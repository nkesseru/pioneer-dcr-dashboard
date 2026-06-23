/* feedback-compliment.js — wiring for the compliment landing page.
 *
 * Reads dcrId / customerId / techId from the URL, manages the star
 * rating widget (default 5), and POSTs to submitFeedbackV1.
 *
 * No Firebase SDK on this page — the backing Function is a public
 * HTTPS endpoint and accepts plain fetch POSTs. Keeps the landing page
 * dependency-free so it loads fast on slow mobile connections.
 */

(function () {
  'use strict';

  const FUNCTION_URL =
    'https://us-central1-pioneer-dcr-hub.cloudfunctions.net/submitFeedbackV1';

  // ---- URL params -----------------------------------------------------------
  const params = new URLSearchParams(window.location.search);
  const dcrId      = (params.get('dcrId')      || '').slice(0, 120);
  const customerId = (params.get('customerId') || '').slice(0, 120);
  const techId     = (params.get('techId')     || '').slice(0, 120);

  // Context strip — best-effort. Pure cosmetic; the function does the
  // authoritative resolution server-side.
  if (customerId || techId) {
    const el = document.getElementById('fb-context');
    el.style.display = 'block';
    el.innerHTML =
      'Linking your compliment to ' +
      (customerId ? ('<strong>' + escapeHtml(customerId) + '</strong>') : 'your location') +
      (techId     ? (' &middot; tech <strong>' + escapeHtml(techId) + '</strong>') : '') +
      '.';
  }

  // ---- Star rating widget ---------------------------------------------------
  // Default to 5 stars per spec. Clicking a star sets the rating to its
  // value; the visual fill spans 1..N to convey "this rating, not just
  // this star". Keyboard arrows / Home / End cycle the rating for a11y.
  let rating = 5;
  const starButtons = Array.prototype.slice.call(
    document.querySelectorAll('.fb-star')
  );
  function paintStars() {
    starButtons.forEach(function (b) {
      const v = Number(b.getAttribute('data-value'));
      b.classList.toggle('is-active', v <= rating);
      b.setAttribute('aria-checked', String(v === rating));
    });
  }
  starButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      rating = Number(b.getAttribute('data-value')) || 5;
      paintStars();
    });
  });
  // Keyboard nudge for accessibility — left/right cycle.
  document.addEventListener('keydown', function (e) {
    if (!document.activeElement || !document.activeElement.classList.contains('fb-star')) return;
    if (e.key === 'ArrowRight') { rating = Math.min(5, rating + 1); paintStars(); e.preventDefault(); }
    if (e.key === 'ArrowLeft')  { rating = Math.max(1, rating - 1); paintStars(); e.preventDefault(); }
    if (e.key === 'Home')       { rating = 1; paintStars(); e.preventDefault(); }
    if (e.key === 'End')        { rating = 5; paintStars(); e.preventDefault(); }
  });
  paintStars();

  // ---- Submit ---------------------------------------------------------------
  const form     = document.getElementById('fb-form');
  const submitEl = document.getElementById('fb-submit');
  const resultEl = document.getElementById('fb-result');

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    resultEl.innerHTML = '';

    submitEl.disabled    = true;
    submitEl.textContent = 'Sending…';

    const fd = new FormData(form);
    const body = {
      type:            'compliment',
      dcrId:           dcrId,
      customerId:      customerId,
      techId:          techId,
      rating:          rating,
      complimentText:  String(fd.get('complimentText') || ''),
      customerName:    String(fd.get('customerName') || ''),
      shareConsent:    fd.get('shareConsent') === 'true',
      _hp_website:     String(fd.get('_hp_website') || '')
    };

    try {
      const res = await fetch(FUNCTION_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body)
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) {
        throw new Error(data.error || ('HTTP ' + res.status));
      }
      // Personalized thank-you. Tech name comes from the URL when the
      // email pre-populated it; otherwise generic.
      const personalize = techId
        ? ('We’ll make sure ' + escapeHtml(humanizeSlug(techId)) + ' sees it.')
        : 'We’ll make sure the team sees it.';
      resultEl.innerHTML =
        '<div class="fb-success">' +
        '<strong>Thank you — this means a lot.</strong><br/>' +
        personalize +
        '</div>';
      // Lock the form so re-submission isn't possible.
      Array.prototype.slice.call(form.querySelectorAll('input, textarea, button'))
        .forEach(function (el) { el.disabled = true; });
      submitEl.textContent = 'Sent';
    } catch (err) {
      submitEl.disabled    = false;
      submitEl.textContent = 'Send Compliment';
      resultEl.innerHTML =
        '<div class="fb-error">' +
        '<strong>Something went wrong.</strong><br/>' +
        'Please try again, or email <a href="mailto:info@pioneercomclean.com">info@pioneercomclean.com</a>. ' +
        'Error: ' + escapeHtml(String(err && err.message || err)) +
        '</div>';
    }
  });

  // ---- helpers --------------------------------------------------------------
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // "april-k" → "April K", "drew-c" → "Drew C", etc. Cosmetic only.
  function humanizeSlug(slug) {
    return String(slug || '')
      .split(/[-_]+/)
      .filter(Boolean)
      .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); })
      .join(' ')
      .trim();
  }
})();
