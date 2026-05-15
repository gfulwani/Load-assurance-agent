'use strict';
/**
 * Startup: deploy SQLite schema then start CDS server.
 * Used on CF where cds-dk CLI may not be available.
 *
 * cds.server() is the programmatic equivalent of cds-serve.
 * It loads the model, connects to the DB, mounts all services, and starts Express.
 */
const cds  = require('@sap/cds');
const path = require('path');

async function main() {
  // Deploy schema to SQLite BEFORE starting server — tables must exist before first request
  try {
    console.log('[start] Deploying CDS schema to SQLite...');
    await cds.deploy('db', { to: 'sqlite:db.sqlite' });
    console.log('[start] Schema deployed.');
  } catch (e) {
    console.error('[start] cds.deploy failed, continuing:', e.message);
  }

  // Create SQL view aliases so the OData service layer can find the tables
  // CDS deploys tables as e.g. com_loadassurance_ShipmentScan but the OData
  // service queries LoadAssuranceService_ShipmentScans.
  try {
    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(path.join(__dirname, 'db.sqlite'));
    const views = [
      ['LoadAssuranceService_ShipmentScans',  'com_loadassurance_ShipmentScan'],
      ['LoadAssuranceService_HUValidations',  'com_loadassurance_HUValidation'],
      ['LoadAssuranceService_ExceptionLogs',  'com_loadassurance_ExceptionLog'],
      ['LoadAssuranceService_ValidationLogs', 'com_loadassurance_ValidationLog'],
    ];
    // Schema migrations — add new columns if missing (idempotent)
    const migrations = [
      `ALTER TABLE com_loadassurance_ShipmentScan ADD COLUMN reviewHUs INTEGER DEFAULT 0`,
      `ALTER TABLE com_loadassurance_HUValidation ADD COLUMN labelStatus TEXT`,
      `ALTER TABLE com_loadassurance_HUValidation ADD COLUMN stackingCompliant INTEGER DEFAULT 1`,
      `ALTER TABLE com_loadassurance_HUValidation ADD COLUMN status TEXT`,
      `ALTER TABLE com_loadassurance_HUValidation ADD COLUMN severity TEXT`,
    ];
    await new Promise((resolve, reject) => {
      db.serialize(() => {
        let pending = views.length + migrations.length;
        let done = 0;
        const finish = (err) => {
          if (err) { console.warn('[start] View/migration warning:', err.message); }
          if (++done === pending) resolve();
        };
        // Run migrations first (ignore "duplicate column" errors — that's fine)
        migrations.forEach(sql => db.run(sql, finish));
        // Then create view aliases
        views.forEach(([view, table]) => {
          db.run(`CREATE VIEW IF NOT EXISTS "${view}" AS SELECT * FROM "${table}"`, finish);
        });
      });
    });
    db.close();
    console.log('[start] SQL view aliases created.');
  } catch (e) {
    console.warn('[start] Could not create SQL view aliases:', e.message);
  }

  console.log('[start] Starting CDS server...');
  // Add raw proxy route to fetch WT $metadata through the destination
  cds.on('bootstrap', (app) => {
    const express = require('express');
    const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
    const DESTINATION = 'M20CLNT100';
    const OBD_BASE    = '/sap/opu/odata4/sap/api_whse_outb_delivery_order_2/srvd_a2x/sap/whseoutbdeliveryorder/0001/';

    app.use(express.json({ limit: '10mb' }));

    app.use('/skills', (req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    // ── POST /skills/delivery-status (also accepts GET for backwards compat) ─
    const deliveryStatusHandler = async (req, res) => {
      const { obdNumber, warehouse } = { ...req.query, ...req.body } || {};
      if (!obdNumber) return res.status(400).json({ success: false, error: 'obdNumber is required' });
      try {
        const huResp = await executeHttpRequest(
          { destinationName: DESTINATION },
          { method: 'GET', url: '/sap/opu/odata4/sap/api_handlingunit/srvd_a2x/sap/handlingunit/0001/HandlingUnit?$top=200',
            headers: { 'Accept': 'application/json', 'sap-client': '100' } }
        );
        const allHUs = huResp.data?.value || [];
        const obd = (obdNumber || '').toString().trim();
        const delivHUs = allHUs.filter(h => {
          const ref = (h.HandlingUnitReferenceDocument || '').toString().trim();
          return ref.includes(obd) || obd.includes(ref) || ref.replace(/^0+/,'') === obd.replace(/^0+/,'');
        });
        const hus = delivHUs.map(h => {
          const n  = parseFloat(h.NetWeight || 0);
          const g  = parseFloat(h.GrossWeight || 0);
          const lw = parseFloat(h.LoadingWeight || 0);
          const p  = parseFloat(h.PlannedWeight || 0);
          const ew = n>0?n : lw>0?lw : p>0?p : g>0?g : 0;
          const blocked = !!(h.EWMHUContentChangeIsBlocked || h.EWMHUMovementChangeIsBlocked ||
                             h.EWMHUPostingChangeIsBlocked  || h.EWMHUIsBlockedByCustoms);
          return {
            huId: h.HandlingUnitExternalID || '',
            storageBin: h.StorageBin || '',
            expectedWeight: ew,
            weightUnit: h.WeightUnit || 'LB',
            grossWeight: parseFloat(h.GrossWeight || 0),
            isBlocked: blocked,
            isInStock: !!h.EWMHandlingUnitIsInStock,
            huStatus: blocked ? 'BLK' : h.EWMHandlingUnitIsInStock ? 'STOCK' : 'PLAN'
          };
        });
        res.json({
          success: true,
          obdNumber: obd,
          warehouse: warehouse || '',
          huCount: hus.length,
          hus,
          firstHuId: hus[0]?.huId || null,
          allBlocked: hus.length > 0 && hus.every(h => h.isBlocked),
          anyBlocked: hus.some(h => h.isBlocked)
        });
      } catch (e) {
        console.error('[SKILL delivery-status]', e.message);
        res.status(500).json({ success: false, error: e.message });
      }
    };
    app.get('/skills/delivery-status', deliveryStatusHandler);
    app.post('/skills/delivery-status', deliveryStatusHandler);

    // ── GET /openapi.json ─────────────────────────────────────────────────
    app.get('/openapi.json', (req, res) => {
      res.sendFile(path.join(__dirname, 'openapi.json'));
    });

    // ── Joule operation handlers (shared by /joule/validate router + individual endpoints) ──
    const jouleHuWeight = async (obd, wh) => {
      const HU_PATH = '/sap/opu/odata4/sap/api_handlingunit/srvd_a2x/sap/handlingunit/0001/HandlingUnit';
      const norm = d => d.toString().replace(/^0+/, '');
      const variants = [...new Set([obd, obd.padStart(10,'0'), norm(obd)])];
      let items = [];
      for (const v of variants) {
        try {
          const filter = `Warehouse eq '${wh}' and HandlingUnitReferenceDocument eq '${v}'`;
          const r = await executeHttpRequest({ destinationName: DESTINATION },
            { method: 'GET', url: `${HU_PATH}?$top=200&$filter=${encodeURIComponent(filter)}`, headers: { Accept: 'application/json', 'sap-client': '100' } });
          items = r.data?.value || [];
          if (items.length) break;
        } catch(e) { console.warn(`[jouleHuWeight] variant '${v}' failed:`, e.message); }
      }
      if (!items.length) return { success: false, message: `No handling units found for delivery ${obd} in warehouse ${wh}. Picking may not have started yet.`, huCount: 0, outboundDelivery: obd, warehouse: wh };
      const hus = items.map(h => {
        const n = parseFloat(h.NetWeight||0), g = parseFloat(h.GrossWeight||0);
        const lw = parseFloat(h.LoadingWeight||0), p = parseFloat(h.PlannedWeight||0);
        const ew = n>0?n : lw>0?lw : p>0?p : g>0?g : 0;
        const blocked = !!(h.EWMHUContentChangeIsBlocked||h.EWMHUMovementChangeIsBlocked||h.EWMHUPostingChangeIsBlocked||h.EWMHUIsBlockedByCustoms);
        return { huId: h.HandlingUnitExternalID||'', storageBin: h.StorageBin||'-', expectedWeight: ew, weightUnit: h.WeightUnit||'LB', isBlocked: blocked };
      });
      const lines = hus.map(h => `HU ${h.huId}: ${h.expectedWeight} ${h.weightUnit} | Bin: ${h.storageBin}${h.isBlocked?' | ⚠ BLOCKED':''}`).join('\n');
      return { success: true, message: `Delivery ${obd} — ${hus.length} HU(s):\n${lines}`, huCount: hus.length, outboundDelivery: obd, warehouse: wh };
    };

    const jouleApprove = async (obd, wh) => {
      const svc = await cds.connect.to('LoadAssuranceService');
      const result = await svc.send('approveDispatch', { outboundDelivery: obd, warehouse: wh });
      const success = result?.success ?? false;
      const message = success
        ? `Delivery ${obd} approved for dispatch.\nShipping Readiness: Set ✅\nNext step: Confirm Loading onto vehicle.`
        : `Dispatch approval attempted for ${obd}.\n${result?.message || 'Check EWM manually.'}`;
      return { success, message, outboundDelivery: obd, warehouse: wh };
    };

    const jouleBlock = async (obd, wh, reason) => {
      const svc = await cds.connect.to('LoadAssuranceService');
      const result = await svc.send('blockDispatch', { outboundDelivery: obd, warehouse: wh, reason: reason || 'Blocked via Joule' });
      const success = result?.success ?? false;
      const message = success
        ? `Delivery ${obd} has been blocked.\nReason: ${reason || 'Blocked via Joule'}\nShipping readiness reversed — delivery is on hold.`
        : `Block attempted for delivery ${obd}.\n${result?.message || 'Check EWM manually.'}`;
      return { success, message, outboundDelivery: obd, warehouse: wh };
    };

    const jouleReverse = async (obd, wh) => {
      const svc = await cds.connect.to('LoadAssuranceService');
      const result = await svc.send('reverseShippingReadiness', { outboundDelivery: obd, warehouse: wh });
      const success = result?.success ?? false;
      const giReversed = result?.giReversed ?? false;
      const message = success
        ? `Delivery ${obd} has been reversed.\nGoods Issue: ${giReversed ? 'Reversed' : 'Skipped'}\nShipping Readiness: Reversed\nDelivery is now on hold — ready for re-inspection.`
        : `Reversal attempted for delivery ${obd}.\n${result?.message || 'Check EWM manually.'}`;
      return { success, message, giReversed, srReversed: success, outboundDelivery: obd, warehouse: wh };
    };

    const jouleGI = async (obd, wh) => {
      const svc = await cds.connect.to('LoadAssuranceService');
      const result = await svc.send('postGoodsIssue', { handlingUnitId: '', outboundDelivery: obd, warehouseNumber: wh });
      const success = result?.success ?? false;
      const message = success
        ? `Goods Issue posted for delivery ${obd}. Delivery is now closed — inventory updated in SAP.`
        : `Goods Issue failed for delivery ${obd}.\n${result?.message || 'Check EWM manually.'}`;
      return { success, message, outboundDelivery: obd, warehouse: wh };
    };

    const jouleCancelPick = async (obd, wh, huId) => {
      const svc = await cds.connect.to('LoadAssuranceService');
      const result = await svc.send('cancelPicking', { huId: huId||'', outboundDelivery: obd, warehouse: wh, itemNo: '' });
      const success = result?.success ?? false;
      const message = success
        ? `Pick cancelled for delivery ${obd}${huId?' HU '+huId:''}.\n${result?.aiGuidance || 'Use /SCWM/CANCPICK to confirm on RF gun.'}`
        : `Pick cancellation failed for delivery ${obd}.\n${result?.message || 'Try /SCWM/CANCPICK manually.'}`;
      return { success, message, outboundDelivery: obd, warehouse: wh };
    };

    const jouleCreatePick = async (obd, wh) => {
      const svc = await cds.connect.to('LoadAssuranceService');
      const result = await svc.send('createPick', { huId: '', outboundDelivery: obd, warehouse: wh });
      const success = result?.success ?? false;
      const message = success
        ? `Pick task created for delivery ${obd}.\n${result.message || 'Task will appear on RF gun.'}`
        : `Pick task creation failed for delivery ${obd}.\n${result?.message || 'Check EWM manually.'}`;
      return { success, message, outboundDelivery: obd, warehouse: wh };
    };

    const jouleConfirmLoading = async (obd, wh) => {
      const obdKey = String(obd).padStart(10, '0');
      const ODO2_HEAD = '/sap/opu/odata4/sap/api_warehouse_odo_2/srvd_a2x/sap/warehouseoutbdeliveryorder/0001/WhseOutboundDeliveryOrderHead';
      const head = await executeHttpRequest(
        { destinationName: DESTINATION },
        { method: 'GET', url: `${ODO2_HEAD}('${obdKey}')`, headers: { Accept: 'application/json', 'sap-client': '100' } },
        { fetchCsrfToken: false }
      ).catch(e => ({ _error: e.message }));
      if (head._error) return { success: false, message: `Could not fetch delivery ${obd}: ${head._error}`, outboundDelivery: obd, warehouse: wh };
      if (head.data?.EWMOutbDlvOrdImmdLoadgIsActv) return { success: true, message: `Loading already active for delivery ${obd} — RF task already sent to operator gun.`, outboundDelivery: obd, warehouse: wh };
      const etag = head.headers?.etag || '*';
      let csrfToken = '*';
      try {
        const tok = await executeHttpRequest(
          { destinationName: DESTINATION },
          { method: 'GET', url: ODO2_HEAD + '?$top=1', headers: { Accept: 'application/json', 'sap-client': '100', 'x-csrf-token': 'Fetch' } },
          { fetchCsrfToken: false }
        );
        csrfToken = tok.headers?.['x-csrf-token'] || '*';
      } catch(_) {}
      const act = await executeHttpRequest(
        { destinationName: DESTINATION },
        { method: 'POST', url: `${ODO2_HEAD}('${obdKey}')/SAP__self.ActivateImmediateLoading`,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'sap-client': '100', 'If-Match': etag, 'x-csrf-token': csrfToken }, data: {} },
        { fetchCsrfToken: false }
      ).catch(e => ({ _error: e.message, status: 500 }));
      const success = !act._error && act.status < 400;
      const message = success
        ? `Loading confirmed for delivery ${obd}. RF task sent to operator gun.`
        : `Loading activation failed for delivery ${obd}.\n${act._error || 'EWM returned HTTP ' + act.status}`;
      return { success, message, outboundDelivery: obd, warehouse: wh };
    };

    const jouleScan = async (obd, wh) => {
      const svc = await cds.connect.to('LoadAssuranceService');
      const result = await svc.send('scanDelivery', { outboundDelivery: obd, warehouse: wh, scaleWeight: null });

      if (result?.pickingNotStarted) {
        return { success: false, message: `Delivery ${obd} — picking not started yet. No HUs assigned.\nNext step: Create a pick task to begin picking.`, outboundDelivery: obd, warehouse: wh };
      }
      if (!result?.huResults?.length) {
        return { success: false, message: `No handling units found for delivery ${obd} in warehouse ${wh}.`, outboundDelivery: obd, warehouse: wh };
      }

      const status  = result.dispatchStatus || 'PENDING';
      const passed  = result.passedHUs  || 0;
      const failed  = result.failedHUs  || 0;
      const review  = result.reviewHUs  || 0;
      const total   = result.totalHUs   || result.huResults.length;

      const huLines = result.huResults.map(hu => {
        const delta  = hu.deltaPct !== undefined ? (hu.deltaPct > 0 ? '+' : '') + hu.deltaPct.toFixed(1) + '%' : 'N/A';
        const icon   = hu.passed ? '✅' : (hu.weightPassed === false ? '❌' : '⚠️');
        return `  ${icon} HU ${hu.huId}: Expected ${hu.expectedWeight} ${hu.weightUnit || 'LB'}, Actual ${hu.actualWeight} ${hu.weightUnit || 'LB'} (Δ ${delta}) — Bin: ${hu.storageBin || '-'}`;
      }).join('\n');

      const verdictIcon = status === 'APPROVED' || status === 'SHIPPED' ? '✅' : status === 'BLOCKED' ? '❌' : '⚠️';
      const nextStep =
        status === 'SHIPPED'  ? 'Delivery already shipped — Goods Issue posted.' :
        status === 'APPROVED' ? 'Next step: Approve dispatch to set shipping readiness.' :
        status === 'BLOCKED'  ? 'Delivery is BLOCKED — reweigh failed HUs or get supervisor approval.' :
        failed > 0            ? 'Next step: Reweigh failed HUs and rescan, or get supervisor approval.' :
                                'Next step: Approve dispatch to proceed.';

      const message =
        `${verdictIcon} Delivery ${obd} — Scan Result: ${status}\n` +
        `HUs: ${total} total | ${passed} passed | ${failed} failed | ${review} review\n\n` +
        `${huLines}\n\n` +
        `AI Analysis: ${result.aiSummary || 'No analysis available.'}\n\n` +
        `${nextStep}`;

      return { success: status !== 'BLOCKED', message, outboundDelivery: obd, warehouse: wh };
    };

    // ── GET /joule/health ──────────────────────────────────────────────────
    app.get('/joule/health', (req, res) => {
      res.json({
        status: 'operational',
        skills: { scanDelivery: 'active', scanPallet: 'active', getHUData: 'active', validateCompliance: 'active', confirmLoading: 'active', handleException: 'active' },
        connections: { ewm: 'connected', aiCore: 'connected', nvidia: 'connected' },
        timestamp: new Date().toISOString()
      });
    });

    // ── POST /joule/validate ───────────────────────────────────────────────
    app.post('/joule/validate', async (req, res) => {
      const { outboundDelivery, obdNumber, warehouse, huId, userMessage, intent } = req.body || {};
      const obd = (outboundDelivery || obdNumber || '').trim();
      const wh  = (warehouse || '2001').trim();
      if (!obd) return res.status(400).json({ success: false, message: 'outboundDelivery is required', outboundDelivery: '' });

      // Route to sub-operation based on userMessage or intent field
      const msg = (userMessage || intent || '').toLowerCase();
      try {
        if (msg.match(/hu.?weight|handling unit weight|weight/))   return res.json(await jouleHuWeight(obd, wh));
        if (msg.match(/scan|check.?delivery|validate|inspect/))    return res.json(await jouleScan(obd, wh));
        if (msg.match(/approve|shipping.?ready|set.?ready/))       return res.json(await jouleApprove(obd, wh));
        if (msg.match(/block|hold/))                               return res.json(await jouleBlock(obd, wh, req.body.reason));
        if (msg.match(/reverse|undo/))                             return res.json(await jouleReverse(obd, wh));
        if (msg.match(/goods.?issue|post.?gi|close.?delivery/))    return res.json(await jouleGI(obd, wh));
        if (msg.match(/cancel.?pick/))                             return res.json(await jouleCancelPick(obd, wh, req.body.huId));
        if (msg.match(/create.?pick|start.?pick/))                 return res.json(await jouleCreatePick(obd, wh));
        if (msg.match(/confirm.?load|loading|activate.?load/))     return res.json(await jouleConfirmLoading(obd, wh));
      } catch(e) {
        console.error('[joule/validate router]', e.message);
        return res.status(500).json({ success: false, message: e.message, outboundDelivery: obd, warehouse: wh });
      }

      try {
        const norm = d => (d||'').toString().replace(/^0+/, '');
        const variants = [...new Set([obd, obd.padStart(10,'0'), norm(obd)])];
        let delivHUs = [];
        for (const variant of variants) {
          try {
            const filter = `Warehouse eq '${wh}' and HandlingUnitReferenceDocument eq '${variant}'`;
            const r = await executeHttpRequest(
              { destinationName: DESTINATION },
              { method: 'GET', url: `/sap/opu/odata4/sap/api_handlingunit/srvd_a2x/sap/handlingunit/0001/HandlingUnit?$top=50&$filter=${encodeURIComponent(filter)}`,
                headers: { Accept: 'application/json', 'sap-client': '100' } }
            );
            const items = r.data?.value || [];
            if (items.length > 0) { delivHUs = items; break; }
          } catch(e) {}
        }

        if (!delivHUs.length) {
          return res.json({ success: false, message: `No handling units found for delivery ${obd} in warehouse ${wh}.`, outboundDelivery: obd, warehouse: wh });
        }

        let raw = huId ? delivHUs.find(h => (h.HandlingUnitExternalID||'').trim() === huId.trim()) : delivHUs[0];
        if (!raw) raw = delivHUs[0];

        const resolvedHuId = (raw.HandlingUnitExternalID || '').trim();
        const n  = parseFloat(raw.NetWeight||0), g = parseFloat(raw.GrossWeight||0);
        const t  = parseFloat(raw.HandlingUnitTareWeight||0);
        const lw = parseFloat(raw.LoadingWeight||0), p = parseFloat(raw.PlannedWeight||0);
        const expectedWeight = n>0?n : lw>0?lw : p>0?p : g>0&&t>0?Math.max(0.1,g-t) : g>0?g : 0;
        const weightUnit  = raw.WeightUnit || 'LB';
        const storageBin  = raw.StorageBin || '';
        const isBlocked   = !!(raw.EWMHUContentChangeIsBlocked||raw.EWMHUMovementChangeIsBlocked||raw.EWMHUPostingChangeIsBlocked||raw.EWMHUIsBlockedByCustoms);
        const isClosed    = !!raw.HandlingUnitIsClosed;
        const huStatus    = isBlocked ? 'BLOCKED' : raw.EWMHandlingUnitIsInStock ? 'STOCK' : raw.EWMHandlingUnitIsLoaded ? 'LOADED' : raw.EWMHandlingUnitIsPlanned ? 'PLANNED' : isClosed ? 'CLOSED' : 'ACTIVE';

        const complianceIssues = [];
        if (isBlocked)          complianceIssues.push('HU is blocked in EWM');
        if (isClosed)           complianceIssues.push('HU is closed');
        if (!expectedWeight)    complianceIssues.push('No weight data recorded in EWM — manual verification required');

        const localVerdict   = isBlocked || isClosed ? 'FAIL' : !expectedWeight ? 'REVIEW' : 'PASS';
        const rootCause      = complianceIssues.length > 0 ? complianceIssues.join('; ') : 'No issues detected';
        const recommendation = localVerdict === 'PASS'
          ? 'Delivery is clear for dispatch — proceed with shipping readiness.'
          : localVerdict === 'REVIEW'
          ? 'Manual weight verification required — supervisor must confirm HU weight in EWM before dispatch.'
          : 'Hold delivery — resolve blocked or closed HU before dispatch can proceed.';
        const message =
          `Verdict: ${localVerdict}\n` +
          `HU ID: ${resolvedHuId}\n` +
          `Root Cause: ${rootCause}\n` +
          `Recommendation: ${recommendation}`;

        const displayText =
          `Verdict: ${localVerdict}\n` +
          `HU ID: ${resolvedHuId}\n` +
          `Message: ${message}\n` +
          `Root Cause: ${rootCause}\n` +
          `Recommendation: ${recommendation}`;

        const payload = {
          message, success: true, verdict: localVerdict,
          outboundDelivery: obd, warehouse: wh
        };
        res.json(payload);

      } catch(e) {
        console.error('[joule/validate]', e.message);
        res.status(500).json({ success: false, message: 'Validation failed: ' + e.message, outboundDelivery: obd, warehouse: wh });
      }
    });

    // ── POST /joule/reverse ───────────────────────────────────────────────
    app.post('/joule/reverse', async (req, res) => {
      const obd = (req.body?.outboundDelivery || req.body?.obdNumber || '').trim();
      const wh  = (req.body?.warehouse || '2001').trim();
      if (!obd) return res.status(400).json({ message: 'outboundDelivery is required' });
      try { res.json(await jouleReverse(obd, wh)); } catch(e) { res.status(500).json({ success: false, message: `Reversal failed: ${e.message}`, outboundDelivery: obd, warehouse: wh }); }
    });

    // ── POST /joule/hu-weight ─────────────────────────────────────────────
    app.post('/joule/hu-weight', async (req, res) => {
      const obd = (req.body?.outboundDelivery || '').trim();
      const wh  = (req.body?.warehouse || '2001').trim();
      if (!obd) return res.status(400).json({ message: 'outboundDelivery is required' });
      try { res.json(await jouleHuWeight(obd, wh)); } catch(e) { res.status(500).json({ success: false, message: `Failed to fetch HU data: ${e.message}`, outboundDelivery: obd, warehouse: wh }); }
    });

    // ── POST /joule/approve ───────────────────────────────────────────────
    app.post('/joule/approve', async (req, res) => {
      const obd = (req.body?.outboundDelivery || '').trim();
      const wh  = (req.body?.warehouse || '2001').trim();
      if (!obd) return res.status(400).json({ message: 'outboundDelivery is required' });
      try { res.json(await jouleApprove(obd, wh)); } catch(e) { res.status(500).json({ success: false, message: `Approval failed: ${e.message}`, outboundDelivery: obd, warehouse: wh }); }
    });

    // ── POST /joule/block ─────────────────────────────────────────────────
    app.post('/joule/block', async (req, res) => {
      const obd = (req.body?.outboundDelivery || '').trim();
      const wh  = (req.body?.warehouse || '2001').trim();
      if (!obd) return res.status(400).json({ message: 'outboundDelivery is required' });
      try { res.json(await jouleBlock(obd, wh, req.body?.reason)); } catch(e) { res.status(500).json({ success: false, message: `Block failed: ${e.message}`, outboundDelivery: obd, warehouse: wh }); }
    });

    // ── POST /joule/gi ────────────────────────────────────────────────────
    app.post('/joule/gi', async (req, res) => {
      const obd = (req.body?.outboundDelivery || '').trim();
      const wh  = (req.body?.warehouse || '2001').trim();
      if (!obd) return res.status(400).json({ message: 'outboundDelivery is required' });
      try { res.json(await jouleGI(obd, wh)); } catch(e) { res.status(500).json({ success: false, message: `GI failed: ${e.message}`, outboundDelivery: obd, warehouse: wh }); }
    });

    // ── POST /joule/cancel-pick ───────────────────────────────────────────
    app.post('/joule/cancel-pick', async (req, res) => {
      const obd = (req.body?.outboundDelivery || '').trim();
      const wh  = (req.body?.warehouse || '2001').trim();
      if (!obd) return res.status(400).json({ message: 'outboundDelivery is required' });
      try { res.json(await jouleCancelPick(obd, wh, req.body?.huId)); } catch(e) { res.status(500).json({ success: false, message: `Cancel pick failed: ${e.message}`, outboundDelivery: obd, warehouse: wh }); }
    });

    // ── POST /joule/create-pick ───────────────────────────────────────────
    app.post('/joule/create-pick', async (req, res) => {
      const obd = (req.body?.outboundDelivery || '').trim();
      const wh  = (req.body?.warehouse || '2001').trim();
      if (!obd) return res.status(400).json({ message: 'outboundDelivery is required' });
      try { res.json(await jouleCreatePick(obd, wh)); } catch(e) { res.status(500).json({ success: false, message: `Create pick failed: ${e.message}`, outboundDelivery: obd, warehouse: wh }); }
    });

    // ── POST /skills/get-hu-data ───────────────────────────────────────────
    app.post('/skills/get-hu-data', async (req, res) => {
      console.log('[get-hu-data] body:', JSON.stringify(req.body));
      const { warehouse, huId, obdNumber } = req.body || {};
      if (!warehouse) return res.status(400).json({ success: false, error: 'warehouse is required' });
      if (!huId)      return res.status(400).json({ success: false, error: 'huId is required' });
      try {
        const resp = await executeHttpRequest(
          { destinationName: DESTINATION },
          { method: 'GET', url: '/sap/opu/odata4/sap/api_handlingunit/srvd_a2x/sap/handlingunit/0001/HandlingUnit?$top=200',
            headers: { 'Accept': 'application/json', 'sap-client': '100' } }
        );
        const allHUs = resp.data?.value || [];
        const raw = allHUs.find(h =>
          (h.HandlingUnitExternalID || '').toString().trim() === huId.trim() &&
          (h.Warehouse || '').toString().trim() === warehouse.trim()
        );
        if (!raw) return res.status(404).json({ success: false, error: `HU ${huId} not found in warehouse ${warehouse}` });

        const n  = parseFloat(raw.NetWeight || 0);
        const g  = parseFloat(raw.GrossWeight || 0);
        const t  = parseFloat(raw.HandlingUnitTareWeight || 0);
        const lw = parseFloat(raw.LoadingWeight || 0);
        const p  = parseFloat(raw.PlannedWeight || 0);
        const expectedWeight =
          n  > 0 ? n  :
          lw > 0 ? lw :
          p  > 0 ? p  :
          g  > 0 ? g  : 0;
        const weightSource =
          n  > 0 ? 'NetWeight' : lw > 0 ? 'LoadingWeight' : p > 0 ? 'PlannedWeight' : g > 0 ? 'GrossWeight' : 'NONE';

        const blocked = !!(raw.EWMHUContentChangeIsBlocked || raw.EWMHUMovementChangeIsBlocked ||
                           raw.EWMHUPostingChangeIsBlocked  || raw.EWMHUIsBlockedByCustoms);
        const huStatus = blocked ? 'BLK' : raw.EWMHandlingUnitIsLoaded ? 'LOAD' :
          raw.EWMHandlingUnitIsInStock ? 'STOCK' : raw.EWMHandlingUnitIsPlanned ? 'PLAN' :
          raw.EWMHandlingUnitIsUnloaded ? 'UNLD' : 'UNKN';
        const refDocument = raw.HandlingUnitReferenceDocument || '';
        const obdMatch    = obdNumber
          ? refDocument.includes(obdNumber) || obdNumber.includes(refDocument) : undefined;

        const payload = {
          success: true, huId,
          warehouse:      raw.Warehouse    || warehouse,
          storageBin:     raw.StorageBin   || '',
          storageType:    raw.StorageType  || '',
          expectedWeight, weightUnit: raw.WeightUnit || 'LB', weightSource,
          grossWeight: g, netWeight: n, tareWeight: t,
          isBlocked: blocked, isInStock: !!raw.EWMHandlingUnitIsInStock,
          isLoaded: !!raw.EWMHandlingUnitIsLoaded, isPlanned: !!raw.EWMHandlingUnitIsPlanned,
          isClosed: !!raw.HandlingUnitIsClosed, huStatus, refDocument, refDocType: '', obdMatch, error: null
        };
        res.json({ result: payload, ...payload });
      } catch (e) {
        console.error('[SKILL get-hu-data]', e.message);
        res.status(500).json({ result: { success: false, error: e.message }, success: false, error: e.message });
      }
    });

    // ── POST /skills/scan-pallet ───────────────────────────────────────────
    app.post('/skills/scan-pallet', async (req, res) => {
      const { imageBase64, imageUrl, mediaType, huId, outboundDelivery } = req.body || {};
      try {
        const { runVisionAgent } = require('./srv/service.js');

        let b64 = imageBase64;
        if (!b64 && imageUrl) {
          const imgResp = await fetch(imageUrl);
          const buf = await imgResp.arrayBuffer();
          b64 = Buffer.from(buf).toString('base64');
        }
        if (!b64) return res.status(400).json({ success: false, error: 'imageBase64 or imageUrl is required' });

        // runVisionAgent: NVIDIA plain-text → Claude JSON structuring
        const raw = await runVisionAgent(b64, mediaType || 'image/jpeg');

        // Normalise confidence (already normalised in service.js but guard here too)
        const confidence = parseFloat(String(raw.confidence ?? 0.85)) || 0.85;

        // Merge issues — Claude's list is primary; supplement with flag-based extras
        const issues = Array.isArray(raw.issues) && raw.issues.length ? [...raw.issues] : [];
        if (raw.stackingViolations?.length) {
          for (const v of raw.stackingViolations) {
            if (!issues.some(i => i === v)) issues.push(v);
          }
        }
        if (raw.stretchWrapIntact === false && !issues.some(i => /wrap/i.test(i)))
          issues.push('Stretch wrap incomplete or damaged');
        if (raw.palletCondition === 'RUSTY'   && !issues.some(i => /rust/i.test(i)))
          issues.push('Pallet shows rust — structural risk');
        if (raw.palletCondition === 'DAMAGED' && !issues.some(i => /damage/i.test(i)))
          issues.push('Pallet physically damaged');
        if (raw.labelDamage    && !issues.some(i => /label/i.test(i)))
          issues.push('HU label torn or illegible');
        if (raw.missingLabels  && !issues.some(i => /missing/i.test(i)))
          issues.push('One or more items missing labels');

        // Final verdict — respect Claude's but enforce hard rules
        let verdict = (raw.verdict || 'REVIEW').toUpperCase();
        if (raw.stackingCompliant === false || raw.palletCondition === 'DAMAGED' ||
            raw.palletCondition === 'RUSTY'  || raw.stretchWrapIntact === false) {
          verdict = 'FAIL';
        }
        if (!issues.length && verdict !== 'PASS') {
          issues.push(raw.observations || 'Visual check required');
        }

        // wrapIntegrity — prefer Claude's explicit field, then derive from flag
        const wrapIntegrity = raw.wrapIntegrity || raw.wrap_integrity || raw.WrapIntegrity
          || (raw.stretchWrapIntact === false ? 'FAIL' : raw.stretchWrapIntact === true ? 'PASS' : 'REVIEW');

        console.log('[SKILL scan-pallet] final:', JSON.stringify({
          verdict, confidence, wrapIntegrity, issueCount: issues.length
        }));

        const result = {
          success:           true,
          huId:              huId || raw.huLabel || null,
          huLabelDetected:   !!raw.huLabel,
          huLabelReadable:   !raw.labelDamage && !!raw.huLabel,
          stackingCompliant: raw.stackingCompliant !== false,
          wrapIntegrity,
          palletCondition:   raw.palletCondition || 'GOOD',
          layersDetected:    raw.layersDetected || 0,
          itemCount:         raw.itemCount || 0,
          stabilityScore:    raw.stabilityScore || 70,
          issues,
          observations:      raw.observations || '',
          labelTextsRead:    raw.labelTextsRead || [],
          confidence,
          verdict,
          recommendation:    raw.stackingRecommendation || (verdict === 'PASS' ? 'Pallet approved for dispatch' : 'Resolve issues before dispatch')
        };
        res.json({ value: result, ...result });
      } catch (e) {
        console.error('[SKILL scan-pallet]', e.message);
        res.status(500).json({ success: false, error: e.message });
      }
    });

    // ── POST /skills/validate-compliance ──────────────────────────────────
    app.post('/skills/validate-compliance', async (req, res) => {
      let { huId, warehouse, obdNumber, actualWeight, weightUnit, visionResult, ewmData } = req.body || {};
      if (!obdNumber) return res.status(400).json({ success: false, error: 'obdNumber is required' });
      try {
        const { callAI } = require('./srv/service.js');

        // Auto-fetch HU data from EWM if huId not provided or ewmData missing
        if ((!huId || !ewmData) && obdNumber) {
          try {
            const huResp = await executeHttpRequest(
              { destinationName: DESTINATION },
              { method: 'GET', url: '/sap/opu/odata4/sap/api_handlingunit/srvd_a2x/sap/handlingunit/0001/HandlingUnit?$top=200',
                headers: { 'Accept': 'application/json', 'sap-client': '100' } }
            );
            const allHUs = huResp.data?.value || [];
            // Find HUs belonging to this delivery
            const delivHUs = allHUs.filter(h => {
              const ref = (h.HandlingUnitReferenceDocument || '').toString().trim();
              const obd = obdNumber.toString().trim();
              return ref.includes(obd) || obd.includes(ref) ||
                     ref.replace(/^0+/,'') === obd.replace(/^0+/,'');
            });
            if (delivHUs.length > 0) {
              // Use first HU if huId not given; otherwise match
              const raw = huId
                ? (delivHUs.find(h => (h.HandlingUnitExternalID||'').trim() === huId.trim()) || delivHUs[0])
                : delivHUs[0];
              if (!huId) huId = raw.HandlingUnitExternalID || '';
              if (!ewmData) {
                const n  = parseFloat(raw.NetWeight || 0);
                const g  = parseFloat(raw.GrossWeight || 0);
                const lw = parseFloat(raw.LoadingWeight || 0);
                const p  = parseFloat(raw.PlannedWeight || 0);
                const expectedWeight = n>0?n : lw>0?lw : p>0?p : g>0?g : 0;
                const blocked = !!(raw.EWMHUContentChangeIsBlocked || raw.EWMHUMovementChangeIsBlocked ||
                                   raw.EWMHUPostingChangeIsBlocked  || raw.EWMHUIsBlockedByCustoms);
                ewmData = {
                  expectedWeight, weightUnit: raw.WeightUnit || 'LB',
                  isBlocked: blocked, obdMatch: true,
                  storageBin: raw.StorageBin || '',
                  huStatus: blocked ? 'BLK' : raw.EWMHandlingUnitIsInStock ? 'STOCK' : 'PLAN',
                  huCount: delivHUs.length, allHuIds: delivHUs.map(h => h.HandlingUnitExternalID)
                };
                if (!weightUnit) weightUnit = ewmData.weightUnit;
              }
            }
          } catch (fetchErr) {
            console.warn('[validate-compliance] auto-fetch HU failed:', fetchErr.message);
          }
        }

        const expected    = ewmData?.expectedWeight || 0;
        const actual      = actualWeight || 0;
        const delta       = actual - expected;
        const deltaPct    = expected > 0 ? Math.abs(delta) / expected * 100 : 0;
        const weightCheck = deltaPct <= 5;
        const labelCheck  = visionResult
          ? !visionResult.huLabelDetected || visionResult.huLabelDetected.includes(huId) || huId.includes(visionResult.huLabelDetected)
          : true;
        const obdCheck      = ewmData?.obdMatch !== false;
        const stackingCheck = visionResult ? visionResult.stackingCompliant !== false : true;
        const statusCheck   = ewmData ? !ewmData.isBlocked : true;
        const localVerdict  = !weightCheck || !statusCheck ? 'FAIL' : !stackingCheck || !labelCheck ? 'REVIEW' : 'PASS';

        const aiRaw = await callAI(
          `You are a warehouse load compliance agent for SAP EWM. Validate pallet against EWM record. Weight tolerance ±5%.
Respond JSON only: {"verdict":"PASS/FAIL/REVIEW","confidence":0-100,"rootCause":null,"recommendation":"...","correctionSteps":["..."],"aiInsight":"..."}`,
          `HU: ${huId} | WH: ${warehouse} | OBD: ${obdNumber}
Expected: ${expected} ${weightUnit || 'LB'} | Actual: ${actual} ${weightUnit || 'LB'} | Delta: ${deltaPct.toFixed(2)}%
Weight: ${weightCheck ? 'PASS' : 'FAIL'} | Status: ${statusCheck ? 'OK' : 'BLOCKED'} | Stacking: ${stackingCheck ? 'OK' : 'FAIL'}
Local verdict: ${localVerdict}`
        );

        let ai = null;
        if (aiRaw) { try { const m = aiRaw.match(/\{[\s\S]*\}/); if (m) ai = JSON.parse(m[0]); } catch (_) {} }
        const verdict        = ai?.verdict || localVerdict;
        const rootCause      = ai?.rootCause || (!weightCheck ? `Weight delta ${deltaPct.toFixed(1)}% exceeds 5%` : !statusCheck ? 'HU blocked in EWM' : null);
        const recommendation = ai?.recommendation || (verdict === 'PASS' ? 'Proceed with loading' : 'Hold — investigate before dispatch');

        const compliancePayload = {
          success: true, verdict,
          confidence:     ai?.confidence || (verdict === 'PASS' ? 90 : 75),
          weightCheck, weightDelta: parseFloat(delta.toFixed(3)), weightDeltaPct: parseFloat(deltaPct.toFixed(2)),
          labelCheck, obdCheck, stackingCheck, statusCheck, rootCause, recommendation,
          correctionSteps: ai?.correctionSteps || (verdict !== 'PASS' ? ['Verify weight on certified scale', 'Check EWM HU master data', 'Contact supervisor'] : []),
          aiInsight: ai?.aiInsight || aiRaw || recommendation, error: null
        };
        res.json({ result: compliancePayload, ...compliancePayload });
      } catch (e) {
        console.error('[SKILL validate-compliance]', e.message);
        res.status(500).json({ result: { success: false, error: e.message }, success: false, error: e.message });
      }
    });

    // ── POST /skills/confirm-loading ──────────────────────────────────────
    app.post('/skills/confirm-loading', async (req, res) => {
      const { obdNumber, outboundDelivery } = req.body || {};
      const obd = obdNumber || outboundDelivery;
      if (!obd) return res.status(400).json({ success: false, error: 'obdNumber is required' });
      try {
        const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
        // Fetch fresh head + ETag
        const obdKey = String(obd).padStart(10, '0');
        const ODO2_HEAD = '/sap/opu/odata4/sap/api_warehouse_odo_2/srvd_a2x/sap/warehouseoutbdeliveryorder/0001/WhseOutboundDeliveryOrderHead';
        const head = await executeHttpRequest(
          { destinationName: DESTINATION },
          { method: 'GET', url: `${ODO2_HEAD}('${obdKey}')`, headers: { Accept: 'application/json', 'sap-client': '100' } },
          { fetchCsrfToken: false }
        ).catch(e => ({ status: 500, headers: {}, data: {}, _error: e.message }));

        if (head._error) return res.status(500).json({ success: false, loadingActivated: false, messages: [], error: 'Could not fetch delivery head: ' + head._error });

        const etag = head.headers?.etag || '*';
        const alreadyActive = !!head.data?.EWMOutbDlvOrdImmdLoadgIsActv;
        if (alreadyActive) {
          return res.json({ success: true, loadingActivated: true, messages: ['Loading already active — RF task already sent to gun'], error: null });
        }

        // Fetch CSRF token
        let csrfToken = '*';
        try {
          const tok = await executeHttpRequest(
            { destinationName: DESTINATION },
            { method: 'GET', url: ODO2_HEAD + '?$top=1', headers: { Accept: 'application/json', 'sap-client': '100', 'x-csrf-token': 'Fetch' } },
            { fetchCsrfToken: false }
          );
          csrfToken = tok.headers?.['x-csrf-token'] || '*';
        } catch (_) {}

        const actionUrl = `${ODO2_HEAD}('${obdKey}')/SAP__self.ActivateImmediateLoading`;
        const act = await executeHttpRequest(
          { destinationName: DESTINATION },
          { method: 'POST', url: actionUrl,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'sap-client': '100', 'If-Match': etag, 'x-csrf-token': csrfToken },
            data: {} },
          { fetchCsrfToken: false }
        ).catch(e => ({ status: 500, data: {}, _error: e.message }));

        const loadingActivated = !act._error && act.status < 400;
        const errMsg = act._error || (!loadingActivated ? `EWM returned HTTP ${act.status}` : null);
        const payload = { success: loadingActivated, loadingActivated, messages: loadingActivated ? ['Loading activated — RF task sent to operator gun'] : [], error: errMsg || null };
        return res.json({ result: payload, ...payload });
      } catch (e) {
        console.error('[SKILL confirm-loading]', e.message);
        res.status(500).json({ success: false, loadingActivated: false, messages: [], error: e.message });
      }
    });

    // ── POST /skills/handle-exception ─────────────────────────────────────
    app.post('/skills/handle-exception', async (req, res) => {
      const { obdNumber, huId, warehouse, failureReason, rootCause } = req.body || {};
      if (!obdNumber) return res.status(400).json({ success: false, error: 'obdNumber is required' });
      let giReversed = false, srReversed = false;
      const messages = [];
      try {
        const etag1 = await executeHttpRequest(
          { destinationName: DESTINATION },
          { method: 'GET', url: OBD_BASE + 'WhseOBDOrdHead/' + obdNumber, headers: { 'Accept': 'application/json', 'sap-client': '100' } }
        ).then(r => r.headers?.etag || '*').catch(() => '*');

        try {
          const r = await executeHttpRequest({ destinationName: DESTINATION },
            { method: 'POST', url: OBD_BASE + 'WhseOBDOrdHead/' + obdNumber + '/ReverseGoodsIssue',
              headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'sap-client': '100', 'If-Match': etag1 }, data: {} });
          giReversed = r.status < 400;
          messages.push(`ReverseGoodsIssue: ${giReversed ? 'OK' : `skipped (HTTP ${r.status})`}`);
        } catch (e) { messages.push(`ReverseGoodsIssue: skipped (${e.message})`); }

        const etag2 = await executeHttpRequest(
          { destinationName: DESTINATION },
          { method: 'GET', url: OBD_BASE + 'WhseOBDOrdHead/' + obdNumber, headers: { 'Accept': 'application/json', 'sap-client': '100' } }
        ).then(r => r.headers?.etag || '*').catch(() => '*');

        try {
          const r = await executeHttpRequest({ destinationName: DESTINATION },
            { method: 'POST', url: OBD_BASE + 'WhseOBDOrdHead/' + obdNumber + '/ReverseShippingReadiness',
              headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'sap-client': '100', 'If-Match': etag2 }, data: {} });
          srReversed = r.status < 400;
          messages.push(`ReverseShippingReadiness: ${srReversed ? 'OK' : `FAILED (HTTP ${r.status})`}`);
        } catch (e) { messages.push(`ReverseShippingReadiness: error (${e.message})`); }

        const exceptionPayload = {
          success: srReversed, giReversed, shippingReversed: srReversed,
          manualStepsRequired: true, messages,
          manualInstructions: [
            `HOLD pallet HU ${huId || 'unknown'} — do NOT load on vehicle`,
            `Run /SCWM/CANCPICK to cancel warehouse tasks for HU ${huId || 'unknown'}`,
            `Reason: ${failureReason || rootCause || 'Compliance check failed'}`,
            'Move HU to exception zone / quarantine area',
            `Notify warehouse supervisor — OBD ${obdNumber} is on hold`,
            `Re-inspect HU before re-processing outbound delivery ${obdNumber}`
          ],
          message: `Exception raised for HU ${huId || 'unknown'} on OBD ${obdNumber}. Shipping readiness ${srReversed ? 'reversed' : 'reversal attempted'}.`,
          error: null
        };
        res.json({ result: exceptionPayload, ...exceptionPayload });
      } catch (e) {
        console.error('[SKILL handle-exception]', e.message);
        res.status(500).json({ result: { success: false, error: e.message }, success: false, giReversed, shippingReversed: srReversed, manualStepsRequired: true, manualInstructions: [], messages, message: '', error: e.message });
      }
    });

    // ── GET /wtmeta ────────────────────────────────────────────────────────
    app.get('/wtmeta', async (req, res) => {
      try {
        const r = await executeHttpRequest({ destinationName: DESTINATION }, {
          method: 'GET',
          url: '/sap/opu/odata4/sap/api_warehouse_order_task_2/srvd_a2x/sap/warehouseordertask/0001/$metadata',
          headers: { Accept: 'application/xml', 'sap-client': '100' }
        }, { fetchCsrfToken: false });
        res.set('Content-Type', 'application/xml').send(r.data);
      } catch(e) {
        res.status(500).send(e.message);
      }
    });

    // ── POST /skills/diagnose-block ───────────────────────────────────────────
    app.post('/skills/diagnose-block', async (req, res) => {
      const { huId, warehouse } = req.body || {};
      if (!huId) return res.status(400).json({ success: false, error: 'huId is required' });
      try {
        const { diagnoseBlockReason } = require('./srv/service.js');
        const result = await diagnoseBlockReason(huId, warehouse || '');
        res.json({ success: true, value: result, ...result });
      } catch (e) {
        console.error('[SKILL diagnose-block]', e.message);
        res.status(500).json({ success: false, error: e.message });
      }
    });

    // ── POST /skills/create-incident ──────────────────────────────────────────
    app.post('/skills/create-incident', async (req, res) => {
      const { huId, obdNumber, warehouse, failureType, operator } = req.body || {};
      if (!obdNumber) return res.status(400).json({ success: false, error: 'obdNumber is required' });
      try {
        const { generateIncidentReport } = require('./srv/service.js');
        const result = await generateIncidentReport({ huId: huId || '', obdNumber, warehouse: warehouse || '', failureType: failureType || 'BLOCKED', operator: operator || 'Operator' });
        res.json({ success: true, value: result, ...result });
      } catch (e) {
        console.error('[SKILL create-incident]', e.message);
        res.status(500).json({ success: false, error: e.message });
      }
    });

    // ── POST /skills/find-alternatives ────────────────────────────────────────
    app.post('/skills/find-alternatives', async (req, res) => {
      const { huId, warehouse } = req.body || {};
      if (!huId)      return res.status(400).json({ success: false, error: 'huId is required' });
      if (!warehouse) return res.status(400).json({ success: false, error: 'warehouse is required' });
      try {
        const { findAlternativeHUs } = require('./srv/service.js');
        const result = await findAlternativeHUs(huId, warehouse);
        res.json({ success: true, value: result, ...result });
      } catch (e) {
        console.error('[SKILL find-alternatives]', e.message);
        res.status(500).json({ success: false, error: e.message });
      }
    });

    console.log('[Skills] Registered: /skills/{get-hu-data,scan-pallet,validate-compliance,confirm-loading,handle-exception,diagnose-block,create-incident,find-alternatives}');

    // ── Scale simulator proxy (browser connects directly — these are no-ops) ──
    app.post('/connectScale',    (req, res) => res.json({ success: false, error: 'Use browser direct connection' }));
    app.get('/scaleReading',     (req, res) => res.json({ weight: null, stable: false, unit: 'KG' }));
    app.post('/disconnectScale', (req, res) => res.json({ success: true }));
  });
  try {
    const server = await cds.server({
      service: 'all',
      from:    path.join(__dirname, 'srv'),
      static:  path.join(__dirname, 'webapp')
    });
    console.log('[start] CDS server started, port:', server?.address?.()?.port);
  } catch (e) {
    console.error('[start] cds.server() threw:', e.message, e.stack);
    process.exit(1);
  }
}

main().catch(e => { console.error('[start] Fatal:', e.message); process.exit(1); });
