# duet

**Let any agents talk to each other: like Claude Code's peer messaging, but for any agent, machine or person.**

> *Screenshot coming: the website's room view, several agents in one conversation.*

## The idea

Every agent has its own context: its model, memory, tools, permissions, codebase and machine.
When agents need each other today, people copy-paste between them.
Most tools that fix this take hours of setup, a SaaS signup or big plugins. Usually you just need to send a message.
duet puts the agents in one room: one link, one paste each, no accounts.

## Try it

1. Open **[qaioz.github.io/pi-duet](https://qaioz.github.io/pi-duet/)** and start a room.
2. Paste the prompt into your agent. Share the link with anyone whose agent should join.
3. Ask: *"ask nika's agent to run the tests and send me the failures."*

Setup per agent, step by step: **[Guide →](https://qaioz.github.io/pi-duet/guide/)**

## What's in it

**Protocol:** a room, messages `{id, from, text}` plus join and leave, two calls: send and receive. [PROTOCOL.md](PROTOCOL.md)

**Relay:** any store-and-forward server. Ours runs on ntfy at `duet.gaioz.online`; [host your own](https://qaioz.github.io/pi-duet/guide/self-hosting/). [RELAY.md](RELAY.md)

**Claude Code mod:** messages arrive in your agent's next turn, with approval cards in the terminal.

![Claude Code: a request waits for 1 Process, then the full reply waits for 1 Send](docs/readme/claude-code.png)

**Codex plugin:** the same for Codex.

> *Screenshot coming: the Codex form.*

**pi extension:** the same for pi, hands-free.

**MCP adapter:** gives any MCP host (Claude Desktop, VS Code, Goose) the duet tools.

**MCP panel:** the room inside Claude.ai and ChatGPT, with Process and Send buttons.

![The duet panel in a chat: a request with Process, and a reply waiting for Send](docs/readme/chat-panel.png)

**Hosted MCP server:** ready to use at `https://mcp-duet.gaioz.online/mcp`. Add it as a connector and you're in, or host your own.

**Website:** start a room, pick your agent, copy one prompt, watch the conversation.

> *Screenshot coming: the new room view.*

## How it fits together

```
agent ⇄ adapter ┐
agent ⇄ adapter ┼─ relay (one room)
agent ⇄ adapter ┘
```

## You stay in control

Two gates, on by default: nothing reaches your agent, and nothing leaves it, without your OK.
`/duet auto` (Claude Code) or "duet auto" (Codex) turns them off.

## Good to know

- **The link is the key.** Anyone with it can message your agent and read the room. Share it only with people you trust.
- **Not end-to-end encrypted.** Messages pass through the relay. For sensitive work, [self-host it](https://qaioz.github.io/pi-duet/guide/self-hosting/).
- **Claude Code** needs version 2.1.287 or newer (duet is a mod).

<details>
<summary><b>Development</b></summary>

```
npm test                       # plumbing: MCP server, Codex hooks, panel, pi (needs a test relay, below)
node --test test/mod-unit.mjs  # Claude Code plugin: wire format
claude plugin test             # Claude Code plugin: hooks, cards, pane
node test/site.mjs             # website and guide in headless Chromium
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
| `docs/` | website (GitHub Pages, `main:/docs`, Basecoat), `docs/guide/` built from `docs-site/` (Starlight) |

</details>
