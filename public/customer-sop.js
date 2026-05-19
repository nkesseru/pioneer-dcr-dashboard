/* ====================================================================
 * customer-sop.js — shared renderer for the public/secure SOP split.
 *
 * Schema (post-split):
 *   • customers/{slug}.sop* (flat camelCase fields) — PUBLIC, all staff
 *       sopStatus, sopUpdatedAt, sopSource, sopQuickGlance,
 *       sopSections, sopDoNot, sopMustDo, sopPublicNotes, hasSecureSop
 *
 *   • customer_secure/{slug}                       — ADMIN-ONLY
 *       alarmCodes, doorCodes, gateCodes, keyFobNotes,
 *       alarmCompanyNotes, emergencyContacts, secureInstructions,
 *       rawDeputyNotes, deputyCompanyId, deputyCompanyName,
 *       deputyCompanyCode, addressPrint, activeInDeputy,
 *       sourceUpdatedAt, parsedAt, parserVersion
 *
 * Public API:
 *   CustomerSop.renderPublic(container, customerDoc)         — sectioned public block (admin view)
 *   CustomerSop.renderPublicSimple(container, customerDoc)   — single collapsible block (tech view, v1)
 *   CustomerSop.renderSecure(container, secureDoc)           — admin-only block
 *   CustomerSop.inlineSummary(customerDoc, opts)             — inline preview (Today's Work)
 *   CustomerSop.statusForCustomer(customerDoc)               — { code, label }
 *
 *   CustomerSop.render(container, customerDoc, opts)         — back-compat alias
 *     opts.mode === "admin" + opts.secure → render both blocks.
 *
 * Tech-view v1 (renderPublicSimple) intentionally STOPS sectioning the
 * SOP into headings. The previous parser sometimes labelled an entire
 * SOP "Bathroom" or similar misleading title; showing the raw cleaned
 * notes is more useful to the tech standing in the building. Admin
 * keeps the sectioned render via renderPublic so the parser output
 * stays inspectable.
 * ================================================================== */
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtImported(ts) {
    if (!ts) return "";
    if (ts.toDate) ts = ts.toDate();
    if (typeof ts === "string") ts = new Date(ts);
    if (!(ts instanceof Date) || isNaN(ts.getTime())) return "";
    return ts.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  }

  function sopStatusForCustomer(c) {
    if (!c) return { code: "no_sop", label: "No SOP" };
    const st = String(c.sopStatus || "").toLowerCase();
    if (st === "has_sop")       return { code: "has_sop",       label: "Has SOP" };
    if (st === "needs_review")  return { code: "needs_review",  label: "Needs Review" };
    if (st === "inactive")      return { code: "inactive",      label: "Inactive in Deputy" };
    return { code: "no_sop", label: "No SOP" };
  }

  // ---------- small helpers ----------
  function chip(cls, text) {
    return '<span class="sop-chip ' + cls + '">' + esc(text) + '</span>';
  }
  function bullets(items) {
    if (!Array.isArray(items) || !items.length) return "";
    return '<ul class="sop-bullets">' +
      items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join("") +
    '</ul>';
  }
  function bulletsRedacted(items) {
    if (!Array.isArray(items) || !items.length) return "";
    return '<ul class="sop-bullets sop-bullets-redact">' +
      items.map(function (i) {
        return '<li><span class="sop-redact" data-redact="1">' + esc(i) + '</span></li>';
      }).join("") +
    '</ul>';
  }

  // ---------- PUBLIC cards ----------
  function renderQuickGlance(c) {
    const items = Array.isArray(c.sopQuickGlance) ? c.sopQuickGlance.slice(0, 5) : [];
    if (!items.length) return "";
    return (
      '<section class="sop-card sop-card-quick">' +
        '<header class="sop-card-head">' +
          '<h3 class="sop-card-title">Quick Glance</h3>' +
          chip("is-info", "Top " + items.length) +
        '</header>' +
        bullets(items) +
      '</section>'
    );
  }

  function renderCriticalPublic(c) {
    const doNot  = Array.isArray(c.sopDoNot)  ? c.sopDoNot  : [];
    const must   = Array.isArray(c.sopMustDo) ? c.sopMustDo : [];
    if (!doNot.length && !must.length) return "";
    const blocks = [];
    if (doNot.length) blocks.push(
      '<div class="sop-critical-block is-dont">' +
        '<h4>Do not</h4>' + bullets(doNot) +
      '</div>'
    );
    if (must.length) blocks.push(
      '<div class="sop-critical-block is-must">' +
        '<h4>Must do</h4>' + bullets(must) +
      '</div>'
    );
    return (
      '<section class="sop-card sop-card-critical">' +
        '<header class="sop-card-head">' +
          '<h3 class="sop-card-title">Critical Notes</h3>' +
        '</header>' +
        '<div class="sop-critical-grid">' + blocks.join("") + '</div>' +
      '</section>'
    );
  }

  function renderSections(c) {
    const secs = Array.isArray(c.sopSections) ? c.sopSections : [];
    if (!secs.length) return "";
    return (
      '<section class="sop-card sop-card-sections">' +
        '<header class="sop-card-head">' +
          '<h3 class="sop-card-title">Scope by Area</h3>' +
          chip("is-info", String(secs.length) + " section" + (secs.length === 1 ? "" : "s")) +
        '</header>' +
        '<div class="sop-sections">' +
          secs.map(function (s) {
            const tasks = Array.isArray(s.tasks) ? s.tasks : [];
            return (
              '<details class="sop-section">' +
                '<summary>' +
                  '<span class="sop-section-title">' + esc(s.title || "—") + '</span>' +
                  (s.frequency
                    ? '<span class="sop-section-freq">' + esc(s.frequency) + '</span>'
                    : '') +
                  '<span class="sop-section-count">' +
                    tasks.length + ' task' + (tasks.length === 1 ? '' : 's') +
                  '</span>' +
                '</summary>' +
                bullets(tasks) +
              '</details>'
            );
          }).join("") +
        '</div>' +
      '</section>'
    );
  }

  function renderPublicNotes(c) {
    const notes = Array.isArray(c.sopPublicNotes) ? c.sopPublicNotes : [];
    if (!notes.length) return "";
    return (
      '<section class="sop-card">' +
        '<header class="sop-card-head">' +
          '<h3 class="sop-card-title">Other notes</h3>' +
        '</header>' +
        bullets(notes) +
      '</section>'
    );
  }

  function renderPublicFooter(c) {
    const updatedAt = fmtImported(c.sopUpdatedAt);
    const bits = [];
    if (c.sopSource) bits.push(esc(c.sopSource));
    if (updatedAt)   bits.push('Updated ' + esc(updatedAt));
    if (c.hasSecureSop) bits.push(chip("is-warn", "Secure ops info exists (admin only)"));
    if (!bits.length) return "";
    return '<footer class="sop-footer">' + bits.join(' · ') + '</footer>';
  }

  function renderPublic(container, customer) {
    if (!container) return;
    const c = customer || {};
    // Treat "no SOP fields at all" as empty state.
    const hasAny = Array.isArray(c.sopQuickGlance) && c.sopQuickGlance.length ||
                   Array.isArray(c.sopSections)    && c.sopSections.length ||
                   Array.isArray(c.sopDoNot)       && c.sopDoNot.length ||
                   Array.isArray(c.sopMustDo)      && c.sopMustDo.length ||
                   Array.isArray(c.sopPublicNotes) && c.sopPublicNotes.length ||
                   c.sopStatus || c.sopUpdatedAt;
    if (!hasAny) {
      container.innerHTML =
        '<div class="sop-empty">No SOP imported yet for this customer. ' +
        'Run <code>scripts/seedCustomerSopsFromDeputy.js</code> to import from Deputy.</div>';
      return;
    }
    container.innerHTML =
      renderQuickGlance(c) +
      renderCriticalPublic(c) +
      renderSections(c) +
      renderPublicNotes(c) +
      renderPublicFooter(c);
  }

  // ---------- PUBLIC SIMPLE (tech view, v1) ----------
  // Picks the safest available source on the customer doc and returns
  // { text, source }. Priority:
  //   1. customers/{slug}.sopRawPublicText        (seed-redacted full text)
  //   2. customers/{slug}.sopPublicNotes joined   (parser leftovers)
  //   3. customers/{slug}.sopSections flattened   (last-resort fallback)
  function pickSimpleSopText(c) {
    if (typeof c.sopRawPublicText === "string" && c.sopRawPublicText.trim()) {
      return { text: c.sopRawPublicText.trim(), source: "sopRawPublicText" };
    }
    if (Array.isArray(c.sopPublicNotes) && c.sopPublicNotes.length) {
      return { text: c.sopPublicNotes.join("\n").trim(), source: "sopPublicNotes" };
    }
    if (Array.isArray(c.sopSections) && c.sopSections.length) {
      const parts = c.sopSections.map(function (s) {
        const title = String(s && s.title || "Section");
        const tasks = Array.isArray(s && s.tasks) ? s.tasks : [];
        if (!tasks.length) return title;
        return title + "\n" + tasks.map(function (t) { return "• " + t; }).join("\n");
      });
      return { text: parts.join("\n\n").trim(), source: "sopSections" };
    }
    return { text: "", source: null };
  }

  function renderPublicSimple(container, customer) {
    if (!container) return;
    const c = customer || {};
    const picked = pickSimpleSopText(c);

    if (!picked.text) {
      container.innerHTML =
        '<section class="sop-simple sop-simple-empty">' +
          '<h3 class="sop-simple-title">Customer SOP</h3>' +
          '<p class="sop-simple-empty-msg">No SOP added for this customer yet.</p>' +
        '</section>';
      return;
    }

    container.innerHTML =
      '<section class="sop-simple" data-source="' + esc(picked.source) + '">' +
        '<div class="sop-simple-head">' +
          '<h3 class="sop-simple-title">Customer SOP</h3>' +
          '<p class="sop-simple-sub">Tap to expand cleaning instructions for this location.</p>' +
        '</div>' +
        '<button type="button" class="sop-simple-toggle" aria-expanded="false">Show SOP</button>' +
        '<div class="sop-simple-body" hidden>' +
          '<div class="sop-simple-text">' + esc(picked.text) + '</div>' +
        '</div>' +
      '</section>';

    const btn  = container.querySelector(".sop-simple-toggle");
    const body = container.querySelector(".sop-simple-body");
    if (btn && body) {
      btn.addEventListener("click", function () {
        const isOpen = !body.hasAttribute("hidden");
        if (isOpen) {
          body.setAttribute("hidden", "");
          btn.setAttribute("aria-expanded", "false");
          btn.textContent = "Show SOP";
        } else {
          body.removeAttribute("hidden");
          btn.setAttribute("aria-expanded", "true");
          btn.textContent = "Hide SOP";
        }
      });
    }
  }

  // ---------- SECURE block (admin-only) ----------
  function renderAccessBlock(secure) {
    const parts = [];
    function row(label, arr) {
      if (!Array.isArray(arr) || !arr.length) return;
      parts.push(
        '<div class="sop-access-row">' +
          '<div class="sop-access-label">' + esc(label) + '</div>' +
          bulletsRedacted(arr) +
        '</div>'
      );
    }
    row("Alarm codes",        secure.alarmCodes);
    row("Door codes",         secure.doorCodes);
    row("Gate codes",         secure.gateCodes);
    row("Keys / fobs",        secure.keyFobNotes);
    row("Alarm company",      secure.alarmCompanyNotes);
    row("Emergency contacts", secure.emergencyContacts);
    if (!parts.length) return "";
    return (
      '<section class="sop-card sop-card-access">' +
        '<header class="sop-card-head">' +
          '<h3 class="sop-card-title">Access &amp; Security</h3>' +
          chip("is-warn", "Sensitive — tap to reveal") +
        '</header>' +
        '<p class="sop-card-sub">' +
          'Admin-only. Never share with customers and never appears in customer-facing email.' +
        '</p>' +
        '<details class="sop-access-details" open>' +
          '<summary>Show access details</summary>' +
          '<div class="sop-access-grid">' + parts.join("") + '</div>' +
        '</details>' +
      '</section>'
    );
  }
  function renderSecureInstructions(secure) {
    const arr = Array.isArray(secure.secureInstructions) ? secure.secureInstructions : [];
    if (!arr.length) return "";
    return (
      '<section class="sop-card sop-card-critical">' +
        '<header class="sop-card-head">' +
          '<h3 class="sop-card-title">Secure instructions</h3>' +
          chip("is-warn", "Admin-only") +
        '</header>' +
        '<p class="sop-card-sub">' +
          'Lines that contained code-like or sensitive content. Kept here ' +
          'so the public SOP rendering stays safe for techs.' +
        '</p>' +
        bullets(arr) +
      '</section>'
    );
  }
  function renderRawNotes(secure) {
    const raw = String(secure.rawDeputyNotes || "");
    if (!raw) return "";
    return (
      '<section class="sop-card sop-card-raw">' +
        '<details>' +
          '<summary>Raw Deputy notes (admin only)</summary>' +
          '<pre class="sop-raw">' + esc(raw) + '</pre>' +
        '</details>' +
      '</section>'
    );
  }
  function renderSecureFooter(secure) {
    const bits = [];
    if (secure.deputyCompanyName) {
      bits.push('Deputy: ' + esc(secure.deputyCompanyName) +
        (secure.deputyCompanyId ? ' (id ' + secure.deputyCompanyId + ')' : ''));
    }
    if (secure.deputyCompanyCode) bits.push('Code: <code>' + esc(secure.deputyCompanyCode) + '</code>');
    if (secure.activeInDeputy === false) bits.push('<strong>Inactive in Deputy</strong>');
    const imported = fmtImported(secure.parsedAt);
    const updated  = fmtImported(secure.sourceUpdatedAt);
    if (imported) bits.push('Parsed ' + esc(imported));
    if (updated && updated !== imported) bits.push('Source ' + esc(updated));
    if (!bits.length) return "";
    return '<footer class="sop-footer">' + bits.join(' · ') + '</footer>';
  }

  function renderSecure(container, secure) {
    if (!container) return;
    if (!secure || typeof secure !== "object") {
      container.innerHTML =
        '<div class="sop-empty">No secure SOP data on file. ' +
        'Either none was detected during the Deputy import, or this customer doesn\'t have one yet.</div>';
      return;
    }
    container.innerHTML =
      '<div class="sop-secure-banner">' +
        '<strong>Admin-only Secure Ops.</strong> ' +
        'Codes, contacts, and raw notes. Visible to admins only; ' +
        'firestore.rules denies tech reads. Never copied into ' +
        'customer-facing emails or public pages.' +
      '</div>' +
      renderAccessBlock(secure) +
      renderSecureInstructions(secure) +
      renderRawNotes(secure) +
      renderSecureFooter(secure);
  }

  // ---------- inline preview ----------
  function inlineSummary(customer, opts) {
    opts = opts || {};
    const c = customer || {};
    const items = Array.isArray(c.sopQuickGlance) ? c.sopQuickGlance : [];
    if (!items.length) return "";
    const cap = Math.max(1, Math.min(opts.max || 3, 5));
    const slice = items.slice(0, cap);
    return (
      '<ul class="sop-inline-quick">' +
        slice.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join("") +
      '</ul>'
    );
  }

  // ---------- back-compat shim ----------
  // Older call sites used render(container, customer, {mode:"tech"|"admin"}).
  // We keep the signature but always render the PUBLIC block; callers
  // that want the secure block must call renderSecure() explicitly with
  // the customer_secure doc data.
  function render(container, customer, opts) {
    opts = opts || {};
    renderPublic(container, customer);
    if (opts.mode === "admin" && opts.secure) {
      const sep = document.createElement("div");
      sep.className = "sop-secure-sep";
      container.appendChild(sep);
      const wrap = document.createElement("div");
      wrap.className = "sop-secure-wrap";
      container.appendChild(wrap);
      renderSecure(wrap, opts.secure);
    }
  }

  window.CustomerSop = {
    renderPublic:       renderPublic,
    renderPublicSimple: renderPublicSimple,
    renderSecure:       renderSecure,
    render:             render,            // back-compat
    inlineSummary:      inlineSummary,
    statusForCustomer:  sopStatusForCustomer
  };
})();
