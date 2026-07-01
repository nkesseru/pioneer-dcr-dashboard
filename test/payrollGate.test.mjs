// Payroll Gate V2 — pure-JS tests for the labor-integrity gate.
//
// Three functions are gated by the same principle (post-2026-07-01):
//   1. functions/index.js :: payrollIsBlocker(s)
//      — server-side; called by exportPayrollCsvV1 + lockPayrollPeriodV1
//   2. public/admin/tab-labor-review.js :: approveGatePasses(s)
//      — client-side; hides the Approve button per row
//   3. public/admin/tab-payroll.js :: totalBlockers (workflow + banner)
//      — client-side; gates the Payroll Workflow bar + PAYROLL READY banner
//
// All three are pure and this file mirrors the prod source EXACTLY.
// Any divergence is a bug — the copies below should be diff'd against
// the prod source when either is changed.
//
// Run: node --test test/payrollGate.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ============================================================
// MIRROR of functions/index.js :: payrollIsBlocker (Payroll Gate V2)
// ============================================================
function payrollIsBlocker(s) {
  if (s.admin_removed === true) return null;
  if (s.is_test === true || s.exclude_from_payroll_export === true) return null;
  if (s.needs_review === true) return "needs_review";
  if (s.status === "active" || s.status === "paused") return "active";
  if (s.status === "completed" && !s.clock_out_at) return "missing_clockout";
  return null;
}

// ============================================================
// MIRROR of public/admin/tab-labor-review.js :: approveGatePasses (V2)
// ============================================================
function payrollState(s) { return (s && s.payroll_state) || "pending_review"; }
function approveGatePasses(s) {
  if (!s) return false;
  const state = payrollState(s);
  if (state !== "pending_review" && state !== "reviewed") return false;
  if (s.admin_removed === true) return false;
  if (s.needs_review === true) return false;
  if (s.status !== "completed") return false;
  if (typeof s.work_minutes !== "number" || s.work_minutes <= 0) return false;
  const isCleaning = !s.labor_type || s.labor_type === "cleaning";
  if (isCleaning) {
    if (!s.assignment_id) return false;
  }
  return true;
}

// ============================================================
// Fixtures
// ============================================================
function cleanCompletedSession(overrides) {
  return Object.assign({
    status:         "completed",
    clock_out_at:   "2026-06-17T05:00:00Z",
    work_minutes:   120,
    payroll_state:  "pending_review",
    assignment_id:  "sa_deputy__6019",
    labor_type:     "cleaning",
    admin_removed:  false,
    needs_review:   false,
    is_test:        false
  }, overrides || {});
}

// ============================================================
// payrollIsBlocker — Payroll Gate V2 behavior
// ============================================================
describe("payrollIsBlocker — Payroll Gate V2 (DCR is recovery, not blocker)", () => {
  test("clean completed session returns null (no blocker)", () => {
    const s = cleanCompletedSession();
    assert.equal(payrollIsBlocker(s), null);
  });

  test("session with DCR pending (dcr_status absent) is NOT a blocker under V2", () => {
    const s = cleanCompletedSession({ dcr_status: undefined, dcr_id: null });
    assert.equal(payrollIsBlocker(s), null, "V2 must NOT flag DCR-pending as blocker");
  });

  test("session with status=dcr_pending is NOT a blocker under V2", () => {
    const s = cleanCompletedSession({ status: "dcr_pending" });
    assert.equal(payrollIsBlocker(s), null, "status=dcr_pending must NOT block payroll under V2");
  });

  test("session with dcr_status='waived' is NOT a blocker (recovery-work, still labor-clean)", () => {
    const s = cleanCompletedSession({ dcr_status: "waived" });
    assert.equal(payrollIsBlocker(s), null);
  });

  test("session with dcr_status='submitted' is NOT a blocker (no change from prior)", () => {
    const s = cleanCompletedSession({ dcr_status: "submitted", dcr_id: "dcr_abc" });
    assert.equal(payrollIsBlocker(s), null);
  });

  // ----- Real labor blockers still enforced -----

  test("needs_review=true blocks with reason 'needs_review'", () => {
    const s = cleanCompletedSession({ needs_review: true });
    assert.equal(payrollIsBlocker(s), "needs_review");
  });

  test("status=active blocks with reason 'active'", () => {
    const s = cleanCompletedSession({ status: "active", clock_out_at: null });
    assert.equal(payrollIsBlocker(s), "active");
  });

  test("status=paused blocks with reason 'active'", () => {
    const s = cleanCompletedSession({ status: "paused", clock_out_at: null });
    assert.equal(payrollIsBlocker(s), "active");
  });

  test("completed + no clock_out_at blocks with reason 'missing_clockout'", () => {
    const s = cleanCompletedSession({ clock_out_at: null });
    assert.equal(payrollIsBlocker(s), "missing_clockout");
  });

  test("admin_removed=true never blocks (session is archived, ignored)", () => {
    const s = cleanCompletedSession({
      admin_removed: true, needs_review: true, status: "active"
    });
    assert.equal(payrollIsBlocker(s), null);
  });

  test("is_test=true never blocks", () => {
    const s = cleanCompletedSession({ is_test: true, needs_review: true });
    assert.equal(payrollIsBlocker(s), null);
  });

  test("exclude_from_payroll_export=true never blocks", () => {
    const s = cleanCompletedSession({ exclude_from_payroll_export: true, needs_review: true });
    assert.equal(payrollIsBlocker(s), null);
  });

  // ----- Blocker priority order -----

  test("needs_review takes priority over active", () => {
    const s = cleanCompletedSession({ needs_review: true, status: "active" });
    assert.equal(payrollIsBlocker(s), "needs_review");
  });

  test("active takes priority over missing_clockout", () => {
    const s = cleanCompletedSession({ status: "active", clock_out_at: null });
    assert.equal(payrollIsBlocker(s), "active");
  });

  test("labor_type=inspection (non-cleaning) — completed session is not a blocker", () => {
    // V1 previously had the labor_type carve-out for DCR only. Now that
    // DCR isn't checked at all, cleaning vs inspection doesn't matter
    // for this helper — both pass the labor gate identically.
    const s = cleanCompletedSession({ labor_type: "inspection", assignment_id: null });
    assert.equal(payrollIsBlocker(s), null);
  });
});

