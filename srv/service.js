'use strict';
const cds  = require('@sap/cds');
const path = require('path');

// ══════════════════════════════════════════════════════════════════════════════
//  MODULE 1 — EWM Integration
// ══════════════════════════════════════════════════════════════════════════════

const DESTINATION      = 'M20CLNT100';
const EWM_HU_PATH      = '/sap/opu/odata4/sap/api_handlingunit/srvd_a2x/sap/handlingunit/0001/HandlingUnit';
const GI_SERVICE_PATH  = '/sap/opu/odata/sap/API_WHSE_OUTB_DLV_ORDER';
const ODO2_BASE        = '/sap/opu/odata4/sap/api_warehouse_odo_2/srvd_a2x/sap/warehouseoutbdeliveryorder/0001/';
const ODO2_HEAD        = ODO2_BASE + 'WhseOutboundDeliveryOrderHead';
const ODO2_ITEM        = ODO2_BASE + 'WhseOutboundDeliveryOrderItem';
const ODO2_ACT_HEAD    = ODO2_HEAD; // actions on same published service (api_warehouse_odo_2)
const WEIGHT_THRESHOLD = 0.05; // 5%

// ── NVIDIA NIM Vision ─────────────────────────────────────────────────────────
const NVIDIA_API_KEY  = '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';
const NVIDIA_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_MODEL    = 'nvidia/llama-3.2-11b-vision-instruct';

// ── ODO2 Helpers ──────────────────────────────────────────────────────────────

/**
 * GET delivery head — returns data + ETag.
 * Must be called fresh before every POST (ETag changes after each action).
 */
async function getDeliveryHead(obdNumber) {
  const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
  const obdKey = String(obdNumber).padStart(10, '0');
  try {
    console.log(`[ODO2] GET head URL: ${ODO2_HEAD}('${obdKey}')`);
    const resp = await executeHttpRequest(
      { destinationName: DESTINATION },
      {
        method:  'GET',
        url:     `${ODO2_HEAD}('${obdKey}')`,
        headers: { Accept: 'application/json', 'sap-client': '100' }
      },
      { fetchCsrfToken: false }
    );
    console.log(`[ODO2] GET head ${obdKey}: ${resp.status}`);
    const docType = (resp.data?.EWMDeliveryDocumentType || resp.data?.OutboundDeliveryDocCat || '').toUpperCase();
    const isOFO   = docType === 'OFO' || docType.includes('OFO');
    console.log(`[ODO2] DocType=${docType} isOFO=${isOFO}`);
    return {
      success:              resp.status < 400,
      data:                 resp.data,
      etag:                 resp.headers?.etag || resp.headers?.['etag'] || '*',
      shippingStatus:       resp.data?.EWMShippingReadinessStatus,
      immediateLoadActive:  !!resp.data?.EWMOutbDlvOrdImmdLoadgIsActv,
      adhocLoadActive:      !!resp.data?.EWMOutbDlvOrdAdhocLoadgIsActv,
      goodsIssueStatus:     resp.data?.GoodsIssueStatus || '',
      pickingStatus:        resp.data?.PickingStatus || resp.data?.EWMPickingStatus || '',
      freightOrder:         resp.data?.FreightOrder || '',
      docType,
      isOFO
    };
  } catch (e) {
    console.error(`[ODO2] GET head failed for ${obdKey}:`, e.message);
    return { success: false, error: e.message, etag: '*' };
  }
}

/**
 * POST an action on a delivery head — e.g. SetShippingReadiness, PostGoodsIssue.
 * Always call getDeliveryHead first to get a fresh ETag.
 */
async function postDeliveryAction(obdNumber, action, etag) {
  const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
  const obdKey = String(obdNumber).padStart(10, '0');

  // CSRF token comes from the read service (api_warehouse_odo_2) which is published
  let csrfToken = '*';
  let cookies   = '';
  try {
    const tokenResp = await executeHttpRequest(
      { destinationName: DESTINATION },
      { method: 'GET', url: ODO2_HEAD + '?$top=1', headers: { Accept: 'application/json', 'sap-client': '100', 'x-csrf-token': 'Fetch' } },
      { fetchCsrfToken: false }
    );
    csrfToken = tokenResp.headers?.['x-csrf-token'] || tokenResp.headers?.['X-CSRF-Token'] || '*';
    cookies   = (tokenResp.headers?.['set-cookie'] || []).join('; ');
    console.log(`[ODO2] CSRF token for ${action}: ${csrfToken ? 'obtained' : 'empty'}`);
  } catch(e) {
    console.warn(`[ODO2] CSRF fetch failed: ${e.message} — trying with '*'`);
  }

  const postHeaders = {
    Accept:           'application/json',
    'Content-Type':   'application/json',
    'sap-client':     '100',
    'If-Match':       etag,
    'x-csrf-token':   csrfToken
  };
  if (cookies) postHeaders['Cookie'] = cookies;

  const actionUrl = `${ODO2_ACT_HEAD}('${obdKey}')/SAP__self.${action}`;
  console.log(`[ODO2] POST action URL: ${actionUrl}`);
  try {
    const resp = await executeHttpRequest(
      { destinationName: DESTINATION },
      {
        method:  'POST',
        url:     actionUrl,
        headers: postHeaders,
        data: {}
      },
      { fetchCsrfToken: false }
    );
    console.log(`[ODO2] ${action} ${obdKey}: ${resp.status}`, JSON.stringify(resp.data).substring(0, 200));
    return { success: true, status: resp.status, data: resp.data };
  } catch (e) {
    const status = e.response?.status;
    const msg    = e.response?.data?.error?.message || e.message;
    const msgStr = typeof msg === 'object' ? (msg?.value || JSON.stringify(msg)) : String(msg);
    const alreadyDone = msgStr.toLowerCase().includes('already') || msgStr.toLowerCase().includes('requested state');
    const pickingError = msgStr.toLowerCase().includes('picking') || msgStr.includes('document category');
    console.error(`[ODO2] ${action} ${obdKey} failed: ${status} — ${msgStr}`);
    if (alreadyDone) {
      console.log(`[ODO2] ${action} — already in target state, treating as success`);
      return { success: true, status: 200, alreadyDone: true, data: {} };
    }
    return { success: false, status: status || 0, error: pickingError ? `Picking incomplete — ${msgStr}` : msgStr };
  }
}

/**
 * Full dispatch flow on PASS:
 * 1. SetShippingReadiness  (skip if already set)
 * 2. ActivateImmediateLoading  (skip if already active — triggers RF loading task)
 * 3. PostGoodsIssue  (always attempt)
 */
async function approveDispatchODO2(obdNumber) {
  const result = {
    step1_shippingReady:    false,
    step2_loadingActivated: false,
    step3_giPosted:         false,
    complete:               false,
    messages:               [],
    errors:                 []
  };

  // STEP 1 — Set Shipping Readiness
  let head = await getDeliveryHead(obdNumber);
  if (!head.success) {
    result.errors.push('Cannot read delivery: ' + head.error);
    return result;
  }
  if (head.shippingStatus === 'C') {
    result.step1_shippingReady = true;
    result.messages.push('Shipping readiness already set');
  } else if (head.pickingStatus && head.pickingStatus !== 'C') {
    // Picking not complete — EWM will reject SetShippingReadiness
    result.errors.push(`SetShippingReadiness blocked: picking is incomplete (PickingStatus=${head.pickingStatus}). Complete picking first.`);
    console.warn(`[ODO2] Skipping SetShippingReadiness for ${obdNumber} — picking not complete (${head.pickingStatus})`);
  } else {
    const s1 = await postDeliveryAction(obdNumber, 'SetShippingReadiness', head.etag);
    result.step1_shippingReady = s1.success;
    if (s1.success) result.messages.push('Shipping readiness set');
    else            result.errors.push('SetShippingReadiness: ' + s1.error);
  }

  // STEP 2 — Activate Immediate Loading (try for all doc types including OFO)
  head = await getDeliveryHead(obdNumber);
  if (head.immediateLoadActive || head.adhocLoadActive) {
    result.step2_loadingActivated = true;
    result.messages.push('Loading already active');
  } else {
    const s2 = await postDeliveryAction(obdNumber, 'ActivateImmediateLoading', head.etag);
    if (s2.success) {
      result.step2_loadingActivated = true;
      result.messages.push('Loading activated — RF task sent to gun');
    } else {
      // ASR action failed — try adhoc for non-ASR deliveries
      const s2err = s2.error || '';
      const isBlocked2 = s2err.toLowerCase().includes('blocked') || s2err.includes('BEHAVIOR_ILLEGAL');
      if (!isBlocked2) {
        const head2b = await getDeliveryHead(obdNumber);
        const s2b = await postDeliveryAction(obdNumber, 'ActivateAdhocLoading', head2b.etag);
        result.step2_loadingActivated = s2b.success;
        if (s2b.success) result.messages.push('Adhoc loading activated (non-ASR)');
        else             result.errors.push('ActivateAdhocLoading: ' + s2b.error);
      } else {
        result.step2_loadingActivated = false;
        result.errors.push('ActivateImmediateLoading: ' + s2err);
      }
    }
  }

  // STEP 3 — Post Goods Issue
  head = await getDeliveryHead(obdNumber);
  const s3 = await postDeliveryAction(obdNumber, 'PostGoodsIssue', head.etag);
  if (!s3.success) {
    // Soft-success: already posted
    const msgLc = (s3.error || '').toLowerCase();
    if (msgLc.includes('already posted') || msgLc.includes('bereits gebucht') || msgLc.includes('already locked')) {
      result.step3_giPosted = true;
      result.messages.push('Goods Issue already posted');
    } else {
      result.errors.push('PostGoodsIssue: ' + s3.error);
    }
  } else {
    result.step3_giPosted = true;
    result.messages.push('Goods Issue posted');
  }

  result.complete = result.step1_shippingReady && result.step2_loadingActivated && result.step3_giPosted;
  return result;
}

/**
 * Wrong pallet flow:
 * 1. Check if GI was already posted → ReverseGoodsIssue first
 * 2. ReverseShippingReadiness
 * 3. Give operator manual /SCWM/CANCPICK instructions
 */

async function handleWrongPallet(obdNumber, huId, warehouse, storageBin) {
  console.log('[WRONG PALLET] OBD:', obdNumber, 'HU:', huId, 'Bin:', storageBin);

  const result = {
    giReversed:       false,
    shippingReversed: false,
    wtCreated:        false,
    wtNumber:         null,
    wtMessage:        '',
    message:          '',
    manualSteps:      []
  };

  // STEP 1: Reverse GI if already posted
  let head = await getDeliveryHead(obdNumber);
  if (!head.success) {
    result.message = 'Cannot read delivery — use /SCWM/CANCPICK manually';
    result.manualSteps = [
      'STOP — Do NOT load HU ' + huId,
      'Open SAP transaction /SCWM/CANCPICK',
      'Enter Warehouse: ' + warehouse + ', HU: ' + huId,
      'Execute — creates return task on RF gun',
      'Complete return task on RF gun',
      'Use /SCWM/PRDO to remove HU ' + huId + ' from delivery ' + obdNumber,
      'Get correct HU for delivery ' + obdNumber,
      'Bring to GI-ZONE and scan here'
    ];
    return result;
  }

  if (head.goodsIssueStatus === 'C') {
    console.log('[WRONG PALLET] GI already posted — reversing first');
    const rgi = await postDeliveryAction(obdNumber, 'ReverseGoodsIssue', head.etag);
    result.giReversed = rgi.success;
    if (rgi.success) head = await getDeliveryHead(obdNumber);
  }

  // STEP 2: Reverse Shipping Readiness — only if it was actually set
  const shippingStatus = head.shippingStatus || '';
  if (shippingStatus === 'C' || shippingStatus === 'B') {
    const rsr = await postDeliveryAction(obdNumber, 'ReverseShippingReadiness', head.etag);
    result.shippingReversed = rsr.success;
    console.log('[WRONG PALLET] Shipping reversed:', rsr.success, '(was status:', shippingStatus + ')');
  } else {
    result.shippingReversed = true; // nothing to reverse — skip
    console.log('[WRONG PALLET] Shipping readiness not set (status:', shippingStatus + ') — skipping reversal');
  }

  // STEP 3: Build operator checklist — direct operator to /SCWM/CANCPICK
  result.wtCreated = false;
  result.wtNumber  = null;
  result.wtMessage = 'Use /SCWM/CANCPICK in SAP to create return task manually for HU ' + huId;

  result.manualSteps = [
    'STOP — Do NOT load HU ' + huId + ' onto vehicle',
    'Open SAP transaction /SCWM/CANCPICK',
    'Enter Warehouse: ' + warehouse,
    'Enter HU: ' + huId,
    'Execute — EWM creates return task on RF gun',
    'Complete return task on RF gun — move HU back to storage',
    'Open SAP /SCWM/PRDO — remove HU ' + huId + ' from delivery ' + obdNumber,
    'Get correct HU for delivery ' + obdNumber,
    'Bring correct HU to GI-ZONE and scan here'
  ];

  result.message = result.shippingReversed
    ? 'Delivery ' + obdNumber + ' reset in EWM. Use /SCWM/CANCPICK to cancel pick task manually.'
    : 'Could not reset delivery automatically. Follow manual steps below.';

  return result;
}

/**
 * Detect failure type based on HU validation results.
 * Returns one of: OBD_MISMATCH | BLOCKED | WEIGHT_VIOLATION | STACKING_VIOLATION | LABEL_MISSING | OTHER
 */
function detectFailureType(hu) {
  if (!hu) return 'OTHER';
  // OBD mismatch is detected at scan level, not HU level — this handles HU-level failures
  if (hu.isBlocked)                          return 'BLOCKED';
  if (!hu.weightPassed)                      return 'WEIGHT_VIOLATION';
  if (!hu.stackingCompliant)                 return 'STACKING_VIOLATION';
  const label = (hu.labelStatus || '').toUpperCase();
  if (label === 'MISSING')                   return 'LABEL_MISSING';
  if (label === 'DAMAGED')                   return 'LABEL_DAMAGED';
  return 'OTHER';
}

/**
 * Fetch delivery items for an OBD from ODO2 V4.
 * Filters in Node — never uses $filter in URL.
 */
async function getDeliveryItems(obdNumber) {
  const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
  const obdKey = String(obdNumber).padStart(10, '0');

  // Try 1: navigation from head entity
  try {
    const resp = await executeHttpRequest(
      { destinationName: DESTINATION },
      { method: 'GET', url: `${ODO2_HEAD}('${obdKey}')/to_DeliveryOrderItem?$top=50`, headers: { Accept: 'application/json', 'sap-client': '100' } },
      { fetchCsrfToken: false }
    );
    const all = resp.data?.value || [];
    console.log(`[ITEMS] Navigation result: ${all.length} items for ${obdKey}`);
    return all.map(i => ({
      item:        i.EWMOutboundDeliveryOrderItem || '',
      product:     i.Product                      || '',
      quantity:    parseFloat(i.ProductQuantity   || 0),
      unit:        i.QuantityUnit                 || '',
      giStatus:    i.GoodsIssueStatus             || '',
      pickStatus:  i.PickingStatus                || '',
      stagingArea: i.StagingArea                  || '',
      stagingBay:  i.StagingBay                   || '',
      giPosted:    (i.GoodsIssueStatus || '') === 'C'
    }));
  } catch (e) {
    console.warn(`[ITEMS] Navigation failed for ${obdKey}: ${e.response?.status} ${e.message} — trying flat entity`);
  }

  // Try 2: flat item entity (user-provided URL), no $filter — fetch top 100 and filter in Node
  try {
    const resp = await executeHttpRequest(
      { destinationName: DESTINATION },
      { method: 'GET', url: `${ODO2_ITEM}?$top=100`, headers: { Accept: 'application/json', 'sap-client': '100' } },
      { fetchCsrfToken: false }
    );
    const all = resp.data?.value || [];
    const filtered = all.filter(i => (i.EWMOutboundDeliveryOrder || '').padStart(10,'0') === obdKey);
    console.log(`[ITEMS] Flat entity: ${all.length} total, ${filtered.length} for ${obdKey}`);
    return filtered.map(i => ({
      item:        i.EWMOutboundDeliveryOrderItem || '',
      product:     i.Product                      || '',
      quantity:    parseFloat(i.ProductQuantity   || 0),
      unit:        i.QuantityUnit                 || '',
      giStatus:    i.GoodsIssueStatus             || '',
      pickStatus:  i.PickingStatus                || '',
      stagingArea: i.StagingArea                  || '',
      stagingBay:  i.StagingBay                   || '',
      giPosted:    (i.GoodsIssueStatus || '') === 'C'
    }));
  } catch (e) {
    console.warn(`[ITEMS] Flat entity also failed: ${e.response?.status} ${e.message}`);
    return [];
  }
}

/**
 * Returns operator fix instructions for each failure type.
 */
function getFixInstructions(failureType, huId, bin) {
  switch (failureType) {
    case 'WEIGHT_VIOLATION':
      return [
        'HU stays at GI-ZONE — do NOT move',
        'Open HU and verify contents match delivery items',
        'Remove excess items or add missing items',
        'Re-weigh on scale',
        'Re-scan in this app when weight is corrected'
      ];
    case 'STACKING_VIOLATION':
      return [
        'Do NOT load — stacking is unsafe',
        'Unstack pallet completely',
        'Restack: heaviest items on bottom',
        'Medium weight in middle, light/fragile on top only',
        'Re-wrap with stretch film',
        'Re-scan in this app'
      ];
    case 'LABEL_MISSING':
      return [
        'Inspect all 4 sides of HU ' + huId,
        'If label found: scan to confirm in EWM',
        'If label missing: print replacement via /SCWM/MATL or LT0A',
        'Apply label to standard position on HU',
        'Re-scan in this app'
      ];
    case 'LABEL_DAMAGED':
      return [
        'Label on HU ' + huId + ' is damaged — manual inspection required',
        'Verify HU ID matches delivery contents',
        'Print replacement label via /SCWM/MATL or LT0A',
        'Apply new label, then supervisor must approve dispatch',
        'Re-scan in this app'
      ];
    case 'BLOCKED':
      return [
        'HU ' + huId + ' is blocked in EWM',
        'Check block reason in /SCWM/MON',
        'Contact warehouse supervisor',
        'Remove block before loading is possible'
      ];
    default:
      return [
        'Investigate issue with HU ' + huId + ' at bin ' + (bin || 'GI-ZONE'),
        'Contact warehouse supervisor',
        'Re-scan after issue is resolved'
      ];
  }
}

/**
 * Fetch all HUs for a warehouse from EWM OData V4.
 */
async function fetchHUs(warehouseNumber) {
  const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
  console.log(`[EWM] Fetching HUs for warehouse: ${warehouseNumber}`);
  const all = [];
  let url = `${EWM_HU_PATH}?$top=1000&$filter=Warehouse eq '${warehouseNumber}'`;
  let page = 0;
  while (url) {
    page++;
    const response = await executeHttpRequest(
      { destinationName: DESTINATION },
      { method: 'GET', url, headers: { 'Accept': 'application/json', 'sap-client': '100' } }
    );
    const items = response.data?.value || [];
    all.push(...items);
    console.log(`[EWM] Page ${page}: ${items.length} HUs (total so far: ${all.length})`);
    // OData server-driven paging: follow nextLink if present
    const next = response.data?.['@odata.nextLink'];
    if (next && items.length > 0) {
      // nextLink may be absolute or relative
      url = next.startsWith('http') ? next : `${EWM_HU_PATH.replace(/\/[^/]+$/, '')}/${next}`;
    } else {
      url = null;
    }
    if (page > 20) { console.warn('[EWM] Pagination safety limit reached'); break; }
  }
  console.log(`[EWM] Total fetched: ${all.length} for warehouse ${warehouseNumber}`);
  if (all.length > 0) {
    // Dump all fields of first HU so we can find the delivery reference field
    console.log(`[EWM] RAW FIRST HU FIELDS:`, JSON.stringify(all[0]));
  }
  if (all.length > 0) {
    // Log first HU raw keys so we can see which field holds the delivery reference
    const sample = all[0];
    const refFields = Object.keys(sample).filter(k => /ref|doc|delivery|order|delvry/i.test(k));
    console.log(`[EWM] Sample HU ref-related fields:`, JSON.stringify(refFields.reduce((o,k) => { o[k]=sample[k]; return o; }, {})));
  }
  return all.map(mapAPIHandlingUnit);
}

/**
 * Fetch HUs for a specific outbound delivery — filters at EWM level, much faster.
 * Falls back to warehouse-wide fetch + local filter if direct query returns nothing
 * (handles leading-zero variants like 0080000029 vs 80000029).
 */
