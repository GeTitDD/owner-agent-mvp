# P3 · Layered Knowledge Composition (v0.3)

## Core goal

Build reusable, inspectable knowledge for new research, experiments, and feature development. **This is not primarily an Agent-task-success optimizer.** Pi is the first adapter, not the owner of the knowledge.

- **L1 / domain:** transferable concepts, mechanisms, invariants.
- **L2 / applied:** transferable patterns and experimental procedures, often conditional.
- **L3 / project:** environment, requirements, decisions, project-specific findings.
- **Sharing is orthogonal to abstraction:** `layer` says what a claim is about; `sharing` controls where it may be accessed. L3 example records stay local (`sharing: "project"`).
- **Confidence is orthogonal to eligibility:** `applicable` does not mean `verified`. Verification is a separate `verification.status` field.

## Project knowledge first: extraction and maintenance

The immediate objective is **reliable knowledge within each registered project**, not a universal cognitive ontology or a continuously updated mirror of external facts.

- Distinguish declared project context (goals, versions, capabilities, constraints) from observed behavior backed by code, tests or experiments.
- Capture completed experience and evidence before distilling atomic claims; Agent-generated candidates are unverified and do not imply Owner acceptance.
- Default new findings to L3 and the correct project scope. Cross-project promotion to L2 requires successful independent evidence from at least two distinct projects; L1 needs stronger domain-level validation and explicit review.
- Applicability, verification and Owner adoption are different concepts. Neither an applicable rule nor a passing test proves that Owner already knows the claim.
- Preserve revisions and provenance. When dependencies, evidence or conditions change, mark relevant knowledge for review instead of overwriting a previously adopted revision.

