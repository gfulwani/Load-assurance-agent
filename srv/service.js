const cds = require('@sap/cds');

// ── Deployment config ─────────────────────────────────────────────────────────
const AI_DEPLOYMENT_ID = 'd7c6d5586db36270';
const AI_RESOURCE_GROUP = 'default';

// ── Mock fallback data ────────────────────────────────────────────────────────
const MOCK_HUS = [
    { ID: 'hu-001-uuid-0000-0000-000000000001', huID: 'HU-EWM-001', outboundDelivery: 'OD-2024-00123', expectedWeight: 245.500, actualWeight: 247.200, status: 'Passed', severity: 'Low', issueDescription: null, validationConfidence: 98.50 },
    { ID: 'hu-002-uuid-0000-0000-000000000002', huID: 'HU-EWM-002', outboundDelivery: 'OD-2024-00124', expectedWeight: 180.000, actualWeight: 162.300, status: 'Failed', severity: 'Critical', issueDescription: 'Actual weight deviates by 9.8% from expected — exceeds 5% threshold. Possible missing items or wrong product loaded.', validationConfidence: 95.10 },
    { ID: 'hu-003-uuid-0000-0000-000000000003', huID: 'HU-EWM-003', outboundDelivery: 'OD-2024-00124', expectedWeight: 320.750, actualWeight: 333.900, status: 'Review', severity: 'High', issueDescription: 'Weight variance of 4.1% is within threshold but label scan returned DAMAGED status. Manual review required.', validationConfidence: 72.30 },
    { ID: 'hu-004-uuid-0000-0000-000000000004', huID: 'HU-EWM-004', outboundDelivery: 'OD-2024-00125', expectedWeight: 95.000, actualWeight: 94.800, status: 'Passed', severity: 'Low', issueDescription: null, validationConfidence: 99.20 },
    { ID: 'hu-005-uuid-0000-0000-000000000005', huID: 'HU-EWM-005', outboundDelivery: 'OD-2024-00126', expectedWeight: 410.000, actualWeight: 388.500, status: 'Failed', severity: 'High', issueDescription: 'Weight short by 21.5 kg (5.2% deviation). Stacking configuration non-compliant — top-heavy arrangement detected.', validationConfidence: 88.75 }
];

const MOCK_VRS = [
    { ID: 'vr-001-uuid-0000-0000-000000000001', hu_ID: 'hu-001-uuid-0000-0000-000000000001', labelStatus: 'OK', stackingCompliance: true, weightDelta: 1.700, aiInsight: 'Weight variance within acceptable range. All labels scanned successfully. No anomalies detected.', rootCause: null, recommendedAction: 'Approve for dispatch.' },
    { ID: 'vr-002-uuid-0000-0000-000000000002', hu_ID: 'hu-002-uuid-0000-0000-000000000002', labelStatus: 'OK', stackingCompliance: true, weightDelta: -17.700, aiInsight: 'Significant underweight detected. AI model confidence 95%. Pattern matches prior incidents of short-pick from bin WH01-B12.', rootCause: 'Short-pick likely from storage bin WH01-B12. Two SKUs with similar packaging may have been confused.', recommendedAction: 'Return HU to pick station. Verify bin WH01-B12 inventory. Re-pick missing items before re-sealing.' },
    { ID: 'vr-003-uuid-0000-0000-000000000003', hu_ID: 'hu-003-uuid-0000-0000-000000000003', labelStatus: 'Damaged', stackingCompliance: true, weightDelta: 13.150, aiInsight: 'Damaged label detected on side panel. Weight overage may indicate substituted item. Low confidence recommendation due to label ambiguity.', rootCause: 'Label damaged — possibly during automated palletizing. Weight overage could indicate product substitution or mislabeled SKU.', recommendedAction: 'Manual label inspection required. Cross-check HU contents against delivery note OD-2024-00124 before dispatch.' },
    { ID: 'vr-004-uuid-0000-0000-000000000004', hu_ID: 'hu-004-uuid-0000-0000-000000000004', labelStatus: 'OK', stackingCompliance: true, weightDelta: -0.200, aiInsight: 'All checks passed. Weight delta negligible. Label integrity confirmed.', rootCause: null, recommendedAction: 'Approve for dispatch.' },
    { ID: 'vr-005-uuid-0000-0000-000000000005', hu_ID: 'hu-005-uuid-0000-0000-000000000005', labelStatus: 'OK', stackingCompliance: false, weightDelta: -21.500, aiInsight: 'Dual failure: underweight and stacking non-compliance. Top-heavy load detected by sensor array. Risk of transit damage or warehouse accident.', rootCause: 'Automated stacker placed heavy cartons on top layer. Short-pick from line item 3 accounts for weight deficit.', recommendedAction: 'Do NOT dispatch. Restack HU per EWM stacking rules. Re-pick missing 21.5 kg before re-validation.' }
];

