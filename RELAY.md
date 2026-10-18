# Relay: ntfy

- Any [ntfy](https://docs.ntfy.sh) server is a relay for [PROTOCOL.md](PROTOCOL.md). Ours is `https://duet.gaioz.online`
- **Channel** = ntfy topic: `<relay>/<channel>`

## Calls

```
append:      POST <relay>/<channel>                               body = the message
read since:  GET  <relay>/<channel>/json?poll=1&since=<cursor>
stream:      GET  <relay>/<channel>/json?since=<cursor>
```

- **Cursor:** ntfy's message `id`. `since=all` reads everything kept
- **Stream:** keepalive about every 45 s; 90 s of silence means poll from the cursor
- **Lag:** ntfy writes in batches, so clients re-read once about 10 s later

## Large bodies

- Over 4 KB, ntfy stores the body as an attachment
- Fetch it only from the same relay. Up to 256 KB

## duet.gaioz.online

- Keeps messages 30 days (ntfy.sh: 12 h)
- ntfy's per-address limits; the hosted MCP server next to it is exempt
- No accounts: anyone who knows a topic can read and write it, which is why the channel is a hash

## Ignored

- Titles, tags, priorities, actions, email, phone and app push. A message is the body only