// ============================================================
// approveGatePasses — Payroll Gate V2 client-side (Approve button)
// ============================================================
describe("approveGatePasses — Payroll Gate V2 (client Approve button)", () => {
  test("clean pending_review session with all labor signals green PASSES", () => {
    const s = cleanCompletedSession();
    assert.equal(approveGatePasses(s), true);
  });

  test("session with DCR pending (no dcr_status, no dcr_id) NOW PASSES under V2", () => {
    const s = cleanCompletedSession({ dcr_status: undefined, dcr_id: null });
    assert.equal(approveGatePasses(s), true,
      "V2 must allow approve when only DCR is missing but labor is clean");
  });

  test("session with dcr_status='waived' PASSES (unchanged)", () => {
    const s = cleanCompletedSession({ dcr_status: "waived" });
    assert.equal(approveGatePasses(s), true);
  });

  test("session with dcr_status='submitted' PASSES (unchanged)", () => {
    const s = cleanCompletedSession({ dcr_status: "submitted", dcr_id: "dcr_abc" });
    assert.equal(approveGatePasses(s), true);
  });

  test("session with payroll_state='reviewed' also passes (both entry states OK)", () => {
    const s = cleanCompletedSession({ payroll_state: "reviewed" });
    assert.equal(approveGatePasses(s), true);
  });

  test("session with payroll_state='approved_for_payroll' does NOT pass (already approved)", () => {
    const s = cleanCompletedSession({ payroll_state: "approved_for_payroll" });
    assert.equal(approveGatePasses(s), false);
  });

  test("session with payroll_state='exported' does NOT pass (locked)", () => {
    const s = cleanCompletedSession({ payroll_state: "exported" });
    assert.equal(approveGatePasses(s), false);
  });

  test("admin_removed=true does NOT pass", () => {
    const s = cleanCompletedSession({ admin_removed: true });
    assert.equal(approveGatePasses(s), false);
  });

  test("needs_review=true does NOT pass", () => {
    const s = cleanCompletedSession({ needs_review: true });
    assert.equal(approveGatePasses(s), false);
  });

  test("status='active' does NOT pass", () => {
    const s = cleanCompletedSession({ status: "active", clock_out_at: null });
    assert.equal(approveGatePasses(s), false);
  });

  test("status='paused' does NOT pass", () => {
    const s = cleanCompletedSession({ status: "paused", clock_out_at: null });
    assert.equal(approveGatePasses(s), false);
  });

  test("status='dcr_pending' does NOT pass (still not 'completed')", () => {
    // Note: status="dcr_pending" is a V1 status the tech-clock code used
    // to set. It's not "completed" so approveGatePasses still rejects it.
    // Payroll blocker check (server) does allow it, but the row must first
    // transition to 'completed' via admin OR normal flow. Only labor-clean
    // completed sessions get approved.
    const s = cleanCompletedSession({ status: "dcr_pending" });
    assert.equal(approveGatePasses(s), false);
  });

  test("work_minutes=0 does NOT pass (labor integrity gap)", () => {
    const s = cleanCompletedSession({ work_minutes: 0 });
    assert.equal(approveGatePasses(s), false);
  });

  test("work_minutes missing does NOT pass", () => {
    const s = cleanCompletedSession({ work_minutes: undefined });
    assert.equal(approveGatePasses(s), false);
  });

  test("cleaning labor without assignment_id does NOT pass (Deputy linkage integrity)", () => {
    const s = cleanCompletedSession({ assignment_id: null });
    assert.equal(approveGatePasses(s), false);
  });

  test("non-cleaning labor (inspection) without assignment_id PASSES", () => {
    const s = cleanCompletedSession({ labor_type: "inspection", assignment_id: null });
    assert.equal(approveGatePasses(s), true);
  });

  test("non-cleaning labor (supply_station) without assignment_id PASSES", () => {
    const s = cleanCompletedSession({ labor_type: "supply_station", assignment_id: null });
    assert.equal(approveGatePasses(s), true);
  });

  test("null session does NOT pass", () => {
    assert.equal(approveGatePasses(null), false);
  });

  test("undefined session does NOT pass", () => {
    assert.equal(approveGatePasses(undefined), false);
  });
});

