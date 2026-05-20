/* ============================================================================
 * feedback.js — PUBLIC customer feedback intake
 *
 * Single endpoint (submitFeedbackV1) that accepts feedback from the two
 * customer-facing pages linked from the DCR email:
 *   - feedback-compliment.html  →  type: "compliment"
 *   - feedback-issue.html       →  type: "complaint"
 *
 * Auth model:
 *   Public (no Firebase Auth). Customers click links from email and land
 *   on the feedback pages anonymously. Defenses:
 *     • Strict body validation — type/length/enum whitelists.
 *     • Honeypot field rejects obvious bots (any non-empty `_hp_website`).
 *     • Length caps on every free-text field.
 *     • Body size hard cap (~7MB so 3 × ~2MB photos fit comfortably).
 *     • TODO rate-limit: add per-IP throttle once we see real traffic.
 *
 * Side effects on success:
 *   1. customer_feedback/{autoId} — universal record, written for both
 *      types (a unified place to read "what did customers tell us today?").
 *   2. quality_wins/{autoId}     — only for compliments with rating ≥ 4.
 *                                  Carries source: "customer_compliment"
 *                                  to distinguish from inspection wins.
 *   3. customer_complaints/{id}  — only for complaints. Carries the
 *      operational fields (status, urgency, severity, assignment).
 *   4. customer-complaint-photos/{complaintId}/{N}-{name}
 *                                — optional photo uploads. Firebase
 *                                  download tokens minted so URLs render
 *                                  inline in email alerts.
 *   5. notifications/{autoId}    — Team Hub celebration for compliments
 *                                  OR office-manager alert for complaints.
 *   6. Gmail alert (Workspace)   — manager + office-manager get a clear
 *                                  email for complaints; compliments
 *                                  optionally send a celebratory email.
 *
 * Returns: { ok: true, feedbackId, complaintId?, qualityWinId? }
 * ========================================================================== */

'use strict';

const crypto = require('crypto');
const { google } = require('googleapis');

const PIONEER_BRAND_NAME = "Pioneer Commercial Cleaning";
const FEEDBACK_BASE      = "https://pioneer-dcr-hub.web.app";
const STORAGE_BUCKET     = "pioneer-dcr-hub.firebasestorage.app";

// ---- Validation whitelists --------------------------------------------------
const VALID_CATEGORIES = new Set([
  "missed-area",
  "trash-recycling",
  "restroom",
  "supplies-restocking",
  "floor",
  "damage",
  "access-security",
  "other"
]);

const VALID_URGENCY = new Set([
  "wait",     // Can wait until next service
  "contact",  // Please contact me
  "asap"      // Needs attention ASAP
]);

const CATEGORY_LABELS = {
  "missed-area":          "Missed area",
  "trash-recycling":      "Trash / recycling",
  "restroom":             "Restroom issue",
  "supplies-restocking":  "Supplies / restocking",
  "floor":                "Floor issue",
  "damage":               "Damage concern",
  "access-security":      "Access / security concern",
  "other":                "Other"
};

const URGENCY_LABELS = {
  "wait":     "Can wait until next service",
  "contact":  "Please contact me",
  "asap":     "Needs attention ASAP"
};

const MAX_TEXT  = 4000;
const MAX_NAME  = 200;
const MAX_PHONE = 50;
const MAX_PHOTOS_PER_COMPLAINT = 3;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

// ---- Helpers ----------------------------------------------------------------

function clampStr(v, max) {
  if (v == null) return "";
  return String(v).trim().slice(0, max);
}

