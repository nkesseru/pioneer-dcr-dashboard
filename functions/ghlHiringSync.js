/* ============================================================================
 * ghlHiringSync.js — Phase 2A.2 GHL hiring snapshot writer
 *
 * Pulls Applicant Tracking pipeline opportunities from LeadConnector v2 and
 * writes a daily rollup to office_manager_hiring_snapshots/{YYYY-MM-DD}. The
 * snapshot shape matches the reader in public/manager.js (normalizeHiringSnapshot)
 * so the Hiring Health card flips the "Data Source" pill to "Live GHL"
 * automatically once a snapshot lands.
 *
 * Mapping (from Phase 2A.2 spec):
 *   Applicants 7d        — opportunities created in last 7 days
 *   Applicants 30d       — opportunities created in last 30 days
 *   Interviews Scheduled — currently in "Group Interview" stage
 *   Interviews Completed — currently in any stage past Group Interview
 *                          (1on1, Working Interview, Waiting, Offer,
 *                           Onboarding, Hired) — excludes Yellow/Red/Withdrawn
 *   Working Interviews   — currently in "Working Interview - OnSite"
 *   Hires                — currently in "Hired" with lastStageChangeAt
 *                          inside the last 30 days (falls back to createdAt)
 *   Yellow / Red / Withdrawn are excluded from active funnel health for v1.
 *
 * PII discipline:
 *   The opportunity records carry candidate names + contact IDs. This module
 *   strips them at the API boundary — only structural fields (id, stage id,
 *   created/updated timestamps) survive past fetchOpportunities(). Logs
 *   never carry candidate identifiers.
 *
 * Auth:
 *   Token comes from the GHL_PRIVATE_INTEGRATION_TOKEN secret. Never logged.
 *   When the token is missing the sync skips cleanly (returns
 *   { ok:false, skipped:true, reason:"no_token" }) so a fresh deploy can't
 *   crash a scheduled job before Nick sets the secret.
 * ========================================================================== */

'use strict';

const { logger } = require('firebase-functions');
const admin      = require('firebase-admin');

// ---- Constants --------------------------------------------------------------

const GHL_API_BASE     = 'https://services.leadconnectorhq.com';
// LeadConnector v2 requires a "Version" header. 2021-07-28 is the v2 baseline.
const GHL_API_VERSION  = '2021-07-28';

const PIPELINE_NAME       = 'Applicant Tracking';
const PIPELINE_ID_DEFAULT = 'FChZ71z7rhA4pvhI95aS';
const LOCATION_ID_DEFAULT = 'LvZR8MSKZz7ubTwIP33H';

// Stage names — exact strings from GHL Applicant Tracking pipeline.
const STAGE_NEW_APPLICANT     = 'New Applicant';
const STAGE_YELLOW            = 'Yellow';
const STAGE_GROUP_INTERVIEW   = 'Group Interview';
const STAGE_ONE_ON_ONE        = '1 on 1 Interview - Starbucks';
const STAGE_WORKING_INTERVIEW = 'Working Interview - OnSite';
const STAGE_WAITING_DECISION  = 'Waiting for Final Decision';
const STAGE_OFFER             = 'Offer Stage - Pre Onboarding';
const STAGE_ONBOARDING        = 'Onboarding';
const STAGE_HIRED             = 'Hired';
const STAGE_RED               = 'Red';
const STAGE_WITHDRAWN         = 'Withdrawn';

// Stages past Group Interview (spec: "stage index >= 4"). Used to count
// Interviews Completed. Hired is included because someone hired completed
// their interviews; Yellow/Red/Withdrawn are excluded entirely from the
// active funnel.
const COMPLETED_INTERVIEW_STAGES = new Set([
  STAGE_ONE_ON_ONE,
  STAGE_WORKING_INTERVIEW,
  STAGE_WAITING_DECISION,
  STAGE_OFFER,
  STAGE_ONBOARDING,
  STAGE_HIRED
]);

const EXCLUDED_STAGES = new Set([STAGE_YELLOW, STAGE_RED, STAGE_WITHDRAWN]);

const PAGE_LIMIT       = 100;   // GHL caps page size at 100
const PAGE_HARD_STOP   = 50;    // Safety: refuse to fan out past 5000 opps

// ---- Helpers ----------------------------------------------------------------

