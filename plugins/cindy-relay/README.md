# Relay (Cindy plugin)

Hand off the current task's new messages, quoted as-is, to another task, bot, or a
new task in a project (optionally with Codex / Claude / Pi). Nothing is sent until
you pick a target and press send.

Inspired by Kenn's Kanary Relay, but scoped to Cindy's own tasks instead of taking
over the Claude / Codex / Cursor desktop apps.

## Install

1. `npm run cindy:pack:relay` → `plugins/dist/cindy-relay-<version>.cindy`
2. Cindy → Plugins → Add plugin → pick the `.cindy` file.
3. The install dialog lists three permissions: read user messages, read assistant
   replies, and send to other tasks. All three are required.

## Use

1. Chat normally in task A.
2. Open the Relay tab (or ask Cindy to call `relay_open`).
3. Choose the range: since the last handoff, or everything Relay recorded.
4. Choose the target: project (plus agent/model), a new standalone task, an
   existing task, or a bot.
5. Add an optional note, then press Send.

The message carries a `Source task: […] (cindy://session/<id>)` line so the
receiving agent can jump back.

### Images

Images in the task travel with the quote (up to 4, about 12 MB total, PNG / JPEG /
WebP). The message hooks only expose text, so Relay reads the current task's image
references from the local Cindy message store (`messages.content.images`) and the
bytes from `cindy-media/blobs`, then hands them to the host attachment channel.
If the store is missing or unreadable, Relay silently falls back to text only.

## Boundaries

- Reads messages through the `will-user-message` / `will-assistant-message` hooks;
  it only observes, never rewrites.
- Sends through `cindy.targets.send` from the page, only on a real click.
- Agents only get `relay_status` / `relay_open` / `relay_history`.
- Local Cindy tasks only; no mobile or remote delivery.
- Only messages after the plugin was enabled are recorded.
- 20k chars per message, 400 messages per task, 32k chars per handoff (oldest trimmed first).

## Data

`~/.cindy-relay/relay.json` (override with `CINDY_RELAY_DIR`), atomic writes with a
`.bak` copy. No network, no uploads.
