/* Pioneer DCR Hub — diagnose a tech's login readiness.
 *
 * Walks through every check the live auth pipeline does so you can
 * answer "why can't <tech> log in?" without poking around the
 * Firebase console.
 *
 * Usage:
 *   node scripts/check-tech-auth.js makaila@example.com
 *   node scripts/check-tech-auth.js makaila-b               # by slug
 *
 * Reports:
 *   ✓ / ✗  cleaning_techs/<slug> exists + active
 *   ✓ / ✗  cleaning_techs.email matches the lookup email
 *   ✓ / ✗  Firebase Auth user exists for that email
 *   ✓ / ✗  Auth user not disabled
 *   ◦      Last sign-in time (if known)
 *   ◦      Sign-in providers configured for that user (password / google)
 *   ◦      Whether the role assigned matches a real PioneerOps tech
 */

const admin = require("firebase-admin");
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json")),
  });
}
const db = admin.firestore();

const ARG = process.argv[2] || "";
if (!ARG) {
  console.error("Usage: node scripts/check-tech-auth.js <email-or-slug>");
  process.exit(1);
}

function check(ok, label, detail) {
  const mark = ok ? "✓" : "✗";
  const line = "  " + mark + "  " + label + (detail != null ? " — " + detail : "");
  console.log(line);
}
function info(label, detail) {
  console.log("  ◦  " + label + (detail != null ? " — " + detail : ""));
}

async function main() {
  console.log("=== PioneerOps tech auth diagnostic ===\n");

  // 1. Resolve cleaning_techs doc — by slug first, then by email.
  let techSnap = null;
  let techSlug = "";
  if (ARG.indexOf("@") < 0) {
    techSlug = ARG;
    techSnap = await db.collection("cleaning_techs").doc(ARG).get();
  } else {
    const emailLc = ARG.toLowerCase().trim();
    // Try both `email` field shapes used historically.
    let q = await db.collection("cleaning_techs").where("email", "==", emailLc).limit(1).get();
    if (q.empty) q = await db.collection("cleaning_techs").where("email", "==", ARG.trim()).limit(1).get();
    if (!q.empty) {
      techSnap = q.docs[0];
      techSlug = techSnap.id;
    }
  }

  if (!techSnap || !techSnap.exists) {
    check(false, "cleaning_techs lookup", "no doc matched '" + ARG + "'");
    console.log("\nFix: create or repair the cleaning_techs entry, then re-run.");
    return;
  }
  const tech = techSnap.data() || {};
  check(true, "cleaning_techs/" + techSlug + " exists");
  check(tech.active !== false, "active flag", tech.active === false ? "ARCHIVED (active=false)" : "active");
  info("display_name", tech.display_name || "(missing)");
  info("email (stored)", tech.email || "(missing)");
  info("tech_slug", tech.tech_slug || techSlug);
  info("dcr_enabled", String(tech.dcr_enabled !== false));

  const techEmail = String(tech.email || "").trim().toLowerCase();
  if (!techEmail) {
    check(false, "tech email", "cleaning_techs.email is empty — set it to the same address the user uses in Deputy");
    return;
  }

  // 2. Email passed in matches the doc's email (case-insensitive).
  if (ARG.indexOf("@") >= 0) {
    const argLc = ARG.trim().toLowerCase();
    check(techEmail === argLc, "lookup email matches cleaning_techs.email",
      techEmail === argLc ? techEmail : ("doc has '" + techEmail + "', you passed '" + argLc + "'"));
  }

  // 3. Firebase Auth user exists for techEmail.
  let userRec = null;
  try {
    userRec = await admin.auth().getUserByEmail(techEmail);
    check(true, "Firebase Auth user exists", userRec.uid);
  } catch (err) {
    check(false, "Firebase Auth user", err && err.code === "auth/user-not-found"
      ? "NO USER — invite was never accepted, or email mismatch. Run admin → Send Invite, OR fix email and re-invite."
      : "lookup failed: " + (err && err.message));
    console.log("\nFix: open Admin → Cleaning Techs → " + (tech.display_name || techSlug) + " → Send Invite.");
    return;
  }

  // 4. Not disabled.
  check(!userRec.disabled, "Auth user enabled",
    userRec.disabled ? "DISABLED — re-enable in Firebase Auth console" : "active");

  // 5. Providers (Google? Password? Both?) — drives the "should they use Google?" advice.
  const providers = (userRec.providerData || []).map(function (p) { return p.providerId; });
  info("sign-in providers", providers.length ? providers.join(", ") : "(none — odd)");
  if (providers.indexOf("password") < 0 && providers.indexOf("google.com") < 0) {
    check(false, "supported provider configured", "neither password nor google — re-invite");
  } else {
    check(true, "supported provider configured",
      providers.indexOf("google.com") >= 0 ? "Google ready" : "Password only — recommend Google for easier login");
  }

  // 6. Last sign-in time.
  const lastSignIn = userRec.metadata && userRec.metadata.lastSignInTime;
  info("last sign-in", lastSignIn || "(never)");
  info("created", (userRec.metadata && userRec.metadata.creationTime) || "(unknown)");

  console.log("\n=== Recommendation ===\n");
  if (providers.indexOf("google.com") >= 0) {
    console.log("  → Tell the tech to open https://pioneer-dcr-hub.web.app/login");
    console.log("    and tap 'Sign in with Google'. Use the email above.");
  } else if (providers.indexOf("password") >= 0) {
    console.log("  → Two options for the tech:");
    console.log("    1. Easiest: open https://pioneer-dcr-hub.web.app/login");
    console.log("       and tap 'Sign in with Google' (creates the link to this");
    console.log("       account on first sign-in; no password needed).");
    console.log("    2. Or use email + password — if password forgotten, tap");
    console.log("       'Forgot password' on /login. After setting a new password");
    console.log("       Firebase will now return them to /login (fix shipped today).");
  }
}

main().catch(function (err) {
  console.error("Diagnostic failed:", err.message);
  process.exit(1);
});
