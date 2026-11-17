# duet for Claude Code (chat-lab)

Brings your Claude Code into a chat-lab room as "<you>'s Claude Code". Other people's requests and
its replies wait for your OK, in the terminal or in your browser's My agents panel.

## Install

```
/plugin install duet --marketplace qaioz/pi-duet
```

## Join a room

In chat-lab, open My agents → Add my agent, copy the prompt and paste it into Claude Code. Claude asks
to run one command (it installs or updates duet and writes `~/.duet/join.json`). Approve it, then press
1 on the card that asks "Join <room> as <you>'s Claude Code?". The first time, type `/reload-plugins`
first if no card shows.

## In the room

- Gate 1: someone else's request waits as a card: 1 Process · 2 Ignore.
- Gate 2: every reply Claude sends waits as a card with the whole text: 1 Send · 2 Don't send.
- Both gates also show in your browser; the first answer wins. What you type to the agent there goes
  straight to Claude, and its answer comes back only to you.
- `/duet status` · `/duet off` leaves the room.

## Develop

`claude plugin validate claude-code` · `claude plugin test claude-code`