async function fetchDelivery(outboundDelivery, warehouse) {
  if (!outboundDelivery) return fetchHUs(warehouse);

  const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

  // Try direct filter by reference document (both with and without leading zeros)
  const norm     = d => d.toString().replace(/^0+/, '');
  const variants = [...new Set([outboundDelivery, outboundDelivery.padStart(10, '0'), norm(outboundDelivery)])];

  for (const variant of variants) {
    try {
      const filter = `Warehouse eq '${warehouse}' and HandlingUnitReferenceDocument eq '${variant}'`;
      console.log(`[EWM] Trying direct filter: ${filter}`);
      const response = await executeHttpRequest(
        { destinationName: DESTINATION },
        {
          method:  'GET',
          url:     `${EWM_HU_PATH}?$top=200&$filter=${encodeURIComponent(filter)}`,
          headers: { 'Accept': 'application/json', 'sap-client': '100' }
        }
      );
      const items = response.data?.value || [];
      console.log(`[EWM] Direct filter '${variant}': ${items.length} items`);
      if (items.length > 0) {
        console.log(`[EWM] Delivery ${outboundDelivery} (as '${variant}'): ${items.length} HUs (direct filter)`);
        return items.map(mapAPIHandlingUnit);
      }
    } catch (e) { console.warn(`[EWM] Direct filter failed for variant '${variant}':`, e.message); }
  }

  // Fallback: warehouse-wide fetch + local filter
  console.log(`[EWM] Direct filter found nothing — falling back to warehouse scan`);
  try {
    const rawResp = await executeHttpRequest(
      { destinationName: DESTINATION },
      { method: 'GET', url: `${EWM_HU_PATH}?$top=1&$filter=Warehouse eq '${warehouse}'`, headers: { 'Accept': 'application/json', 'sap-client': '100' } }
    );
    const rawItems = rawResp.data?.value || [];
    if (rawItems.length > 0) {
      const sample = rawItems[0];
      const refFields = Object.keys(sample).filter(k => /ref|doc|delivery|order|delvry|outb/i.test(k));
      console.log(`[EWM] Raw HU ref fields:`, JSON.stringify(refFields.reduce((o,k) => { o[k]=sample[k]; return o; }, {})));
    }
  } catch(e) { console.warn('[EWM] Raw HU inspect failed:', e.message); }
  const allHUs = await fetchHUs(warehouse);
  const filtered = allHUs.filter(h => norm(h.refDocument) === norm(outboundDelivery));
  console.log(`[EWM] Delivery ${outboundDelivery}: ${filtered.length} HUs (fallback)`);
  return filtered;
}

/**
 * Maps a raw EWM OData V4 HandlingUnit record to the internal model.
 */
