/* Pioneer DCR Hub — shared staff-auth controller.
 *
 * Loaded by both /index.html (DCR form) and /tech.html (Tech Hub). NOT
 * loaded by /admin.html — the admin page has its own allowlist-only flow.
 *
 * Public API exposed on window.STAFF_AUTH:
 *   init(opts)            — call once on DOMContentLoaded
 *   signIn()              — opens Google sign-in popup (admin-friendly)
 *   signInWithPassword(email, password)
 *                         — sign in with Firebase Email/Password provider
 *   sendPasswordReset(email)
 *                         — emails a password-reset link
 *   signOut()             — signs the user out
 *   getCurrentStaff()     — returns the current staff object or null
 *   getIdToken()          — returns a Promise<string> for the current ID token
 *   isAdmin()             — convenience boolean
 *
 * Authentication is provider-agnostic from the server's perspective:
 * whoAmIV1 matches request.auth.email against ALLOWED_ADMIN_EMAILS and the
 * cleaning_techs.email index. A tech may sign in via Google (if their
 * cleaning_techs.email is a Google account) or via Email/Password.
 *
 * Session persistence is set to LOCAL — the Firebase auth state survives
 * browser restarts on the same device. Users stay signed in until they
 * explicitly sign out, the password is reset, or an admin disables the
 * Firebase Auth user.
 *
 * init() callbacks (all optional):
 *   onAuthorized(staff)   — user is signed in AND verified active staff
 *   onDenied(info)        — user is signed in but not active staff
 *   onSignedOut()         — user is not signed in
 *   onChecking()          — auth state in flight
 *
 * Each callback fires for the current state on init and on every transition.
 * Pages should hide/show their auth screens from these callbacks — staff-auth
 * itself owns NO UI.
 */
