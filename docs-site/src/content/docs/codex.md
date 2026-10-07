---
title: Codex
description: duet for Codex CLI, the desktop app and the IDE extension.
---
## Start · prompt

1. On [the website](https://qaioz.github.io/pi-duet/): **Copy prompt**, paste it into Codex, open in your project folder.
2. duet already there: Codex calls `duet_join`, done. Otherwise approve its one shell command, then start a
   new Codex session in this folder and say "join duet" (first time: trust duet's hooks). A form asks
   `Join <room> as <name>? · <folder>`: **Join**. Codex tells duet the folder only when a turn starts.
   No form (Full Access): duet says "a join is waiting"; your own "join duet" joins.

The room code is in the prompt (and in `duet_join`'s arguments), so it stays in the session history and reaches
the model's provider. Every Codex route joins through the model; only `setup codex` (IDE) keeps it out.

## Start · plugin, yourself (CLI, desktop app)

One line, in your project folder:

```sh
codex plugin marketplace add qaioz/pi-duet && codex plugin marketplace upgrade pi-duet && codex plugin add duet@pi-duet && codex "join duet room <room> as <name>"
```

- First time: review duet's hooks → **Trust all**. After an update Codex asks again.
- Codex already open: `/plugins` → duet, new session, "join duet room `<room>` as `<name>`".
- A folder remembers its room · a new session there rejoins, in ask · "leave duet" forgets it.
- Update: `codex plugin marketplace upgrade pi-duet && codex plugin add duet@pi-duet`, new session.

## Start · `setup codex` (IDE extension, one global room)

```sh
npx -y github:qaioz/pi-duet setup codex --room <room> --name <name>
```

- Writes `~/.codex/config.toml`: duet's MCP server (120 s timeouts, approves duet's own tools only) and its hooks.
- Every Codex window joins that room. Backup: `config.toml.before-duet`.
- Undo: `npx -y github:qaioz/pi-duet setup codex --off`. Node 20+.
- Plugin **or** `setup codex`, not both.

## Two gates

| | Form | Choices |
|---|---|---|
| Request in | `duet · karlo · 14:02` + the whole request | **Process** · **Ignore** · **Process and send** |
| Reply out | `send to karlo? · full reply` + the text | **Send** · **Don't send** |

- The form shows exactly what Codex gets. Hidden characters are removed: `[hidden characters removed]`.
- **Process and send**: the first `duet_send` to karlo in that turn, answering that request, goes without the form · ends with the turn.
- Too long for one form (over 60,000 characters): **Ignore** only.
- "check duet" in ask: the same form for each request · Codex gets only the processed ones.
- "what was said in duet" in ask: only what you saw in a form.

"duet auto": no gates, 8 turns in a row max · "duet ask" back.

## Say

"check duet" · "duet status" · "what was said in duet" · "leave duet"

## Weaker spots

- A request arriving mid-turn waits for the turn to end.
- After **Esc**: requests wait for "check duet".
- **Full Access** in ask: Codex declines every form, so requests wait · "check duet" says how many, no text · type `duet auto` as your own prompt, or use a mode that asks.
- **Full Access** in ask: replies can't leave (Codex declines the Send form too) · type `duet auto` as your own prompt, or use a mode that asks.
- Hooks fail open: a slow or gone duet server means no form.
- Windows: no push · say "check duet".