// ── Destination / EWM fetch ───────────────────────────────────────────────────
const DESTINATION = 'M20CLNT100';
// OData V4 — SAP API Business Hub: api_handlingunit
const HU_ODATA_ENDPOINT = '/sap/opu/odata4/sap/api_handlingunit/srvd_a2x/sap/handlingunit/0001/HandlingUnit';

async function fetchFromDestination(warehouse) {
    try {
        const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
        const path = `${HU_ODATA_ENDPOINT}?$top=50`;
        console.log(`[EWM] Connecting to destination '${DESTINATION}'`);
        console.log(`[EWM] Calling: ${path}`);
        const response = await executeHttpRequest(
            { destinationName: DESTINATION },
            {
                method: 'GET',
                url: path,
                headers: {
                    'sap-client': '100',
                    'Accept': 'application/json'
                }
            }
        );
        console.log(`[EWM] HTTP status: ${response.status}`);
        // OData V4 returns { value: [...] }
        const items = response.data?.value || [];
        if (!items.length) { console.log('[EWM] No data — falling back to mock'); return null; }
        console.log(`[EWM] Live HUs received: ${items.length}`);
        return items.map((hu, i) => ({
            ID:                   hu.HandlingUnitExternalID || hu.HandlingUnit || `hu-live-${i}`,
            huID:                 hu.HandlingUnitExternalID || hu.HandlingUnit || `HU-LIVE-${i}`,
            outboundDelivery:     hu.GoodsMovementRefDocNumber || hu.DeliveryDocument || '',
            expectedWeight:       parseFloat(hu.HandlingUnitGrossWeight || hu.GrossWeight || 0),
            actualWeight:         parseFloat(hu.HandlingUnitActualGrossWeight || hu.HandlingUnitGrossWeight || hu.GrossWeight || 0),
            status:               deriveStatus(hu),
            severity:             deriveSeverity(hu),
            issueDescription:     `Type: ${hu.HandlingUnitType || 'N/A'} | Material: ${hu.ProductionOrProcessOrder || 'N/A'}`,
            validationConfidence: 85.0
        }));
    } catch (err) {
        console.error(`[EWM] Fetch failed: ${err.message} — using mock data`);
        return null;
    }
}

function deriveStatus(hu) {
    const s = (hu.HandlingUnitStatus || hu.HUStatus || '').toUpperCase();
    if (s.includes('ERROR') || s.includes('ISSUE'))    return 'Failed';
    if (s.includes('PENDING') || s.includes('REVIEW')) return 'Review';
    return 'Passed';
}

function deriveSeverity(hu) {
    const s = (hu.HandlingUnitStatus || hu.HUStatus || '').toUpperCase();
    if (s.includes('ERROR') || s.includes('CRITICAL')) return 'High';
    if (s.includes('WARNING') || s.includes('REVIEW')) return 'Medium';
    return 'Low';
}

// ── AI Core credentials ───────────────────────────────────────────────────────
function getAICoreCredentials() {
    try {
        const vcap = process.env.VCAP_SERVICES ? JSON.parse(process.env.VCAP_SERVICES) : {};
        console.log('[AI] VCAP service keys:', Object.keys(vcap).join(', ') || 'none');
        const creds = vcap['aicore']?.[0]?.credentials
                   || vcap['AI Core']?.[0]?.credentials
                   || vcap['ai-core']?.[0]?.credentials
                   || null;
        if (!creds) console.warn('[AI] AI Core not found in VCAP_SERVICES');
        else        console.log('[AI] AI Core bound — url:', creds.serviceurls?.AI_API_URL || creds.url || 'unknown');
        return creds;
    } catch (err) {
        console.error('[AI] Failed to parse VCAP_SERVICES:', err.message);
        return null;
    }
}

// ── Token cache ───────────────────────────────────────────────────────────────
let _aiToken = null;
let _aiTokenExpiry = 0;

async function getAIToken(creds) {
    if (_aiToken && Date.now() < _aiTokenExpiry) {
        console.log('[AI] Using cached token');
        return _aiToken;
    }
    const tokenUrl     = `${creds.url}/oauth/token`;
    const clientId     = creds.clientid;
    const clientSecret = creds.clientsecret;
    console.log(`[AI] Fetching token from: ${tokenUrl}`);
    const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
    });
    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`AI Core token fetch failed (${resp.status}): ${err}`);
    }
    const data = await resp.json();
    _aiToken       = data.access_token;
    _aiTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    console.log('[AI] Token acquired, expires in', data.expires_in, 'seconds');
    return _aiToken;
}

// ── Core AI call — Claude via /invoke ────────────────────────────────────────
async function callAI(systemPrompt, userPrompt) {
    const creds = getAICoreCredentials();
    if (!creds) { console.warn('[AI] No credentials — skipping'); return null; }
    try {
        const token   = await getAIToken(creds);
        const baseUrl = creds.serviceurls?.AI_API_URL || creds.url;
        const url     = `${baseUrl}/v2/inference/deployments/${AI_DEPLOYMENT_ID}/invoke`;
        console.log(`[AI] POST ${url}`);
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization':     `Bearer ${token}`,
                'Content-Type':      'application/json',
                'AI-Resource-Group': AI_RESOURCE_GROUP
            },
            body: JSON.stringify({
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: 500,
                messages: [
                    { role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }
                ]
            })
        });
        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`AI Core ${resp.status}: ${errText}`);
        }
        const result  = await resp.json();
        const content = result.content?.[0]?.text || '';
        console.log('[AI] Response OK');
        return content;
    } catch (err) {
        console.error('[AI] Call failed:', err.message);
        return null;
    }
}

