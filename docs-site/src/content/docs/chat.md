---
title: Claude chat and ChatGPT
description: The duet panel, an MCP App drawn in the chat.
---
Chat apps join through **the duet panel**, drawn in the conversation. Add duet once (below), then paste
the website's prompt: "Open duet: call duet_room with room `<room>` and name `<name>`." The panel opens joined.

## Add duet

| App | How |
|---|---|
| **claude.ai** · Claude apps · Cowork | Customize → Connectors → Add custom connector · name **`duet`** · URL `https://mcp-duet.gaioz.online/mcp` · no sign-in |
| **ChatGPT** | Settings → Security and login → Developer mode · chatgpt.com/plugins → + → **Add custom MCP server**, name **`duet`**, the same URL, no auth → **Create as a plugin** · install it from your plugins · new chat |
| **Claude Desktop** | `npx -y github:qaioz/pi-duet setup claude-desktop --room <room> --name <name>`, or open [`duet.mcpb`](https://qaioz.github.io/pi-duet/duet.mcpb) · quit and reopen |
| **VS Code** (Copilot agent mode) | `code --add-mcp '{"name":"duet","command":"npx","args":["-y","github:qaioz/pi-duet","--room","<room>","--name","<name>"]}'` |
| **Goose** | `goose session --with-extension "npx -y github:qaioz/pi-duet --room <room> --name <name>"` |

Name it `duet`: the chat shows that name on its prompts ("… from duet"); a room code as the name says
nothing, and it sits in your connector list. Renaming later: Customize → Connectors → the connector → edit.

Team, Enterprise, workspaces: an owner may have to allow custom connectors or Developer mode.

Claude asks before the first `duet room` in a chat: **Always allow** (or Customize → Connectors → duet →
tool permissions) skips it next time. The panel calls nothing until you click Join, so opening it asks once.

## Join

- **The prompt**: quick, but the code stays in the chat history.
- **The panel** (the private way): say "open duet", type the room code and your name into it · the model never sees the code.

The panel keeps the code (Copy) and remembers your name.

## Two gates

| | Where | Choices |
|---|---|---|
| Request in | the panel | **Process** · **Ignore** · **Process and send** |
| Reply out | a duet card in the chat | **Send** · **Don't send** |

- Gate 2: `duet_send` draws its own card with the full reply. The server holds the message until you click.
  The model is told "Waiting for your OK in the duet card" and doesn't resend.
- **Process and send**: the reply to that request goes out without the card's Send · once · 15 min.
- **Check** (panel) or "check" (chat): what waits, and from whom · your agent never reads a request before you click.
- A long request shows its start · **Process** waits for **Show all**.
- Hidden characters are removed, here and in what your agent gets: `[hidden characters removed]`.
- **Conversation · N**: one row · opens the room's history.
- Nothing starts your agent by itself: no chat app lets a panel start the model.

## What's live, what waits for a click

| Where | A new request shows up | Reaches your agent | Reply goes out |
|---|---|---|---|
| claude.ai, Claude apps, Cowork | live stream from the hosted server · polls every 4 s if the app blocks it | your click (Process) | your click (Send), or Process and send |
| ChatGPT | the same | your click | your click |
| Claude Desktop chat, VS Code, Goose (local server) | polls every 4 s (20 s in a hidden tab) | your click | your click |
| Claude Code, Codex, pi | live (the relay) | ask: your keypress · auto: by itself | ask: your keypress · auto: by itself |

Checked in a test browser (Chromium) only: the stream, and polling when a strict app blocks it. Not yet seen
in claude.ai, the Claude apps, Cowork or ChatGPT: whether they let the panel open the stream (if not, the
panel polls, as before). No chat app lets a panel start the model: a request waits for your click everywhere.

## Apps that draw no panel

Goose CLI and other hosts without MCP Apps: say "check duet". With forms, each request asks **Process** /
**Process and send** / **Ignore** first. No forms: in ask, requests wait unread · start duet with `--mode auto` to take them.
There is no card for gate 2 there, so read what your agent sends.

## The hosted server

`mcp-duet.gaioz.online`, run by duet's author, for apps that only reach public HTTPS servers.

- **Room code**: hashed at join, then dropped · nothing on disk · no room, name or message in logs.
- **Messages**: in memory while your panel is open (it sees them, like the relay).
- **No accounts**: each panel has a seat, found by a random id.
- **Limits**: 50 rooms, 300 panels · per address 10 panels in 3 rooms · 30 messages (2 MB) per panel per 10 min.
- Always uses `duet.gaioz.online` as relay · own relay: Claude Desktop, VS Code or Goose.
- **Live stream** (`/live`): the panel reads its own room's state straight from the server (the one domain
  it declares) · the same state it would poll for · `DUET_LIVE=0` turns it off.
- Run your own: `node hosted.js` (`PORT`, `HOST`, `DUET_SERVER`, `PUBLIC_URL`) or `hosted/` (Docker).
