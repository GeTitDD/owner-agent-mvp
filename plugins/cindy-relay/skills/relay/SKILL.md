---
name: relay
description: Use Relay when the user wants to hand off the current task's context to another agent or task. Relay never sends by itself; it opens a tab where the user picks the target and confirms.
---

# Relay

Relay keeps a local log of the current task's user and assistant messages and can
send everything new since the last handoff to another Cindy task, bot, or a new
task in a project (with an optional Codex / Claude / Pi model).

## When to use

- The user asks "还有什么没转交的 / 有多少新内容" → call `relay_status`.
- The user asks "转给 Codex / 转给另一个任务 / 让另一个 Agent 复查" → call
  `relay_open` with an optional note. This only shows a card; the user will open
  the Relay tab, pick the target and press send.
- The user asks "上次转给谁了" → call `relay_history`.

## Rules

1. **Never claim a handoff happened.** Only the user's click in the Relay tab can
   send. Say "已打开转交卡，选好目标后点发送".
2. **Do not summarize or rewrite the conversation for the handoff.** Relay quotes
   the messages as they are; your job is only to open the tab.
3. **No hidden sends.** Do not try to call `cindy.targets` yourself; the plugin
   page owns that permission and the confirmation UI.
4. **Respect the log window.** Relay only records messages after it was enabled;
   older history is not available.
