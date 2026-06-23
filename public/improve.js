/* Pioneer DCR Hub — Help Improve Pioneer submission page.
 *
 * Two flows:
 *   • improvement      — standard operational improvement (default).
 *                        Identity ALWAYS attached; the team's culture is
 *                        ownership, not anonymous venting.
 *   • protected        — separate channel for harassment / discrimination
 *                        / retaliation / serious ethics or safety
 *                        concerns. Visible only to a small named-admin
 *                        set. Optional anonymity toggle on this flow only.
 *
 * Tone everywhere: supportive, solution-oriented. "Focus on helping
 * improve the system, not attacking people."
 */
(function () {
  "use strict";

  const $ = function (id) { return document.getElementById(id); };

  const MAX_PHOTOS = 3;
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

  let currentStaff = null;
  let currentMode  = "improvement";
  const stagedPhotos = [];  // [{ file, previewUrl }]

  function setStaffAuthState(name) {
    ["checking", "signin", "denied"].forEach(function (s) {
      const el = document.getElementById("staff-auth-" + s);
      if (el) el.hidden = (s !== name);
    });
    const content = document.getElementById("staff-auth-content");
    if (content) content.hidden = (name !== "content");
  }

  function setMode(mode) {
    currentMode = mode;
    document.querySelectorAll(".improve-mode-btn").forEach(function (btn) {
      const on = btn.getAttribute("data-mode") === mode;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    const helpEl = $("improve-mode-help");
    if (helpEl) {
      helpEl.innerHTML = mode === "protected"
        ? "For harassment, discrimination, retaliation, or serious ethics or safety concerns. " +
          "<strong>Reports go to senior management only.</strong>"
        : "Help us improve how Pioneer operates. Share friction, ideas, workflow " +
          "improvements, operational issues, or opportunities to make the company " +
          "stronger. Senior management reviews every submission. " +
          "<strong>Focus on helping improve the system, not attacking people.</strong>";
    }
    const improveForm = $("improve-form");
    const protForm    = $("protected-form");
    const success     = $("improve-success");
    if (improveForm) improveForm.hidden = mode !== "improvement";
    if (protForm)    protForm.hidden    = mode !== "protected";
    if (success)     success.hidden     = true;
    clearStatus();
  }

  function clearStatus() {
    ["improve-form-status", "improve-form-error", "protected-form-status", "protected-form-error"].forEach(function (id) {
      const el = $(id);
      if (el) { el.textContent = ""; el.hidden = true; }
    });
  }

  function setStatus(id, msg) {
    const el = $(id);
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; }
    else     { el.textContent = "";  el.hidden = true; }
  }

  /* ---- Photo staging ---------------------------------------------- */

  function renderPhotoPreviews() {
    const root = $("improve-photo-previews");
    if (!root) return;
    root.innerHTML = stagedPhotos.map(function (p, i) {
      return '<div class="improve-photo-preview">' +
               '<img src="' + p.previewUrl + '" alt="Screenshot ' + (i + 1) + '" />' +
               '<button type="button" class="improve-photo-remove" data-i="' + i + '" aria-label="Remove">×</button>' +
             '</div>';
    }).join("");
    root.querySelectorAll(".improve-photo-remove").forEach(function (b) {
      b.addEventListener("click", function () {
        const i = Number(b.getAttribute("data-i"));
        const removed = stagedPhotos.splice(i, 1)[0];
        if (removed && removed.previewUrl) {
          try { URL.revokeObjectURL(removed.previewUrl); } catch (_e) {}
        }
        renderPhotoPreviews();
      });
    });
  }

  function onPhotosChange(ev) {
    const files = Array.from(ev.target.files || []);
    for (let i = 0; i < files.length && stagedPhotos.length < MAX_PHOTOS; i++) {
      const f = files[i];
      if (!f.type || !f.type.startsWith("image/")) continue;
      if (f.size > MAX_PHOTO_BYTES) {
        setStatus("improve-form-error", "Photo \"" + f.name + "\" is over 5 MB. Skipped.");
        continue;
      }
      stagedPhotos.push({ file: f, previewUrl: URL.createObjectURL(f) });
    }
    ev.target.value = "";
    renderPhotoPreviews();
  }

  async function uploadStagedPhotos(submissionId) {
    if (stagedPhotos.length === 0) return [];
    const storage = firebase.storage();
    const urls = [];
    for (let i = 0; i < stagedPhotos.length; i++) {
      const file = stagedPhotos[i].file;
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      const path = "pioneer-improvements/" + submissionId + "/photo-" + (i + 1) + "." + ext;
      const ref  = storage.ref(path);
      const snap = await ref.put(file, { contentType: file.type || "image/jpeg" });
      const url  = await snap.ref.getDownloadURL();
      urls.push(url);
    }
    return urls;
  }

  /* ---- Validation -------------------------------------------------- */

  function softTrim(s) { return String(s == null ? "" : s).trim(); }

  function validateImprovement() {
    const problem    = softTrim($("improve-problem")    && $("improve-problem").value);
    const why        = softTrim($("improve-why")        && $("improve-why").value);
    const suggest    = softTrim($("improve-suggest")    && $("improve-suggest").value);
    if (!problem || problem.length < 8) return "Add a few sentences about what's getting in the way.";
    if (!why     || why.length < 5)     return "Add a quick note on why this matters.";
    if (!suggest || suggest.length < 5) return "Add at least one idea for how to improve it. It doesn't have to be polished.";
    return null;
  }
  function validateProtected() {
    const what    = softTrim($("protected-what")        && $("protected-what").value);
    const ctx     = softTrim($("protected-context")     && $("protected-context").value);
    const resolve = softTrim($("protected-resolution")  && $("protected-resolution").value);
    if (!what || what.length < 12)     return "Tell us what happened so we can look into it.";
    if (!resolve || resolve.length < 5) return "Share what would help resolve this.";
    return null;
  }

  /* ---- Submit handlers -------------------------------------------- */

  function newSubmissionId() {
    // 16-char timestamp+random — readable, sortable, unique enough.
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  async function submitImprovement(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    clearStatus();
    const err = validateImprovement();
    if (err) { setStatus("improve-form-error", err); return; }
    if (!currentStaff || !currentStaff.uid) {
      setStatus("improve-form-error", "We lost your sign-in. Refresh and try again.");
      return;
    }
    const btn = $("improve-submit");
    if (btn) btn.disabled = true;
    setStatus("improve-form-status", "Sending…");

    try {
      const submissionId = newSubmissionId();
      const photoUrls = await uploadStagedPhotos(submissionId);
      const db = firebase.firestore();
      const sts = firebase.firestore.FieldValue.serverTimestamp();
      const doc = {
        submission_id:        submissionId,
        submission_type:      "improvement",
        is_protected:         false,
        is_anonymous:         false,
        is_pioneerops_issue:  !!($("improve-is-pioneerops-issue") && $("improve-is-pioneerops-issue").checked),
        category:             softTrim($("improve-category") && $("improve-category").value),
        problem:              softTrim($("improve-problem").value),
        why_matters:          softTrim($("improve-why").value),
        suggested_improvement: softTrim($("improve-suggest").value),
        photo_urls:           photoUrls,
        // Identity stamped server-side via Firestore rules (the create
        // rule requires these fields match request.auth) so a spoofed
        // payload can't mis-attribute the submission.
        submitted_by_uid:     currentStaff.uid,
        submitted_by_email:   String(currentStaff.email || "").toLowerCase().trim(),
        submitted_by_name:    String(currentStaff.display_name || currentStaff.tech && currentStaff.tech.display_name || currentStaff.email || ""),
        submitted_by_role:    currentStaff.role || "",
        status:               "submitted",
        admin_notes:          "",
        show_in_team_hub:     false,
        created_at:           sts,
        updated_at:           sts,
        last_status_change_at: sts
      };
      await db.collection("pioneer_improvements").doc(submissionId).set(doc, { merge: false });

      try { if (window.PioneerCelebrate) window.PioneerCelebrate.celebrate({ intensity: "small" }); } catch (_e) {}
      paintSuccess("improvement");
    } catch (e) {
      console.error("[improve] submit failed", e);
      setStatus("improve-form-error",
        "Couldn't send that — try again in a minute. " +
        "If it keeps failing, contact senior management directly. " +
        "(" + (e && e.message ? e.message : "unknown") + ")");
    } finally {
      if (btn) btn.disabled = false;
      setStatus("improve-form-status", "");
    }
  }

  async function submitProtected(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    clearStatus();
    const err = validateProtected();
    if (err) { setStatus("protected-form-error", err); return; }
    if (!currentStaff || !currentStaff.uid) {
      setStatus("protected-form-error", "We lost your sign-in. Refresh and try again.");
      return;
    }
    const btn = $("protected-submit");
    if (btn) btn.disabled = true;
    setStatus("protected-form-status", "Sending…");

    try {
      const submissionId = newSubmissionId();
      const anonymous = !!($("protected-anonymous") && $("protected-anonymous").checked);
      const db = firebase.firestore();
      const sts = firebase.firestore.FieldValue.serverTimestamp();
      const doc = {
        submission_id:        submissionId,
        submission_type:      "protected",
        is_protected:         true,
        is_anonymous:         anonymous,
        category:             "protected",
        problem:              softTrim($("protected-what").value),
        why_matters:          softTrim($("protected-context").value),
        suggested_improvement: softTrim($("protected-resolution").value),
        // Identity fields: when the submitter chose anonymous, we DO NOT
        // surface them in the doc body — but we still stamp uid/email so
        // a single named admin can resolve the submitter if a serious
        // safety issue requires direct follow-up. The Firestore rule
        // restricts read of the protected collection to the admin list,
        // and the admin UI hides identity for anonymous submissions
        // unless the admin explicitly opens an "identify submitter"
        // affordance (Phase 2 — not in V1).
        submitted_by_uid:     currentStaff.uid,
        submitted_by_email:   String(currentStaff.email || "").toLowerCase().trim(),
        submitted_by_name:    anonymous ? "" : String(currentStaff.display_name || currentStaff.email || ""),
        submitted_by_role:    currentStaff.role || "",
        status:               "submitted",
        admin_notes:          "",
        show_in_team_hub:     false,
        created_at:           sts,
        updated_at:           sts,
        last_status_change_at: sts
      };
      await db.collection("pioneer_improvements").doc(submissionId).set(doc, { merge: false });
      paintSuccess("protected", anonymous);
    } catch (e) {
      console.error("[improve] protected submit failed", e);
      setStatus("protected-form-error",
        "Couldn't send that — try again in a minute. " +
        "If it keeps failing, contact senior management directly. " +
        "(" + (e && e.message ? e.message : "unknown") + ")");
    } finally {
      if (btn) btn.disabled = false;
      setStatus("protected-form-status", "");
    }
  }

  function paintSuccess(kind, wasAnonymous) {
    const improveForm = $("improve-form");
    const protForm    = $("protected-form");
    if (improveForm) improveForm.hidden = true;
    if (protForm)    protForm.hidden    = true;
    const success = $("improve-success");
    const title   = $("improve-success-title");
    const body    = $("improve-success-body");
    if (kind === "protected") {
      if (title) title.textContent = "Thanks — your report is in.";
      if (body)  body.textContent  = wasAnonymous
        ? "Your name isn't attached to this report. Senior management will follow up if needed."
        : "Only senior management will see this. We'll follow up as soon as possible.";
    } else {
      if (title) title.textContent = "Thanks — we got it.";
      if (body)  body.textContent  =
        "Senior management reviews every submission. We'll follow up if we need clarification, " +
        "and we'll let the team know when improvements ship from ideas like this.";
    }
    if (success) success.hidden = false;
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (_e) {}
  }

  function resetForms() {
    ["improve-problem", "improve-why", "improve-suggest",
     "protected-what", "protected-context", "protected-resolution"].forEach(function (id) {
      const el = $(id);
      if (el) el.value = "";
    });
    const cat = $("improve-category");
    if (cat) cat.value = "";
    const isPo = $("improve-is-pioneerops-issue");
    if (isPo) isPo.checked = false;
    const anon = $("protected-anonymous");
    if (anon) anon.checked = false;
    stagedPhotos.splice(0).forEach(function (p) {
      try { URL.revokeObjectURL(p.previewUrl); } catch (_e) {}
    });
    renderPhotoPreviews();
    clearStatus();
  }

  function wire() {
    document.querySelectorAll(".improve-mode-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { setMode(btn.getAttribute("data-mode")); });
    });
    const improveForm = $("improve-form");
    if (improveForm) improveForm.addEventListener("submit", submitImprovement);
    const protForm = $("protected-form");
    if (protForm) protForm.addEventListener("submit", submitProtected);
    const photos = $("improve-photos");
    if (photos) photos.addEventListener("change", onPhotosChange);
    const another = $("improve-success-another");
    if (another) another.addEventListener("click", function () {
      resetForms();
      const success = $("improve-success");
      if (success) success.hidden = true;
      setMode(currentMode);
    });
    document.querySelectorAll("[data-staff-signout]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (window.STAFF_AUTH) window.STAFF_AUTH.signOut();
      });
    });
    const googleBtn = $("staff-google-signin");
    if (googleBtn) googleBtn.addEventListener("click", function () {
      if (window.STAFF_AUTH) window.STAFF_AUTH.signIn();
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    wire();
    setStaffAuthState("checking");
    if (!window.STAFF_AUTH) {
      console.error("[improve] STAFF_AUTH missing");
      setStaffAuthState("signin");
      return;
    }
    window.STAFF_AUTH.init({
      onChecking:   function () { setStaffAuthState("checking"); },
      onSignedOut:  function () { setStaffAuthState("signin"); },
      onDenied:     function (info) {
        setStaffAuthState("denied");
        const msg = info && info.message;
        const el  = $("staff-auth-denied-msg");
        if (msg && el) el.textContent = msg;
      },
      onAuthorized: function (staff) {
        currentStaff = staff;
        setStaffAuthState("content");
        const nameEl = $("improve-signed-in-name");
        if (nameEl) {
          nameEl.textContent =
            (staff && (staff.display_name || (staff.tech && staff.tech.display_name) || staff.email)) || "you";
        }
      }
    });
  });
})();
