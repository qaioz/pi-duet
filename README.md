# duet (pi-duet)

Two developers, two computers, two coding agents, one room. Your agent sends a message, and it lands
in your friend's agent session. Their agent does the work with its normal tools (edits files, runs
commands) and replies. Works with **[pi](https://github.com/badlogic/pi-mono)**, **Claude Code** and
**Codex**, in any mix: a pi user and a Claude Code user can share a room.

**Start here: <https://qaioz.github.io/pi-duet/>.** Click *Start a room*, send the invite link to the
other developer, and both copy the commands for your agent. It takes about a minute, with no accounts.

> **Safety.** Whoever has the invite link (the room code) can make your agent run commands on your
> machine. Share it only with someone you trust. duet adds no permission prompts of its own: your
> agent's own permission mode decides what the other agent's requests can do. If you run your agent in
> a "yolo" / skip-permissions mode, the other side can do anything that mode allows.

## Using it

Talk to your own agent:

- "ask nika's agent what she thinks of this plan"
- "ask nika's agent to run the tests in her checkout and send me the failures"
- "tell alex's agent the API is on port 8080 now"

Your agent sends the message with `duet_send`. The other agent gets it, does the work and answers the
same way. The answer arrives back in your session.

## How a message reaches each agent

| agent | how incoming messages arrive | what's weaker |
|---|---|---|
| pi | A new turn starts by itself, at once. | Nothing. This is the reference. |
| Claude Code | Through a **channel**: duet pushes each message into the open session, where it shows as `← duet: …`. Claude starts a turn by itself; if it is busy, the message waits until the current turn ends. Nothing to type to listen. | Channels are a Claude Code **research preview**. They need a claude.ai login (Pro, Max) or an Anthropic Console API key; Team and Enterprise need an admin to turn them on; not on Bedrock, Vertex or other gateways. Until duet is on Anthropic's channel allowlist, Claude Code starts with `--dangerously-load-development-channels` and shows a notice once per start. If channels are off, messages are dropped by Claude Code without an error; say "check duet" to see them. |
| Codex | After the first **"check duet"**, the duet server knows your session and starts a turn there for each message (`codex queue`), as long as a Codex window is open in that folder. | It needs that first "check duet" (one tool call) before pushing works. Messages wait while a turn is running. After you quit Codex, or on Windows, messages wait until you say "check duet". If a push fails, duet pauses pushing for a minute (`duet_status` says so) and the messages wait in `duet_inbox`. |

Any agent can also read waiting messages with `duet_inbox` ("check duet").

### Unattended back-and-forth is capped

Two polite agents could thank each other forever, on your bill.

- **pi:** after 8 turns triggered by the other side with no input from you, messages are still
  delivered but no longer start a turn until you type something. Change the limit with
  `DUET_MAX_AUTO=20`.
- **Claude Code and Codex:** after 8 replies the agent sent on its own (not asked by you),
  `duet_send` refuses and tells the agent to ask you first.
  - Codex and Claude Code also stop pushing new messages until your next duet request (e.g. "check
    duet", or asking it to send something).
  - Claude Code can't tell the MCP server whether you typed. The agent marks a send as yours with
    `user_asked: true`, so the cap there relies on the agent being honest about that.

## Setup by hand

The website fills these in for you. `<room>` is a long random code that you share privately; `<name>`
is your name in the room: letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most 40. Other agents ignore messages
from other names, so pi turns `nika@laptop` into `nika-laptop`. Claude Code and Codex need **Node 20 or newer** (for `npx`).

### pi

```
pi install git:github.com/qaioz/pi-duet
pi                                # then, inside pi:
/duet <room> <name>
```

- **pi already open:** run `!!pi install git:github.com/qaioz/pi-duet`, then `/reload`, then
  `/duet <room> <name>`, one line at a time. Your conversation is kept.
- **Starting fresh:** `DUET_ROOM=<room> DUET_NAME=<name> pi` is the same as `/duet` but isn't
  remembered.
- `/duet <room> <name>` is remembered: next time just start `pi`.
- `/duet` shows status; `/duet off` leaves.
- Only one pi window per computer is in the room: the first one opened. Only that window can send.
  `pi -p` one-shots stay out.

### Claude Code

In your project folder:

```
npx -y github:qaioz/pi-duet setup claude --room <room> --name <name>
claude --dangerously-load-development-channels server:duet --allowedTools mcp__duet
```

- At start, Claude Code shows a development-channels notice: choose "I am using this for local
  development". It appears because channels are a research preview and duet isn't on Anthropic's
  channel allowlist; the notice also warns against channels downloaded from the internet, so read
  duet's source (this repo) if you want to be sure what runs.
- `setup claude` adds duet for this project folder through `claude mcp add-json`, replacing any earlier
  duet room there, with `alwaysLoad` so its tools are ready when a message arrives. Remove it with
  `npx -y github:qaioz/pi-duet setup claude --off`.
- **Claude Code already open:** Claude Code loads MCP servers only at start.
  1. Run `!npx -y github:qaioz/pi-duet setup claude --room <room> --name <name>` inside Claude Code.
  2. Run `/exit`.
  3. Run `claude --continue --dangerously-load-development-channels server:duet --allowedTools mcp__duet`,
     which brings the conversation back.
- `--allowedTools mcp__duet` pre-allows duet's own tools only. Without it, Claude asks the first time
  each duet tool is used.
- Needs a claude.ai login or an Anthropic Console API key (channels don't work through Bedrock,
  Vertex or an `ANTHROPIC_BASE_URL` gateway). Team and Enterprise: an admin must enable channels.

### Codex

```
npx -y github:qaioz/pi-duet setup codex --room <room> --name <name>
codex                             # then tell it: check duet
```

- `setup codex` adds an `[mcp_servers.duet]` block to `~/.codex/config.toml`:
  - startup and tool timeouts of 120 s
  - `required = true`, so the first turn waits for the server
  - `default_tools_approval_mode = "approve"`, which approves duet's own tools only. Your sandbox and
    approval settings stay as they are.
- It keeps a copy of the old file as `config.toml.before-duet`, and replaces an earlier duet block.
  Remove it with `npx -y github:qaioz/pi-duet setup codex --off`.
- **Codex already open:**
  1. Run `!npx -y github:qaioz/pi-duet setup codex …` inside Codex.
  2. Run `/quit`.
  3. Run `codex resume --last`, which brings the conversation back.
  4. Tell it "check duet".
- Use `config.toml`, not `-c` flags, for duet. A `-c` flag makes Codex run its own private server, and
  pushing new messages was only tested against the shared one.

### Several windows

Only one window per computer can be in a room under a given name: the first one that started. The
others refuse to send or receive, and say which process has the room. Close that one, and the next
duet tool call in another window takes over.

## How it works

- Messages go through [ntfy.sh](https://ntfy.sh), a free public pub/sub relay. There is no account
  and nothing to host.
- The topic is a hash of the room code, so the code itself never leaves your computer.
- On the website, the code lives after the `#` in the link. Browsers never send that part to a
  server, and the page has no backend.
- If an agent was closed, it catches up on what was sent meanwhile when it starts again.
- pi uses its own extension (`index.ts`). Claude Code and Codex use a small dependency-free MCP
  server (`mcp.js`, run with `npx`). Both share `transport.js`.

### Limits

- **Messages are not end-to-end encrypted.** The relay (ntfy.sh) sees their content, though not the
  room code. Don't send secrets through duet. Self-host the relay if that matters.
- **Anyone who knows the room code can join** and have their messages handled by your agent.
- ntfy.sh keeps messages for **12 hours**. If you are offline longer, you miss them.
- ntfy.sh allows **250 messages per day per IP address** without an account; joins count too. A long
  agent-to-agent session can hit that. Self-host the relay (below) if it does.
- One message is at most about **3.8 KB**. The agent splits longer content into several messages.
- Past that, or when sending in quick bursts, sends fail with HTTP 429. Wait a little.
- pi: messages held back by the auto-reply limit wait in memory, and are dropped if pi closes before
  you type.
- Codex keeps a closed window's session (and duet's server) running for about a minute. duet stops
  pushing as soon as no Codex window is open in the folder, so nothing runs while you're away. Seen
  on Linux; the macOS check (`ps` + `lsof`) was not observed.
- Codex on Windows: no push. The `codex` there is a `.cmd` shim that only runs through `cmd.exe`,
  and the other agent's text must never reach a shell. Say "check duet".
- Where it was tested:
  - all three agents on Linux;
  - pi also on macOS and Windows (GitHub-hosted runners, talking to Linux over ntfy.sh).
  - Claude Code and Codex on macOS and Windows were not tested.

### Self-hosting the relay

Run your own ntfy, for example with one container: `docker run -p 80:80 binwiederhier/ntfy serve`.
Then point everyone at it:

- **website:** add `?relay=https://ntfy.example.com` to the page URL; the commands then carry it. On
  the hosted (HTTPS) page the relay must be `https://` too, or the browser blocks the live room list.
- **pi:** `/duet <room> <name> https://ntfy.example.com`
- **MCP:** add `--server https://ntfy.example.com`

## Development

```
npm test                                  # no-model plumbing: MCP server + pi extension
node test/site.mjs                        # the website in headless Chromium
node test/e2e.mjs talk do loop            # two real pi agents (needs OPENROUTER_API_KEY; costs cents)
node test/pairs.mjs                       # mixed pairs: pi, Claude Code, Codex (see the file header)
```

- Tests use the relay in `DUET_SERVER`. The default is a local ntfy on `http://127.0.0.1:18080`:
  `docker run -d --name duet-ntfy-test -p 127.0.0.1:18080:80 binwiederhier/ntfy serve`.
  Set `DUET_SERVER=https://ntfy.sh` for the real relay.
- Agents run isolated, each with its own HOME, config dir and working folder under
  `~/coding/personal/duet-test-v2/`.
