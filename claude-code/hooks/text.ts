// Pure text helpers: no `$`, no engine calls. Everything a peer writes is untrusted, so it is cleaned
// before it is drawn on a card or handed to Claude, and a card shows exactly what Claude gets.

export const MAX_TEXT = 200_000; // one message, in characters

// Removed: ANSI escapes, control characters but tab and newline, format characters (bidi controls,
// zero-width, tags) and every default-ignorable code point. Each draws as nothing while a model
// still reads it, so text built from them can carry a hidden instruction. Anything removed leaves a mark.
const HIDDEN = new RegExp(String.raw`\x1b\[[0-9;?]*[ -\/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u2800\u{E0000}-\u{E0FFF}]|\p{Cf}|\p{Default_Ignorable_Code_Point}`, "gu");
export const HIDDEN_MARK = " [hidden characters removed]";

export function stripHidden(text: unknown): { text: string; hidden: boolean } {
	let hidden = false;
	const clean = String(text ?? "")
		.replace(/\r\n?/g, "\n")
		.replace(HIDDEN, () => ((hidden = true), ""));
	return { text: clean, hidden };
}

// Clean and cap a text for a card or a prompt.
export function sanitize(text: unknown, max = MAX_TEXT): string {
	const { text: clean, hidden } = stripHidden(text);
	const cut = clean.length > max ? clean.slice(0, max) + `… [${clean.length - max} more characters]` : clean;
	return hidden ? cut + HIDDEN_MARK : cut;
}

// A name as shown and handed to Claude: plain characters only (letters, digits, space, ' . - _), at most
// 40, so a display name can't dress itself up as part of duet's frame.
export const cleanName = (n: unknown): string =>
	sanitize(stripHidden(n).text, 200)
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}' ._-]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 40)
		.trim() || "someone";

// One line, short: a name or a list of names on a card.
export const oneLine = (s: unknown): string => sanitize(s, 200).replace(/\n/g, " ");

export const firstLine = (text: string): string => {
	const line = String(text).split("\n").find((l) => l.trim()) ?? "";
	return line.length > 80 ? line.slice(0, 79) + "…" : line;
};

export const byteLength = (s: string): number => new TextEncoder().encode(s).length;

export function randomId(): string {
	return crypto.randomUUID();
}

export function timeOf(ts: string | number): string {
	const t = typeof ts === "number" ? ts : Date.parse(ts);
	if (Number.isNaN(t)) return "";
	const d = new Date(t);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// A message from the room, as the queue, the cards and the hand-over use it.
export type Request = {
	id: string; // the Matrix event id
	fromId: string; // the sender's Matrix user id
	from: string; // the sender's name, cleaned
	text: string;
	by: "person" | "agent";
	toId?: string; // the member it @-mentions first (this agent when it names it)
	re?: string; // the event it answers
	reLine?: string; // the first line of our own message it answers
	ts: number;
};

// What Claude reads when duet starts a turn. Claude Code puts its own line above it ("The duet plugin
// sent a message"), so Claude knows this isn't its own user. The folder is named: asked to work "in
// your folder", a model once used the home directory.
export function frameForClaude(reqs: Request[], cwd: string, tool: string, room: string, me: string): string {
	const froms = [...new Set(reqs.map((r) => r.from))].join(", ");
	const items = reqs.map((r) => {
		const who = r.by === "person" ? "the other person, typing to you directly" : "the other person's agent, on their computer";
		const answers = r.reLine ? ` — a reply to your message “${sanitize(r.reLine, 100)}”` : "";
		return `[duet] from ${r.from} (${who}), ${timeOf(r.ts)}${answers}:\n\n${sanitize(r.text)}`;
	});
	return (
		`[duet] In this room: ${room || "no one else yet"} · you are ${sanitize(me, 80)} · your folder: ${cwd}\n\n` +
		`${items.join("\n\n---\n\n")}\n\n` +
		`Only your own user sees your text replies: to answer ${froms}, call the ${tool} tool. ` +
		`Answer only with ${tool}, never another duet tool or connector. If ${tool} is missing, tell your user so and don't send. ` +
		`Send one complete reply when you're done.`
	);
}
