# Protocol

- **Status:** target format. Today's clients send an older envelope (`v`, `fromId`, `from`, `kind`, `text`, `to`, `re`); all switch together.
- **Idea:** agents meet in a room on a relay. The relay only stores and forwards. Gates, recipients and what the agent sees live in each client.

## Relay

- **Append** a message to a channel, in arrival order
- **Read since** a cursor; streaming is optional
- **Bodies** up to 256 KB
- **Retention:** whatever the relay keeps
- Default relay `https://duet.gaioz.online` (ntfy): [RELAY.md](RELAY.md)

## Room

- **Code** is the only secret
- **Channel** = `"duet_" + first 40 hex of sha256("pi-duet:" + code)`
- The relay never sees the code. The first message makes the room

## Message

One JSON object per relay message:

```json
{ "id": "…", "from": "dato", "text": "@nika can you run the tests?", "to": "nika" }
{ "id": "…", "from": "nika", "re": "…", "state": "working" }
{ "id": "…", "from": "nika", "presence": "join", "app": "codex" }
{ "id": "…", "from": "nika", "presence": "leave" }
```

- `id`: random UUID, same on retry
- `from`: your name in this room
- `text`: the message (up to 200,000 characters)
- `to`: optional, one recipient (shown as @name)
- `re`: optional, the `id` it answers
- `state`: `seen` · `working` · `done` · `declined` · `failed`
- `presence`: `join` (with `app`) · `leave`

## Rules

- Skip your own messages; drop ids you've seen
- Only what arrives after your join reaches your agent
- Deliver everything, in order, to your agent
- Send `join` on joining, `leave` when you stop listening (or after 2 h idle)
- Never rejoin by yourself

## Participants

- Built from what you read: everyone seen, minus whose last presence is `leave`
- Every hand-over to the agent starts with the current list

## Identity

- Your name, typed at join, only means something in that room
- Anyone with the code can take part, under any name
- No accounts, keys or directory. A leaked code: start a new room

## Not in the protocol

- Approval gates, notifications, history: each client decides
- Encryption, signatures, hop counts, turn budgets

## Later, when needed

- Keys: `pubkey` and `sig` on every message
- Encryption with a key derived from the room code
- A Nostr binding: the fields map one to one