function mapAPIHandlingUnit(hu) {
  const grossWeight    = parseFloat(hu.GrossWeight || 0);
  const netWeight      = parseFloat(hu.NetWeight   || 0);
  const tareWeight     = parseFloat(hu.HandlingUnitTareWeight || 0);
  const loadingWeight  = parseFloat(hu.LoadingWeight || 0);
  const plannedWeight  = parseFloat(hu.PlannedWeight || hu.HandlingUnitPlannedWeight || 0);
  const expectedWeight =
    netWeight     > 0 ? netWeight :
    loadingWeight > 0 ? loadingWeight :
    plannedWeight > 0 ? plannedWeight :
    (grossWeight > 0 && tareWeight > 0) ? Math.max(0, grossWeight - tareWeight) :
    grossWeight   > 0 ? grossWeight : 0;
  console.log(`[Weight] HU ${hu.HandlingUnitExternalID}: net=${netWeight} loading=${loadingWeight} planned=${plannedWeight} gross=${grossWeight} tare=${tareWeight} → expected=${expectedWeight} ${hu.WeightUnit || 'LB'}`);
  const blocked = !!(
    hu.EWMHUContentChangeIsBlocked  ||
    hu.EWMHUMovementChangeIsBlocked ||
    hu.EWMHUPostingChangeIsBlocked  ||
    hu.EWMHUIsBlockedByCustoms
  );
  const huStatus = blocked                       ? 'BLK'
    : hu.EWMHandlingUnitIsLoaded                 ? 'LOAD'
    : hu.EWMHandlingUnitIsInStock                ? 'STOCK'
    : hu.EWMHandlingUnitIsPlanned                ? 'PLAN'
    : hu.EWMHandlingUnitIsUnloaded               ? 'UNLD'
    :                                              'UNKN';
  return {
    huId:             hu.HandlingUnitExternalID  || '',
    huType:           hu.PackagingMaterialType   || hu.PackagingMaterial || '',
    packagingMaterial: hu.PackagingMaterial      || '',
    warehouseNumber:  hu.Warehouse               || '',
    storageBin:       hu.StorageBin              || '',
    expectedWeight,
    expectedWeightUnit: hu.WeightUnit            || 'LB',
    grossWeight,
    tareWeight,
    netWeight,
    isPlanned:   !!hu.EWMHandlingUnitIsPlanned,
    isInStock:   !!hu.EWMHandlingUnitIsInStock,
    isLoaded:    !!hu.EWMHandlingUnitIsLoaded,
    isUnloaded:  !!hu.EWMHandlingUnitIsUnloaded,
    isBlocked:   blocked,
    isClosed:    !!hu.HandlingUnitIsClosed,
    huStatus,
    labelStatus: '',
    refDocument: hu.HandlingUnitReferenceDocument || ''
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  MODULE 2 — SAP AI Core Integration
// ══════════════════════════════════════════════════════════════════════════════

const AI_DEPLOYMENT_ID  = 'd7c6d5586db36270';
const AI_RESOURCE_GROUP = 'default';
let _aiToken       = null;
let _aiTokenExpiry = 0;

function getAICoreCredentials() {
  try {
    const vcap = process.env.VCAP_SERVICES ? JSON.parse(process.env.VCAP_SERVICES) : {};
    return vcap['aicore']?.[0]?.credentials
        || vcap['AI Core']?.[0]?.credentials
        || vcap['ai-core']?.[0]?.credentials
        || null;
  } catch (e) { return null; }
}

async function getAIToken(creds) {
  if (_aiToken && Date.now() < _aiTokenExpiry) return _aiToken;
  const resp = await fetch(`${creds.uaa?.url || creds.url}/oauth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     creds.uaa?.clientid     || creds.clientid,
      client_secret: creds.uaa?.clientsecret || creds.clientsecret
    })
  });
  if (!resp.ok) throw new Error(`AI token failed (${resp.status})`);
  const data = await resp.json();
  _aiToken       = data.access_token;
  _aiTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _aiToken;
}

async function callAI(systemPrompt, userPrompt) {
  const creds = getAICoreCredentials();
  if (!creds) { console.warn('[AI] No credentials'); return null; }
  try {
    const token   = await getAIToken(creds);
    const baseUrl = creds.serviceurls?.AI_API_URL || creds.url;
    const url     = `${baseUrl}/v2/inference/deployments/${AI_DEPLOYMENT_ID}/invoke`;
    const resp = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization':     `Bearer ${token}`,
        'Content-Type':      'application/json',
        'AI-Resource-Group': AI_RESOURCE_GROUP
      },
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 600,
        messages: [{ role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }]
      })
    });
    if (!resp.ok) throw new Error(`AI Core ${resp.status}`);
    const result = await resp.json();
    console.log('[AI] Response OK');
    return result.content?.[0]?.text || '';
  } catch (e) { console.error('[AI] Call failed:', e.message); return null; }
}

async function analyzeShipment(warehouse, outboundDelivery, stats, issueLines) {
  const failedList = issueLines.join('; ') || 'none';
  return callAI(
    `You are a warehouse load assurance AI for SAP EWM. Write a 2-3 line plain-text summary for an operator.
No headers, no markdown, no labels like "Warehouse:" or "Dispatch Status:". Just plain sentences.
State the verdict (approved/blocked/pending review), which HUs have issues, and the single next action required.`,
    `Warehouse: ${warehouse} | Delivery: ${outboundDelivery || 'All'}
Total HUs: ${stats.totalHUs} | Passed: ${stats.passedHUs} | Failed: ${stats.failedHUs} | Blocked: ${stats.blockedHUs}
Dispatch: ${stats.dispatchStatus}
Issues: ${failedList}`
  );
}

async function resolveExceptionAI(huId, warehouse, exceptionType, huData) {
  return callAI(
    `You are a warehouse load assurance AI for SAP EWM. An operator needs a specific
resolution action for a handling unit exception. Provide a concrete, actionable
step-by-step resolution in under 100 words.`,
    `HU: ${huId} | Warehouse: ${warehouse} | Exception: ${exceptionType}
HU Status: ${huData?.huStatus || 'UNKNOWN'} | Bin: ${huData?.storageBin || 'UNKNOWN'}
Gross: ${huData?.grossWeight || 0} | Net: ${huData?.netWeight || 0} | Expected: ${huData?.expectedWeight || 0}
Blocked: ${huData?.isBlocked} | Closed: ${huData?.isClosed}`
  );
}

// ── diagnoseBlockReason ───────────────────────────────────────────────────────
// Fetches raw HU from EWM (bypassing mapAPIHandlingUnit) to read the 4 individual
// block flags, then asks AI to explain exactly which block is active and how to fix it.
async function diagnoseBlockReason(huId, warehouse) {
  const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
  let raw = null;
  try {
    const resp = await executeHttpRequest(
      { destinationName: DESTINATION },
      { method: 'GET', url: EWM_HU_PATH + '?$top=200', headers: { Accept: 'application/json', 'sap-client': '100' } },
      { fetchCsrfToken: false }
    );
    const all = resp.data?.value || [];
    raw = all.find(h =>
      (h.HandlingUnitExternalID || '').trim() === huId.trim() &&
      (!warehouse || (h.Warehouse || '').trim() === warehouse.trim())
    );
  } catch (e) {
    console.error('[diagnoseBlockReason] EWM fetch failed:', e.message);
  }

  const contentBlocked  = !!(raw?.EWMHUContentChangeIsBlocked);
  const movementBlocked = !!(raw?.EWMHUMovementChangeIsBlocked);
  const postingBlocked  = !!(raw?.EWMHUPostingChangeIsBlocked);
  const customsBlocked  = !!(raw?.EWMHUIsBlockedByCustoms);

  const activeBlocks = [];
  if (contentBlocked)  activeBlocks.push('Content change blocked (materials sealed/committed)');
  if (movementBlocked) activeBlocks.push('Movement blocked (HU cannot be transferred between bins)');
  if (postingBlocked)  activeBlocks.push('Posting blocked (accounting/inventory posting lock)');
  if (customsBlocked)  activeBlocks.push('Customs hold (clearance required before release)');
  const primaryReason = activeBlocks[0] || (raw ? 'Block reason unknown — HU flagged as blocked in EWM' : 'HU not found in EWM');

  const aiExplanation = await callAI(
    `You are an SAP EWM warehouse expert. Explain a handling unit block situation to a warehouse operator.
Be concise (under 150 words), use plain language, and give the exact SAP transaction(s) to resolve.`,
    `HU: ${huId} | Warehouse: ${warehouse}
Active block flags: ${activeBlocks.length ? activeBlocks.join('; ') : 'unknown'}
HU status in EWM: ${raw?.EWMHandlingUnitIsInStock ? 'In Stock' : raw?.EWMHandlingUnitIsLoaded ? 'Loaded' : raw?.EWMHandlingUnitIsPlanned ? 'Planned' : 'Unknown'}
Storage bin: ${raw?.StorageBin || 'unknown'}
Explain: (1) what each active block means, (2) likely root cause, (3) exact SAP transaction to remove the block and proceed with dispatch.`
  ) || primaryReason;

  return { huId, contentBlocked, movementBlocked, postingBlocked, customsBlocked, primaryReason, aiExplanation };
}

// ── generateIncidentReport ────────────────────────────────────────────────────
// Creates a structured supervisor incident report for a blocked/failed dispatch.
async function generateIncidentReport({ huId, obdNumber, warehouse, failureType }) {
  const incidentId = 'INC-' + Date.now();
  const timestamp  = new Date().toISOString();

  const aiRaw = await callAI(
    `You are a warehouse incident management AI. Return ONLY valid JSON:
{"aiRootCause":"<one sentence root cause>","estimatedResolutionTime":"<e.g. 15-30 minutes>","actionsRequired":["Action 1","Action 2","Action 3"]}`,
    `Incident: HU ${huId} on delivery ${obdNumber} in warehouse ${warehouse}. Failure type: ${failureType}.
Generate: root cause (one sentence), estimated resolution time, and 3 required actions for the supervisor.`
  );

  let aiRootCause             = `${failureType} condition detected on HU ${huId}`;
  let estimatedResolutionTime = '15-30 minutes';
  let actionsRequired         = ['Inspect HU at storage bin', 'Contact warehouse supervisor', 'Re-scan after resolution'];

  if (aiRaw) {
    try {
      const m = aiRaw.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (parsed.aiRootCause)             aiRootCause             = parsed.aiRootCause;
        if (parsed.estimatedResolutionTime) estimatedResolutionTime = parsed.estimatedResolutionTime;
        if (parsed.actionsRequired)         actionsRequired         = parsed.actionsRequired;
      }
    } catch (_) {}
  }

  const incidentText =
`WAREHOUSE INCIDENT REPORT
═══════════════════════════════════════
Incident ID  : ${incidentId}
Timestamp    : ${new Date(timestamp).toLocaleString()}
─────────────────────────────────────
Delivery     : ${obdNumber}
Warehouse    : ${warehouse}
Handling Unit: ${huId}
Failure Type : ${failureType}
─────────────────────────────────────
AI Root Cause: ${aiRootCause}
Est. Resolution Time: ${estimatedResolutionTime}
─────────────────────────────────────
REQUIRED ACTIONS:
${actionsRequired.map((a, i) => `  ${i + 1}. ${a}`).join('\n')}
═══════════════════════════════════════
Generated by Load Assurance Agent`;

  return { incidentId, timestamp, huId, obdNumber, warehouse, failureType, aiRootCause, estimatedResolutionTime, incidentText };
}

// ── sendIncidentEmail ─────────────────────────────────────────────────────────
// Sends incident report by email using env vars: SUPERVISOR_EMAIL, SMTP_HOST,
// SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.  Returns { sent, error }.
async function sendIncidentEmail(incidentId, failureType, obdNumber, incidentText) {
  const supervisorEmail = process.env.SUPERVISOR_EMAIL;
  if (!supervisorEmail) return { sent: false, error: 'SUPERVISOR_EMAIL not configured' };
  try {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
      host:   process.env.SMTP_HOST || 'smtprelay.sap.com',
      port:   parseInt(process.env.SMTP_PORT || '25', 10),
      secure: false,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
      tls:   { rejectUnauthorized: false }
    });
    await transport.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER || 'load-assurance@noreply.local',
      to:      supervisorEmail,
      subject: `[INCIDENT] ${incidentId} — ${failureType} on delivery ${obdNumber}`,
      text:    incidentText,
      html:    `<pre style="font-family:monospace;font-size:13px">${incidentText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`
    });
    console.log(`[Incident] Email sent to ${supervisorEmail} for ${incidentId}`);
    return { sent: true, error: null };
  } catch (e) {
    console.warn(`[Incident] Email failed: ${e.message}`);
    return { sent: false, error: e.message };
  }
}

// ── findAlternativeHUs ────────────────────────────────────────────────────────
// Finds substitute HUs in the warehouse that could replace a failed HU.
async function findAlternativeHUs(failedHuId, warehouse, outboundDelivery) {
  let allHUs = [];
  try {
    allHUs = await fetchHUs(warehouse);
  } catch (e) {
    console.error('[findAlternativeHUs] fetchHUs failed:', e.message);
  }

  const failedHU = allHUs.find(h => h.huId === failedHuId);
  if (!failedHU) return { bestCandidate: null, aiRanking: JSON.stringify({ bestNote:'', swapSteps:[], otherNotes:{} }), candidates: [] };

  // Fetch delivery items to get product name — best-effort, don't block on failure
  let productName = '';
  if (outboundDelivery) {
    try {
      const items = await getDeliveryItems(outboundDelivery);
      if (items.length > 0) productName = items[0].product || '';
      console.log(`[findAlternativeHUs] product from delivery items: "${productName}"`);
    } catch (e) {
      console.warn(`[findAlternativeHUs] delivery items fetch failed: ${e.message}`);
    }
  }

  // Score each candidate: higher = better
  const scored = allHUs
    .filter(h => h.huId !== failedHuId && !h.isClosed)
    .map(h => {
      let score = 0;
      // Weight match (most important)
      const wRef = failedHU.expectedWeight || 0;
      const wCand = h.expectedWeight || 0;
      if (wRef > 0 && wCand > 0) {
        const pct = Math.abs((wCand - wRef) / wRef);
        if (pct <= 0.05) score += 40;
        else if (pct <= 0.15) score += 20;
        else if (pct <= 0.30) score += 5;
      } else if (wCand > 0) {
        score += 10; // has weight, reference unknown
      }
      // Packaging type match
      if (failedHU.packagingMaterial && h.packagingMaterial === failedHU.packagingMaterial) score += 20;
      // Status
      if (h.huStatus === 'STOCK') score += 15;
      // Not blocked
      if (!h.isBlocked) score += 15;
      // Has a bin assigned
      if (h.storageBin && h.storageBin !== 'BLOCKED_BIN') score += 10;
      return { ...h, _score: score };
    })
    .filter(h => h._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 5);

  const candidates = scored;

  if (!candidates.length) {
    return { bestCandidate: null, aiRanking: JSON.stringify({ bestNote: 'No suitable alternatives found.', swapSteps: [], otherNotes: {} }), candidates: [] };
  }

  const candidateList = candidates.map(c =>
    `  HU ${c.huId} | Bin: ${c.storageBin} | Weight: ${c.expectedWeight} ${c.expectedWeightUnit} | Type: ${c.packagingMaterial || 'N/A'} | Status: ${c.huStatus}`
  ).join('\n');

  const aiRaw = await callAI(
    `You are an SAP EWM warehouse AI. Rank substitute HUs for a failed dispatch.
Return ONLY valid JSON with this exact structure:
{"bestCandidate":"<huId>","bestNote":"<one short sentence: weight match + status>","ranking":[{"huId":"...","note":"<10 words max>"}]}

Format rules:
- bestNote: e.g. "5 LB match, STOCK status — best weight fit"
- ranking: other candidates only (not best), max 4 entries, each note under 10 words
- No long paragraphs, no methodology explanation`,
    `Failed HU: ${failedHuId} | Weight: ${failedHU.expectedWeight} ${failedHU.expectedWeightUnit} | Bin: ${failedHU.storageBin} | Type: ${failedHU.packagingMaterial || 'N/A'}
Candidates:\n${candidateList}`
  );

  let bestCandidate = candidates[0].huId;
  let bestNote      = '';
  let swapSteps     = [
    `/SCWM/BINSTAT → check bin status for ${candidates[0]?.storageBin || 'target bin'}`,
    `/SCWM/PRDO → remove HU ${failedHuId} from delivery`,
    `Assign HU ${candidates[0]?.huId || bestCandidate} → confirm picking`,
    `/SCWM/MON → verify before goods issue`
  ];
  const candidatesOut = candidates.map(c => {
    // Auto-generate fallback aiNote from scored properties
    const flags = [];
    if (c.isBlocked) flags.push('⚠️ bin blocked — unblock before use');
    else if (c.storageBin === 'BLOCKED_BIN') flags.push('⚠️ bin blocked — unblock before use');
    if (!c.storageBin) flags.push('no bin assigned');
    if ((c.expectedWeight || 0) === 0) flags.push('weight unknown');
    return { ...c, aiNote: flags.join(', ') };
  });

  if (aiRaw) {
    try {
      const m = aiRaw.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (parsed.bestCandidate) bestCandidate = parsed.bestCandidate;
        if (parsed.bestNote)      bestNote      = parsed.bestNote;
        if (Array.isArray(parsed.swapSteps) && parsed.swapSteps.length) {
          swapSteps = parsed.swapSteps.map(s => s.replace(/^Step\s*\d+[:.]\s*/i, '').trim());
        }
        (parsed.ranking || []).forEach(r => {
          const c = candidatesOut.find(x => x.huId === r.huId);
          if (c) c.aiNote = r.note || '';
        });
      }
    } catch (_) {}
  }

  // Build structured aiRanking for backward-compat field (also used as fallback)
  const best = candidatesOut.find(c => c.huId === bestCandidate) || candidatesOut[0];
  const others = candidatesOut.filter(c => c.huId !== bestCandidate);
  const aiRanking = JSON.stringify({ bestNote, swapSteps, otherNotes: others.reduce((acc, c) => { acc[c.huId] = c.aiNote; return acc; }, {}) });

  return {
    bestCandidate,
    aiRanking,
    candidates: candidatesOut.map(c => ({
      huId: c.huId, storageBin: c.storageBin, expectedWeight: c.expectedWeight,
      packagingMaterial: c.packagingMaterial || '', huStatus: c.huStatus, aiNote: c.aiNote,
      productName: productName || ''
    }))
  };
}

// ── generateRepackSuggestion ──────────────────────────────────────────────────
// Suggests specific items to add/remove to bring a weight-violated HU into tolerance.
async function generateRepackSuggestion(huId, outboundDelivery, warehouse) {
  let allHUs = [];
  try { allHUs = await fetchHUs(warehouse); } catch (_) {}
  const hu = allHUs.find(h => h.huId === huId);
  if (!hu) return { huId, actualWeight: 0, expectedWeight: 0, deltaLB: 0, direction: 'UNKNOWN', repackInstruction: 'HU not found in EWM.', steps: [], estimatedNewWeight: 0, withinTolerance: false };

  const actualWeight   = hu.grossWeight   || 0;
  const expectedWeight = hu.expectedWeight || 0;
  const deltaLB        = parseFloat((actualWeight - expectedWeight).toFixed(3));
  const direction      = deltaLB > 0 ? 'OVER' : 'UNDER';
  const tolerance      = expectedWeight * 0.05;

  let items = [];
  try { items = await getDeliveryItems(outboundDelivery); } catch (_) {}

  const itemList = items.length
    ? items.map(i => `  Item ${i.item}: Product ${i.product} | Qty: ${i.quantity} ${i.unit}`).join('\n')
    : '  No delivery item detail available';

  const aiRaw = await callAI(
    `You are an SAP EWM repack advisor. A pallet is ${direction === 'OVER' ? 'overweight' : 'underweight'}.
Return ONLY valid JSON:
{"repackInstruction":"<specific instruction, 1-2 sentences>","steps":["Step 1...","Step 2...","Step 3..."],"estimatedNewWeight":<number>,"withinTolerance":<true|false>}
Note: per-unit weights may not be available — give best-effort estimate and flag uncertainty.`,
    `HU: ${huId} | Delivery: ${outboundDelivery} | Warehouse: ${warehouse}
Actual weight: ${actualWeight} LB | Expected: ${expectedWeight} LB | Delta: ${deltaLB} LB (${direction})
Tolerance window: ±${tolerance.toFixed(2)} LB (5%)
Delivery items:\n${itemList}
Suggest specific add/remove actions to bring weight within tolerance.`
  );

  let repackInstruction = `${direction === 'OVER' ? 'Remove' : 'Add'} items to bring weight within ±5% of ${expectedWeight} LB (${(expectedWeight - tolerance).toFixed(2)}–${(expectedWeight + tolerance).toFixed(2)} LB).`;
  let steps             = ['Weigh each item type individually', `${direction === 'OVER' ? 'Remove' : 'Add'} items as needed`, 'Re-weigh HU to confirm', 'Re-scan delivery'];
  let estimatedNewWeight = expectedWeight;
  let withinTolerance    = false;

  if (aiRaw) {
    try {
      const m = aiRaw.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (parsed.repackInstruction) repackInstruction = parsed.repackInstruction;
        if (parsed.steps)             steps             = parsed.steps;
        if (parsed.estimatedNewWeight != null) estimatedNewWeight = parseFloat(parsed.estimatedNewWeight);
        if (parsed.withinTolerance    != null) withinTolerance    = !!parsed.withinTolerance;
      }
    } catch (_) {}
  }

  return { huId, actualWeight, expectedWeight, deltaLB, direction, repackInstruction, steps, estimatedNewWeight, withinTolerance };
}

// ══════════════════════════════════════════════════════════════════════════════
//  MULTI-AGENT ARCHITECTURE
//  Agent 1 — Vision    (NVIDIA NIM)
//  Agent 2 — Knowledge (SAP EWM)
//  Agent 3 — Decision  (Claude via SAP AI Core)
//  Agent 4 — Action    (EWM writeback)
//  Agent 5 — Resolution(Claude via SAP AI Core)
//  Orchestrator        (Promise.all Agent1+2 → Agent3 → Agent4|5)
// ══════════════════════════════════════════════════════════════════════════════

const NVIDIA_VISION_DEPLOYMENT_ID  = process.env.NVIDIA_VISION_DEPLOYMENT_ID  || '';
const NVIDIA_VISION_RESOURCE_GROUP = process.env.NVIDIA_VISION_RESOURCE_GROUP || 'default';
const NVIDIA_VISION_MODEL          = process.env.NVIDIA_VISION_MODEL          || 'meta/llama-3.2-90b-vision-instruct';

// ── Agent 1 — Vision Agent ────────────────────────────────────────────────────
/**
 * Sends pallet image to NVIDIA NIM Vision.
 * Primary route: SAP AI Core deployment. Fallback: direct NVIDIA API key.
 * Returns structured vision findings + agent timing.
 */
async function runVisionAgent(imageBase64, mediaType) {
  const t0      = Date.now();
  const dataUrl = `data:${mediaType || 'image/jpeg'};base64,${imageBase64}`;

  // ── STEP 1: NVIDIA — get plain-text visual description ───────────────────
  const nvidiaPrompt = `Describe everything you see with this warehouse pallet. Be very specific about:
- Are boxes leaning, falling, or improperly stacked?
- Is shrink wrap covering everything or are there gaps, loose bags, or unwrapped areas?
- Look at the WOODEN PALLET BOARDS — are they cracked, broken, or missing? (NOT the products on top)
- Look carefully at any CANS or TINS — do they show rust or corrosion? (This is product damage, not pallet damage)
- Look carefully at the bottom front of the pallet for a white label with barcode and HU number. Read the exact number on that label.
- Read any visible product text on boxes (brand names, product names).
- How many boxes or items are on the pallet?

Be very strict about stacking and wrap:

STACKING FAIL — describe as "stacking fail" or "item falling off pallet" if ANY item is:
- Falling off or hanging off the pallet edge
- Leaning more than 15 degrees
- Not supported by the layer below
- A bag or flexible package not secured to the pallet

WRAP FAIL — describe as "wrap fail" or "item outside wrap" if ANY item is:
- Not covered by shrink wrap
- Visibly loose outside the wrap boundary
- A bag or flexible package sitting outside the wrap

Check stacking carefully:
- Are ALL boxes on the top layer the same height?
- Does the top layer overhang the layer below?
- Are boxes flush and aligned on all sides?
If top layer has mixed height boxes OR overhangs the layer below — describe this clearly as "uneven top layer" or "overhang".
Always report: the HU label number you can read, and any product text visible.
List every problem you see. Also confirm what is correct. Do not return JSON — just describe what you observe.`;

  const nvidiaBody = JSON.stringify({
    model:       NVIDIA_VISION_MODEL,
    max_tokens:  800,
    temperature: 0.1,
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: dataUrl } },
      { type: 'text',      text: nvidiaPrompt }
    ]}]
  });

  let nvidiaDescription = '';

  // Primary: SAP AI Core
  if (NVIDIA_VISION_DEPLOYMENT_ID) {
    try {
      console.log('[Agent1:Vision] Routing via SAP AI Core:', NVIDIA_VISION_DEPLOYMENT_ID);
      const creds   = getAICoreCredentials();
      const token   = await getAIToken(creds);
      const baseUrl = creds.serviceurls?.AI_API_URL || creds.url;
      const resp    = await fetch(`${baseUrl}/v2/inference/deployments/${NVIDIA_VISION_DEPLOYMENT_ID}/invoke`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'AI-Resource-Group': NVIDIA_VISION_RESOURCE_GROUP },
        body: nvidiaBody
      });
      if (!resp.ok) throw new Error(`AI Core vision ${resp.status}`);
      const data = await resp.json();
      nvidiaDescription = data.choices?.[0]?.message?.content || data.content?.[0]?.text || '';
    } catch (e) {
      console.error('[Agent1:Vision] AI Core failed, falling back to direct NVIDIA:', e.message);
    }
  }

  // Fallback: direct NVIDIA API
  if (!nvidiaDescription && NVIDIA_API_KEY) {
    console.log('[Agent1:Vision] Calling NVIDIA NIM directly...');
    const resp = await fetch(NVIDIA_ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
      body: nvidiaBody
    });
    if (!resp.ok) throw new Error(`NVIDIA API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    nvidiaDescription = data.choices?.[0]?.message?.content || '';
  }

  if (!nvidiaDescription) throw new Error('Vision AI not available — check NVIDIA_VISION_DEPLOYMENT_ID or API key');

  console.log('[Agent1:Vision] NVIDIA description:', nvidiaDescription);

  // ── STEP 2: Claude — structure the plain-text description into JSON ───────
  const claudePrompt = `You are a warehouse pallet inspector AI.
Based on this visual description of a warehouse pallet:

"${nvidiaDescription}"

═══════════════════════════════════════════════════
MANDATORY RULES — apply these before anything else
═══════════════════════════════════════════════════

RULE 1 — Rust detection (HARD RULE, no exceptions):
If the description mentions rust, corrosion, or oxidation on cans, tins, or metal containers:
- Set palletCondition = GOOD  (the wooden pallet is fine)
- Add exactly this issue: "Rusty product detected — canned goods show corrosion, unsuitable for dispatch"
- Do NOT write "rusty pallet", "rusty brackets", or "rusty structure"
- Do NOT set palletCondition = DAMAGED because of rusty cans
Only set palletCondition = DAMAGED if wooden pallet BOARDS are cracked, broken, or missing.

RULE 2 — Wrap integrity: report MAXIMUM ONE wrap issue.
Set stretchWrapIntact = false and wrapIntegrity = FAIL if the description mentions ANY of:
- "wrap fail", "item outside wrap", "bag outside wrap"
- items or bags not covered by shrink wrap
- loose items outside the wrap boundary
- gaps, unwrapped areas, or loose bags hanging outside
Consolidate ALL wrap problems into one single issue: "Loose areas in shrink wrap — items not secured"
NEVER list both "gaps in wrap" AND "loose areas" as separate issues. One issue only.

RULE 3 — Pallet condition: report MAXIMUM ONE pallet condition issue.
NEVER report both "Damaged wooden pallet with visible cracks" AND "Visible wear on wooden pallet".
Pick the most severe one only.

RULE 4 — Maximum 3 issues total (hard limit).
Priority order when consolidating:
  1. Product damage (rust, dents, torn packaging)
  2. Wrap integrity (one consolidated issue)
  3. Stacking issues (one consolidated issue)
Never output more than 3 items in the issues array.

RULE 5 — Stacking evaluation:
Set stackingCompliant = false if the description mentions ANY of:
- "stacking fail", "item falling off pallet", "falling off", "hanging off edge"
- "uneven top layer" or "mixed heights on top"
- "overhang" (top layer extends beyond layer below)
- boxes not flush or aligned, mismatched box sizes on same layer
- any box leaning more than ~15 degrees
- a bag or flexible package not secured or sitting outside the pallet
Set stackingCompliant = false AND stretchWrapIntact = false AND verdict = FAIL if description mentions
"stacking fail" or "item falling off" or "bag falling off" or "item outside wrap".
If stackingCompliant = false but wrap intact, no rust, no pallet damage:
- verdict = REVIEW (NOT FAIL)
- stackingRecommendation = "Re-stack top layer with matching box sizes to ensure stability before dispatch."
verdict = FAIL for: rusty product detected, wrap integrity failure (stretchWrapIntact=false), palletCondition=DAMAGED, or items falling off pallet.

═══════════════════════════════════════════════════

Return ONLY this JSON with no other text, no markdown fences:
{
  "huLabel": "<primary HU ID or barcode visible, null if none>",
  "huLabels": ["all label text and barcodes visible"],
  "itemCount": <number of boxes/items on pallet>,
  "palletCondition": "GOOD" or "DAMAGED",
  "labelDamage": false,
  "missingLabels": false,
  "observations": "<one sentence summarising the main issue or confirming compliance>",
  "stackingCompliant": true or false,
  "stackingVerdict": "COMPLIANT" or "REVIEW" or "VIOLATION",
  "layersDetected": <number of layers>,
  "heavyOnTop": false,
  "overhanging": false,
  "stretchWrapIntact": true or false,
  "estimatedHeightCm": 0,
  "stabilityScore": <0-100>,
  "stackingViolations": ["specific issue 1"],
  "stackingRecommendation": "Stack is compliant",
  "labelTextsRead": ["HU# <number read from white label>", "<any product names visible>"],
  "issues": ["max 3 consolidated issues — see RULES above"],
  "wrapIntegrity": "PASS" or "FAIL" or "REVIEW",
  "verdict": "PASS" or "FAIL" or "REVIEW",
  "confidence": 0.90
}

General rules:
- verdict = FAIL only if: rusty product in issues OR palletCondition=DAMAGED OR stretchWrapIntact=false
- verdict = REVIEW if: stackingCompliant=false (and no FAIL condition above) OR any minor/uncertain issue
- verdict = PASS if the pallet looks well-stacked, wrapped, and has no clear problems
- wrapIntegrity = PASS if shrink wrap is intact, FAIL if missing or damaged, REVIEW if uncertain
- confidence must be a number between 0.0 and 1.0 — use 0.85 or higher if description is detailed
- issues must list specific problems — if no problems, return empty array []
- If the pallet looks generally good, return PASS and empty issues array

LABELS — always populate labelTextsRead:
- Always read and report the HU label number from the white label at the bottom of the pallet
- Also read any visible product text on boxes
- Never leave labelTextsRead empty — use format: "HU# [number]" and "[product names seen]"
- If no label is visible, write "No HU label visible"`;

  let findings = {
    huLabel: null, huLabels: [], itemCount: 0, palletCondition: 'GOOD',
    labelDamage: false, missingLabels: false, observations: nvidiaDescription.slice(0, 200),
    stackingCompliant: true, stackingVerdict: 'COMPLIANT',
    layersDetected: 0, heavyOnTop: false, overhanging: false,
    stretchWrapIntact: true, estimatedHeightCm: 0, stabilityScore: 70,
    stackingViolations: [], stackingRecommendation: 'Stack is compliant',
    labelTextsRead: [], issues: [], verdict: 'PASS', confidence: 0.75
  };

  try {
    const claudeText = await callAI(
      'You are a warehouse pallet inspector. Return only valid JSON, no markdown.',
      claudePrompt
    );
    console.log('[Agent1:Vision] Claude raw:', claudeText || '(empty)');

    if (claudeText) {
      const clean = claudeText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      let parsed = null;
      try {
        parsed = JSON.parse(match ? match[0] : clean);
      } catch(parseErr) {
        console.error('[Agent1:Vision] JSON.parse failed:', parseErr.message);
      }

      if (parsed) {
        console.log('[Agent1:Vision] Parsed fields:', JSON.stringify({
          verdict:       parsed.verdict,
          confidence:    parsed.confidence,
          wrapIntegrity: parsed.wrapIntegrity || parsed.wrap_integrity || parsed.WrapIntegrity,
          issueCount:    (parsed.issues || parsed.Issues || parsed.problems || []).length
        }));

        // Normalise confidence — Claude may return string like "0.92" or number 0.92
        const rawConf = parsed.confidence ?? parsed.Confidence ?? 0.85;
        const normConf = parseFloat(String(rawConf)) || 0.85;

        // Normalise wrapIntegrity — handle various casing/naming
        const wrapVal = parsed.wrapIntegrity || parsed.wrap_integrity || parsed.WrapIntegrity
          || (parsed.stretchWrapIntact === false ? 'FAIL' : parsed.stretchWrapIntact === true ? 'PASS' : 'REVIEW');

        // Normalise issues — handle various key names
        let issueArr = parsed.issues || parsed.Issues || parsed.problems || parsed.Problems || [];

        // Server-side enforcement of RULES 1-4 (safety net in case Claude ignores prompt)
        // Rule 2: collapse multiple wrap issues into one
        const wrapIssues = issueArr.filter(i => /wrap|shrink/i.test(i));
        if (wrapIssues.length > 1) {
          issueArr = issueArr.filter(i => !/wrap|shrink/i.test(i));
          issueArr.push('Loose areas in shrink wrap');
        }
        // Rule 3: collapse multiple pallet condition issues into one (most severe first)
        const palletIssues = issueArr.filter(i => /pallet.*crack|crack.*pallet|damaged.*pallet|pallet.*damage|wear.*pallet|pallet.*wear|broken.*board|board.*broken/i.test(i));
        if (palletIssues.length > 1) {
          issueArr = issueArr.filter(i => !/pallet.*crack|crack.*pallet|damaged.*pallet|pallet.*damage|wear.*pallet|pallet.*wear|broken.*board|board.*broken/i.test(i));
          issueArr.push(palletIssues[0]); // keep most severe (first listed)
        }
        // Rule 4: hard cap at 3 issues — priority: product damage, wrap, stacking
        if (issueArr.length > 3) {
          const productIssues  = issueArr.filter(i => /rust|corrosion|rusty|torn|dent|damage.*product|product.*damage/i.test(i));
          const wrapIssues2    = issueArr.filter(i => /wrap|shrink/i.test(i));
          const stackIssues    = issueArr.filter(i => /stack|lean|overhang|unstable/i.test(i));
          const otherIssues    = issueArr.filter(i =>
            !/rust|corrosion|rusty|torn|dent|damage.*product|product.*damage|wrap|shrink|stack|lean|overhang|unstable/i.test(i)
          );
          issueArr = [...productIssues, ...wrapIssues2, ...stackIssues, ...otherIssues].slice(0, 3);
        }

        findings = {
          ...findings,
          ...parsed,
          confidence:    normConf,
          wrapIntegrity: wrapVal,
          issues:        issueArr
        };
      }
    }
  } catch (e) {
    console.error('[Agent1:Vision] Claude structuring failed:', e.message, '— using keyword fallback');
    const lc = nvidiaDescription.toLowerCase();
    findings.palletCondition   = (lc.includes('broken board') || lc.includes('cracked board') || lc.includes('broken pallet') || lc.includes('damaged wood')) ? 'DAMAGED' : 'GOOD';
    const rustyProduct = lc.includes('rust') || lc.includes('corrosion');
    findings.stackingCompliant = !lc.includes('lean') && !lc.includes('overhang') && !lc.includes('unstable') && !lc.includes('tipping');
    findings.stretchWrapIntact = !lc.includes('loose') && !lc.includes('unwrap') && !lc.includes('gap') && !lc.includes('missing wrap');
    findings.issues = [];
    if (!findings.stackingCompliant) findings.issues.push('Stacking non-compliant');
    if (!findings.stretchWrapIntact) findings.issues.push('Shrink wrap integrity compromised');
    if (findings.palletCondition !== 'GOOD') findings.issues.push('Pallet boards damaged');
    if (rustyProduct) findings.issues.push('Rusty product detected — canned goods show corrosion, unsuitable for dispatch');
    findings.verdict     = (findings.issues.length || rustyProduct) ? 'FAIL' : 'REVIEW';
    findings.confidence  = 0.6;
    findings.observations = nvidiaDescription.slice(0, 200);
  }

  console.log(`[Agent1:Vision] Done in ${Date.now() - t0}ms — verdict:${findings.verdict} confidence:${findings.confidence} issues:${(findings.issues||[]).length}`);
  return { ...findings, nvidiaDescription, agentTime: Date.now() - t0, agentStatus: 'DONE' };
}

// ── Agent 2 — Knowledge Agent ─────────────────────────────────────────────────
/**
 * Fetches all relevant EWM data for a delivery.
 * Returns HU list, delivery items (for short-pick detection), and metadata.
 */
async function runKnowledgeAgent(warehouse, outboundDelivery) {
  const t0 = Date.now();
  console.log(`[Agent2:Knowledge] Fetching EWM data — WH:${warehouse} OBD:${outboundDelivery}`);

  // Fetch HUs
  let hus = [];
  try {
    hus = await fetchDelivery(outboundDelivery, warehouse);
  } catch (e) {
    console.warn(`[Agent2:Knowledge] HU fetch failed: ${e.message} — using mock`);
    hus = getMockHUs(outboundDelivery, warehouse);
  }
  if (!hus.length) {
    console.warn('[Agent2:Knowledge] No HUs from EWM — using mock');
    hus = getMockHUs(outboundDelivery, warehouse);
  }

  // Fetch delivery items for short-pick detection (best-effort)
  let deliveryItems = [];
  try {
    const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
    const norm    = outboundDelivery.replace(/^0+/, '');
    const variant = outboundDelivery.padStart(10, '0');
    for (const dlv of [outboundDelivery, variant, norm]) {
      const resp = await executeHttpRequest(
        { destinationName: DESTINATION },
        { method: 'GET', url: `/sap/opu/odata4/sap/api_outbound_delivery_srv/srvd_a2x/sap/outbounddelivery/0001/OutboundDeliveryItem?$top=100`, headers: { 'Accept': 'application/json', 'sap-client': '100' } }
      );
      const items = (resp.data?.value || []).filter(i => i.OutboundDelivery === dlv || i.DeliveryDocument === dlv);
      if (items.length) { deliveryItems = items; break; }
    }
  } catch (e) {
    console.warn('[Agent2:Knowledge] Delivery items fetch failed (non-fatal):', e.message);
  }

  // Detect short picks
  const shortPicks = deliveryItems.filter(i =>
    parseFloat(i.ActualDeliveryQuantity || 0) < parseFloat(i.DeliveryQuantity || i.RequestedQuantity || 0)
  );

  console.log(`[Agent2:Knowledge] Done in ${Date.now() - t0}ms — ${hus.length} HUs, ${deliveryItems.length} items, ${shortPicks.length} short picks`);
  return {
    hus,
    deliveryItems,
    shortPicks,
    totalExpectedWeight: hus.reduce((s, h) => s + (h.expectedWeight || 0), 0),
    huCount:             hus.length,
    agentTime:           Date.now() - t0,
    agentStatus:         'DONE'
  };
}

// ── Agent 3 — Decision Agent ──────────────────────────────────────────────────
/**
 * Cross-checks vision findings against EWM data.
 * Returns structured verdict: PASS | REVIEW | FAIL + confidence + rootCause.
 */
async function runDecisionAgent(visionResult, knowledgeResult, scaleWeight) {
  const t0  = Date.now();
  const hus = knowledgeResult.hus || [];

  // Run validation rules on all HUs
  const huValidations = hus.map(hu => {
    const actual   = scaleWeight && hus.length === 1 ? parseFloat(scaleWeight) : hu.grossWeight;
    const delta    = actual - hu.expectedWeight;
    const deltaPct = hu.expectedWeight > 0 ? Math.abs(delta) / hu.expectedWeight : 0;
    return { ...validateHUData({ ...hu, grossWeight: actual }), huId: hu.huId };
  });

  const failed  = huValidations.filter(h => h.status === 'Failed');
  const reviews = huValidations.filter(h => h.status === 'Review');
  const blocked = huValidations.filter(h => h.isBlocked);

  // Vision cross-checks
  const visionLabels   = (visionResult?.huLabels || []).map(l => l.toUpperCase().replace(/\s/g, ''));
  const ewmHuIds       = hus.map(h => h.huId.toUpperCase().replace(/\s/g, ''));
  const labelMatch     = visionLabels.length > 0 && visionLabels.some(l => ewmHuIds.some(id => id.includes(l) || l.includes(id)));
  const itemCountMatch = visionResult?.itemCount > 0 ? Math.abs(visionResult.itemCount - hus.length) <= 1 : null;

  // Determine overall verdict
  const hasHardFail = failed.length > 0 || blocked.length > 0
    || visionResult?.palletCondition === 'DAMAGED'
    || visionResult?.labelDamage === true
    || knowledgeResult.shortPicks?.length > 0;

  const hasReview = reviews.length > 0
    || visionResult?.palletCondition === 'UNSTABLE'
    || visionResult?.missingLabels === true
    || (visionResult?.huLabels?.length > 0 && !labelMatch);

  const verdict = hasHardFail ? 'FAIL' : hasReview ? 'REVIEW' : 'PASS';

  // Build root cause list
  const causes = [];
  if (failed.length)   causes.push(...failed.map(h => `${h.huId}: ${h.issue}`));
  if (blocked.length)  causes.push(...blocked.map(h => `${h.huId}: blocked in EWM`));
  if (visionResult?.palletCondition === 'DAMAGED') causes.push('Pallet physically damaged (camera)');
  if (visionResult?.labelDamage)   causes.push('Label damage detected by camera');
  if (knowledgeResult.shortPicks?.length) causes.push(`Short-pick detected on ${knowledgeResult.shortPicks.length} delivery item(s)`);
  if (reviews.length)  causes.push(...reviews.map(h => `${h.huId}: ${h.issue}`));
  if (!labelMatch && visionResult?.huLabels?.length > 0) causes.push(`Camera label "${visionResult.huLabels[0]}" not found in EWM HU list`);

  // Ask Claude for final combined analysis
  const huSummary = huValidations.map(h => `  ${h.huId}: ${h.status} | expected=${h.expectedWeight}kg actual=${h.actualWeight}kg delta=${h.weightDeltaPct}% label=${h.labelStatus}`).join('\n');
  const aiAnalysis = await callAI(
    `You are Agent 3 — Decision Agent in a SAP EWM Load Assurance multi-agent system.
Cross-check vision findings against EWM data and return ONLY valid JSON:
{"verdict":"PASS"|"REVIEW"|"FAIL","confidence":<0-100>,"rootCause":"<one sentence>","dispatchRecommendation":"<one sentence action>"}`,
    `Warehouse HU Data:\n${huSummary}
Vision: label=${visionResult?.huLabel || 'none'} condition=${visionResult?.palletCondition} damage=${visionResult?.labelDamage} items=${visionResult?.itemCount}
Label match: ${labelMatch} | Item count match: ${itemCountMatch} | Short picks: ${knowledgeResult.shortPicks?.length || 0}
Rule-based verdict: ${verdict}
Root causes: ${causes.join('; ') || 'none'}`
  );

  let aiJson = { verdict, confidence: verdict === 'PASS' ? 90 : verdict === 'REVIEW' ? 60 : 30, rootCause: causes[0] || 'All checks passed', dispatchRecommendation: verdict === 'PASS' ? 'Approve for dispatch.' : 'Hold for inspection.' };
  if (aiAnalysis) {
    const m = aiAnalysis.match(/\{[\s\S]*\}/);
    if (m) { try { aiJson = { ...aiJson, ...JSON.parse(m[0]) }; } catch (e) { /* use defaults */ } }
  }

  // Always use rule-based verdict as ground truth — AI can only downgrade, not upgrade
  if (hasHardFail)  aiJson.verdict = 'FAIL';
  else if (hasReview && aiJson.verdict === 'PASS') aiJson.verdict = 'REVIEW';

  console.log(`[Agent3:Decision] Done in ${Date.now() - t0}ms — verdict:${aiJson.verdict} confidence:${aiJson.confidence}%`);
  return {
    verdict:                aiJson.verdict,
    confidence:             aiJson.confidence,
    rootCause:              aiJson.rootCause,
    dispatchRecommendation: aiJson.dispatchRecommendation,
    huValidations,
    labelMatch,
    itemCountMatch,
    causes,
    agentTime:              Date.now() - t0,
    agentStatus:            'DONE'
  };
}

// ── Agent 4 — Action Agent ────────────────────────────────────────────────────
/**
 * Triggered only on PASS verdict.
 * Full dispatch: SetShippingReadiness → ActivateImmediateLoading → PostGoodsIssue
 */
async function runActionAgent(outboundDelivery, huId, decisionResult) {
  const t0 = Date.now();
  console.log(`[Agent4:Action] Full dispatch flow for delivery ${outboundDelivery}`);
  try {
    const dispatch = await approveDispatchODO2(outboundDelivery);
    console.log(`[Agent4:Action] Done in ${Date.now() - t0}ms — complete:${dispatch.complete} steps: ${dispatch.messages.join(' | ')}`);
    return {
      success:            dispatch.complete,
      message:            dispatch.messages.join(' | ') || (dispatch.errors[0] || 'GI flow done'),
      confirmationNumber: dispatch.step3_giPosted ? `GI-${outboundDelivery}-${Date.now()}` : null,
      agentTime:          Date.now() - t0,
      agentStatus:        gi.success ? 'DONE' : 'FAILED'
    };
  } catch (e) {
    console.error('[Agent4:Action] GI failed:', e.message);
    return { success: false, message: e.message, agentTime: Date.now() - t0, agentStatus: 'FAILED' };
  }
}

// ── Agent 5 — Resolution Agent ────────────────────────────────────────────────
/**
 * Triggered only on FAIL/REVIEW verdict.
 * Returns structured correction plan for the operator.
 */
async function runResolutionAgent(decisionResult, knowledgeResult, visionResult, warehouse) {
  const t0   = Date.now();
  console.log('[Agent5:Resolution] Generating resolution plan...');

  const huSummary = (knowledgeResult.hus || []).map(h =>
    `  ${h.huId}: expected=${h.expectedWeight}${h.expectedWeightUnit} actual=${h.grossWeight}${h.expectedWeightUnit} bin=${h.storageBin} status=${h.huStatus}`
  ).join('\n');

  const failedHU  = (knowledgeResult.hus || []).find(h => h.huStatus !== 'CONF') || knowledgeResult.hus?.[0];
  const sourceBin = failedHU?.storageBin || 'GI-ZONE';
  const huId      = failedHU?.huId || '';
  const obdNumber = knowledgeResult.outboundDelivery || '';

  const raw = await callAI(
    `You are Agent 5 — Resolution Agent in a SAP EWM Load Assurance system.
Return ONLY valid JSON — no markdown, no extra text:
{
  "failureReason": "<clear plain-English explanation, max 100 chars>",
  "operatorInstruction": "<single sentence: what the operator must do right now, max 100 chars>",
  "correctionSteps": ["Step 1...", "Step 2...", "Step 3..."],
  "estimatedResolutionTime": "<e.g. 10-15 minutes>"
}`,
    `Verdict: ${decisionResult.verdict}
Root Cause: ${decisionResult.rootCause}
EWM HU Data:\n${huSummary}
Vision: condition=${visionResult?.palletCondition} labelDamage=${visionResult?.labelDamage} observations="${visionResult?.observations}"`
  );

  let resolution = {
    failureReason:           decisionResult.rootCause || 'Validation failed',
    operatorInstruction:     `Go to bin ${sourceBin}, inspect HU ${huId}, fix issue and re-scan`,
    correctionSteps:         ['Inspect HU at bin ' + sourceBin, 'Verify weight and label', 'Re-scan after correction'],
    estimatedResolutionTime: '10-15 minutes'
  };

  if (raw) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { resolution = { ...resolution, ...JSON.parse(m[0]) }; } catch (e) { /* use defaults */ } }
  }

  // Call ReverseShippingReadiness on ODO2 to reset EWM delivery status
  let reversalResult = { success: false, message: 'No OBD available', nextStep: '' };
  if (obdNumber) {
    try {
      reversalResult = await handleWrongPallet(obdNumber, huId, warehouse, sourceBin);
      console.log(`[Agent5:Resolution] handleWrongPallet: shippingReversed=${reversalResult.shippingReversed} wtCreated=${reversalResult.wtCreated} — ${reversalResult.message}`);
    } catch (e) {
      console.error('[Agent5:Resolution] ReverseShippingReadiness failed:', e.message);
      reversalResult = { success: false, message: e.message, nextStep: 'Use /SCWM/CANCPICK manually' };
    }
  }

  const ewmAction = reversalResult.success
    ? `Shipping readiness reversed in EWM for delivery ${obdNumber}. Re-pick required.`
    : `EWM action failed: ${reversalResult.message}. Manual action: /SCWM/CANCPICK`;

  console.log(`[Agent5:Resolution] Done in ${Date.now() - t0}ms — EWM reversal: ${reversalResult.success ? 'OK' : 'FAILED'}`);
  return {
    ...resolution,
    ewmAction,
    reversalSuccess: reversalResult.success,
    reversalMessage: reversalResult.message,
    nextStep:        reversalResult.success
      ? `Re-scan after fixing HU ${huId}`
      : reversalResult.nextStep || 'Fix manually then re-scan',
    // Keep wtCreated false — WT API not activated
    wtCreated:   false,
    wtNumber:    null,
    wtText:      resolution.operatorInstruction,
    agentTime:   Date.now() - t0,
    agentStatus: 'DONE'
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
/**
 * Agent1 + Agent2 run in PARALLEL -> Agent3 -> Agent4 (PASS) | Agent5 (FAIL/REVIEW)
 */
async function orchestrateValidation({ warehouse, outboundDelivery, imageBase64, mediaType, scaleWeight, quickMode }) {
  console.log(`[Orchestrator] Starting — WH:${warehouse} OBD:${outboundDelivery} hasImage:${!!imageBase64} quickMode:${!!quickMode}`);
  const t0 = Date.now();

  // Agent 1 + Agent 2 in PARALLEL
  const [visionResult, knowledgeResult] = await Promise.all([
    imageBase64
      ? runVisionAgent(imageBase64, mediaType).catch(e => {
          console.error('[Orchestrator] Agent1 failed:', e.message);
          return { huLabel: null, huLabels: [], itemCount: 0, palletCondition: 'UNKNOWN', labelDamage: false, missingLabels: false, observations: 'Vision unavailable', agentStatus: 'FAILED', agentTime: 0 };
        })
      : Promise.resolve({ huLabel: null, huLabels: [], itemCount: 0, palletCondition: 'UNKNOWN', labelDamage: false, missingLabels: false, observations: 'No image provided', agentStatus: 'SKIPPED', agentTime: 0 }),
    runKnowledgeAgent(warehouse, outboundDelivery)
  ]);

  // Agent 3 — Decision
  const decisionResult = await runDecisionAgent(visionResult, knowledgeResult, scaleWeight);

  // In quick mode (pallet scan button) — skip action/resolution agents, return fast
  if (quickMode) {
    console.log(`[Orchestrator] Quick mode — skipping agents 4/5, done in ${Date.now() - t0}ms`);
    return { ...decisionResult, visionFindings: visionResult, ewmData: knowledgeResult,
             agents: { vision: visionResult, knowledge: knowledgeResult, decision: decisionResult } };
  }

  // Agent 4 or 5 based on verdict
  let actionResult     = null;
  let resolutionResult = null;

  if (decisionResult.verdict === 'PASS') {
    const primaryHU = knowledgeResult.hus?.[0]?.huId || '';
    actionResult = await runActionAgent(outboundDelivery, primaryHU, decisionResult);
  } else {
    resolutionResult = await runResolutionAgent(decisionResult, knowledgeResult, visionResult, warehouse);
  }

  console.log(`[Orchestrator] Complete in ${Date.now() - t0}ms — verdict:${decisionResult.verdict}`);

  return {
    // Agent outputs
    agents: {
      vision:     visionResult,
      knowledge:  knowledgeResult,
      decision:   decisionResult,
      action:     actionResult,
      resolution: resolutionResult
    },
    // Flattened result for UI / DB
    verdict:          decisionResult.verdict,
    confidence:       decisionResult.confidence,
    rootCause:        decisionResult.rootCause,
    dispatchStatus:   decisionResult.verdict === 'PASS' ? 'APPROVED' : decisionResult.verdict === 'REVIEW' ? 'REVIEW' : 'BLOCKED',
    huResults:        decisionResult.huValidations,
    labelMatch:       decisionResult.labelMatch,
    itemCountMatch:   decisionResult.itemCountMatch,
    visionFindings:   visionResult,
    ewmData:          knowledgeResult,
    resolution:       resolutionResult,
    giPosted:         actionResult?.success || false,
    totalTime:        Date.now() - t0
  };
}

/**
 * Legacy: kept for backward compat — used by analyzeWithVision calls.
 * @deprecated use orchestrateValidation
 */
async function callNvidiaVision(imageBase64, mediaType) {
  return runVisionAgent(imageBase64, mediaType);
}

const VISION_PROMPT = `You are a warehouse stacking compliance inspector.
Analyse this warehouse pallet photo and identify:

1. LAYERS: How many layers of boxes are stacked? Count from bottom to top.
2. BOX SIZES: Are boxes on upper layers visibly larger or heavier looking than boxes below?
3. LABELS: Read any visible text — HU IDs, weight numbers, FRAGILE, THIS SIDE UP, DO NOT STACK, stack limits, hazmat symbols.
4. STABILITY: Any leaning, overhang, damaged stretch wrap, or deformation?
5. HEIGHT: Estimate total stack height in cm.
6. VERDICT: COMPLIANT / REVIEW / VIOLATION

Return ONLY valid JSON:
{
  "huLabels": ["all label text, HU IDs, weight numbers, or warning text visible"],
  "itemCount": <boxes on pallet>,
  "palletCondition": "GOOD" | "DAMAGED" | "UNSTABLE",
  "labelDamage": <true if any label torn/illegible>,
  "missingLabels": <true if any item unlabeled>,
  "observations": "<one sentence>",
  "stackingCompliant": <true if COMPLIANT>,
  "stackingVerdict": "COMPLIANT" | "REVIEW" | "VIOLATION",
  "layersDetected": <layers counted>,
  "heavyOnTop": <true if upper layers have larger/heavier boxes>,
  "overhanging": <true if any box extends beyond pallet edges>,
  "stretchWrapIntact": <true if stretch film continuous and undamaged>,
  "estimatedHeightCm": <total height in cm>,
  "stabilityScore": <0-100>,
  "stackingViolations": ["<specific issue observed>"],
  "stackingRecommendation": "<one sentence>",
  "labelTextsRead": ["<exact text from any visible label>"]
}`;

/**
 * Send an image to NVIDIA NIM Vision.
 * Primary: routes through SAP AI Core deployment (enterprise, no key needed).
 * Fallback: direct NVIDIA API with legacy key.
 */
async function callNvidiaVision(imageBase64, mediaType) {
  const dataUrl = `data:${mediaType || 'image/jpeg'};base64,${imageBase64}`;
  const body = JSON.stringify({
    model:       NVIDIA_VISION_MODEL,
    max_tokens:  512,
    temperature: 0.1,
    messages: [{
      role:    'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text',      text: VISION_PROMPT }
      ]
    }]
  });

  let rawText = '';

  // ── Primary: SAP AI Core deployment ──────────────────────────────────────
  if (NVIDIA_VISION_DEPLOYMENT_ID) {
    try {
      console.log('[VISION] Routing via SAP AI Core deployment:', NVIDIA_VISION_DEPLOYMENT_ID);
      const creds   = getAICoreCredentials();
      const token   = await getAIToken(creds);
      const baseUrl = creds.serviceurls?.AI_API_URL || creds.url;
      const url     = `${baseUrl}/v2/inference/deployments/${NVIDIA_VISION_DEPLOYMENT_ID}/invoke`;
      const resp    = await fetch(url, {
        method:  'POST',
        headers: {
          'Authorization':     `Bearer ${token}`,
          'Content-Type':      'application/json',
          'AI-Resource-Group': NVIDIA_VISION_RESOURCE_GROUP
        },
        body
      });
      if (!resp.ok) throw new Error(`AI Core vision ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      rawText    = data.choices?.[0]?.message?.content || data.content?.[0]?.text || '';
      console.log('[VISION] AI Core response:', rawText.slice(0, 200));
    } catch (e) {
      console.error('[VISION] AI Core call failed, falling back to direct NVIDIA:', e.message);
    }
  }

  // ── Fallback: direct NVIDIA API ───────────────────────────────────────────
  if (!rawText && NVIDIA_API_KEY) {
    try {
      console.log('[VISION] Calling NVIDIA NIM directly...');
      const resp = await fetch(NVIDIA_ENDPOINT, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
        body
      });
      if (!resp.ok) throw new Error(`NVIDIA API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      rawText    = data.choices?.[0]?.message?.content || '';
      console.log('[VISION] NVIDIA direct response:', rawText.slice(0, 200));
    } catch (e) {
      console.error('[VISION] Direct NVIDIA call failed:', e.message);
      throw e;
    }
  }

  if (!rawText) throw new Error('Vision AI not configured — set NVIDIA_VISION_DEPLOYMENT_ID or check AI Core credentials');

  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch (e) { /* fall through */ }
  }
  return { observations: rawText, huLabels: [], itemCount: 0, palletCondition: 'UNKNOWN', labelDamage: false, missingLabels: false };
}

/**
 * Call Claude (via SAP AI Core) with combined EWM + vision data for final verdict.
 */
async function analyzeWithVision(warehouse, delivery, huRows, visionData) {
  const huList = huRows.map(h =>
    `  HU ${h.huId}: expected=${h.expectedWeight}kg actual=${h.actualWeight}kg ${h.passed ? 'PASSED' : 'FAILED'}${h.isBlocked ? ' BLOCKED' : ''}`
  ).join('\n');

  return callAI(
    `You are a warehouse load assurance AI for SAP EWM. You have both EWM weight validation data
AND a visual inspection of the pallet from a camera. Combine both sources to give a definitive
verdict. Be concise (max 150 words). Structure your response as:
LABEL CHECK: <do vision HU labels match EWM?>
ITEM COUNT: <does visible count match expected HU count?>
CONDITION: <pallet condition assessment>
VERDICT: <overall dispatch recommendation>`,
    `Warehouse: ${warehouse} | Delivery: ${delivery}
EWM Handling Units:
${huList}

Vision Findings:
- Labels seen on pallet: ${(visionData.huLabels || []).join(', ') || 'none detected'}
- Items/boxes visible: ${visionData.itemCount ?? 'unknown'}
- Pallet condition: ${visionData.palletCondition || 'unknown'}
- Label damage: ${visionData.labelDamage ? 'YES' : 'no'}
- Missing labels: ${visionData.missingLabels ? 'YES' : 'no'}
- Observations: ${visionData.observations || 'none'}`
  );
}

// ── MCP Client — connects to mcp/server.js via stdio ─────────────────────────

const { Client }              = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { spawn } = require('child_process');

let _mcpClient = null;

async function getMCPClient() {
  if (_mcpClient) return _mcpClient;
  const mcpPath = path.join(__dirname, '..', 'mcp', 'server.js');
  const transport = new StdioClientTransport({
    command: process.execPath,  // node
    args:    [mcpPath]
  });
  const client = new Client(
    { name: 'load-assurance-agent', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);
  _mcpClient = client;
  console.log('[MCP] Client connected to MCP server');
  return client;
}

async function executeTool(toolName, toolInput) {
  try {
    const client = await getMCPClient();
    const result = await client.callTool({ name: toolName, arguments: toolInput });
    const text = result.content?.[0]?.text || '{}';
    return JSON.parse(text);
  } catch (e) {
    console.error(`[MCP] Tool call failed (${toolName}):`, e.message);
    // Fallback: direct DB query if MCP unavailable
    return executeFallbackTool(toolName, toolInput);
  }
}

async function executeFallbackTool(toolName, toolInput) {
  try {
    if (toolName === 'get_delivery_status') {
      const { outboundDelivery, warehouse } = toolInput;
      const [scan] = await SELECT.from('com.loadassurance.ShipmentScan')
        .where({ outboundDelivery, warehouse }).orderBy({ createdAt: 'desc' }).limit(1);
      if (!scan) return { found: false };
      return { found: true, outboundDelivery: scan.outboundDelivery, dispatchStatus: scan.dispatchStatus,
               totalHUs: scan.totalHUs, passedHUs: scan.passedHUs, failedHUs: scan.failedHUs };
    }
    if (toolName === 'get_open_deliveries') {
      const scans = await SELECT.from('com.loadassurance.ShipmentScan')
        .where({ warehouse: toolInput.warehouse }).orderBy({ createdAt: 'desc' });
      const latest = {};
      scans.forEach(s => { if (!latest[s.outboundDelivery]) latest[s.outboundDelivery] = s; });
      return { warehouse: toolInput.warehouse, deliveries: Object.values(latest) };
    }
    if (toolName === 'get_blocked_hus') {
      const { outboundDelivery, warehouse } = toolInput;
      const [scan] = await SELECT.from('com.loadassurance.ShipmentScan')
        .where({ outboundDelivery, warehouse }).orderBy({ createdAt: 'desc' }).limit(1);
      if (!scan) return { found: false };
      const hus = await SELECT.from('com.loadassurance.HUValidation').where({ scan_ID: scan.ID });
      return { found: true, blockedHUs: hus.filter(h => !h.passed) };
    }
  } catch (e) { return { error: e.message }; }
  return { error: 'Tool not available' };
}

const demoInsights = {
  topFailureProducts: [
    { product: 'P-101 (Industrial Bearings)',    failureRate: '34%', avgDelta: '+8.2 LB', rootCause: 'Packaging inconsistency — supplier variation in foam inserts' },
    { product: 'P-205 (Hydraulic Seals Bulk)',   failureRate: '21%', avgDelta: '-5.7 LB', rootCause: 'Moisture absorption during storage causing weight loss' },
    { product: 'P-318 (Drive Shaft Assembly)',   failureRate: '18%', avgDelta: '+12.4 LB', rootCause: 'Operator adding protective wrap not accounted in tare weight' }
  ],
  rootCauses: [
    'Scale not tared before session — zero offset carries through all HU weights',
    'EWM expected weight set at goods receipt but packaging changed by supplier',
    'Blocked HUs from previous shift not cleared — movement lock still active',
    'HU label scanned twice — duplicate entry inflates actual weight reading',
    'Customs hold from overnight batch run — requires customs release in VL02N / contact customs team'
  ],
  recommendations: [
    'Tare scale at shift start and after every 10th weigh-in',
    'Check and clear movement blocks via VL06O outbound monitor before dispatch window',
    'Flag P-101 HUs for secondary weigh — 1-in-3 fail tolerance check',
    'Contact procurement to update EWM tare weights for P-205 supplier change',
    'Schedule customs release workflow before 06:00 to avoid dispatch delays'
  ]
};

async function chatWithAI(message, context) {
  const creds = getAICoreCredentials();
  if (!creds) { console.warn('[AI] No credentials'); return null; }
  try {
    const token   = await getAIToken(creds);
    const baseUrl = creds.serviceurls?.AI_API_URL || creds.url;
    const url     = `${baseUrl}/v2/inference/deployments/${AI_DEPLOYMENT_ID}/invoke`;
    const systemPrompt = `You are a Load Assurance Copilot for SAP EWM warehouse 2001.

ABSOLUTE RULES:
1. NEVER mention product names (Herbal Tea, RIP IT, Cheerios, Pasta, cereal, food items — nothing)
2. NEVER use SAP transaction codes
3. NEVER say "no active scans" or "I don't have data" — always answer using available delivery/HU context
4. NEVER use markdown tables
5. NEVER ask for warehouse number — it is always 2001
6. Maximum 15 lines per response
7. End with one yes/no question
8. NEVER expose raw SAP field values — translate everything to plain English:
   • shippingStatus=1 → "not yet ship-ready"
   • shippingStatus=C → "ship-ready confirmed"
   • GoodsIssueStatus=C → "goods issue posted"
   • GoodsIssueStatus= (blank) → "goods issue not yet posted"
   • dispatchStatus=BLOCKED → "dispatch is blocked"
   • dispatchStatus=APPROVED → "cleared for dispatch"
   • huStatus=STOCK → "in stock"
   • huStatus=PLAN → "planned, not yet staged"
   • isBlocked=true → "movement blocked"

ONLY reference:
- HU numbers (881353, 881354, 881349, 800881-800891)
- Delivery numbers (80000900, 80000947)
- Weight values and deviations
- Bin locations (GI-ZONE, BLOCKED_BIN etc)
- Status values (STOCK, REVIEW, BLOCKED, PASSED)
- Scan timestamps

CORRECT response for departure risk question:

"📦 Departure Risk — Warehouse 2001

🔴 High Risk — Delivery 80000900
   • 12 of 13 HUs uncleared — dispatch blocked
   • HU 881349 has no weight data
   • HUs 800881–800891 in 2–5% review band

🟡 Medium Risk — Delivery 80000947
   • 2 HUs in review band, pending sign-off
   • Both in GI-ZONE, ready for re-weigh

✅ Clear — All other deliveries
   • 80000157, 80000158 ship ready

Immediate action: resolve HU 881349 missing weight before truck release.

Want me to pull full HU detail for 80000900?"

Current warehouse context:
- Warehouse: 2001
- Active deliveries: 80000900, 80000947
- HU 881349: missing weight data
- HUs 800881-800891: +3.49% weight deviation
- Delivery 80000947 HUs: 2-3% review band
- Operator context: ${context || 'Warehouse 2001 — outbound dispatch operations'}`;

    // Fetch tool list from MCP server
    let mcpTools = [];
    try {
      const mcpClient = await getMCPClient();
      const { tools } = await mcpClient.listTools();
      // Convert MCP inputSchema → Claude input_schema
      mcpTools = tools.map(t => ({
        name:         t.name,
        description:  t.description,
        input_schema: t.inputSchema
      }));
      console.log('[MCP] Tools loaded:', mcpTools.map(t => t.name).join(', '));
    } catch (e) {
      console.warn('[MCP] Could not load tools, proceeding without:', e.message);
    }

    const messages = [{ role: 'user', content: message }];

    // Agentic loop: keep going while AI returns tool_use
    for (let i = 0; i < 5; i++) {
      const body = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 800,
        system: systemPrompt,
        messages
      };
      if (mcpTools.length) body.tools = mcpTools;

      const resp = await fetch(url, {
        method:  'POST',
        headers: {
          'Authorization':     `Bearer ${token}`,
          'Content-Type':      'application/json',
          'AI-Resource-Group': AI_RESOURCE_GROUP
        },
        body: JSON.stringify(body)
      });
      if (!resp.ok) throw new Error(`AI Core ${resp.status}`);
      const result = await resp.json();

      if (result.stop_reason === 'end_turn') {
        const text = result.content?.find(c => c.type === 'text')?.text || '';
        console.log('[AI] Chat done after', i + 1, 'turn(s)');
        return text;
      }

      if (result.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: result.content });

        const toolUseBlocks = result.content.filter(c => c.type === 'tool_use');
        const toolResults = await Promise.all(toolUseBlocks.map(async (tu) => {
          console.log(`[MCP] Calling tool: ${tu.name}`, JSON.stringify(tu.input));
          const output = await executeTool(tu.name, tu.input);
          console.log(`[MCP] Tool result: ${tu.name}`, JSON.stringify(output).slice(0, 200));
          return {
            type:        'tool_result',
            tool_use_id: tu.id,
            content:     JSON.stringify(output)
          };
        }));

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      return result.content?.find(c => c.type === 'text')?.text || '';
    }

    return 'I reached the tool call limit. Please try a more specific question.';
  } catch (e) {
    console.error('[AI] Chat failed:', e.message);
    return null;
  }
}

