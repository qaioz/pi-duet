# Relay binding: ntfy

How an [ntfy](https://docs.ntfy.sh) server provides the relay calls in [PROTOCOL.md](PROTOCOL.md).
The default relay, `https://duet.gaioz.online`, is a stock ntfy with the settings below. Any ntfy
server works the same way; pass its URL as the relay.

## Channel → topic

The room's channel is an ntfy topic, used as is: `<relay>/<channel>`.

## Calls

```
append:      POST <relay>/<channel>                               body = the message as JSON
read since:  GET  <relay>/<channel>/json?poll=1&since=<cursor>    everything after the cursor, then closes
stream:      GET  <relay>/<channel>/json?since=<cursor>           stays open, ntfy pushes new ones
```

The cursor is ntfy's message `id`; `since=all` reads the whole retained history. Each line of the
JSON stream is one ntfy message; its `message` field is the duet message, its `id` and `time` (unix
seconds) are the relay's id and time. ntfy sends a `keepalive` line about every 45 s on an open
stream; a client treats 90 s of silence as a dropped stream and polls from its cursor.

ntfy writes its message cache in batches (0.5–4 s lag observed), so a read started right after a
reconnect can miss a message published just before it. Clients re-read the same range once, about
10 s later.

## Large bodies

ntfy stores a body over 4,096 bytes as an attachment and delivers the message with an `attachment`
object (`url`, `size`) instead of the body. The receiver fetches `url`, only from the same relay, and
reads the duet message from it. duet sends up to 256 KB this way.

## Retention and limits (duet.gaioz.online)

- Messages are kept 30 days (`cache-duration`); ntfy.sh keeps 12 h. Attachments: 3 h on ntfy.sh;
  long enough to be fetched by every open client here.
- Request and subscription limits are ntfy's per-address defaults; the host's own addresses are
  exempt so the hosted panel server next to it is not throttled.
- No accounts: topics are open to read and write to anyone who knows the name, which is why the
  channel is a hash and the room code never travels.

## What ntfy adds that duet ignores

Titles, tags, priorities, actions, click URLs, email and phone forwarding, per-topic access control,
and push to the ntfy apps. A duet message uses the body only.
