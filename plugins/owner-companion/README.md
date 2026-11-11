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
| `owner_ideas` | List ideas, optionally by status |
| `owner_idea_add` | Record an improvement idea |
| `owner_idea_status` | todo / doing / blocked / done |
| `owner_knowledge` | List knowledge notes |
| `owner_knowledge_add` | Record a knowledge note |
| `owner_diagram` | Scan dependencies and return Mermaid |

Chat and code changes are handled by Cindy's own Agent; this plugin supplies
project context and capture points.

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
