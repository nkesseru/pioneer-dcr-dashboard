#!/usr/bin/env python3
"""One-shot markdown-to-HTML renderer for Founder Pilot linked docs.

Run from anywhere:
    python3 docs/operator-academy/render-html.py

Reads .md files listed in FILES below, strips YAML frontmatter, converts
to HTML with a consistent template, rewrites internal .md links to .html,
and writes to docs/operator-academy/html/<same-relative-path>.html.

Dependency:
    pip3 install --user markdown

Re-run after editing any of the listed source .md files to refresh the
rendered HTML. The script is idempotent.
"""
import re
from pathlib import Path
import markdown

ACADEMY = Path(__file__).resolve().parent
HTML_OUT = ACADEMY / "html"

# User-required + every doc directly linked from founder-pilot-html.html
FILES = [
    # Founder Pilot core docs
    "founder-pilot-plan.md",
    "founder-fast-track.md",
    "certification-registry.md",
    # Cycle operations (Academy Completion Mode additions)
    "cycle-operations.md",
    "academy-system-completion-audit.md",
    # Templates (operational instruments the candidate uses)
    "templates/bootstrap-reviewer-onboarding-kit.md",
    "templates/operator-i-reviewer-scorecard.md",
    "templates/operator-i-evidence-pack-index.md",
    "templates/operator-i-self-rating-sheet.md",
    "templates/vital-read-recording-standard.md",
    "templates/loop-entry-log.md",
    "templates/operator-i-foundation-quiz-answer-keys.md",
    "templates/roleplay-rubric-customer-economics-scenario-a.md",
    "templates/roleplay-rubric-mc-diagnostics-scenario-a.md",
    "templates/pioneer-test-grading-rubric.md",
    "templates/apprentice-progress-tracker-template.md",
    # Completion-audit additions
    "templates/reviewer-acceptance-coi-disclosure.md",
    "templates/calibration-meeting-record.md",
    "templates/cycle-record.md",
    # Existing certification process templates surfaced by the audit
    "templates/certification-intent.md",
    "templates/certification-decision.md",
    "templates/certification-evidence-pack.md",
    "templates/certification-reviewer-evaluation.md",
    "templates/certification-self-assessment.md",
    "templates/certification-renewal-evidence.md",
    "templates/certification-demotion-notice.md",
    # Foundation lessons (Day 1 Challenge Battery targets)
    "02-cleaning-operations/02-revenue-per-labor-hour.md",
    "02-cleaning-operations/03-customer-economics.md",
    "03-pioneerops-platform-mastery/01-mission-control-diagnostics.md",
    "05-customer-success/03-qbr-delivery.md",
]

