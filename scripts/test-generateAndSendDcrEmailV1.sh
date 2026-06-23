#!/usr/bin/env bash
# ============================================================================
# test-generateAndSendDcrEmailV1.sh
#
# Smoke-test the native DCR email pipeline against a single test DCR.
#
# Required env:
#   DCR_ID                       — Firestore dcr_submissions doc id
#   CUSTOMER_ID                  — Firestore customers doc id (slug)
#   ADMIN_ID_TOKEN               — Firebase Auth ID token of an
#                                  allowlisted admin
#
# Optional env:
#   TEST_RECIPIENT               — Override recipient email. When set,
#                                  the function routes the send to this
#                                  address INSTEAD of the customer's
#                                  email, prefixes the subject with
#                                  [TEST], and tags the payload doc
#                                  as a test send.
#   FUNCTION_URL                 — Override the deployed function URL
#                                  (e.g. for a staging deploy).
#
# How to get an admin ID token: sign into https://pioneer-dcr-hub.web.app/admin.html
# and in DevTools console run:
#   const t = await firebase.auth().currentUser.getIdToken();
#   console.log(t)
#
# Then:
#   export ADMIN_ID_TOKEN="paste-here"
#   export DCR_ID="paste-here"
#   export CUSTOMER_ID="paste-here"
#   export TEST_RECIPIENT="nick@pioneercomclean.com"   # recommended for first run
#   ./scripts/test-generateAndSendDcrEmailV1.sh
#
# JSON construction:
#   Uses `jq` when available (safe encoding of any user-supplied input).
#   Falls back to a Bash heredoc for portability. Either path avoids
#   the fragile inline-escape problem that broke the previous version.
# ============================================================================

set -euo pipefail

FUNCTION_URL="${FUNCTION_URL:-https://us-central1-pioneer-dcr-hub.cloudfunctions.net/generateAndSendDcrEmailV1}"

: "${DCR_ID:?Set DCR_ID to a dcr_submissions document id}"
: "${CUSTOMER_ID:?Set CUSTOMER_ID to a customers document id}"
# Note: no apostrophes inside the :? message — bash parses them as
# unmatched single-quote markers even when the whole construct is
# inside double quotes. Cost us 20 minutes once.
: "${ADMIN_ID_TOKEN:?Set ADMIN_ID_TOKEN to the Firebase ID token of an allowlisted admin}"

TEST_RECIPIENT="${TEST_RECIPIENT:-}"

# Build the JSON body safely. Two paths:
#   (a) jq -n when available — handles every special character.
#   (b) Bash heredoc — readable + no inline escaping. Values flow
#       through unmodified. No fragile printf-with-escapes here.
build_body() {
  if command -v jq >/dev/null 2>&1; then
    if [ -n "$TEST_RECIPIENT" ]; then
      jq -nc \
        --arg dcrId "$DCR_ID" \
        --arg customerId "$CUSTOMER_ID" \
        --arg testRecipientEmail "$TEST_RECIPIENT" \
        '{dcrId: $dcrId, customerId: $customerId, testRecipientEmail: $testRecipientEmail}'
    else
      jq -nc \
        --arg dcrId "$DCR_ID" \
        --arg customerId "$CUSTOMER_ID" \
        '{dcrId: $dcrId, customerId: $customerId}'
    fi
    return
  fi

  # No jq → heredoc fallback. Newlines inside the heredoc are fine
  # in JSON; curl reads it verbatim. Values flow through unmodified
  # (no inline escaping), which is the whole point of switching off
  # the old single-line printf approach that broke on special chars.
  if [ -n "$TEST_RECIPIENT" ]; then
    cat <<EOF
{
  "dcrId": "$DCR_ID",
  "customerId": "$CUSTOMER_ID",
  "testRecipientEmail": "$TEST_RECIPIENT"
}
EOF
  else
    cat <<EOF
{
  "dcrId": "$DCR_ID",
  "customerId": "$CUSTOMER_ID"
}
EOF
  fi
}

BODY="$(build_body)"

echo "→ POST $FUNCTION_URL"
echo "→ Body:"
echo "$BODY"
echo ""

# Capture body + HTTP code separately so we can differentiate:
#   • function ran fine             → 2xx, print body
#   • token expired / not admin     → 401/403, print refresh hint, exit 0
#                                     (the function is healthy; the operator
#                                      just needs to refresh their token)
#   • real function failure         → 4xx/5xx, print body, exit non-zero
#
# Writing the body to a tmp file lets curl emit the HTTP code to stdout
# without commingling streams; then we cat the file once we've decided
# how to interpret the status.
TMP_BODY="$(mktemp -t dcr-email-test-body)"
trap 'rm -f "$TMP_BODY"' EXIT

HTTP_CODE="$(
  curl --silent --show-error \
    --max-time 70 \
    -o "$TMP_BODY" \
    -w "%{http_code}" \
    -X POST "$FUNCTION_URL" \
    -H "Authorization: Bearer $ADMIN_ID_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary "$BODY"
)"

echo "HTTP $HTTP_CODE"
echo ""
echo "Response body:"
cat "$TMP_BODY"
echo ""

case "$HTTP_CODE" in
  2*)
    # Success — the function ran cleanly.
    exit 0
    ;;
  401|403)
    # Auth failure — almost always an expired Firebase ID token.
    # We deliberately do NOT exit non-zero here because the function
    # itself is healthy; the operator just needs a fresh token.
    cat <<'TOKEN_HINT' >&2

────────────────────────────────────────────────────────────────────
Admin token expired or missing.

This is NOT a function failure. The Firebase ID token in
ADMIN_ID_TOKEN has expired (tokens live ~1 hour) or your account
isn't on the admin allowlist.

To refresh:
  1. Open https://pioneer-dcr-hub.web.app/admin.html in your browser.
  2. Make sure you are signed in as an allowlisted admin.
  3. Open DevTools → Console and run:

       (await firebase.auth().currentUser.getIdToken(true))

     (The "true" forces a refresh.)
  4. Copy the token output, then in your shell:

       export ADMIN_ID_TOKEN="<paste>"

  5. Re-run this script. The function is fine; only the token
     needed refreshing.
────────────────────────────────────────────────────────────────────
TOKEN_HINT
    exit 0
    ;;
  *)
    # Anything else is a real function-side failure. Bubble up with
    # a non-zero exit so callers (CI, scripts) know to investigate.
    echo "Function returned HTTP $HTTP_CODE — see body above." >&2
    exit 1
    ;;
esac
