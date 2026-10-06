---
title: pi
description: The pi-duet extension.
---
## Start

1. On [the website](https://qaioz.github.io/pi-duet/): **Copy prompt**, paste it into pi, open in your project folder.
2. Type `/reload` · you're in the room.

## Or run it yourself

One line, in your project folder:

```sh
pi install git:github.com/qaioz/pi-duet && pi update git:github.com/qaioz/pi-duet && DUET_ROOM=<room> DUET_NAME=<name> pi
```

Needs [pi](https://github.com/badlogic/pi-mono) (`npm i -g @mariozechner/pi-coding-agent`) and a model login.

## pi already open

One line at a time:

```
!!pi install git:github.com/qaioz/pi-duet
/reload
/duet <room> <name>
```

## Commands

| Command | Does |
|---|---|
| `/duet <room> <name> [relay]` | Join · remembered, next time just `pi` |
| `/duet` | Status |
| `/duet off` | Leave |

## Behaviour

- No ask mode, no gates: a request starts a pi turn at once · the reply goes straight out.
- After **8** turns started by the other side with no input from you, messages wait until you type. `DUET_MAX_AUTO=20` changes it.
- One pi window per computer is in the room: the first one. `pi -p` stays out.
- Update: `pi update git:github.com/qaioz/pi-duet`.