function pacificYMD(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function parseMs(value) {
  if (!value) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

async function ghlFetch(token, path, params) {
  const url = new URL(GHL_API_BASE + path);
  if (params) {
    Object.keys(params).forEach(function (k) {
      if (params[k] != null) url.searchParams.set(k, String(params[k]));
    });
  }
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Version':       GHL_API_VERSION,
      'Accept':        'application/json'
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(function () { return ''; });
    // Truncate so a long HTML error page doesn't dominate Cloud Logging.
    const snippet = body.slice(0, 200).replace(/\s+/g, ' ');
    const err = new Error('GHL ' + path + ' ' + res.status + ': ' + snippet);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---- Pipeline + stage resolution -------------------------------------------

async function fetchPipelineStages(token, locationId, pipelineId) {
  const json = await ghlFetch(token, '/opportunities/pipelines', {
    locationId: locationId
  });
  const pipelines = (json && (json.pipelines || json.data)) || [];
  // Match by id first (the spec gave us one); fall back to exact name match
  // in case the id ever rotates.
  let found = pipelines.find(function (p) { return String(p.id) === String(pipelineId); });
  if (!found) {
    found = pipelines.find(function (p) {
      return p && typeof p.name === 'string' && p.name.trim() === PIPELINE_NAME;
    });
  }
  if (!found) {
    throw new Error('GHL pipeline not found: id=' + pipelineId + ' name="' + PIPELINE_NAME + '"');
  }
  const rawStages = Array.isArray(found.stages) ? found.stages : [];
  const stages = rawStages.map(function (s, idx) {
    return {
      id:       s.id,
      name:     (s.name || '').trim(),
      position: typeof s.position === 'number' ? s.position : idx
    };
  });
  return { pipelineId: found.id, pipelineName: found.name, stages: stages };
}

// ---- Opportunity pagination -------------------------------------------------

async function fetchOpportunities(token, locationId, pipelineId) {
  const all = [];
  let page  = 1;
  while (page <= PAGE_HARD_STOP) {
    const json = await ghlFetch(token, '/opportunities/search', {
      location_id: locationId,
      pipeline_id: pipelineId,
      limit:       PAGE_LIMIT,
      page:        page
    });
    const items = (json && (json.opportunities || json.data)) || [];
    // Drop PII at the boundary — keep only the fields metrics need.
    items.forEach(function (it) {
      all.push({
        id:                String(it.id || ''),
        pipelineStageId:   it.pipelineStageId || it.stageId || null,
        status:            it.status || null,
        createdAt:         it.createdAt || it.dateAdded || it.dateCreated || null,
        updatedAt:         it.updatedAt || it.dateUpdated || null,
        lastStageChangeAt: it.lastStageChangeAt || it.lastStatusChangeAt || null
      });
    });
    if (items.length < PAGE_LIMIT) break;
    page++;
  }
  if (page > PAGE_HARD_STOP) {
    logger.warn('[ghlSync] pagination hard-stop hit', { page: page, fetched: all.length });
  }
  return all;
}

// ---- Metrics ----------------------------------------------------------------

function calculateMetrics(opportunities, stages, now) {
  const nowMs          = now.getTime();
  const sevenDaysAgo   = nowMs - 7  * 86400000;
  const thirtyDaysAgo  = nowMs - 30 * 86400000;

  const stageById = new Map();
  stages.forEach(function (s) { stageById.set(s.id, s); });

  // Initialize breakdown so empty stages still report zero (easier to debug).
  const breakdown = {};
  stages.forEach(function (s) { breakdown[s.name] = 0; });
  breakdown['(unknown)'] = 0;

  let applicants7d        = 0;
  let applicants30d       = 0;
  let interviewsScheduled = 0;
  let interviewsCompleted = 0;
  let workingInterviews   = 0;
  let hires               = 0;

  opportunities.forEach(function (opp) {
    const stage     = stageById.get(opp.pipelineStageId);
    const stageName = stage ? stage.name : '(unknown)';
    breakdown[stageName] = (breakdown[stageName] || 0) + 1;

    if (EXCLUDED_STAGES.has(stageName)) return;

    const createdMs     = parseMs(opp.createdAt);
    const stageChangeMs = parseMs(opp.lastStageChangeAt);

    if (Number.isFinite(createdMs)) {
      if (createdMs >= sevenDaysAgo)  applicants7d++;
      if (createdMs >= thirtyDaysAgo) applicants30d++;
    }

    if (stageName === STAGE_GROUP_INTERVIEW)   interviewsScheduled++;
    if (COMPLETED_INTERVIEW_STAGES.has(stageName)) interviewsCompleted++;
    if (stageName === STAGE_WORKING_INTERVIEW) workingInterviews++;

    if (stageName === STAGE_HIRED) {
      // Prefer the stage-change timestamp so "hires in the last 30 days"
      // counts when the move happened, not when the contact was created.
      const effectiveMs = Number.isFinite(stageChangeMs) ? stageChangeMs : createdMs;
      if (Number.isFinite(effectiveMs) && effectiveMs >= thirtyDaysAgo) {
        hires++;
      }
    }
  });

  return {
    applicants7d:        applicants7d,
    applicants30d:       applicants30d,
    interviewsScheduled: interviewsScheduled,
    interviewsCompleted: interviewsCompleted,
    workingInterviews:   workingInterviews,
    hires:               hires,
    breakdown:           breakdown
  };
}

// ---- Top-level sync ---------------------------------------------------------

async function runSync(opts) {
  opts = opts || {};
  const token       = opts.token;
  const db          = opts.db || admin.firestore();
  const locationId  = opts.locationId || LOCATION_ID_DEFAULT;
  const pipelineId  = opts.pipelineId || PIPELINE_ID_DEFAULT;
  const now         = opts.now || new Date();
  const invokedBy   = opts.invokedBy || 'unknown';

  if (!token) {
    logger.warn('[ghlSync] GHL_PRIVATE_INTEGRATION_TOKEN not set — skipping sync', {
      invoked_by: invokedBy
    });
    return { ok: false, skipped: true, reason: 'no_token' };
  }

  const startMs = Date.now();

  const resolved = await fetchPipelineStages(token, locationId, pipelineId);
  logger.info('[ghlSync] pipeline resolved', {
    pipeline_id:   resolved.pipelineId,
    pipeline_name: resolved.pipelineName,
    stage_count:   resolved.stages.length
  });

  const opportunities = await fetchOpportunities(token, locationId, resolved.pipelineId);
  logger.info('[ghlSync] opportunities fetched', { count: opportunities.length });

  const metrics = calculateMetrics(opportunities, resolved.stages, now);

  const today       = pacificYMD(now);
  const periodEnd   = today;
  // 7-day rolling window is the headline; period_start matches it so the
  // existing reader has a sane label.
  const periodStart = pacificYMD(new Date(now.getTime() - 6 * 86400000));

  const snapshot = {
    snapshot_date:        today,
    period_start:         periodStart,
    period_end:           periodEnd,
    applicants:           metrics.applicants30d,
    applicants_7d:        metrics.applicants7d,
    applicants_30d:       metrics.applicants30d,
    interviews_scheduled: metrics.interviewsScheduled,
    interviews_completed: metrics.interviewsCompleted,
    working_interviews:   metrics.workingInterviews,
    hires:                metrics.hires,
    source:               'ghl',
    updated_at:           admin.firestore.FieldValue.serverTimestamp(),
    stage_breakdown:      metrics.breakdown,
    raw_counts: {
      total_opportunities: opportunities.length,
      pipeline_id:         resolved.pipelineId,
      location_id:         locationId,
      invoked_by:          invokedBy,
      duration_ms:         Date.now() - startMs
    }
  };

  await db.collection('office_manager_hiring_snapshots')
    .doc(today)
    .set(snapshot, { merge: true });

  logger.info('[ghlSync] snapshot written', {
    snapshot_date:        today,
    applicants_7d:        metrics.applicants7d,
    applicants_30d:       metrics.applicants30d,
    interviews_scheduled: metrics.interviewsScheduled,
    interviews_completed: metrics.interviewsCompleted,
    working_interviews:   metrics.workingInterviews,
    hires:                metrics.hires,
    invoked_by:           invokedBy,
    duration_ms:          Date.now() - startMs
  });

  return {
    ok:                    true,
    snapshot_date:         today,
    counts: {
      applicants_7d:        metrics.applicants7d,
      applicants_30d:       metrics.applicants30d,
      interviews_scheduled: metrics.interviewsScheduled,
      interviews_completed: metrics.interviewsCompleted,
      working_interviews:   metrics.workingInterviews,
      hires:                metrics.hires
    },
    stages_resolved:        resolved.stages.length,
    opportunities_fetched:  opportunities.length,
    duration_ms:            Date.now() - startMs
  };
}

module.exports = {
  runSync:              runSync,
  // Exposed for the local test script + unit tests.
  fetchPipelineStages:  fetchPipelineStages,
  fetchOpportunities:   fetchOpportunities,
  calculateMetrics:     calculateMetrics,
  pacificYMD:           pacificYMD,
  PIPELINE_NAME:        PIPELINE_NAME,
  PIPELINE_ID_DEFAULT:  PIPELINE_ID_DEFAULT,
  LOCATION_ID_DEFAULT:  LOCATION_ID_DEFAULT
};
