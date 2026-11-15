# Owner Companion (Cindy plugin)

A self-contained Cindy plugin for project tracking: project brief, idea inbox,
knowledge notes and a dependency diagram. Everything lives in the plugin's own
Node worker — no bridge, no second client, no desktop app required.

## Install

1. Build the package: `npm run cindy:pack` → `plugins/dist/owner-companion-<version>.cindy`.
2. In Cindy open **插件 → 添加插件** and choose the `.cindy` file (or drag it in).
3. Open **Owner** from the left navigation, then click **添加项目** and paste a
   local project path.

Verified against **Cindy 0.1.124 (Windows)**: install, enable, main view, idea
create/adopt/delete, dependency scan and agent tools.

## Data and permissions

- Data file: `~/.owner-companion/owner.json` (atomic writes, `.bak` backup).
- No project files are written. All tools are read-only except ideas and
  knowledge notes, which only touch the plugin's own JSON file.
- The plugin declares a Node worker plus `mainView` / `panel` / `settingsHtml` /
  mobile projection. Pages and `main.js` have no direct network or filesystem
  access; the worker performs local reads and scans.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `owner_projects` | List registered projects |
| `owner_project_overview` | Brief, next action, ideas and diagram summary |
| `owner_brief_refresh` | Re-scan the project and rebuild the brief |
| `owner_ideas` / `owner_idea_add` / `owner_idea_status` | Idea inbox |
| `owner_knowledge` / `owner_knowledge_add` / `owner_knowledge_propose` | Knowledge list, direct note, review candidate |
| `owner_knowledge_tidy` / `owner_knowledge_search` | Tidy report / keyword search |
| `owner_experience_add` | Record a raw experience |
| `owner_github_status` | Repo, issues, PRs and branch state |
| `owner_patches` / `owner_patch_propose` | Pending patches / submit a diff proposal |
| `owner_test_run` | Run an allowlisted test command |
| `owner_diagram` | Dependency scan + Mermaid |

Apply-patch and create-Draft-PR are **UI-only** (no agent tool), and both require an
explicit confirmation checkbox.

## Knowledge flow

```text
conversation
  ├─ owner_experience_add      raw observation
  └─ owner_knowledge_propose   candidate (status: proposed)
         │
         ├─ 接受 → unverified ── 标记已验证 → verified
         └─ 拒绝 → rejected（保留审计）
```

Tidy only reports duplicates, short bodies and unverified items; it never merges or
deletes. Accepting a candidate is not verification.

## GitHub, patches and tests

- `owner_github_status` uses the local `gh` CLI (repo, 5 issues, 5 PRs, branch and
  dirty state). Repos the current `gh` account cannot see return a readable error.
- Draft PR creation is UI-only: requires the confirmation checkbox, refuses dirty
  worktrees or a branch equal to base, pushes the current branch, never merges.
- `owner_patch_propose` accepts a `git diff` (paths must stay inside the project).
  Applying is UI-only: confirmation checkbox + base-commit check + `git apply`.
- `owner_test_run` accepts only `npm test`, `npm run <script>`, `node --test`,
  `pytest`, `python -m pytest`, `dotnet test`, `cargo test`, `go test`.
- No Docker sandbox and no auto-merge; Cindy's own agent/permissions handle broader
  code changes.


## Development

```text
plugins/owner-companion/
├── ghost.json          # schemaVersion 3 manifest + tools
├── main.js             # sandbox brain: page <-> worker, tool calls
├── bridge.js           # page helper (BroadcastChannel + /wake)
├── main-view.html/css/js
├── settings.html/js
├── node/worker.cjs     # JSON-RPC stdio
└── node/lib/
    ├── store.mjs       # projects / ideas / briefs / diagrams / knowledge
    ├── scan.mjs        # bounded project scan
    ├── brief.mjs       # quick local brief
    └── diagrams.mjs    # dependency scan + Mermaid
```

Tests: `tests/plugin-worker.test.mjs`, `tests/plugin-scan.test.mjs`,
`tests/plugin-diagrams.test.mjs`.

Packaging uses JSZip so zip entries use `/` separators (Windows
`Compress-Archive` writes `\` and Cindy rejects the package).
