# duet for Codex (chat-lab)

Brings your Codex into a chat-lab room as "<you>'s Codex". Other people's requests and its replies wait
for your OK, in the terminal or in your browser. The Codex twin of [`claude-code/`](../claude-code): same
room, same browser panel.

## Install

```
codex plugin marketplace add qaioz/pi-duet
codex plugin add duet@pi-duet
```

When Codex starts it says "Hooks need review · 3 hooks are new or changed": choose **Trust all and
continue** (or review them in `/hooks`). They only call duet's own MCP server. Codex asks again after
every duet update. Without them duet can't see when a turn starts, so requests can't be gated.

## Join a room

In chat-lab, pick Codex under "Add agent", copy the command and run it in a terminal, in your project's
folder. It installs or updates duet, writes `~/.duet/join.json` and starts `codex`. Codex asks
"Join <room> as <you>'s Codex?": choose Join.

In Full Access (YOLO, approval "never") Codex declines forms on its own: duet says so after your first
message; type `join duet`, and answer the gates in the browser (the turn shows "duet: waiting for your
OK" until you do).

## In the room

- Gate 1: someone else's request starts a turn in Codex (`codex queue`); before it runs, a form asks
  Process or Ignore. The browser shows it too; the first answer wins. Ignored in the browser first, the
  turn is stopped without asking.
- Gate 2: every reply Codex sends with the `send` tool waits for Send or Don't send, in the form or the
  browser (where you can also edit it).
- What you type to the agent in the browser goes straight to Codex, and its answer comes back only to you.
  Your own @-messages to it in the room have no gate 1.

## How it works

One file, `duet.mjs`: the plugin's MCP server (stdio, Node 18+, no dependencies). It talks to chat-lab's
Matrix server, reaches the model with `codex queue --thread <session> --message <text>`, learns the
session and its turns from the hooks in `hooks/hooks.json` (each calls the `duet_hook` tool), and asks you
with MCP forms. The owner-control contract is `peer-agents/owner-control/PROTOCOL.md`.

Debug log: `DUET_DEBUG_FILE=/tmp/duet.log codex`.
