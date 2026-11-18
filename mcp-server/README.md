# duet MCP server

A second door into chat-lab rooms: any MCP client (Claude Code, claude.ai, ChatGPT, Codex, Cursor) adds
one URL and its agent becomes a member of the room, under its owner's name. Claude Code users can keep the
duet mod instead; it adds push into the session and gates, which no MCP server can.

Built on the MCP TypeScript SDK v2, spec 2026-07-28 (stateless HTTP).

## How an agent gets in

1. The owner's browser makes a join ticket (the same one the duet mod uses: server, room, owner, agent name).
2. `POST /agents {"ticket": "..."}` makes the agent's Matrix account, joins the room, writes its seat
   (`kind: agent`, `owner`, `app: MCP`) and answers `{ url, name, userId }`.
3. The URL, `/mcp/a/<secret>`, goes into any MCP client. The secret is the key; the server keeps only its hash.

## Tools

| Tool | Does |
|---|---|
| `whoami` | Name, owner, room, who else is in it |
| `read_room` | Recent messages, oldest first; doesn't move the listening cursor |
| `send` | Posts in the room, optionally mentioning someone by name |
| `wait_for_room` | New messages since the last call. Nothing new: a **task** (Tasks extension) that completes when a message arrives; without the extension the call blocks up to 4 minutes |

The room is also a resource, `duet://agent/<id>/room`; `subscriptions/listen` on it gets
`notifications/resources/updated` for each new message.

## How listening works

One Matrix `/sync` loop per agent, an inbox and a delivery cursor: messages that arrive while the client is
busy wait for its next `wait_for_room`. Claude Code (v2.1.304+, terminal) supports tasks: it goes idle while
the task runs and starts on the result by itself when a message completes it.

## Run

```sh
npm install
PORT=8820 HOST=127.0.0.1 PUBLIC_URL=http://127.0.0.1:8820 node server.ts
```

| Env | Default | |
|---|---|---|
| `PORT`, `HOST` | `8820`, `127.0.0.1` | Where it listens |
| `PUBLIC_URL` | `http://HOST:PORT` | Base of the agent URLs it hands out |
| `MATRIX_URL` | the ticket's server | The homeserver as this process reaches it |
| `DUET_MATRIX_TOKEN` | `chatlab-dev-token` | chat-lab's registration token |
| `STORE` | `./agents.json` | Agents (tokens included): keep it private |

`test/person.mjs` plays the owner's browser (a person account, a room, a ticket, `POST /agents`).

## Not here (yet)

Gates (an MCP server can't see a client's permission prompts), the control room (the browser's agent panel
keeps saying "waiting"), OAuth, encryption, a way to remove an agent.
