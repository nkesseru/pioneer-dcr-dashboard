/* ============================================================================
 * comm-threads.js — Phase 3A Communication Threads helper module
 *
 * Data architecture for all future Pioneer communication features. NOT
 * wired into any UI in Phase 3A — this file exists so future surfaces
 * (Communication Center, Team Hub messaging, callout conversations,
 * customer follow-ups, Twilio outbound, etc.) attach to a stable model.
 *
 * Surface: `window.CommThreads` (namespaced to avoid collision with the
 * many existing IIFE-style modules in /public).
 *
 * --------------------------------------------------------------------------
 * SCHEMA
 * --------------------------------------------------------------------------
 *
 * communication_threads/{threadId}
 *   category                enum CATEGORIES
 *   status                  enum STATUS
 *   subject                 string, 1..200
 *   source_type             string | null   — discriminator pointing back to
 *                                             the originating record type
 *                                             (e.g. "callout", "customer",
 *                                             "recognition"). Used for dedup
 *                                             via findOrCreateOpenThread.
 *   source_id               string | null   — the originating record id
 *                                             (slug, doc id, etc.)
 *   participants            array<{ type, id, name }>
 *                                           — identity-typed participants.
 *                                             Immutable post-create.
 *   participant_ids         array<string>   — flattened lowercased identifiers
 *                                             (emails / slugs) for fast
 *                                             array-contains queries.
 *   created_by              string (email)
 *   created_at              Timestamp
 *   updated_at              Timestamp
 *   closed_at               Timestamp | null
 *   closed_by               string  | null
 *   last_message_at         Timestamp | null  — denorm: latest message createdAt
 *   last_message_preview    string    | null  — denorm: trimmed body (~140 chars)
 *   last_message_direction  enum DIRECTIONS | null
 *   message_count           number            — denorm counter
 *
 * communication_messages/{messageId}
 *   thread_id               string (parent threadId)
 *   category                string            — denormalized from thread for
 *                                                category-scoped queries
 *                                                without a JOIN
 *   channel                 enum CHANNELS
 *   direction               enum DIRECTIONS
 *   status                  enum MESSAGE_STATUS
 *   sender_type             enum SENDER_TYPES
 *   sender_id               string (email)
 *   sender_name             string
 *   recipient_type          enum RECIPIENT_TYPES
 *   recipient_id            string            — empty string for 'team'
 *   recipient_name          string
 *   body                    string, 1..2000
 *   created_at              Timestamp
 *   deliver_after           Timestamp         — earliest visible; mirrors
 *                                                Phase 1C working-hours
 *                                                pattern for office_manager
 *   delivered_at            Timestamp | null
 *   read_at                 Timestamp | null
 *   sms_phone               string    | null  — populated for channel=sms
 *   sms_sid                 string    | null  — Twilio SID (server-only)
 *   sms_error               string    | null
 *
 * --------------------------------------------------------------------------
 * USAGE
 * --------------------------------------------------------------------------
 *
 *   // Create a thread + first message (typical pattern)
 *   const tid = await CommThreads.findOrCreateOpenThread({
 *     category:    CommThreads.CATEGORIES.LEADERSHIP,
 *     subject:     'Recognition for Worker A',
 *     source_type: 'recognition',
 *     source_id:   'unique-key',
 *     participants: [
 *       { type: 'executive', id: 'april@pioneercomclean.com', name: 'April' },
 *       { type: 'tech',      id: 'worker@example.com',        name: 'Worker A' }
 *     ]
 *   });
 *   await CommThreads.addMessage(tid, {
 *     channel:        CommThreads.CHANNELS.IN_APP,
 *     direction:      CommThreads.DIRECTIONS.OUTBOUND,
 *     sender_type:    'executive',
 *     sender_id:      'april@pioneercomclean.com',
 *     sender_name:    'April',
 *     recipient_type: 'employee',
 *     recipient_id:   'worker@example.com',
 *     recipient_name: 'Worker A',
 *     body:           'Thank you for covering the Saturday route.'
 *   });
 *
 * Future surfaces should reach for THESE helpers rather than reading and
 * writing the collections directly — denorm bookkeeping (message_count,
 * last_message_*) is centralized here.
 * ========================================================================== */