function isEmailShaped(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function htmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Severity is derived from urgency, not user-controlled, so a manager
// triaging the inbox can scan severity-sorted complaints and trust it.
function severityFromUrgency(u) {
  if (u === "asap")    return "high";
  if (u === "contact") return "medium";
  return "low";
}

// Decode a base64 data URL or raw base64 to a Buffer. Returns null on
// any decode failure so callers can soft-skip malformed photos rather
// than 500ing the whole submission.
function decodeBase64Image(input) {
  if (typeof input !== 'string') return null;
  let raw = input;
  const commaIdx = raw.indexOf(',');
  // Strip an optional `data:image/...;base64,` prefix.
  if (raw.startsWith('data:') && commaIdx > 0) raw = raw.slice(commaIdx + 1);
  try {
    const buf = Buffer.from(raw, 'base64');
    if (!buf || buf.length === 0) return null;
    return buf;
  } catch (_e) { return null; }
}

// Build a Firebase Storage long-lived download URL backed by a fresh
// download token in the object's metadata. Same pattern as the tech-
// photo uploader — works in email clients, no expiration.
function buildFirebaseTokenUrl(storagePath, token) {
  return 'https://firebasestorage.googleapis.com/v0/b/' + STORAGE_BUCKET +
         '/o/' + encodeURIComponent(storagePath) +
         '?alt=media&token=' + token;
}

// SHA-256 of the IP, truncated. We never store raw IPs (privacy), but
// the hash is enough to spot spam waves from a single origin during
// triage. Length-truncated so 32 hex chars is plenty of entropy.
function hashIp(ip) {
  if (!ip) return "";
  try {
    return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32);
  } catch (_e) { return ""; }
}

// ---- Gmail sender (inline reimplementation; matches dcrEmail.js) -----------
// Reproduced here rather than imported so feedback.js is self-contained
// — the dcrEmail module's send helper is module-local. The two
// implementations are identical in semantics; if the Gmail send rules
// change, update BOTH.
async function sendGmailMessage(opts) {
  const { to, subject, html, senderEmail, serviceAccountKey } = opts || {};
  if (!to)                throw new Error("sendGmailMessage: missing 'to'");
  if (!subject)           throw new Error("sendGmailMessage: missing 'subject'");
  if (!html)              throw new Error("sendGmailMessage: missing 'html'");
  if (!senderEmail)       throw new Error("sendGmailMessage: missing senderEmail");
  if (!serviceAccountKey) throw new Error("sendGmailMessage: missing service account key");

  let creds;
  try {
    creds = (typeof serviceAccountKey === 'string')
              ? JSON.parse(serviceAccountKey)
              : serviceAccountKey;
  } catch (e) {
    throw new Error('GMAIL_SERVICE_ACCOUNT_KEY is not valid JSON: ' + e.message);
  }
  if (!creds.client_email || !creds.private_key) {
    throw new Error('Service account key missing client_email or private_key');
  }

  const jwt = new google.auth.JWT({
    email:   creds.client_email,
    key:     creds.private_key,
    scopes:  ['https://www.googleapis.com/auth/gmail.send'],
    subject: senderEmail
  });
  await jwt.authorize();
  const gmail = google.gmail({ version: 'v1', auth: jwt });

  const fromHeader = '"' + PIONEER_BRAND_NAME + '" <' + senderEmail + '>';
  const mime = [
    'From: ' + fromHeader,
    'To: ' + to,
    'Subject: ' + subject,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    html
  ].join('\r\n');

  const raw = Buffer.from(mime, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: raw }
  });
  return res.data;
}

// ---- Resolution helpers -----------------------------------------------------

async function resolveDcr(db, dcrId, logger) {
  if (!dcrId) return null;
  try {
    const snap = await db.collection('dcr_submissions').doc(dcrId).get();
    if (!snap.exists) return null;
    return Object.assign({ id: snap.id }, snap.data());
  } catch (e) {
    logger && logger.warn('[feedback] dcr lookup failed', { dcrId, error: e.message });
    return null;
  }
}

async function resolveCustomer(db, customerId, customerSlugFromDcr, logger) {
  const id = String(customerId || '').trim();
  if (id) {
    try {
      const snap = await db.collection('customers').doc(id).get();
      if (snap.exists) return Object.assign({ id: snap.id }, snap.data());
    } catch (e) {
      logger && logger.warn('[feedback] customer direct lookup failed', { id, error: e.message });
    }
    // Slug fallback (mirrors the resolveCustomerDoc logic in dcrEmail.js).
    try {
      const q = await db.collection('customers').where('customer_slug', '==', id).limit(1).get();
      if (!q.empty) return Object.assign({ id: q.docs[0].id }, q.docs[0].data());
    } catch (e) {
      logger && logger.warn('[feedback] customer slug lookup failed', { id, error: e.message });
    }
  }
  if (customerSlugFromDcr && customerSlugFromDcr !== id) {
    try {
      const snap = await db.collection('customers').doc(customerSlugFromDcr).get();
      if (snap.exists) return Object.assign({ id: snap.id }, snap.data());
    } catch (_e) { /* tolerated */ }
  }
  return null;
}

