// The duet wire format for the Claude Code mod: pure functions, no `node:` imports, no mods API.
// It must stay compatible with transport.js (pi, the MCP server): same topic hash, same envelope.
// Older clients drop `kind: "note"` (their isEnvelope rejects it) and ignore the fields they don't
// know (`via`, `by`), so everything here is safe to send to them.

export const DEFAULT_SERVER = "https://duet.gaioz.online"; // the duet relay (ntfy), run by the author
// ntfy.sh turns bodies over 4096 bytes into attachments; transport.js stays under 3800.
export const MAX_BYTES = 3800;
// Unattended peer-started turns allowed in auto mode before duet falls back to asking.
export const MAX_AUTO = 8;
// A Text string child may hold at most 10,000 characters; keep well under.
export const MAX_SHOWN = 6000;

export const NOTES = ["declined", "stopped", "failed", "approval-wait", "left", "moved"];

const NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._-]{0,39}$/u;
export const isName = (name) => typeof name === "string" && NAME.test(name);
export const isPlaceholderName = (name) => typeof name === "string" && /^your[-_ ]?name$/i.test(name);
export const fitName = (name) =>
	isName(name)
		? name
		: Array.from(String(name).normalize("NFC").replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-").replace(/^[^\p{L}\p{N}]+/u, ""))
				.slice(0, 40)
				.join("") || "anon";

export function isRelayUrl(url) {
	return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(url);
}

// A room code is the shared secret: letters, digits and dashes, 3 to 64 characters.
export const isRoomCode = (room) => typeof room === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(room);

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

export function envelope(fields) {
	return { v: 1, id: randomId(), ...fields, ts: new Date().toISOString() };
}

export function isEnvelope(e) {
	if (
		e?.v !== 1 ||
		typeof e.fromId !== "string" ||
		typeof e.from !== "string" ||
		!NAME.test(e.from) ||
		typeof e.ts !== "string" ||
		(e.to !== undefined && typeof e.to !== "string")
	)
		return false;
	if (e.kind === "join") return true;
	if (e.kind === "msg") return typeof e.text === "string" && e.text.length <= 4 * MAX_BYTES && !e.text.includes("\0");
	if (e.kind === "note") return NOTES.includes(e.note);
	return false;
}

// Drop our own echoes (by install id) and messages addressed to someone else.
export function isForMe(env, myFromId, myName) {
	if (env.fromId === myFromId) return false;
	return !env.to || env.to.normalize("NFC").toLowerCase() === myName.normalize("NFC").toLowerCase();
}

export const byteLength = (s) => new TextEncoder().encode(s).length;

// Peer text is untrusted: Text refuses control characters other than tab and newline (and an invalid
// tree silently falls back to the engine's drawing), so strip them, and cap the length.
export function sanitize(text, max = MAX_SHOWN) {
	const clean = String(text ?? "")
		.replace(/\r\n?/g, "\n")
		.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "") // ANSI escape sequences
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/g, "");
	return clean.length > max ? clean.slice(0, max) + `… [${clean.length - max} more characters]` : clean;
}

// The first `lines` lines of a text, each cut to `width`, for the card above the prompt.
export function preview(text, lines = 4, width = 160, hint = " — /duet to read all") {
	const all = sanitize(text).split("\n");
	const shown = all.slice(0, lines).map((l) => (l.length > width ? l.slice(0, width - 1) + "…" : l));
	if (all.length > lines) shown.push(`… (${all.length - lines} more lines${hint})`);
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
		return `[duet] from ${e.from} (${who})${at ? ", " + at : ""}:\n\n${sanitize(e.text, 4 * MAX_BYTES)}`;
	});
	return (
		`${parts.join("\n\n---\n\n")}\n\n` +
		`Only your own user sees your text replies: to answer ${froms}, call the ${tool} tool. ` +
		`"Your folder" means ${cwd}: work there, and nowhere else unless your own user says so. ` +
		`While you work on this request, some tools are off (anything outside that folder, scheduling, background work); ` +
		`if you need one, tell ${froms} to ask your user.`
	);
}
