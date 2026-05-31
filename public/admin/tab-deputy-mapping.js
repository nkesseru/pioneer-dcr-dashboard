/* Pioneer DCR Hub — Admin Deputy Mapping tab (vanilla JS, no build).
 *
 * Deputy Mapping — read-only diagnostic + Alias Manager + Customer
 * integration view.
 *
 * Compares deputy_shift_cache for a chosen sync_date against the
 * active cleaning_techs + customers caches and surfaces unmapped
 * employees/locations. Suggestions are derived from normalized-name
 * equality only (case-insensitive, whitespace-collapsed, ASCII-only
 * alpha+digits). Nothing is auto-applied — the admin still edits the
 * cleaning_techs or customers row to align.
 *
 * Reads:
 *   - deputy_shift_cache   (admin role-gated, full collection)
 *   - customer_aliases     (full collection)
 *   - cleaning_techs       (via deps.getTechs)
 *   - customers            (via deps.getCustomers)
 *
 * Writes:
 *   - customers/{slug}     (mapDeputyCompany / removeCompanyMapping /
 *                           keepDuplicateMapping)
 *   - cleaning_techs/{slug} (applyEmployeeMapping)
 *   - customer_aliases/{id} (create / toggleActive / delete / seed)
 *
 * Calls 2 Cloud Functions via admin-ID-token POST:
 *   - SEED_PILOT_CUSTOMER_ALIASES_URL (seedPilotAliases)
 *   - DEPUTY_API_DIAGNOSTIC_URL       (runDeputyApiProbe)
 *
 * Phase 22 also fixes 4 latent ReferenceError sites: bare `techs` /
 * `customers` reads inside renderDeputyMappingEmployees (L1080),
 * renderDeputyCompanies (L1423), renderUnmappedDeputyLocations
 * (L2183), and populateAliasCreateCustomerOptions (L2237) — same
 * pattern as the Phase 20 Announcements fix. Each now rebinds from
 * getTechs() / getCustomers() at function entry.
 *
 * Surface lives at window.__pioneerAdmin.tabs.deputyMapping:
 *   {
 *     init,                          // wireDeputyMappingControls — DOM wiring + first-activation auto-load
 *     refresh,                       // loadDeputyMapping — Firestore reload + dispatch to all 6 renderers
 *     populateCustomerIntegration    // populateCustomerDeputyIntegration(c) — fills the Deputy block inside the customer edit modal
 *   }
 *
 * Loaded AFTER admin/_utils.js + admin/_shell.js and BEFORE admin.js.
 *
 * External dependencies:
 *   • escapeHtml, getActive, getCustomerName, getCustomerSlug,
 *     getTechName, getTechSlug from __pioneerAdmin.utils
 *   • showToast from __pioneerAdmin.shell
 *   • Lazily resolved at call time from __pioneerAdmin.deps:
 *       - getCustomers()
 *       - getTechs()
 *       - getCurrentAdminEmail()
 *       - handleAdminWriteError(err, opts)
 *   • window.firebase compat SDK (auth + firestore)
 *   • window.SEED_PILOT_CUSTOMER_ALIASES_URL + window.DEPUTY_API_DIAGNOSTIC_URL
 *     (firebase-config.js)
 */