// ============================================================
// End-to-end regression scenarios (the 4 payroll blockers from
// this morning's investigation)
// ============================================================
describe("Real-world regression — the 4 morning payroll blockers", () => {
  // These four sessions match the ones surfaced in the 2026-07-01
  // forensic investigation. Under Payroll Gate V1 all four were BLOCKED
  // on "dcr not submitted". Under V2 they should all PASS the labor gate
  // and be approvable / exportable (though the human decision — approve
  // vs recover — remains with Kirby).

  test("Bonnie @ Baker 2026-06-17 (231min, no DCR) — labor clean, V2 approvable", () => {
    const s = {
      status: "completed",
      clock_in_at:  "2026-06-17T23:59:07Z",
      clock_out_at: "2026-06-18T03:51:03Z",
      work_minutes: 231,
      payroll_state: undefined,   // defaults pending_review
      assignment_id: "sa_deputy__6019",
      labor_type:   "cleaning",
      needs_review: false,
      admin_removed: false
      // no dcr_status, no dcr_id — this was the blocker
    };
    assert.equal(payrollIsBlocker(s), null, "V2 must not block on DCR");
    assert.equal(approveGatePasses(s), true, "V2 must allow approve");
  });

  test("Nicholas H @ MacDonald 2026-06-17 (8min, aborted, no DCR) — labor clean, V2 approvable", () => {
    const s = {
      status: "completed",
      clock_in_at:  "2026-06-18T01:15:43Z",
      clock_out_at: "2026-06-18T01:24:12Z",
      work_minutes: 8,
      payroll_state: undefined,
      assignment_id: "sa_deputy__6122",
      labor_type:   "cleaning",
      needs_review: false,
      admin_removed: false
    };
    assert.equal(payrollIsBlocker(s), null);
    assert.equal(approveGatePasses(s), true);
  });

  test("Gene F @ Vehr's 2026-06-24 (64min, orphaned DCR) — labor clean, V2 approvable", () => {
    const s = {
      status: "completed",
      clock_in_at:  "2026-06-25T00:13:21Z",
      clock_out_at: "2026-06-25T01:17:41Z",
      work_minutes: 64,
      payroll_state: undefined,
      assignment_id: "sa_deputy__5996",
      labor_type:   "cleaning",
      needs_review: false,
      admin_removed: false
    };
    assert.equal(payrollIsBlocker(s), null);
    assert.equal(approveGatePasses(s), true);
  });

  test("Bonnie @ Baker 2026-06-21 (236min, no DCR) — labor clean, V2 approvable", () => {
    const s = {
      status: "completed",
      clock_in_at:  "2026-06-21T20:28:22Z",
      clock_out_at: "2026-06-22T00:25:05Z",
      work_minutes: 236,
      payroll_state: undefined,
      assignment_id: "sa_deputy__6027",
      labor_type:   "cleaning",
      needs_review: false,
      admin_removed: false
    };
    assert.equal(payrollIsBlocker(s), null);
    assert.equal(approveGatePasses(s), true);
  });
});

// ============================================================
// MIRROR of public/admin/tab-payroll.js :: totalBlockers formula
// used by both computeWorkflowState() (Payroll Workflow bar) AND
// renderBanner() (PAYROLL READY / BLOCKED banner).
// ============================================================
//
// blockers shape from computeBlockers():
//   { needs_review, active, dcr_pending, missing_clockout }
//
// V2 formula intentionally excludes dcr_pending — DCR is recovery
// work, not a payroll gate. The dcr_pending field is still counted
// for the per-employee recovery view + tile display, but is not
// summed into totalBlockers.
function totalBlockersV2(blockers) {
  return blockers.needs_review + blockers.active + blockers.missing_clockout;
}

