/* Pioneer DCR Hub — tokenized customer DCR report page.
 *
 * Loads ONE report by token (?t=<rawToken>) from getDcrReportByTokenV1.
 * No Firebase Auth, no admin surface. The function side bumps view
 * counts and returns a customer-safe shape we render directly.
 */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function showState(name) {
    $("dcr-loading").hidden = name !== "loading";
    $("dcr-error").hidden   = name !== "error";
    $("dcr-report").hidden  = name !== "report";
  }
  function showError(msg) {
    if (msg) $("dcr-error-msg").textContent = msg;
    showState("error");
  }

  function getToken() {
    try {
      const t = new URLSearchParams(window.location.search || "").get("t") || "";
      return t.trim();
    } catch (_e) { return ""; }
  }

  function renderReport(r) {
    document.title = "Cleaning Report · " + (r.customer_name || "Pioneer");

    $("dcr-report-customer").textContent = r.customer_name || "";
    $("dcr-report-date").textContent     = r.clean_date_human || r.clean_date || "";

    // Tech block.
    $("dcr-tech-name").textContent   = r.tech && r.tech.display_name || "Your Pioneer tech";
    $("dcr-tech-tenure").textContent = r.tech && r.tech.tenure_label || "";
    const photoEl = $("dcr-tech-photo");
    if (r.tech && r.tech.photo_url) {
      photoEl.src = r.tech.photo_url;
      photoEl.alt = r.tech.display_name || "Pioneer cleaning tech";
      photoEl.hidden = false;
    } else {
      photoEl.hidden = true;
    }
    $("dcr-tech-summary").textContent = r.summary || "";

    if (r.signed_off_at) {
      try {
        const d = new Date(r.signed_off_at);
        if (!isNaN(d.getTime())) {
          const fmt = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Los_Angeles",
            month: "long", day: "numeric",
            hour: "numeric", minute: "2-digit", hour12: true
          });
          $("dcr-signed-line").textContent = "Signed off-site at " + fmt.format(d);
          $("dcr-signed-line").hidden = false;
        }
      } catch (_e) {}
    }

    // Issue block.
    const tier = (r.issue && r.issue.tier) || "green";
    const pill = $("dcr-issue-pill");
    pill.textContent = tier === "green"
      ? "All clear"
      : (tier === "yellow" ? "Heads-up" : "Pioneer is following up");
    pill.classList.remove("dcr-pill-green", "dcr-pill-yellow", "dcr-pill-red");
    pill.classList.add("dcr-pill-" + tier);
    $("dcr-issue-message").textContent = (r.issue && r.issue.message) || "";

    // Checklist.
    const checklistEl = $("dcr-checklist");
    if (Array.isArray(r.checklist) && r.checklist.length > 0) {
      checklistEl.innerHTML = r.checklist.map(function (sec) {
        const itemsHtml = sec.done_items.map(function (it) {
          return '<li>' + esc(it) + '</li>';
        }).join("");
        return '<section class="dcr-checklist-section">' +
                 '<h3 class="dcr-checklist-head">' + esc(sec.section_label) + '</h3>' +
                 '<ul class="dcr-checklist-items">' + itemsHtml + '</ul>' +
               '</section>';
      }).join("");
    } else {
      checklistEl.innerHTML = '<p class="dcr-empty-note">No checklist captured for this visit.</p>';
    }

    // Photos.
    if (Array.isArray(r.photos) && r.photos.length > 0) {
      $("dcr-photos-card").hidden = false;
      $("dcr-photos").innerHTML = r.photos.map(function (p) {
        return '<figure class="dcr-photo">' +
                 '<a href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer">' +
                   '<img src="' + esc(p.url) + '" alt="' + esc(p.caption || "Cleaning photo") + '" />' +
                 '</a>' +
                 (p.caption ? '<figcaption>' + esc(p.caption) + '</figcaption>' : '') +
               '</figure>';
      }).join("");
    } else {
      $("dcr-photos-card").hidden = true;
    }

    // Feedback links.
    if (r.feedback) {
      if (r.feedback.compliment_url) $("dcr-feedback-compliment").href = r.feedback.compliment_url;
      if (r.feedback.issue_url)      $("dcr-feedback-issue").href      = r.feedback.issue_url;
    }

    $("dcr-report-id").textContent = r.report_id || "";

    showState("report");
  }

  async function loadReport() {
    const token = getToken();
    if (!token) {
      showError("This link is missing its access token. Open the link from the original email.");
      return;
    }
    const url = (window.GET_DCR_REPORT_BY_TOKEN_URL || "");
    if (!url) {
      showError("Report service not configured.");
      return;
    }
    try {
      const res = await fetch(url + "?t=" + encodeURIComponent(token), {
        method: "GET",
        headers: { "Accept": "application/json" },
        cache: "no-store"
      });
      const body = await res.json().catch(function () { return {}; });
      if (!res.ok || !body.ok) {
        const msg = (body && body.error) || "Report unavailable.";
        showError(msg);
        return;
      }
      renderReport(body.report);
    } catch (err) {
      console.warn("[dcr-report] fetch failed", err);
      showError("Couldn't load the report. Check your connection and try the link again.");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadReport);
  } else {
    loadReport();
  }
})();