(function () {
  "use strict";

  if (!window.__pioneerAdmin || !window.__pioneerAdmin.utils || !window.__pioneerAdmin.shell) {
    throw new Error("admin/tab-deputy-mapping.js: utils + shell modules must load first");
  }
  const {
    escapeHtml, getActive,
    getCustomerName, getCustomerSlug,
    getTechName, getTechSlug
  } = window.__pioneerAdmin.utils;
  const { showToast } = window.__pioneerAdmin.shell;

  function depOrThrow(name) {
    const deps = window.__pioneerAdmin && window.__pioneerAdmin.deps;
    if (!deps || typeof deps[name] !== "function") {
      throw new Error("tab-deputy-mapping: __pioneerAdmin.deps." + name + " not populated yet");
    }
    return deps[name];
  }
  const getCustomers          = () => depOrThrow("getCustomers")();
  const getTechs              = () => depOrThrow("getTechs")();
  const getCurrentAdminEmail  = () => depOrThrow("getCurrentAdminEmail")();
  const handleAdminWriteError = (err, opts) => depOrThrow("handleAdminWriteError")(err, opts);

  function $(id) { return document.getElementById(id); }

  // Lazy Firestore handle. We intentionally do NOT call
  // firebase.firestore() at module-load time — the compat SDK's
  // initialization can race the script tag order under certain
  // browser / network conditions, throwing here and preventing
  // window.__pioneerAdmin.tabs.deputyMapping from ever being
  // registered (which then trips admin.js's downstream load guard).
  // Every other tab module already lazy-initializes inside function
  // bodies; this getter brings tab-deputy-mapping.js in line.
  function db() { return firebase.firestore(); }

  /* ---------- module state ---------- */

  let deputyMappingShifts = [];
  let customerAliases     = [];   // cached /customer_aliases docs
  let showInactiveInCustomerPicker = false;   // toggled by "Show inactive" button

  // Normalize an alias for indexing + doc-id derivation. Mirrors the
  // normalizeKeySuggest() helper on the backend so the two sides
  // produce identical keys for the same input.
  function normalizeAlias(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function setDeputyMappingState(state, msg) {
    const loadEl    = $("deputy-mapping-loading");
    const errEl     = $("deputy-mapping-error");
    const emptyEl   = $("deputy-mapping-empty");
    const contentEl = $("deputy-mapping-content");
    if (loadEl)    loadEl.hidden    = state !== "loading";
    if (errEl)     errEl.hidden     = state !== "error";
    if (emptyEl)   emptyEl.hidden   = state !== "empty";
    if (contentEl) contentEl.hidden = state !== "content";
    if (state === "error" && errEl && msg) errEl.textContent = msg;
  }

  // Normalize signal slightly stronger than before: strip trailing
  // "s" so "Cleaning Tech" and "Cleaning Techs" collapse. KEEP IN SYNC
  // with normalizeKey() in functions/index.js syncDeputyShiftsCore.
  function normalizeMatchKey(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .replace(/s$/, "");
  }

  // ====================================================================
  // EMPLOYEE-ONLY MAPPING ARCHITECTURE
  // ====================================================================
  //
  // Deputy = who + when + official shift link.
  // PioneerOps = customer/location truth.
  //
  // The admin's only Deputy job here is to link each Deputy person
  // to a Pioneer cleaning tech (cleaning_techs.deputy_employee_*).
  // Customer mapping was removed from Deputy for the pilot: Deputy's
  // operational-unit names are unreliable ("Cleaning Techs"), so the
  // tech picks the customer on the DCR and submitDcrV1 writes
  // selected_customer_{slug,name} back onto pioneer_work_sessions.

  // Build all the indexes the renderers need, in one pass each.
  function buildMappingIndexes() {
    const techs = getTechs();
    const techsByDeputyId           = {};
    const techsByDeputyEmail        = {};
    const techsByEmailKey           = {};
    const techsByExplicitDeputyName = {};
    const techsByDisplayNameKey     = {};
    techs.forEach(function (t) {
      if (!getActive(t)) return;
      if (t.deputy_employee_id != null && t.deputy_employee_id !== "") {
        techsByDeputyId[String(t.deputy_employee_id)] = t;
      }
      const de = String(t.deputy_employee_email || "").toLowerCase().trim();
      if (de) techsByDeputyEmail[de] = t;
      const e = String(t.email || "").toLowerCase().trim();
      if (e) techsByEmailKey[e] = t;
      const explicit = normalizeMatchKey(t.deputy_employee_name);
      if (explicit && !techsByExplicitDeputyName[explicit]) techsByExplicitDeputyName[explicit] = t;
      const display = normalizeMatchKey(getTechName(t));
      if (display && !techsByDisplayNameKey[display]) techsByDisplayNameKey[display] = t;
    });

    return {
      techsByDeputyId, techsByDeputyEmail, techsByEmailKey,
      techsByExplicitDeputyName, techsByDisplayNameKey
    };
  }

  // Resolve a single Deputy person against the current tech mappings.
  // Returns {ref, via} when mapped, null when unmapped.
  function resolveDeputyPerson(p, ix) {
    if (p.deputy_employee_id != null && ix.techsByDeputyId[String(p.deputy_employee_id)]) {
      return { ref: ix.techsByDeputyId[String(p.deputy_employee_id)], via: "id" };
    }
    const emailKey = String(p.employee_email || "").toLowerCase().trim();
    if (emailKey && ix.techsByDeputyEmail[emailKey]) return { ref: ix.techsByDeputyEmail[emailKey], via: "deputy_email" };
    if (emailKey && ix.techsByEmailKey[emailKey])    return { ref: ix.techsByEmailKey[emailKey], via: "email" };
    const nameKey = normalizeMatchKey(p.employee_display_name);
    if (nameKey && ix.techsByExplicitDeputyName[nameKey]) return { ref: ix.techsByExplicitDeputyName[nameKey], via: "deputy_name" };
    return null;
  }

  // Aggregate distinct Deputy persons seen across the loaded shifts.
  function aggregateDeputyPeople() {
    const byKey = new Map();
    deputyMappingShifts.forEach(function (s) {
      const id = (s.deputy_employee_id != null && s.deputy_employee_id !== "")
                    ? String(s.deputy_employee_id) : "";
      const nameKey = normalizeMatchKey(s.employee_display_name);
      const key = id ? "id:" + id : (nameKey ? "name:" + nameKey : "");
      if (!key) return;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key:                       key,
          deputy_employee_id:        id ? Number(id) : null,
          employee_display_name:     s.employee_display_name || "",
          employee_email:            s.employee_email_deputy || s.employee_email || "",
          shift_count:               0,
          last_seen:                 null,
          sample_shift_url:          ""
        });
      }
      const g = byKey.get(key);
      g.shift_count += 1;
      const t = toMillis(s.start_time);
      if (t > (g.last_seen || 0)) g.last_seen = t;
      if (!g.sample_shift_url && s.deputy_shift_url) g.sample_shift_url = s.deputy_shift_url;
    });
    return Array.from(byKey.values()).sort(function (a, b) {
      return (a.employee_display_name || "").localeCompare(b.employee_display_name || "");
    });
  }

  function toMillis(ts) {
    if (!ts) return 0;
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") { const t = Date.parse(ts); return isNaN(t) ? 0 : t; }
    if (ts.toMillis) return ts.toMillis();
    if (ts.toDate)   return ts.toDate().getTime();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    return 0;
  }

  function fmtLastSeenPT(ms) {
    if (!ms) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "short", day: "numeric"
      }).format(new Date(ms));
    } catch (e) { return ""; }
  }

  // ============= Renderers =============

  function renderDeputyMappingEmployees() {
    const root = $("deputy-mapping-employees");
    if (!root) return;
    const techs = getTechs();
    const ix = buildMappingIndexes();
    const people = aggregateDeputyPeople();
    const unmapped = people.filter(function (p) { return !resolveDeputyPerson(p, ix); });

    const totalEl = $("deputy-mapping-employees-total");
    if (totalEl) {
      totalEl.textContent = unmapped.length + " unmapped · " + people.length + " seen total";
    }

    if (unmapped.length === 0) {
      root.innerHTML =
        '<div class="dm-empty-state">' +
          '<strong>Every Deputy person seen in the last ' + DEPUTY_MAPPING_LOOKBACK_DAYS + ' days is mapped.</strong>' +
          ' New people will appear here automatically on their first shift.' +
        '</div>';
      return;
    }

    const techOptionsHtml = techs
      .filter(function (t) { return getActive(t); })
      .sort(function (a, b) { return getTechName(a).localeCompare(getTechName(b)); })
      .map(function (t) {
        return '<option value="' + escapeHtml(getTechSlug(t)) + '">' +
                 escapeHtml(getTechName(t)) +
                 (t.email ? " (" + escapeHtml(t.email) + ")" : "") +
               '</option>';
      }).join("");

    root.innerHTML = unmapped.map(function (p) {
      const nameKey   = normalizeMatchKey(p.employee_display_name);
      const suggested = nameKey ? ix.techsByDisplayNameKey[nameKey] : null;

      const dataAttrs =
        ' data-deputy-id="' + escapeHtml(p.deputy_employee_id != null ? String(p.deputy_employee_id) : "") + '"' +
        ' data-deputy-name="' + escapeHtml(p.employee_display_name || "") + '"' +
        ' data-deputy-email="' + escapeHtml(p.employee_email || "") + '"';

      const lastSeen = fmtLastSeenPT(p.last_seen);
      const openLink = p.sample_shift_url
        ? '<a class="deputy-open-link" href="' + escapeHtml(p.sample_shift_url) +
          '" target="_blank" rel="noopener">Open in Deputy ↗</a>'
        : '';

      let suggestionBlk = "";
      if (suggested) {
        suggestionBlk =
          '<div class="dm-suggestion">' +
            '<div class="dm-suggestion-text">' +
              'Suggested: <strong>' + escapeHtml(getTechName(suggested)) + '</strong> (display-name match)' +
            '</div>' +
            '<button class="dm-btn dm-btn-primary" type="button"' +
              ' data-action="apply-emp"' +
              ' data-tech-slug="' + escapeHtml(getTechSlug(suggested)) + '"' +
              dataAttrs + '>Accept suggestion</button>' +
          '</div>';
      }

      const pickerBlk =
        '<div class="dm-picker">' +
          '<label class="dm-picker-label">Map this Deputy person to a Pioneer tech (one-time):</label>' +
          '<div class="dm-picker-row">' +
            '<select class="dm-select" data-pick="emp"' + dataAttrs + '>' +
              '<option value="">— Pick a tech —</option>' + techOptionsHtml +
            '</select>' +
            '<button class="dm-btn dm-btn-primary is-disabled" type="button"' +
              ' data-action="apply-emp-pick"' +
              dataAttrs + ' disabled>Pick tech first</button>' +
          '</div>' +
        '</div>';

      return (
        '<div class="dm-card" role="listitem">' +
          '<div class="dm-card-head">' +
            '<div class="dm-headline">' +
              escapeHtml(p.employee_display_name || "(no name)") +
            '</div>' +
            '<span class="mapping-pill is-unmapped">Needs mapping</span>' +
          '</div>' +
          '<div class="dm-deputy-shows">' +
            '<span class="dm-label">Deputy person:</span> ' +
            escapeHtml(p.employee_display_name || "(no name)") +
            (p.employee_email ? ' · ' + escapeHtml(p.employee_email) : '') +
          '</div>' +
          '<div class="dm-footnote">' +
            (p.deputy_employee_id != null ? 'Deputy employee ID ' + escapeHtml(String(p.deputy_employee_id)) + ' · ' : '') +
            'seen in ' + p.shift_count + ' shift' + (p.shift_count === 1 ? '' : 's') +
            (lastSeen ? ' · last ' + escapeHtml(lastSeen) : '') +
          '</div>' +
          (openLink ? '<div class="dm-open">' + openLink + '</div>' : '') +
          suggestionBlk +
          pickerBlk +
        '</div>'
      );
    }).join("");
  }

  // Sync status / raw diagnostics summary shown in the collapsed
  // disclosure on the admin Deputy tab. Pulls the latest last_synced_at
  // across the loaded window so admin can confirm Deputy data is fresh.
  function renderDeputyMappingSummary() {
    const el = $("deputy-mapping-summary");
    if (!el) return;
    let latest = 0;
    deputyMappingShifts.forEach(function (s) {
      const t = toMillis(s.last_synced_at);
      if (t > latest) latest = t;
    });
    const lastSync = latest
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          dateStyle: "medium", timeStyle: "short"
        }).format(new Date(latest))
      : "unknown";
    el.textContent =
      "Lookback: last " + DEPUTY_MAPPING_LOOKBACK_DAYS + " days of cached shifts " +
      "(" + deputyMappingShifts.length + " shift" + (deputyMappingShifts.length === 1 ? "" : "s") + "). " +
      "Last sync: " + lastSync + " PT. " +
      "Customer mapping was removed from Deputy for the pilot — techs pick customer on the DCR.";
  }

  const DEPUTY_MAPPING_LOOKBACK_DAYS = 14;

  async function loadDeputyMapping() {
    setDeputyMappingState("loading");
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - DEPUTY_MAPPING_LOOKBACK_DAYS);
      const cutoffDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric", month: "2-digit", day: "2-digit"
      }).format(cutoff);
      const [shiftsSnap, aliasesSnap] = await Promise.all([
        db().collection("deputy_shift_cache")
          .where("sync_date", ">=", cutoffDate)
          .get(),
        db().collection("customer_aliases").get()
      ]);
      deputyMappingShifts = shiftsSnap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      customerAliases = aliasesSnap.docs.map(function (d) {
        return Object.assign({ id: d.id }, d.data());
      });
      // We always render — even when no Deputy shifts exist the
      // alias manager is still useful for admin curation.
      renderDeputyMappingSummary();
      renderDeputyMappingEmployees();
      renderDeputyConnectionHealth();
      renderDeputyCompanies();
      renderAliasManager();
      renderUnmappedDeputyLocations();
      if (deputyMappingShifts.length === 0 && customerAliases.length === 0) {
        setDeputyMappingState("empty");
      } else {
        setDeputyMappingState("content");
      }
    } catch (err) {
      console.error("[deputy-mapping] load failed", err);
      const msg = (err && err.code === "permission-denied")
        ? "Permission denied — only admins can read Deputy mapping data."
        : ("Couldn't load Deputy data: " + (err && err.message || "unknown"));
      setDeputyMappingState("error", msg);
    }
  }

  // ===================================================================
  // CUSTOMER ALIAS MANAGER
  // ===================================================================
  // Tally how many cached shifts in the lookback window cite a given
  // alias (via suggested_customer_source). Cheap O(N) scan since the
  // cache window is already loaded.
  function countAliasUsage(alias) {
    const normalized = normalizeAlias(alias.alias);
    const slug = String(alias.customer_slug || "").trim();
    let count = 0;
    deputyMappingShifts.forEach(function (s) {
      if (!s.suggested_customer_slug || s.suggested_customer_slug !== slug) return;
      // Source format: "code:NOTL" / "name_match:instructions" / "alias_match:location_name".
      // The bracket code path embeds the code itself in the source string;
      // text-match paths attribute by field name only. Count any source
      // where the resolved slug matches this alias's slug AND either:
      //   - the source carries the alias verbatim (code:NOTL), or
      //   - the alias is one of the customer's known keys (we accept
      //     any same-slug suggestion as "this alias contributed").
      const src = String(s.suggested_customer_source || "");
      if (!src) return;
      if (src.startsWith("code:")) {
        if (src.slice(5).toUpperCase() === String(alias.alias).toUpperCase()) {
          count += 1;
          return;
        }
      } else {
        // Text-match path — accept if the alias appears as a normalized
        // substring of any shift text field.
        const fields = [s.instructions, s.memo, s.operational_unit_memo, s.location_name, s.company_name];
        for (let i = 0; i < fields.length; i++) {
          if (normalizeAlias(fields[i]).indexOf(normalized) !== -1) { count += 1; return; }
        }
      }
    });
    return count;
  }

  // ===================================================================
  // DEPUTY COMPANIES → PIONEER CUSTOMERS (primary mapping)
  // ===================================================================
  // Aggregates distinct (deputy_company_id, deputy_company_name) pairs
  // observed on recent cache docs. For each unique Deputy company we
  // show: the Pioneer customer it's currently mapped to (via
  // customers.deputy_company_id), or an Unmapped pill + picker to map
  // it once. Mapping writes deputy_company_id + deputy_company_name
  // to the chosen customer doc; next sync auto-resolves every shift
  // for that company at matchSource="deputy_company_id", confidence="exact".

  function aggregateDeputyCompanies() {
    const byKey = new Map();
    deputyMappingShifts.forEach(function (s) {
      const id   = (typeof s.deputy_company_id === "number" && s.deputy_company_id > 0)
                     ? s.deputy_company_id
                     : null;
      const name = String(s.deputy_company_name || "").trim();
      // Key by id when present (most stable); else by normalized name.
      const key = id != null
                    ? "id:" + id
                    : (name ? "name:" + normalizeAlias(name) : "");
      if (!key) return;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key:                  key,
          deputy_company_id:    id,
          deputy_company_name:  name,
          deputy_company_code:  String(s.deputy_company_code || "").trim(),
          deputy_label:         String(s.deputy_label_with_company || "").trim(),
          shift_count:          0,
          last_seen:            null,
          sample_employee:      "",
          sample_url:           "",
          // The match the sync produced. When match_source is
          // "deputy_company_id" the row is already mapped via the
          // canonical field; otherwise admin should map it here.
          last_match_source:    String(s.match_source || ""),
          last_customer_slug:   String(s.customer_slug || ""),
          last_customer_name:   String(s.customer_name || "")
        });
      }
      const g = byKey.get(key);
      g.shift_count += 1;
      const t = toMillis(s.start_time);
      if (t > (g.last_seen || 0)) g.last_seen = t;
      if (!g.sample_employee && s.employee_display_name) g.sample_employee = s.employee_display_name;
      if (!g.sample_url      && s.deputy_shift_url)      g.sample_url      = s.deputy_shift_url;
    });
    return Array.from(byKey.values()).sort(function (a, b) {
      return (a.deputy_company_name || "").localeCompare(b.deputy_company_name || "");
    });
  }

  // Build customer lookups by Deputy Company.Id. Two separate indexes:
  //   • activeByCompanyId — active customers only
  //   • inactiveByCompanyId — inactive customers only (for warning state)
  //   • duplicateActiveByCompanyId — companyId → [activeCustomer,...]
  //     populated when two-plus active customers share the same id
  function buildCustomerByDeputyCompanyIndex() {
    const customers = getCustomers();
    const activeByCompanyId    = {};
    const inactiveByCompanyId  = {};
    const duplicateActiveByCompanyId = {};
    customers.forEach(function (c) {
      const cid = c.deputy_company_id != null && c.deputy_company_id !== ""
                    ? c.deputy_company_id
                    : c.deputy_location_id;
      if (cid == null || cid === "") return;
      const key = String(cid);
      if (!getActive(c)) {
        if (!inactiveByCompanyId[key]) inactiveByCompanyId[key] = c;
        return;
      }
      if (activeByCompanyId[key]) {
        if (!duplicateActiveByCompanyId[key]) {
          duplicateActiveByCompanyId[key] = [activeByCompanyId[key]];
        }
        duplicateActiveByCompanyId[key].push(c);
      } else {
        activeByCompanyId[key] = c;
      }
    });
    return {
      active:    activeByCompanyId,
      inactive:  inactiveByCompanyId,
      duplicate: duplicateActiveByCompanyId
    };
  }

  // Compute the single status that applies to a given Deputy company.
  // Priority: Duplicate > Inactive > No Company ID > Mapped > Alias Fallback > Needs Mapping.
  function deputyCompanyStatus(g, idx) {
    const cid = g.deputy_company_id;
    if (cid == null || cid === "") {
      return { code: "no_id",        label: "No Company ID" };
    }
    const key = String(cid);
    if (idx.duplicate[key]) {
      return {
        code: "duplicate",
        label: "Duplicate Mapping",
        offending: idx.duplicate[key]
      };
    }
    if (idx.active[key]) {
      return { code: "mapped", label: "Mapped", customer: idx.active[key] };
    }
    if (idx.inactive[key]) {
      return { code: "inactive", label: "Inactive Customer", customer: idx.inactive[key] };
    }
    // No customer claims this Company.Id. If the sync is currently
    // resolving these shifts via the alias path, surface that.
    if (g.last_match_source === "alias") {
      return { code: "alias_fallback", label: "Alias Fallback" };
    }
    return { code: "needs_mapping", label: "Needs Mapping" };
  }

  function renderDeputyCompanies() {
    const root    = $("deputy-companies-list");
    const totalEl = $("deputy-companies-total");
    if (!root) return;
    const customers = getCustomers();
    const rows = aggregateDeputyCompanies();
    const idx  = buildCustomerByDeputyCompanyIndex();

    let mapped = 0, needs = 0, dupes = 0, inactive = 0, fallback = 0, noid = 0;
    rows.forEach(function (g) {
      const st = deputyCompanyStatus(g, idx);
      if (st.code === "mapped")         mapped   += 1;
      else if (st.code === "duplicate") dupes    += 1;
      else if (st.code === "inactive")  inactive += 1;
      else if (st.code === "no_id")     noid     += 1;
      else if (st.code === "alias_fallback") fallback += 1;
      else                              needs    += 1;
    });
    if (totalEl) {
      totalEl.textContent =
        mapped + " mapped · " +
        needs + " needs mapping" +
        (dupes    ? " · " + dupes + " duplicate"     : "") +
        (inactive ? " · " + inactive + " inactive"   : "") +
        (fallback ? " · " + fallback + " via alias"  : "") +
        (noid     ? " · " + noid + " no id"          : "");
    }
    if (rows.length === 0) {
      root.innerHTML =
        '<p class="dm-empty-state">' +
          '<strong>No Deputy companies in the recent shift cache.</strong> ' +
          'Wait for the next scheduled sync (every 10 min), then refresh.' +
        '</p>';
      return;
    }
    // Customer picker options. Inactive customers are HIDDEN by default
    // (safety — prevents mapping a Deputy company to an archived
    // customer). Admin can toggle "Show inactive" to surface them with
    // a visible marker.
    const customerOptionsHtml = customers
      .filter(function (c) { return showInactiveInCustomerPicker || getActive(c); })
      .sort(function (a, b) {
        // Active first, then alphabetical.
        const ai = getActive(a) ? 0 : 1;
        const bi = getActive(b) ? 0 : 1;
        if (ai !== bi) return ai - bi;
        return getCustomerName(a).localeCompare(getCustomerName(b));
      })
      .map(function (c) {
        const inactive = !getActive(c);
        return '<option value="' + escapeHtml(getCustomerSlug(c)) + '"' +
                 (inactive ? ' data-inactive="true"' : '') + '>' +
                 escapeHtml(getCustomerName(c)) +
                 (inactive ? "  (inactive)" : "") +
               '</option>';
      }).join("");
    // "Show inactive" toggle row, rendered once at the top of the list.
    const showInactiveToggleHtml =
      '<div class="dm-show-inactive-row">' +
        '<button type="button" class="dm-btn dm-btn-secondary dm-btn-sm"' +
          ' data-action="toggle-show-inactive">' +
          (showInactiveInCustomerPicker
            ? "Hide inactive customers"
            : "Show inactive customers in picker") +
        '</button>' +
        (showInactiveInCustomerPicker
          ? '<span class="dm-show-inactive-note">Inactive customers visible (use with care).</span>'
          : '') +
      '</div>';
    root.innerHTML = rows.map(function (g) {
      const cid = g.deputy_company_id;
      const lastSeen = fmtLastSeenPT(g.last_seen);
      const status = deputyCompanyStatus(g, idx);
      const pillClass = ({
        mapped:         "is-mapped",
        needs_mapping:  "is-unmapped",
        duplicate:      "is-duplicate",
        inactive:       "is-inactive",
        no_id:          "is-unmapped",
        alias_fallback: "is-suggestion"
      })[status.code] || "is-unmapped";

      // Rename-safe display: if the mapped customer's stored
      // deputy_company_name differs from the live name we see in
      // recent cache, surface both so admin notices the rename.
      let renameNote = "";
      if (status.customer && status.customer.deputy_company_name &&
          g.deputy_company_name &&
          String(status.customer.deputy_company_name).trim() !==
          String(g.deputy_company_name).trim()) {
        renameNote =
          '<div class="dm-rename-note">' +
            'Stored on customer doc as <em>' + escapeHtml(status.customer.deputy_company_name) + '</em>; ' +
            'currently named in Deputy as <strong>' + escapeHtml(g.deputy_company_name) + '</strong>. ' +
            'Matching still works via Company.Id — no action needed.' +
          '</div>';
      }

      // Duplicate detail panel — list every offending Pioneer customer.
      // Each entry gets a "Keep this mapping" button that promotes one
      // customer as the owner and removes deputy_company_id from the
      // others in one batch.
      let duplicateDetail = "";
      if (status.code === "duplicate" && Array.isArray(status.offending)) {
        duplicateDetail =
          '<div class="dm-warning-detail">' +
            '<strong>Duplicate Deputy company mapping.</strong> ' +
            String(status.offending.length) + ' Pioneer customers claim Deputy Company ID ' +
            escapeHtml(String(cid)) + '. Today\'s Work will <strong>not</strong> auto-resolve ' +
            'these shifts until you pick one. The first customer alphabetically is the ' +
            'current "owner" of the mapping in the index — but the resolver does not ' +
            'auto-pick because of this ambiguity.' +
            '<ul class="dm-duplicate-list">' +
              status.offending.map(function (c) {
                return '<li>' +
                  '<span class="dm-duplicate-name">' +
                    escapeHtml(getCustomerName(c)) +
                    ' <code>' + escapeHtml(getCustomerSlug(c)) + '</code>' +
                  '</span>' +
                  '<button class="dm-btn dm-btn-primary dm-btn-sm" type="button"' +
                    ' data-action="keep-duplicate-mapping"' +
                    ' data-keep-slug="' + escapeHtml(getCustomerSlug(c)) + '"' +
                    ' data-deputy-company-id="' + escapeHtml(String(cid)) + '"' +
                    '>Keep this mapping</button>' +
                '</li>';
              }).join("") +
            '</ul>' +
          '</div>';
      }

      // Inactive detail panel.
      let inactiveDetail = "";
      if (status.code === "inactive" && status.customer) {
        inactiveDetail =
          '<div class="dm-warning-detail">' +
            '<strong>Mapped to inactive customer.</strong> ' +
            'Deputy Company ID ' + escapeHtml(String(cid)) + ' is currently mapped to ' +
            '<em>' + escapeHtml(getCustomerName(status.customer)) + '</em>, which is archived. ' +
            'Shifts for this company stay <strong>unresolved</strong> on Today\'s Work; ' +
            'either reactivate the customer or remap to a different one below.' +
          '</div>';
      }

      const dataAttrs =
        ' data-deputy-company-id="' + escapeHtml(cid != null ? String(cid) : "") + '"' +
        ' data-deputy-company-name="' + escapeHtml(g.deputy_company_name || "") + '"';

      return (
        '<div class="dm-card" role="listitem">' +
          '<div class="dm-card-head">' +
            '<div class="dm-headline">' +
              escapeHtml(g.deputy_company_name || "(unnamed Deputy company)") +
            '</div>' +
            '<span class="mapping-pill ' + pillClass + '">' + escapeHtml(status.label) +
              (status.code === "mapped" && status.customer
                ? ' → ' + escapeHtml(getCustomerName(status.customer))
                : '') +
            '</span>' +
          '</div>' +
          '<div class="dm-footnote">' +
            (cid != null ? 'Deputy Company ID ' + escapeHtml(String(cid)) + ' · ' : '') +
            (g.deputy_company_code ? 'Code <code>' + escapeHtml(g.deputy_company_code) + '</code> · ' : '') +
            'Seen in ' + g.shift_count + ' shift' + (g.shift_count === 1 ? '' : 's') +
            (lastSeen ? ' · last ' + escapeHtml(lastSeen) : '') +
          '</div>' +
          (g.sample_url
            ? '<div class="dm-open"><a class="deputy-open-link" href="' + escapeHtml(g.sample_url) +
              '" target="_blank" rel="noopener">Open in Deputy ↗</a></div>'
            : '') +
          renameNote +
          duplicateDetail +
          inactiveDetail +
          (status.code === "mapped" && status.customer
            ? '<div class="dm-mapped-detail">' +
                'Linked to <strong>' + escapeHtml(getCustomerName(status.customer)) + '</strong> ' +
                '(<code>' + escapeHtml(getCustomerSlug(status.customer)) + '</code>) via ' +
                '<code>customers.deputy_company_id</code>.' +
                ' <button class="dm-btn dm-btn-secondary dm-btn-sm" type="button"' +
                  ' data-action="remove-deputy-company-mapping"' +
                  ' data-keep-slug="' + escapeHtml(getCustomerSlug(status.customer)) + '"' +
                  ' data-deputy-company-id="' + escapeHtml(String(cid)) + '">' +
                  'Remove mapping</button>' +
              '</div>'
            : '') +
          (cid != null
            ? '<div class="dm-picker">' +
                '<label class="dm-picker-label">' +
                  (status.code === "mapped"
                    ? 'Change mapping to a different Pioneer customer:'
                    : 'Map this Deputy company to a Pioneer customer (one-time):') +
                '</label>' +
                '<div class="dm-picker-row">' +
                  '<select class="dm-select" data-pick="deputy-company"' + dataAttrs + '>' +
                    '<option value="">— Pick a Pioneer customer —</option>' + customerOptionsHtml +
                  '</select>' +
                  '<button class="dm-btn dm-btn-primary is-disabled" type="button"' +
                    ' data-action="map-deputy-company"' +
                    dataAttrs + ' disabled>Pick customer first</button>' +
                '</div>' +
              '</div>'
            : '') +
        '</div>'
      );
    }).join("");
    // Inject the "Show inactive" toggle row at the top of the list.
    root.innerHTML = showInactiveToggleHtml + root.innerHTML;
  }

  // Connection Health — top-of-panel status banner. Reads from the
  // already-loaded shift cache + alias collection, no extra round trips.
  function renderDeputyConnectionHealth() {
    const root        = $("deputy-health-stats");
    const summaryEl   = $("deputy-health-summary");
    const warningsEl  = $("deputy-health-warnings");
    if (!root) return;

    const idx = buildCustomerByDeputyCompanyIndex();
    // Aggregate match-source counts across the loaded shifts.
    const counts = {
      total:               deputyMappingShifts.length,
      by_deputy_company_id:  0,
      by_deputy_company_name: 0,
      by_alias:              0,
      duplicate:             0,
      inactive:              0,
      none:                  0
    };
    let latestSyncMs = 0;
    deputyMappingShifts.forEach(function (s) {
      const t = toMillis(s.last_synced_at);
      if (t > latestSyncMs) latestSyncMs = t;
      const src = String(s.match_source || "");
      if (s.duplicate_mapping)                   counts.duplicate += 1;
      else if (s.inactive_customer)              counts.inactive += 1;
      else if (src === "deputy_company_id")      counts.by_deputy_company_id += 1;
      else if (src === "deputy_company_name")    counts.by_deputy_company_name += 1;
      else if (src === "alias")                  counts.by_alias += 1;
      else                                       counts.none += 1;
    });

    const lastSyncLabel = latestSyncMs
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: "America/Los_Angeles",
          dateStyle: "medium", timeStyle: "short"
        }).format(new Date(latestSyncMs))
      : "unknown";

    if (summaryEl) {
      summaryEl.textContent = counts.total + " shift" + (counts.total === 1 ? "" : "s") +
        " · last sync " + lastSyncLabel + " PT";
    }

    // Build warning banners for any Pioneer-side duplicates / inactive
    // mappings discovered while indexing customers (covers cases where
    // no shifts have hit them yet).
    const warnings = [];
    Object.keys(idx.duplicate).forEach(function (cid) {
      const dupes = idx.duplicate[cid] || [];
      warnings.push({
        kind:  "duplicate",
        label: "Duplicate Deputy company mapping",
        body:  "Deputy Company ID " + cid + " is claimed by " + dupes.length +
               " Pioneer customers: " + dupes.map(function (c) { return getCustomerName(c); }).join(", ") + "."
      });
    });
    Object.keys(idx.inactive).forEach(function (cid) {
      const c = idx.inactive[cid];
      // Only warn when this inactive mapping is actually causing
      // unresolved shifts (i.e. there's no active customer with the
      // same id AND the sync flagged inactive_customer).
      if (idx.active[cid]) return;
      const usedOnShift = deputyMappingShifts.some(function (s) {
        return String(s.deputy_company_id || "") === cid && s.inactive_customer;
      });
      if (!usedOnShift) return;
      warnings.push({
        kind:  "inactive",
        label: "Inactive customer holds Deputy company mapping",
        body:  "Deputy Company ID " + cid + " is mapped to inactive customer " +
               getCustomerName(c) + ". Shifts stay unresolved until you reactivate or remap."
      });
    });

    if (warningsEl) {
      warningsEl.innerHTML = warnings.map(function (w) {
        return '<div class="dm-health-warning is-' + w.kind + '">' +
                 '<strong>' + escapeHtml(w.label) + '.</strong> ' +
                 escapeHtml(w.body) +
               '</div>';
      }).join("");
    }

    // ---- Top-line Mapping Health banner ----
    // Roll up the per-shift counts into per-company counts: distinct
    // Deputy companies (across loaded shifts) classified into mapped,
    // duplicate, unmapped (no Pioneer customer claims the id), or
    // inactive-conflict (only an inactive customer claims it). Banner
    // color: GREEN when zero issues, AMBER when only unmapped, RED
    // when duplicates exist.
    const companyStats = (function () {
      const rowsAgg = aggregateDeputyCompanies();
      const out = { mapped: 0, duplicate: 0, unmapped: 0, inactive: 0, no_id: 0 };
      rowsAgg.forEach(function (g) {
        const st = deputyCompanyStatus(g, idx);
        if (st.code === "mapped")         out.mapped   += 1;
        else if (st.code === "duplicate") out.duplicate += 1;
        else if (st.code === "inactive")  out.inactive  += 1;
        else if (st.code === "no_id")     out.no_id     += 1;
        else                              out.unmapped  += 1;
      });
      return out;
    })();
    const healthLevel = companyStats.duplicate > 0
                          ? "red"
                          : (companyStats.unmapped > 0 || companyStats.inactive > 0
                              ? "amber"
                              : "green");
    const healthBannerHtml =
      '<div class="dm-health-banner is-' + healthLevel + '">' +
        '<div class="dm-health-banner-title">' +
          'Mapping Health ' +
          '<span class="dm-health-banner-pill">' +
            (healthLevel === "green" ? "All clear"
              : healthLevel === "amber" ? "Action recommended"
              : "Action required") +
          '</span>' +
        '</div>' +
        '<ul class="dm-health-banner-list">' +
          '<li>' + companyStats.mapped + ' mapped</li>' +
          '<li>' + companyStats.duplicate + ' duplicate' + (companyStats.duplicate === 1 ? "" : "s") + '</li>' +
          '<li>' + companyStats.unmapped + ' unmapped</li>' +
          '<li>' + companyStats.inactive + ' inactive conflict' + (companyStats.inactive === 1 ? "" : "s") + '</li>' +
        '</ul>' +
      '</div>';

    root.innerHTML =
      healthBannerHtml +
      '<div class="dm-health-grid">' +
        '<div class="dm-health-stat"><span class="dm-health-num">' + counts.by_deputy_company_id + '</span><span class="dm-health-label">via Company ID</span></div>' +
        '<div class="dm-health-stat"><span class="dm-health-num">' + counts.by_deputy_company_name + '</span><span class="dm-health-label">via Company name</span></div>' +
        '<div class="dm-health-stat"><span class="dm-health-num">' + counts.by_alias + '</span><span class="dm-health-label">via alias</span></div>' +
        '<div class="dm-health-stat"><span class="dm-health-num">' + counts.duplicate + '</span><span class="dm-health-label">duplicate</span></div>' +
        '<div class="dm-health-stat"><span class="dm-health-num">' + counts.inactive + '</span><span class="dm-health-label">inactive</span></div>' +
        '<div class="dm-health-stat"><span class="dm-health-num">' + counts.none + '</span><span class="dm-health-label">unmapped</span></div>' +
      '</div>';
  }

  async function mapDeputyCompanyToCustomer(opts) {
    const slug = opts.customer_slug;
    const cid  = opts.deputy_company_id;
    const name = opts.deputy_company_name || "";
    if (!slug)              { showToast("err", "Pick a customer first."); return; }
    if (cid == null || cid === "") { showToast("err", "Missing Deputy Company ID."); return; }
    // Safety: refuse to map to an inactive customer unless the picker
    // is in "show inactive" mode AND admin really meant it. We can't
    // tell which here, so just block silently — the inactive option
    // in the picker is already labeled "(inactive)".
    const targetCustomer = getCustomers().find(function (c) { return getCustomerSlug(c) === slug; });
    if (targetCustomer && !getActive(targetCustomer) && !showInactiveInCustomerPicker) {
      showToast("err", "That customer is inactive. Toggle 'Show inactive' first if you really want to map it.");
      return;
    }
    try {
      await db().collection("customers").doc(slug).update({
        deputy_company_id:    Number(cid) || cid,
        deputy_company_name:  name,
        updated_at:           firebase.firestore.FieldValue.serverTimestamp(),
        updated_by:           getCurrentAdminEmail()
      });
      showToast("ok", "Mapped Deputy company to customer. Next sync auto-resolves every matching shift.");
      await window.__pioneerAdmin.tabs.customers.refresh();
      renderDeputyCompanies();
      renderDeputyConnectionHealth();
    } catch (err) {
      handleAdminWriteError(err, { context: "map deputy company to customer" });
    }
  }

  // Remove the Deputy company mapping from a customer doc. Preserves
  // every other field (including aliases) so the customer keeps
  // working normally — just no longer auto-resolves Deputy shifts.
  async function removeCompanyMapping(slug, cid) {
    if (!slug) { showToast("err", "Missing customer slug."); return; }
    const customer = getCustomers().find(function (c) { return getCustomerSlug(c) === slug; });
    if (!customer) { showToast("err", "Couldn't find that customer."); return; }
    const msg = "Remove Deputy company mapping from this customer?\n\n" +
                'Customer: ' + getCustomerName(customer) + '\n' +
                'Deputy Company ID: ' + cid + '\n\n' +
                "The customer stays active — only the Deputy link is removed. " +
                "Aliases and all other settings are preserved.";
    if (!window.confirm(msg)) return;
    try {
      await db().collection("customers").doc(slug).update({
        deputy_company_id:    firebase.firestore.FieldValue.delete(),
        deputy_company_name:  firebase.firestore.FieldValue.delete(),
        updated_at:           firebase.firestore.FieldValue.serverTimestamp(),
        updated_by:           getCurrentAdminEmail()
      });
      showToast("ok", "Deputy company mapping removed.");
      await window.__pioneerAdmin.tabs.customers.refresh();
      renderDeputyCompanies();
      renderDeputyConnectionHealth();
    } catch (err) {
      handleAdminWriteError(err, { context: "remove deputy company mapping" });
    }
  }

  // Resolve a duplicate-mapping conflict: keep the chosen customer's
  // deputy_company_id, remove it from every other customer that
  // claimed the same id. Atomic per-customer writes; toast on success.
  async function keepDuplicateMapping(keepSlug, cid) {
    if (!keepSlug)          { showToast("err", "Missing customer slug."); return; }
    if (cid == null || cid === "") { showToast("err", "Missing Deputy Company ID."); return; }
    const cidStr = String(cid);
    // Find every customer currently claiming this Company.Id.
    const claimants = getCustomers().filter(function (c) {
      const ccid = c.deputy_company_id != null && c.deputy_company_id !== ""
                     ? c.deputy_company_id
                     : c.deputy_location_id;
      return ccid != null && String(ccid) === cidStr;
    });
    const keepCustomer = claimants.find(function (c) { return getCustomerSlug(c) === keepSlug; });
    if (!keepCustomer) {
      showToast("err", "The customer you chose isn't in the duplicate set anymore. Refresh and retry.");
      return;
    }
    const toRemove = claimants.filter(function (c) { return getCustomerSlug(c) !== keepSlug; });
    if (toRemove.length === 0) {
      showToast("ok", "Already resolved — no other claimants found.");
      await window.__pioneerAdmin.tabs.customers.refresh();
      renderDeputyCompanies();
      renderDeputyConnectionHealth();
      return;
    }
    const msg = "Keep Deputy Company ID " + cidStr + " on " +
                getCustomerName(keepCustomer) + " and remove it from " +
                toRemove.length + " other customer" +
                (toRemove.length === 1 ? "" : "s") + "?\n\n" +
                toRemove.map(function (c) { return "  • " + getCustomerName(c); }).join("\n");
    if (!window.confirm(msg)) return;
    try {
      const batch = db().batch();
      toRemove.forEach(function (c) {
        const ref = db().collection("customers").doc(getCustomerSlug(c));
        batch.update(ref, {
          deputy_company_id:    firebase.firestore.FieldValue.delete(),
          deputy_company_name:  firebase.firestore.FieldValue.delete(),
          updated_at:           firebase.firestore.FieldValue.serverTimestamp(),
          updated_by:           getCurrentAdminEmail()
        });
      });
      await batch.commit();
      showToast("ok", "Duplicate resolved.");
      await window.__pioneerAdmin.tabs.customers.refresh();
      renderDeputyCompanies();
      renderDeputyConnectionHealth();
    } catch (err) {
      handleAdminWriteError(err, { context: "resolve duplicate company mapping" });
    }
  }

  // ===================================================================
  // ALIAS AUDIT — surface flagged aliases for admin review.
  // ===================================================================
  // Reasons we flag:
  //   • conflict      — same normalized form points at 2+ customers
  //   • duplicate     — same normalized form, same customer, multiple docs
  //   • too_short     — normalized length < 5 (inert at suggestion time)
  //   • generic_word  — normalized form is in SUGGEST_DENY
  //   • unusual_match — alias and customer name share no substring overlap
  //                     AND alias doesn't look like a shorthand code
  //   • disabled      — already inactive (informational)
  //
  // Auto-classified kinds (when alias_kind is unset):
  //   • shorthand_code         — 2-8 char all-caps token
  //   • deputy_location_name   — alias exactly equals customer name
  //   • normalized_customer_name — alias is a substring of customer name (or vice versa)
  //   • manual                 — falls through

  // Mirror of the backend SUGGEST_DENY list — kept in sync by inspection.
  const ALIAS_AUDIT_DENY = new Set([
    "pioneer", "pioneercommercialcleaning", "commercialcleaning",
    "cleaningtech", "technician", "admin", "office", "route",
    "shift", "coverage", "floater", "training"
  ]);
  const ALIAS_AUDIT_MIN_LEN = 5;

  function isShorthandPattern(text) {
    const s = String(text || "").trim();
    return /^[A-Z0-9][A-Z0-9 ]{1,7}$/.test(s);
  }

  function classifyAliasKind(a) {
    if (a.alias_kind && typeof a.alias_kind === "string") return a.alias_kind;
    const alias = String(a.alias || "");
    const cname = String(a.customer_name || "");
    if (isShorthandPattern(alias)) return "shorthand_code";
    if (alias && cname && alias.trim().toLowerCase() === cname.trim().toLowerCase()) {
      return "deputy_location_name";
    }
    const an = normalizeAlias(alias);
    const cn = normalizeAlias(cname);
    if (an && cn && an.length >= 4 &&
        (cn.indexOf(an) !== -1 || an.indexOf(cn) !== -1)) {
      return "normalized_customer_name";
    }
    return "manual";
  }

  function computeAliasAudit() {
    const byNorm = new Map();   // normalized → [aliasDoc...]
    customerAliases.forEach(function (a) {
      const norm = String(a.normalized_alias || normalizeAlias(a.alias) || "");
      if (!norm) return;
      if (!byNorm.has(norm)) byNorm.set(norm, []);
      byNorm.get(norm).push(a);
    });
    const flagged = [];
    customerAliases.forEach(function (a) {
      const norm = String(a.normalized_alias || normalizeAlias(a.alias) || "");
      const reasons = [];
      const sameNorm = byNorm.get(norm) || [];
      const distinctSlugs = new Set(sameNorm.map(function (x) { return String(x.customer_slug || ""); }));
      if (norm.length < ALIAS_AUDIT_MIN_LEN) reasons.push("too_short");
      if (norm && ALIAS_AUDIT_DENY.has(norm)) reasons.push("generic_word");
      if (distinctSlugs.size > 1) reasons.push("conflict");
      if (sameNorm.length > 1 && distinctSlugs.size === 1) reasons.push("duplicate");
      const cn = normalizeAlias(a.customer_name || "");
      if (norm && cn && norm.length >= 4 &&
          cn.indexOf(norm) === -1 && norm.indexOf(cn) === -1 &&
          !isShorthandPattern(a.alias)) {
        reasons.push("unusual_match");
      }
      if (reasons.length) {
        flagged.push({
          doc: a,
          normalized: norm,
          reasons: reasons,
          kind: classifyAliasKind(a),
          conflict_slugs: Array.from(distinctSlugs)
        });
      }
    });
    return {
      flagged:     flagged,
      conflictCount: flagged.filter(function (f) { return f.reasons.indexOf("conflict") !== -1; }).length,
      activeCount:  customerAliases.filter(function (a) { return a.active !== false; }).length,
      disabledCount: customerAliases.filter(function (a) { return a.active === false; }).length
    };
  }

  function renderAliasAudit() {
    const root      = $("alias-audit-list");
    const summaryEl = $("alias-audit-summary");
    const actionBtn = $("alias-audit-disable-conflicts");
    if (!root || !summaryEl) return;
    const audit = computeAliasAudit();
    summaryEl.textContent =
      audit.activeCount + " active · " +
      audit.disabledCount + " disabled · " +
      audit.conflictCount + " conflict" + (audit.conflictCount === 1 ? "" : "s");
    // Action button only when there ARE conflicts to act on.
    if (actionBtn) {
      const conflictsActive = audit.flagged.some(function (f) {
        return f.reasons.indexOf("conflict") !== -1 && f.doc.active !== false;
      });
      actionBtn.hidden = !conflictsActive;
    }
    if (audit.flagged.length === 0) {
      root.innerHTML =
        '<p class="dm-empty-state">' +
          '<strong>No flagged aliases.</strong> ' +
          'Audit passes — every alias is unambiguous, has min-length, and is not in the deny-list.' +
        '</p>';
      return;
    }
    // Sort: conflicts first, then generic, then duplicate, then short, then unusual.
    const order = { conflict: 0, generic_word: 1, duplicate: 2, too_short: 3, unusual_match: 4 };
    function reasonRank(reasons) {
      let best = 99;
      reasons.forEach(function (r) { if (order[r] < best) best = order[r]; });
      return best;
    }
    const rows = audit.flagged.slice().sort(function (a, b) {
      return reasonRank(a.reasons) - reasonRank(b.reasons);
    });
    const reasonLabel = {
      conflict:      "conflict",
      duplicate:     "duplicate",
      too_short:     "too short",
      generic_word:  "generic word",
      unusual_match: "unusual mapping"
    };
    root.innerHTML = rows.map(function (f) {
      const a = f.doc;
      const isActive = a.active !== false;
      const reasonChips = f.reasons.map(function (r) {
        const cls = "dm-flag-chip is-" + r.replace(/_/g, "-");
        return '<span class="' + cls + '">' + escapeHtml(reasonLabel[r] || r) + '</span>';
      }).join(" ");
      return (
        '<div class="alias-audit-row' + (isActive ? '' : ' is-inactive') + '"' +
          ' data-alias-id="' + escapeHtml(a.id || "") + '"' +
          ' role="listitem">' +
          '<div class="alias-audit-alias">' +
            '<code>' + escapeHtml(a.alias || "") + '</code>' +
            '<span class="alias-row-source">' + escapeHtml(f.kind) + '</span>' +
          '</div>' +
          '<div class="alias-row-arrow" aria-hidden="true">→</div>' +
          '<div class="alias-audit-customer">' +
            escapeHtml(a.customer_name || a.customer_slug || "?") +
          '</div>' +
          '<div class="alias-audit-reasons">' + reasonChips + '</div>' +
          '<div class="alias-row-actions">' +
            '<button type="button" class="dm-btn dm-btn-secondary dm-btn-sm"' +
              ' data-action="alias-toggle">' +
              (isActive ? 'Disable' : 'Enable') +
            '</button>' +
            '<button type="button" class="dm-btn dm-btn-secondary dm-btn-sm"' +
              ' data-action="alias-delete">Delete</button>' +
          '</div>' +
        '</div>'
      );
    }).join("");
  }

  // Batch-disable every alias that's flagged as a conflict AND still active.
  async function disableFlaggedConflicts() {
    const audit = computeAliasAudit();
    const targets = audit.flagged.filter(function (f) {
      return f.reasons.indexOf("conflict") !== -1 && f.doc.active !== false;
    });
    if (targets.length === 0) {
      showToast("ok", "No active conflicts to disable.");
      return;
    }
    if (!confirm("Disable " + targets.length + " conflicting alias" +
                 (targets.length === 1 ? "" : "es") +
                 "? They'll stay in the table for audit; you can re-enable individually.")) {
      return;
    }
    try {
      // Batched commits — stay under the 500-write limit per batch.
      for (let i = 0; i < targets.length; i += 400) {
        const batch = db().batch();
        targets.slice(i, i + 400).forEach(function (f) {
          const ref = db().collection("customer_aliases").doc(f.doc.id);
          batch.set(ref, {
            customer_slug:    f.doc.customer_slug || "",
            customer_name:    f.doc.customer_name || "",
            active:           false,
            flagged_reasons:  f.reasons,
            updated_at:       firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        });
        await batch.commit();
      }
      showToast("ok", "Disabled " + targets.length + " conflicting alias" +
                       (targets.length === 1 ? "" : "es") + ".");
      await reloadAliases();
    } catch (err) {
      handleAdminWriteError(err, { context: "disable conflicting aliases" });
    }
  }

  function renderAliasManager() {
    populateAliasCreateCustomerOptions();
    renderAliasAudit();
    const root = $("alias-list");
    const totalEl = $("alias-manager-total");
    if (totalEl) {
      const active = customerAliases.filter(function (a) { return a.active !== false; }).length;
      totalEl.textContent = active + " active · " + customerAliases.length + " total";
    }
    if (!root) return;
    if (customerAliases.length === 0) {
      root.innerHTML =
        '<p class="dm-empty-state">' +
          '<strong>No aliases yet.</strong> Use the form above to add the first one, ' +
          'or use "Seed from existing customer fields" below to import known codes from <code>customers</code>.' +
        '</p>';
      return;
    }
    const rows = customerAliases.slice().sort(function (a, b) {
      const ai = a.active === false ? 1 : 0;
      const bi = b.active === false ? 1 : 0;
      if (ai !== bi) return ai - bi;
      return String(a.alias || "").localeCompare(String(b.alias || ""));
    });
    root.innerHTML = rows.map(function (a) {
      const used = countAliasUsage(a);
      const sourceLabel = a.source === "manual_seed"   ? "seeded"
                       : a.source === "admin_created"  ? "manual"
                       : a.source === "learned"        ? "learned"
                       : (a.source || "unknown");
      const kind = classifyAliasKind(a);
      const isActive = a.active !== false;
      return (
        '<div class="alias-row' + (isActive ? '' : ' is-inactive') + '" role="listitem"' +
          ' data-alias-id="' + escapeHtml(a.id || "") + '">' +
          '<div class="alias-row-alias">' +
            '<code>' + escapeHtml(a.alias || "") + '</code>' +
            '<span class="alias-row-source">' + escapeHtml(kind) +
              ' · ' + escapeHtml(sourceLabel) + '</span>' +
          '</div>' +
          '<div class="alias-row-arrow" aria-hidden="true">→</div>' +
          '<div class="alias-row-customer">' +
            escapeHtml(a.customer_name || a.customer_slug || "?") +
            '<span class="alias-row-slug">' + escapeHtml(a.customer_slug || "") + '</span>' +
          '</div>' +
          '<div class="alias-row-usage" title="Shifts in the last ' + DEPUTY_MAPPING_LOOKBACK_DAYS + ' days that cited this alias">' +
            (used > 0 ? used + ' recent shift' + (used === 1 ? '' : 's') : '<em>not seen recently</em>') +
          '</div>' +
          '<div class="alias-row-actions">' +
            '<button type="button" class="dm-btn dm-btn-secondary dm-btn-sm"' +
              ' data-action="alias-toggle">' +
              (isActive ? 'Disable' : 'Enable') +
            '</button>' +
            '<button type="button" class="dm-btn dm-btn-secondary dm-btn-sm"' +
              ' data-action="alias-delete">Delete</button>' +
          '</div>' +
        '</div>'
      );
    }).join("");
  }

  // Aggregate distinct UNMAPPED Deputy location names seen on recent
  // shifts. Each row in the rendered list is one click away from
  // creating an alias. "Unmapped" means: no customer_aliases entry
  // currently matches AND the sync produced no suggested_customer_*.
  function aggregateUnmappedDeputyLocations() {
    const aliasNormSet = new Set();
    customerAliases.forEach(function (a) {
      if (a.active === false) return;
      const n = String(a.normalized_alias || normalizeAlias(a.alias));
      if (n) aliasNormSet.add(n);
    });
    const byKey = new Map();
    deputyMappingShifts.forEach(function (s) {
      // Prefer Deputy's Company name (=deputy_location_name). Only
      // fall through to OperationalUnitName when no company is set —
      // it's usually a generic team label.
      const primary  = s.deputy_location_name || s.company_name || "";
      const fallback = s.deputy_operational_unit_name || s.location_name || "";
      const candidates = [];
      if (primary)  candidates.push({ text: primary,  source: "deputy_location_name" });
      if (fallback && fallback !== primary) {
        candidates.push({ text: fallback, source: "deputy_operational_unit_name" });
      }
      candidates.forEach(function (cand) {
        const text = String(cand.text || "").trim();
        if (!text) return;
        const norm = normalizeAlias(text);
        if (!norm) return;
        // Skip if there's already an alias entry covering this string.
        if (aliasNormSet.has(norm)) return;
        // Skip if the sync already produced a suggested customer for
        // this exact shift via some other path — admin doesn't need
        // to map it explicitly. (We still surface it if the same
        // location text appears on OTHER shifts without a suggestion.)
        const key = norm;
        if (!byKey.has(key)) {
          byKey.set(key, {
            key:           key,
            display:       text,
            source:        cand.source,
            shift_count:   0,
            last_seen:     null,
            sample_employee: "",
            sample_url:    ""
          });
        }
        const g = byKey.get(key);
        g.shift_count += 1;
        const t = toMillis(s.start_time);
        if (t > (g.last_seen || 0)) g.last_seen = t;
        if (!g.sample_employee && s.employee_display_name) g.sample_employee = s.employee_display_name;
        if (!g.sample_url      && s.deputy_shift_url)      g.sample_url = s.deputy_shift_url;
      });
    });
    return Array.from(byKey.values()).sort(function (a, b) {
      return b.shift_count - a.shift_count;
    });
  }

  function renderUnmappedDeputyLocations() {
    const root = $("unmapped-deputy-locations");
    const totalEl = $("unmapped-deputy-locations-total");
    if (!root) return;
    const customers = getCustomers();
    const rows = aggregateUnmappedDeputyLocations();
    if (totalEl) totalEl.textContent = rows.length + " unmapped";
    if (rows.length === 0) {
      root.innerHTML =
        '<p class="dm-empty-state">' +
          '<strong>Every Deputy location seen recently is already mapped.</strong> ' +
          'New names will appear here automatically as future shifts sync.' +
        '</p>';
      return;
    }
    const customerOptionsHtml = customers
      .filter(function (c) { return getActive(c); })
      .sort(function (a, b) { return getCustomerName(a).localeCompare(getCustomerName(b)); })
      .map(function (c) {
        return '<option value="' + escapeHtml(getCustomerSlug(c)) + '">' +
                 escapeHtml(getCustomerName(c)) +
               '</option>';
      }).join("");
    root.innerHTML = rows.map(function (g) {
      const lastSeen = fmtLastSeenPT(g.last_seen);
      const sourceLabel = g.source === "deputy_location_name"
        ? "Deputy location"
        : "Deputy operational unit";
      const dataAttrs =
        ' data-deputy-location-text="' + escapeHtml(g.display) + '"';
      return (
        '<div class="dm-card" role="listitem">' +
          '<div class="dm-card-head">' +
            '<div class="dm-headline">' +
              '<span class="dm-type-chip">' + escapeHtml(sourceLabel) + '</span> ' +
              escapeHtml(g.display) +
            '</div>' +
            '<span class="mapping-pill is-unmapped">Needs mapping</span>' +
          '</div>' +
          '<div class="dm-footnote">' +
            'Seen in ' + g.shift_count + ' shift' + (g.shift_count === 1 ? '' : 's') +
            (lastSeen ? ' · last ' + escapeHtml(lastSeen) : '') +
            (g.sample_employee ? ' · ' + escapeHtml(g.sample_employee) : '') +
          '</div>' +
          (g.sample_url
            ? '<div class="dm-open"><a class="deputy-open-link" href="' + escapeHtml(g.sample_url) +
              '" target="_blank" rel="noopener">Open in Deputy ↗</a></div>'
            : '') +
          '<div class="dm-picker">' +
            '<label class="dm-picker-label">Map this Deputy location to a Pioneer customer (one-time):</label>' +
            '<div class="dm-picker-row">' +
              '<select class="dm-select" data-pick="deputy-loc"' + dataAttrs + '>' +
                '<option value="">— Pick a Pioneer customer —</option>' + customerOptionsHtml +
              '</select>' +
              '<button class="dm-btn dm-btn-primary is-disabled" type="button"' +
                ' data-action="map-deputy-loc"' +
                dataAttrs + ' disabled>Pick customer first</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join("");
  }

  function populateAliasCreateCustomerOptions() {
    const sel = $("alias-create-customer");
    if (!sel) return;
    const customers = getCustomers();
    const currentValue = sel.value;
    const html = ['<option value="">— Pick a Pioneer customer —</option>']
      .concat(customers
        .filter(function (c) { return getActive(c); })
        .sort(function (a, b) { return getCustomerName(a).localeCompare(getCustomerName(b)); })
        .map(function (c) {
          return '<option value="' + escapeHtml(getCustomerSlug(c)) + '">' +
                   escapeHtml(getCustomerName(c)) +
                 '</option>';
        })).join("");
    sel.innerHTML = html;
    if (currentValue) sel.value = currentValue;
  }

  // Build the doc id we'll use for a given alias. Stable per
  // normalized alias text, so re-adding the same alias is a no-op
  // (and matches the backend's lookup).
  function aliasDocId(aliasText) {
    const norm = normalizeAlias(aliasText);
    return norm || "blank-" + Date.now();
  }

  async function createAlias(aliasText, customerSlug) {
    const alias = String(aliasText || "").trim();
    const slug  = String(customerSlug || "").trim();
    if (!alias) { showToast("err", "Enter an alias first."); return; }
    if (!slug)  { showToast("err", "Pick a Pioneer customer first."); return; }
    const customer = getCustomers().find(function (c) { return getCustomerSlug(c) === slug; });
    if (!customer) { showToast("err", "Couldn't find that customer."); return; }

    const docId = aliasDocId(alias);
    const payload = {
      alias:                  alias,
      normalized_alias:       normalizeAlias(alias),
      customer_slug:          slug,
      customer_name:          getCustomerName(customer),
      active:                 true,
      source:                 "admin_created",
      confidence:             "high",
      learned_from_dcr:       false,
      learned_from_dcr_count: 0,
      last_learned_at:        null,
      created_at:             firebase.firestore.FieldValue.serverTimestamp(),
      updated_at:             firebase.firestore.FieldValue.serverTimestamp()
    };
    try {
      await db().collection("customer_aliases").doc(docId).set(payload, { merge: true });
      showToast("ok", "Alias saved. Future shifts auto-suggest this customer.");
      await reloadAliases();
    } catch (err) {
      handleAdminWriteError(err, { context: "create customer_alias" });
    }
  }

  async function toggleAliasActive(docId) {
    if (!docId) return;
    const current = customerAliases.find(function (a) { return a.id === docId; });
    if (!current) return;
    const nextActive = current.active === false;
    try {
      // The firestore rule requires customer_slug + customer_name + active
      // to stay on the doc, so use merge:true + the fields we already have.
      await db().collection("customer_aliases").doc(docId).set({
        customer_slug: current.customer_slug || "",
        customer_name: current.customer_name || "",
        active:        nextActive,
        updated_at:    firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      showToast("ok", nextActive ? "Alias enabled." : "Alias disabled.");
      await reloadAliases();
    } catch (err) {
      handleAdminWriteError(err, { context: "toggle customer_alias" });
    }
  }

  async function deleteAlias(docId) {
    if (!docId) return;
    if (!confirm("Delete this alias? Future shifts carrying it will stop auto-suggesting a customer.")) return;
    try {
      await db().collection("customer_aliases").doc(docId).delete();
      showToast("ok", "Alias deleted.");
      await reloadAliases();
    } catch (err) {
      handleAdminWriteError(err, { context: "delete customer_alias" });
    }
  }

  async function reloadAliases() {
    const snap = await db().collection("customer_aliases").get();
    customerAliases = snap.docs.map(function (d) {
      return Object.assign({ id: d.id }, d.data());
    });
    renderAliasManager();
    renderUnmappedDeputyLocations();
  }

  // Pilot seed — calls the server-side Cloud Function that knows the
  // curated Pioneer alias list. We never embed the alias list in
  // frontend JS: the list lives in functions/index.js and updates
  // via redeploy.
  async function seedPilotAliases() {
    const url = (window.SEED_PILOT_CUSTOMER_ALIASES_URL || "").trim();
    const statusEl = $("alias-seed-status");
    function status(msg) { if (statusEl) statusEl.textContent = msg; }
    if (!url || /REPLACE_WITH/.test(url)) {
      status("SEED_PILOT_CUSTOMER_ALIASES_URL is not configured in firebase-config.js.");
      showToast("err", "Pilot seed URL missing — check firebase-config.js.");
      return;
    }
    let idToken = null;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (_e) { /* swallow */ }
    if (!idToken) {
      showToast("err", "You appear to be signed out. Refresh and sign in again.");
      return;
    }
    status("Calling server-side seed…");
    let result = null;
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + idToken
        },
        body: "{}"
      });
      result = await res.json().catch(function () { return {}; });
      if (!res.ok || !result.ok) {
        const msg = (result && result.error) ? result.error : ("Server returned " + res.status);
        status("Seed failed: " + msg);
        showToast("err", "Pilot seed failed: " + msg);
        return;
      }
    } catch (err) {
      status("Seed failed: " + (err && err.message || "network error"));
      showToast("err", "Pilot seed network error.");
      return;
    }
    const seededN  = result.seeded_count  || 0;
    const skippedN = result.skipped_count || 0;
    const missingN = (result.missing_customers || []).length;
    let detail = "Seed successful — " + seededN + " new alias" + (seededN === 1 ? "" : "es");
    if (skippedN)  detail += ", " + skippedN + " already existed";
    if (missingN)  detail += ", " + missingN + " seed entr" + (missingN === 1 ? "y" : "ies") + " skipped (no matching Pioneer customer)";
    detail += ".";
    status(detail);
    showToast("ok", "Seed successful — " + seededN + " new alias" + (seededN === 1 ? "" : "es") + ".");
    if (missingN && Array.isArray(result.missing_customers)) {
      console.warn("[seed] missing Pioneer customers for these seed entries:", result.missing_customers);
    }
    await reloadAliases();
  }

  // Diagnostic — hits Deputy's API via the admin-only probe Cloud
  // Function and dumps the JSON into the disclosure on the admin page.
  // Pure read-only: nothing is written, nothing is auto-mapped.
  async function runDeputyApiProbe(resource) {
    const url = (window.DEPUTY_API_DIAGNOSTIC_URL || "").trim();
    const statusEl = $("deputy-api-probe-status");
    const outEl    = $("deputy-api-probe-output");
    function status(msg) { if (statusEl) statusEl.textContent = msg; }
    function output(obj) {
      if (!outEl) return;
      try {
        outEl.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
      } catch (_e) {
        outEl.textContent = String(obj);
      }
    }
    if (!url || /REPLACE_WITH/.test(url)) {
      status("DEPUTY_API_DIAGNOSTIC_URL is not configured in firebase-config.js.");
      return;
    }
    let idToken = null;
    try {
      const u = firebase.auth().currentUser;
      if (u) idToken = await u.getIdToken();
    } catch (_e) { /* swallow */ }
    if (!idToken) {
      status("You appear to be signed out. Refresh and sign in again.");
      return;
    }
    status("Calling Deputy " + resource + " endpoint…");
    output("");
    let result = null;
    let httpStatus = 0;
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + idToken
        },
        body: JSON.stringify({ resource: resource })
      });
      httpStatus = res.status;
      result = await res.json().catch(function () { return {}; });
    } catch (err) {
      status("Probe failed: " + (err && err.message || "network error"));
      return;
    }
    if (!result || result.ok !== true) {
      const msg = (result && result.error) ? result.error : ("HTTP " + httpStatus);
      status("Probe failed: " + msg);
      output(result || { error: "no response body" });
      return;
    }
    status(
      "OK — " + resource + " · " +
      result.count + " row" + (result.count === 1 ? "" : "s") +
      " (showing first " + (result.capped_to || 0) + ") · " +
      "endpoint " + result.endpoint_called + " · " +
      "token " + result.token_source
    );
    output(result);
  }

  // One-click migration: harvests every entry from customers[].aliases[]
  // and customers[].deputy_customer_codes[] and creates a corresponding
  // /customer_aliases doc with source="manual_seed". Idempotent — skips
  // anything that already has a doc id collision.
  async function seedAliasesFromCustomers() {
    const statusEl = $("alias-seed-status");
    function status(msg) { if (statusEl) statusEl.textContent = msg; }
    status("Reading customer fields…");
    const existingIds = new Set(customerAliases.map(function (a) { return a.id; }));
    const writes = [];
    getCustomers().forEach(function (c) {
      if (!getActive(c)) return;
      const slug = getCustomerSlug(c);
      if (!slug) return;
      const name = getCustomerName(c) || "";
      const fromAliases = Array.isArray(c.aliases) ? c.aliases : [];
      const fromCodes   = Array.isArray(c.deputy_customer_codes) ? c.deputy_customer_codes : [];
      fromAliases.concat(fromCodes).forEach(function (raw) {
        const aliasText = String(raw || "").trim();
        if (!aliasText) return;
        const id = aliasDocId(aliasText);
        if (existingIds.has(id)) return;
        existingIds.add(id);  // de-dup within this run
        writes.push({
          id: id,
          payload: {
            alias:                  aliasText,
            normalized_alias:       normalizeAlias(aliasText),
            customer_slug:          slug,
            customer_name:          name,
            active:                 true,
            source:                 "manual_seed",
            confidence:             "high",
            learned_from_dcr:       false,
            learned_from_dcr_count: 0,
            last_learned_at:        null,
            created_at:             firebase.firestore.FieldValue.serverTimestamp(),
            updated_at:             firebase.firestore.FieldValue.serverTimestamp()
          }
        });
      });
    });
    if (writes.length === 0) {
      status("Nothing to seed — every alias on customer docs is already in customer_aliases.");
      return;
    }
    status("Writing " + writes.length + " alias" + (writes.length === 1 ? "" : "es") + "…");
    try {
      // Write in batches of 400 to stay under the 500-write batch limit.
      for (let i = 0; i < writes.length; i += 400) {
        const batch = db().batch();
        writes.slice(i, i + 400).forEach(function (w) {
          batch.set(db().collection("customer_aliases").doc(w.id), w.payload, { merge: false });
        });
        await batch.commit();
      }
      status("Seeded " + writes.length + " alias" + (writes.length === 1 ? "" : "es") + ".");
      showToast("ok", "Seeded " + writes.length + " aliases from customer fields.");
      await reloadAliases();
    } catch (err) {
      status("Seed failed: " + (err && err.message || "unknown error"));
      handleAdminWriteError(err, { context: "seed customer_aliases" });
    }
  }


  // ============= Writers =============

  async function applyEmployeeMapping(opts) {
    const slug = opts.tech_slug;
    if (!slug) { showToast("err", "Missing tech slug — refresh and try again."); return; }
    const update = {
      updated_at:           firebase.firestore.FieldValue.serverTimestamp(),
      updated_by:           getCurrentAdminEmail(),
      deputy_employee_name: opts.deputy_name || ""
    };
    if (opts.deputy_id)    update.deputy_employee_id    = Number(opts.deputy_id) || opts.deputy_id;
    if (opts.deputy_email) update.deputy_employee_email = String(opts.deputy_email).toLowerCase().trim();
    try {
      await db().collection("cleaning_techs").doc(slug).update(update);
      showToast("ok", "Tech mapping saved. Applies to all future shifts.");
      await window.__pioneerAdmin.tabs.techs.refresh();
      renderDeputyMappingEmployees();
    } catch (err) {
      handleAdminWriteError(err, { context: "deputy employee mapping" });
    }
  }


  function wireDeputyMappingControls() {
    const refreshBtn  = $("deputy-mapping-refresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () { loadDeputyMapping(); });
    }

    // Auto-load when the Deputy tab is first activated.
    const tabBtn = document.querySelector('.admin-tab[data-tab="deputy"]');
    let firstActivation = true;
    if (tabBtn) {
      tabBtn.addEventListener("click", function () {
        if (!firstActivation) return;
        firstActivation = false;
        loadDeputyMapping();
      });
    }

    // Helper — flip the picker-button state when the dropdown changes.
    function updatePickButtonState(sel) {
      if (!sel) return;
      const card = sel.closest(".dm-card");
      if (!card) return;
      const btn = card.querySelector('button[data-action="apply-emp-pick"]');
      if (!btn) return;
      const hasValue = !!sel.value;
      btn.disabled = !hasValue;
      btn.classList.toggle("is-disabled", !hasValue);
      btn.textContent = hasValue ? "Map this" : "Pick tech first";
    }

    // Employees panel.
    const empRoot = $("deputy-mapping-employees");
    if (empRoot) {
      empRoot.addEventListener("change", function (ev) {
        const sel = ev.target.closest('select[data-pick="emp"]');
        if (sel) updatePickButtonState(sel);
      });
      empRoot.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        if (action === "apply-emp") {
          applyEmployeeMapping({
            tech_slug:     btn.dataset.techSlug,
            deputy_id:     btn.dataset.deputyId,
            deputy_name:   btn.dataset.deputyName,
            deputy_email:  btn.dataset.deputyEmail
          });
        } else if (action === "apply-emp-pick") {
          const card = btn.closest(".dm-card");
          const sel  = card && card.querySelector('select[data-pick="emp"]');
          const techSlug = sel && sel.value;
          if (!techSlug) { showToast("err", "Pick a tech first."); return; }
          applyEmployeeMapping({
            tech_slug:     techSlug,
            deputy_id:     btn.dataset.deputyId,
            deputy_name:   btn.dataset.deputyName,
            deputy_email:  btn.dataset.deputyEmail
          });
        }
      });
    }

    // Customer Alias Manager — create form.
    const createForm = $("alias-create-form");
    if (createForm) {
      createForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        const aliasInput = $("alias-create-alias");
        const custSelect = $("alias-create-customer");
        const aliasText  = aliasInput ? aliasInput.value : "";
        const slug       = custSelect ? custSelect.value : "";
        createAlias(aliasText, slug).then(function () {
          if (aliasInput) aliasInput.value = "";
          if (custSelect) custSelect.value = "";
        });
      });
    }

    // Customer Alias Manager — per-row toggle/delete. Same handler
    // covers the audit list (.alias-audit-row) by walking either
    // parent class up to data-alias-id.
    function bindAliasActions(rootEl) {
      if (!rootEl) return;
      rootEl.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        const row = btn.closest("[data-alias-id]");
        const id  = row && row.dataset.aliasId;
        if (!id) return;
        if (btn.dataset.action === "alias-toggle") toggleAliasActive(id);
        if (btn.dataset.action === "alias-delete") deleteAlias(id);
      });
    }
    bindAliasActions($("alias-list"));
    bindAliasActions($("alias-audit-list"));

    // "Disable all flagged conflicts" — batch action on the audit panel.
    const disableConflictsBtn = $("alias-audit-disable-conflicts");
    if (disableConflictsBtn) {
      disableConflictsBtn.addEventListener("click", function () { disableFlaggedConflicts(); });
    }

    // Pilot seed button — server-side function call.
    const pilotBtn = $("alias-seed-pilot");
    if (pilotBtn) {
      pilotBtn.addEventListener("click", function () { seedPilotAliases(); });
    }

    // Deputy API probe — three buttons, one output area. Diagnostic only.
    const probeRoot = $("deputy-api-probe");
    if (probeRoot) {
      probeRoot.addEventListener("click", function (ev) {
        const btn = ev.target.closest("button[data-probe]");
        if (!btn) return;
        const resource = btn.dataset.probe;
        if (!resource) return;
        runDeputyApiProbe(resource);
      });
    }
    // Legacy seed-from-customers button — frontend-driven harvest.
    const seedBtn = $("alias-seed-run");
    if (seedBtn) {
      seedBtn.addEventListener("click", function () { seedAliasesFromCustomers(); });
    }

    // Deputy Companies — primary mapping panel.
    const companiesRoot = $("deputy-companies-list");
    if (companiesRoot) {
      companiesRoot.addEventListener("change", function (ev) {
        const sel = ev.target.closest('select[data-pick="deputy-company"]');
        if (!sel) return;
        const card = sel.closest(".dm-card");
        const btn  = card && card.querySelector('button[data-action="map-deputy-company"]');
        if (!btn) return;
        const hasValue = !!sel.value;
        btn.disabled = !hasValue;
        btn.classList.toggle("is-disabled", !hasValue);
        btn.textContent = hasValue ? "Map this company" : "Pick customer first";
      });
      companiesRoot.addEventListener("click", function (ev) {
        const mapBtn = ev.target.closest('button[data-action="map-deputy-company"]');
        if (mapBtn) {
          const card = mapBtn.closest(".dm-card");
          const sel  = card && card.querySelector('select[data-pick="deputy-company"]');
          const slug = sel && sel.value;
          if (!slug) { showToast("err", "Pick a customer first."); return; }
          mapDeputyCompanyToCustomer({
            customer_slug:       slug,
            deputy_company_id:   mapBtn.dataset.deputyCompanyId,
            deputy_company_name: mapBtn.dataset.deputyCompanyName
          });
          return;
        }
        const removeBtn = ev.target.closest('button[data-action="remove-deputy-company-mapping"]');
        if (removeBtn) {
          removeCompanyMapping(removeBtn.dataset.keepSlug, removeBtn.dataset.deputyCompanyId);
          return;
        }
        const keepBtn = ev.target.closest('button[data-action="keep-duplicate-mapping"]');
        if (keepBtn) {
          keepDuplicateMapping(keepBtn.dataset.keepSlug, keepBtn.dataset.deputyCompanyId);
          return;
        }
        const toggleBtn = ev.target.closest('button[data-action="toggle-show-inactive"]');
        if (toggleBtn) {
          showInactiveInCustomerPicker = !showInactiveInCustomerPicker;
          renderDeputyCompanies();
          return;
        }
      });
    }

    // Unmapped-Deputy-locations panel (legacy, lives under the
    // collapsed Fallback Aliases disclosure).
    const unmappedRoot = $("unmapped-deputy-locations");
    if (unmappedRoot) {
      unmappedRoot.addEventListener("change", function (ev) {
        const sel = ev.target.closest('select[data-pick="deputy-loc"]');
        if (!sel) return;
        const card = sel.closest(".dm-card");
        const btn  = card && card.querySelector('button[data-action="map-deputy-loc"]');
        if (!btn) return;
        const hasValue = !!sel.value;
        btn.disabled = !hasValue;
        btn.classList.toggle("is-disabled", !hasValue);
        btn.textContent = hasValue ? "Map this location" : "Pick customer first";
      });
      unmappedRoot.addEventListener("click", function (ev) {
        const btn = ev.target.closest('button[data-action="map-deputy-loc"]');
        if (!btn) return;
        const card = btn.closest(".dm-card");
        const sel  = card && card.querySelector('select[data-pick="deputy-loc"]');
        const slug = sel && sel.value;
        const text = btn.dataset.deputyLocationText || "";
        if (!slug) { showToast("err", "Pick a customer first."); return; }
        if (!text) { showToast("err", "Missing Deputy location text."); return; }
        // Re-uses the manual createAlias path so all alias docs share
        // a schema. The "alias" is the verbatim Deputy location name.
        createAlias(text, slug).then(function () {
          renderUnmappedDeputyLocations();
        });
      });
    }
  }

  /* ---------- Customer edit-modal Deputy Integration block ----------
   * Called from tab-customers.js via deps.populateCustomerDeputyIntegration.
   * Phase 22 moved it here from admin.js because it reads
   * deputyMappingShifts + toMillis + fmtLastSeenPT — all Deputy-module
   * internals. Owns its own DOM IDs (`cust-edit-deputy-*`). */
  function populateCustomerDeputyIntegration(c) {
    const slug    = getCustomerSlug(c);
    const cid     = c.deputy_company_id != null && c.deputy_company_id !== ""
                      ? c.deputy_company_id
                      : c.deputy_location_id;
    const stored  = String(c.deputy_company_name || "").trim();
    const nameEl   = $("cust-edit-deputy-name");
    const idEl     = $("cust-edit-deputy-id");
    const lastEl   = $("cust-edit-deputy-last-shift");
    const srcEl    = $("cust-edit-deputy-match-source");
    const healthEl = $("cust-edit-deputy-health");
    const helpEl   = $("cust-edit-deputy-help");

    if (nameEl) nameEl.textContent = stored || "—";
    if (idEl)   idEl.textContent   = (cid != null && cid !== "") ? String(cid) : "—";

    // Walk recent cache for the most-recent shift assigned to this slug
    // (when mapping is current) OR carrying the stored Company.Id
    // (covers cases where the cache hasn't refreshed yet).
    let mostRecent = null;
    deputyMappingShifts.forEach(function (s) {
      const matches =
        (slug && s.customer_slug === slug) ||
        (cid != null && String(s.deputy_company_id || "") === String(cid));
      if (!matches) return;
      const t = toMillis(s.start_time);
      if (!mostRecent || t > (mostRecent._t || 0)) {
        mostRecent = Object.assign({ _t: t }, s);
      }
    });
    if (lastEl) {
      lastEl.textContent = mostRecent
        ? fmtLastSeenPT(mostRecent._t) +
            (mostRecent.deputy_company_name ? " · " + mostRecent.deputy_company_name : "")
        : "Not seen in last " + DEPUTY_MAPPING_LOOKBACK_DAYS + " days";
    }
    if (srcEl) {
      srcEl.textContent = mostRecent
        ? (String(mostRecent.match_source || "") +
           (mostRecent.match_confidence ? " (" + mostRecent.match_confidence + ")" : ""))
        : "—";
    }
    // Health classification mirrors the Deputy Companies pills.
    let healthLabel = "—";
    let healthClass = "";
    if (cid == null || cid === "") {
      healthLabel = "Not linked to a Deputy company";
    } else if (!getActive(c)) {
      healthLabel = "Inactive Pioneer customer";
      healthClass = "is-inactive";
    } else {
      // Look for duplicates: another active customer with same cid.
      const customers = getCustomers();
      const dupes = customers.filter(function (other) {
        if (getCustomerSlug(other) === slug) return false;
        if (!getActive(other)) return false;
        const otherCid = other.deputy_company_id != null && other.deputy_company_id !== ""
                           ? other.deputy_company_id
                           : other.deputy_location_id;
        return otherCid != null && String(otherCid) === String(cid);
      });
      if (dupes.length > 0) {
        healthLabel = "Duplicate — also claimed by " + dupes.length + " other customer" +
                      (dupes.length === 1 ? "" : "s");
        healthClass = "is-duplicate";
      } else {
        healthLabel = "Mapped (Company.Id canonical)";
        healthClass = "is-mapped";
      }
    }
    if (healthEl) {
      healthEl.innerHTML = '<span class="mapping-pill ' + escapeHtml(healthClass) + '">' +
                            escapeHtml(healthLabel) + '</span>';
    }
    // Rename note: stored name vs latest seen name.
    if (helpEl) {
      if (mostRecent && mostRecent.deputy_company_name && stored &&
          String(mostRecent.deputy_company_name).trim() !== stored) {
        helpEl.textContent = "Deputy currently sends this company as '" +
                             mostRecent.deputy_company_name +
                             "'. Matching uses Company.Id — the rename is cosmetic.";
        helpEl.hidden = false;
      } else if (cid != null && cid !== "") {
        helpEl.textContent = "Matching is keyed on Deputy Company.Id. Renaming the company in Deputy does not break this link.";
        helpEl.hidden = false;
      } else {
        helpEl.textContent = "No Deputy company linked yet. Map this customer from Admin → Deputy → Deputy Companies.";
        helpEl.hidden = false;
      }
    }
  }

  /* ---------- export surface ---------- */

  window.__pioneerAdmin.tabs = window.__pioneerAdmin.tabs || {};
  window.__pioneerAdmin.tabs.deputyMapping = {
    init:                        wireDeputyMappingControls,
    refresh:                     loadDeputyMapping,
    populateCustomerIntegration: populateCustomerDeputyIntegration
  };
}());
