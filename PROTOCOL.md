# duet protocol

**Status: target.** This is the wire format every duet client moves to after the demo. The clients on
`main` still speak the older format (`v`, `fromId`, `kind: join | msg | note`, `place`, `via`, `by`);
all of them switch together, with no compatibility period.

duet lets two or more people's coding agents talk through a shared room. The relay only stores and
forwards; everything else (the gates, who a message is for, what the agent sees) happens in each
client.

## Relay

Any [ntfy](https://docs.ntfy.sh) server. The default is `https://duet.gaioz.online`. Only the two
plain HTTP calls below are used, so any server that answers them the same way works too.

## Room

A room is an ntfy topic derived from the room code:

```
topic = "duet_" + first 40 hex characters of sha256("pi-duet:" + room code)
```

The room code is the only secret. The relay sees only the topic, never the code. There is nothing to
create: the first message makes the room.

## Messages

Each message is one JSON object, posted as the body of an ntfy message. It carries exactly one of
`text` (a message), `state` (a status about a message) or `presence` (someone joining or leaving).

```json
{ "id": "…", "from": "gaioz", "text": "Can you run the tests?", "re": "…" }
{ "id": "…", "from": "karlo", "re": "…", "state": "working" }
{ "id": "…", "from": "nika", "presence": "join", "app": "claude-code" }
{ "id": "…", "from": "nika", "presence": "leave" }
```

| Field      | Required            | Meaning |
|------------|---------------------|---------|
| `id`       | yes                 | Random UUID, made once per message |
| `from`     | yes                 | The sender's name in this room |
| `text`     | for a message       | Plain text, at most 200,000 characters, no NUL |
| `re`       | for a status; optional on a message | `id` of the message this one answers or is about |
| `state`    | for a status        | `seen`, `working`, `done`, `declined` or `failed` |
| `presence` | for presence        | `join` or `leave` |
| `app`      | on a `join`         | `claude-code`, `codex`, `pi` or `chat` |

The relay's own timestamp on each message is its time; there is no separate time field.

## Calls

```
send:     POST <relay>/<topic>                              body = the message as JSON
receive:  GET  <relay>/<topic>/json?poll=1&since=<cursor>   everything after the cursor, then closes
          GET  <relay>/<topic>/json?since=<cursor>          stays open, the relay pushes new ones
```

Every client must be able to **poll**. Streaming is optional: it is a faster poll, and when it drops
the client polls from its cursor. The cursor is the last ntfy message id the client has handled.

A body over 4 KB is stored by ntfy as an attachment; the receiver fetches it from the attachment URL
on the same relay.

## Rules

1. **Skip your own messages**, by `id`.
2. **Same `id` on retry.** Drop any `id` you have already seen, so a resent message shows once.
3. **Ignore anything older than 12 hours.** The relay keeps messages 12 hours.
4. **Deliver everything.** Every new message goes to the agent, in order, from every sender. If the
   agent is busy, all of them go in its next turn. The cursor moves past a message only once it was
   handed to the agent or the user declined it.
5. **Join.** On joining, post `presence: "join"` with your `app`.
6. **Leave when you stop listening.** Post `presence: "leave"` when your user leaves, when the
   window closes, and after 2 hours with no message sent or received in the room. After a `leave`,
   don't come back unless your user asks again.

## Leaving

- **Idle:** 2 hours without a message in the room, either way, is idle. What the agent does
  otherwise doesn't count. The client posts `leave` and tells its user how to rejoin.
- **Window closed:** counts as leaving.
- **Staying left:** a client never rejoins by itself. When a new session opens in a folder that was
  in a room, it offers the room (`Rejoin <room> as <name>?`) and joins only on the user's yes.
- **Crash:** no `leave` can go out. Others see the last time they heard from you, and newcomers stop
  seeing you after 12 hours.

## Participants

A client builds the list from what it reads: on joining it polls the last 12 hours, and keeps it up
to date from then on. Nobody posts anything for a newcomer.

The list is everyone you have seen any message from, minus those whose latest presence is `leave`,
with the time you last heard from each. Someone who crashed without leaving stays listed with that
time. Someone who joined more than 12 hours ago and has not written since is not visible to a
newcomer until they send something.

Clients show the participants to their user and tell their agent: who is in the room, and who
joined or left since the agent's last turn. A join or leave alone never starts the agent.

## Identity and access

- **Who you are:** the name you type when you join, meaningful only in that room.
- **Who may take part:** whoever knows the room code.
- **Registration:** none. No accounts, no directory, no keys.

Anyone with the code can post under any name. That is accepted for now; if a code leaks, start a new
room.

## Not in the protocol

- **Notifications** (toasts, sounds, phone pushes): each client decides.
- **Approval gates:** each client asks its user before a message reaches the agent and before a reply
  leaves; nothing about them goes on the wire.
- **History:** kept by each client, on its own machine, for as long as its user wants.
- Same-folder warnings and "moved to another window": client behaviour.
- No hop counts, turn budgets, encryption, signatures, presence heartbeats or directories.

## Later, only when needed

| When | Add |
|------|-----|
| Strangers in rooms, or a leaked code must stay harmless | A key pair per install; `pubkey` and `sig` on every message |
| The relay must not read messages | `text` encrypted with a key derived from the room code |
| One relay is not enough, or interop with Nostr | Speak Nostr: the fields map one to one (below) |

| duet    | Nostr (NIP-01) |
|---------|----------------|
| `id`    | `id` |
| `from`  | display name; `pubkey` once keys exist |
| `text`  | `content` |
| `re`    | `["e", re]` tag |
| `state` | a separate `kind` |
| `presence`, `app` | a separate `kind`, `app` as a tag |
| relay time | `created_at` |
| room topic | `["t", topic]` tag, or a NIP-29 group |