async function resolveTech(db, techId, techSlugFromDcr, logger) {
  const id = String(techId || techSlugFromDcr || '').trim();
  if (!id) return null;
  try {
    const snap = await db.collection('cleaning_techs').doc(id).get();
    if (!snap.exists) return null;
    return Object.assign({ id: snap.id }, snap.data());
  } catch (e) {
    logger && logger.warn('[feedback] tech lookup failed', { id, error: e.message });
    return null;
  }
}

// ---- Photo upload (complaints) ----------------------------------------------

async function uploadComplaintPhotos(bucket, complaintId, photoInputs, logger) {
  const out = [];
  if (!Array.isArray(photoInputs) || photoInputs.length === 0) return out;
  const limited = photoInputs.slice(0, MAX_PHOTOS_PER_COMPLAINT);
  for (let i = 0; i < limited.length; i++) {
    const p = limited[i] || {};
    const buf = decodeBase64Image(p.base64);
    if (!buf || buf.length > MAX_PHOTO_BYTES) {
      logger && logger.warn('[feedback] skipping invalid/oversized photo', {
        complaintId, index: i, hasBuffer: !!buf, size: buf ? buf.length : 0
      });
      continue;
    }
    const contentType = (typeof p.contentType === 'string' && /^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(p.contentType))
      ? p.contentType.toLowerCase()
      : 'image/jpeg';
    // Strip any path/control chars from a user-supplied filename. Keep
    // the extension if present and safe.
    const cleanName = String(p.name || ('photo-' + (i + 1)))
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 80) || ('photo-' + (i + 1));
    const storagePath = 'customer-complaint-photos/' + complaintId + '/' + (i + 1) + '-' + cleanName;
    const token = crypto.randomUUID();

    try {
      const file = bucket.file(storagePath);
      await file.save(buf, {
        resumable: false,
        contentType: contentType,
        metadata: {
          cacheControl: 'private, max-age=86400',
          metadata: {
            firebaseStorageDownloadTokens: token
          }
        }
      });
      out.push({
        url: buildFirebaseTokenUrl(storagePath, token),
        storagePath: storagePath,
        contentType: contentType,
        size: buf.length
      });
    } catch (e) {
      logger && logger.warn('[feedback] photo upload failed', {
        complaintId, index: i, error: e.message
      });
    }
  }
  return out;
}

// ---- Notification builders --------------------------------------------------

function buildComplimentNotification(ctx) {
  return {
    type:          "quality_win",
    priority:      "low",
    audience:      ["team_hub", "customer_panel"],
    title:         "Customer compliment received",
    message:
      (ctx.customerName || "A customer") + " recognized " +
      (ctx.techDisplayName || "the Pioneer team") + " for great work" +
      (ctx.customerName ? (" at " + ctx.customerName) : "") + ".",
    celebration:   true,
    requiresAction: false,
    read:          false,
    linkedCollection: "customer_feedback",
    linkedDocId:   ctx.feedbackId,
    qualityWinId:  ctx.qualityWinId || null,
    customerId:    ctx.customerId || null,
    techId:        ctx.techId     || null,
    rating:        ctx.rating     || null,
    createdAt:     ctx.serverTimestamp
  };
}

function buildComplaintNotification(ctx) {
  return {
    type:          "customer_complaint",
    priority:      "high",
    audience:      ["office_manager", "manager"],
    assignedRoles: ["office_manager", "manager"],
    assignedUsers: ["kirby", "april"],
    title:         "Customer concern submitted",
    message:
      "A customer submitted a concern" +
      (ctx.customerName ? (" for " + ctx.customerName) : "") +
      ". Review immediately.",
    severity:      ctx.severity,
    urgency:       ctx.urgency,
    category:      ctx.category,
    requiresAction: true,
    celebration:    false,
    read:          false,
    linkedCollection: "customer_complaints",
    linkedDocId:   ctx.complaintId,
    feedbackId:    ctx.feedbackId,
    customerId:    ctx.customerId || null,
    techId:        ctx.techId     || null,
    createdAt:     ctx.serverTimestamp
  };
}

