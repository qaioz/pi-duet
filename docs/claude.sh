#!/bin/sh
# duet for Claude Code: install the plugin (or update an older one), then start Claude Code in the room.
#
#   curl -fsSL https://qaioz.github.io/pi-duet/claude.sh | sh -s -- <room> <name> [relay]
#
# Claude Code joins from DUET_ROOM / DUET_NAME as soon as the plugin loads: no /duet typed at start-up,
# which could reach Claude Code before the plugin was ready.
set -eu

# All in one function, run only once the whole script has arrived: a cut-off download runs nothing,
# and nothing below can read the rest of the script from stdin (curl | sh feeds it there).
main() {

	room=${1:-}
	name=${2:-}
	relay=${3:-https://duet.gaioz.online}
	fail() { echo "duet: $*" >&2; exit 1; }

	# The same rules as everywhere in duet (and nothing a shell reads specially).
	printf '%s' "$room" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$' || fail "usage: sh -s -- <room code> <your name> [relay]  (a room code is 3-64 letters, digits, . _ -)"
	printf '%s' "$name" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$' || fail "your name: letters, digits, . _ - (up to 40), starting with a letter or digit"
	printf '%s' "$name" | grep -Eqi '^your[-_]?name$' && fail "\"$name\" is the placeholder: use your own name"
	printf '%s' "$relay" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$' || fail "the relay must be a plain http(s) URL"
	command -v claude >/dev/null 2>&1 || fail "Claude Code isn't installed (https://claude.com/claude-code)"

	echo "duet: installing or updating the Claude Code plugin…"
	claude plugin marketplace add qaioz/pi-duet >/dev/null
	claude plugin marketplace update pi-duet >/dev/null
	claude plugin install duet@pi-duet >/dev/null
	claude plugin update duet@pi-duet >/dev/null
	claude plugin enable duet@pi-duet >/dev/null 2>&1 || true # "already enabled" is an error to it

	# The plugin is a Claude Code mod. Anthropic can switch mods off remotely, and a stale copy of that
	# switch sometimes says off: one short request refreshes it. In an empty folder, `claude plugin test`
	# says "no hooks module to load" only while mods are on.
	mods_on() {
		dir=$(mktemp -d)
		out=$(cd "$dir" && claude plugin test 2>&1 || true)
		rmdir "$dir"
		case $out in *"no hooks module to load"*) return 0 ;; *) return 1 ;; esac
	}
	if ! mods_on; then
		echo "duet: Claude Code says mods are off; refreshing that setting…"
		claude -p --model haiku "Reply with just: ok" </dev/null >/dev/null 2>&1 || true
		if ! mods_on; then
			echo "duet: Claude Code's mods are off for your account right now (Anthropic switches them remotely)," >&2
			echo "      so the duet plugin can't run in Claude Code: /duet would be an unknown command." >&2
			echo "      Try again later, or use duet from Codex or pi, or the duet panel in Claude Desktop or claude.ai" >&2
			echo "      (no mods needed): https://qaioz.github.io/pi-duet/ → Claude chat / ChatGPT." >&2
			exit 1
		fi
	fi

	echo "duet: starting Claude Code in room $(printf '%s' "$room" | cut -c1-4)… as $name"
	# Piped into sh, stdin is this script: give Claude Code the terminal. Use the real device
	# (/dev/ttys003, /dev/pts/0): on macOS, Claude Code crashes reading /dev/tty (kqueue EINVAL).
	tty_dev=/dev/tty
	t=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')
	case $t in '' | '?' | '??') ;; *) [ -c "/dev/$t" ] && tty_dev=/dev/$t ;; esac
	if [ "$relay" = https://duet.gaioz.online ]; then
		DUET_ROOM=$room DUET_NAME=$name exec claude <"$tty_dev"
	else
		DUET_ROOM=$room DUET_NAME=$name DUET_SERVER=$relay exec claude <"$tty_dev"
	fi
}
main "$@"
