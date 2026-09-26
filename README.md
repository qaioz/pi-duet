# pi-duet

Two people, two computers, two [pi](https://github.com/badlogic/pi-mono) coding agents — one room.
Your agent sends a message; it lands in your friend's pi session as a new turn; their agent does the
work with its normal tools (edits files, runs commands) and replies.

There is **no permission prompt** for what the other agent asks yours to do. Only share a room with
someone you trust with your machine.

## Setup (both of you)

```
npm i -g @mariozechner/pi-coding-agent
pi install git:github.com/qaioz/pi-duet
cd <some folder> && pi
```

Then, inside pi, both run the same room name with your own name:

```
/duet <room> <name>
```

For example `/duet <long-random-words> alice` on one computer and `/duet <long-random-words> bob` on
the other. The room name is the shared password: make up something long and unguessable (not an
example from this page), and send it to your friend privately.

pi remembers the room, so next time just start `pi` and you are back in. Only one pi window per
computer is in the room at a time: the first one opened. If you close it, run `/duet <room> <name>`
in another window to move the room there. Only that window can send; `pi -p` one-shots can neither
join nor send.

> This repo is private for now: you need to be added as a collaborator, and `git` must be able to
> read GitHub (e.g. `gh auth login`, or a credential helper) for `pi install` to clone it.

### Model login

Each of you brings your own model key. Example with OpenRouter and DeepSeek (cheap, works well):

```
export OPENROUTER_API_KEY=sk-or-...        # or run /login inside pi and pick OpenRouter
pi --provider openrouter --model deepseek/deepseek-v4-flash
```

To make it the default, put this in `~/.pi/agent/settings.json`:

```json
{ "defaultProvider": "openrouter", "defaultModel": "deepseek/deepseek-v4-flash" }
```

In testing, `deepseek/deepseek-v4-flash` was reliable. `deepseek/deepseek-chat` sometimes dropped a
tool call or invented command output, so avoid it here.

## Using it

Just talk to your own agent:

- "ask bob what he thinks of this plan"
- "ask bob's agent to run the tests in his checkout and send me the failures"
- "tell alice's agent the API is on port 8080 now"

The message is fire-and-forget; the reply shows up later as a `[duet] from <name>` message and your
agent picks it up from there.

Commands:

| | |
|---|---|
| `/duet` | status: room, name, connected?, peers seen |
| `/duet <room> <name> [server]` | join (and remember) a room |
| `/duet off` | leave and forget the room (from the window that is in it) |

The footer shows `duet: <name>` while connected.

### Auto-reply limit

Two polite agents can thank each other forever, on your bill. After **8** turns triggered by the
other side with no input from you, incoming messages are still delivered but no longer start a turn;
you get a warning and they are picked up the next time you type anything. Change the limit with
`DUET_MAX_AUTO=20 pi`.

## How it works

Messages go through [ntfy.sh](https://ntfy.sh), a free public pub/sub relay — no account, nothing to
host. The topic is a hash of the room name, so the room name itself never leaves your computer.
If pi was closed, it catches up on what was sent meanwhile when it starts again.

### Limits

- **Anyone who knows the room name can join** and have their messages run as turns on your agent.
- ntfy.sh keeps messages for **12 hours**: longer offline and you miss them.
- ntfy.sh allows **250 messages per day per IP address** without an account (joins count too). A
  long agent-to-agent session can hit that; self-host (below) if it does.
- One message is at most about **3.8 KB**; the agent splits longer content into several messages.
- Past that, or when sending in quick bursts, sends fail with HTTP 429: wait a little.
- Messages held back by the auto-reply limit wait in memory; closing pi before you type drops them.

### Self-hosting the relay

Run your own ntfy (one container: `docker run -p 80:80 binwiederhier/ntfy serve`) and point both
sides at it, with `DUET_SERVER=https://ntfy.example.com pi` or `/duet <room> <name> https://ntfy.example.com`.

## Development

```
npm test                              # no-model plumbing tests against real ntfy.sh
node test/e2e.mjs talk do loop        # two real agents (needs OPENROUTER_API_KEY; costs cents)
node test/e2e.mjs install             # install from GitHub into a throwaway agent dir
```

`PI=/path/to/pi` picks the pi binary; tests run in `~/coding/personal/duet-test` (`DUET_TEST_DIR`).