See [Project Knowledge Maintenance](PROJECT_KNOWLEDGE_MAINTENANCE.md) for the current extraction SOP. The main branch already provides layered knowledge and manual Workbench editing; automatic harvest/reuse/feedback remains Draft [PR #23](https://github.com/GeTitDD/owner-agent-mvp/pull/23).

## Run the new end-to-end example

```bash
node --version                   # requires Node 22.13+
npm test                         # includes v0.2 regression tests
npm run demo:layered
node bin/domainctl.mjs inspect --project examples/pi-local-research
node bin/domainctl.mjs explain --project examples/pi-service-research
node bin/domainctl.mjs compile --project examples/pi-service-research --task 'test caching in Pi extension'
node bin/domainctl.mjs lock --project examples/pi-local-research --out /tmp/pi-local-context.lock.json
```

Both examples import `context-engineering@0.1.0#cache` and `software-testing@0.1.0#experiments`. The cache profile automatically imports `pi-sdk@0.1.0#core`. The projects share domain `snapshotId` and stable prefix `stableHash`, but differ in `projectSnapshotId`, selected knowledge and applicability:

| Knowledge | Local Pi research | Service Pi research |
|---|---|---|
| Prefix-cache applied practice | `applicable` | `not_applicable` (`prefix_cache=false`, no latency objective) |
| Isolated experiment runner | `applicable` | `not_applicable` (`isolated_runner=false`) |
| Provider cache usage metrics | `applicable` | `needs_verification` (not declared) |
| L3 project knowledge | local sandbox observation | tenant-isolation boundary |

**These example claims are illustrative, NOT production-verified Pi findings.** They are explicitly marked `verification.status = "unverified"`. The tests verify deterministic selection logic, not the truth of every claim or actual cache hits.

## Project profile schema

`examples/pi-local-research/domain-context.json` is a full worked example. The optional extended fields are:

```json
{
  "project": {
    "id": "my-project",
    "primaryDomain": "pi-sdk",
    "notes": "Workload-specific caveats",
    "environment": {
      "runtime": "Node.js 22",
      "platform": "linux-container",
      "dependencies": { "pi-sdk": "version-under-test" },
      "capabilities": { "prefix_cache": false },
      "properties": { "networked": true }
    },
    "requirements": {
      "ids": ["auditability"],
      "goals": ["Build a tenant-safe extension"],
      "constraints": { "multi_tenant": true }
    },
    "decisions": [{ "id": "tenant-gating", "summary": "Check tenant before recall" }]
  },
  "domainRoot": "../../domains",
  "domains": [{ "id": "context-engineering", "version": "0.1.0", "profile": "cache" }],
  "projectKnowledgeFiles": ["knowledge/local-finding.json"],
  "context": { "maxTokens": 2400 }
}
```

Runtime and dependencies are declarations, not environment detection. A feature being undeclared is **unknown**, not `false`.

## Domain manifest with profiles and dependencies

```json
{
  "id": "context-engineering",
  "version": "0.1.0",
  "stableKnowledgeIds": ["context.foundations"],
  "knowledgeFiles": ["knowledge/context.foundations.json", "knowledge/context.prefix-cache.json"],
  "profiles": {
    "cache": {
      "knowledgeIds": ["context.foundations", "context.prefix-cache"],
      "stableKnowledgeIds": ["context.foundations"],
      "dependencies": [{ "id": "pi-sdk", "version": "0.1.0", "profile": "core" }]
    }
  }
}
```

The resolver:

1. Recursively loads declared *package* dependencies, rejects cycles and domain-version conflicts.
2. Merges requested profiles of the same domain without duplicating records.
3. Selects only explicit IDs from each profile, and rejects IDs absent from published shared records.
4. Produces deterministic import ordering independent of the order of declarations.
5. Includes the entire package's published knowledge and Skill content in the package hash, even if only one profile is selected. Mutating an indexed package version is prohibited.

`profile: "all"` (the default) imports all published/shared knowledge from that package. An unknown named profile fails closed. Cross-domain `relations` are recorded for future knowledge-graph exploration; P3 only enforces explicit `contradicts` links and package-level dependencies, not full knowledge-level dependency closure.

## Knowledge with machine-readable applicability

```json
{
  "id": "context.prefix-cache",
  "layer": "applied",
  "kind": "pattern",
  "title": "Stable prefix caching strategy",
  "claim": "...",
  "keywords": ["cache", "prefix"],
  "status": "published",
  "sharing": "shared",
  "verification": { "status": "unverified" },
  "applicability": {
    "requires": [
      { "source": "environment", "path": "capabilities.prefix_cache", "op": "eq", "value": true },
      { "source": "requirements", "path": "ids", "op": "contains", "value": "reduce-latency" }
    ],
    "excludes": []
  },
  "evidenceRefs": ["example:experiment-01"]
}
```

Supported sources: `environment` with `runtime`, `platform`, `capabilities.KEY`, `dependencies.KEY`, `properties.KEY`; `requirements` with `ids`, `constraints.KEY`. Supported comparisons: `eq`, `ne`, `contains`, `in`. No expression evaluation, shell execution, JMESPath, or custom code. All predicates are deterministic.

| Result | Meaning |
|---|---|
| `applicable` | No configured condition is contradicted or unknown. **Not proof of factual validity.** |
| `needs_verification` | One or more required environmental/requirement properties are absent or unknown. |
| `not_applicable` | A required fact was explicitly false, or an exclusion explicitly true. |
| `conflict` | An unresolved explicit `contradicts` relation links two potentially applicable records. Neither is auto-injected. |

Legacy P2 candidate `applicability: ["human-readable label"]` is still supported as advisory text; it is **not** silently reinterpreted as a machine predicate.

Stable always-on knowledge must not include project-dependent applicability rules. Such packages are rejected, preserving the distinction between globally stable prefixes and dynamic project advice.

## L3 local knowledge

The project may opt into `projectKnowledgeFiles`, each inside its project directory. Example:

```json
{
  "id": "my-finding", "layer": "project", "kind": "experiment",
  "title": "This repo's result", "claim": "Experiment outcomes bound to this exact repository",
  "keywords": ["experiment"], "status": "published", "sharing": "project",
  "verification": { "status": "unverified" },
  "evidenceRefs": ["local:test-01"]
}
```

These records:
- Cannot escape the project directory via `../` or symlinks.
- Are retrieved in memory by the compiler and recall tool, but **never written to the shared SQLite full-text index**.
- Are excluded from any other project's snapshot, unless a human explicitly builds and publishes generalized, reviewed shared knowledge through a separate workflow.
- Do not affect `sharedSnapshotId` or `stableHash`; they do affect `projectSnapshotId`, compilation hash and the lock.

This is project isolation within a single trusted local process, **not** a network multi-tenant authorization solution. Do not expose the local engine as a public service without authentication and ACL enforcement.

## Two independently useful snapshot identities

- `sharedSnapshotId`: hashes selected published shared domain contents, profiles, manifest and Skill metadata. Identical for projects importing exactly the same versioned knowledge.
- `projectSnapshotId`: hashes `sharedSnapshotId` plus the validated environment, requirements, decisions, budget settings and L3 local record content. Varies when a project's actual context changes. The absolute checkout path is excluded from the hash for portability; it is used independently when pinning sessions.
- `stableHash`: hash of byte-identical stable text. It is **not** a provider's KV cache key.
- `compilationHash`: additionally includes task text, selected knowledge and compiler version.

`domainctl lock --project PATH --out /path/to/file.json` generates a deterministic, task-independent lock including knowledge keys, content hashes, per-project applicability, domain version pins and contradictions. It refuses to overwrite a different existing lock; choose a new filename for a new experiment or knowledge revision. Even though it stores hashes rather than full claims, the lock contains project metadata; **do not publish it without reviewing project-specific information**.

## Where the previous project experience pipeline fits

P2 Trace/Evidence/Candidate/Review/Publish remains in place and regression tested. But the broader system's main purpose is producing **trusted, reusable domain understanding** for a user or an Agent's *new research and experiments*, not automatically optimizing downstream task completion. The next modules should prioritize personal knowledge editing, source provenance, active gap discovery and isolated experiment validation.

## Current boundaries

- No Web knowledge-management UI or personal-note CRUD in this release.
- No automated semantic generalization from project results to cross-project domain patterns; P2 supports manually reviewed publication of new candidates.
- No complete graph reasoning, semver constraint solving, or knowledge-level dependency closure yet.
- No self-executing research Agent, no production cache-hit tracing.
- Pi integration remains **mock-lifecycle tested**, not verified against a real Pi install or live model.
- A declared capability or version is not automatically inspected in the actual runtime. Verified evidence status must come from actual tests/source inspection, not field names.
- Minimal keyword retrieval is not a Chinese semantic search solution; extend with hybrid retrieval when requirements justify it.
