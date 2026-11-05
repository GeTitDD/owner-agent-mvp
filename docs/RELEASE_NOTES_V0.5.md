# v0.5 local acceptance report

Date: 2026-11-05

- Node.js: v22.16.0
- `npm run check`: PASS — syntax checks across legacy and new Owner modules.
- `npm test`: PASS — 62/62 Node automated tests (49 inherited + 13 new).
- `npm run demo:owner`: PASS — temporary two-project registry, event projection, knowledge proposal and explicit approval with pinned knowledge revision.
- Workbench HTTP smoke: PASS — `/api/health` returned 0.5.0, `/api/owner/summary` returned registered project, `/companion.html` and `/app.js` returned HTTP 200.
- Pi SDK integration: simulated hooks (trusted/untrusted, metadata-only); real model/real Pi binary NOT tested.
- Electron native shell: source/syntax verified; GUI/tray NOT tested in this container; installation is optional.
- Browser screenshot: could not be produced by headless Chromium in this environment, so no claim of visual acceptance is made.

Security review scope: local-only host and origin controls, no prompts/tool outputs in Pi Owner event records, project canonical-root registration gate, replay-safe event IDs, human review before knowledge links, optimistic knowledge revision check, no automatic code edits, no automatic LLM calls.

Known limitations: no durable task-queue dispatcher, no automatic code/experiment watchers, no startup-at-login installer, no auth on the local HTTP service, no real Agent execution coordination, approved cross-project knowledge is linked in Owner registry but not auto-injected into compiled Pi contexts.
