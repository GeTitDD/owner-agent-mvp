# P2 / Knowledge Evolution（v0.2）

## 完成范围

```text
Pi session_start → Agent run / tool_execution_end / agent_settled
       ↓ metadata only; default off
SQLite evolution_runs + evolution_tool_events
       ↓ explicit user-controlled evidence; optional real Node test execution
Evidence (private by default; cross-project consent required)
       ↓ optional extractor callback (model suggestions, never approvals)
Candidate (immutable payload hash, reviewable)
       ↓ manual human review + passed test evidence
Approved
       ↓ publisher checks source immutable hash, duplicate IDs, consent and approvals
Domain Package vNext (new directory, old version untouched)
       ↓ target project explicitly upgrades domain-context.json + begins new session
Context Compiler / domain_recall on the new snapshot
```

**Important:** Metadata-only traces do not contain enough semantic content to infer domain rules. A user or trusted validation process must explicitly supply an evidence summary. The extractor port accepts only explicitly share-consented summaries. The included demo uses a fixed example callback, **not an LLM**. There is no hidden model API call, background worker, or unattended self-publishing.

## 0. Setup

```bash
node --version            # >=22.13
npm test                  # 23 tests
npm run demo:evolution    # disposable demo, requires no API key
```

For CLI calls sharing a persistent database, use the same environment variable:

```bash
export DOMAIN_CONTEXT_DB="$HOME/.domain-context/index.sqlite"
```

Within an existing Pi project, enable metadata capture explicitly:

```json
"evolution": { "capture": "metadata" }
```

If omitted, capture is **off**. Even with capture enabled, tool arguments, results, prompt text, and model messages are not stored by this collector. Project roots, tool names and opaque session/branch IDs are retained locally; restrict DB file access appropriately. `agent_settled` marks a lifecycle boundary, not task correctness.

## 1. Find a settled run

After using Pi with the extension:

```bash
node bin/domainctl.mjs trace list --project-id payment-service
node bin/domainctl.mjs trace show --run <RUN_ID>
```

The run ID is a local UUID, distinct from Pi's session ID. Its `branch_leaf_id` is captured at the beginning of the run; branch changes after collection should be reviewed before interpreting evidence.

## 2. Create evidence

Recommended: run an actual trusted local Node test. This is an **explicit** user action. Node executes the test file with the permissions of your local account. Test stdout/stderr are discarded, not persisted. The ledger stores only the file hash, result, summary and run reference.

```bash
node bin/domainctl.mjs evidence verify-test \
  --project examples/payment-service \
  --run <RUN_ID> \
  --test tests/replay.test.mjs \
  --summary 'Duplicate event replay passed integration regression' \
  --share true
```

This command requires the run's `project_root` to match `--project`. An unsuccessful Node test records `outcome=failed` and cannot satisfy an approval gate. The `--share true` flag means the user explicitly permits use of that **summary** to propose cross-project knowledge; it does **not** share raw project files.

If a machine test is impossible, create a clearly identified manual attestation with `evidence add --file`:

```json
{
  "runId": "<RUN_ID>",
  "kind": "test",
  "outcome": "passed",
  "summary": "Duplicate deliveries are deduplicated in the tested code path",
  "reference": "manual-review:issue-123/test-plan-2",
  "sharingConsent": true
}
```

Use `node bin/domainctl.mjs evidence add --file evidence.json`. Manual test claims are **not automatically verified**. Approval still requires a reviewer; in production, tighten this gate to accept trusted CI evidence only.

## 3. Propose a candidate

The CLI supports a JSON candidate, which stays unpublished:

```json
{
  "domainId": "software-engineering",
  "baseVersion": "1.0.0",
  "knowledgeId": "pattern.stable-replay-key",
  "kind": "pattern",
  "title": "Stable replay identity",
  "claim": "When processing at-least-once events, preserve event identity across retries and regression-test duplicate delivery before changing committed state.",
  "keywords": ["retry", "replay", "duplicate", "event"],
  "applicability": ["queue-worker", "webhook"],
  "exceptions": [],
  "evidenceIds": ["<EVIDENCE_ID>"]
}
```

```bash
node bin/domainctl.mjs candidate propose --file candidate.json
node bin/domainctl.mjs candidate inspect --id <CANDIDATE_ID>
```

Code integration can also call `engine.extract({domainId, baseVersion, evidenceIds, extractor})`, passing an async callback that returns the same draft fields. Only summaries whose `sharing_consent` is true reach the callback; it never sees raw Pi tool outputs. Its result is still a **candidate**.

## 4. Review and publish

```bash
node bin/domainctl.mjs candidate review \
  --id <CANDIDATE_ID> --decision approve --reviewer <REVIEWER>

node bin/domainctl.mjs publish \
  --project examples/payment-service \
  --domain software-engineering \
  --from 1.0.0 --to 1.0.1 \
  --candidates <CANDIDATE_ID>
```

The publisher checks reviewer decisions, linked evidence, a passed test, consent, source-domain immutability and duplicate knowledge IDs. It writes a **new** directory `domains/software-engineering/1.0.1`. Only published/shared knowledge from the old version is carried forward; private draft files are removed from the new distribution. Skills are copied without following symlinks. Source version `1.0.0` is never altered.

There is no overwrite of existing versions. If a filesystem rename succeeds but the SQLite transaction fails, the new directory remains for explicit reconciliation; publishing is **not** claimed to be atomic across SQLite and the filesystem. Use a single publisher or add a lock/transaction coordinator before multi-worker use.

## 5. Adopt or roll back in a different project

Update the recipient project's `domain-context.json` version to `1.0.1` and start a **new Pi session**. It can then discover the new knowledge via `domain_recall`. Existing sessions remain pinned and fail closed if their reference changes mid-session.

For rollback, change the project reference back to `1.0.0`, start a new session, and retain the published `1.0.1` package for audit. Never mutate an existing version in place.

## Invariants and actual limits

- No raw prompt, tool arguments, result bodies, or chain-of-thought in the metadata trace database.
- `agent_settled` never auto-approves or auto-publishes knowledge.
- Evidence summary is *user supplied* or test-supplied; only explicitly consented evidence is passed to extractors.
- At least one `passed` test and a manual reviewer are required to promote.
- The secret detector covers only common token patterns, not all PII or data-leakage paths; reviewer must inspect each proposal.
- Strong semantic duplication/conflict detection, independent CI attestation, multi-tenant ACLs, automatic model extraction, atomic cross-store publishing, and cross-project task-quality Eval remain future work.
- Old source version and session-pinned snapshots remain immutable.

## API methods

```js
const engine = createDomainEngine({ dbPath: '/local/index.sqlite' });
const runId = engine.evolution.beginRun({ sessionId, branchLeafId, projectId, projectRoot, snapshotId });
engine.evolution.recordTool({ runId, toolCallId, toolName, isError, durationMs });
engine.evolution.settleRun(runId, { aborted: false });
const evidence = engine.evolution.addEvidence({ runId, kind: 'test', outcome: 'passed', summary, reference, sharingConsent: true });
const drafts = await engine.extract({domainId, baseVersion, evidenceIds: [evidence.id], extractor: async ({ evidence }) => []});
// Review each draft explicitly, then publish to a new version.
```

The Pi extension uses the documented `agent_start`, `tool_execution_end`, and `agent_settled` events. The local integration test mocks Pi's lifecycle and checks the persisted SQLite ledger. A full Pi CLI process with a real model has not been exercised in this environment.
