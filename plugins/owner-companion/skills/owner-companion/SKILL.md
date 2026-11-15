---
name: owner-companion
description: Use Owner Companion tools for project progress, project briefs, ideas, knowledge and dependency diagrams. Read-only by default; apply patches and create PRs only through the Owner plugin UI.
---

# Owner Companion

Owner Companion is a Cindy plugin that keeps project-level state on this computer:
projects, briefs, an idea inbox, knowledge notes, dependency diagrams, GitHub
status, patch proposals and test runs.

## When to use

Use the `owner_*` tools whenever the user asks about a project's progress,
structure, risks, ideas, knowledge, dependencies, GitHub state or tests. Do not
answer from memory when the project is registered in Owner — call the tool first.

Start with `owner_projects` if you do not know the project id, then
`owner_project_overview` for a compact view (brief, next action, idea and
knowledge counts, diagram versions).

## Tool selection

| User intent | Tool |
| --- | --- |
| "我有几个项目 / 项目列表" | `owner_projects` |
| "这个项目怎么样 / 进度 / 下一步" | `owner_project_overview` |
| "重新看一下这个项目 / 画像过期" | `owner_brief_refresh` |
| "记一下这个想法" | `owner_idea_add` |
| "有哪些想法 / 待讨论" | `owner_ideas` |
| "把这个想法标记为已采纳/搁置" | `owner_idea_status` |
| "我之前记过什么知识" | `owner_knowledge` |
| "记一条知识" | `owner_knowledge_add` |
| "把这次讨论提炼成知识候选" | `owner_experience_add` then `owner_knowledge_propose` |
| "知识库有什么重复/没验证的" | `owner_knowledge_tidy` |
| "搜一下知识" | `owner_knowledge_search` |
| "画一下依赖" | `owner_diagram` |
| "看下 GitHub / PR / Issue" | `owner_github_status` |
| "跑一下测试" | `owner_test_run` |
| "把这次改动做成补丁" | `owner_patch_propose`（必须提供 git diff） |

## Rules

1. **Never invent project facts.** Only describe what a tool returned. If a tool
   returns nothing or an error, say so and suggest adding the project in the
   Owner plugin.
2. **Knowledge is not verified by default.** A candidate proposed with
   `owner_knowledge_propose` is `proposed`; accepting and verifying happen only in
   the Owner plugin UI. Never claim a candidate is verified.
3. **Ideas are captured, not executed.** `owner_idea_add` only stores text.
4. **Code changes need a patch proposal.** Generate a `git diff`, then call
   `owner_patch_propose`. Do not edit project files directly for Owner-tracked
   changes. The user applies the patch in the plugin UI.
5. **Draft PR creation is UI-only.** Never claim a PR was created unless the user
   did it in the plugin. You may read PR/Issue state with `owner_github_status`.
6. **Tests use the allowlist.** `owner_test_run` only accepts `npm test`,
   `npm run <script>`, `node --test`, `pytest`, `python -m pytest`, `dotnet test`,
   `cargo test`, `go test`.
7. **Keep output compact.** Summarize; do not dump raw tool JSON.