// ---- Email alert HTML builders ---------------------------------------------

function renderComplaintAlertHtml(ctx) {
  const safe = htmlEscape;
  const photosHtml = (Array.isArray(ctx.photoUploads) && ctx.photoUploads.length)
    ? ('<p style="margin:14px 0 4px;font-weight:700;">Customer photos:</p>' +
       '<table cellpadding="0" cellspacing="0" border="0"><tr>' +
       ctx.photoUploads.map(function (p) {
         return '<td valign="top" style="padding:4px;">' +
                '<a href="' + safe(p.url) + '" style="display:block;text-decoration:none;">' +
                '<img src="' + safe(p.url) + '" alt="Customer photo" ' +
                'style="display:block;width:160px;max-width:160px;height:auto;border:1px solid #E6E9EE;border-radius:8px;" />' +
                '</a></td>';
       }).join('') +
       '</tr></table>')
    : '';
  return (
    '<!doctype html><html><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#1F1F24;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#FFF3F3;">' +
    '<tr><td align="center" style="padding:24px 16px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#FFFFFF;border:1px solid #E6E9EE;border-left:4px solid #E36D6D;border-radius:12px;">' +
    '<tr><td style="padding:24px;">' +
    '<div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;font-weight:800;color:#8A2A2A;margin-bottom:8px;">Pioneer Alert · Customer concern</div>' +
    '<h1 style="margin:0 0 4px;font-size:20px;font-weight:800;line-height:1.3;">' +
      safe(ctx.customerName || 'Unspecified location') +
    '</h1>' +
    '<div style="font-size:13px;color:#475569;margin-bottom:16px;">' +
      safe(ctx.techDisplayName ? ('Tech on record: ' + ctx.techDisplayName) : 'Tech: unknown') +
      (ctx.dcrId ? ('  ·  DCR: ' + safe(ctx.dcrId)) : '') +
    '</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F5F7FA;border-radius:8px;margin-bottom:16px;"><tr>' +
      '<td style="padding:12px 14px;font-size:13px;">' +
        '<div><strong>Category:</strong> ' + safe(CATEGORY_LABELS[ctx.category] || ctx.category) + '</div>' +
        '<div><strong>Urgency:</strong> ' + safe(URGENCY_LABELS[ctx.urgency] || ctx.urgency) + '</div>' +
        '<div><strong>Severity:</strong> ' + safe(ctx.severity) + '</div>' +
      '</td>' +
    '</tr></table>' +
    '<p style="margin:0 0 4px;font-weight:700;">What the customer reported:</p>' +
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.55;white-space:pre-wrap;">' +
      safe(ctx.details || '(no details provided)') +
    '</p>' +
    (ctx.contactName || ctx.contactEmail || ctx.contactPhone
      ? ('<p style="margin:0 0 4px;font-weight:700;">Contact preference:</p>' +
         '<div style="font-size:14px;line-height:1.6;">' +
           (ctx.contactName  ? ('Name: '  + safe(ctx.contactName)  + '<br/>') : '') +
           (ctx.contactEmail ? ('Email: ' + safe(ctx.contactEmail) + '<br/>') : '') +
           (ctx.contactPhone ? ('Phone: ' + safe(ctx.contactPhone)) : '') +
         '</div>')
      : '<div style="font-size:13px;color:#475569;margin-bottom:8px;">No contact details provided by customer.</div>') +
    photosHtml +
    '<hr style="border:none;border-top:1px solid #E6E9EE;margin:20px 0;" />' +
    '<div style="font-size:12px;color:#475569;">' +
      'Complaint ID: ' + safe(ctx.complaintId) + '<br/>' +
      'Feedback ID: ' + safe(ctx.feedbackId) +
    '</div>' +
    '</td></tr></table>' +
    '</td></tr></table>' +
    '</body></html>'
  );
}

