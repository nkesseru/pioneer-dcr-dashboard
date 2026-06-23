/* feedback-issue.js — wiring for the concern/complaint landing page.
 *
 * Reads dcrId / customerId / techId from URL, handles photo uploads
 * (client-side base64 encode, ≤3 files, ≤2MB each), POSTs to
 * submitFeedbackV1.
 *
 * No Firebase SDK on this page — the public Function endpoint accepts
 * a plain fetch POST with base64 image payloads, and uploads to
 * Storage server-side via the Admin SDK. That keeps the public
 * Storage rules locked down (no anonymous-write paths to abuse).
 */

(function () {
  'use strict';

  const FUNCTION_URL =
    'https://us-central1-pioneer-dcr-hub.cloudfunctions.net/submitFeedbackV1';

  const MAX_PHOTOS    = 3;
  const MAX_PHOTO_MB  = 2;
  const MAX_PHOTO_BYTES = MAX_PHOTO_MB * 1024 * 1024;

  const params = new URLSearchParams(window.location.search);
  const dcrId      = (params.get('dcrId')      || '').slice(0, 120);
  const customerId = (params.get('customerId') || '').slice(0, 120);
  const techId     = (params.get('techId')     || '').slice(0, 120);

  if (customerId || techId) {
    const el = document.getElementById('fb-context');
    el.style.display = 'block';
    el.innerHTML =
      'Linking your concern to ' +
      (customerId ? ('<strong>' + escapeHtml(customerId) + '</strong>') : 'your location') +
      (techId     ? (' &middot; visit by <strong>' + escapeHtml(techId) + '</strong>') : '') +
      '.';
  }

  // ---- Photo handling -------------------------------------------------------
  // Photos are read client-side via FileReader → base64. The Function
  // bouncer caps each file at 2MB and refuses anything that doesn't
  // decode to image bytes, so size/type validation here is purely UX
  // (faster feedback for the customer than a server roundtrip).
  /** @type {Array<{name: string, contentType: string, base64: string, dataUrl: string}>} */
  const stagedPhotos = [];

  const photoInput  = document.getElementById('fb-photo-input');
  const photoList   = document.getElementById('fb-photo-list');
  const photoError  = document.getElementById('fb-photo-error');

  photoInput.addEventListener('change', async function () {
    photoError.textContent = '';
    const files = Array.prototype.slice.call(photoInput.files || []);
    for (const file of files) {
      if (stagedPhotos.length >= MAX_PHOTOS) {
        photoError.textContent = 'Max ' + MAX_PHOTOS + ' photos.';
        break;
      }
      if (!/^image\//i.test(file.type)) {
        photoError.textContent = 'Please pick image files only.';
        continue;
      }
      if (file.size > MAX_PHOTO_BYTES) {
        photoError.textContent = file.name + ' is over ' + MAX_PHOTO_MB + 'MB.';
        continue;
      }
      try {
        const dataUrl = await readAsDataUrl(file);
        const base64  = dataUrl.substring(dataUrl.indexOf(',') + 1);
        stagedPhotos.push({
          name:        file.name,
          contentType: file.type,
          base64:      base64,
          dataUrl:     dataUrl
        });
      } catch (e) {
        photoError.textContent = 'Could not read ' + file.name + '.';
      }
    }
    photoInput.value = '';     // allow re-picking the same file
    renderPhotos();
  });

  function renderPhotos() {
    photoList.innerHTML = '';
    stagedPhotos.forEach(function (p, idx) {
      const thumb = document.createElement('div');
      thumb.className = 'fb-photo-thumb';
      const img = document.createElement('img');
      img.alt   = p.name;
      img.src   = p.dataUrl;
      thumb.appendChild(img);
      const btn = document.createElement('button');
      btn.type        = 'button';
      btn.setAttribute('aria-label', 'Remove ' + p.name);
      btn.textContent = '×';
      btn.addEventListener('click', function () {
        stagedPhotos.splice(idx, 1);
        renderPhotos();
      });
      thumb.appendChild(btn);
      photoList.appendChild(thumb);
    });
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload  = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(fr.error || new Error('read failed')); };
      fr.readAsDataURL(file);
    });
  }

  // ---- Submit ---------------------------------------------------------------
  const form     = document.getElementById('fb-form');
  const submitEl = document.getElementById('fb-submit');
  const resultEl = document.getElementById('fb-result');

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    resultEl.innerHTML = '';

    const fd = new FormData(form);
    const category = String(fd.get('category') || '');
    const urgency  = String(fd.get('urgency')  || '');
    const details  = String(fd.get('details')  || '').trim();

    // Inline validation — the function will re-validate, but a clear
    // client-side message is friendlier than a 400 round-trip.
    if (!category)        return showError('Please choose a category.');
    if (!urgency)         return showError('Please pick how urgent this is.');
    if (details.length < 5) return showError('Please tell us a bit more about what happened.');

    submitEl.disabled    = true;
    submitEl.textContent = 'Sending…';

    const body = {
      type:         'complaint',
      dcrId:        dcrId,
      customerId:   customerId,
      techId:       techId,
      category:     category,
      urgency:      urgency,
      details:      details,
      contactName:  String(fd.get('contactName')  || ''),
      contactEmail: String(fd.get('contactEmail') || ''),
      contactPhone: String(fd.get('contactPhone') || ''),
      photos:       stagedPhotos.map(function (p) {
        return { name: p.name, contentType: p.contentType, base64: p.base64 };
      }),
      _hp_website:  String(fd.get('_hp_website') || '')
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
      resultEl.innerHTML =
        '<div class="fb-success">' +
        '<strong>Thanks — we’ve got it.</strong><br/>' +
        'Our office team will review your concern and follow up. If urgent, expect a call soon.' +
        '</div>';
      Array.prototype.slice.call(form.querySelectorAll('input, textarea, select, button'))
        .forEach(function (el) { el.disabled = true; });
      submitEl.textContent = 'Sent';
    } catch (err) {
      submitEl.disabled    = false;
      submitEl.textContent = 'Send Concern';
      resultEl.innerHTML =
        '<div class="fb-error">' +
        '<strong>We couldn’t send that.</strong><br/>' +
        'Please try again, or email <a href="mailto:info@pioneercomclean.com">info@pioneercomclean.com</a> and we’ll get on it. ' +
        'Error: ' + escapeHtml(String(err && err.message || err)) +
        '</div>';
    }
  });

  function showError(msg) {
    resultEl.innerHTML = '<div class="fb-error">' + escapeHtml(msg) + '</div>';
    return false;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
})();
