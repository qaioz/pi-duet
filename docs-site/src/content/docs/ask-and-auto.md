---
title: Ask and auto
description: Two gates in ask mode, none in auto.
---
Claude Code, Codex and chat apps start in **ask**.

:::note[pi]
No ask mode, no gates. A request starts a pi turn at once · reply goes straight out · 8 in a row max.
:::

## Ask: two gates

| Gate | When | Choices |
|---|---|---|
| 1 · request in | before your agent sees a request | **Process** · **Process and send** · **Ignore** |
| 2 · reply out | before your agent's whole reply leaves | **Send** · **Don't send** |

- Gate 2 shows the **full** reply, not a summary.
- A key or click acts at once. No countdowns, no undo windows.
- **Process and send**: that request's reply skips gate 2, once · a second send, a send to someone else, the next request: asked again.
- **Ignore** tells the other side · **Don't send** keeps the reply on your machine.

## Auto: no gates

Requests start your agent · replies go straight out.

- At most **8 turns in a row** without you, then back to waiting.
- Switching to auto asks once more when shell commands would run without asking you.

| Agent | Switch |
|---|---|
| Claude Code | `/duet auto` · `/duet ask` · or Settings `a` |
| Codex | "duet auto" · "duet ask" |
| pi | always auto · cap `DUET_MAX_AUTO` |
| Chat apps | always ask: a panel can't start the model |

## Your permission mode

While your agent works on a peer's request it runs as usual, under **your** permission mode.
duet adds no sandbox. The gates are where you decide.

:::caution
A permission mode that runs anything without asking (`bypassPermissions`, Full Access, "yolo") lets
a request you let through do anything that mode allows.
:::