(function () {
  "use strict";

  let initialized       = false;
  let currentStaff      = null;
  let onAuthorizedCb    = null;
  let onDeniedCb        = null;
  let onSignedOutCb     = null;
  let onCheckingCb      = null;

  // Lightweight cache of the last successful whoAmI result. Used purely
  // for snappy mobile boot — pages can read getCachedStaff() to pre-fill
  // a display name in the brand header or the customer dropdown so the
  // UI doesn't feel "blank" while the real whoAmI request is in flight.
  //
  // SECURITY: This cache is NEVER the source of truth. The
  // onAuthorized(staff) callback only fires after whoAmIV1 returns
  // {allowed: true}; the server enforces the same check on every
  // submitDcrV1 / techHubViewV1 request via the ID token. If an attacker
  // edits localStorage, they get nothing — server-side gates ignore it.
  const STAFF_CACHE_KEY = "pioneer_dcr_staff_cache_v1";

  function readCachedStaff() {
    try {
      const raw = localStorage.getItem(STAFF_CACHE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== "object") return null;
      return obj;
    } catch (e) { return null; }
  }

  function writeCachedStaff(staff) {
    try {
      const tech = staff && staff.tech ? staff.tech : null;
      const lite = {
        email:         staff && staff.email || null,
        role:          staff && staff.role  || null,
        display_name:  tech && tech.display_name || null,
        tech_slug:     tech && tech.slug || null,
        assigned_customer_slugs: tech && Array.isArray(tech.assigned_customer_slugs)
          ? tech.assigned_customer_slugs.slice()
          : [],
        cached_at: Date.now()
      };
      localStorage.setItem(STAFF_CACHE_KEY, JSON.stringify(lite));
    } catch (e) { /* localStorage full or disabled — non-fatal */ }
  }

  function clearCachedStaff() {
    try { localStorage.removeItem(STAFF_CACHE_KEY); } catch (e) {}
  }

  function init(opts) {
    if (initialized) return;
    initialized = true;
    opts = opts || {};
    onAuthorizedCb = opts.onAuthorized || null;
    onDeniedCb     = opts.onDenied     || null;
    onSignedOutCb  = opts.onSignedOut  || null;
    onCheckingCb   = opts.onChecking   || null;

    if (!window.FIREBASE_CONFIG || !window.firebase) {
      console.error("[staff-auth] Firebase SDK or config missing.");
      fire("denied", { reason: "config_missing",
                       message: "Sign-in isn't set up on this page. Email info@pioneercomclean.com." });
      return;
    }
    if (typeof firebase.auth !== "function") {
      console.error("[staff-auth] firebase-auth-compat.js didn't load.");
      fire("denied", { reason: "auth_sdk_missing",
                       message: "Sign-in isn't available. Hard-reload (Cmd+Shift+R)." });
      return;
    }
    if (!window.WHOAMI_URL || /REPLACE_WITH/.test(window.WHOAMI_URL)) {
      console.error("[staff-auth] WHOAMI_URL not configured in firebase-config.js.");
      fire("denied", { reason: "whoami_url_missing",
                       message: "Sign-in endpoint isn't configured. Email info@pioneercomclean.com." });
      return;
    }

    if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);

    // LOCAL persistence — survives browser restarts and is the most
    // app-like option for mobile (PWA / home-screen launch reopens still
    // signed in). Fire-and-forget: persistence is set asynchronously, but
    // onAuthStateChanged still fires with the cached user on first load.
    // We log failures (e.g., Safari Private Mode storage quirks) but
    // don't block sign-in flow.
    try {
      firebase.auth()
        .setPersistence(firebase.auth.Auth.Persistence.LOCAL)
        .catch(function (err) {
          console.warn("[staff-auth] LOCAL persistence not available; falling back to default", err);
        });
    } catch (e) {
      console.warn("[staff-auth] setPersistence threw synchronously", e);
    }

    // Initial state — checking until onAuthStateChanged fires for the first
    // time with the cached session (or null).
    fire("checking");

    firebase.auth().onAuthStateChanged(async function (user) {
      if (!user) {
        currentStaff = null;
        clearCachedStaff();
        fire("signed-out");
        return;
      }
      fire("checking");
      try {
        const idToken = await user.getIdToken();
        const res = await fetch(window.WHOAMI_URL, {
          method:  "GET",
          headers: { "Authorization": "Bearer " + idToken }
        });
        const body = await res.json().catch(function () { return {}; });

        if (!res.ok || !body.ok) {
          console.error("[staff-auth] whoAmI returned non-OK", res.status, body);
          currentStaff = null;
          clearCachedStaff();
          fire("denied", {
            reason:  body.error || ("server_" + res.status),
            message: body.error ||
              "Couldn't verify your account. Check your connection and try again."
          });
          return;
        }

        if (!body.allowed) {
          currentStaff = null;
          clearCachedStaff();
          fire("denied", {
            reason:  body.reason || "denied",
            email:   body.email,
            message: friendlyDeniedMessage(body.reason, body.email)
          });
          return;
        }

        currentStaff = {
          email: body.email,
          uid:   body.uid,
          role:  body.role,           // "admin" | "cleaning_tech"
          tech:  body.tech || null    // populated for cleaning_tech (and for any admin
                                      // who happens to also be in cleaning_techs)
        };
        writeCachedStaff(currentStaff);
        fire("authorized", currentStaff);
      } catch (err) {
        console.error("[staff-auth] whoAmI request failed", err);
        // Keep the cache on transient network failures so the next page
        // load can still optimistically pre-fill. We do NOT call
        // onAuthorized here — that would bypass server verification.
        currentStaff = null;
        fire("denied", {
          reason:  "network_error",
          message: "Couldn't reach the sign-in service. Check your connection and try again."
        });
      }
    });
  }

  // Friendly text rendered into #staff-auth-denied-msg. Plain text — the
  // sign-in panel renders a clickable mailto: link below this message as
  // a permanent help footer, so we do NOT inline a link here.
  function friendlyDeniedMessage(reason, email) {
    const who = email ? "Your account (" + email + ")" : "Your account";
    if (reason === "archived") {
      return "Your PioneerOps access is not active. Please contact Pioneer management.";
    }
    if (reason === "dcr_disabled") {
      return "Your PioneerOps access is not currently enabled. Please contact Pioneer management.";
    }
    // Default / not_on_staff_list / unknown
    return "Your PioneerOps access is not active. Please contact Pioneer management.";
  }

  function fire(state, info) {
    if (state === "checking"  && onCheckingCb)  onCheckingCb();
    if (state === "signed-out" && onSignedOutCb) onSignedOutCb();
    if (state === "denied"    && onDeniedCb)    onDeniedCb(info || {});
    if (state === "authorized" && onAuthorizedCb) onAuthorizedCb(currentStaff);
  }

  // Google sign-in on STAFF pages (DCR form + Customer Info Hub).
  //
  // POLICY (Pioneer DCR Hub, 2026):
  //
  //   1. Staff pages always use signInWithPopup. NEVER signInWithRedirect.
  //      Safari's Intelligent Tracking Prevention can purge the IndexedDB
  //      handoff cookies that the redirect handshake depends on, leaving
  //      the user stranded on a "Welcome back…" spinner. Popup avoids the
  //      cross-origin redirect entirely.
  //
  //   2. If the popup fails for ANY reason other than user-cancellation,
  //      we DO NOT fall back to redirect. We resolve with a result envelope
  //      so the page can render an inline message steering the user to the
  //      email/password form that sits right above the Google button.
  //
  //   3. The resolved envelope matches the shape of signInWithPassword:
  //        { ok: true }                                  → onAuthStateChanged fires next
  //        { ok: false, code, message, cancelled: false } → render in panel
  //        { ok: true, cancelled: true }                 → silent (user closed popup)
  //
  // Adding a redirect fallback here would silently break Safari sessions.
  // If a future SDK release ships a magic "this just works on Safari" fix,
  // re-evaluate — but keep the popup-only default unless it's measurably
  // better in the field.
  async function signIn() {
    if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      await firebase.auth().signInWithPopup(provider);
      // onAuthStateChanged takes it from here.
      return { ok: true };
    } catch (err) {
      const code = err && err.code;
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        // User-cancelled — silent.
        return { ok: true, cancelled: true };
      }
      console.error("[staff-auth] Google sign-in failed", code, err && err.message, err);
      // Staff pages always have the email/password form right there, so
      // every non-cancellation failure mode collapses to the same advice:
      // "try email/password instead." We surface the underlying code so
      // support can pattern-match, but we do not blast a raw error at the
      // user — the message is identical across SDK versions and browser
      // quirks (popup blocker, storage partitioning, configuration gaps).
      const friendly = "Google sign-in may not work in this browser. Please use email and password.";
      return { ok: false, code: code || "unknown", message: friendly, cancelled: false };
    }
  }

  // Map raw Firebase Auth error codes to friendly, office-routing messages.
  // We DELIBERATELY do not surface "user-not-found" vs "wrong-password"
  // separately — both collapse to a single message to avoid leaking
  // account existence. (Firebase 9+ already returns "invalid-credential"
  // for both, but older SDKs and emulators distinguish them.)
  // Plain-text — the sign-in panel renders a clickable mailto: link below
  // the inline-message area as the canonical help affordance, so we don't
  // repeat the email here.
  function friendlyAuthError(code) {
    if (code === "auth/wrong-password" ||
        code === "auth/invalid-credential" ||
        code === "auth/invalid-login-credentials") {
      return "That email/password didn't work. Please try again.";
    }
    if (code === "auth/user-not-found") {
      return "No DCR account found for this email yet.";
    }
    if (code === "auth/user-disabled") {
      return "Your DCR access is not currently enabled.";
    }
    if (code === "auth/invalid-email") {
      return "That doesn't look like a valid email address.";
    }
    if (code === "auth/too-many-requests") {
      return "Too many sign-in attempts. Please wait a few minutes and try again.";
    }
    if (code === "auth/network-request-failed") {
      return "Couldn't reach the sign-in service. Check your connection and try again.";
    }
    return "Sign-in failed. Please try again.";
  }

  // Email/password sign-in.
  //
  // Resolves to {ok: true} on success — onAuthStateChanged then runs the
  // whoAmI verification and fires onAuthorized. Resolves to
  // {ok: false, code, message} on failure so the caller can render the
  // message inline next to the form. We deliberately resolve (not reject)
  // for the failure path so callers don't need a try/catch wrapper.
  async function signInWithPassword(email, password) {
    if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
    const e = String(email || "").trim();
    const p = String(password || "");
    if (!e || !p) {
      return {
        ok: false,
        code: "auth/missing-fields",
        message: "Enter your email and password to sign in."
      };
    }
    try {
      await firebase.auth().signInWithEmailAndPassword(e, p);
      return { ok: true };
    } catch (err) {
      const code = err && err.code;
      console.warn("[staff-auth] password sign-in failed", code);
      return { ok: false, code: code || "unknown", message: friendlyAuthError(code) };
    }
  }

  // Send a Firebase password-reset email.
  // Same resolve-don't-reject contract as signInWithPassword.
  async function sendPasswordReset(email) {
    if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
    const e = String(email || "").trim();
    if (!e) {
      return {
        ok: false,
        code: "auth/missing-email",
        message: "Enter your email address first, then tap Forgot password."
      };
    }
    // Anti-enumeration: return the SAME success message on both real
    // success and on auth/user-not-found, so an attacker can't probe
    // which emails have accounts. Other errors (network, invalid email,
    // rate-limit) still surface so the user knows the request didn't
    // go through.
    const antiEnumMessage =
      "If an account exists for that email, a reset link has been sent. " +
      "Check your inbox and spam folder for an email from Pioneer Commercial Cleaning.";
    try {
      // actionCodeSettings.url ensures Firebase routes the user back
      // to /login.html after they set their new password. Without
      // it, the reset success page is a dead end (the issue Makaila
      // hit during pilot prep).
      await firebase.auth().sendPasswordResetEmail(e, {
        url: window.location.origin + "/login.html",
        handleCodeInApp: false
      });
      return { ok: true, message: antiEnumMessage };
    } catch (err) {
      const code = err && err.code;
      console.warn("[staff-auth] password reset failed", code);
      if (code === "auth/user-not-found") {
        return { ok: true, message: antiEnumMessage };
      }
      return { ok: false, code: code || "unknown", message: friendlyAuthError(code) };
    }
  }

  async function signOut() {
    try {
      clearCachedStaff();
      await firebase.auth().signOut();
    } catch (err) { console.error("[staff-auth] sign-out failed", err); }
  }

  function getCurrentStaff() { return currentStaff; }

  // Lightweight cached snapshot from the LAST successful whoAmI. Returns
  // null when no cache (first sign-in ever on this device, or post-
  // signout). Pages may use this for optimistic UI — e.g., pre-filling
  // the header email or the customer dropdown — but must NOT treat it as
  // authorization. Final authorization always comes from
  // onAuthorized(staff) once the live whoAmI call returns.
  function getCachedStaff() { return readCachedStaff(); }

  async function getIdToken() {
    const user = firebase.auth && firebase.auth().currentUser;
    if (!user) return null;
    try { return await user.getIdToken(); }
    catch (err) { console.error("[staff-auth] getIdToken failed", err); return null; }
  }

  function isAdmin() { return !!(currentStaff && currentStaff.role === "admin"); }

  window.STAFF_AUTH = {
    init:                init,
    signIn:              signIn,
    signInWithPassword:  signInWithPassword,
    sendPasswordReset:   sendPasswordReset,
    signOut:             signOut,
    getCurrentStaff:     getCurrentStaff,
    getCachedStaff:      getCachedStaff,
    getIdToken:          getIdToken,
    isAdmin:             isAdmin
  };
})();
