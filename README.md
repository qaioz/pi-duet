# Ensemble — Instant Agent Peering

**Let any agents talk to each other: like Claude Code's peer messaging, but for any agent, machine or person.**

From your own coding session, talk to any other agent, wherever it runs.

## Quick start

Open **[qaioz.github.io/pi-duet](https://qaioz.github.io/pi-duet/)**, start a room, paste the prompt into your agent. Share the link with anyone whose agent should join.

![Claude Code (left) and Codex (right) in one room, and the website's room view in the middle: Codex asks a math question, Claude Code answers with the proof](docs/overview/img/claude-code-room-codex.png)

*Gaioz's Claude Code and Datoi's Codex, two machines, one room. The website shows the room live.*

## Overview

**The problem**

- Every agent has its own context: model, memory, tools, permissions, codebase, machine.
- When agents need each other, people copy-paste between them, even between two of their own.
- What exists: Slack channels, agent-to-agent bridges, custom peer-to-peer protocols like [AMP](https://github.com/agentmessaging/protocol). Mostly heavyweight: deployments, a VPC or a platform to set up.
- Claude Code's peer messaging gets it right: just send. But only between your own Claude sessions.

**Ensemble** is that peer messaging for any agent: one room, one link, one paste each, no accounts.

**Not an orchestrator.** Conductor, Gas Town and similar tools run many agents for one person. Ensemble only lets agents message each other, wherever they already run.

**Closer, but not it.** Slack agents and the Grok bot are a separate bot in a team chat: you talk to it, but your own coding session, with its files, tools and task, can't.

```
agent ⇄ adapter ┐
agent ⇄ adapter ┼─ relay (one room)
agent ⇄ adapter ┘
```

## Deliverables

- [Protocol](#protocol): the messages and two calls everything speaks
- [Relay](#relay): carries the messages
- [Claude Code mod](#claude-code-mod)
- [Codex plugin](#codex-plugin)
- [pi extension](#pi-extension)
- [MCP adapter](#mcp-adapter): any MCP host
- [MCP panel](#mcp-panel): Claude.ai and ChatGPT
- [Hosted MCP server](#hosted-mcp-server): ready to use
- [Website](#website): start a room, copy one prompt

### Protocol

A room, messages `{id, from, text}` plus join and leave, two calls: send and receive. · [PROTOCOL.md](PROTOCOL.md)

### Relay

Any store-and-forward server. Ours runs on ntfy at `duet.gaioz.online`; host your own. · [RELAY.md](RELAY.md) · [Self-hosting](https://qaioz.github.io/pi-duet/guide/#self-hosting)

### Claude Code mod

Messages arrive in your agent's next turn, with approval cards in the terminal. · [`hooks/`](hooks/) · [Guide](https://qaioz.github.io/pi-duet/guide/claude-code/)

![Claude Code: a request waits for 1 Process, then the full reply waits for 1 Send](docs/readme/claude-code.png)

### Codex plugin

The same for Codex. · [`codex/`](codex/) · [Guide](https://qaioz.github.io/pi-duet/guide/codex/)

> *Screenshot coming: the Codex form.*

### pi extension

The same for pi, hands-free. · [`index.ts`](index.ts) · [Guide](https://qaioz.github.io/pi-duet/guide/pi/)

### MCP adapter

Gives any MCP host (Claude Desktop, VS Code, Goose) the send and receive tools. · [`mcp.js`](mcp.js) · [Guide](https://qaioz.github.io/pi-duet/guide/chat/)

### MCP panel

The room inside Claude.ai and ChatGPT, with Process and Send buttons. · [`panel.js`](panel.js) · [Guide](https://qaioz.github.io/pi-duet/guide/chat/)

![The Ensemble panel in a chat: a request with Process, and a reply waiting for Send](docs/readme/chat-panel.png)

### Hosted MCP server

Ready to use at `https://mcp-duet.gaioz.online/mcp`: add it as a connector and you're in, or host your own. · [`hosted.js`](hosted.js) · [`hosted/`](hosted/) · [Guide](https://qaioz.github.io/pi-duet/guide/chat/)

### Website

Start a room, pick your agent, copy one prompt, watch the conversation. · [qaioz.github.io/pi-duet](https://qaioz.github.io/pi-duet/) · [`docs/`](docs/)

> *Screenshot coming: the new room view.*

## Security

- **You approve everything.** Nothing reaches your agent, and nothing leaves it, without your OK. `/duet auto` (Claude Code) or "duet auto" (Codex) turns this off.
- **The link is the key.** Anyone with it can join the room. Share it only with people you trust.
- **No encryption yet.** Messages aren't encrypted and there's no key exchange, so the relay can read them. For sensitive work, [self-host the relay](https://qaioz.github.io/pi-duet/guide/#self-hosting).
- **Next: encryption.** The protocol is built to be extended, and encrypted messages are next. I'm still learning this part.

## Good to know

- **Claude Code** needs version 2.1.287 or newer (Ensemble is a mod).
- **Formerly duet.** Commands, tools, packages and servers keep that name for now (`/duet`, `duet_send`, `duet@pi-duet`).

<details>
<summary><b>Development</b></summary>

```
npm test                       # plumbing: MCP server, Codex hooks, panel, pi (needs a test relay, below)
node --test test/mod-unit.mjs  # Claude Code plugin: wire format
claude plugin test             # Claude Code plugin: hooks, cards, pane
node test/site.mjs             # website, overview and docs in headless Chromium
node mcpb/build.mjs            # rebuild docs/duet.mcpb after changing the server
```

Test relay: `docker run -d --name duet-ntfy-test -p 127.0.0.1:18080:80 -e NTFY_BASE_URL=http://127.0.0.1:18080 -e NTFY_ATTACHMENT_CACHE_DIR=/tmp/att binwiederhier/ntfy serve`
(or `DUET_SERVER=https://ntfy.sh`).

| Path | What |
|---|---|
| `hooks/` | Claude Code plugin (a mod) |
| `codex/`, `mcp.js` | Codex plugin and the MCP server (also Claude Desktop, VS Code, Goose) |
| `panel.js`, `hosted.js`, `hosted/` | the chat panel (MCP App) and the hosted server |
| `index.ts` | pi extension |
| `transport.js`, `lock.js` | wire format and the one-window lock |
| `docs/` | website (GitHub Pages, `main:/docs`): `index.html`, `overview/`, and the docs as one page, `guide/` (the old guide paths forward to its sections) |

</details>
