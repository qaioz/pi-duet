# duet (pi-duet)

Pair your coding agent with a friend's. "ask nika's agent to run the tests and send me the failures":
their agent works, with its own tools · the answer lands in your session. Works with **Claude Code**, **Codex**, **[pi](https://github.com/badlogic/pi-mono)**, and
**Claude chat / ChatGPT** through the duet panel, in any mix. No accounts.

- **Start a room:** <https://qaioz.github.io/pi-duet/>
- **Guide:** <https://qaioz.github.io/pi-duet/guide/> · setup per agent, the two gates, how it works,
  self-hosting, limits

Two gates in ask mode (the default on Claude Code, Codex, chat apps): request in (Do it / Ignore) ·
whole reply out (Send / Don't send). pi: no gates, always auto, 8 in a row max.

> **Safety.** Whoever has the invite link (the room code) can send your agent requests and read the
> room. Share it only with someone you trust. Messages are not end-to-end encrypted.

## Development

```
npm test                                  # no-model plumbing: MCP server + pi extension
node --test test/mod-unit.mjs             # Claude Code plugin: wire format
claude plugin test                        # Claude Code plugin: hooks, cards, pane (Claude Code's own test kit)
node test/site.mjs                        # the website and the guide in headless Chromium
node test/e2e.mjs talk do loop            # two real pi agents (needs OPENROUTER_API_KEY; costs cents)
node test/codex.mjs                       # Codex: hooks, ask form, turn-end hand-over, join (no model)
node test/panel.mjs                       # the duet panel: stdio + hosted servers, and the panel in Chromium
node mcpb/build.mjs                       # rebuild docs/duet.mcpb after changing the server (panel.mjs checks it)
node test/pairs.mjs                       # mixed pairs: pi, Claude Code, Codex (see the file header)
```

- Tests use the relay in `DUET_SERVER`. The default is a local ntfy on `http://127.0.0.1:18080`:
  `docker run -d --name duet-ntfy-test -p 127.0.0.1:18080:80 -e NTFY_BASE_URL=http://127.0.0.1:18080 -e NTFY_ATTACHMENT_CACHE_DIR=/tmp/att binwiederhier/ntfy serve`
  (the base URL and attachment folder let it carry long messages).
  Set `DUET_SERVER=https://ntfy.sh` for the real relay.
- Agents run isolated, each with its own HOME, config dir and working folder under
  `~/coding/personal/duet-test-v2/`.

### Website and guide

GitHub Pages serves `main:/docs` (legacy, no build step).

- `docs/index.html`: the website, one file on [Basecoat](https://basecoatui.com) (`docs/basecoat.min.css`,
  vendored from `basecoat-css@1.0.2`, MIT) with Geist (`docs/fonts/`, OFL). It loads nothing from other
  domains: only itself and the relay.
- `docs-site/`: the guide, a [Starlight](https://starlight.astro.build) site. Edit
  `docs-site/src/content/docs/`, then `cd docs-site && npm ci && npm run build`: it writes `docs/guide/`.
  Commit both.
- `docs/claude.sh`: the optional Claude Code installer that also checks mods are on.

### Layout

| file | what |
|---|---|
| `index.ts` | pi extension |
| `mcp.js` | MCP server (Codex, Claude Desktop, VS Code, Goose) |
| `hosted.js`, `hosted/` | the hosted MCP server for web chat apps |
| `panel.js` | the duet panel (MCP App) |
| `hooks/` | Claude Code plugin (a mod); `hooks/wire.js` is its copy of the wire format |
| `codex/` | Codex plugin hooks |
| `transport.js`, `lock.js` | wire format and the one-window lock, shared |
| `setup.js` | `setup codex`, `setup claude-desktop` |
