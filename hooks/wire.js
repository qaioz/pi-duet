// The duet wire format for the Claude Code mod: pure functions, no `node:` imports, no mods API.
// It must stay compatible with transport.js (pi, the MCP server): same topic hash, same envelope.
// pi and the MCP server drop `kind: "note"` (their isEnvelope rejects it) and ignore the fields they
// don't know (`by`), so everything here is safe to send to them.

export const DEFAULT_SERVER = "https://duet.gaioz.online"; // the duet relay (ntfy), run by the author
// Longer messages still go out as one: the relay stores the body as an attachment (ntfy does that
// above 4096 bytes; ntfy.sh keeps them 3 h, up to 2 MB) and receivers fetch it. Same as transport.js.
export const MAX_BYTES = 256_000;
export const MAX_TEXT = 200_000;
// Unattended peer-started turns allowed in auto mode before duet falls back to asking.
export const MAX_AUTO = 8;
// A Text string child may hold at most 10,000 characters; keep well under.
export const MAX_SHOWN = 6000;

export const NOTES = ["declined", "stopped", "failed", "approval-wait", "left", "moved"];

const NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._-]{0,39}$/u;
// No hidden characters either (\p{M} holds the variation selectors and the grapheme joiner): a name
// goes into every prompt and form unchanged.
export const isName = (name) => typeof name === "string" && NAME.test(name) && !stripHidden(name).hidden;
export const isPlaceholderName = (name) => typeof name === "string" && /^your[-_ ]?name$/i.test(name);
export const fitName = (name) =>
	isName(name)
		? name
		: Array.from(stripHidden(name).text.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-").replace(/^[^\p{L}\p{N}]+/u, ""))
				.slice(0, 40)
				.join("") || "anon";

export function isRelayUrl(url) {
	return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(url);
}

// Words that mean "leave" in /duet (pi uses /duet off). None of them can be a room name.
export const LEAVE_WORDS = ["off", "leave", "stop", "disable", "quit", "exit"];

// A room code is the shared secret: 3-64 letters, digits, . _ -, not a leave word. The same rule as
// transport.js isRoomCode (Codex, pi, the MCP servers, the join file): test/mod-unit.mjs compares them.
export const isRoomCode = (room) =>
	typeof room === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(room) && !LEAVE_WORDS.includes(room.toLowerCase());

// The join file (~/.duet/join.json) the website's prompt writes: { agent, room, name, relay, cwd,
// pcwd, at } with `at` in Unix seconds. What a client does with its text: "take" ({ room, name,
// relay }), "clear" (stale: nobody will take it) or null (leave it: another client or folder may).
export const JOIN_FRESH_S = 30 * 60;
// A folder as both sides write it: Git Bash's /c/x and Windows' C:\x are one folder; no trailing slash.
const folderKey = (p) => (typeof p === "string" && p ? p.replace(/\\/g, "/").replace(/^\/([A-Za-z])(?=\/|$)/, "$1:").replace(/\/+$/, "") || "/" : "");
// Windows paths (C:\x, \\server\x) compare without case; Linux and macOS ones as written.
const isWindowsPath = (p) => typeof p === "string" && (/^[A-Za-z]:/.test(p) || p.includes("\\"));
// The join file's folder is this one or, on this window's own start or reload (nested), one inside it:
// the agent's shell may have cd'd into a subfolder. A poll takes only its own folder, so a window open
// in ~ doesn't take every prompt pasted below it.
export const sameFolder = (paths, folder, nested = false) => {
	const here0 = folderKey(folder);
	return !!here0 && paths.some((p) => {
		const fold = isWindowsPath(folder) || isWindowsPath(p);
		const here = fold ? here0.toLowerCase() : here0;
		const k = fold ? folderKey(p).toLowerCase() : folderKey(p);
		const root = here === "/" || /^[A-Za-z]:$/.test(here); // / or C:\ is no one's project
		return !!k && (k === here || (nested && !root && k.startsWith(here + "/")));
	});
};
export function readJoinFile(text, agent, folder, nowMs, nested = false) {
	let j;
	try {
		j = JSON.parse(text);
	} catch {
		return null;
	}
	if (!j || typeof j !== "object" || typeof j.at !== "number") return null;
	const age = nowMs / 1000 - j.at;
	if (age > JOIN_FRESH_S) return { clear: true };
	if (age < -5 * 60 || j.agent !== agent) return null;
	if (!sameFolder([j.cwd, j.pcwd], folder, nested)) return null;
	if (!isRoomCode(j.room) || !isName(j.name) || isPlaceholderName(j.name) || (j.relay !== undefined && !isRelayUrl(j.relay))) return null;
	return { take: { room: j.room, name: j.name, relay: j.relay } };
}

const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256hex(text) {
	return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// The room name is the shared secret; only its hash ever reaches the server. Same as transport.js.
export async function topicFor(room) {
	return "duet_" + (await sha256hex("pi-duet:" + room)).slice(0, 40);
}

export function randomId() {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const b = crypto.getRandomValues(new Uint8Array(16));
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = hex(b);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const WORDS = [
	"amber", "birch", "cedar", "delta", "ember", "fjord", "grove", "heron", "indigo", "juniper", "kelp", "lumen",
	"maple", "nectar", "onyx", "pebble", "quartz", "raven", "sage", "tidal", "umber", "violet", "willow", "zephyr",
	"otter", "lynx", "falcon", "badger", "marten", "osprey", "puffin", "walrus", "yak", "gecko", "bison", "crane",
];

// A fresh room code like "amber-otter-4821-x7q2": 2 words + 4 digits + 4 base-36 chars (~50 bits).
export function newRoomCode() {
	const r = crypto.getRandomValues(new Uint32Array(4));
	const tail = (r[3] >>> 0).toString(36).padStart(4, "0").slice(-4);
	return `${WORDS[r[0] % WORDS.length]}-${WORDS[r[1] % WORDS.length]}-${String(r[2] % 10000).padStart(4, "0")}-${tail}`;
}

// Which computer and folder an agent works in, as a hash (same recipe as transport.js placeFor):
// two windows in the same folder share it, so a join can warn that they may edit the same files.
// Salted with the room's topic, so the same folder can't be recognised across rooms.
export async function placeFor(cwd, topic, host) {
	return (await sha256hex(`duet-place:${topic}:${host}:${cwd}`)).slice(0, 16);
}

// A long message's attachment, accepted only when it is a real upload on this very relay (same rules
// as transport.js attachmentUrl): same origin, path exactly <relay path>/file/<id>[.ext], no query,
// and a size. Anyone can post an attachment that points anywhere.
export function attachmentUrl(a, server, max) {
	if (!a || typeof a.url !== "string" || typeof a.size !== "number" || a.size > max) return null;
	let u, base;
	try {
		u = new URL(a.url);
		base = new URL(server);
	} catch {
		return null;
	}
	const path = base.pathname.replace(/\/+$/, "");
	if (u.origin !== base.origin || u.search || u.hash || u.username || u.password) return null;
	return new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/file/[A-Za-z0-9]+(\\.[A-Za-z0-9]+)?$`).test(u.pathname) && !/\/\.\.?\//.test(a.url) ? u.href : null;
}

// The first line of a text, short: how a reply names the message it answers.
export const firstLine = (text) => {
	const line = String(text).split("\n").find((l) => l.trim()) ?? "";
	return line.length > 80 ? line.slice(0, 79) + "…" : line;
};

export function envelope(fields) {
	return { v: 1, id: randomId(), ...fields, ts: new Date().toISOString() };
}

export function isEnvelope(e) {
	if (
		e?.v !== 1 ||
		typeof e.fromId !== "string" ||
		typeof e.from !== "string" ||
		!isName(e.from) ||
		typeof e.ts !== "string" ||
		(e.to !== undefined && typeof e.to !== "string") ||
		(e.re !== undefined && typeof e.re !== "string") ||
		(e.place !== undefined && typeof e.place !== "string")
	)
		return false;
	if (e.kind === "join") return true;
	if (e.kind === "msg") return typeof e.text === "string" && e.text.length <= MAX_TEXT && !e.text.includes("\0");
	if (e.kind === "note") return NOTES.includes(e.note);
	return false;
}

// Drop our own echoes (by install id) and messages addressed to someone else.
export function isForMe(env, myFromId, myName) {
	if (env.fromId === myFromId) return false;
	return !env.to || env.to.normalize("NFC").toLowerCase() === myName.normalize("NFC").toLowerCase();
}

export const byteLength = (s) => new TextEncoder().encode(s).length;

// The one cleaner for the other side's text: a copy of transport.js's (the mod can't import from
// outside hooks/); test/mod-unit.mjs checks that both agree. Removed: ANSI escapes, control characters
// but tab and newline (C0, C1, U+2028/2029), format characters (\p{Cf}: bidi controls, zero-width,
// tags), every default-ignorable code point (variation selectors, CGJ, Hangul fillers, Mongolian FVS,
// the whole tag block) and the blank Braille cell: each draws as nothing while a model still reads it.
// Text built from them can carry a whole hidden instruction. Anything removed leaves a visible mark.
export const HIDDEN = /\x1b\[[0-9;?]*[ -\/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u2800\u{E0000}-\u{E0FFF}]|\p{Cf}|\p{Default_Ignorable_Code_Point}/gu;
export const HIDDEN_MARK = " [hidden characters removed]";
export function stripHidden(text) {
	let hidden = false;
	const clean = String(text ?? "")
		.replace(/\r\n?/g, "\n")
		.replace(HIDDEN, () => ((hidden = true), ""));
	return { text: clean, hidden };
}
export function cleanText(text) {
	const r = stripHidden(text);
	return r.hidden ? r.text + HIDDEN_MARK : r.text;
}

// Peer text is untrusted: Text refuses control characters other than tab and newline (and an invalid
// tree silently falls back to the engine's drawing), so they go (stripHidden), and the length is capped.
// A card shows every word Claude gets (gate 1) and every word a reply sends (gate 2): the same
// function makes both.
export function sanitize(text, max = MAX_SHOWN) {
	const { text: clean, hidden } = stripHidden(text);
	const cut = clean.length > max ? clean.slice(0, max) + `… [${clean.length - max} more characters]` : clean;
	return hidden ? cut + HIDDEN_MARK : cut;
}

// The first `lines` lines of a text, each cut to `width`, for the card above the prompt.
export function preview(text, lines = 4, width = 160, hint = " — /duet to read all") {
	const all = sanitize(text).split("\n");
	const total = String(text ?? "").replace(/\r\n?/g, "\n").split("\n").length; // before sanitize shortens it
	let cut = String(text ?? "").length > MAX_SHOWN; // sanitize shortened it
	const shown = all.slice(0, lines).map((l) => {
		if (l.length <= width) return l;
		cut = true;
		return l.slice(0, width - 1) + "…";
	});
	// Say so whenever anything is left out, not only whole lines.
	if (total > lines) shown.push(`… (${total - lines} more lines${hint})`);
	else if (cut) shown.push(`… (cut${hint})`);
	return shown.join("\n");
}

const clock = (ts) => {
	const t = Date.parse(ts);
	if (Number.isNaN(t)) return "";
	const d = new Date(t);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const timeOf = clock;

// What Claude reads when duet starts a turn. The engine puts "The duet plugin sent a message:" above
// it, so Claude knows this isn't its own user. Observed: asked to work "in your folder", the model
// used the home directory — so the folder is named.
export function frameForClaude(envs, cwd, tool) {
	const froms = [...new Set(envs.map((e) => e.from))].join(", ");
	const parts = envs.map((e) => {
		const who = e.by === "person" ? "the other person, typing to you directly" : "the other person's agent, on their computer";
		const at = clock(e.ts);
		const answers = e.reLine ? ` — a reply to your message “${sanitize(e.reLine, 100)}”` : "";
		return `[duet] from ${e.from} (${who})${at ? ", " + at : ""}${answers}:\n\n${sanitize(e.text, MAX_TEXT)}`;
	});
	return (
		`${parts.join("\n\n---\n\n")}\n\n` +
		`Only your own user sees your text replies: to answer ${froms}, call the ${tool} tool. ` +
		`Send one complete reply when you're done.`
	);
}
