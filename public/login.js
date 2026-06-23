/* Pioneer DCR Hub — /login.html controller.
 *
 * Single canonical sign-in entry point. Wires the existing STAFF_AUTH
 * pipeline (Google popup + email/password fallback + LOCAL persistence)
 * and routes the user to their landing surface on success.
 *
 * Routing behavior:
 *   • If already signed in + authorized → /team-hub.html (or
 *     ?next=<safe path> if provided)
 *   • If signed in but NOT on the active staff list → "denied" card
 *     with an explicit "text Kirby or Nick" instruction
 *   • Otherwise → sign-in card
 *
 * The ?next= query string honors only relative paths starting with
 * "/" — never an external URL — so an attacker can't redirect a
 * freshly-signed-in user off PioneerOps.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function safeNextPath() {
    try {
      const p = new URLSearchParams(window.location.search).get("next") || "";
      // Only allow same-origin relative paths.
      if (p && p.charAt(0) === "/" && p.charAt(1) !== "/") return p;
    } catch (_e) {}
    return "/team-hub.html";
  }

  function setState(name) {
    ["checking", "signin", "denied"].forEach(function (s) {
      const el = $("login-" + s);
      if (el) el.hidden = (s !== name);
    });
  }

  function paintInlineMsg(msg, isError) {
    const el = $("staff-auth-inline-msg");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.textContent = msg;
    el.hidden = false;
    el.classList.toggle("is-error", !!isError);
  }

  function showDenied(info) {
    setState("denied");
    const msgEl = $("login-denied-msg");
    if (msgEl && info && info.message) msgEl.textContent = info.message;
    const emailEl = $("login-denied-email");
    if (emailEl) {
      const u = firebase.auth().currentUser;
      emailEl.textContent = (u && u.email) || "—";
    }
  }

  function redirectIntoApp() {
    const dest = safeNextPath();
    try { console.info("[login] routing into app", { dest: dest }); } catch (_e) {}
    window.location.replace(dest);
  }

  function wireGoogleButton() {
    const btn = $("login-google-btn");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      paintInlineMsg("", false);
      btn.disabled = true;
      try {
        if (window.STAFF_AUTH && typeof window.STAFF_AUTH.signIn === "function") {
          await window.STAFF_AUTH.signIn();
        } else {
          // Fallback: direct popup if STAFF_AUTH helper isn't exposed.
          const provider = new firebase.auth.GoogleAuthProvider();
          provider.setCustomParameters({ prompt: "select_account" });
          await firebase.auth().signInWithPopup(provider);
        }
        // onAuthorized callback below handles the redirect.
      } catch (err) {
        console.warn("[login] google sign-in failed", err);
        const code = err && err.code;
        if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
          // User dismissed the popup — silent.
        } else {
          paintInlineMsg("Google sign-in didn't complete. Try again, or use email + password below.", true);
        }
      } finally {
        btn.disabled = false;
      }
    });
  }

  function wirePasswordForm() {
    const form = $("staff-password-form");
    if (!form) return;
    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      paintInlineMsg("", false);
      const emailEl = $("staff-email");
      const pwEl    = $("staff-password");
      const submit  = $("staff-password-submit");
      const email   = (emailEl && emailEl.value || "").trim();
      const pw      = pwEl && pwEl.value || "";
      if (!email || !pw) {
        paintInlineMsg("Enter your email and password.", true);
        return;
      }
      if (submit) submit.disabled = true;
      try {
        if (window.STAFF_AUTH && typeof window.STAFF_AUTH.signInWithPassword === "function") {
          await window.STAFF_AUTH.signInWithPassword(email, pw);
        } else {
          await firebase.auth().signInWithEmailAndPassword(email, pw);
        }
        // onAuthorized handles redirect.
      } catch (err) {
        const code = err && err.code;
        console.warn("[login] password sign-in failed", code);
        paintInlineMsg(friendlyAuthError(code, email), true);
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }

  function wireForgotLink() {
    const link = $("staff-forgot-link");
    if (!link) return;
    link.addEventListener("click", async function () {
      paintInlineMsg("", false);
      const emailEl = $("staff-email");
      const email = (emailEl && emailEl.value || "").trim();
      if (!email) {
        paintInlineMsg("Type your email above first, then tap Forgot password.", true);
        if (emailEl) emailEl.focus();
        return;
      }
      try {
        if (window.STAFF_AUTH && typeof window.STAFF_AUTH.sendPasswordReset === "function") {
          const res = await window.STAFF_AUTH.sendPasswordReset(email);
          if (res && res.ok) {
            paintInlineMsg(res.message, false);
          } else {
            paintInlineMsg((res && res.message) || friendlyAuthError(res && res.code, email), true);
          }
        } else {
          await firebase.auth().sendPasswordResetEmail(email, {
            url: window.location.origin + "/login.html",
            handleCodeInApp: false
          });
          paintInlineMsg("If an account exists for that email, a reset link has been sent. Check your inbox and spam folder.", false);
        }
      } catch (err) {
        const code = err && err.code;
        console.warn("[login] reset send failed", code);
        paintInlineMsg(friendlyAuthError(code, email), true);
      }
    });
  }

  function wireSignOutButtons() {
    document.querySelectorAll("[data-staff-signout]").forEach(function (b) {
      b.addEventListener("click", function () {
        try { firebase.auth().signOut(); } catch (_e) {}
        setState("signin");
      });
    });
  }

  function friendlyAuthError(code, email) {
    switch (code) {
      case "auth/invalid-email":
        return "That doesn't look like a valid email address.";
      case "auth/user-not-found":
      case "auth/wrong-password":
      case "auth/invalid-credential":
      case "auth/invalid-login-credentials":
        return "Email or password didn't match. Tap Forgot password to set a new one — or use Google above.";
      case "auth/too-many-requests":
        return "Too many tries — wait a couple minutes, then try again. Or text Kirby or Nick.";
      case "auth/user-disabled":
        return "This account is disabled. Text Kirby or Nick to reactivate.";
      case "auth/network-request-failed":
        return "Network glitch. Check your connection and try again.";
      case "auth/popup-blocked":
        return "Your browser blocked the Google popup. Allow popups for this site, or use email + password.";
      case "auth/account-exists-with-different-credential":
        return "This email is already linked to a different sign-in method. Try Google above.";
      default:
        return "Something didn't work. Try again, or text Kirby or Nick for help.";
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    setState("checking");
    wireGoogleButton();
    wirePasswordForm();
    wireForgotLink();
    wireSignOutButtons();

    try {
      window.STAFF_AUTH.init({
        onChecking:   function () { setState("checking"); },
        onSignedOut:  function () { setState("signin"); },
        onDenied:     showDenied,
        onAuthorized: redirectIntoApp
      });
    } catch (err) {
      console.error("[login] STAFF_AUTH init failed", err);
      setState("signin");
      paintInlineMsg("Sign-in isn't loading. Hard-reload (Cmd+Shift+R) or text Kirby/Nick.", true);
    }
  });
})();
