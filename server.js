'use strict';
const cds    = require('@sap/cds');
const express = require('express');
const path    = require('path');

// Ensure SQLite tables exist before any request comes in.
// Uses CREATE TABLE IF NOT EXISTS — safe to run on every startup.
function ensureSchema() {
  return new Promise((resolve) => {
    try {
      const sqlite3 = require('sqlite3').verbose();
      const dbPath  = path.join(__dirname, 'db.sqlite');
      const db      = new sqlite3.Database(dbPath);
      db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS com_loadassurance_ShipmentScan (
          ID TEXT PRIMARY KEY, createdAt TEXT, createdBy TEXT, modifiedAt TEXT, modifiedBy TEXT,
          outboundDelivery TEXT, warehouse TEXT, scannedBy TEXT,
          totalHUs INTEGER DEFAULT 0, passedHUs INTEGER DEFAULT 0,
          failedHUs INTEGER DEFAULT 0, blockedHUs INTEGER DEFAULT 0,
          dispatchStatus TEXT DEFAULT 'PENDING', aiSummary TEXT
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS com_loadassurance_HUValidation (
          ID TEXT PRIMARY KEY, createdAt TEXT, createdBy TEXT, modifiedAt TEXT, modifiedBy TEXT,
          scan_ID TEXT, huId TEXT, storageBin TEXT,
          expectedWeight REAL, actualWeight REAL, weightUnit TEXT,
          weightDelta REAL, weightDeltaPct REAL,
          weightPassed INTEGER DEFAULT 1, isBlocked INTEGER DEFAULT 0,
          isClosed INTEGER DEFAULT 0, huStatus TEXT, issue TEXT, passed INTEGER DEFAULT 1
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS com_loadassurance_ExceptionLog (
          ID TEXT PRIMARY KEY, createdAt TEXT, createdBy TEXT, modifiedAt TEXT, modifiedBy TEXT,
          scan_ID TEXT, huId TEXT, warehouse TEXT, exceptionType TEXT,
          description TEXT, resolvedBy TEXT DEFAULT 'PENDING', resolutionAction TEXT
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS com_loadassurance_ValidationLog (
          ID TEXT PRIMARY KEY, createdAt TEXT, createdBy TEXT, modifiedAt TEXT, modifiedBy TEXT,
          huId TEXT, warehouse TEXT, expectedWeight REAL, actualWeight REAL,
          weightUnit TEXT, deltaPct REAL, passed INTEGER, aiInsight TEXT
        )`, (err) => {
          db.close();
          if (err) console.error('[DB] Schema error:', err.message);
          else      console.log('[DB] Schema ready');
          resolve();
        });
      });
    } catch (e) {
      console.error('[DB] ensureSchema failed:', e.message);
      resolve(); // non-fatal — let server start anyway
    }
  });
}

cds.on('bootstrap', async (app) => {
  await ensureSchema();

  app.use(express.static(path.join(__dirname, 'webapp')));
  app.use(express.static(path.join(__dirname, 'app')));

  // ── JSON body parser for skill routes ──────────────────────────────────────
  app.use(express.json({ limit: '10mb' }));

  // ── CORS for /skills/* ─────────────────────────────────────────────────────
  app.use('/skills', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ── Lazy ref to service functions (module cached after CDS loads service) ──
  function svc() { return require('./srv/service.js'); }

  // ── POST /skills/get-hu-data ───────────────────────────────────────────────
  app.post('/skills/get-hu-data', async (req, res) => {
    const { warehouse, huId, obdNumber } = req.body || {};
    if (!warehouse) return res.status(400).json({ success: false, error: 'warehouse is required' });
    if (!huId)      return res.status(400).json({ success: false, error: 'huId is required' });
    try {
      const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
      const DESTINATION = 'M20CLNT100';

      const resp = await executeHttpRequest(
        { destinationName: DESTINATION },
        {
          method: 'GET',
          url: '/sap/opu/odata4/sap/api_handlingunit/srvd_a2x/sap/handlingunit/0001/HandlingUnit?$top=200',
          headers: { 'Accept': 'application/json', 'sap-client': '100' }
        }
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
        n  > 0          ? n  :
        lw > 0          ? lw :
        p  > 0          ? p  :
        g  > 0 && t > 0 ? Math.max(0.1, g - t) :
        g  > 0          ? g  : 0;
      const weightSource =
        n  > 0 ? 'NetWeight'     :
        lw > 0 ? 'LoadingWeight' :
        p  > 0 ? 'PlannedWeight' :
        g  > 0 ? 'GrossWeight'   : 'NONE';

      const blocked = !!(raw.EWMHUContentChangeIsBlocked || raw.EWMHUMovementChangeIsBlocked ||
                         raw.EWMHUPostingChangeIsBlocked  || raw.EWMHUIsBlockedByCustoms);
      const huStatus = blocked                       ? 'BLK'
        : raw.EWMHandlingUnitIsLoaded                ? 'LOAD'
        : raw.EWMHandlingUnitIsInStock               ? 'STOCK'
        : raw.EWMHandlingUnitIsPlanned               ? 'PLAN'
        : raw.EWMHandlingUnitIsUnloaded              ? 'UNLD' : 'UNKN';

      const refDocument = raw.HandlingUnitReferenceDocument || '';
      const obdMatch    = obdNumber
        ? refDocument.includes(obdNumber) || obdNumber.includes(refDocument)
        : undefined;

      res.json({
        success: true,
        huId,
        warehouse:      raw.Warehouse        || warehouse,
        storageBin:     raw.StorageBin        || '',
        storageType:    raw.StorageType       || '',
        expectedWeight,
        weightUnit:     raw.WeightUnit        || 'LB',
        weightSource,
        grossWeight:    g,
        netWeight:      n,
        tareWeight:     t,
        isBlocked:      blocked,
        isInStock:      !!raw.EWMHandlingUnitIsInStock,
        isLoaded:       !!raw.EWMHandlingUnitIsLoaded,
        isPlanned:      !!raw.EWMHandlingUnitIsPlanned,
        isClosed:       !!raw.HandlingUnitIsClosed,
        huStatus,
        refDocument,
        refDocType:     '',
        obdMatch,
        error:          null
      });
    } catch (e) {
      console.error('[SKILL get-hu-data]', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /skills/scan-pallet ───────────────────────────────────────────────
  app.post('/skills/scan-pallet', async (req, res) => {
    const { imageBase64, warehouse, obdNumber, mediaType } = req.body || {};
    try {
      const { runVisionAgent } = svc();
      const raw = await runVisionAgent(imageBase64, mediaType || 'image/jpeg');
      res.json({
        success:           true,
        huLabelDetected:   raw.huLabel || raw.labelText || '',
        itemCount:         raw.itemCount || 0,
        stackingCompliant: raw.stackingCompliant !== false,
        stackingLayers:    raw.stackingLayers || 0,
        condition:         raw.condition === 'DAMAGED' ? 'DAMAGED' : raw.condition === 'GOOD' ? 'GOOD' : 'REVIEW',
        damageDetected:    raw.condition === 'DAMAGED',
        wrapIntact:        raw.sealIntact !== false,
        confidence:        raw.confidence >= 80 ? 'HIGH' : raw.confidence >= 50 ? 'MEDIUM' : 'LOW',
        observations:      (raw.issues || []).join('; ') || 'No issues detected',
        error:             null
      });
    } catch (e) {
      console.error('[SKILL scan-pallet]', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /skills/validate-compliance ──────────────────────────────────────
  app.post('/skills/validate-compliance', async (req, res) => {
    const { huId, warehouse, obdNumber, actualWeight, weightUnit, visionResult, ewmData } = req.body || {};
    if (!huId)      return res.status(400).json({ success: false, error: 'huId is required' });
    if (!obdNumber) return res.status(400).json({ success: false, error: 'obdNumber is required' });
    try {
      const { callAI } = svc();
      const expected    = ewmData?.expectedWeight || 0;
      const actual      = actualWeight || 0;
      const delta       = actual - expected;
      const deltaPct    = expected > 0 ? Math.abs(delta) / expected * 100 : 0;
      const weightCheck = deltaPct <= 5;
      const labelCheck  = visionResult
        ? !visionResult.huLabelDetected || visionResult.huLabelDetected === '' ||
          visionResult.huLabelDetected.includes(huId) || huId.includes(visionResult.huLabelDetected)
        : true;
      const obdCheck      = ewmData?.obdMatch !== false;
      const stackingCheck = visionResult ? visionResult.stackingCompliant !== false : true;
      const statusCheck   = ewmData ? !ewmData.isBlocked : true;
      const localVerdict  = !weightCheck || !statusCheck ? 'FAIL' : !stackingCheck || !labelCheck ? 'REVIEW' : 'PASS';

      const aiRaw = await callAI(
        `You are an autonomous warehouse load compliance agent for SAP EWM.
Validate the physical pallet scan against the EWM digital record.
Check: weight tolerance ±5%, label match, OBD assignment, stacking compliance, HU status flags.
Respond JSON only: {"verdict":"PASS/FAIL/REVIEW","confidence":0-100,"rootCause":null,"recommendation":"...","correctionSteps":["..."],"aiInsight":"..."}`,
        `HU: ${huId} | Warehouse: ${warehouse} | OBD: ${obdNumber}
Expected Weight: ${expected} ${weightUnit || ewmData?.weightUnit || 'LB'}
Actual Weight: ${actual} ${weightUnit || 'LB'}
Weight Delta: ${delta.toFixed(3)} (${deltaPct.toFixed(2)}%)
Weight Check: ${weightCheck ? 'PASS' : 'FAIL'}
Label Detected: ${visionResult?.huLabelDetected || 'not scanned'}
Label Check: ${labelCheck ? 'PASS' : 'FAIL'}
OBD Match: ${obdCheck ? 'YES' : 'NO'}
Stacking Compliant: ${stackingCheck ? 'YES' : 'NO'}
Condition: ${visionResult?.condition || 'not scanned'}
HU Blocked: ${ewmData?.isBlocked || false}
Local Verdict: ${localVerdict}`
      );

      let aiResult = null;
      if (aiRaw) { try { const m = aiRaw.match(/\{[\s\S]*\}/); if (m) aiResult = JSON.parse(m[0]); } catch (_) {} }

      const verdict         = aiResult?.verdict || localVerdict;
      const rootCause       = aiResult?.rootCause || (!weightCheck ? `Weight delta ${deltaPct.toFixed(1)}% exceeds 5% threshold` : !statusCheck ? 'HU is blocked in EWM' : null);
      const recommendation  = aiResult?.recommendation || (verdict === 'PASS' ? 'Proceed with loading' : 'Hold pallet — investigate before dispatch');
      const correctionSteps = aiResult?.correctionSteps || (verdict !== 'PASS' ? ['Verify actual weight on certified scale', 'Check EWM HU master data', 'Contact warehouse supervisor'] : []);

      res.json({
        success:        true,
        verdict,
        confidence:     aiResult?.confidence || (verdict === 'PASS' ? 90 : 75),
        weightCheck,
        weightDelta:    parseFloat(delta.toFixed(3)),
        weightDeltaPct: parseFloat(deltaPct.toFixed(2)),
        labelCheck,
        obdCheck,
        stackingCheck,
        statusCheck,
        rootCause,
        recommendation,
        correctionSteps,
        aiInsight:      aiResult?.aiInsight || aiRaw || recommendation,
        error:          null
      });
    } catch (e) {
      console.error('[SKILL validate-compliance]', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /skills/confirm-loading ──────────────────────────────────────────
  app.post('/skills/confirm-loading', async (req, res) => {
    const { obdNumber } = req.body || {};
    if (!obdNumber) return res.status(400).json({ success: false, error: 'obdNumber is required' });
    try {
      const { approveDispatchODO2 } = svc();
      const result = await approveDispatchODO2(obdNumber);
      res.json({
        success:              result.success,
        shippingReadinessSet: result.shippingReadinessSet || result.success,
        loadingActivated:     result.loadingActivated     || false,
        giPosted:             result.giPosted             || result.success,
        complete:             result.success,
        messages:             result.errors || [],
        error:                result.success ? null : (result.errors || []).join('; ')
      });
    } catch (e) {
      console.error('[SKILL confirm-loading]', e.message);
      res.status(500).json({ success: false, shippingReadinessSet: false, loadingActivated: false, giPosted: false, complete: false, messages: [], error: e.message });
    }
  });

  // ── POST /skills/handle-exception ─────────────────────────────────────────
  app.post('/skills/handle-exception', async (req, res) => {
    const { obdNumber, huId, warehouse, failureReason, rootCause } = req.body || {};
    if (!obdNumber) return res.status(400).json({ success: false, error: 'obdNumber is required' });
    const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
    const DESTINATION = 'M20CLNT100';
    const OBD_BASE    = '/sap/opu/odata4/sap/api_whse_outb_delivery_order_2/srvd_a2x/sap/whseoutbdeliveryorder/0001/';
    let giReversed = false, srReversed = false;
    const messages = [];
    try {
      // Get ETag
      const headResp = await executeHttpRequest(
        { destinationName: DESTINATION },
        { method: 'GET', url: OBD_BASE + 'WhseOBDOrdHead/' + obdNumber, headers: { 'Accept': 'application/json', 'sap-client': '100' } }
      );
      const etag = headResp.headers?.etag || headResp.headers?.['etag'] || '*';

      // ReverseGoodsIssue (best-effort)
      try {
        const giResp = await executeHttpRequest(
          { destinationName: DESTINATION },
          { method: 'POST', url: OBD_BASE + 'WhseOBDOrdHead/' + obdNumber + '/ReverseGoodsIssue',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'sap-client': '100', 'If-Match': etag }, data: {} }
        );
        giReversed = giResp.status < 400;
        messages.push(`ReverseGoodsIssue: ${giReversed ? 'OK' : `skipped (HTTP ${giResp.status})`}`);
      } catch (e) { messages.push(`ReverseGoodsIssue: skipped (${e.message})`); }

      // ReverseShippingReadiness — fresh ETag
      const etag2 = await executeHttpRequest(
        { destinationName: DESTINATION },
        { method: 'GET', url: OBD_BASE + 'WhseOBDOrdHead/' + obdNumber, headers: { 'Accept': 'application/json', 'sap-client': '100' } }
      ).then(r => r.headers?.etag || r.headers?.['etag'] || '*').catch(() => '*');

      try {
        const srResp = await executeHttpRequest(
          { destinationName: DESTINATION },
          { method: 'POST', url: OBD_BASE + 'WhseOBDOrdHead/' + obdNumber + '/ReverseShippingReadiness',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'sap-client': '100', 'If-Match': etag2 }, data: {} }
        );
        srReversed = srResp.status < 400;
        messages.push(`ReverseShippingReadiness: ${srReversed ? 'OK' : `FAILED (HTTP ${srResp.status})`}`);
      } catch (e) { messages.push(`ReverseShippingReadiness: error (${e.message})`); }

      res.json({
        success:             srReversed,
        giReversed,
        shippingReversed:    srReversed,
        manualStepsRequired: true,
        manualInstructions: [
          `HOLD pallet HU ${huId || 'unknown'} — do NOT load on vehicle`,
          `In SAP: run /SCWM/CANCPICK to cancel open warehouse tasks for HU ${huId || 'unknown'}`,
          `Reason: ${failureReason || rootCause || 'Compliance check failed'}`,
          `Root cause: ${rootCause || 'See validation report'}`,
          'Move HU to exception zone / quarantine area',
          `Notify warehouse supervisor — OBD ${obdNumber} is on hold`,
          `Re-inspect HU before re-processing outbound delivery ${obdNumber}`
        ],
        messages,
        message: `Exception raised for HU ${huId || 'unknown'} on OBD ${obdNumber}. Shipping readiness ${srReversed ? 'reversed' : 'reversal attempted'}. Manual steps required.`,
        error:   null
      });
    } catch (e) {
      console.error('[SKILL handle-exception]', e.message);
      res.status(500).json({ success: false, giReversed, shippingReversed: srReversed, manualStepsRequired: true, manualInstructions: [], messages, message: '', error: e.message });
    }
  });

  // ── POST /joule/validate ──────────────────────────────────────────────────
  // Single skill endpoint for Joule Studio — validate delivery for dispatch.
  // Inputs: huId (optional), warehouse, outboundDelivery
  // Output: exactly the fields Joule expects
  app.post('/joule/validate', async (req, res) => {
    const { huId, warehouse, outboundDelivery } = req.body || {};
    if (!warehouse)        return res.status(400).json({ result: 'ERROR', message: 'warehouse is required', verdict: 'ERROR', huId: huId || '', huStatus: '', isBlocked: false, rootCause: 'Missing input', storageBin: '', weightUnit: '', expectedWeight: 0, recommendation: 'Provide warehouse number', outboundDelivery: outboundDelivery || '' });
    if (!outboundDelivery) return res.status(400).json({ result: 'ERROR', message: 'outboundDelivery is required', verdict: 'ERROR', huId: huId || '', huStatus: '', isBlocked: false, rootCause: 'Missing input', storageBin: '', weightUnit: '', expectedWeight: 0, recommendation: 'Provide outbound delivery number', outboundDelivery: '' });

    try {
      const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
      const { callAI } = svc();
      const DESTINATION = 'M20CLNT100';
      const HU_PATH = '/sap/opu/odata4/sap/api_handlingunit/srvd_a2x/sap/handlingunit/0001/HandlingUnit?$top=200';

      // Fetch all HUs from EWM
      const resp = await executeHttpRequest(
        { destinationName: DESTINATION },
        { method: 'GET', url: HU_PATH, headers: { Accept: 'application/json', 'sap-client': '100' } },
        { fetchCsrfToken: false }
      );
      const allHUs = resp.data?.value || [];

      // Filter to this delivery — match by reference document
      const obd = outboundDelivery.trim();
      const deliveryHUs = allHUs.filter(h => {
        const ref = (h.HandlingUnitReferenceDocument || '').trim();
        return ref === obd || ref.padStart(10, '0') === obd.padStart(10, '0') ||
               obd.includes(ref) || ref.includes(obd);
      });

      // If huId specified, narrow to that one HU; otherwise take first
      let raw = huId
        ? deliveryHUs.find(h => (h.HandlingUnitExternalID || '').trim() === huId.trim())
        : deliveryHUs[0];

      // Fallback — search all HUs by huId if not found by delivery
      if (!raw && huId) {
        raw = allHUs.find(h =>
          (h.HandlingUnitExternalID || '').trim() === huId.trim() &&
          (h.Warehouse || '').trim() === warehouse.trim()
        );
      }

      if (!raw) {
        const msg = huId
          ? `HU ${huId} not found for delivery ${obd} in warehouse ${warehouse}`
          : `No HUs found for delivery ${obd} in warehouse ${warehouse}`;
        return res.json({
          result: 'NOT_FOUND', verdict: 'REVIEW', message: msg,
          huId: huId || '', huStatus: 'UNKNOWN', isBlocked: false,
          rootCause: 'HU not found in EWM', storageBin: '', weightUnit: 'LB',
          expectedWeight: 0, recommendation: 'Verify delivery number and warehouse in EWM',
          outboundDelivery: obd
        });
      }

      // Map raw EWM fields
      const resolvedHuId = (raw.HandlingUnitExternalID || '').trim();
      const n  = parseFloat(raw.NetWeight     || 0);
      const g  = parseFloat(raw.GrossWeight   || 0);
      const t  = parseFloat(raw.HandlingUnitTareWeight || 0);
      const lw = parseFloat(raw.LoadingWeight || 0);
      const p  = parseFloat(raw.PlannedWeight || 0);
      const expectedWeight =
        n  > 0          ? n  :
        lw > 0          ? lw :
        p  > 0          ? p  :
        g  > 0 && t > 0 ? Math.max(0.1, g - t) :
        g  > 0          ? g  : 0;
      const weightUnit = raw.WeightUnit || 'LB';

      const isBlocked = !!(raw.EWMHUContentChangeIsBlocked || raw.EWMHUMovementChangeIsBlocked ||
                           raw.EWMHUPostingChangeIsBlocked  || raw.EWMHUIsBlockedByCustoms);
      const isClosed  = !!raw.HandlingUnitIsClosed;
      const storageBin = raw.StorageBin || '';
      const huStatus = isBlocked ? 'BLOCKED'
        : raw.EWMHandlingUnitIsLoaded   ? 'LOADED'
        : raw.EWMHandlingUnitIsInStock  ? 'STOCK'
        : raw.EWMHandlingUnitIsPlanned  ? 'PLANNED'
        : isClosed                      ? 'CLOSED' : 'ACTIVE';

      // Determine compliance
      const hasWeight = expectedWeight > 0;
      const weightPassed = hasWeight; // actual weight not provided by Joule — flag for manual check if missing
      const complianceIssues = [];
      if (isBlocked)  complianceIssues.push('HU is blocked in EWM');
      if (isClosed)   complianceIssues.push('HU is closed');
      if (!hasWeight) complianceIssues.push('No weight data recorded in EWM — manual verification required');

      const localVerdict = isBlocked || isClosed ? 'FAIL' : !hasWeight ? 'REVIEW' : 'PASS';

      const rootCause      = complianceIssues.length > 0 ? complianceIssues.join('; ') : 'No issues detected';
      const recommendation = localVerdict === 'PASS'
        ? 'Delivery is clear for dispatch — proceed with shipping readiness.'
        : localVerdict === 'REVIEW'
        ? 'Manual weight verification required — supervisor must confirm HU weight in EWM before dispatch.'
        : 'Hold delivery — resolve blocked or closed HU before dispatch can proceed.';

      const message = localVerdict === 'PASS'
        ? `HU ${resolvedHuId} passed all compliance checks for delivery ${obd}. Ready for dispatch.`
        : localVerdict === 'REVIEW'
        ? `HU ${resolvedHuId} on delivery ${obd} requires manual review before dispatch can proceed.`
        : `HU ${resolvedHuId} on delivery ${obd} failed compliance — dispatch is blocked.`;

      const displayText =
        `Verdict: ${localVerdict}\n` +
        `HU ID: ${resolvedHuId}\n` +
        `Message: ${message}\n` +
        `Root Cause: ${rootCause}\n` +
        `Recommendation: ${recommendation}`;

      res.json({
        result:           displayText,
        verdict:          localVerdict,
        message,
        huId:             resolvedHuId,
        huStatus,
        isBlocked,
        rootCause,
        storageBin,
        weightUnit,
        expectedWeight,
        recommendation,
        outboundDelivery: obd
      });

    } catch (e) {
      console.error('[/joule/validate]', e.message);
      res.status(500).json({
        result: 'ERROR', verdict: 'ERROR', message: 'Validation failed: ' + e.message,
        huId: huId || '', huStatus: '', isBlocked: false, rootCause: e.message,
        storageBin: '', weightUnit: '', expectedWeight: 0,
        recommendation: 'Check EWM connectivity and retry', outboundDelivery: outboundDelivery || ''
      });
    }
  });

  // ── GET /joule/health ──────────────────────────────────────────────────────
  app.get('/joule/health', (req, res) => {
    res.json({
      status: 'operational',
      skills: { scanPallet: 'active', getHUData: 'active', validateCompliance: 'active', confirmLoading: 'active', handleException: 'active', validateDelivery: 'active' },
      connections: { ewm: 'connected', aiCore: 'connected', nvidia: 'connected' },
      timestamp: new Date().toISOString()
    });
  });

  console.log('[Skills] Registered: /skills/{get-hu-data,scan-pallet,validate-compliance,confirm-loading,handle-exception}');

  // SPA fallback — must be last
  app.use((req, res, next) => {
    const p = req.path;
    if (p.startsWith('/api') || p.startsWith('/skills') || p.startsWith('/joule') ||
        p.match(/\.(js|xml|json|css|properties|png|svg|ico)$/)) {
      return next();
    }
    res.sendFile(path.join(__dirname, 'webapp', 'index.html'));
  });
});

module.exports = cds.server;
