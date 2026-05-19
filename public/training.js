/* ====================================================================
 * training.js — shared module for /training.html and /lesson.html.
 *
 * One file, two surfaces. We branch on what DOM the page exposes:
 *   • /training.html — has #training-lib-grid → renderLibrary()
 *   • /lesson.html   — has #lesson-card      → renderLesson()
 *
 * Data sources:
 *   • Lessons:  public/data/training-lessons.json   (static, hosted)
 *   • Progress: users/{uid}/training_progress/{lessonId}  (per-user)
 *
 * Lesson schema (see public/data/training-lessons.json):
 *   { id, title, category, estimatedMinutes, summary,
 *     sections: [{ heading, body }],
 *     quiz:     [{ q, options[], answer }],   // optional
 *     acknowledgmentText: "..." }
 *
 * Progress doc schema (firestore.rules enforces own-write):
 *   { lessonId, status: "in_progress"|"completed",
 *     score: 0..100|null, acknowledgmentSignedAt: Timestamp|null,
 *     acknowledgmentText: string, userAgent: string,
 *     completedAt: Timestamp|null, updatedAt: Timestamp }
 *
 * The library reads progress on render to badge each lesson card.
 * The lesson writes a "started" doc on quiz submit, then merges in
 * the completion fields on acknowledge.
 * ================================================================== */