// ── HU analysis ──────────────────────────────────────────────────────────────
async function analyzeHU(hu) {
    const system = `You are an SAP EWM Load Assurance AI agent. Analyze handling unit data and respond with JSON only — no markdown, no extra text.
Format: {"aiInsight":"<1-2 sentence analysis>","rootCause":"<root cause or null>","recommendedAction":"<next step>"}`;
    const delta    = hu.actualWeight - hu.expectedWeight;
    const deltaPct = Math.abs(delta) / (hu.expectedWeight || 1) * 100;
    const user = `HU: ${hu.huID}
Delivery: ${hu.outboundDelivery}
Expected Weight: ${hu.expectedWeight} kg
Actual Weight: ${hu.actualWeight} kg
Delta: ${delta.toFixed(3)} kg (${deltaPct.toFixed(2)}%)
Status: ${hu.status} | Severity: ${hu.severity}
${hu.issueDescription ? 'Issue: ' + hu.issueDescription : ''}`;
    const raw = await callAI(system, user);
    if (!raw) return null;
    try {
        const match = raw.match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : { aiInsight: raw, rootCause: null, recommendedAction: 'Manual review' };
    } catch {
        return { aiInsight: raw, rootCause: null, recommendedAction: 'Manual review' };
    }
}

// ── Chat copilot ──────────────────────────────────────────────────────────────
async function chatWithAI(userMessage, context) {
    const system = `You are the Load Assurance Copilot for SAP EWM. You help warehouse supervisors understand handling unit validation issues, weight deviations, and dispatch decisions. Be concise and practical.
Current context: ${context}`;
    return await callAI(system, userMessage);
}

// ── Fallback replies ──────────────────────────────────────────────────────────
function generateFallbackReply(q) {
    const ql = q.toLowerCase();
    if (ql.includes('fail'))     return 'Check weight delta — failures occur when deviation exceeds ±5% of expected weight.';
    if (ql.includes('weight'))   return 'Weight threshold is ±5%. Deviations 2–5% trigger Review; above 5% trigger Failed status.';
    if (ql.includes('stack'))    return 'Stacking compliance checks that heavy items are on lower layers per EWM stacking rules.';
    if (ql.includes('dispatch')) return 'Only HUs with Passed status and no open issues are cleared for dispatch.';
    return 'Please select a Handling Unit from the worklist for detailed AI analysis.';
}

// ── CAP Service ───────────────────────────────────────────────────────────────
module.exports = cds.service.impl(function () {

    this.on('READ', 'HandlingUnits', async (req) => {
        const warehouse = req._.req?.query?.warehouse || '';
        const live = await fetchFromDestination(warehouse);
        return live || MOCK_HUS;
    });

    this.on('READ', 'ValidationResults', () => MOCK_VRS);

    this.on('READ', 'AIRecommendations', () => []);

    this.on('validateHU', async (req) => {
        const { huID } = req.data;
        const allHUs = await fetchFromDestination('') || MOCK_HUS;
        const hu = allHUs.find(h => h.huID === huID);
        if (!hu) return req.error(404, `HandlingUnit '${huID}' not found`);
        const delta    = hu.actualWeight - hu.expectedWeight;
        const deltaPct = Math.abs(delta) / (hu.expectedWeight || 1);
        const passed   = deltaPct <= 0.05;
        const ai = await analyzeHU({ ...hu, status: passed ? 'Passed' : 'Failed' });
        return {
            status:            passed ? 'Passed' : 'Failed',
            weightDelta:       Math.round(delta * 1000) / 1000,
            passed,
            message:           passed
                ? `HU ${huID} passed. Delta: ${delta.toFixed(3)} kg (${(deltaPct*100).toFixed(2)}%).`
                : `HU ${huID} failed. Delta: ${delta.toFixed(3)} kg (${(deltaPct*100).toFixed(2)}%) exceeds 5% threshold.`,
            aiInsight:         ai?.aiInsight         || `Weight variance ${(deltaPct*100).toFixed(2)}%. ${passed ? 'Within threshold.' : 'Exceeds 5% threshold.'}`,
            rootCause:         ai?.rootCause         || null,
            recommendedAction: ai?.recommendedAction || (passed ? 'Approve for dispatch.' : 'Investigate and re-validate.')
        };
    });

    this.on('chat', async (req) => {
        const { message, huContext } = req.data;
        if (!message) return req.error(400, 'message is required');
        const reply = await chatWithAI(message, huContext || 'General warehouse inquiry');
        return {
            reply:     reply || generateFallbackReply(message),
            aiPowered: !!reply
        };
    });
});
