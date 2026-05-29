/* Pioneer DCR Hub — Pilot Readiness terminal check.
 *
 * Runs the same engine as the admin panel (`pilotReadinessCheckV1`) but
 * straight against the production database via the Admin SDK. No writes,
 * no test docs — pure read pipeline.
 *
 * Usage:
 *   node scripts/pilot-readiness-check.js
 *   node scripts/pilot-readiness-check.js --tech makaila-b      # one tech
 *   node scripts/pilot-readiness-check.js --limit 3             # first N
 *   node scripts/pilot-readiness-check.js --json                # raw JSON dump
 *
 * Exit code:
 *   0  — every active tech is PASS or WARN
 *   1  — at least one FAIL surfaced (CI-friendly)
 *
 * Requires serviceAccountKey.json at the repo root (gitignored).
 */

const admin = require("firebase-admin");
const path  = require("path");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(require("../serviceAccountKey.json"))
  });
}

const engine = require(path.join(__dirname, "..", "functions", "pilotReadinessEngine"));

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { techSlug: null, limit: 0, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--tech")    { out.techSlug = args[++i] || null; continue; }
    if (a === "--limit")   { out.limit    = Number(args[++i]) || 0; continue; }
    if (a === "--json")    { out.json     = true; continue; }
    if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/pilot-readiness-check.js [--tech <slug>] [--limit N] [--json]");
      process.exit(0);
    }
  }
  return out;
}

// ANSI colors — disabled when output is piped or NO_COLOR is set.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
function color(s, code) { return COLOR ? ("\x1b[" + code + "m" + s + "\x1b[0m") : s; }
function green(s)  { return color(s, "32"); }
function yellow(s) { return color(s, "33"); }
function red(s)    { return color(s, "31"); }
function bold(s)   { return color(s, "1");  }
function dim(s)    { return color(s, "2");  }

function badge(level) {
  if (level === "PASS") return green("PASS");
  if (level === "WARN") return yellow("WARN");
  return red("FAIL");
}

function printReport(report) {
  console.log(bold("\n=== Pioneer DCR Hub — Pilot Readiness ==="));
  console.log(dim("Generated " + report.generated_at));
  console.log(dim("Techs checked: " + report.summary.tech_count +
    "  ·  " + green("PASS " + report.summary.pass) +
    "  ·  " + yellow("WARN " + report.summary.warn) +
    "  ·  " + red("FAIL " + report.summary.fail)));

  report.techs.forEach(function (t) {
    console.log("\n" + badge(t.overall) + "  " + bold(t.display_name) +
      "  " + dim("· " + t.tech_slug + " · " + (t.email || "(no email)")));
    // Group checks by category for readability.
    const grouped = Object.create(null);
    t.checks.forEach(function (c) {
      if (!grouped[c.category]) grouped[c.category] = [];
      grouped[c.category].push(c);
    });
    Object.keys(grouped).forEach(function (cat) {
      console.log("  " + dim("[" + cat + "]"));
      grouped[cat].forEach(function (c) {
        console.log("    " + badge(c.level) + "  " + c.label);
        if (c.detail) {
          c.detail.split("\n").forEach(function (line) {
            console.log("        " + dim(line));
          });
        }
      });
    });
  });

  console.log("");
  if (report.summary.fail > 0) {
    console.log(red(bold("FAIL — " + report.summary.fail + " tech(s) have blockers. Fix them before pilot rollout.")));
  } else if (report.summary.warn > 0) {
    console.log(yellow(bold("WARN — " + report.summary.warn + " tech(s) have non-blocking issues. Review before rollout.")));
  } else {
    console.log(green(bold("PASS — all techs ready for pilot.")));
  }
  console.log("");
}

(async function main() {
  const opts = parseArgs();
  try {
    const report = await engine.runReadinessForTechs(admin, {
      techSlug: opts.techSlug,
      limit:    opts.limit
    });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }
    process.exit(report.summary.fail > 0 ? 1 : 0);
  } catch (err) {
    console.error(red("Readiness check crashed: ") + (err && err.message));
    if (err && err.stack) console.error(dim(err.stack));
    process.exit(2);
  }
})();
