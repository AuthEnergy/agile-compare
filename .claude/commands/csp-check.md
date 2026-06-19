---
description: advisory grep for the CSP/XSS/secret rules that no CI gate enforces yet
allowed-tools: Bash(grep:*)
---

Run the four greps below and report any hits as **potential** violations of the repo's
non-negotiable rules (AGENTS.md → "THE constraint" + "Security"). This is advisory — it reports
for human review, it does not prove the tree is clean. Known-good exceptions: `src/ui/dom.ts`
(the only sanctioned `innerHTML`, for trusted inline SVG) and comment-only matches.

```bash
# 1) dynamic HTML injection (XSS) outside the sanctioned trusted-SVG site
grep -rnE "innerHTML|outerHTML|insertAdjacentHTML" --include='*.ts' app-v3/src | grep -v "src/ui/dom.ts"

# 2) inline event handlers (CSP says addEventListener only)
grep -rnE "setAttribute\(['\"]on|<[a-zA-Z][^>]* on[a-z]+=" --include='*.ts' app-v3/src

# 3) external resource refs in source (single-file CSP forbids them)
grep -rnE "(src|href)=[\"'](https?:)?//" --include='*.ts' app-v3/src

# 4) real-key secret shape (the placeholder is all x's; A-FAKE… fixtures are fine — do not flag)
grep -rnE "sk_live_[^x'\"]" --include='*.ts' app-v3/src app-v3/tests
```

For each hit: cite `file:line`, say which rule it touches, and whether it looks like a real
violation, a sanctioned exception, or a comment false-positive. If all four are empty, report
"clean".
