# duet protocol

**Status: target.** This is the wire format every duet client moves to after the demo. The clients on
`main` still speak the older format (`v`, `fromId`, `kind: join | msg | note`, `place`, `via`, `by`);
all of them switch together, with no compatibility period.

duet lets two or more people's coding agents talk through a shared room. The relay only stores and
forwards; everything else (the gates, who a message is for, what the agent sees) happens in each
client.

The protocol says what a relay must do and what clients send through it. It does not name a relay
implementation: how a concrete relay provides the calls below is a *binding*, kept in its own file.
The default relay is `https://duet.gaioz.online`; its binding is [RELAY.md](RELAY.md).

## Relay

A relay is a store-and-forward server with named channels. For duet it must provide:

- **Append.** Accept a message body on a channel and keep it, in arrival order.
- **Read since.** Return every message on a channel after a given cursor, each with the relay's own
  id and time, then close. A client may also hold the connection open to be pushed new ones, but
  only the closing read is required.
- **Large bodies.** Carry a body of up to 256 KB. How (inline or by reference) is the binding's
  business; the receiver gets the whole body either way.
- **Retention.** Keep messages for a configured time. Nothing in the protocol depends on how long.

A relay needs no accounts, no knowledge of duet, and no per-room setup. Any server that answers these
calls the same way is a duet relay; the binding says how.

## Room

A room is a channel derived from the room code:

```
channel = "duet_" + first 40 hex characters of sha256("pi-duet:" + room code)
```

The room code is the only secret. The relay sees only the channel name, never the code. There is
nothing to create: the first message makes the room.

## Messages

Each message is one JSON object, sent as the body of one relay message. It carries exactly one of
`text` (a message), `state` (a status about a message) or `presence` (someone joining or leaving).
All three are ordinary messages: they travel, arrive and reach the agent the same way.

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
send:     append the message, as JSON, to the room's channel
receive:  read the channel since your cursor; the cursor is the relay's id of the last message handled
```

Every client must be able to **poll** (read since, then close). Streaming is optional: it is a faster
poll, and when it drops the client polls from its cursor.

## Rules

1. **Skip your own messages**, by `id`.
2. **Same `id` on retry.** Drop any `id` you have already seen, so a resent message shows once.
3. **Only what arrives while you are in the room reaches the agent.** Messages posted before your
   `join` are history: they build the participant list and the user can read them, but they are
   never handed to the agent. There is no age limit; the relay keeps messages as long as it is
   configured to.
4. **Deliver everything.** Every message that arrives while you are in the room goes to the agent,
   in order, from every sender: texts, statuses, joins and leaves alike. If the agent is busy, all
   of them go in its next turn. The cursor moves past a message only once it was handed to the agent
   or the user declined it.
5. **Join.** On joining, send `presence: "join"` with your `app`.
6. **Leave when you stop listening.** Send `presence: "leave"` when your user leaves, when the
   window closes, and after 2 hours with no message sent or received in the room. After a `leave`,
   don't come back unless your user asks again.

## Leaving

- **Idle:** 2 hours without a message in the room, either way, is idle. What the agent does
  otherwise doesn't count. The client sends `leave` and tells its user how to rejoin.
- **Window closed:** counts as leaving.
- **Staying left:** a client never rejoins by itself. When a new session opens in a folder that was
  in a room, it offers the room (`Rejoin <room> as <name>?`) and joins only on the user's yes.
- **Crash:** no `leave` can go out. Others see the last time they heard from you.

## Participants

A client builds the list from what it reads: on joining it reads everything the relay has for the
room, and keeps it up to date from then on. Nobody sends anything for a newcomer.

The list is everyone you have seen any message from, minus those whose latest presence is `leave`,
with the time you last heard from each. Someone who crashed without leaving stays listed with that
time. If the relay has dropped someone's messages, they are not visible until they send something.

Clients show the participants to their user. The agent learns of joins and leaves from the messages
themselves (rule 4); since history before your own `join` never reaches it, every hand-over also
starts with the current participant list.

## Identity and access

- **Who you are:** the name you type when you join, meaningful only in that room.
- **Who may take part:** whoever knows the room code.
- **Registration:** none. No accounts, no directory, no keys.

Anyone with the code can post under any name. That is accepted for now; if a code leaks, start a new
room.

## Not in the protocol

- **Which relay software**, its URL scheme, limits or retention: the binding.
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
| One relay is not enough, or interop with Nostr | A Nostr binding: the fields map one to one (below) |

| duet    | Nostr (NIP-01) |
|---------|----------------|
| `id`    | `id` |
| `from`  | display name; `pubkey` once keys exist |
| `text`  | `content` |
| `re`    | `["e", re]` tag |
| `state` | a separate `kind` |
| `presence`, `app` | a separate `kind`, `app` as a tag |
| relay time | `created_at` |
| room channel | `["t", channel]` tag, or a NIP-29 group |
