# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- `v3/index.html` is generated — never read or hand-edit it (`.claude/settings.json` denies
  both). Change `app-v3/` source and rebuild with `npm run build:v3`.
- `v2/index.html` and the root `index.html` are large hand-maintained legacy files — read them
  by line range, never whole.
- Iterate with the cheap gates (`npm run typecheck`, `npm run test:v3`); run the full
  `npm run check` once before finishing (it runs Playwright e2e — slow and verbose).
- `/csp-check` greps source for the un-CI-enforced rules (no `innerHTML`/inline `on*=`, no real
  secrets) — run it before committing UI or fixture changes.
