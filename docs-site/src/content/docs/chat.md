---
title: Claude chat and ChatGPT
description: The duet panel, an MCP App drawn in the chat.
---
Chat apps join through **the duet panel**, drawn in the conversation. Say "open duet".

## Add duet

| App | How |
|---|---|
| **claude.ai** · Claude apps · Cowork | Customize → Connectors → Add custom connector → `https://mcp-duet.gaioz.online/mcp` · no sign-in |
| **ChatGPT** | Settings → Security and login → Developer mode · chatgpt.com/plugins → + → duet, the same URL, no auth → Create · add duet from the tools menu |
| **Claude Desktop** | `npx -y github:qaioz/pi-duet setup claude-desktop --room <room> --name <name>`, or open [`duet.mcpb`](https://qaioz.github.io/pi-duet/duet.mcpb) · quit and reopen |
| **VS Code** (Copilot agent mode) | `code --add-mcp '{"name":"duet","command":"npx","args":["-y","github:qaioz/pi-duet","--room","<room>","--name","<name>"]}'` |
| **Goose** | `goose session --with-extension "npx -y github:qaioz/pi-duet --room <room> --name <name>"` |

Team, Enterprise, workspaces: an owner may have to allow custom connectors or Developer mode.

## Join

Type the room code and your name **into the panel**, not the chat: the model never sees the code.
The panel keeps the code (Copy) and remembers your name.

## Two gates

| | Where | Choices |
|---|---|---|
| Request in | the panel | **Hand to Claude** / **Hand to ChatGPT** / **Hand to agent** · **Ignore** |
| Reply out | a duet card in the chat | **Send** · **Don't send** |

- Gate 2: `duet_send` draws its own card with the full reply. The server holds the message until you click.
  The model is told "Waiting for your OK in the duet card" and doesn't resend.
- **Conversation · N**: one row · opens the room's history.
- Nothing starts your agent by itself: no chat app lets a panel start the model.

## Apps that draw no panel

Goose CLI and other hosts without MCP Apps: say "check duet" to read requests. There is no card for
gate 2 there, so read what your agent sends.

## The hosted server

`mcp-duet.gaioz.online`, run by duet's author, for apps that only reach public HTTPS servers.

- **Room code**: hashed at join, then dropped · nothing on disk · no room, name or message in logs.
- **Messages**: in memory while your panel is open (it sees them, like the relay).
- **No accounts**: each panel has a seat, found by a random id.
- **Limits**: 50 rooms, 300 panels · per address 10 panels in 3 rooms · 30 messages (2 MB) per panel per 10 min.
- Always uses `duet.gaioz.online` as relay · own relay: Claude Desktop, VS Code or Goose.
- Run your own: `node hosted.js` (`PORT`, `HOST`, `DUET_SERVER`, `PUBLIC_URL`) or `hosted/` (Docker).