// ── Mock data — fallback when EWM is unreachable (demo / dev) ────────────────
const MOCK_HUS = [
  { huId: 'HU-EWM-001', storageBin: 'WH01-A01', expectedWeight: 245.500, grossWeight: 247.200, netWeight: 230.0, expectedWeightUnit: 'LB', warehouseNumber: '2001', isBlocked: false, isClosed: false, huStatus: 'STOCK', labelStatus: 'OK',      stackingAllowed: true  },
  { huId: 'HU-EWM-002', storageBin: 'WH01-B12', expectedWeight: 180.000, grossWeight: 162.300, netWeight: 155.0, expectedWeightUnit: 'LB', warehouseNumber: '2001', isBlocked: false, isClosed: false, huStatus: 'STOCK', labelStatus: 'OK',      stackingAllowed: true  },
  { huId: 'HU-EWM-003', storageBin: 'WH01-C03', expectedWeight: 320.750, grossWeight: 333.900, netWeight: 310.0, expectedWeightUnit: 'LB', warehouseNumber: '2001', isBlocked: false, isClosed: false, huStatus: 'STOCK', labelStatus: 'Damaged', stackingAllowed: true  },
  { huId: 'HU-EWM-004', storageBin: 'WH01-D04', expectedWeight:  95.000, grossWeight:  94.800, netWeight:  88.0, expectedWeightUnit: 'LB', warehouseNumber: '2001', isBlocked: false, isClosed: false, huStatus: 'STOCK', labelStatus: 'OK',      stackingAllowed: true  },
  { huId: 'HU-EWM-005', storageBin: 'WH01-E05', expectedWeight: 410.000, grossWeight: 388.500, netWeight: 375.0, expectedWeightUnit: 'LB', warehouseNumber: '2001', isBlocked: false, isClosed: false, huStatus: 'STOCK', labelStatus: 'OK',      stackingAllowed: false },
];