function renderComplimentAlertHtml(ctx) {
  const safe = htmlEscape;
  const stars = '★'.repeat(Math.max(0, Math.min(5, Number(ctx.rating) || 0))) +
                '☆'.repeat(Math.max(0, 5 - (Number(ctx.rating) || 0)));
  return (
    '<!doctype html><html><body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#1F1F24;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F0FBF4;">' +
    '<tr><td align="center" style="padding:24px 16px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#FFFFFF;border:1px solid #BFEACB;border-left:4px solid #34C759;border-radius:12px;">' +
    '<tr><td style="padding:24px;">' +
    '<div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;font-weight:800;color:#1B5E20;margin-bottom:8px;">Pioneer Win · Customer compliment</div>' +
    '<h1 style="margin:0 0 4px;font-size:20px;font-weight:800;line-height:1.3;">' +
      safe(ctx.techDisplayName || 'Your Pioneer team') +
    '</h1>' +
    '<div style="font-size:13px;color:#475569;margin-bottom:16px;">' +
      safe(ctx.customerName ? ('Customer: ' + ctx.customerName) : 'Customer location unspecified') +
      (ctx.dcrId ? ('  ·  DCR: ' + safe(ctx.dcrId)) : '') +
    '</div>' +
    '<div style="font-size:22px;letter-spacing:2px;color:#F5B942;margin-bottom:12px;">' + stars + '</div>' +
    (ctx.complimentText
      ? ('<p style="margin:0 0 16px;font-size:15px;line-height:1.55;white-space:pre-wrap;">' +
           safe(ctx.complimentText) + '</p>')
      : '<p style="margin:0 0 16px;font-size:14px;color:#475569;font-style:italic;">No comment provided — just the stars.</p>') +
    (ctx.contactName
      ? ('<div style="font-size:13px;color:#475569;margin-bottom:8px;">From: ' + safe(ctx.contactName) + '</div>')
      : '') +
    '<div style="font-size:12px;color:#475569;">' +
      'Share consent: ' + (ctx.shareConsent ? 'YES' : 'no') + '<br/>' +
      'Feedback ID: ' + safe(ctx.feedbackId) +
    '</div>' +
    '</td></tr></table>' +
    '</td></tr></table>' +
    '</body></html>'
  );
}

// ---- Main HTTP handler ------------------------------------------------------