(function () {
  "use strict";

  // ---------- tiny DOM helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function nl2br(s) {
    return esc(s).replace(/\n/g, "<br/>");
  }

  // ---------- KEEP IN SYNC nav: see other staff pages ----------
  // training is exposed to admin + cleaning_tech (same audience as
  // Customer Info Hub). Adding it here matches the unhidden entry
  // commented out in tech.js / app.js / admin.js / supply-station.js
  // / team-hub.js / inspections.js — when you next edit those files,
  // uncomment the matching `training` line so the nav stays
  // consistent across surfaces.
  const ROLE_NAV_ITEMS = [
    { key: "today-work",     label: "Today's Work",         href: "/work.html",           roles: ["admin", "cleaning_tech"] },
    { key: "dcr",            label: "DCR",                  href: "/",                    roles: ["admin", "cleaning_tech"] },
    { key: "customer-info",  label: "Customer Info Hub",    href: "/tech.html",           roles: ["admin", "cleaning_tech"] },
    { key: "supply-station", label: "Supply Station Order", href: "/supply-station.html", roles: ["admin", "cleaning_tech"] },
    { key: "team-hub",       label: "Pioneer Team Hub",     href: "/team-hub.html",       roles: ["admin", "cleaning_tech"] },
    { key: "training",       label: "Safety Training",      href: "/training.html",       roles: ["admin", "cleaning_tech"] },
    { key: "inspections",    label: "Inspections",          href: "/inspections.html",    roles: ["admin"] },
    { key: "admin",          label: "Admin",                href: "/admin",               roles: ["admin"] }
  ];
  function withCurrentSearch(href) {
    const s = (typeof location !== "undefined" && location.search) || "";
    if (!s) return href;
    return href + (href.indexOf("?") >= 0 ? "&" + s.slice(1) : s);
  }
  function renderRoleNav(role) {
    const nav = $("role-nav");
    if (!nav) return;
    if (!role) { nav.hidden = true; nav.innerHTML = ""; return; }
    const current = nav.dataset.currentPage || "";
    const items = ROLE_NAV_ITEMS.filter(function (i) { return i.roles.indexOf(role) >= 0; });
    nav.innerHTML = items.map(function (i) {
      const isActive = i.key === current;
      const cls = "role-nav-link" + (isActive ? " is-active" : "");
      if (isActive) return '<span class="' + cls + '" aria-current="page">' + esc(i.label) + '</span>';
      return '<a class="' + cls + '" href="' + esc(withCurrentSearch(i.href)) + '">' + esc(i.label) + '</a>';
    }).join("");
    nav.hidden = false;
  }
  function paintStaffIdentity(staff) {
    const nameEl  = $("staff-header-name");
    const emailEl = $("staff-header-email");
    const account = $("staff-header-account");
    const display = (staff && staff.tech && staff.tech.display_name) ||
                    (staff && staff.displayName) ||
                    (staff && staff.email) || "";
    if (nameEl)  nameEl.textContent  = display;
    if (emailEl) emailEl.textContent = (staff && staff.email) || "";
    if (account) account.hidden = !display && !(staff && staff.email);
  }

  // ---------- staff-auth state machine UI ----------
  function setStaffAuthState(state) {
    const checking = $("staff-auth-checking");
    const signin   = $("staff-auth-signin");
    const denied   = $("staff-auth-denied");
    const content  = $("staff-auth-content");
    if (checking) checking.hidden = state !== "checking";
    if (signin)   signin.hidden   = state !== "signin";
    if (denied)   denied.hidden   = state !== "denied";
    if (content)  content.hidden  = state !== "content";
    document.body.classList.toggle("is-signing-in", state === "checking" || state === "signin");
  }
  function wireSignInButton() {
    const btn = $("staff-signin-btn");
    if (btn) btn.addEventListener("click", function () {
      if (window.STAFF_AUTH && typeof window.STAFF_AUTH.signInWithGoogle === "function") {
        window.STAFF_AUTH.signInWithGoogle();
      }
    });
    const form = $("staff-password-form");
    if (form) form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (window.STAFF_AUTH && typeof window.STAFF_AUTH.signInWithEmail === "function") {
        const email = ($("staff-email") || {}).value || "";
        const pw    = ($("staff-password") || {}).value || "";
        window.STAFF_AUTH.signInWithEmail(email, pw);
      }
    });
    const forgot = $("staff-forgot-link");
    if (forgot) forgot.addEventListener("click", function () {
      if (window.STAFF_AUTH && typeof window.STAFF_AUTH.sendResetEmail === "function") {
        const email = ($("staff-email") || {}).value || "";
        window.STAFF_AUTH.sendResetEmail(email);
      }
    });
  }
  function wireSignOutButtons() {
    document.querySelectorAll("[data-staff-signout]").forEach(function (el) {
      el.addEventListener("click", function () {
        if (window.STAFF_AUTH) window.STAFF_AUTH.signOut();
      });
    });
  }

  // ---------- Data loaders ----------
  let _lessonsCache = null;
  async function loadLessons() {
    if (_lessonsCache) return _lessonsCache;
    // Cache-bust on deploy by appending the build query string that
    // other Pioneer pages use; otherwise just fetch.
    const url = "data/training-lessons.json" +
                (location.search.indexOf("v=") >= 0 ? location.search : "");
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error("Couldn't load lesson catalog (" + res.status + ")");
    const json = await res.json();
    if (!json || !Array.isArray(json.lessons)) throw new Error("Lesson catalog is malformed");
    _lessonsCache = json;
    return json;
  }
  async function loadAllProgressForUser(uid) {
    if (!uid || !window.firebase || typeof firebase.firestore !== "function") return {};
    const db = firebase.firestore();
    try {
      const snap = await db.collection("users").doc(uid).collection("training_progress").get();
      const out = {};
      snap.docs.forEach(function (d) { out[d.id] = d.data() || {}; });
      return out;
    } catch (err) {
      console.warn("[training] progress read failed:", err && err.code || err);
      return {};
    }
  }
  async function loadOneProgress(uid, lessonId) {
    if (!uid || !lessonId || !window.firebase) return null;
    const db = firebase.firestore();
    try {
      const d = await db.collection("users").doc(uid).collection("training_progress").doc(lessonId).get();
      return d.exists ? (d.data() || null) : null;
    } catch (err) {
      console.warn("[training] one-progress read failed:", err && err.code || err);
      return null;
    }
  }
  async function writeProgress(uid, lessonId, patch) {
    if (!uid || !lessonId || !window.firebase) throw new Error("Not signed in");
    const db = firebase.firestore();
    const FV = firebase.firestore.FieldValue;
    const payload = Object.assign({
      lessonId:  lessonId,
      userAgent: String(navigator.userAgent || "").slice(0, 500),
      updatedAt: FV.serverTimestamp()
    }, patch || {});
    await db.collection("users").doc(uid).collection("training_progress").doc(lessonId)
            .set(payload, { merge: true });
  }

  // ---------- LIBRARY view ----------
  function statusBadge(status) {
    if (status === "completed")   return '<span class="lib-card-status is-done">✓ Completed</span>';
    if (status === "in_progress") return '<span class="lib-card-status is-mid">In progress</span>';
    return '<span class="lib-card-status is-new">Not started</span>';
  }

  function libraryCardHtml(lesson, progress) {
    const status   = (progress && progress.status) || "not_started";
    const minutes  = Number(lesson.estimatedMinutes) || null;
    const catLabel = lesson.category ? esc(lesson.category) : "Safety";
    return (
      '<a class="lib-card" href="/lesson.html?lessonId=' + encodeURIComponent(lesson.id) + '">' +
        '<div class="lib-card-eyebrow-row">' +
          '<span class="lib-card-eyebrow">' + catLabel + '</span>' +
          statusBadge(status) +
        '</div>' +
        '<h3 class="lib-card-title">' + esc(lesson.title) + '</h3>' +
        '<p class="lib-card-summary">' + esc(lesson.summary || "") + '</p>' +
        '<div class="lib-card-foot">' +
          '<span class="lib-card-id">' + esc(lesson.id) + '</span>' +
          (minutes ? ('<span class="lib-card-mins">~' + minutes + ' min</span>') : '') +
        '</div>' +
      '</a>'
    );
  }

  async function renderLibrary(staff) {
    const grid     = $("training-lib-grid");
    const loading  = $("training-lib-loading");
    const errorEl  = $("training-lib-error");
    const emptyEl  = $("training-lib-empty");
    if (!grid) return;
    let catalog, progressMap;
    try {
      catalog = await loadLessons();
    } catch (err) {
      if (loading) loading.hidden = true;
      if (errorEl) { errorEl.hidden = false; errorEl.textContent = (err && err.message) || "Couldn't load lessons."; }
      return;
    }
    try {
      progressMap = await loadAllProgressForUser(staff && staff.uid);
    } catch (_e) {
      progressMap = {};
    }
    const lessons = catalog.lessons || [];
    if (loading) loading.hidden = true;
    if (!lessons.length) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    grid.innerHTML = lessons.map(function (l) {
      return libraryCardHtml(l, progressMap[l.id]);
    }).join("");
    grid.hidden = false;
  }

  // ---------- LESSON view ----------
  function getLessonIdFromUrl() {
    const m = location.search.match(/[?&]lessonId=([A-Za-z0-9_-]{1,40})/);
    return m ? m[1] : "";
  }

  function lessonSectionsHtml(sections) {
    if (!Array.isArray(sections) || !sections.length) return "";
    return (
      '<div class="lesson-sections">' +
        sections.map(function (s) {
          return (
            '<section class="lesson-section">' +
              '<h3 class="lesson-section-head">' + esc(s.heading || "") + '</h3>' +
              '<div class="lesson-section-body">' + nl2br(s.body || "") + '</div>' +
            '</section>'
          );
        }).join("") +
      '</div>'
    );
  }

  function lessonQuizHtml(quiz) {
    if (!Array.isArray(quiz) || !quiz.length) return "";
    const qhtml = quiz.map(function (q, qi) {
      const opts = (q.options || []).map(function (opt, oi) {
        const id = "quiz-q" + qi + "-o" + oi;
        return (
          '<label class="lesson-quiz-option" for="' + id + '">' +
            '<input type="radio" id="' + id + '" name="quiz-q' + qi + '" value="' + oi + '" />' +
            '<span>' + esc(opt) + '</span>' +
          '</label>'
        );
      }).join("");
      return (
        '<fieldset class="lesson-quiz-q" data-q="' + qi + '" data-answer="' + Number(q.answer || 0) + '">' +
          '<legend class="lesson-quiz-q-text">Q' + (qi + 1) + '. ' + esc(q.q) + '</legend>' +
          '<div class="lesson-quiz-options">' + opts + '</div>' +
          '<div class="lesson-quiz-feedback" hidden></div>' +
        '</fieldset>'
      );
    }).join("");
    return (
      '<section class="lesson-quiz" id="lesson-quiz">' +
        '<h3 class="lesson-quiz-head">Quick check</h3>' +
        '<p class="lesson-quiz-sub">Pick the best answer. You can change your answers before submitting.</p>' +
        qhtml +
        '<div class="lesson-quiz-err" id="lesson-quiz-err" hidden></div>' +
        '<button type="button" class="lesson-quiz-submit" id="lesson-quiz-submit">Submit answers</button>' +
        '<div class="lesson-quiz-score" id="lesson-quiz-score" hidden></div>' +
      '</section>'
    );
  }

  function lessonAckHtml(lesson) {
    return (
      '<section class="lesson-ack" id="lesson-ack" hidden>' +
        '<h3 class="lesson-ack-head">Acknowledgment</h3>' +
        '<p class="lesson-ack-body">' + esc(lesson.acknowledgmentText || "") + '</p>' +
        '<label class="lesson-ack-name">' +
          '<span class="lesson-ack-name-label">Type your name to sign</span>' +
          '<input type="text" id="lesson-ack-name-input" autocomplete="name"' +
            ' placeholder="Your full name" maxlength="100" />' +
        '</label>' +
        '<div class="lesson-ack-err" id="lesson-ack-err" hidden></div>' +
        '<button type="button" class="lesson-ack-submit" id="lesson-ack-submit">' +
          'Sign acknowledgment &amp; finish' +
        '</button>' +
        '<div class="lesson-ack-done" id="lesson-ack-done" hidden>' +
          '<span class="lesson-ack-done-mark" aria-hidden="true">✓</span>' +
          '<div>' +
            '<strong>You’re done with this lesson.</strong>' +
            '<p class="lesson-ack-done-sub">Saved to your training record. ' +
            '<a href="/training.html">Back to lesson library</a>.</p>' +
          '</div>' +
        '</div>' +
      '</section>'
    );
  }

  function lessonAlreadyDoneHtml(progress) {
    if (!progress || progress.status !== "completed") return "";
    let when = "";
    const ts = progress.completedAt || progress.acknowledgmentSignedAt;
    if (ts) {
      try {
        const d = ts.toDate ? ts.toDate() : (typeof ts === "string" ? new Date(ts) : null);
        if (d && !isNaN(d.getTime())) {
          when = " on " + d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
        }
      } catch (_e) { /* noop */ }
    }
    const scoreNote = (progress.score != null) ? (" · score " + progress.score + "%") : "";
    return (
      '<div class="lesson-already-done">' +
        '<span class="lesson-already-done-mark" aria-hidden="true">✓</span>' +
        '<div>' +
          '<strong>You’ve already completed this lesson' + esc(when) + '.</strong>' +
          '<p>You can re-read it any time. A repeat acknowledgment will update your record.' + esc(scoreNote) + '</p>' +
        '</div>' +
      '</div>'
    );
  }

  function getRadioValue(name) {
    const els = document.getElementsByName(name);
    for (let i = 0; i < els.length; i++) if (els[i].checked) return els[i].value;
    return null;
  }

  function gradeQuiz(quiz) {
    if (!Array.isArray(quiz) || !quiz.length) return { ok: true, score: 100, total: 0, correct: 0 };
    let correct = 0;
    let unanswered = false;
    quiz.forEach(function (q, qi) {
      const v = getRadioValue("quiz-q" + qi);
      if (v == null) { unanswered = true; return; }
      if (Number(v) === Number(q.answer || 0)) correct += 1;
    });
    if (unanswered) return { ok: false, score: null, total: quiz.length, correct: correct, unanswered: true };
    const score = Math.round((correct / quiz.length) * 100);
    return { ok: true, score: score, total: quiz.length, correct: correct };
  }

  async function renderLesson(staff) {
    const card        = $("lesson-card");
    const loading     = $("lesson-loading");
    const errorEl     = $("lesson-error");
    const notFoundEl  = $("lesson-not-found");
    const titleEl     = $("lesson-page-title");
    const subEl       = $("lesson-page-sub");
    if (!card) return;

    const lessonId = getLessonIdFromUrl();
    if (!lessonId) {
      if (loading) loading.hidden = true;
      if (notFoundEl) notFoundEl.hidden = false;
      return;
    }

    let catalog;
    try { catalog = await loadLessons(); }
    catch (err) {
      if (loading) loading.hidden = true;
      if (errorEl) { errorEl.hidden = false; errorEl.textContent = (err && err.message) || "Couldn't load lessons."; }
      return;
    }
    const lesson = (catalog.lessons || []).filter(function (l) { return l.id === lessonId; })[0];
    if (!lesson) {
      if (loading) loading.hidden = true;
      if (notFoundEl) notFoundEl.hidden = false;
      return;
    }

    const progress = await loadOneProgress(staff && staff.uid, lessonId);

    if (titleEl) titleEl.textContent = lesson.title;
    if (subEl)   subEl.textContent   = lesson.summary || "";
    document.title = "Pioneer Safety Training — " + lesson.title;

    const hasQuiz = Array.isArray(lesson.quiz) && lesson.quiz.length;
    card.innerHTML =
      '<div class="lesson-head">' +
        '<span class="lesson-eyebrow">' + esc(lesson.category || "Safety") + ' · ' + esc(lesson.id) + '</span>' +
        '<h2 class="lesson-title">' + esc(lesson.title) + '</h2>' +
        (Number(lesson.estimatedMinutes) ? '<p class="lesson-mins">~' + Number(lesson.estimatedMinutes) + ' min read</p>' : '') +
      '</div>' +
      lessonAlreadyDoneHtml(progress) +
      lessonSectionsHtml(lesson.sections) +
      (hasQuiz ? lessonQuizHtml(lesson.quiz) : '') +
      lessonAckHtml(lesson);
    card.hidden = false;
    if (loading) loading.hidden = true;

    // If no quiz, reveal the acknowledgment immediately.
    if (!hasQuiz) {
      const ackEl = $("lesson-ack");
      if (ackEl) ackEl.hidden = false;
    }

    // Wire quiz submit.
    const quizBtn = $("lesson-quiz-submit");
    if (quizBtn) quizBtn.addEventListener("click", async function () {
      const errEl   = $("lesson-quiz-err");
      const scoreEl = $("lesson-quiz-score");
      const result  = gradeQuiz(lesson.quiz);
      if (errEl) errEl.hidden = true;
      if (!result.ok) {
        if (errEl) { errEl.hidden = false; errEl.textContent = "Please answer every question before submitting."; }
        return;
      }
      // Per-question feedback.
      document.querySelectorAll(".lesson-quiz-q").forEach(function (f) {
        const qi      = Number(f.dataset.q);
        const answer  = Number(f.dataset.answer || 0);
        const chosen  = getRadioValue("quiz-q" + qi);
        const fb      = f.querySelector(".lesson-quiz-feedback");
        const correct = Number(chosen) === answer;
        if (fb) {
          fb.hidden = false;
          fb.textContent = correct ? "Correct." : "Not quite — review the lesson for this one.";
          fb.className = "lesson-quiz-feedback " + (correct ? "is-correct" : "is-incorrect");
        }
      });
      if (scoreEl) {
        scoreEl.hidden = false;
        scoreEl.textContent =
          "Score: " + result.score + "% (" + result.correct + "/" + result.total + " correct).";
      }
      // Mark as "in_progress" with score.
      try {
        await writeProgress(staff.uid, lesson.id, {
          status:             "in_progress",
          score:              result.score,
          acknowledgmentText: lesson.acknowledgmentText || ""
        });
      } catch (err) {
        console.warn("[training] in-progress write failed:", err && err.message || err);
      }
      // Reveal acknowledgment block.
      const ackEl = $("lesson-ack");
      if (ackEl) {
        ackEl.hidden = false;
        ackEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });

    // Wire acknowledgment submit.
    const ackBtn = $("lesson-ack-submit");
    if (ackBtn) ackBtn.addEventListener("click", async function () {
      const nameInput = $("lesson-ack-name-input");
      const errEl     = $("lesson-ack-err");
      const doneEl    = $("lesson-ack-done");
      const typedName = String((nameInput && nameInput.value) || "").trim();
      if (errEl) errEl.hidden = true;
      if (!typedName) {
        if (errEl) { errEl.hidden = false; errEl.textContent = "Type your name above to sign."; }
        if (nameInput) nameInput.focus();
        return;
      }
      ackBtn.disabled = true;
      ackBtn.textContent = "Saving…";
      try {
        const FV = firebase.firestore.FieldValue;
        // Re-grade quiz at completion in case the user didn't click
        // Submit again after changing an answer. If no quiz, score = null.
        const reGrade = hasQuiz ? gradeQuiz(lesson.quiz) : { score: null };
        await writeProgress(staff.uid, lesson.id, {
          status:                  "completed",
          score:                   reGrade.score,
          acknowledgmentText:      lesson.acknowledgmentText || "",
          acknowledgmentSignedAt:  FV.serverTimestamp(),
          completedAt:             FV.serverTimestamp(),
          signedName:              typedName.slice(0, 100),
          // Store email + display name for the admin report so the
          // admin doesn't have to cross-reference Auth UIDs.
          uid:                     staff.uid,
          email:                   String((staff.email || "")).toLowerCase().slice(0, 200),
          displayName:             String((staff.tech && staff.tech.display_name) ||
                                          (staff.displayName) || typedName).slice(0, 120)
        });
        ackBtn.hidden = true;
        if (doneEl) doneEl.hidden = false;
      } catch (err) {
        console.error("[training] completion write failed:", err);
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = (err && err.code === "permission-denied")
            ? "Permission denied. Please refresh and sign in again."
            : "Couldn't save your acknowledgment. Check your connection and try again.";
        }
        ackBtn.disabled = false;
        ackBtn.textContent = "Sign acknowledgment & finish";
      }
    });
  }

  // ---------- boot ----------
  document.addEventListener("DOMContentLoaded", function () {
    wireSignInButton();
    wireSignOutButtons();
    setStaffAuthState("checking");
    try {
      window.STAFF_AUTH.init({
        onChecking:  function () { setStaffAuthState("checking"); },
        onSignedOut: function () { setStaffAuthState("signin"); },
        onDenied:    function (info) {
          setStaffAuthState("denied");
          const msgEl = $("staff-auth-denied-msg");
          if (msgEl && info && info.message) msgEl.textContent = info.message;
        },
        onAuthorized: function (staff) {
          setStaffAuthState("content");
          paintStaffIdentity(staff);
          renderRoleNav(staff && staff.role);
          // Branch by which page we're on:
          if (document.getElementById("training-lib-grid")) {
            renderLibrary(staff);
          } else if (document.getElementById("lesson-card")) {
            renderLesson(staff);
          }
        }
      });
    } catch (err) {
      console.error("STAFF_AUTH.init failed", err);
      setStaffAuthState("signin");
    }
  });

  // Expose a small surface for admin.js to reuse the catalog loader.
  window.TRAINING = { loadLessons: loadLessons };
})();
