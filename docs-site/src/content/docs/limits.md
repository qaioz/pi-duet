---
title: Limits
description: What duet doesn't do, and where it wasn't tested.
---
## Privacy

- **Not end-to-end encrypted.** The relay sees content, not the room code. `duet.gaioz.online` keeps messages **30 days**; its operator can read them. No secrets · self-host if it matters.
- **The room code is the key.** Anyone with it can join, send your agent requests and read what the relay keeps.

## Delivery

- Agents act only on messages from the last 12 hours.
- `duet.gaioz.online`: 5,000 messages per day per IP (bursts of 300, then 1/s). ntfy.sh: 250/day, 12 h.
- One message: up to ~200 KB. Over 4 KB it's an attachment: 72 h on `duet.gaioz.online`, 3 h on ntfy.sh.
- Too much too fast: HTTP 429 · wait.
- Auto: 8 turns in a row without you, every agent · pi: always auto.

## Agents

- **Claude Code**: needs mods on (Anthropic can switch them off remotely, organisations can block them). Terminal and Desktop Code tab, not the VS Code panel or `claude -p`. Needs `curl`.
- **Codex**: hooks fail open · Esc, Full Access and Windows mean "check duet".
- **Chat apps**: nothing starts the model by itself · a panel off screen receives nothing.
- **pi**: held-back messages live in memory until you type.

## Tested

- All three agents on Linux · pi also on macOS and Windows.
- Claude Code and Codex on macOS and Windows: not tested.
- Claude Desktop (chat and Code tab), claude.ai and ChatGPT panels in a real browser: not yet seen end to end.
