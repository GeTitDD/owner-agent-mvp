# Owner Agent v0.5 — design & operations

## Product boundary

Owner is the durable principal. The owner-centred Resident Runtime owns a project registry, tasks, event log, verified knowledge links and attention policies. Project-specific Pi sessions own their execution; the existing domain knowledge compiler owns cross-domain contexts. No single long-running LLM session is an authoritative database.

## Current priority: maintain knowledge within each project (2026-11-09)

Owner is a **source of truth for Owner's recorded, adopted domain knowledge and project context**, not an authority on the latest external facts. A code change, test, document or Agent inference may support a candidate update, but does not imply Owner has learned or accepted it. Preserve the source, project scope, revision and the distinction between observed evidence, verified claims and Owner adoption.

The immediate work is deliberately concrete:

1. Inventory registered projects: domain(s), goals, environment/dependency versions, constraints and explicit unknowns; mark declarations versus observations.
2. Extract small, traceable knowledge candidates from code, documents, experiments, tests and completed runs. Keep automatic candidates unverified.
3. Use the existing Personal Knowledge Workbench for human review, corrections, version history and evidence. Store specific findings at L3 before cross-project generalization.
4. Reuse applicability checks, Resolver and Context Compiler; propose L2/L1 only with independent evidence and explicit review.
5. Re-check knowledge when environments, test evidence or project assumptions change; do not silently overwrite Owner's adopted version.

The project workflow and acceptance criteria are in [Project Knowledge Maintenance](PROJECT_KNOWLEDGE_MAINTENANCE.md). A universal cognitive-state schema, Project Journal, knowledge graph and new Agent infrastructure are intentionally deferred. The sections below describe the historical v0.5 baseline; automatic Knowledge Loop and Companion knowledge UI remain Draft PR #23/#24.

## Implemented

- Local SQLite owner registry, explicit project ID ↔ canonical existing project root (with status, goals and domains). No recursive project scanning without authorization.
- Task list and manual status; an `agent_settled` event **does not** mark the task done.
- Replay-safe, metadata-only Pi event capture (session ID, branch, tool name, failure flag and execution duration). Captures no prompt, arguments, outputs or source file contents. Must explicitly enable `OWNER_AGENT_CAPTURE=1` for a registered, trusted project.
- Event projection: active run count, tool errors, settlement. All raw events remain append-only.
- Knowledge transfer requires a *personally verified*, evidence-referenced domain knowledge unit; suggestion → explicit approve/reject → pinned knowledge link for target project. No automatic code changes, knowledge publication, task execution or project-context injection.
- OwnerAgent deterministic read-only answers with source IDs; an **explicitly invoked** optional Pi SDK `noTools: true` one-shot cognitive adapter.
- Resident monitor runs on a low-frequency local timer without any automatic LLM calls, dedupes new events/attention. Native notifications opt-in.
- Web owner view and a small corner companion in the same Workbench; an optional Electron always-on-top desktop companion, system tray and full Workbench window.
- Previous v0.4 Personal Knowledge Workbench, L1/L2/L3 and Pi context adapters preserved.

## Data isolation

All components must refer to the same SQLite file. Default `~/.domain-context/index.sqlite`. Override with `DOMAIN_CONTEXT_DB=/absolute/path/file.sqlite` across the old Workbench/Compiler and Pi extension. For a separate Owner database override, additionally set `OWNER_AGENT_DB` consistently for the desktop companion, ownerctl and Owner Pi Extension; when using the Workbench, its dbPath must match the Owner database. The simplest and safest setup is one `DOMAIN_CONTEXT_DB`.

The web server binds to `127.0.0.1` with local-only host validation, CSRF-type header and Origin checks. The server has **no user authentication**: use only on a private personal machine, and never expose through a proxy, tunnel or public binding.

## Start / stop

```bash
node -v                         # >= 22.13
npm test
npm run demo:owner               # temporary DB, no LLM
npm run workbench                # keep running for browser companion
# Browse http://127.0.0.1:4317
```