function getMockHUs(outboundDelivery, warehouse) {
  console.log(`[MOCK] Returning mock HUs for delivery ${outboundDelivery} warehouse ${warehouse}`);
  return MOCK_HUS.map(h => ({ ...h, warehouseNumber: warehouse, refDocument: outboundDelivery }));
}
// ══════════════════════════════════════════════════════════════════════════════

const WEIGHT_FAIL_THRESHOLD   = 0.05;  // >5%  → Failed
const WEIGHT_REVIEW_THRESHOLD = 0.02;  // 2-5% → Review

/**
 * Run all validation rules against a single HU.
 * Returns { status, severity, failures[], reviews[], issue }
 */
function runValidationRules(hu, deltaPct) {
  const failures = [];
  const reviews  = [];

  // Blocked / closed — hard fails
  if (hu.isBlocked) failures.push('HU is blocked in EWM');
  if (hu.isClosed)  failures.push('HU is closed and cannot be dispatched');

  // Weight checks — skip entirely if EWM has no weight data (expectedWeight=0)
  if (hu.expectedWeight <= 0) {
    reviews.push('No weight data in EWM — manual weight verification required');
  } else if (deltaPct > WEIGHT_FAIL_THRESHOLD)
    failures.push(`Weight deviation ${(deltaPct * 100).toFixed(2)}% exceeds ${WEIGHT_FAIL_THRESHOLD * 100}% threshold`);
  else if (deltaPct > WEIGHT_REVIEW_THRESHOLD)
    reviews.push(`Weight deviation ${(deltaPct * 100).toFixed(2)}% is in the 2–5% review band`);

  // Label status
  const label = (hu.labelStatus || '').toUpperCase();
  if (label === 'MISSING')  failures.push('Label is missing — HU cannot be dispatched without a valid label');
  else if (label === 'DAMAGED') reviews.push('Label is damaged — manual inspection required before dispatch');

  // Stacking compliance
  if (hu.stackingAllowed === false || hu.stackingCompliance === false)
    reviews.push('Stacking non-compliant — top-heavy or incorrect layer arrangement detected');

  const status   = failures.length > 0 ? 'Failed'
                 : reviews.length  > 0 ? 'Review'
                 :                       'Passed';
  const severity = failures.length > 0
    ? (deltaPct > 0.10 || label === 'MISSING' ? 'Critical' : 'High')
    : reviews.length > 0 ? 'Medium' : 'Low';

  const allIssues = [...failures, ...reviews];
  return { status, severity, failures, reviews, issue: allIssues.join(' | ') };
}

function validateHUData(hu) {
  const actualWeight   = hu.grossWeight;
  const expectedWeight = hu.expectedWeight;
  const delta          = actualWeight - expectedWeight;
  const deltaPct       = expectedWeight > 0 ? Math.abs(delta) / expectedWeight : 0;

  const { status, severity, failures, reviews, issue } = runValidationRules(hu, deltaPct);
  const passed = status === 'Passed';

  return {
    huId:              hu.huId,
    storageBin:        hu.storageBin,
    expectedWeight,
    actualWeight,
    weightUnit:        hu.expectedWeightUnit,
    weightDelta:       parseFloat(delta.toFixed(3)),
    weightDeltaPct:    parseFloat((deltaPct * 100).toFixed(2)),
    weightPassed:      deltaPct <= WEIGHT_FAIL_THRESHOLD,
    isBlocked:         hu.isBlocked,
    isClosed:          hu.isClosed,
    huStatus:          hu.huStatus,
    labelStatus:       hu.labelStatus || '',
    stackingCompliant: hu.stackingAllowed === false || hu.stackingCompliance === false ? false : null,
    status,
    severity,
    issue,
    passed
  };
}

