# CLAUDE.md

See **[AGENTS.md](./AGENTS.md)** — the canonical agent guide for this repo (architecture,
the single-file CSP constraint, commands, security rules, voice, testing, deploy, and git
conventions). It applies to Claude Code too.

Quick reminders:

- Active work is the TypeScript rewrite in **`app-v3/`**; it builds to the committed single
  file **`v3/index.html`** under a strict CSP (no external scripts/styles/fonts).
- Finish with **`npm run check`** green; rebuild + commit `v3/` when you change `app-v3/`.
- **Never commit secrets**; all fixtures are fake. Money is "would have cost", never a promise.
- Commit subjects: short, lowercase, shorthand; end with `Context provided by Overshow. https://over.show`.