(function () {
  'use strict';

  /* ---------------- Enums (single source of truth) ---------------- */

  const CATEGORIES = Object.freeze({
    LEADERSHIP: 'leadership',
    SCHEDULING: 'scheduling',
    SUPPLIES:   'supplies',
    CALLOUT:    'callout',
    CUSTOMER:   'customer',
    GENERAL:    'general'
  });
  const CATEGORY_SET = new Set(Object.values(CATEGORIES));

  // Phase 3B.1 — five-state machine. The two terminal states (resolved,
  // closed) and three active states (open + the two waiting_on_*). 'open'
  // is kept for backward compat with threads created before the state
  // machine landed; new threads should not be created in 'open'.
  const STATUS = Object.freeze({
    OPEN:                  'open',
    WAITING_ON_EMPLOYEE:   'waiting_on_employee',
    WAITING_ON_MANAGEMENT: 'waiting_on_management',
    RESOLVED:              'resolved',
    CLOSED:                'closed'
  });
  const STATUS_SET = new Set(Object.values(STATUS));
  // Active = not terminal. Used by inbox queries on /manager + /ceo.
  const ACTIVE_STATUSES = Object.freeze([
    STATUS.OPEN, STATUS.WAITING_ON_EMPLOYEE, STATUS.WAITING_ON_MANAGEMENT
  ]);
  // Pretty labels for badge rendering.
  const STATUS_LABEL = Object.freeze({
    open:                  'Open',
    waiting_on_employee:   'Waiting on employee',
    waiting_on_management: 'Waiting on management',
    resolved:              'Resolved',
    closed:                'Closed'
  });

  // Phase 3B.2 — priority axis (orthogonal to category + status).
  const PRIORITIES = Object.freeze({
    FYI:             'fyi',
    ACTION_REQUIRED: 'action_required',
    URGENT:          'urgent'
  });
  const PRIORITY_SET = new Set(Object.values(PRIORITIES));
  const PRIORITY_LABEL = Object.freeze({
    fyi:             'FYI',
    action_required: 'Action Required',
    urgent:          'Urgent'
  });

  // Phase 3B.2 — message types. UI-side discriminator that maps to a
  // (category, priority) default via MESSAGE_TYPE_DEFAULTS. Stored on
  // the thread for future reporting ("we sent 12 recognitions this
  // month") without re-deriving from category alone.
  const MESSAGE_TYPES = Object.freeze({
    RECOGNITION:      'recognition',
    COACHING_SUPPORT: 'coaching_support',
    ANNOUNCEMENT:     'announcement',
    LOGISTICS:        'logistics',
    SUPPLY:           'supply',
    SCHEDULING:       'scheduling',
    CALLOUT:          'callout',
    CUSTOMER_ISSUE:   'customer_issue',
    GENERAL:          'general'
  });
  const MESSAGE_TYPE_SET = new Set(Object.values(MESSAGE_TYPES));
  const MESSAGE_TYPE_LABEL = Object.freeze({
    recognition:      'Recognition',
    coaching_support: 'Coaching / Support',
    announcement:     'Announcement',
    logistics:        'Logistics',
    supply:           'Supply',
    scheduling:       'Scheduling',
    callout:          'Call-out',
    customer_issue:   'Customer Issue',
    general:          'General'
  });
  // Default (category, priority) per message type. The /manager compose
  // modal applies this on Kind change; the admin can override either
  // dropdown before submit. Persisted alongside category + priority so
  // future reports can group by message type without re-deriving.
  const MESSAGE_TYPE_DEFAULTS = Object.freeze({
    recognition:      { category: 'leadership', priority: 'fyi' },
    coaching_support: { category: 'leadership', priority: 'action_required' },
    announcement:     { category: 'leadership', priority: 'fyi' },
    logistics:        { category: 'general',    priority: 'action_required' },
    supply:           { category: 'supplies',   priority: 'action_required' },
    scheduling:       { category: 'scheduling', priority: 'action_required' },
    callout:          { category: 'callout',    priority: 'urgent' },
    customer_issue:   { category: 'customer',   priority: 'action_required' },
    general:          { category: 'general',    priority: 'fyi' }
  });

  const CHANNELS = Object.freeze({
    IN_APP: 'in_app',
    SMS:    'sms'
  });
  const CHANNEL_SET = new Set(Object.values(CHANNELS));

  const DIRECTIONS = Object.freeze({
    OUTBOUND: 'outbound',
    INBOUND:  'inbound'
  });
  const DIRECTION_SET = new Set(Object.values(DIRECTIONS));

  const MESSAGE_STATUS = Object.freeze({
    QUEUED:    'queued',
    DELIVERED: 'delivered',
    FAILED:    'failed',
    DISMISSED: 'dismissed'
  });
  const MESSAGE_STATUS_SET = new Set(Object.values(MESSAGE_STATUS));

  const SENDER_TYPES   = Object.freeze(['executive', 'admin', 'tech', 'customer', 'system']);
  const RECIPIENT_TYPES = Object.freeze(['employee', 'team', 'office_manager', 'customer', 'admin']);

  /* ---------------- Internals ---------------- */

  function getDb(maybeDb) {
    if (maybeDb) return maybeDb;
    if (!window.firebase || typeof firebase.firestore !== 'function') {
      throw new Error('comm-threads: firebase.firestore() not available');
    }
    return firebase.firestore();
  }

  function nowSentinel() {
    return firebase.firestore.FieldValue.serverTimestamp();
  }

  function lc(s) { return String(s || '').toLowerCase().trim(); }

  function trimPreview(body) {
    const s = String(body || '').replace(/\s+/g, ' ').trim();
    if (s.length <= 140) return s;
    return s.slice(0, 137) + '…';
  }

  function ensureEnum(label, value, set) {
    if (!set.has(value)) {
      throw new Error('comm-threads: invalid ' + label + ' "' + value + '"');
    }
  }

  function ensureString(label, value, max) {
    if (typeof value !== 'string' || !value.length) {
      throw new Error('comm-threads: ' + label + ' is required');
    }
    if (max && value.length > max) {
      throw new Error('comm-threads: ' + label + ' too long (' + value.length + ' > ' + max + ')');
    }
  }

  function flattenParticipantIds(participants) {
    return (participants || [])
      .map(function (p) { return lc(p && p.id); })
      .filter(function (s) { return s.length > 0; });
  }

  function callerEmail() {
    const u = window.firebase && firebase.auth && firebase.auth().currentUser;
    return u && u.email ? lc(u.email) : '';
  }

  /* ---------------- Thread CRUD ---------------- */

  /**
   * Create a new thread. Returns the new doc id.
   *
   * Required: category, subject, participants (array of >=1 participant).
   * Optional: source_type, source_id, status (default 'open'), created_by
   *           (defaults to current Firebase Auth user's email).
   */
  async function createThread(opts, maybeDb) {
    const db = getDb(maybeDb);
    opts = opts || {};
    ensureEnum('category', opts.category, CATEGORY_SET);
    ensureString('subject', opts.subject, 200);
    if (!Array.isArray(opts.participants) || !opts.participants.length) {
      throw new Error('comm-threads: at least one participant is required');
    }
    // Phase 3B.1 — default initial status is waiting_on_employee
    // (management is the first sender; the recipient is now on the
    // hook to respond). Callers can override via opts.status.
    const status = opts.status || STATUS.WAITING_ON_EMPLOYEE;
    ensureEnum('status', status, STATUS_SET);
    // Phase 3B.2 — priority is required on the schema; default is
    // action_required (most messages need a response). message_type
    // is optional; when present it must match the enum, and it's used
    // for reporting + the compose-modal Kind defaults.
    const priority = opts.priority || PRIORITIES.ACTION_REQUIRED;
    ensureEnum('priority', priority, PRIORITY_SET);
    let messageType = null;
    if (opts.message_type != null) {
      ensureEnum('message_type', opts.message_type, MESSAGE_TYPE_SET);
      messageType = opts.message_type;
    }
    const createdBy = lc(opts.created_by || callerEmail());
    if (!createdBy) throw new Error('comm-threads: created_by is required');

    const participants = opts.participants.map(function (p) {
      return {
        type: String(p.type || ''),
        id:   String(p.id   || ''),
        name: String(p.name || '')
      };
    });
    const participant_ids = flattenParticipantIds(participants);

    const sts = nowSentinel();
    const doc = {
      category:               opts.category,
      status:                 status,
      priority:               priority,
      message_type:           messageType,
      subject:                opts.subject,
      source_type:            opts.source_type || null,
      source_id:              opts.source_id   || null,
      participants:           participants,
      participant_ids:        participant_ids,
      created_by:             createdBy,
      created_at:             sts,
      updated_at:             sts,
      closed_at:              null,
      closed_by:              null,
      last_message_at:        null,
      last_message_preview:   null,
      last_message_direction: null,
      message_count:          0
    };
    const ref = await db.collection('communication_threads').add(doc);
    return ref.id;
  }

  /**
   * Find an open thread by source triple (category + source_type + source_id),
   * or create one if none exists. Returns the thread id. The dedup is
   * client-side; concurrent calls can still race — by design, the audit
   * trail can carry two threads if it must. Use this for any feature
   * where re-triggering on the same source record should reuse one thread
   * (callouts, recognitions for the same employee within a window, etc.).
   *
   * If opts.source_type or opts.source_id is empty, this falls through to
   * createThread (no dedup possible).
   */
  async function findOrCreateOpenThread(opts, maybeDb) {
    const db = getDb(maybeDb);
    opts = opts || {};
    if (!opts.source_type || !opts.source_id) {
      return createThread(opts, db);
    }
    // Phase 3B.1 — match any non-terminal status (open + waiting_on_*).
    // Resolved + closed threads are NOT reused; a fresh trigger on the
    // same source starts a new thread.
    const existing = await db.collection('communication_threads')
      .where('source_type', '==', opts.source_type)
      .where('source_id',   '==', opts.source_id)
      .where('status',      'in', ACTIVE_STATUSES.slice())
      .limit(1).get();
    if (!existing.empty) {
      // Match category too — different feature reusing the same source id
      // shouldn't accidentally hijack an unrelated open thread.
      const found = existing.docs[0];
      if ((found.data() || {}).category === opts.category) {
        return found.id;
      }
    }
    return createThread(opts, db);
  }

  async function findThreadById(threadId, maybeDb) {
    const db = getDb(maybeDb);
    if (!threadId) return null;
    const doc = await db.collection('communication_threads').doc(threadId).get();
    if (!doc.exists) return null;
    return Object.assign({ _id: doc.id }, doc.data() || {});
  }

  /**
   * List threads where the given identifier is a participant. Sorted by
   * last_message_at desc. Pass status='open' (default) to scope to active
   * conversations, or null to include closed.
   */
  async function findThreadsByParticipant(identifier, opts, maybeDb) {
    const db = getDb(maybeDb);
    const id = lc(identifier);
    if (!id) return [];
    opts = opts || {};
    const limit  = opts.limit  || 50;
    const status = (typeof opts.status === 'undefined') ? STATUS.OPEN : opts.status;

    let q = db.collection('communication_threads')
      .where('participant_ids', 'array-contains', id);
    if (status) q = q.where('status', '==', status);
    q = q.orderBy('last_message_at', 'desc').limit(limit);

    const snap = await q.get();
    return snap.docs.map(function (d) {
      return Object.assign({ _id: d.id }, d.data() || {});
    });
  }

  async function closeThread(threadId, opts, maybeDb) {
    const db = getDb(maybeDb);
    opts = opts || {};
    const closedBy = lc(opts.closed_by || callerEmail());
    await db.collection('communication_threads').doc(threadId).update({
      status:     STATUS.CLOSED,
      closed_at:  nowSentinel(),
      closed_by:  closedBy,
      updated_at: nowSentinel()
    });
  }

  // Phase 3B.1 — Resolve is the "happy-path" terminal. Same audit
  // fields as close, different status so reports can tell the two
  // apart ("how many threads ended amicably?" vs. "how many got
  // killed off?").
  async function resolveThread(threadId, opts, maybeDb) {
    const db = getDb(maybeDb);
    opts = opts || {};
    const resolvedBy = lc(opts.resolved_by || callerEmail());
    await db.collection('communication_threads').doc(threadId).update({
      status:     STATUS.RESOLVED,
      closed_at:  nowSentinel(),
      closed_by:  resolvedBy,
      updated_at: nowSentinel()
    });
  }

  async function reopenThread(threadId, maybeDb) {
    const db = getDb(maybeDb);
    // Reopen lands on waiting_on_management — the natural "someone
    // needs to follow up" state after revival.
    await db.collection('communication_threads').doc(threadId).update({
      status:     STATUS.WAITING_ON_MANAGEMENT,
      closed_at:  null,
      closed_by:  null,
      updated_at: nowSentinel()
    });
  }

  /* ---------------- Message CRUD ---------------- */

  /**
   * Append a message to a thread. Runs as a batched write so the message
   * doc + thread denorm bump (last_message_*, message_count, updated_at)
   * land atomically. Returns the new message doc id.
   *
   * Required: channel, direction, sender_id, sender_name, sender_type,
   *           recipient_type, body. recipient_id is required for any
   *           direction!=team broadcast.
   *
   * Optional: deliver_after (Date or Timestamp) — defaults to serverTimestamp
   *           (deliver immediately). status defaults to 'queued'.
   *           sms_phone (channel=sms only).
   */
  async function addMessage(threadId, opts, maybeDb) {
    const db = getDb(maybeDb);
    if (!threadId) throw new Error('comm-threads: threadId is required');
    opts = opts || {};
    ensureEnum('channel',   opts.channel,   CHANNEL_SET);
    ensureEnum('direction', opts.direction, DIRECTION_SET);
    const status = opts.status || MESSAGE_STATUS.QUEUED;
    ensureEnum('status',    status,         MESSAGE_STATUS_SET);
    ensureString('body',    opts.body, 2000);
    ensureString('sender_id',      opts.sender_id);
    ensureString('sender_name',    opts.sender_name);
    if (SENDER_TYPES.indexOf(opts.sender_type) < 0) {
      throw new Error('comm-threads: invalid sender_type "' + opts.sender_type + '"');
    }
    if (RECIPIENT_TYPES.indexOf(opts.recipient_type) < 0) {
      throw new Error('comm-threads: invalid recipient_type "' + opts.recipient_type + '"');
    }
    const recipientId = (opts.recipient_type === 'team') ? '' : lc(opts.recipient_id || '');
    if (opts.recipient_type !== 'team' && !recipientId) {
      throw new Error('comm-threads: recipient_id required for non-team messages');
    }

    // Hydrate denorm category from the thread so message queries don't
    // need to join. If the thread is missing, the rules will reject
    // anyway — fail loud client-side first.
    const threadDoc = await db.collection('communication_threads').doc(threadId).get();
    if (!threadDoc.exists) {
      throw new Error('comm-threads: thread "' + threadId + '" not found');
    }
    const threadData = threadDoc.data() || {};

    let deliverAfter;
    if (opts.deliver_after instanceof Date) {
      deliverAfter = firebase.firestore.Timestamp.fromDate(opts.deliver_after);
    } else if (opts.deliver_after && typeof opts.deliver_after.toMillis === 'function') {
      deliverAfter = opts.deliver_after;
    } else {
      // Default: deliver immediately (use serverTimestamp via nowSentinel
      // would be cleaner, but mixing sentinels with batched writes is
      // fine — Firestore resolves them at commit).
      deliverAfter = nowSentinel();
    }

    const msgRef    = db.collection('communication_messages').doc();
    const threadRef = db.collection('communication_threads').doc(threadId);
    const sts       = nowSentinel();

    const messageDoc = {
      thread_id:      threadId,
      category:       threadData.category || null,
      channel:        opts.channel,
      direction:      opts.direction,
      status:         status,
      sender_type:    opts.sender_type,
      sender_id:      lc(opts.sender_id),
      sender_name:    opts.sender_name,
      recipient_type: opts.recipient_type,
      recipient_id:   recipientId,
      recipient_name: String(opts.recipient_name || ''),
      body:           opts.body,
      created_at:     sts,
      deliver_after:  deliverAfter,
      delivered_at:   null,
      read_at:        null,
      sms_phone:      (opts.channel === CHANNELS.SMS) ? String(opts.sms_phone || '') : null,
      sms_sid:        null,
      sms_error:      null
    };

    // Phase 3B.1 — auto-bump thread status based on direction:
    //   outbound (management→employee) → waiting_on_employee
    //   inbound  (employee→management) → waiting_on_management
    // If the thread is already in a terminal state (resolved/closed),
    // we DON'T flip it — that would resurrect a closed conversation.
    // The caller is responsible for reopening if that's their intent.
    const currentStatus = (threadData && threadData.status) || STATUS.OPEN;
    const isTerminal = (currentStatus === STATUS.RESOLVED || currentStatus === STATUS.CLOSED);
    const nextStatus = isTerminal
      ? currentStatus
      : (opts.direction === DIRECTIONS.OUTBOUND
          ? STATUS.WAITING_ON_EMPLOYEE
          : STATUS.WAITING_ON_MANAGEMENT);

    const threadPatch = {
      status:                 nextStatus,
      updated_at:             sts,
      last_message_at:        sts,
      last_message_preview:   trimPreview(opts.body),
      last_message_direction: opts.direction,
      message_count: firebase.firestore.FieldValue.increment(1)
    };

    const batch = db.batch();
    batch.set(msgRef, messageDoc);
    batch.update(threadRef, threadPatch);
    await batch.commit();
    return msgRef.id;
  }

  async function listMessagesForThread(threadId, opts, maybeDb) {
    const db = getDb(maybeDb);
    if (!threadId) return [];
    opts = opts || {};
    const limit = opts.limit || 200;
    const snap = await db.collection('communication_messages')
      .where('thread_id', '==', threadId)
      .orderBy('created_at', 'asc')
      .limit(limit).get();
    return snap.docs.map(function (d) {
      return Object.assign({ _id: d.id }, d.data() || {});
    });
  }

  async function markMessageDelivered(messageId, maybeDb) {
    const db = getDb(maybeDb);
    await db.collection('communication_messages').doc(messageId).update({
      status:       MESSAGE_STATUS.DELIVERED,
      delivered_at: nowSentinel(),
      updated_at:   nowSentinel()
    });
  }

  async function markMessageRead(messageId, maybeDb) {
    const db = getDb(maybeDb);
    await db.collection('communication_messages').doc(messageId).update({
      status:     MESSAGE_STATUS.DELIVERED, // delivered + read; we don't model "read but undelivered"
      read_at:    nowSentinel(),
      updated_at: nowSentinel()
    });
  }

  async function markMessageDismissed(messageId, maybeDb) {
    const db = getDb(maybeDb);
    await db.collection('communication_messages').doc(messageId).update({
      status:       MESSAGE_STATUS.DISMISSED,
      delivered_at: nowSentinel(),
      updated_at:   nowSentinel()
    });
  }

  async function markMessageFailed(messageId, errorMessage, maybeDb) {
    const db = getDb(maybeDb);
    await db.collection('communication_messages').doc(messageId).update({
      status:     MESSAGE_STATUS.FAILED,
      sms_error:  String(errorMessage || '').slice(0, 500),
      updated_at: nowSentinel()
    });
  }

  /* ---------------- Public API ---------------- */

  window.CommThreads = Object.freeze({
    CATEGORIES:               CATEGORIES,
    STATUS:                   STATUS,
    STATUS_LABEL:             STATUS_LABEL,
    ACTIVE_STATUSES:          ACTIVE_STATUSES,
    // Phase 3B.2 — priority + message type
    PRIORITIES:               PRIORITIES,
    PRIORITY_LABEL:           PRIORITY_LABEL,
    MESSAGE_TYPES:            MESSAGE_TYPES,
    MESSAGE_TYPE_LABEL:       MESSAGE_TYPE_LABEL,
    MESSAGE_TYPE_DEFAULTS:    MESSAGE_TYPE_DEFAULTS,
    CHANNELS:                 CHANNELS,
    DIRECTIONS:               DIRECTIONS,
    MESSAGE_STATUS:           MESSAGE_STATUS,
    SENDER_TYPES:             SENDER_TYPES,
    RECIPIENT_TYPES:          RECIPIENT_TYPES,

    createThread:             createThread,
    findOrCreateOpenThread:   findOrCreateOpenThread,
    findThreadById:           findThreadById,
    findThreadsByParticipant: findThreadsByParticipant,
    closeThread:              closeThread,
    resolveThread:            resolveThread,
    reopenThread:             reopenThread,

    addMessage:               addMessage,
    listMessagesForThread:    listMessagesForThread,
    markMessageDelivered:     markMessageDelivered,
    markMessageRead:          markMessageRead,
    markMessageDismissed:     markMessageDismissed,
    markMessageFailed:        markMessageFailed,

    // Re-exported helpers — useful for callers building doc shapes
    // before deciding whether to commit.
    trimPreview:              trimPreview
  });

})();
