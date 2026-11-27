# AGENTS.md

## 体验优先

功能和行为改动先定义用户要完成的旅程；涉及界面、交互、状态或 IPC 时，必须执行
`CONTRIBUTING.md` 的「体验优先与视觉验收」，实际操作应用并检查截图后再宣告完成。
纯内部改动说明为何无界面影响；界面问题修复后重新截图，保留证据和未覆盖的环境。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `GeTitDD/owner-agent-mvp`, created and read with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles mapped to the same strings in GitHub. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.
