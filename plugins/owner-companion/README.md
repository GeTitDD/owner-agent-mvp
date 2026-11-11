# Owner Companion (Cindy plugin)

Brings Owner Companion's project view into Cindy: project brief, the idea inbox,
knowledge counters, diagram versions and a read-only discussion with the Agent.

The plugin does not store project data itself. It talks to the Owner Companion
desktop app's mobile bridge on your machine (`http://127.0.0.1:47831` by default).

## Install

1. Install and start Owner Companion on the same computer.
2. In Owner Companion open **Settings → 手机连接 (Phone connection)** and note the
   address and the 6-digit pairing code.
3. In Cindy open the plugin settings and fill in the address and code, then press
   **连接**. The plugin stores only the device token, never the pairing code
   (`~/.owner-companion/plugin.json`, mode 0600).
4. Open the **Owner** main view from Cindy's left navigation.

## What you get

| Area | Behaviour |
| --- | --- |
| Projects | Switch between registered projects; each project loads its own data |
| Brief | One-liner, how to run, risks, stale marker |
| Ideas | Add / adopt / park / reopen / delete, or send one back to the chat |
| Knowledge | Experience / knowledge / candidate counters and diagram versions |
| Chat | Read-only discussion through the desktop analysis pipeline |

## Permissions and limits

- The plugin declares only a Node worker (`node/worker.cjs`). Pages and `main.js`
  have no direct network access; the worker performs loopback HTTP requests.
- No write access to project files, no approvals, no job execution. If a chat
  message needs a code change, Owner Companion creates a pending request that
  must be approved on the desktop.
- The bridge token is stored per user profile. Delete
  `~/.owner-companion/plugin.json` to unlink.

## Development

```text
plugins/owner-companion/
├── ghost.json          # schemaVersion 3 manifest
├── main.js             # sandbox background: page <-> Node worker
├── bridge.js           # page helper (BroadcastChannel + /wake)
├── main-view.html/css/js
├── settings.html/js
└── node/worker.cjs     # JSON-RPC stdio -> HTTP bridge
```

Tests for the worker live in `tests/owner-companion-plugin.test.mjs`.