describe("totalBlockers V2 — Payroll Workflow + Banner gate", () => {
  test("all-zeros blockers → totalBlockers = 0 (banner shows READY)", () => {
    const b = { needs_review: 0, active: 0, dcr_pending: 0, missing_clockout: 0 };
    assert.equal(totalBlockersV2(b), 0);
  });

  test("4 dcr_pending only → totalBlockers = 0 (this morning's scenario)", () => {
    const b = { needs_review: 0, active: 0, dcr_pending: 4, missing_clockout: 0 };
    assert.equal(totalBlockersV2(b), 0,
      "4 DCR-pending sessions must NOT trigger BLOCKED banner under V2");
  });

  test("1 needs_review + 4 dcr_pending → totalBlockers = 1 (real blocker still fires)", () => {
    const b = { needs_review: 1, active: 0, dcr_pending: 4, missing_clockout: 0 };
    assert.equal(totalBlockersV2(b), 1);
  });

  test("2 active + 3 dcr_pending → totalBlockers = 2", () => {
    const b = { needs_review: 0, active: 2, dcr_pending: 3, missing_clockout: 0 };
    assert.equal(totalBlockersV2(b), 2);
  });

  test("1 missing_clockout + 10 dcr_pending → totalBlockers = 1", () => {
    const b = { needs_review: 0, active: 0, dcr_pending: 10, missing_clockout: 1 };
    assert.equal(totalBlockersV2(b), 1);
  });

  test("all four buckets populated → sums only 3 (dcr_pending excluded)", () => {
    const b = { needs_review: 2, active: 1, dcr_pending: 5, missing_clockout: 3 };
    assert.equal(totalBlockersV2(b), 6, "2 + 1 + 3 = 6; dcr_pending's 5 is not counted");
  });

  test("50 dcr_pending sessions alone still returns 0 (recovery workqueue only)", () => {
    const b = { needs_review: 0, active: 0, dcr_pending: 50, missing_clockout: 0 };
    assert.equal(totalBlockersV2(b), 0);
  });
});

// ============================================================
// Convergence: server-side blocker counts + client-side
// totalBlockers formula should always agree on whether the
// period is BLOCKED or READY.
// ============================================================
describe("Cross-check: server payrollIsBlocker + client totalBlockers agree", () => {
  // Simulate a period as sessions[] fed through server-side per-session
  // classification. Sum the same buckets. Assert they equal what the
  // client-side totalBlockers formula would compute from the same shape.

  function serverSideBlockerCounts(sessions) {
    const b = { needs_review: 0, active: 0, dcr_pending: 0, missing_clockout: 0 };
    sessions.forEach(s => {
      const key = payrollIsBlocker(s);
      if (key === "needs_review")     b.needs_review     += 1;
      if (key === "active")           b.active           += 1;
      if (key === "dcr_pending")      b.dcr_pending      += 1;
      if (key === "missing_clockout") b.missing_clockout += 1;
    });
    return b;
  }

  test("4 DCR-pending-only sessions: server counts = client counts = 0 blocked", () => {
    const sessions = [
      cleanCompletedSession({ dcr_status: undefined }),
      cleanCompletedSession({ dcr_status: undefined, assignment_id: "sa_deputy_2" }),
      cleanCompletedSession({ dcr_status: undefined, assignment_id: "sa_deputy_3" }),
      cleanCompletedSession({ dcr_status: undefined, assignment_id: "sa_deputy_4" })
    ];
    const serverB = serverSideBlockerCounts(sessions);
    assert.equal(serverB.needs_review,     0);
    assert.equal(serverB.active,           0);
    assert.equal(serverB.dcr_pending,      0, "V2 server no longer classifies DCR-pending");
    assert.equal(serverB.missing_clockout, 0);
    assert.equal(totalBlockersV2(serverB), 0,
      "Client formula on server counts must agree: 0 blockers");
  });

  test("mixed period with real blockers: server + client agree on total", () => {
    const sessions = [
      cleanCompletedSession(),                                            // clean
      cleanCompletedSession({ needs_review: true }),                       // needs_review
      cleanCompletedSession({ status: "active", clock_out_at: null }),     // active
      cleanCompletedSession({ clock_out_at: null }),                       // missing_clockout
      cleanCompletedSession({ dcr_status: undefined }),                    // dcr-pending (not blocker)
      cleanCompletedSession({ dcr_status: undefined, needs_review: true }),// double: needs_review wins
    ];
    const serverB = serverSideBlockerCounts(sessions);
    assert.equal(serverB.needs_review,     2);
    assert.equal(serverB.active,           1);
    assert.equal(serverB.missing_clockout, 1);
    assert.equal(serverB.dcr_pending,      0);
    assert.equal(totalBlockersV2(serverB), 4);
  });
});