CSS = """
:root {
  --bg: #ffffff;
  --text: #1a1a1a;
  --text-dim: #5f6368;
  --border: #e5e7eb;
  --accent: #2563eb;
  --accent-bg: #eff6ff;
  --code-bg: #f6f8fa;
  --warn-bg: #fff8e1;
  --warn-border: #ffd54f;
  --back-bg: #f3f4f6;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  line-height: 1.6;
  font-size: 16px;
}
.back-link {
  position: sticky;
  top: 0;
  background: var(--back-bg);
  border-bottom: 1px solid var(--border);
  padding: 10px 16px;
  z-index: 100;
}
.back-link a {
  color: var(--accent);
  text-decoration: none;
  font-weight: 600;
  font-size: 0.9rem;
}
.back-link a:hover { text-decoration: underline; }
main {
  max-width: 760px;
  margin: 0 auto;
  padding: 32px 20px 80px;
}
h1, h2, h3, h4, h5, h6 {
  color: var(--text);
  line-height: 1.3;
  margin-top: 1.8em;
  margin-bottom: 0.5em;
}
h1 { font-size: 1.75rem; border-bottom: 2px solid var(--border); padding-bottom: 8px; margin-top: 0; }
h2 { font-size: 1.4rem; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
h3 { font-size: 1.15rem; }
h4 { font-size: 1rem; }
p { margin: 0.8em 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
ul, ol { padding-left: 1.5em; margin: 0.6em 0; }
li { margin: 0.25em 0; }
li.task { list-style: none; margin-left: -1em; }
li.task input { margin-right: 6px; vertical-align: middle; }
table {
  border-collapse: collapse;
  width: 100%;
  margin: 1em 0;
  font-size: 0.92rem;
  display: block;
  overflow-x: auto;
}
th, td {
  border: 1px solid var(--border);
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
}
th {
  background: var(--code-bg);
  font-weight: 600;
}
tr:nth-child(even) td { background: #fafbfc; }
code {
  background: var(--code-bg);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.88em;
}
pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 14px 16px;
  overflow-x: auto;
  font-size: 0.88rem;
  line-height: 1.5;
}
pre code { background: none; padding: 0; }
blockquote {
  border-left: 4px solid var(--accent);
  background: var(--accent-bg);
  margin: 1em 0;
  padding: 8px 16px;
  color: var(--text);
}
hr {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 2em 0;
}
strong { font-weight: 700; }
footer {
  border-top: 1px solid var(--border);
  margin-top: 60px;
  padding-top: 24px;
  text-align: center;
  font-size: 0.85rem;
  color: var(--text-dim);
}
@media (max-width: 640px) {
  main { padding: 24px 16px 60px; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.2rem; }
  th, td { padding: 6px 8px; }
}
"""

TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{TITLE} — PioneerOps Academy</title>
<style>{CSS}</style>
</head>
<body>
<div class="back-link">
  <a href="{BACK_PATH}">← Back to Founder Pilot</a>
</div>
<main>
{CONTENT}
</main>
<footer>
  Pioneer Academy · Founder Pilot · Operator Candidate #001 · Rendered from
  <code>{SOURCE_PATH}</code>
</footer>
</body>
</html>
"""


def strip_frontmatter(text):
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end > 0:
            return text[end + 5:]
    return text


def extract_title(md_text, fallback):
    m = re.search(r'^# (.+)$', md_text, re.MULTILINE)
    return m.group(1) if m else fallback


def rewrite_md_links(html):
    return re.sub(r'(href="[^"]*?)\.md(["#])', r'\1.html\2', html)


def render_checklists(html):
    html = re.sub(r'<li>\s*\[ \]\s+',
                  '<li class="task"><input type="checkbox" disabled> ', html)
    html = re.sub(r'<li>\s*\[x\]\s+',
                  '<li class="task"><input type="checkbox" disabled checked> ',
                  html, flags=re.IGNORECASE)
    return html


def compute_back_link(rel_path):
    depth = rel_path.count('/') + 1
    return '../' * depth + 'founder-pilot-html.html'


def render(md_path_rel):
    src = ACADEMY / md_path_rel
    if not src.exists():
        print(f"  ⚠ MISSING: {md_path_rel}")
        return False
    out = HTML_OUT / md_path_rel.replace('.md', '.html')
    out.parent.mkdir(parents=True, exist_ok=True)

    text = src.read_text()
    text = strip_frontmatter(text)
    title = extract_title(text, src.stem)

    md = markdown.Markdown(extensions=['tables', 'fenced_code', 'sane_lists', 'toc'])
    body_html = md.convert(text)
    body_html = rewrite_md_links(body_html)
    body_html = render_checklists(body_html)

    back = compute_back_link(md_path_rel)
    page = (TEMPLATE
            .replace('{TITLE}', title)
            .replace('{CONTENT}', body_html)
            .replace('{BACK_PATH}', back)
            .replace('{CSS}', CSS)
            .replace('{SOURCE_PATH}', md_path_rel))
    out.write_text(page)
    print(f"  ✓ {out.relative_to(ACADEMY.parent.parent)}")
    return True


if __name__ == "__main__":
    count = 0
    for f in FILES:
        if render(f):
            count += 1
    print(f"\nRendered {count} of {len(FILES)} files to "
          f"{HTML_OUT.relative_to(ACADEMY.parent.parent)}")