function buildHttpHandler(deps) {
  const {
    admin, db, logger,
    GMAIL_SENDER_EMAIL,
    GMAIL_SERVICE_ACCOUNT_KEY,
    KIRBY_ALERT_EMAIL,
    APRIL_ALERT_EMAIL
  } = deps;

  return async function submitFeedbackV1(req, res) {
    // CORS — public endpoint. Allow any origin so the static feedback
    // pages can POST from the hosting domain (or an emulator) without
    // bouncing on preflight.
    res.set('Access-Control-Allow-Origin',  '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age',       '3600');
    res.set('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'POST only' });
      return;
    }

    const body = req.body || {};

    // Honeypot — bots fill every visible field; humans don't see this
    // one. If filled, accept the request silently (return 200 like a
    // real success) so the bot doesn't learn the form was rejected.
    if (typeof body._hp_website === 'string' && body._hp_website.trim().length > 0) {
      logger.warn('[feedback] honeypot tripped', {
        ua: clampStr(req.headers['user-agent'], 200),
        type: clampStr(body.type, 40)
      });
      res.json({ ok: true, status: 'received' });
      return;
    }

    const type = clampStr(body.type, 20);
    if (type !== 'compliment' && type !== 'complaint') {
      res.status(400).json({ ok: false, error: 'type must be "compliment" or "complaint"' });
      return;
    }

    // URL-param identifiers (passed through from the email links).
    const dcrId      = clampStr(body.dcrId,      120);
    const customerId = clampStr(body.customerId, 120);
    const techId     = clampStr(body.techId,     120);

    // Resolve linked docs best-effort. Missing docs do NOT block the
    // submission — the customer's input is more valuable than perfect
    // joins. The linked flag records what we managed to resolve.
    const dcrDoc = await resolveDcr(db, dcrId, logger);
    const customerDoc = await resolveCustomer(
      db, customerId, dcrDoc && dcrDoc.customer_slug, logger
    );
    const techDoc = await resolveTech(
      db, techId, dcrDoc && dcrDoc.tech_slug, logger
    );

    const resolvedCustomerSlug = (customerDoc && (customerDoc.customer_slug || customerDoc.id)) ||
                                  (dcrDoc && dcrDoc.customer_slug) || null;
    const resolvedCustomerName = (customerDoc && (customerDoc.customer_name || customerDoc.name)) ||
                                  (dcrDoc && (dcrDoc.customer_name || dcrDoc.customerName)) || null;
    const resolvedTechSlug = (techDoc && (techDoc.tech_slug || techDoc.id)) ||
                              (dcrDoc && dcrDoc.tech_slug) || null;
    const resolvedTechDisplayName = (techDoc && (techDoc.display_name || techDoc.displayName || techDoc.name)) ||
                                     (dcrDoc && (dcrDoc.tech_display_name || dcrDoc.techDisplayName)) || null;

    const serverTs = admin.firestore.FieldValue.serverTimestamp();
    const ipHash = hashIp(
      String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()
    );
    const userAgent = clampStr(req.headers['user-agent'], 200);

    try {
      let feedbackId = null;
      let complaintId = null;
      let qualityWinId = null;

      if (type === 'compliment') {
        // ---- Compliment branch ----
        let rating = parseInt(body.rating, 10);
        if (!Number.isFinite(rating)) rating = 5;
        if (rating < 1) rating = 1;
        if (rating > 5) rating = 5;

        const complimentText = clampStr(body.complimentText, MAX_TEXT);
        const customerNameInput = clampStr(body.customerName, MAX_NAME);
        const shareConsent = body.shareConsent === true || body.shareConsent === 'true';

        // Feedback record.
        const feedbackRef = db.collection('customer_feedback').doc();
        feedbackId = feedbackRef.id;
        const feedbackDoc = {
          type:            'compliment',
          dcrId:           dcrId || null,
          customerId:      customerId || null,
          customerSlug:    resolvedCustomerSlug,
          customerName:    resolvedCustomerName,
          customerNameInput: customerNameInput || null,
          techId:          techId || null,
          techSlug:        resolvedTechSlug,
          techDisplayName: resolvedTechDisplayName,
          rating:          rating,
          complimentText:  complimentText || null,
          shareConsent:    shareConsent,
          linked:          !!(dcrDoc || customerDoc || techDoc),
          source:          'feedback-compliment-page',
          ipHash:          ipHash,
          userAgent:       userAgent,
          createdAt:       serverTs
        };

        // Quality win — only when rating >= 4. Compatible with the
        // existing quality_wins shape by carrying an empty inspection_id
        // and a clear source flag so existing Team Hub renderers can
        // branch on source if they choose.
        if (rating >= 4) {
          const qwRef = db.collection('quality_wins').doc();
          qualityWinId = qwRef.id;
          await qwRef.set({
            inspection_id:               "",
            source:                      "customer_compliment",
            customer_slug:               resolvedCustomerSlug || "",
            customer_display_name:       resolvedCustomerName || "",
            credited_tech_slug:          resolvedTechSlug || "",
            credited_tech_display_name:  resolvedTechDisplayName || "",
            overall_score:               rating,
            compliment_text:             complimentText || "",
            share_consent:               shareConsent,
            feedback_id:                 feedbackId,
            dcr_id:                      dcrId || "",
            created_at:                  serverTs
          });
          feedbackDoc.qualityWinRefId = qualityWinId;
        }

        await feedbackRef.set(feedbackDoc);

        // Notification — Team Hub celebration.
        await db.collection('notifications').add(
          buildComplimentNotification({
            feedbackId:      feedbackId,
            qualityWinId:    qualityWinId,
            customerId:      resolvedCustomerSlug || customerId || null,
            customerName:    resolvedCustomerName,
            techId:          resolvedTechSlug || techId || null,
            techDisplayName: resolvedTechDisplayName,
            rating:          rating,
            serverTimestamp: serverTs
          })
        );

        // Optional email celebration. Send to Kirby + April when set;
        // silently skip when secrets aren't configured (compliments
        // shouldn't depend on email being wired up).
        const sendTo = [];
        try { if (KIRBY_ALERT_EMAIL && KIRBY_ALERT_EMAIL.value()) sendTo.push(KIRBY_ALERT_EMAIL.value()); } catch (_e) {}
        try { if (APRIL_ALERT_EMAIL && APRIL_ALERT_EMAIL.value()) sendTo.push(APRIL_ALERT_EMAIL.value()); } catch (_e) {}
        if (sendTo.length) {
          try {
            const subject = '[Pioneer Win] Customer compliment for ' +
              (resolvedTechDisplayName || 'the Pioneer team');
            const html = renderComplimentAlertHtml({
              techDisplayName: resolvedTechDisplayName,
              customerName:    resolvedCustomerName,
              dcrId:           dcrId,
              rating:          rating,
              complimentText:  complimentText,
              shareConsent:    shareConsent,
              contactName:     customerNameInput,
              feedbackId:      feedbackId
            });
            await sendGmailMessage({
              to:                sendTo.join(', '),
              subject:           subject,
              html:              html,
              senderEmail:       GMAIL_SENDER_EMAIL.value(),
              serviceAccountKey: GMAIL_SERVICE_ACCOUNT_KEY.value()
            });
          } catch (e) {
            logger.warn('[feedback] compliment email failed (non-fatal)', { error: e.message });
          }
        }

        logger.info('[feedback] compliment recorded', {
          feedbackId, qualityWinId, rating, customer: resolvedCustomerSlug, tech: resolvedTechSlug
        });
        res.json({ ok: true, feedbackId: feedbackId, qualityWinId: qualityWinId });
        return;
      }

      // ---- Complaint branch ----
      const category = clampStr(body.category, 40);
      const urgency  = clampStr(body.urgency,  40);
      const details  = clampStr(body.details,  MAX_TEXT);

      if (!VALID_CATEGORIES.has(category)) {
        res.status(400).json({ ok: false, error: 'invalid category' });
        return;
      }
      if (!VALID_URGENCY.has(urgency)) {
        res.status(400).json({ ok: false, error: 'invalid urgency' });
        return;
      }
      if (details.length < 5) {
        res.status(400).json({ ok: false, error: 'details too short (min 5 chars)' });
        return;
      }
      const severity = severityFromUrgency(urgency);

      const contactName  = clampStr(body.contactName,  MAX_NAME);
      const contactPhone = clampStr(body.contactPhone, MAX_PHONE);
      const contactEmail = clampStr(body.contactEmail, MAX_NAME);
      if (contactEmail && !isEmailShaped(contactEmail)) {
        res.status(400).json({ ok: false, error: 'contactEmail is not a valid email' });
        return;
      }

      // Create the complaint doc first so we have its id for the
      // photo-storage paths and the notification linkage.
      const complaintRef = db.collection('customer_complaints').doc();
      complaintId = complaintRef.id;

      // Upload photos via Admin SDK (bypasses Storage rules). Failures
      // are logged but do not abort the submission — the customer's
      // text is the most important part.
      let photoUploads = [];
      try {
        const bucket = admin.storage().bucket(STORAGE_BUCKET);
        photoUploads = await uploadComplaintPhotos(bucket, complaintId, body.photos, logger);
      } catch (e) {
        logger.warn('[feedback] photo upload pass errored', { error: e.message });
      }

      // Complaint doc.
      await complaintRef.set({
        dcrId:               dcrId || null,
        customerId:          customerId || null,
        customerSlug:        resolvedCustomerSlug,
        customerName:        resolvedCustomerName,
        techId:              techId || null,
        techSlug:            resolvedTechSlug,
        techDisplayName:     resolvedTechDisplayName,
        category:            category,
        details:             details,
        urgency:             urgency,
        status:              "new",
        severity:            severity,
        assignedTo:          "office",
        notifyKirby:         true,
        notifyApril:         true,
        contactName:         contactName || null,
        contactEmail:        contactEmail || null,
        contactPhone:        contactPhone || null,
        photoUrls:           photoUploads.map(function (p) { return p.url; }),
        photoStoragePaths:   photoUploads.map(function (p) { return p.storagePath; }),
        createdAt:           serverTs,
        acknowledgedAt:      null,
        resolvedAt:          null,
        resolutionNotes:     null,
        customerFollowUpNeeded: true,
        ipHash:              ipHash,
        userAgent:           userAgent
      });

      // Mirror to customer_feedback (universal record).
      const feedbackRef = db.collection('customer_feedback').doc();
      feedbackId = feedbackRef.id;
      await feedbackRef.set({
        type:            'complaint',
        dcrId:           dcrId || null,
        customerId:      customerId || null,
        customerSlug:    resolvedCustomerSlug,
        customerName:    resolvedCustomerName,
        techId:          techId || null,
        techSlug:        resolvedTechSlug,
        techDisplayName: resolvedTechDisplayName,
        category:        category,
        urgency:         urgency,
        severity:        severity,
        details:         details,
        contactName:     contactName || null,
        contactEmail:    contactEmail || null,
        contactPhone:    contactPhone || null,
        photoCount:      photoUploads.length,
        complaintRefId:  complaintId,
        linked:          !!(dcrDoc || customerDoc || techDoc),
        source:          'feedback-issue-page',
        ipHash:          ipHash,
        userAgent:       userAgent,
        createdAt:       serverTs
      });

      // Notification — high priority for office manager + manager.
      await db.collection('notifications').add(
        buildComplaintNotification({
          complaintId:  complaintId,
          feedbackId:   feedbackId,
          customerId:   resolvedCustomerSlug || customerId || null,
          customerName: resolvedCustomerName,
          techId:       resolvedTechSlug || techId || null,
          severity:     severity,
          urgency:      urgency,
          category:     category,
          serverTimestamp: serverTs
        })
      );

      // Email alert. Sent only when the secrets resolve to real addresses.
      const sendTo = [];
      try { if (KIRBY_ALERT_EMAIL && KIRBY_ALERT_EMAIL.value()) sendTo.push(KIRBY_ALERT_EMAIL.value()); } catch (_e) {}
      try { if (APRIL_ALERT_EMAIL && APRIL_ALERT_EMAIL.value()) sendTo.push(APRIL_ALERT_EMAIL.value()); } catch (_e) {}
      if (sendTo.length) {
        try {
          const subject = '[Pioneer Alert] Customer concern submitted — ' +
            (resolvedCustomerName || 'unknown location');
          const html = renderComplaintAlertHtml({
            customerName:    resolvedCustomerName,
            techDisplayName: resolvedTechDisplayName,
            dcrId:           dcrId,
            category:        category,
            urgency:         urgency,
            severity:        severity,
            details:         details,
            contactName:     contactName,
            contactEmail:    contactEmail,
            contactPhone:    contactPhone,
            photoUploads:    photoUploads,
            complaintId:     complaintId,
            feedbackId:      feedbackId
          });
          await sendGmailMessage({
            to:                sendTo.join(', '),
            subject:           subject,
            html:              html,
            senderEmail:       GMAIL_SENDER_EMAIL.value(),
            serviceAccountKey: GMAIL_SERVICE_ACCOUNT_KEY.value()
          });
        } catch (e) {
          // Non-fatal — record exists in Firestore even if Gmail fails.
          logger.error('[feedback] complaint email send failed', { error: e.message });
        }
      } else {
        logger.warn('[feedback] no alert recipients configured (set KIRBY_ALERT_EMAIL / APRIL_ALERT_EMAIL secrets)');
      }

      logger.info('[feedback] complaint recorded', {
        complaintId, feedbackId, category, urgency, severity,
        customer: resolvedCustomerSlug, tech: resolvedTechSlug
      });
      res.json({ ok: true, feedbackId: feedbackId, complaintId: complaintId });

    } catch (err) {
      const msg = String(err && err.message || err);
      logger.error('[feedback] handler error', { error: msg, stack: err && err.stack });
      res.status(500).json({ ok: false, error: msg });
    }
  };
}

module.exports = {
  buildHttpHandler:    buildHttpHandler,
  CATEGORY_LABELS:     CATEGORY_LABELS,
  URGENCY_LABELS:      URGENCY_LABELS,
  // Exposed for unit-test / future reuse.
  decodeBase64Image:   decodeBase64Image,
  buildFirebaseTokenUrl: buildFirebaseTokenUrl,
  sendGmailMessage:    sendGmailMessage
};