To run the **optional native companion**, first install Electron with your own network environment:

```bash
npm install --save-dev electron
npm run desktop
```

The Electron host starts a loopback Workbench on an ephemeral port and shows a tray pet. Closing the full Workbench window does not quit the service: use **Tray → 退出**. On some desktop environments, the system tray may not work or Electron dependencies may be missing. **The native GUI has not been launched or tested in the current environment**; JavaScript syntax and HTTP assets were tested.

For native notifications (only if desired): `OWNER_AGENT_NOTIFICATIONS=1 npm run desktop`. Notifications are triggered only for newly observed attention items (e.g. newly blocked task) and can be suppressed by not setting the variable.

## Register and monitor real projects

```bash
node bin/ownerctl.mjs register --id my-pi-project --name 'Pi project' --root /absolute/path/to/project --domain pi-sdk --goal 'Study Pi'
node bin/ownerctl.mjs projects
node bin/ownerctl.mjs task --project my-pi-project --title 'Verify Context API'
node bin/ownerctl.mjs attention
node bin/ownerctl.mjs ask '目前有哪些项目？'
```

Open the project root in Pi, and opt in explicitly:

```bash
OWNER_AGENT_CAPTURE=1 pi -e /absolute/path/to/owner-agent-mvp-v0.5/adapters/pi/owner-extension.mjs
```

`OWNER_AGENT_DB` (if used) and `DOMAIN_CONTEXT_DB` must be set for Pi, Workbench and ownerctl to the same exact DB. The project needs to be registered before running Pi. If Pi does not consider the project trusted, event capture is disabled. Events are not a proof of project success, and a session can have retried or aborted.

For full domain-context compilation, additionally load `adapters/pi/extension.mjs` and supply the project's `domain-context.json`; the owner event adapter is independent of this knowledge compiler.

## Knowledge transfer

Create/verify a domain-scoped L1/L2 Knowledge Unit in the Personal Knowledge Workbench. It must have evidence references and verificationStatus `verified`. Then:

```bash
node bin/ownerctl.mjs suggest --from project-a --to project-b --knowledge personal.xxxxx --why 'Potentially transferable experiment'
node bin/ownerctl.mjs suggestions --status pending
node bin/ownerctl.mjs review --id SUGGESTION_UUID --decision approved
```

Approval pins the specific knowledge revision to an Owner-side project-knowledge link and changes **no** project files, imported domain versions or active Pi context snapshots. The next phase can add a separate explicit `Apply` action after applicability verification.

## Real Agent vs. no-model mode

`ownerctl ask` and the embedded companion answer predefined read-only project-state and knowledge-suggestion queries using deterministic rules. It does **not** claim general reasoning capability. To invoke a real model once, explicitly call `ownerctl ask-pi QUESTION` after separately installing and configuring `@earendil-works/pi-coding-agent`. It builds a minimal in-memory, tool-disabled session from a sanitized owner registry snapshot and disposes it immediately; model cost and model availability are external. This path has a mock integration test but has **not been run against a real model**.

## Not yet implemented

- Owner-level auth/ACL or encrypted storage; data stays private only within the local OS user's permissions.
- Native OS background service that automatically starts on login; currently running Workbench/Electron must be started and kept running by the Owner.
- Real-time project git/file watchers; only explicit Pi opt-in events and project/task UI edits are observed.
- Delegating long-running work to project Agent workers, and task queue durability/approval; not automatic.
- Applying approved knowledge links directly into Context Compiler; links are discoverable from Owner state only.
- Graph-based cross-project automatic discovery and model-backed planning, semantic entailment and reliable generalization.
- End-to-end Pi CLI or Electron GUI tests with real model credentials; the test suite uses deterministic fake events.

## Trust model and risks

The presence of an evidence reference in the personal DB does not by itself prove external correctness. Verified Knowledge Units must be evaluated under their declared scope/version before application. All cross-project transfers remain proposals until explicitly approved. Pi extensions and the Electron runtime run with your local OS account permissions; review installed code and do not run untrusted extensions or projects.
