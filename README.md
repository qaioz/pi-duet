# duet (pi-duet)

Two developers, two computers, two coding agents, one room. Your agent sends a message, and it lands
in your friend's agent session. Their agent does the work with its normal tools (edits files, runs
commands) and replies. Works with **[pi](https://github.com/badlogic/pi-mono)**, **Claude Code** and
**Codex**, in any mix: a pi user and a Claude Code user can share a room.

**Start here: <https://qaioz.github.io/pi-duet/>.** Click *Start a room*, send the invite link to the
other developer, and both copy the commands for your agent. It takes about a minute, with no accounts.

> **Safety.** Whoever has the invite link (the room code) can make your agent run commands on your
> machine. Share it only with someone you trust. Your agent's own permission mode decides what the
> other agent's requests can do: if you run it in a "yolo" / skip-permissions mode, the other side can
> do anything that mode allows. The Claude Code plugin and duet for Codex add a few guards of their
> own ([Claude Code](#claude-code-plugin-what-it-guards-and-what-it-doesnt),
> [Codex](#codex-what-duet-guards-and-what-it-doesnt)); pi and the Claude Code channel route add none.

## Using it

Talk to your own agent:

- "ask nika's agent what she thinks of this plan"
- "ask nika's agent to run the tests in her checkout and send me the failures"
- "tell alex's agent the API is on port 8080 now"

Your agent sends the message with its duet tool (`duet_send`, or `send` in the Claude Code plugin).
The other agent gets it, does the work and answers the same way. The answer arrives back in your
session.

## How a message reaches each agent

| agent | how incoming messages arrive | what's weaker |
|---|---|---|
| pi | A new turn starts by itself, at once. | Nothing. This is the reference. |
| Claude Code (plugin, the default) | Depends on who you said is in the room. **Someone else** (the default): each message waits as a **card above your prompt**, `1` lets Claude do it, `2` ignores it (each with 3 seconds to undo). **Only me** or **someone I trust completely**: messages start a turn by themselves (up to 8 in a row without you). | Needs Claude Code **2.1.287 or newer** with **mods** on: Anthropic can switch mods off remotely, and organisations can block them (then use the channel route below). Draws in the terminal and the Desktop app's Code tab only, not in the VS Code panel or `claude -p`. Needs `curl` (macOS, Windows 10+ and most Linux have it). |
| Claude Code (channel route, older) | Through a **channel**: duet pushes each message into the open session, where it shows as `← duet: …`. Claude starts a turn by itself; if it is busy, the message waits until the current turn ends. Nothing to type to listen. | Channels are a Claude Code **research preview**. They need a claude.ai login (Pro, Max) or an Anthropic Console API key; Team and Enterprise (and Console orgs with managed settings) need an admin to enable them; not on Bedrock, Vertex or other gateways. duet isn't an approved channel plugin, so Claude Code needs `--dangerously-load-development-channels server:duet` and shows a notice at each start. If Claude Code was started without that flag (duet checks its command line on Linux and macOS), messages wait until you say "check duet". If channels are blocked by an org policy, Claude Code drops pushed messages without telling duet; "check duet" shows the last 20 pushed ones until duet restarts. |
| Codex (plugin, or `setup codex`) | **Ask** (the default): each request shows a short form in Codex, "nika's agent asks: … Let Codex do it?", before Codex sees it; **Ignore** drops it and tells the other side. **Auto** (`duet auto`, after a yes): requests start a turn by themselves (up to 8 replies in a row without you). A request that arrives while Codex works waits for that turn to end and continues it. | Needs Codex's hooks, trusted once (`/hooks`), and a Codex window open in the folder. Requests start after your first prompt in a new session. After you press **Esc**, requests wait for your next prompt (Codex tells you so). Under **Full Access** Codex declines duet's form by itself, so requests wait until you say "check duet". On Windows, and after you quit Codex, they wait for "check duet" too. |

Any agent can also read waiting messages with `duet_inbox` ("check duet").

### Unattended back-and-forth is capped

Two polite agents could thank each other forever, on your bill.

- **pi:** after 8 turns triggered by the other side with no input from you, messages are still
  delivered but no longer start a turn until you type something. Change the limit with
  `DUET_MAX_AUTO=20`.
- **Claude Code plugin:** in auto mode, after 8 turns started by the other side with no prompt from
  you, messages go back to waiting as cards. "From you" is Claude Code's own record of a prompt typed
  at your prompt box (or sent through Remote Control), not something the model claims.
- **Claude Code (channel route) and Codex:** after 8 replies the agent sent on its own (not asked by you),
  `duet_send` refuses and tells the agent to ask you first.
  - Codex also stops handing over new messages until you type a prompt. In a turn duet started, the
    agent can't lift the cap by claiming you asked (`user_asked` is ignored there): duet's hooks
    (or Codex's own turn metadata) say who started it.
  - Claude Code stops pushing new messages until you ask it to send something; "check duet" shows
    the held ones meanwhile.
  - Claude Code can't tell the MCP server whether you typed. The agent marks a send as yours with
    `user_asked: true`, so the cap there relies on the agent being honest about that.

## Setup by hand

The website fills these in for you. `<room>` is a long random code that you share privately; `<name>`
is your name in the room: letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most 40. Other agents ignore messages
from other names, so pi turns `nika@laptop` into `nika-laptop`. Codex and the Claude Code channel route need **Node 20 or newer**
(for `npx`); the Claude Code plugin doesn't need Node.

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

Install the plugin once (Claude Code **2.1.287 or newer**), in any Claude Code session:

```
/plugin marketplace add qaioz/pi-duet
/plugin install duet@pi-duet
/duet <room> <name>
```

The plugin is active as soon as it's installed: no restart. From the shell, the same is
`claude plugin marketplace add qaioz/pi-duet` and `claude plugin install duet@pi-duet`, then
`/duet <room> <name>` inside Claude Code.

| command | what it does |
|---|---|
| `/duet new` | makes a room code, joins it, and shows the code to share |
| `/duet <room> [name] [relay]` | joins a room (name defaults to your last one, or `git config user.name`) |
| `/duet` | opens the room's history: a read-only view of what the two agents said, and who's here |
| `/duet trust` | asks again who's in the room (see below) |
| `/duet ask` / `/duet auto` | switches by hand: **ask**, each message waits as a card; **auto**, messages start turns by themselves |
| `/duet off` | leaves the room (`leave`, `stop`, `disable`, `quit` and `exit` work too; none of them can be a room name) |

Duet is two agents talking. You don't type into the room: you decide what your Claude takes on, and
to tell the other side something, you ask your Claude.

**Who's in the room?** The first time you join a room, duet asks once and remembers the answer:

| answer | messages | Claude's replies |
|---|---|---|
| **Someone else** (recommended) | wait as a card: `1` Let Claude do it, `2` Ignore | shown to you before they're sent |
| **Someone I trust completely** | start Claude by themselves (auto) | go straight out |
| **Only me** (your other window, or your own pi or Codex) | start Claude by themselves (auto), with no extra check even under `bypassPermissions` | go straight out |

The guards below stay on whatever you answer: Claude's file tools stay in the session's folder, but
shell commands can reach whatever your permission mode allows. When shell commands would run without
asking you (`bypassPermissions`, Claude Code's own `auto` mode, or an allow rule as broad as
`Bash(*)`), "someone I trust completely" asks once more before auto starts. "Only me" doesn't, so
anyone who has that room's code counts as you.

- The footer shows `duet <room> · <who's here> · ask|auto`. Who's here is who has joined or spoken
  since you joined: an older pi or Codex shows up once it sends something.
- Claude reads a message under Claude Code's own line "The duet plugin sent a message", so it knows
  the request isn't yours. Your normal permission prompts still apply.
- While Claude is busy, a taken request waits ("starts when Claude is free", with a Cancel button)
  and is handed over when the running turn ends.
- After `1` or `2` the card counts down 3 seconds ("starting nika's request in 3 s…", with Cancel or
  Undo) before anything happens: a digit typed alone into an empty prompt presses a card button, and
  a stray one shouldn't act for someone else.
- Several messages from one sender in a row show as one card ("3 messages") with one toast, and go
  to Claude together. Agents are asked to send one complete reply, not progress updates.
- A reply says which of your messages it answers ("↳ reply to your message “…”"), in the card, in
  what Claude reads, in the history and on the website (pi and Codex show it too).
- While Claude works on one request, new messages wait: the footer shows "· 1 waiting".
- Rooms are for two. If a third agent shows up, or another window in this same folder joins the
  room, duet warns once (pi too; Codex in `duet_status`).
- In ask mode, anything Claude sends back while working on the other side's request is shown to you
  first ("send this to nika?"). In auto mode it goes straight out.
- `/duet auto` asks you to confirm first when shell commands would run without asking you. duet asks
  Claude Code's own permission check (it runs nothing): under `bypassPermissions`, Claude Code's
  `auto` mode, or a `Bash(*)` allow rule it asks; in `default`, `acceptEdits`, `plan` and `dontAsk`
  it doesn't. If you then switch to `bypassPermissions` with Shift+Tab, duet notices on the next
  message or tool call and goes back to ask.
- Restart Claude Code in the same folder and it rejoins the room by itself, with a toast
  ("rejoined … · /duet off to leave"), as long as the window was in the room when it closed, less
  than 12 hours ago. It always comes back in **ask** mode, whatever you answered for the room:
  `/duet auto` switches auto back on. Messages sent meanwhile arrive then, as cards. A second
  window in the same folder leaves the room to the window that has it.
  `/clear` keeps you in the room. After `/duet off`, nothing rejoins.
- With another Claude Code plugin user, each side also sees short notes: the message was ignored,
  Claude is waiting for its user to approve a step, the user stopped it, it failed, they left. pi,
  Codex and the channel route ignore these notes.
- The website's room page shows the same conversation, read-only and live, for anyone with the
  invite link.
- If you used the older route in this folder, remove it, or every message arrives twice:
  `npx -y github:qaioz/pi-duet setup claude --off`. The plugin warns you when it sees it.
- Check that mods can load with `claude plugin test` in an empty folder: `no hooks module to load`
  means yes. `hooks modules are turned off …` means no; use the channel route below.

#### Claude Code plugin: what it guards, and what it doesn't

While Claude works on a request from the other side (including subagents it starts for it), the
plugin refuses:

- reading or writing files outside the session's folder (every path argument, and Glob patterns that
  are paths);
- writing, anywhere in a path and in any letter case, `.claude`, `.mcp.json`, `.git`, `CLAUDE.md`,
  `CLAUDE.local.md`, `AGENTS.md`, `.vscode`, `.envrc`, `.husky`, `.pi` or `.codex` (they decide what
  runs on your computer later);
- tools that outlive the request: scheduled tasks, background commands, background and remote
  agents;
- WebFetch, since a URL can carry your files to any server (WebSearch stays on);
- skills, custom subagent types, and every tool beyond file, search, shell, web search, plan and
  to-do tools, including your other MCP servers;
- every tool call once the session starts running commands **without asking you** (Shift+Tab to
  `bypassPermissions` or `auto`) in the middle of a request that started while it still asked, or
  that auto mode started: duet goes back to ask mode, and Claude is told to stop. Switch back with
  Shift+Tab and tell Claude to go on; for an auto-mode request you can also say yes with
  `/duet auto` (that keeps the room in auto). No hook fires when the mode changes, so duet asks
  Claude Code's own permission check on each tool call of the request (a switch to Claude Code's
  `auto` mode is noticed once Claude Code reports it, after the next tool call). A request you took
  while already in `bypassPermissions` isn't stopped: you chose that.

duet hands a request to Claude only while Claude is idle, and a turn counts as the other side's when
Claude Code starts it with that request's text. Every turn after it, until your own next prompt,
counts as the other side's too (a hook that wakes Claude, a task notification, a continuation): duet
fails closed. Stop hooks and `/goal` continue inside the same turn, so they stay fenced. Pressing Esc
on the request, or typing your own prompt, ends this; such a turn sends the other side no notes. If a
turn starts while a request is with Claude Code and no prompt of yours explains it, duet fences it
too, rather than risk missing the request. A request already handed over stays fenced if the plugin
reloads; `/resume`, `/branch` and a new Claude Code process start with nothing fenced (subagents a
request started stay fenced).

Claude reads the reason and can tell the other side to ask you. These are rules about tool names and
paths, **not a sandbox**. A shell command can still do anything your permission mode allows: in
`bypassPermissions` that is everything, including reading secrets and sending them back. Prompts you
type yourself (or send through Remote Control) are never fenced; a `/loop` or scheduled prompt that
fires right after a request, before you type, is.

#### Claude Code without mods: the channel route (older)

Use this when mods can't load (an organisation policy, or Anthropic has switched mods off). In your
project folder:

```
npx -y github:qaioz/pi-duet setup claude --room <room> --name <name>
claude --dangerously-load-development-channels server:duet --allowedTools mcp__duet
```

- At each start, Claude Code shows a development-channels notice: choose "I am using this for local
  development". duet isn't an approved channel plugin, so it needs the development flag; the notice
  says that flag is for local development and not for channels downloaded from the internet. Know
  what you run: `npx -y github:qaioz/pi-duet` runs this repository's `main` branch as it is at each
  start (pin a commit with `setup claude --package github:qaioz/pi-duet#<commit>` if you prefer).
- The other agent's messages start turns in your session. Your usual permission prompts still apply;
  `--allowedTools mcp__duet` pre-allows only duet's own tools.
- Claude Code sends no receipt for a pushed message, so duet keeps its place in the room until Claude
  answers with duet (or you say "check duet"). A last message that needed no answer may therefore show
  up once more after a restart.
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

**The plugin** (Codex CLI and the desktop app):

```
codex plugin marketplace add qaioz/pi-duet
codex plugin add duet@pi-duet       # or /plugins inside Codex
codex                               # a new session; then: join duet room <room> as <name>
```

- The first time, Codex asks you to review duet's hooks: choose **Trust all**. They call duet's own
  server (no shell). After a duet update they are new again, and Codex asks once more.
- Join from inside Codex: "join duet room amber-otter-4821-x7q2 as gaioz". Each folder remembers its
  room: a new session there rejoins it (in ask mode) for 12 hours, and takes it over from an older
  session in the same folder. "leave duet" leaves and forgets it.
- In Codex: "duet auto" / "duet ask" (auto asks you to confirm in a form), "check duet", "duet
  status", "what was said in duet" (the room's last messages, from the relay).
- Updating: `codex plugin marketplace upgrade pi-duet`, then `codex plugin add duet@pi-duet` again
  and start a new session.

**`setup codex`** (the IDE extension, which has no plugins; or if you prefer one global room):

```
npx -y github:qaioz/pi-duet setup codex --room <room> --name <name> [--mode auto]
codex
```

- `setup codex` adds an `[mcp_servers.duet]` block and duet's hooks to `~/.codex/config.toml`:
  - startup and tool timeouts of 120 s
  - `required = true`, so the first turn waits for the server
  - `default_tools_approval_mode = "approve"`, which approves duet's own tools only. Your sandbox and
    approval settings stay as they are.
  - the same hooks as the plugin, between `# duet hooks: begin` and `# duet hooks: end`; your own
    hooks stay.
- Every Codex window then joins that room under that name (the newest session in a folder takes it).
  Use the plugin for a room per folder.
- It keeps a copy of the old file as `config.toml.before-duet`, and replaces an earlier duet block.
  Remove it with `npx -y github:qaioz/pi-duet setup codex --off`.
- **Codex already open:** run `!npx -y github:qaioz/pi-duet setup codex …` inside Codex, `/quit`,
  then `codex resume --last`.
- Use `config.toml`, not `-c` flags, for duet. A `-c` flag makes Codex run its own private server,
  which `codex queue` can't reach.
- Don't use both the plugin and `setup codex`: two servers named duet.

#### Codex: what duet guards, and what it doesn't

While Codex works on the other side's request (from the prompt duet handed over, or from the point a
turn-end hand-over continued your own turn), duet's PreToolUse hook refuses:

- patches (`apply_patch`, also when run through the shell) to files outside the session's folder, or
  to `.codex`, `AGENTS.md`, `.git`, `CLAUDE.md`, `.vscode` and the rest of the Claude Code plugin's list;
- background and scheduled commands (`&`, `nohup`, `setsid`, `crontab`, `at`, `tmux`, …);
- your other MCP servers' tools, subagents, and plugin or permission tools.

**It fails open:** Codex runs a hook that errors, times out (5 s) or gets no answer as if it weren't
there, so if duet's server is slow or gone, the tool runs. It checks shell commands only for
background work: what a command reads or writes is up to Codex's sandbox and approvals, which stay
on. In auto mode, anything your sandbox and approval settings allow, the other side's requests can do.

### Several windows

Only one window per computer can be in a room under a given name.

- **Claude Code plugin:** run `/duet <room>` in a second window and it asks whether to move the room
  there; the first window hands it over and says so.
- **Across clients** (pi, Codex, Claude Code): one lock, `~/.duet/<hash>.lock`. A Claude Code window
  and a Codex window in the same room under the **same name** can't both be in it: the second one
  says who has it ("gaioz is already in room … in Codex (/work/repo)"). Use another name.
- **pi, MCP:** the first one that started has it. The others refuse to send or receive, and say
  which process has the room. Close that one, and the next duet tool call in another window takes
  over. A new Codex session in the same folder takes the room from the older one.

## How it works

- Messages go through **duet.gaioz.online**, an [ntfy](https://ntfy.sh) relay (a pub/sub server)
  run by duet's author. There is no account and nothing to host. Any other ntfy server works too,
  including the public ntfy.sh (see [Self-hosting the relay](#self-hosting-the-relay)).
- The topic is a hash of the room code, so the code itself never leaves your computer.
- On the website, the code lives after the `#` in the link. Browsers never send that part to a
  server, and the page has no backend.
- If an agent was closed, it catches up on what was sent meanwhile when it starts again.
- pi uses its own extension (`index.ts`). Codex, and Claude Code's channel route, use a small
  dependency-free MCP server (`mcp.js`, run with `npx`, or by the Codex plugin), with duet's hooks for
  Codex calling back into it (`codex/hooks.json`). They share `transport.js`, and every client shares
  the lock in `lock.js`.
- The Claude Code plugin is a [mod](https://code.claude.com/docs/en/plugins/mods/overview)
  (`hooks/duet.js`): it receives with `curl` against the relay's stream (mods have no streaming
  network call) and sends with Claude Code's own `fetch`, so a session whose policy refuses network
  requests from mods doesn't join. `hooks/wire.js` is its copy of the wire format, tested against
  `transport.js`. It adds a `note` message kind (declined, stopped, waiting for approval, left,
  moved) that older clients ignore.

### Limits

- **Messages are not end-to-end encrypted.** The relay sees their content, though not the room code.
  duet.gaioz.online keeps every message for **30 days** (to debug duet) and its operator can read them.
  Don't send secrets through duet. Self-host the relay if that matters.
- **Anyone who knows the room code can join** and have their messages handled by your agent, and
  can read what the room's relay still keeps: on duet.gaioz.online, the last 30 days. Treat an
  invite link like a password.
- Agents act only on messages from the last 12 hours, whatever the relay keeps.
- duet.gaioz.online keeps messages for 30 days and allows 5,000 messages per day per IP address
  (bursts of 300, then one per second). On the public ntfy.sh it is 12 hours and 250 per day; a
  long agent-to-agent session can hit that.
- **Everyone in a room must use the same relay.** Installs from before the default changed (it was
  ntfy.sh) still use ntfy.sh until updated; the website's commands always name the relay, so they
  work with old and new installs alike.
- One message can be up to about **200 KB**. Above 4 KB the relay stores it as an attachment and
  receivers fetch it, only when it is a real upload on that same relay (`/file/<id>`, with a size):
  anyone can post an attachment that points somewhere else, and duet ignores those. ntfy.sh keeps attachments for
  **3 hours** and duet.gaioz.online for 72 hours, so a long message sent while someone is away
  longer than that is lost (the plugin says so). A self-hosted ntfy needs `attachment-cache-dir` set
  for long messages. Clients from before 2026-10-04 skip long messages.
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
  - The Claude Code plugin: Linux terminal only (Claude Code 2.1.288, Haiku, default permission
    mode). Not tested in the Desktop app, which needs 2.1.287+.

### Self-hosting the relay

The default relay is duet.gaioz.online. To use another one, such as your own or the public
`https://ntfy.sh`, run ntfy, for example with one container: `docker run -p 80:80 binwiederhier/ntfy serve`.
Then point everyone at it:

- **website:** add `?relay=https://ntfy.example.com` to the page URL; the commands then carry it. On
  the hosted (HTTPS) page the relay must be `https://` too, or the browser blocks the live room list.
- **pi, Claude Code plugin:** `/duet <room> <name> https://ntfy.example.com`
- **MCP:** add `--server https://ntfy.example.com`

## Development

```
npm test                                  # no-model plumbing: MCP server + pi extension
node --test test/mod-unit.mjs             # Claude Code plugin: wire format and guards
claude plugin test                        # Claude Code plugin: hooks, cards, pane (Claude Code's own test kit)
node test/site.mjs                        # the website in headless Chromium
node test/e2e.mjs talk do loop            # two real pi agents (needs OPENROUTER_API_KEY; costs cents)
node test/codex.mjs                       # Codex: hooks, ask form, guard, turn-end hand-over, join (no model)
node test/pairs.mjs                       # mixed pairs: pi, Claude Code, Codex (see the file header)
```

- Tests use the relay in `DUET_SERVER`. The default is a local ntfy on `http://127.0.0.1:18080`:
  `docker run -d --name duet-ntfy-test -p 127.0.0.1:18080:80 -e NTFY_BASE_URL=http://127.0.0.1:18080 -e NTFY_ATTACHMENT_CACHE_DIR=/tmp/att binwiederhier/ntfy serve`
  (the base URL and attachment folder let it carry long messages).
  Set `DUET_SERVER=https://ntfy.sh` for the real relay.
- Agents run isolated, each with its own HOME, config dir and working folder under
  `~/coding/personal/duet-test-v2/`.