function validateShipmentData(hus) {
  const huResults  = hus.map(validateHUData);
  const passedHUs  = huResults.filter(h => h.status === 'Passed').length;
  const reviewHUs  = huResults.filter(h => h.status === 'Review').length;
  const failedHUs  = huResults.filter(h => h.status === 'Failed' && !h.isBlocked).length;
  const blockedHUs = huResults.filter(h => h.isBlocked).length;
  const dispatchStatus = (failedHUs > 0 || blockedHUs > 0)
    ? 'BLOCKED'
    : (reviewHUs > 0 ? 'REVIEW' : 'PENDING');

  const exceptions = huResults
    .filter(h => h.status !== 'Passed')
    .map(h => ({
      huId:          h.huId,
      warehouse:     hus.find(hu => hu.huId === h.huId)?.warehouseNumber || '',
      exceptionType: h.isBlocked   ? 'BLOCKED'
                   : h.isClosed    ? 'CLOSED'
                   : !h.weightPassed ? 'WEIGHT'
                   : h.labelStatus !== 'OK' ? 'LABEL'
                   : !h.stackingCompliant   ? 'STACKING'
                   : 'REVIEW',
      severity:      h.severity,
      description:   h.issue
    }));

  return {
    huResults,
    stats: { totalHUs: huResults.length, passedHUs, reviewHUs, failedHUs, blockedHUs, dispatchStatus },
    exceptions
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  MODULE 4 — CAP Action Handlers
// ══════════════════════════════════════════════════════════════════════════════

const cdsImpl = cds.service.impl(async function () {
  const ShipmentScan  = 'com.loadassurance.ShipmentScan';
  const HUValidation  = 'com.loadassurance.HUValidation';
  const ExceptionLog  = 'com.loadassurance.ExceptionLog';
  const ValidationLog = 'com.loadassurance.ValidationLog';

  // ── scanDelivery ────────────────────────────────────────────────────────────
  this.on('scanDelivery', async (req) => {
    const { outboundDelivery, warehouse, scaleWeight } = req.data;
    if (!warehouse)        return req.error(400, 'warehouse is required');
    if (!outboundDelivery) return req.error(400, 'outboundDelivery is required');

    // 1. Fetch HUs from EWM
    let hus;
    try {
      hus = await fetchDelivery(outboundDelivery, warehouse);
    } catch (e) {
      console.warn(`[SCAN] EWM fetch failed (${e.message})`);
      return req.error(500, `EWM connection failed: ${e.message}`);
    }
    if (!hus || !hus.length) {
      console.warn(`[SCAN] No HUs found in EWM for delivery ${outboundDelivery} warehouse ${warehouse} — picking not yet started`);
      return {
        scanId:           require('crypto').randomUUID(),
        outboundDelivery, warehouse,
        totalHUs:         0,
        passedHUs:        0,
        failedHUs:        0,
        blockedHUs:       0,
        dispatchStatus:   'PENDING',
        pickingNotStarted: true,
        aiSummary:        `Delivery ${outboundDelivery} is ready for picking. No handling units have been assigned yet — create a pick task to start the picking process.`,
        huResults:        [],
        exceptions:       []
      };
    }

    // 1b. If scale weight provided and single HU delivery, override grossWeight
    if (scaleWeight?.weight && hus.length === 1) {
      console.log(`[SCALE] Overriding HU ${hus[0].huId} grossWeight ${hus[0].grossWeight} → ${scaleWeight.weight} ${scaleWeight.unit}`);
      hus[0] = { ...hus[0], grossWeight: parseFloat(scaleWeight.weight) };
    } else if (scaleWeight?.weight && hus.length > 1) {
      console.log(`[SCALE] Scale weight received but ${hus.length} HUs — cannot assign to single HU, ignoring`);
    }

    // 2. Validate all HUs
    const { huResults, stats, exceptions } = validateShipmentData(hus);
    console.log(`[SCAN] dispatchStatus=${stats.dispatchStatus} passed=${stats.passedHUs} failed=${stats.failedHUs} review=${stats.reviewHUs}`);

    // 2b. Detect OBD mismatch (wrong pallet)
    const obdKey      = outboundDelivery.padStart(10, '0');
    const mismatchHUs = hus.filter(h => {
      const ref = (h.refDocument || '').padStart(10, '0');
      return ref && ref !== obdKey;
    });
    const isOBDMismatch = mismatchHUs.length > 0;

    // 2c. Determine failure type for UI routing
    // OBD_MISMATCH > other failures — if any HU belongs to wrong delivery that drives the response
    let failureType = 'NONE';
    if (isOBDMismatch) {
      failureType = 'OBD_MISMATCH';
    } else if (stats.failedHUs > 0 || stats.blockedHUs > 0) {
      const firstFailed = huResults.find(h => h.status === 'Failed' || h.isBlocked);
      failureType = detectFailureType(firstFailed);
    } else if (stats.reviewHUs > 0) {
      failureType = 'REVIEW';
    }

    // 2d. EWM actions based on failure type
    let dispatchResult  = null;   // filled on PASS
    let wrongPalletResult = null; // filled on OBD_MISMATCH
    const isPassed = stats.failedHUs === 0 && stats.blockedHUs === 0 && stats.reviewHUs === 0 && !isOBDMismatch;

    if (isPassed) {
      console.log(`[SCAN] All HUs passed — NOT setting shipping readiness automatically. Operator uses Approve Dispatch button.`);
      // Do NOT call SetShippingReadiness here — operator must explicitly approve via UI button.
      dispatchResult = {
        step1_shippingReady:    false,
        step2_loadingActivated: false,
        step3_giPosted:         false,
        complete:               false,
        messages: ['All HUs passed — use Approve Dispatch to set shipping readiness'],
        errors:   []
      };
      stats.dispatchStatus = 'APPROVED';
    } else if (isOBDMismatch) {
      const wrongHU = mismatchHUs[0];
      console.log(`[SCAN] OBD mismatch — HU ${wrongHU.huId} belongs to ${wrongHU.refDocument}, not ${outboundDelivery} — running handleWrongPallet`);
      wrongPalletResult = await handleWrongPallet(outboundDelivery, wrongHU.huId, warehouse, wrongHU.storageBin).catch(e => ({
        wtCreated: false, wtNumber: null, shippingReversed: false, message: e.message,
        manualSteps: ['Use /SCWM/CANCPICK manually for HU ' + wrongHU.huId], errors: [e.message]
      }));
    }

    // 2e. Fetch delivery items from ODO2 (non-blocking, best-effort)
    const deliveryItems = await getDeliveryItems(outboundDelivery).catch(() => []);
    console.log(`[SCAN] Delivery items from ODO2: ${deliveryItems.length}`);

    // 3. AI shipment summary
    const issueLines = huResults.filter(h => h.status !== 'Passed').map(h => `${h.huId}: ${h.issue}`);
    const aiSummary  = await analyzeShipment(warehouse, outboundDelivery, stats, issueLines)
      || `${stats.passedHUs}/${stats.totalHUs} HUs passed${stats.reviewHUs ? ', ' + stats.reviewHUs + ' under review' : ''}. Dispatch ${stats.dispatchStatus}.`;

    // 4. Persist ShipmentScan — reset any previous scan status for this delivery first
    const scanEntry = {
      outboundDelivery,
      warehouse,
      scannedBy: req.user?.id || 'system',
      ...stats,
      aiSummary
    };
    let scanId;
    try {
      // Reset previous scans so worklist doesn't show stale APPROVED/BLOCKED
      await UPDATE(ShipmentScan)
        .set({ dispatchStatus: 'SUPERSEDED' })
        .where({ outboundDelivery, warehouse });
      console.log('[DB] INSERT ShipmentScan into:', ShipmentScan);
      await INSERT.into(ShipmentScan).entries(scanEntry);
      const [saved] = await SELECT.from(ShipmentScan)
        .where({ outboundDelivery, warehouse })
        .where('dispatchStatus != ', 'SUPERSEDED')
        .orderBy({ createdAt: 'desc' })
        .limit(1);
      scanId = saved?.ID;
      console.log('[DB] ShipmentScan saved, ID:', scanId);
    } catch (e) {
      console.error('[DB] ShipmentScan INSERT failed:', e.message, e.stack);
      return req.error(500, `DB persist failed: ${e.message}`);
    }

    // 5. Persist HUValidations
    if (scanId && huResults.length) {
      try {
        await INSERT.into(HUValidation).entries(
          huResults.map(r => ({ ...r, scan_ID: scanId }))
        );
      } catch (e) { console.error('[DB] HUValidation INSERT failed:', e.message); }
    }

    // 6. Persist ExceptionLogs
    if (scanId && exceptions.length) {
      try {
        await INSERT.into(ExceptionLog).entries(
          exceptions.map(e => ({ ...e, scan_ID: scanId, resolvedBy: 'PENDING' }))
        );
      } catch (e) { console.error('[DB] ExceptionLog INSERT failed:', e.message); }
    }

    return {
      scanId,
      outboundDelivery,
      warehouse,
      ...stats,
      aiSummary,
      huResults,
      failureType,
      dispatch: dispatchResult ? {
        complete:               dispatchResult.complete,
        step1_shippingReady:    dispatchResult.step1_shippingReady,
        step2_loadingActivated: dispatchResult.step2_loadingActivated,
        step3_giPosted:         dispatchResult.step3_giPosted,
        messages:               (dispatchResult.messages || []).join(' | '),
        errors:                 (dispatchResult.errors   || []).join(' | ')
      } : null,
      wrongPallet: wrongPalletResult ? {
        reversalDone:    wrongPalletResult.shippingReversed || false,
        reversalMessage: wrongPalletResult.message || '',
        wtCreated:       wrongPalletResult.wtCreated || false,
        wtNumber:        wrongPalletResult.wtNumber  || null,
        wtMessage:       wrongPalletResult.wtMessage || '',
        manualStepsRequired: true,
        manualInstructions:  JSON.stringify(wrongPalletResult.manualSteps || [])
      } : null,
      deliveryItems,
      exceptions: exceptions.map(e => ({
        huId: e.huId, exceptionType: e.exceptionType, description: e.description
      }))
    };
  });

  // ── revalidateWeights — re-run validation with operator-entered weights ───────
  this.on('revalidateWeights', async (req) => {
    const { outboundDelivery, warehouse, huWeights } = req.data;
    if (!outboundDelivery || !warehouse) return req.error(400, 'outboundDelivery and warehouse required');
    if (!huWeights || !huWeights.length)  return req.error(400, 'huWeights required');

    // Fetch HUs from EWM (same as scanDelivery)
    let hus;
    try {
      hus = await fetchDelivery(outboundDelivery, warehouse);
    } catch (e) {
      return req.error(500, `EWM fetch failed: ${e.message}`);
    }
    if (!hus || !hus.length) return req.error(404, `No HUs found for delivery ${outboundDelivery}`);

    // Override actualWeight (grossWeight) with operator-entered values
    const weightMap = {};
    (huWeights || []).forEach(w => { weightMap[w.huId] = parseFloat(w.actualWeight); });
    hus = hus.map(h => {
      const entered = weightMap[h.huId];
      return entered > 0 ? { ...h, grossWeight: entered } : h;
    });

    // Re-run validation
    const { huResults, stats, exceptions } = validateShipmentData(hus);
    console.log(`[REVALIDATE] ${outboundDelivery} passed=${stats.passedHUs} failed=${stats.failedHUs}`);

    // AI summary
    const issueLines = huResults.filter(h => h.status !== 'Passed').map(h => `${h.huId}: ${h.issue}`);
    const aiSummary  = await analyzeShipment(warehouse, outboundDelivery, stats, issueLines)
      || `${stats.passedHUs}/${stats.totalHUs} HUs passed. Dispatch ${stats.dispatchStatus}.`;

    return { ...stats, huResults, exceptions: exceptions.map(e => ({ huId: e.huId, exceptionType: e.exceptionType, description: e.description })), aiSummary };
  });

  // ── getShipmentStatus ───────────────────────────────────────────────────────
  this.on('getShipmentStatus', async (req) => {
    const { outboundDelivery, warehouse } = req.data;
    if (!outboundDelivery || !warehouse)
      return req.error(400, 'outboundDelivery and warehouse required');

    const [scan] = await SELECT.from(ShipmentScan)
      .where({ outboundDelivery, warehouse })
      .orderBy({ createdAt: 'desc' })
      .limit(1);

    if (!scan) return { found: false };

    return {
      found:            true,
      scanId:           scan.ID,
      outboundDelivery: scan.outboundDelivery,
      warehouse:        scan.warehouse,
      scannedAt:        scan.createdAt,
      totalHUs:         scan.totalHUs,
      passedHUs:        scan.passedHUs,
      failedHUs:        scan.failedHUs,
      blockedHUs:       scan.blockedHUs,
      dispatchStatus:   scan.dispatchStatus,
      aiSummary:        scan.aiSummary
    };
  });

  // ── validateHU (legacy, preserved) ─────────────────────────────────────────
  this.on('validateHU', async (req) => {
    const { huId, warehouse, actualWeight, weightUnit, outboundDelivery } = req.data;
    let huData;
    try {
      const hus = await fetchHUs(warehouse);
      huData = hus.find(h => h.huId === huId);
      if (!huData) return req.error(404, `HU ${huId} not found in warehouse ${warehouse}`);
    } catch (e) { return req.error(500, `EWM fetch failed: ${e.message}`); }

    const expectedWeight = huData.expectedWeight;
    const delta          = actualWeight - expectedWeight;
    const deltaPct       = expectedWeight > 0 ? Math.abs(delta) / expectedWeight : 0;
    const weightPassed   = deltaPct <= WEIGHT_THRESHOLD;

    // OBD mismatch check
    const obdMatch = !outboundDelivery || !huData.refDocument ||
      huData.refDocument.padStart(10, '0') === outboundDelivery.padStart(10, '0');

    const passed = weightPassed && !huData.isBlocked && !huData.isClosed && obdMatch;

    // Detect failure type
    const failureType = passed ? 'NONE' : detectFailureType({
      isBlocked:       huData.isBlocked,
      weightPassed,
      stackingCompliant: true,
      labelStatus:     huData.labelStatus || 'OK'
    });
    const actualFailureType = !obdMatch ? 'OBD_MISMATCH' : failureType;

    const aiInsight = await callAI(
      `You are a warehouse load assurance AI for SAP EWM. Analyse the HU validation
result. Provide: 1. VERDICT 2. Delta analysis 3. Root cause if failed
4. Recommended action. Keep under 100 words.`,
      `HU: ${huId} | Warehouse: ${warehouse}
Expected: ${expectedWeight} ${huData.expectedWeightUnit} | Actual: ${actualWeight} ${weightUnit}
Delta: ${delta.toFixed(3)} (${(deltaPct*100).toFixed(2)}%) | Status: ${huData.huStatus}
OBD match: ${obdMatch} | Result: ${passed ? 'PASSED' : 'FAILED'}`
    ) || `Weight delta ${(deltaPct*100).toFixed(2)}%. ${passed ? 'Within threshold.' : 'Exceeds 5% threshold.'}`;

    // EWM actions based on result
    let dispatch    = null;
    let wrongPallet = null;

    if (passed && outboundDelivery) {
      // Do NOT auto-set shipping readiness — operator uses Approve Dispatch button
      dispatch = {
        step1_shippingReady:    false,
        step2_loadingActivated: false,
        step3_giPosted:         false,
        complete:               false,
        messages: ['HU passed — use Approve Dispatch to set shipping readiness'],
        errors:   []
      };
    } else if (actualFailureType === 'OBD_MISMATCH' && outboundDelivery) {
      wrongPallet = await handleWrongPallet(outboundDelivery, huId, warehouse, huData.storageBin).catch(e => ({
        wtCreated: false, wtNumber: null, shippingReversed: false, message: e.message,
        manualSteps: ['Use /SCWM/CANCPICK manually for HU ' + huId], errors: [e.message]
      }));
    }

    const fixInstructions = passed ? [] : getFixInstructions(actualFailureType, huId, huData.storageBin);

    // Persist to ValidationLog
    await INSERT.into(ValidationLog).entries({
      huId, warehouse, expectedWeight, actualWeight, weightUnit,
      deltaPct: parseFloat((deltaPct*100).toFixed(2)), passed, aiInsight
    });

    return {
      huId, expectedWeight, expectedWeightUnit: huData.expectedWeightUnit,
      actualWeight, weightUnit,
      delta:       parseFloat(delta.toFixed(3)),
      deltaPct:    parseFloat((deltaPct*100).toFixed(2)),
      weightPassed, passed,
      huStatus:    huData.huStatus,
      isBlocked:   huData.isBlocked,
      isClosed:    huData.isClosed,
      storageBin:  huData.storageBin,
      aiInsight,
      failureType: actualFailureType,
      fixInstructions: JSON.stringify(fixInstructions),
      dispatch: dispatch ? {
        complete:               dispatch.complete,
        step1_shippingReady:    dispatch.step1_shippingReady,
        step2_loadingActivated: dispatch.step2_loadingActivated,
        step3_giPosted:         dispatch.step3_giPosted,
        messages:               (dispatch.messages || []).join(' | '),
        errors:                 (dispatch.errors   || []).join(' | ')
      } : null,
      wrongPallet: wrongPallet ? {
        reversalDone:        wrongPallet.shippingReversed || false,
        reversalMessage:     wrongPallet.message || '',
        wtCreated:           wrongPallet.wtCreated || false,
        wtNumber:            wrongPallet.wtNumber  || null,
        wtMessage:           wrongPallet.wtMessage || '',
        manualStepsRequired: true,
        manualInstructions:  JSON.stringify(wrongPallet.manualSteps || [])
      } : null,
      ewmConfirmation: { success: true, message: `Validation recorded for HU ${huId}` }
    };
  });

  // ── resolveException ────────────────────────────────────────────────────────
  this.on('resolveException', async (req) => {
    const { huId, warehouse, exceptionType, scanId } = req.data;

    // Fetch just this HU directly by ID — avoids full warehouse scan
    let huData = null;
    try {
      const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
      const resp = await executeHttpRequest(
        { destinationName: DESTINATION },
        {
          method:  'GET',
          url:     `${EWM_HU_PATH}?$filter=HandlingUnitExternalID eq '${huId}'&$top=1`,
          headers: { 'Accept': 'application/json', 'sap-client': '100' }
        }
      );
      const items = resp.data?.value || [];
      if (items.length) huData = mapAPIHandlingUnit(items[0]);
    } catch (e) { console.warn('[resolveException] HU fetch failed:', e.message); }

    const resolutionAction = await resolveExceptionAI(huId, warehouse, exceptionType, huData)
      || `Review HU ${huId} manually. Check storage bin and weight discrepancy.`;

    // Scope update to the current scan — avoids overwriting resolutions from prior scans
    const whereClause = scanId
      ? { huId, exceptionType, scan_ID: scanId }
      : { huId, exceptionType };
    await UPDATE(ExceptionLog).set({ resolvedBy: 'AGENT', resolutionAction }).where(whereClause);

    return { huId, exceptionType, resolvedBy: 'AGENT', resolutionAction, success: true };
  });

  // ── approveDispatch ─────────────────────────────────────────────────────────
  // Step 1 only: SetShippingReadiness. Operator then uses Confirm Loading and Post GI buttons.
  this.on('approveDispatch', async (req) => {
    const { outboundDelivery, warehouse } = req.data;
    const [latest] = await SELECT.from(ShipmentScan)
      .where({ outboundDelivery, warehouse })
      .where('dispatchStatus !=', 'SUPERSEDED')
      .orderBy({ createdAt: 'desc' })
      .limit(1);

    // Allow approval even without a prior scan (e.g. called from Joule)
    if (latest) {
      await UPDATE(ShipmentScan).set({ dispatchStatus: 'APPROVED' }).where({ ID: latest.ID });
    }
    console.log(`[approveDispatch] ${outboundDelivery}: ${latest ? 'scan '+latest.ID+' → APPROVED' : 'no scan — direct EWM call'}`);

    const messages = [];
    const errors   = [];
    let shippingReadySet = false;
    try {
      const head = await getDeliveryHead(outboundDelivery);
      if (!head.success) throw new Error(head.error);

      if (head.shippingStatus === 'C') {
        shippingReadySet = true;
        messages.push('Shipping readiness already set');
      } else {
        const s1 = await postDeliveryAction(outboundDelivery, 'SetShippingReadiness', head.etag);
        shippingReadySet = s1.success || (s1.error||'').toLowerCase().includes('already');
        if (shippingReadySet) messages.push('Shipping readiness set — use Confirm Loading next');
        else                  errors.push('SetShippingReadiness: ' + s1.error);
      }
    } catch (e) {
      errors.push('Approve error: ' + e.message);
      console.error('[approveDispatch] error:', e.message);
    }

    return {
      success:        shippingReadySet,
      message:        messages.concat(errors).join(' | ') || 'Approve attempted',
      dispatchStatus: 'APPROVED',
      shippingReadySet,
      loadingActivated: false,
      giPosted:         false,
      messages,
      errors
    };
  });

  // ── blockDispatch ───────────────────────────────────────────────────────────
  this.on('blockDispatch', async (req) => {
    const { outboundDelivery, warehouse, reason } = req.data;
    const [latest] = await SELECT.from(ShipmentScan)
      .where({ outboundDelivery, warehouse })
      .where('dispatchStatus !=', 'SUPERSEDED')
      .orderBy({ createdAt: 'desc' })
      .limit(1);

    // Allow block even without a prior scan (e.g. called from Joule)
    if (latest) {
      await UPDATE(ShipmentScan).set({ dispatchStatus: 'BLOCKED', aiSummary: reason }).where({ ID: latest.ID });
    }

    // Reverse shipping readiness in EWM so delivery can be re-picked
    let ewmMessage = '';
    try {
      const head = await getDeliveryHead(outboundDelivery);
      if (head.success) {
        const rev = await postDeliveryAction(outboundDelivery, 'ReverseShippingReadiness', head.etag);
        ewmMessage = rev.success
          ? ' Shipping readiness reversed in EWM.'
          : ` EWM reversal failed: ${rev.error}`;
        console.log(`[blockDispatch] ReverseShippingReadiness ${outboundDelivery}: success=${rev.success}`);
      }
    } catch (e) {
      ewmMessage = ` EWM reversal error: ${e.message}`;
      console.error('[blockDispatch] EWM error:', e.message);
    }

    return { success: true, message: `Delivery ${outboundDelivery} blocked. Reason: ${reason}.${ewmMessage}`, dispatchStatus: 'BLOCKED' };
  });

  // ── chat ────────────────────────────────────────────────────────────────────
  this.on('chat', async (req) => {
    const { message, context } = req.data;
    if (!message) return req.error(400, 'message is required');

    // ── Enrich context with live data ────────────────────────────────────────
    const liveLines = [];

    // 1. Detect delivery numbers mentioned (8-digit)
    const obdMatches = (message + ' ' + (context || '')).match(/\b\d{8}\b/g) || [];
    const obds = [...new Set(obdMatches)];

    // Also always include both known active deliveries for ship-ready / departure questions
    const shipKeywords = /ship.ready|depart|risk|blocked|dispatch|ready|clear/i;
    if (shipKeywords.test(message) && !obds.includes('80000900')) obds.push('80000900');
    if (shipKeywords.test(message) && !obds.includes('80000947')) obds.push('80000947');

    for (const obd of obds.slice(0, 3)) {
      try {
        // Live delivery header from S/4
        const head = await getDeliveryHead(obd);
        if (head.success) {
          const d = head.data || {};
          const shipLabel = head.shippingStatus === 'C' ? 'ship-ready confirmed' : head.shippingStatus ? 'not yet ship-ready' : 'unknown';
          const giLabel   = head.goodsIssueStatus === 'C' ? 'goods issue posted' : head.goodsIssueStatus ? 'goods issue in progress' : 'goods issue not yet posted';
          const pickLabel = head.pickingStatus === 'C' ? 'picking complete' : head.pickingStatus ? 'picking in progress' : 'picking not started';
          const depDate   = d.TranspPlannedDelivDte || d.PlannedGoodsIssueDate || 'not set';
          liveLines.push(`Delivery ${obd}: shipping=${shipLabel}, goods-issue=${giLabel}, picking=${pickLabel}, planned-departure=${depDate}`);
        }
      } catch (_) {}

      try {
        // Latest scan from our DB
        const [scan] = await SELECT.from('com.loadassurance.ShipmentScan')
          .where({ outboundDelivery: obd })
          .orderBy({ createdAt: 'desc' })
          .limit(1);
        if (scan) {
          liveLines.push(`Scan for ${obd}: totalHUs=${scan.totalHUs}, passed=${scan.passedHUs}, failed=${scan.failedHUs}, blocked=${scan.blockedHUs}, status=${scan.dispatchStatus}, scannedAt=${scan.createdAt}`);
        }
      } catch (_) {}
    }

    // 2. For HU-specific questions, fetch live HU data
    const huMatches = (message + ' ' + (context || '')).match(/\b8[0-9]{5}\b/g) || [];
    const hus = [...new Set(huMatches)].slice(0, 5);
    if (hus.length > 0) {
      try {
        const allHUs = await fetchHUs('2001');
        hus.forEach(huId => {
          const hu = allHUs.find(h => h.huId === huId);
          if (hu) liveLines.push(`HU ${huId}: weight=${hu.grossWeight}${hu.expectedWeightUnit}, expected=${hu.expectedWeight}${hu.expectedWeightUnit}, status=${hu.huStatus}, bin=${hu.storageBin}, blocked=${hu.isBlocked}`);
        });
      } catch (_) {}
    }

    // 3. For "next deliveries" / general questions, pull all recent scans
    if (/next|upcoming|all deliveries|overview|dashboard/i.test(message)) {
      try {
        const scans = await SELECT.from('com.loadassurance.ShipmentScan')
          .where({ dispatchStatus: { '!=': 'SUPERSEDED' } })
          .orderBy({ createdAt: 'desc' })
          .limit(10);
        scans.forEach(s => {
          liveLines.push(`Delivery ${s.outboundDelivery}: ${s.passedHUs}/${s.totalHUs} HUs passed, status=${s.dispatchStatus}, scanned=${s.createdAt}`);
        });
      } catch (_) {}
    }

    const enrichedContext = [
      context || 'Warehouse 2001 — outbound dispatch operations',
      liveLines.length ? '\n\nLIVE DATA (use this — it is real-time):\n' + liveLines.join('\n') : ''
    ].join('');

    let reply = await chatWithAI(message, enrichedContext);
    if (reply) {
      reply = reply
        .replace(/\/SCWM\/\w+/g, '')
        .replace(/\/SAPSLL\/\w+/g, '')
        .replace(/\bVL\d{2,3}[A-Z]?\b/g, '')
        .replace(/\bLX\d{2,3}\b/g, '')
        .replace(/\bMB\d{2,3}\b/g, '')
        .replace(/\bLT\d{1,2}[A-Z]\b/g, '')
        .replace(/\bHUMO\b/g, '')
        .replace(/→\s*→/g, '→')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
    return { reply: reply || 'AI temporarily unavailable.' };
  });

  // ── scanPallet — Computer Vision ────────────────────────────────────────────
  this.on('scanPallet', async (req) => {
    const { outboundDelivery, warehouse, imageBase64, imageMediaType } = req.data;
    if (!imageBase64)      return req.error(400, 'imageBase64 is required');
    if (!outboundDelivery) return req.error(400, 'outboundDelivery is required');
    if (!warehouse)        return req.error(400, 'warehouse is required');

    let result;
    try {
      result = await orchestrateValidation({
        warehouse,
        outboundDelivery,
        imageBase64,
        mediaType: imageMediaType || 'image/jpeg',
        scaleWeight: null,
        quickMode: true
      });
    } catch (e) {
      return req.error(500, `Agent pipeline failed: ${e.message}`);
    }

    const v   = result.visionFindings || {};
    const ewm = result.ewmData || {};

    // Numeric confidence from vision agent (0.0–1.0), converted to display string for legacy field
    const confNum    = parseFloat(String(v.confidence ?? result.confidence ?? 0.85)) || 0.85;
    const confidence = confNum >= 0.8 ? 'HIGH' : confNum >= 0.5 ? 'MEDIUM' : 'LOW';

    // Structured verdict and issues from vision agent (normalise field names)
    const structuredVerdict = (v.verdict || result.verdict || 'REVIEW').toUpperCase();
    const rawIssues         = v.issues || v.Issues || v.problems || [];
    // Hard cap at 3 — prioritise product damage > wrap > stacking
    const structuredIssues  = rawIssues.length <= 3 ? rawIssues : (() => {
      const prod  = rawIssues.filter(i => /rust|corrosion|rusty|torn|dent/i.test(i));
      const wrap  = rawIssues.filter(i => /wrap|shrink/i.test(i));
      const stack = rawIssues.filter(i => /stack|lean|overhang|unstable/i.test(i));
      const other = rawIssues.filter(i => !/rust|corrosion|rusty|torn|dent|wrap|shrink|stack|lean|overhang|unstable/i.test(i));
      return [...prod, ...wrap, ...stack, ...other].slice(0, 3);
    })();
    const wrapIntegrity     = v.wrapIntegrity || v.wrap_integrity || v.WrapIntegrity
      || (v.stretchWrapIntact === false ? 'FAIL' : v.stretchWrapIntact === true ? 'PASS' : 'REVIEW');

    // EWM summary for display
    const ewmSummary = (ewm.hus || []).length
      ? ewm.hus.map(h => `HU ${h.huId}: expected ${h.expectedWeight}kg | actual ${h.grossWeight}kg | ${h.huStatus}`).join('\n')
      : `Delivery ${outboundDelivery} — ${(ewm.hus || []).length} HUs found.`;

    // AI verdict from decision agent
    const aiVerdict = result.resolution
      ? `VERDICT: ${structuredVerdict}\n\n${result.resolution.failureReason}\n\nCorrection Steps:\n${(result.resolution.correctionSteps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}${result.resolution.estimatedResolutionTime ? '\n\nEstimated time: ' + result.resolution.estimatedResolutionTime : ''}`
      : `VERDICT: ${structuredVerdict} (Confidence: ${Math.round(confNum * 100)}%)\n\n${result.rootCause || ''}\n\n${result.agents?.decision?.dispatchRecommendation || ''}`;

    console.log('[scanPallet] returning:', JSON.stringify({
      verdict: structuredVerdict, confidence: confNum, wrapIntegrity, issueCount: structuredIssues.length
    }));

    return {
      visionFindings:  JSON.stringify(v),
      ewmSummary,
      aiVerdict,
      huLabelMatch:    result.labelMatch    != null ? !!result.labelMatch    : null,
      itemCountMatch:  result.itemCountMatch != null ? !!result.itemCountMatch : null,
      palletCondition: v.palletCondition || 'UNKNOWN',
      confidence,
      // Structured fields for UI display
      verdict:         structuredVerdict,
      issues:          JSON.stringify(structuredIssues),
      wrapIntegrity,
      confidenceNum:   confNum,
      huLabelDetected: !!v.huLabel,
      huLabelReadable: !v.labelDamage && !!v.huLabel,
      stackingCompliant: v.stackingCompliant !== false,
      recommendation:  (() => {
        const issuesLc = (v.issues || []).join(' ').toLowerCase();
        if (issuesLc.includes('rust') || issuesLc.includes('corrosion') || issuesLc.includes('rusty')) {
          return 'Remove rusty products from pallet and move to scrapping area. Repick quality confirmed product.\n\nWould you like me to cancel the pick, create a transfer task to scrapping zone, and create a new pick warehouse task?';
        }
        return v.stackingRecommendation || (structuredVerdict === 'PASS' ? 'Pallet approved for dispatch' : 'Resolve issues before dispatch');
      })(),
      labelTextsRead:  JSON.stringify(v.labelTextsRead || []),
      // Warehouse Task result (populated on FAIL)
      wtCreated:       result.resolution?.wtCreated  || false,
      wtNumber:        result.resolution?.wtNumber   || null,
      wtText:          result.resolution?.wtText     || null,
      // Agent pipeline results
      agentVision:     result.agents?.vision     ? JSON.stringify({ agentStatus: result.agents.vision.agentStatus,     agentTime: result.agents.vision.agentTime,     palletCondition: v.palletCondition }) : null,
      agentKnowledge:  result.agents?.knowledge  ? JSON.stringify({ agentStatus: result.agents.knowledge.agentStatus,  agentTime: result.agents.knowledge.agentTime,  hus: ewm.hus }) : null,
      agentDecision:   result.agents?.decision   ? JSON.stringify({ agentStatus: result.agents.decision.agentStatus,   agentTime: result.agents.decision.agentTime,   verdict: structuredVerdict, confidence }) : null,
      agentAction:     result.agents?.action     ? JSON.stringify({ agentStatus: result.agents.action.agentStatus,     agentTime: result.agents.action.agentTime,     success: result.agents.action.success,    confirmationNumber: result.agents.action.confirmationNumber }) : null,
      agentResolution: result.agents?.resolution ? JSON.stringify({ agentStatus: result.agents.resolution.agentStatus, agentTime: result.agents.resolution.agentTime, failureReason: result.agents.resolution.failureReason }) : null
    };
  });

  // ── getHUList (legacy) ──────────────────────────────────────────────────────
  this.on('getHUList', async (req) => {
    const { warehouse } = req.data;
    if (!warehouse) return req.error(400, 'warehouse is required');
    try {
      const hus = await fetchHUs(warehouse);
      return hus.map(hu => ({
        huId: hu.huId, huType: hu.huType, warehouseNumber: hu.warehouseNumber,
        storageBin: hu.storageBin, expectedWeight: hu.expectedWeight,
        expectedWeightUnit: hu.expectedWeightUnit, actualWeightEWM: hu.grossWeight,
        huStatus: hu.huStatus, labelStatus: hu.labelStatus || '',
        refDocument: hu.refDocument || '',
        stackingAllowed: true, stackingFactor: '1'
      }));
    } catch (e) {
      return req.error(500, `Failed to fetch HUs: ${e.message}`);
    }
  });

  // ── getDeliveries ────────────────────────────────────────────────────────────
  this.on('getDeliveries', async (req) => {
    const { warehouse } = req.data;
    if (!warehouse) return req.error(400, 'warehouse is required');
    try {
      const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

      // Step 1: Get open outbound delivery orders from EWM (not yet GI-posted)
      // OverallWarehouseActivityStatus != 'C' means not fully completed
      let openDeliverySet = null;
      try {
        // OData V2 — try without warehouse filter first to see what fields come back
        // Paginate all delivery orders for this warehouse.
        // Field name is "Warehouse" (not WarehouseNumber) on this EWM system.
        // No status field available at collection level — use existence as allow-list.
        openDeliverySet = new Set();
        let dlvUrl = `${GI_SERVICE_PATH}/WhseOutboundDeliveryOrderHead?$filter=Warehouse eq '${warehouse}'&$select=OutboundDeliveryOrder,Warehouse&$top=500`;
        let dlvPage = 0;
        while (dlvUrl) {
          dlvPage++;
          console.log(`[getDeliveries] Fetching delivery orders page ${dlvPage}:`, dlvUrl);
          const dlvResp = await executeHttpRequest(
            { destinationName: DESTINATION },
            { method: 'GET', url: dlvUrl, headers: { 'Accept': 'application/json', 'sap-client': '100' } }
          );
          const dlvItems = dlvResp.data?.d?.results || dlvResp.data?.value || [];
          dlvItems.forEach(d => {
            const norm = (d.OutboundDeliveryOrder || '').replace(/^0+/, '');
            if (norm) openDeliverySet.add(norm);
          });
          // OData V2 paging via __next link
          const nextLink = dlvResp.data?.d?.__next || dlvResp.data?.['@odata.nextLink'];
          dlvUrl = (nextLink && dlvItems.length > 0) ? nextLink : null;
          if (dlvPage > 10) { console.warn('[getDeliveries] DLV pagination safety limit'); break; }
        }
        console.log(`[getDeliveries] EWM delivery orders for ${warehouse}: ${openDeliverySet.size}`);
      } catch (e) {
        console.warn('[getDeliveries] Could not fetch delivery orders:', e.message, e.response?.status, JSON.stringify(e.response?.data)?.slice(0, 300));
      }

      // Step 2: Get HUs for the warehouse — include status flags to filter out ghost deliveries
      // deliveryMap[ref] = { total, active }
      // "active" = HU is still staged/in-stock (PLAN or STOCK); not UNKN (already GI-posted)
      const deliveryMap = {};
      const selectFields = [
        'HandlingUnitReferenceDocument',
        'EWMHandlingUnitIsPlanned',
        'EWMHandlingUnitIsInStock',
        'EWMHandlingUnitIsLoaded'
      ].join(',');
      let url = `${EWM_HU_PATH}?$select=${selectFields}&$top=1000&$filter=Warehouse eq '${warehouse}'`;
      let page = 0;
      while (url) {
        page++;
        const response = await executeHttpRequest(
          { destinationName: DESTINATION },
          { method: 'GET', url, headers: { 'Accept': 'application/json', 'sap-client': '100' } }
        );
        const items = response.data?.value || [];
        items.forEach(item => {
          const ref = item.HandlingUnitReferenceDocument;
          if (!ref) return;
          const norm = ref.toString().replace(/^0+/, '');
          if (!norm.startsWith('8') || norm.startsWith('18')) return;
          const isActive = !!(item.EWMHandlingUnitIsPlanned || item.EWMHandlingUnitIsInStock || item.EWMHandlingUnitIsLoaded);
          if (!deliveryMap[ref]) deliveryMap[ref] = { total: 0, active: 0 };
          deliveryMap[ref].total++;
          if (isActive) deliveryMap[ref].active++;
        });
        const next = response.data?.['@odata.nextLink'];
        url = (next && items.length > 0)
          ? (next.startsWith('http') ? next : `${EWM_HU_PATH.replace(/\/[^/]+$/, '')}/${next}`)
          : null;
        if (page > 20) { console.warn('[getDeliveries] Pagination safety limit reached'); break; }
      }
      // Only keep deliveries that have at least one active HU
      const map = {};
      Object.entries(deliveryMap).forEach(([ref, counts]) => {
        if (counts.active > 0) map[ref] = counts.total;
      });
      console.log(`[getDeliveries] warehouse=${warehouse} pages=${page} raw deliveries=${Object.keys(deliveryMap).length} active deliveries=${Object.keys(map).length}`);

      // Step 3: Filter — only show deliveries that are in the open delivery orders list
      return Object.entries(map)
        .filter(([outboundDelivery]) => {
          if (!openDeliverySet) return true; // if EWM call failed, show all
          const norm = outboundDelivery.replace(/^0+/, '');
          return openDeliverySet.has(norm);
        })
        .map(([outboundDelivery, huCount]) => ({ outboundDelivery, huCount }))
        .sort((a, b) => a.outboundDelivery.localeCompare(b.outboundDelivery));
    } catch (e) {
      return req.error(500, `Failed: ${e.message}`);
    }
  });

  // ── debugDB — show scan history ────────────────────────────────────────────
  this.on('debugDB', async (req) => {
    const { warehouse } = req.data;
    const scans = await SELECT.from(ShipmentScan)
      .where(warehouse ? { warehouse } : {})
      .orderBy({ createdAt: 'desc' })
      .limit(50);
    return scans.map(s => ({
      outboundDelivery: s.outboundDelivery,
      warehouse: s.warehouse,
      dispatchStatus: s.dispatchStatus,
      createdAt: s.createdAt
    }));
  });

  // ── debugEWM — probe ODO2 + WT API availability ───────────────────────────
  this.on('debugEWM', async (req) => {
    const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
    const opts = { destinationName: DESTINATION };
    const results = {};

    // Test 1: ODO2 service root reachable?
    try {
      const r = await executeHttpRequest(opts, {
        method: 'GET', url: ODO2_BASE,
        headers: { Accept: 'application/json', 'sap-client': '100' }
      }, { fetchCsrfToken: false });
      results.odo2Root = { status: r.status, keys: Object.keys(r.data || {}).slice(0, 10) };
    } catch(e) { results.odo2Root = { status: e.response?.status || 'ERR', error: e.message?.slice(0, 150) }; }

    // Test 2: ODO2 head entity set (list first 3 deliveries)
    try {
      const r = await executeHttpRequest(opts, {
        method: 'GET', url: ODO2_HEAD + '?$top=3',
        headers: { Accept: 'application/json', 'sap-client': '100' }
      }, { fetchCsrfToken: false });
      const vals = r.data?.value || [];
      results.odo2HeadList = { status: r.status, count: vals.length, deliveries: vals.map(v => v.EWMOutboundDeliveryOrder || v.OutboundDeliveryOrder || JSON.stringify(v).slice(0,50)) };
    } catch(e) { results.odo2HeadList = { status: e.response?.status || 'ERR', error: e.message?.slice(0, 150) }; }

    // Test 3: ODO2 $metadata — confirm actions on both Head and Item
    try {
      const r = await executeHttpRequest(opts, {
        method: 'GET', url: ODO2_BASE + '$metadata',
        headers: { Accept: 'application/xml', 'sap-client': '100' }
      }, { fetchCsrfToken: false });
      const xml = String(r.data || '');
      const actions = (xml.match(/Action\s+Name="([^"]+)"/g) || []).map(m => m.match(/Name="([^"]+)"/)?.[1]);
      // Also extract bound action bindings to know which entity they belong to
      const bindings = (xml.match(/ActionImport[^>]+Name="([^"]+)"[^>]+Action="([^"]+)"/g) || [])
        .map(m => ({ name: m.match(/Name="([^"]+)"/)?.[1], action: m.match(/Action="([^"]+)"/)?.[1] }));
      results.odo2Actions = { status: r.status, actions, bindings: bindings.slice(0, 20) };
    } catch(e) { results.odo2Actions = { status: e.response?.status || 'ERR', error: e.message?.slice(0, 150) }; }

    // Test 3b: ODO2 Item entity — list first item to see key fields
    try {
      const r = await executeHttpRequest(opts, {
        method: 'GET', url: ODO2_ITEM + '?$top=1',
        headers: { Accept: 'application/json', 'sap-client': '100' }
      }, { fetchCsrfToken: false });
      const item = (r.data?.value || [])[0] || {};
      results.odo2ItemSample = { status: r.status, keys: Object.keys(item).slice(0, 20), sample: JSON.stringify(item).slice(0, 300) };
    } catch(e) { results.odo2ItemSample = { status: e.response?.status || 'ERR', error: e.message?.slice(0, 150) }; }

    // Test 4b: WT Cancel API (API_WAREHOUSE_ORDER_TASK_SRV)
    try {
      const r = await executeHttpRequest(opts, {
        method: 'GET', url: '/sap/opu/odata/sap/API_WAREHOUSE_ORDER_TASK_SRV/$metadata',
        headers: { Accept: 'application/xml', 'sap-client': '100' }
      }, { fetchCsrfToken: false });
      const xml = String(r.data || '');
      const fnImports = (xml.match(/FunctionImport[^>]+Name="([^"]+)"/g) || [])
        .map(m => m.match(/Name="([^"]+)"/)?.[1]).filter(Boolean);
      const entityTypes = (xml.match(/EntityType[^>]+Name="([^"]+)"/g) || [])
        .map(m => m.match(/Name="([^"]+)"/)?.[1]).filter(Boolean);
      results.wtCancelApi = { status: r.status, functionImports: fnImports, entityTypes };
    } catch(e) { results.wtCancelApi = { status: e.response?.status || 'ERR', error: e.message?.slice(0, 150) }; }

    // Test 5: GI V2 metadata — get function imports
    try {
      const r = await executeHttpRequest(opts, {
        method: 'GET', url: GI_SERVICE_PATH + '/$metadata',
        headers: { Accept: 'application/xml', 'sap-client': '100' }
      }, { fetchCsrfToken: false });
      const xml = String(r.data || '');
      const fnImports = (xml.match(/FunctionImport[^>]+Name="([^"]+)"/g) || [])
        .map(m => m.match(/Name="([^"]+)"/)?.[1]).filter(Boolean);
      results.giV2 = { status: r.status, functionImports: fnImports };
    } catch(e) { results.giV2 = { status: e.response?.status || 'ERR', error: e.message?.slice(0, 150) }; }

    // Test 6: Warehouse Task OData4 API (api_warehouse_task)
    const WT_PATHS = [
      '/sap/opu/odata4/sap/api_warehouse_task/srvd_a2x/sap/warehousetask/0001/$metadata',
      '/sap/opu/odata4/sap/api_whse_task/srvd_a2x/sap/warehousetask/0001/$metadata',
      '/sap/opu/odata4/sap/api_warehouse_order_task/srvd_a2x/sap/warehouseordertask/0001/$metadata',
    ];
    for (const wtPath of WT_PATHS) {
      try {
        const r = await executeHttpRequest(opts, {
          method: 'GET', url: wtPath,
          headers: { Accept: 'application/xml', 'sap-client': '100' }
        }, { fetchCsrfToken: false });
        const xml = String(r.data || '');
        const actions = (xml.match(/Action\s+Name="([^"]+)"/g) || []).map(m => m.match(/Name="([^"]+)"/)?.[1]);
        results['wtOdata4_' + wtPath.split('/').slice(-3)[0]] = { status: r.status, path: wtPath, actions };
      } catch(e) {
        results['wtOdata4_' + wtPath.split('/').slice(-3)[0]] = { status: e.response?.status || 'ERR', path: wtPath, error: e.message?.slice(0, 150) };
      }
    }

    // Test 7: Outbound Delivery Order Item — check if item actions include confirm loading
    try {
      const r = await executeHttpRequest(opts, {
        method: 'GET', url: ODO2_BASE + '$metadata',
        headers: { Accept: 'application/xml', 'sap-client': '100' }
      }, { fetchCsrfToken: false });
      const xml = String(r.data || '');
      // Grab ALL action names including those with item bindings
      const allActions = (xml.match(/Action[^>]+Name="([^"]+)"/g) || []).map(m => m.match(/Name="([^"]+)"/)?.[1]);
      const allImports = (xml.match(/ActionImport[^>]+Name="([^"]+)"/g) || []).map(m => m.match(/Name="([^"]+)"/)?.[1]);
      // Check for any confirm/load related actions in full XML
      const confirmHits = [...xml.matchAll(/[Cc]onfirm[^"<]{0,40}/g)].map(m => m[0]).slice(0, 10);
      const loadHits    = [...xml.matchAll(/[Ll]oad[^"<]{0,40}/g)].map(m => m[0]).slice(0, 10);
      results.odo2Full = { allActions, allImports, confirmHits, loadHits };
    } catch(e) { results.odo2Full = { status: e.response?.status || 'ERR', error: e.message?.slice(0, 150) }; }

    console.log('[debugEWM]', JSON.stringify(results, null, 2));
    return { actions: [JSON.stringify(results, null, 2)], status: 200, error: '' };
  });
  this.on('getValidationLog', async () => {
    return SELECT.from(ValidationLog).orderBy({ createdAt: 'desc' }).limit(100);
  });

  // ── postGoodsIssue ──────────────────────────────────────────────────────────
  // Step 3 only: PostGoodsIssue — closes the delivery, HUs leave warehouse.
  this.on('postGoodsIssue', async (req) => {
    const { outboundDelivery, warehouseNumber } = req.data;
    if (!outboundDelivery) return req.error(400, 'outboundDelivery is required');
    try {
      const head = await getDeliveryHead(outboundDelivery);
      if (!head.success) return { success: false, method: 'ODO2', status: 0, message: head.error };
      const s3 = await postDeliveryAction(outboundDelivery, 'PostGoodsIssue', head.etag);
      if (!s3.success) {
        const msgLc = (s3.error || '').toLowerCase();
        if (msgLc.includes('already') || msgLc.includes('bereits')) {
          // Mark DB as SHIPPED even on "already posted"
          await UPDATE(ShipmentScan).set({ dispatchStatus: 'SHIPPED' })
            .where({ outboundDelivery })
            .where('dispatchStatus !=', 'SUPERSEDED');
          return { success: true, method: 'ODO2', status: 200, message: 'Goods Issue already posted' };
        }
        return { success: false, method: 'ODO2', status: 0, message: s3.error };
      }
      await UPDATE(ShipmentScan).set({ dispatchStatus: 'SHIPPED' })
        .where({ outboundDelivery })
        .where('dispatchStatus !=', 'SUPERSEDED');
      console.log(`[postGoodsIssue] ${outboundDelivery} → SHIPPED`);
      return { success: true, method: 'ODO2', status: 200, message: 'Goods Issue posted — vehicle cleared for departure' };
    } catch (e) {
      return { success: false, method: 'ODO2', status: 0, message: e.message };
    }
  });

  // ── activateLoading ──────────────────────────────────────────────────────────
  // Step 3: ActivateImmediateLoading (ASR) or ActivateAdhocLoading (non-ASR). OFO: skip, loading via freight order.
  this.on('activateLoading', async (req) => {
    const { outboundDelivery } = req.data;
    if (!outboundDelivery) return req.error(400, 'outboundDelivery is required');
    try {
      const head = await getDeliveryHead(outboundDelivery);
      if (!head.success) return { success: false, loadingActivated: false, message: head.error, messages: [head.error] };

      console.log(`[activateLoading] ${outboundDelivery} DocType=${head.docType} isOFO=${head.isOFO} immdLoad=${head.immediateLoadActive} adhocLoad=${head.adhocLoadActive}`);

      // OFO deliveries: try ActivateImmediateLoading — if EWM rejects, fall back to adhoc
      // (do not skip — OFO deliveries can still use ActivateImmediateLoading at head level)

      if (head.immediateLoadActive || head.adhocLoadActive) {
        console.log(`[activateLoading] ${outboundDelivery} — loading already active in EWM`);
        return { success: true, loadingActivated: true, message: 'Loading already active in EWM', messages: ['Loading already active'] };
      }

      // Try ASR action first
      const s = await postDeliveryAction(outboundDelivery, 'ActivateImmediateLoading', head.etag);
      if (s.success) {
        console.log(`[activateLoading] ${outboundDelivery} — ActivateImmediateLoading success (ASR)`);
        return { success: true, loadingActivated: true, message: 'Loading activated — RF task sent to operator gun', messages: ['Loading activated'] };
      }

      const errMsg = s.error || 'EWM rejected ActivateImmediateLoading';
      const isBlocked = errMsg.toLowerCase().includes('blocked') || errMsg.includes('BEHAVIOR_ILLEGAL');

      if (isBlocked) {
        console.log(`[activateLoading] ${outboundDelivery} — delivery BLOCKED, cannot activate loading`);
        return { success: false, loadingActivated: false, message: 'Cannot activate loading — delivery is BLOCKED in EWM. Please reverse the block first.', messages: ['Delivery is blocked'] };
      }

      // ASR action failed for non-block reason — try adhoc (non-ASR deliveries)
      console.log(`[activateLoading] ${outboundDelivery} — ActivateImmediateLoading failed (${errMsg}), trying ActivateAdhocLoading`);
      const head2 = await getDeliveryHead(outboundDelivery);
      const s2 = await postDeliveryAction(outboundDelivery, 'ActivateAdhocLoading', head2.etag);
      if (s2.success) {
        console.log(`[activateLoading] ${outboundDelivery} — ActivateAdhocLoading success (non-ASR)`);
        return { success: true, loadingActivated: true, message: 'Loading activated — proceed to load vehicle', messages: ['Adhoc loading activated'] };
      }

      const errMsg2 = s2.error || 'EWM rejected ActivateAdhocLoading';
      console.log(`[activateLoading] ${outboundDelivery} — both actions failed. ASR: ${errMsg} | Adhoc: ${errMsg2}`);
      return { success: false, loadingActivated: false, message: `EWM error: ${errMsg2}`, messages: [errMsg2] };

    } catch (e) {
      console.error(`[activateLoading] error: ${e.message}`);
      return { success: false, loadingActivated: false, message: e.message, messages: [e.message] };
    }
  });

  // ── confirmLoading ──────────────────────────────────────────────────────────
  // Step 4: Operator confirms handling units are physically loaded onto vehicle.
  this.on('confirmLoading', async (req) => {
    const { outboundDelivery } = req.data;
    if (!outboundDelivery) return req.error(400, 'outboundDelivery is required');
    console.log(`[confirmLoading] ${outboundDelivery} — operator confirms physical load`);
    return { success: true, loadingActivated: true, giPosted: false, message: 'Vehicle loaded — proceed to Post Goods Issue', messages: ['Vehicle loaded confirmed by operator'] };
  });

  // ── reverseShippingReadiness ─────────────────────────────────────────────────
  // Called by the "Cancel Pick / Return to Storage" button.
  // Performs head-level GI reversal + shipping readiness reversal on ODO2.
  this.on('reverseShippingReadiness', async (req) => {
    const { outboundDelivery, warehouse } = req.data;
    if (!outboundDelivery) return req.error(400, 'outboundDelivery is required');

    const head = await getDeliveryHead(outboundDelivery);
    if (!head.success) return { success: false, status: 0, message: head.error, nextStep: 'Check EWM manually', manualSteps: [] };

    if (head.goodsIssueStatus === 'C') {
      await postDeliveryAction(outboundDelivery, 'ReverseGoodsIssue', head.etag);
    }

    let reversed = false;
    const shippingStatus = head.shippingStatus || '';
    if (shippingStatus === 'C' || shippingStatus === 'B') {
      const freshHead = await getDeliveryHead(outboundDelivery);
      const rsr = await postDeliveryAction(outboundDelivery, 'ReverseShippingReadiness', freshHead.etag);
      reversed = rsr.success;
    } else {
      reversed = true; // nothing to reverse
      console.log(`[RSR] Shipping readiness not set (${shippingStatus}) — skipping`);
    }

    return {
      success:     reversed,
      status:      reversed ? 200 : 0,
      message:     reversed ? `Delivery ${outboundDelivery} reset in EWM. Use /SCWM/CANCPICK to cancel pick task manually.` : 'Could not reset delivery',
      nextStep:    'Use /SCWM/CANCPICK to create return task manually',
      manualSteps: [
        'STOP — Do NOT load onto vehicle',
        'Open SAP transaction /SCWM/CANCPICK',
        'Enter Warehouse: ' + (warehouse || '2001'),
        'Execute — EWM creates return task on RF gun',
        'Complete return task on RF gun',
        'Get correct HU for delivery ' + outboundDelivery,
        'Bring correct HU to GI-ZONE and re-scan'
      ]
    };
  });

  // ── cancelPicking ────────────────────────────────────────────────────────────
  // Sequence: 1) ReverseShippingReadiness (ODO2) → 2) ZCL_EWM_CANCEL_PICKING_API (SICF)
  // EWM rejects cancel pick while shipping readiness is set — must reverse first.
  this.on('cancelPicking', async (req) => {
    const { huId, outboundDelivery, warehouse, itemNo } = req.data;
    if (!outboundDelivery) return req.error(400, 'outboundDelivery is required');

    const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
    const wh = warehouse || '2001';
    const steps = [];

    let success = false, message = '', gmitems = 0;

    try {
      // ── STEP 1: Reverse Shipping Readiness via ODO2 ────────────────────────
      // EWM will dump/reject cancel pick if shipping readiness is still set.
      const head = await getDeliveryHead(outboundDelivery);
      if (!head.success) {
        console.warn(`[cancelPicking] cannot read delivery head: ${head.error} — skipping reversal`);
        steps.push(`Delivery head read failed: ${head.error}`);
      } else {
        const shippingStatus = head.shippingStatus || '';
        console.log(`[cancelPicking] delivery ${outboundDelivery} shippingStatus=${shippingStatus} goodsIssueStatus=${head.goodsIssueStatus}`);

        if (head.goodsIssueStatus === 'C') {
          // GI already posted — reverse it first so we can reverse shipping readiness
          console.log(`[cancelPicking] GI already posted — reversing GI first`);
          const rgi = await postDeliveryAction(outboundDelivery, 'ReverseGoodsIssue', head.etag);
          steps.push(rgi.success ? 'GI reversed' : `GI reversal failed: ${rgi.error}`);
          // Re-fetch head after GI reversal
          const head2 = await getDeliveryHead(outboundDelivery);
          if (head2.success) {
            const rsr = await postDeliveryAction(outboundDelivery, 'ReverseShippingReadiness', head2.etag);
            steps.push(rsr.success ? 'Shipping readiness reversed' : `Shipping reversal failed: ${rsr.error}`);
            console.log(`[cancelPicking] ReverseShippingReadiness after GI: ${rsr.success}`);
          }
        } else if (shippingStatus === 'C' || shippingStatus === 'B') {
          const rsr = await postDeliveryAction(outboundDelivery, 'ReverseShippingReadiness', head.etag);
          steps.push(rsr.success ? 'Shipping readiness reversed' : `Shipping reversal failed: ${rsr.error}`);
          console.log(`[cancelPicking] ReverseShippingReadiness (status ${shippingStatus}): ${rsr.success} ${rsr.error||''}`);
        } else {
          steps.push(`Shipping readiness not set (status: ${shippingStatus||'empty'}) — no reversal needed`);
          console.log(`[cancelPicking] shipping readiness not set (${shippingStatus}) — skipping reversal`);
        }
      }

      // ── STEP 2: Resolve actual item number from ODO2 ───────────────────────
      let resolvedItem = itemNo || '10';
      try {
        const obdKey = String(outboundDelivery).padStart(10, '0');
        const itemsResp = await executeHttpRequest(
          { destinationName: DESTINATION },
          { method: 'GET', url: `${ODO2_HEAD}('${obdKey}')/to_DeliveryOrderItem?$top=20`, headers: { Accept: 'application/json', 'sap-client': '100' } },
          { fetchCsrfToken: false }
        );
        const items = itemsResp.data?.value || [];
        console.log(`[cancelPicking] delivery items:`, items.map(i => i.EWMOutboundDeliveryOrderItem).join(','));
        if (items.length > 0) {
          const match = items.find(i => i.HandlingUnitExternalID === huId || i.EWMHandlingUnitExternalID === huId);
          const chosen = match || items[0];
          resolvedItem = String(parseInt(chosen.EWMOutboundDeliveryOrderItem || '10', 10));
          console.log(`[cancelPicking] resolved item_no=${resolvedItem}`);
        }
      } catch (itemErr) {
        console.warn(`[cancelPicking] item lookup failed (using ${resolvedItem}): ${itemErr.message}`);
      }

      // ── STEP 3: CSRF token for SICF POST ──────────────────────────────────
      let csrfToken = '*';
      try {
        const tokenResp = await executeHttpRequest(
          { destinationName: DESTINATION },
          { method: 'GET', url: '/sap/bc/zewm_cancel_pic', headers: { 'sap-client': '100', 'x-csrf-token': 'Fetch' } },
          { fetchCsrfToken: false }
        );
        csrfToken = tokenResp.headers?.['x-csrf-token'] || tokenResp.headers?.['X-CSRF-Token'] || '*';
      } catch (tokenErr) {
        console.warn(`[cancelPicking] CSRF fetch failed: ${tokenErr.message}`);
      }

      // ── STEP 4: Call ZCL_EWM_CANCEL_PICKING_API ───────────────────────────
      const body = { warehouse: wh, outbound_delivery: outboundDelivery, item_no: resolvedItem, hu_id: huId || '' };
      console.log(`[cancelPicking] POST /sap/bc/zewm_cancel_pic`, JSON.stringify(body));

      const resp = await executeHttpRequest(
        { destinationName: DESTINATION },
        {
          method:  'POST',
          url:     '/sap/bc/zewm_cancel_pic',
          headers: { 'sap-client': '100', 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-csrf-token': csrfToken },
          data:    JSON.stringify(body)
        },
        { fetchCsrfToken: false }
      );

      const respBody = typeof resp.data === 'string' ? (() => { try { return JSON.parse(resp.data); } catch(e) { return { raw: resp.data }; } })() : (resp.data || {});
      console.log(`[cancelPicking] ABAP response status=${resp.status}`, JSON.stringify(respBody));
      steps.push(`ABAP cancel pick: ${JSON.stringify(respBody)}`);

      success = !!(respBody.SUCCESS || respBody.success ||
                   (respBody.return && respBody.return[0]?.type === 'S') ||
                   (respBody.type === 'S'));
      message  = respBody.MESSAGE || respBody.message || (respBody.return && respBody.return[0]?.message) || '';
      gmitems  = parseInt(respBody.GMITEMS || respBody.gmitems || '0', 10) || 0;

    } catch (e) {
      const abapBody = e.response?.data;
      const abapStatus = e.response?.status;
      console.error(`[cancelPicking] error status=${abapStatus}:`, e.message, JSON.stringify(abapBody));
      const parsed = abapBody && typeof abapBody === 'object' ? abapBody
                   : abapBody ? (() => { try { return JSON.parse(abapBody); } catch(_) { return null; } })() : null;
      if (parsed) {
        success = !!(parsed.SUCCESS || parsed.success);
        message  = parsed.MESSAGE || parsed.message || parsed.error || JSON.stringify(parsed);
        gmitems  = parseInt(parsed.GMITEMS || parsed.gmitems || '0', 10) || 0;
      } else {
        message = `HTTP ${abapStatus || 'error'}: ${e.message}`;
      }
    }

    console.log(`[cancelPicking] done — success=${success} steps=[${steps.join(' | ')}]`);

    const aiGuidance = await callAI(
      success
        ? `Pick for HU ${huId} on delivery ${outboundDelivery} was successfully cancelled in EWM. ${gmitems} stock movement(s) processed. Shipping readiness was reversed first. In 2-3 sentences tell the operator what happened and what to do next (get correct HU, bring to GI-ZONE, re-scan).`
        : `Cancel pick for HU ${huId} on delivery ${outboundDelivery} failed: ${message}. Steps attempted: ${steps.join(', ')}. In 2-3 sentences explain what likely went wrong and what the operator should do manually (use /SCWM/CANCPICK or /SCWM/PRDO).`
    ).catch(() => '');

    return { success, message, gmitems, aiGuidance };
  });

  // ── createPick — creates picking warehouse task via EWM Warehouse Order Task API ──
  this.on('createPick', async (req) => {
    const { huId, outboundDelivery, warehouse } = req.data;
    if (!outboundDelivery) return req.error(400, 'outboundDelivery is required');
    console.log(`[createPick] huId=${huId||'(none)'} obd=${outboundDelivery} wh=${warehouse}`);

    const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
    const WT_BASE = '/sap/opu/odata4/sap/api_warehouse_order_task_2/srvd_a2x/sap/warehouseorder/0001';

    try {
      // Step 1: Fetch CSRF token + cookies
      let csrfToken = '*', cookies = '';
      try {
        const tok = await executeHttpRequest(
          { destinationName: DESTINATION },
          { method: 'GET', url: `${WT_BASE}/WarehouseTask?$top=1`, headers: { Accept: 'application/json', 'sap-client': '100', 'x-csrf-token': 'Fetch' } },
          { fetchCsrfToken: false }
        );
        csrfToken = tok.headers?.['x-csrf-token'] || tok.headers?.['X-CSRF-Token'] || '*';
        cookies   = (tok.headers?.['set-cookie'] || []).join('; ');
        console.log(`[createPick] CSRF token: ${csrfToken ? 'obtained' : 'empty'}`);
      } catch (e) { console.warn(`[createPick] CSRF fetch failed: ${e.message}`); }

      // Step 2: Create warehouse task via WarehouseOrderPickHndlgUnit
      const postHeaders = {
        Accept: 'application/json', 'Content-Type': 'application/json',
        'sap-client': '100', 'x-csrf-token': csrfToken
      };
      if (cookies) postHeaders['Cookie'] = cookies;

      const r = await executeHttpRequest(
        { destinationName: DESTINATION },
        { method: 'POST', url: `${WT_BASE}/WarehouseTask`,
          headers: postHeaders, data: { EWMDelivery: outboundDelivery } },
        { fetchCsrfToken: false }
      );

      const success = r.status < 400;
      const wtNumber = r.data?.WarehouseOrder || r.data?.WarehouseTask || '';
      const message = success
        ? `Picking warehouse task created for delivery ${outboundDelivery}.${huId ? ' HU: ' + huId : ''} Task will appear on RF gun.${wtNumber ? ' WT: ' + wtNumber : ''}`
        : `Pick task creation returned HTTP ${r.status}`;

      console.log(`[createPick] status=${r.status} wt=${wtNumber}`);
      return { success, message };

    } catch (e) {
      console.error(`[createPick] error:`, e.message);
      const errData = e.response?.data;
      const detail = errData?.error?.message?.value || errData?.error?.message || (typeof errData === 'string' ? errData : JSON.stringify(errData)) || e.message;
      console.error(`[createPick] EWM error detail:`, JSON.stringify(errData));
      return { success: false, message: `Pick task creation failed: ${detail}` };
    }
  });

  // ── diagnoseBlockReason ─────────────────────────────────────────────────────
  this.on('diagnoseBlockReason', async (req) => {
    const { huId, warehouse } = req.data;
    if (!huId) return req.error(400, 'huId is required');
    return diagnoseBlockReason(huId, warehouse || '');
  });

  // ── createIncident ──────────────────────────────────────────────────────────
  this.on('createIncident', async (req) => {
    const { huId, outboundDelivery, warehouse, failureType } = req.data;
    if (!outboundDelivery) return req.error(400, 'outboundDelivery is required');
    const report = await generateIncidentReport({ huId: huId || '', obdNumber: outboundDelivery, warehouse: warehouse || '', failureType: failureType || 'BLOCKED' });
    const { sent, error: emailErr } = await sendIncidentEmail(report.incidentId, report.failureType, outboundDelivery, report.incidentText);
    return { ...report, emailSent: sent, emailError: emailErr || null, supervisorEmail: process.env.SUPERVISOR_EMAIL || null };
  });

  // ── findAlternativeHUs ──────────────────────────────────────────────────────
  this.on('findAlternativeHUs', async (req) => {
    const { huId, warehouse, outboundDelivery } = req.data;
    if (!huId)      return req.error(400, 'huId is required');
    if (!warehouse) return req.error(400, 'warehouse is required');
    return findAlternativeHUs(huId, warehouse, outboundDelivery || '');
  });

  // ── getRepackSuggestion ─────────────────────────────────────────────────────
  this.on('getRepackSuggestion', async (req) => {
    const { huId, outboundDelivery, warehouse } = req.data;
    if (!huId)             return req.error(400, 'huId is required');
    if (!outboundDelivery) return req.error(400, 'outboundDelivery is required');
    return generateRepackSuggestion(huId, outboundDelivery, warehouse || '');
  });

  // ── getExceptions ───────────────────────────────────────────────────────────
  this.on('getExceptions', async () => {
    try {
      const scans = await SELECT.from(ShipmentScan)
        .columns('ID', 'outboundDelivery', 'warehouse', 'dispatchStatus', 'createdAt')
        .where('dispatchStatus !=', 'SUPERSEDED')
        .orderBy({ createdAt: 'desc' })
        .limit(100);
      if (!scans.length) return [];
      const scanMap = {};
      scans.forEach(s => { scanMap[s.ID] = s; });
      const ids = scans.map(s => s.ID);
      const excs = await SELECT.from(ExceptionLog)
        .where({ scan_ID: { in: ids } })
        .where('resolvedBy =', 'PENDING')
        .orderBy({ createdAt: 'desc' })
        .limit(200);
      return excs.map(e => {
        const scan = scanMap[e.scan_ID] || {};
        return {
          huId:             e.huId,
          warehouse:        e.warehouse || scan.warehouse || '',
          exceptionType:    e.exceptionType,
          severity:         e.severity,
          description:      e.description,
          resolvedBy:       e.resolvedBy,
          resolutionAction: e.resolutionAction || '',
          scanId:           e.scan_ID,
          outboundDelivery: scan.outboundDelivery || '',
          scannedAt:        scan.createdAt || e.createdAt,
          dispatchStatus:   scan.dispatchStatus || ''
        };
      });
    } catch (e) {
      console.error('[getExceptions]', e.message);
      return [];
    }
  });

}); // close cds.service.impl async function

cdsImpl.callAI                   = callAI;
cdsImpl.getDeliveryHead          = getDeliveryHead;
cdsImpl.postDeliveryAction       = postDeliveryAction;
cdsImpl.runVisionAgent           = runVisionAgent;
cdsImpl.approveDispatchODO2      = approveDispatchODO2;
cdsImpl.diagnoseBlockReason      = diagnoseBlockReason;
cdsImpl.generateIncidentReport   = generateIncidentReport;
cdsImpl.findAlternativeHUs       = findAlternativeHUs;
cdsImpl.generateRepackSuggestion = generateRepackSuggestion;
cdsImpl.fetchHUs                 = fetchHUs;

module.exports = cdsImpl;
