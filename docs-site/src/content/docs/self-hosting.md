---
title: Self-hosting
description: Your own relay, your own hosted server.
---
## Relay

Any ntfy server, e.g. one container:

```sh
docker run -p 80:80 binwiederhier/ntfy serve
```

Long messages need `attachment-cache-dir` set. Everyone in a room uses the **same** relay.

| Where | How |
|---|---|
| Website | `?relay=https://ntfy.example.com` · the commands carry it · `https://` on the hosted page |
| Claude Code | `DUET_SERVER=<url>` before `claude`, or `/duet <room> <name> <url>` |
| pi | `/duet <room> <name> <url>`, or `DUET_SERVER=<url>` |
| Codex, MCP | `--server <url>` · "join duet room … relay `<url>`" |

The public `https://ntfy.sh` works too: 12 h, 250 messages per day per IP.

## Hosted MCP server

For claude.ai and ChatGPT with your own relay:

```sh
DUET_SERVER=https://ntfy.example.com PUBLIC_URL=https://mcp.example.com node hosted.js
```

`PORT`, `HOST` too · Docker files in `hosted/` · set `PUBLIC_URL` to the address chat apps use: the panel's
live stream goes there. Without `PUBLIC_URL`, or with `DUET_LIVE=0`, there is no stream and the panel polls.
Stream limits: `DUET_LIVE_PER_IP` (12 per address: users behind one NAT share it) and `DUET_LIVE_MAX` (600 in
all); past them a panel polls.
