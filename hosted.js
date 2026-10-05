#!/usr/bin/env node
// The hosted duet server: the duet panel (panel.js) for chat apps that can only reach a public HTTPS
// MCP server (claude.ai on the web and mobile, Cowork, ChatGPT). MCP over Streamable HTTP, answered
// as plain JSON (no server-to-client stream: a panel polls). No dependencies, like mcp.js.
//
//   node hosted.js            PORT (8092), HOST (127.0.0.1), DUET_SERVER (relay, https://duet.gaioz.online),
//                             PUBLIC_URL, DUET_ORIGINS / DUET_SHARED_RANGES (comma-separated, see below)
//
// Each open panel has a seat: its own room, name, inbox and history, found by a random token the
// panel makes for itself (hosts don't reliably keep one MCP session per conversation). What the server
// holds, and only in memory:
//   - per seat: the room's topic hash (never the room code: it is hashed at join and dropped; the panel
//     keeps the code), the name, the messages since the seat joined, a short "seat" handle the agent's
//     duet_send uses, and the agent's replies waiting for the user's Send (gate 2; they expire);
//   - nothing on disk, and no log line with a room, a token, a name or a message.
// The relay sees every message in plain text (as for every duet client: F12); this server sees the
// messages of the rooms its panels are in, while they are open.
//
// It is a public endpoint without accounts, so everything is bounded: requests and joins per address,
// open panels per address, rooms (the relay allows this box 60 subscriptions), memory per panel and in
// all, the size of a request and how many are in flight, messages per panel, and long messages per day
// (they become attachments on the relay, whose quota this box shares across all its users).
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { BlockList, isIPv6 } from "node:net";
import { pathToFileURL } from "node:url";
import { appTools, cleanText, handOver, heldResult, makeHolds, outgoingItem, panelError, panelResult, preview, resourceContents, resourceEntries, roomTool, SEND_NOTE, sendToolMeta, shortRoom, toWhom } from "./panel.js";
import { envelope, firstLine, fitName, isForMe, isName, isPlaceholderName, isRelayUrl, MAX_BYTES, MAX_TEXT, publish, subscribe, topicFor } from "./transport.js";

export const VERSION = "0.8.0"; // the MCP server's version, as in mcp.js
const PORT = Number(process.env.PORT ?? 8092); // 0: any free port (tests)
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://mcp-duet.gaioz.online").replace(/\/+$/, "");
const RELAY = (process.env.DUET_SERVER || "https://duet.gaioz.online").replace(/\/+$/, "");
if (!isRelayUrl(RELAY)) throw new Error(`DUET_SERVER must be an http(s) URL, got ${JSON.stringify(RELAY)}`);
const num = (k, d) => (process.env[k] === undefined ? d : Number(process.env[k]));
const list = (k) => (process.env[k] || "").split(",").map((x) => x.trim()).filter(Boolean);

const LIMIT = {
	seats: num("DUET_MAX_SEATS", 300), // open panels in rooms, in all
	rooms: num("DUET_MAX_ROOMS", 50), // distinct rooms: one relay subscription each (the relay allows 60 per address)
	seatIdleMs: num("DUET_SEAT_IDLE_MS", 30 * 60_000), // a panel that stops polling leaves after this
	sendsPerSeat: num("DUET_SENDS_PER_SEAT", 30), // messages a seat sends per 10 minutes
	seatSendBytes: num("DUET_SEAT_SEND_BYTES", 2_000_000), // ... and their size, per 10 minutes
	longPerDay: num("DUET_LONG_BYTES_PER_DAY", 60_000_000), // long messages (relay attachments), all seats
	seatChars: num("DUET_SEAT_CHARS", 600_000), // waiting text a seat keeps
	allChars: num("DUET_ALL_CHARS", 30_000_000), // ... all seats together (~60 MB at most)
	bodyBytes: 1_100_000, // one request: a 200 000-character message fits
	bodyMs: 10_000, // a request body must arrive within this: a slow one holds memory for nothing
	batch: 10, // JSON-RPC messages in one request (batches left MCP in 2025-06-18; old clients may send them)
	// Per address. Chat apps call from their own servers, so their published ranges carry many users each,
	// and request bodies in flight come from two pools, so other addresses can't crowd the chat apps out.
	normal: { perMin: num("DUET_IP_PER_MIN", 600), joins: num("DUET_JOINS_PER_IP", 20), seats: num("DUET_SEATS_PER_IP", 10), rooms: num("DUET_ROOMS_PER_IP", 3), longPerDay: 10_000_000, inflight: 8, inflightBytes: 3_000_000 },
	shared: { perMin: 30_000, joins: 2000, seats: Infinity, rooms: Infinity, longPerDay: Infinity, inflight: 400, inflightBytes: 40_000_000 },
	pool: { normal: num("DUET_INFLIGHT_BYTES", 60_000_000), shared: 60_000_000 },
};
// The chat apps' outbound ranges: claude.ai's (published by Anthropic), ChatGPT's connectors (OpenAI
// publishes them at OPENAI_RANGES; fetched at start and daily), and any in DUET_SHARED_RANGES=cidr,cidr.
const OPENAI_RANGES = process.env.DUET_OPENAI_RANGES ?? "https://openai.com/chatgpt-connectors.json";
let shared = rangeList([]);
function rangeList(extra) {
	const b = new BlockList();
	for (const cidr of ["160.79.104.0/21", "2607:6bc0::/48", ...list("DUET_SHARED_RANGES"), ...extra]) {
		const [addr, bits] = String(cidr).split("/");
		try {
			b.addSubnet(addr, Number(bits), isIPv6(addr) ? "ipv6" : "ipv4");
		} catch {} // not a range: skip it
	}
	return b;
}
async function loadOpenAiRanges() {
	if (!OPENAI_RANGES) return;
	try {
		const r = await fetch(OPENAI_RANGES, { signal: AbortSignal.timeout(15_000) });
		// Only narrow ranges: a broad one (a mistake, or a tampered list) would give everyone the wide limits.
		const narrow = (c) => /^[\d.]+\/(1[6-9]|2\d|3[0-2])$/.test(c) || /^[\da-f:]+\/(3[2-9]|[4-9]\d|1[01]\d|12[0-8])$/i.test(c);
		const prefixes = ((await r.json()).prefixes?.map((p) => p.ipv4Prefix ?? p.ipv6Prefix) ?? []).filter((c) => typeof c === "string" && narrow(c));
		if (prefixes.length) shared = rangeList(prefixes.slice(0, 5000));
		console.log(`duet hosted: ${prefixes.length} ChatGPT connector ranges`);
	} catch (e) {
		console.error(`duet hosted: couldn't load ChatGPT's ranges (${e?.name ?? "error"}); they get the normal limits`);
	}
}
// Chat apps call this server from their own servers, which send no Origin; the panel talks to its chat
// app, never to this server. So a browser may call it only from local development tools (the MCP
// Inspector, the ext-apps example host) or origins in DUET_ORIGINS. Stops any web page, or another app's
// panel, from using its visitors' browsers against it, and DNS rebinding.
const ORIGINS = [/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/];
const originOk = (o) => !o || ORIGINS.some((r) => r.test(o)) || list("DUET_ORIGINS").includes(o);

const HOLDS_PER_SEAT = 5; // replies waiting for the user's Send, per panel
const INBOX_MAX = 50;
const PEERS_MAX = 20;
const FULL_MAX = 4000; // a waiting request up to this long goes to the panel whole; longer ones on "Show all"
const HANDED_MAX = 3; // requests a seat keeps after a hand-over, for "Put it back" (counted like waiting text)
const RECENT_MS = 30 * 60_000;
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VIA = { pi: "pi", "claude-code": "Claude Code", codex: "Codex" };
const isRoomCode = (r) => typeof r === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(r);
const isToken = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(t);
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ---------- addresses ----------

// One client address as a key: IPv4 whole, IPv6 by its /64 (one host usually has a whole /64).
function addressKey(ip) {
	const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
	if (v4 || !isIPv6(ip)) return v4 ? v4[1] : ip;
	const [head, tail = ""] = ip.split("::");
	const h = head ? head.split(":") : [];
	const t = tail ? tail.split(":") : [];
	const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
	return full.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
function classOf(ip) {
	const a = ip.replace(/^::ffff:(?=\d+\.)/i, "");
	try {
		return shared.check(a, isIPv6(a) ? "ipv6" : "ipv4") ? LIMIT.shared : LIMIT.normal;
	} catch {
		return LIMIT.normal; // not an address at all
	}
}

const buckets = new Map(); // key -> { n, reset }
function allow(key, max, windowMs, n = 1) {
	const now = Date.now();
	let b = buckets.get(key);
	if (!b || now >= b.reset) buckets.set(key, (b = { n: 0, reset: now + windowMs }));
	b.n += n;
	return b.n <= max;
}

// ---------- rooms: one relay subscription per topic, shared by the seats in it ----------

const rooms = new Map(); // topic -> { sub, seats: Set, up, error }
function openRoom(topic) {
	let r = rooms.get(topic);
	if (r) return r;
	r = { seats: new Set(), up: false, error: "connecting…" };
	r.sub = subscribe({
		server: RELAY,
		topic,
		onEnvelope: (env) => r.seats.forEach((s) => s.onEnvelope(env)),
		onState: (up, error) => {
			[r.up, r.error] = [up, up ? "" : `offline: ${error}`];
			r.seats.forEach((s) => s.rev++);
		},
	});
	rooms.set(topic, r);
	return r;
}
function closeSeat(seat, why = "left") {
	const r = rooms.get(seat.topic);
	seats.delete(seat.key);
	handles.delete(seat.handle);
	holds.drop(seat.key);
	allChars -= seat.chars;
	for (const e of seat.handed.values()) allChars -= e.text.length;
	if (!r) return;
	publish(RELAY, seat.topic, envelope({ fromId: seat.fromId, from: seat.name, kind: "note", note: why })).catch(() => {});
	r.seats.delete(seat);
	if (!r.seats.size) {
		r.sub.stop();
		rooms.delete(seat.topic);
	}
}

// ---------- seats: one per open panel ----------

const seats = new Map(); // sha256(token) -> Seat
const handles = new Map(); // seat handle (for the agent's duet_send) -> Seat
let allChars = 0; // waiting text held, all seats
let longBytes = { n: 0, reset: Date.now() + 86_400_000 }; // long messages sent today, all seats
const holds = makeHolds(); // gate 2: replies waiting for the user's click in the duet card

class Seat {
	constructor(key, topic, name, room, address) {
		Object.assign(this, { key, topic, name, address });
		this.label = shortRoom(room); // the only part of the code kept, and only for a long one
		this.id = randomBytes(6).toString("hex"); // in the panel's rev: a new seat is never "unchanged"
		this.fromId = randomBytes(16).toString("hex");
		this.handle = randomBytes(9).toString("base64url"); // what the agent passes to duet_send
		this.inbox = []; // { pid, id, from, ts, re, text (clean), size }
		this.handed = new Map(); // pid -> request, the last few handed over ("Put it back")
		this.history = []; // previews only
		this.peers = new Map();
		this.peerVia = new Map();
		this.lastFrom = new Map();
		this.sent = new Set(); // our messages' ids, to know a reply when one comes
		this.sends = []; // { at, bytes }
		this.chars = 0;
		this.seq = 0;
		this.rev = 0;
		this.seen = Date.now();
		this.warnings = new Set();
	}
	remember(entry) {
		this.history.push({ at: new Date().toISOString(), ...entry, text: preview(entry.text, 1200) });
		if (this.history.length > 60) this.history.shift();
		this.rev++;
	}
	hold(e) {
		this.inbox.push(e);
		this.chars += e.text.length;
		allChars += e.text.length;
		while (this.inbox.length > INBOX_MAX || this.chars > LIMIT.seatChars) this.drop(this.inbox[0], "older requests were dropped: too many were waiting");
	}
	drop(e, why) {
		this.inbox.splice(this.inbox.indexOf(e), 1);
		this.chars -= e.text.length;
		allChars -= e.text.length;
		if (why) this.warnings.add(why);
	}
	onEnvelope(env) {
		if (!isForMe(env, this.fromId, this.name)) return;
		// Most recently seen last, so a crowd of made-up names pushes out the oldest, not the real peer.
		this.peers.delete(env.from);
		if (this.peers.size >= PEERS_MAX) {
			const old = this.peers.keys().next().value;
			this.peers.delete(old);
			this.peerVia.delete(old);
		}
		this.peers.set(env.from, Date.now());
		if (VIA[env.via]) this.peerVia.set(env.from, env.via);
		if (env.kind === "join") return this.remember({ who: env.from, text: "joined", note: true });
		const pid = String(++this.seq);
		this.remember({ who: env.from, text: env.text, pid });
		this.lastFrom.set(env.from, { id: env.id, at: Date.now() });
		if (this.lastFrom.size > PEERS_MAX) this.lastFrom.delete(this.lastFrom.keys().next().value);
		const text = cleanText(env.text);
		if (allChars + text.length > LIMIT.allChars) return this.warnings.add("a request was dropped: the hosted server is full right now (Claude Code, Codex or pi have no such limit)");
		this.hold({ pid, id: env.id, from: env.from, ts: env.ts, re: env.re, text, size: text.length });
	}
	revNow() {
		const here = [...this.peers.values()].filter((at) => Date.now() - at < RECENT_MS).length;
		return `${this.id}.${this.rev}.${rooms.get(this.topic)?.up ? 1 : 0}.${here}.${holds.waiting(this.key).length}`;
	}
	state() {
		const r = rooms.get(this.topic);
		return {
			hosted: true,
			inRoom: true,
			connected: !!r?.up,
			status: r?.up ? "connected" : (r?.error ?? "offline"),
			room: this.label,
			name: this.name,
			peers: [...this.peers].map(([p, at]) => ({ name: p, via: VIA[this.peerVia.get(p)] ?? "", here: Date.now() - at < RECENT_MS })),
			waiting: this.inbox.map((e) => ({ id: e.pid, from: e.from, at: e.ts, text: e.size <= FULL_MAX ? e.text : preview(e.text), full: e.size <= FULL_MAX, size: e.size })),
			// The conversation: messages only (name · time · text), none of the requests still waiting.
			history: this.history
				.filter((h) => !h.note && !(h.pid && this.inbox.some((e) => e.pid === h.pid)))
				.slice(-40)
				.map((h) => ({ who: h.who, mine: !!h.mine, text: h.text, at: h.at })),
			outgoing: holds.waiting(this.key).map(outgoingItem),
			warnings: [...this.warnings],
			modelNote:
				`duet: your user is in a duet room as ${this.name} (the duet panel in this chat shows it). Requests from the other person's agent reach you only when your user hands one over from the panel. ` +
				`When your user asks you to tell or ask the other agent something, call duet_send with seat "${this.handle}"; your user OKs each reply in the duet card.`,
			rev: this.revNow(),
		};
	}
}
const notInRoom = { hosted: true, inRoom: false, connected: false, status: "", room: "", name: "", peers: [], waiting: [], history: [], outgoing: [], warnings: [], modelNote: "", rev: "out" };

// A panel that stopped polling (closed chat, scrolled away for long) gives its seat back. Only the
// panel keeps a seat alive: the agent's duet_send doesn't.
setInterval(() => {
	const now = Date.now();
	for (const s of [...seats.values()]) if (now - s.seen > LIMIT.seatIdleMs) closeSeat(s, "left");
	for (const [k, b] of buckets) if (now >= b.reset) buckets.delete(k);
}, Math.min(60_000, LIMIT.seatIdleMs)).unref();

// ---------- tools ----------

const sendTool = {
	name: "duet_send",
	description:
		"Send a message to the other person's coding agent in your user's duet room (another developer's agent, on their computer). " +
		"Use it to answer a request your user handed to you from the duet panel, or when your user asks you to tell or ask the other agent something. " +
		"Pass the seat code from the handed-over message (or from the duet note in your context). Your plain-text replies are seen only by your own user. " +
		"Send one complete reply with real results, not progress updates or thank-you messages. " +
		SEND_NOTE,
	inputSchema: {
		type: "object",
		properties: {
			seat: { type: "string", description: 'The seat code duet gave you (in the handed-over message: call duet_send with seat "…").' },
			text: { type: "string", description: "The message: one complete reply, up to ~200 KB." },
			to: { type: "string", description: "Recipient name, if the room has more than one other agent." },
		},
		required: ["seat", "text"],
	},
	annotations: { openWorldHint: true },
	_meta: sendToolMeta,
};

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

// Gate 2: the model's duet_send only holds the reply; the user's Send in the duet card (duet_reply)
// sends it. Every seat exists because a panel was drawn, so this host draws the card too.
function holdReply(a) {
	const seat = handles.get(String(a.seat ?? ""));
	if (!seat) return text("No duet room with that seat code: it may have closed (a panel nobody looked at for 30 minutes leaves its room). Ask your user to open the duet panel and join again.", true);
	if (typeof a.text !== "string" || !a.text) return text("text is required", true);
	if (a.text.length > MAX_TEXT) return text(`The message is ${a.text.length} characters; the limit is ${MAX_TEXT}.`, true);
	const to = a.to ? fitName(String(a.to)) : "";
	const shownTo = toWhom(to, [...seat.peers.keys()]); // exactly who gets it: no `to` goes to the whole room
	const waiting = holds.waiting(seat.key);
	if (!waiting.some((h) => h.text === a.text && h.to === shownTo) && waiting.length >= HOLDS_PER_SEAT) {
		return text(`Not sent: ${HOLDS_PER_SEAT} replies already wait for your user's OK in duet cards.`, true);
	}
	const h = holds.hold(seat.key, shownTo, a.text);
	h.sendTo ??= to;
	seat.rev++;
	return heldResult(h);
}

// The user's Send: out to the relay, within the seat's limits.
async function sendHeld(h) {
	const seat = seats.get(h.owner);
	if (!seat) throw new Error("the duet panel left the room; open it and join again");
	const now = Date.now();
	const peer = h.sendTo ? seat.lastFrom.get(h.sendTo) : [...seat.lastFrom.values()].sort((x, y) => y.at - x.at)[0];
	const re = peer && now - peer.at < 30 * 60_000 ? peer.id : undefined;
	const env = envelope({ fromId: seat.fromId, from: seat.name, kind: "msg", ...(h.sendTo ? { to: h.sendTo } : {}), text: h.text, ...(re ? { re } : {}) });
	// What the relay stores is the envelope as JSON (control characters take 6 bytes there): count that.
	const bytes = Buffer.byteLength(JSON.stringify(env));
	seat.sends = seat.sends.filter((s) => now - s.at < 10 * 60_000);
	if (seat.sends.length >= LIMIT.sendsPerSeat || seat.sends.reduce((n, s) => n + s.bytes, 0) + bytes > LIMIT.seatSendBytes) {
		throw new Error("too many messages from this room in 10 minutes; wait a little");
	}
	const long = bytes > 4000 ? bytes : 0; // over ntfy's 4096 bytes it becomes an attachment on the relay
	if (now >= longBytes.reset) longBytes = { n: 0, reset: now + 86_400_000 };
	const mine = `long ${seat.address}`;
	if (long && (longBytes.n + long > LIMIT.longPerDay || !allow(mine, seat.longPerDay, 86_400_000, long))) {
		throw new Error("the hosted server's allowance for long messages is used up for today; ask for it shorter (under ~3.8 KB)");
	}
	// Counted before the await, so parallel clicks can't slip past the limits; given back if it fails.
	const slot = { at: now, bytes };
	seat.sends.push(slot);
	longBytes.n += long;
	try {
		await publish(RELAY, seat.topic, env);
	} catch (err) {
		seat.sends.splice(seat.sends.indexOf(slot), 1);
		longBytes.n -= long;
		if (long) allow(mine, seat.longPerDay, 86_400_000, -long);
		throw err;
	}
	seat.sent.add(env.id);
	if (seat.sent.size > 100) seat.sent.delete(seat.sent.values().next().value);
	seat.remember({ who: "you", mine: true, text: h.text });
}

async function callTool(name, a, ip) {
	a = a && typeof a === "object" ? a : {};
	if (name === "duet_room") {
		return text(
			"The duet panel is open in the chat. Your user joins a room there: they type the room code into the panel, not into this chat. " +
				"(If no panel shows, this chat app can't draw it: duet's panel works in Claude, ChatGPT, VS Code and Goose.)",
		);
	}
	if (name === "duet_send") return holdReply(a);
	// The card's Send / Don't send: the hold's random id is what it needs (the model never sees it).
	if (name === "duet_reply") {
		const r = await holds.act(a.id, String(a.action ?? ""), sendHeld);
		const owner = seats.get(holds.get(a.id)?.owner);
		if (owner) owner.rev++;
		return r.status === "waiting" && r.error ? { ...panelResult(r), isError: true } : panelResult(r);
	}
	// The panel's own tools: each needs the panel's token.
	if (!appTools.some((t) => t.name === name)) return text(`unknown tool ${name}`, true);
	if (!isToken(a.token)) return panelError("This panel has no id: reload it.");
	const key = sha(a.token);
	let seat = seats.get(key);
	if (seat) seat.seen = Date.now();
	switch (name) {
		case "duet_room_state": {
			if (!seat) return panelResult(notInRoom);
			const rev = seat.revNow();
			return panelResult(a.rev && a.rev === rev ? { unchanged: true, rev } : seat.state());
		}
		case "duet_room_join": {
			const room = String(a.room ?? "").trim();
			const name = String(a.name ?? "").trim();
			if (!isRoomCode(room)) return panelError("A room code is 3-64 letters, digits, . _ -");
			if (!isName(name) || isPlaceholderName(name)) return panelError("Your name: letters, digits, . _ - (up to 40), starting with a letter or digit.");
			const cls = classOf(ip);
			const address = addressKey(ip);
			if (!allow(`join ${address}`, cls.joins, 10 * 60_000)) return panelError("Too many joins from here: wait a few minutes.");
			const topic = topicFor(room); // the code itself goes no further than this line and the label
			if (seat && seat.topic === topic && seat.name === name) return panelResult(seat.state());
			if (seat) closeSeat(seat);
			const full = "The hosted duet is full right now: try again later, or use duet from Claude Desktop, Claude Code, Codex or pi.";
			if (seats.size >= LIMIT.seats) return panelError(full);
			if (!rooms.has(topic) && rooms.size >= LIMIT.rooms) return panelError(full.replace("is full", "has too many rooms open"));
			const fromHere = [...seats.values()].filter((s) => s.address === address);
			if (fromHere.length >= cls.seats) return panelError("Too many duet panels open from here: leave one first.");
			if (!fromHere.some((s) => s.topic === topic) && new Set(fromHere.map((s) => s.topic)).size >= cls.rooms) return panelError("Too many duet rooms open from here: leave one first.");
			// One panel per name in a room, as everywhere in duet: a second one would hand the same requests over again.
			if ([...(rooms.get(topic)?.seats ?? [])].some((s) => s.name.toLowerCase() === name.toLowerCase())) {
				return panelError(`${name} is already in this room in another chat: leave it there first, or use another name.`);
			}
			seat = new Seat(key, topic, name, room, address);
			seat.longPerDay = cls.longPerDay;
			seats.set(key, seat);
			handles.set(seat.handle, seat);
			openRoom(topic).seats.add(seat);
			publish(RELAY, topic, envelope({ fromId: seat.fromId, from: name, kind: "join" })).catch(() => {});
			return panelResult(seat.state());
		}
		case "duet_room_leave": {
			if (seat) closeSeat(seat);
			return panelResult(notInRoom);
		}
		case "duet_read": {
			const e = seat?.inbox.find((m) => m.pid === String(a.id));
			return e ? panelResult({ id: e.pid, text: e.text }) : panelError("That request isn't waiting any more.");
		}
		case "duet_take":
		case "duet_ignore": {
			if (!seat) return panelError("Not in a room.");
			if (name === "duet_take" && a.undo === true) {
				const back = seat.handed.get(String(a.id));
				if (!back) return panelError("Nothing to put back.");
				seat.handed.delete(back.pid);
				allChars -= back.text.length;
				seat.hold(back);
				seat.inbox.unshift(seat.inbox.pop()); // back in front
				seat.remember({ who: "", text: `${back.from}'s request is waiting again`, note: true });
				return panelResult(seat.state());
			}
			const e = seat.inbox.find((m) => m.pid === String(a.id));
			if (!e) return panelError("That request isn't waiting any more: it was handed over or ignored already.");
			seat.drop(e);
			if (name === "duet_ignore") {
				publish(RELAY, seat.topic, envelope({ fromId: seat.fromId, from: seat.name, kind: "note", note: "declined", to: e.from })).catch(() => {});
				seat.remember({ who: "", text: `you didn't take ${e.from}'s request`, note: true });
				return panelResult(seat.state());
			}
			seat.handed.set(e.pid, e);
			allChars += e.text.length;
			if (seat.handed.size > HANDED_MAX) {
				const [old] = seat.handed.values();
				seat.handed.delete(old.pid);
				allChars -= old.text.length;
			}
			seat.remember({ who: "", text: `you handed ${e.from}'s request to your agent`, note: true });
			return panelResult({ text: handOver(e, { reply: !!(e.re && seat.sent.has(e.re)), seat: seat.handle, utc: true }) });
		}
	}
	return text(`unknown tool ${name}`, true);
}

// ---------- MCP over Streamable HTTP (JSON responses only) ----------

const instructions =
	"duet connects your user with another developer's coding agent through a shared room. The duet panel (duet_room) shows the room; " +
	"your user hands you a request from the other agent with a click, and you answer it with duet_send (your user OKs the reply in the duet card). Your plain-text replies reach only your own user.";

async function rpc(msg, ip) {
	const { id, method, params } = msg ?? {};
	if (id === undefined || id === null || typeof method !== "string") return null; // notifications and stray responses
	const ok = (result) => ({ jsonrpc: "2.0", id, result });
	const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
	try {
		switch (method) {
			case "initialize":
				// Which chat apps connect and whether they draw panels: the app's name only, nothing of the user.
				console.log(`duet hosted: initialize from ${String(params?.clientInfo?.name ?? "?").replace(/[^\w .-]/g, "").slice(0, 40)}, ${params?.capabilities?.extensions?.["io.modelcontextprotocol/ui"] ? "draws panels" : "no MCP Apps capability"}`);
				return ok({
					protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
					capabilities: { tools: {}, resources: {} },
					serverInfo: { name: "duet", title: "duet", version: VERSION },
					instructions,
				});
			case "ping":
				return ok({});
			case "tools/list":
				return ok({ tools: [roomTool, sendTool, ...appTools] });
			case "resources/list":
				return ok({ resources: resourceEntries });
			case "resources/templates/list":
				return ok({ resourceTemplates: [] });
			case "resources/read":
				return resourceContents(params?.uri, VERSION) ? ok(resourceContents(params.uri, VERSION)) : err(-32002, "resource not found");
			case "tools/call":
				return ok(await callTool(String(params?.name ?? ""), params?.arguments, ip));
			default:
				return err(-32601, `method not found: ${method}`);
		}
	} catch (e) {
		console.error(`duet hosted: ${method} failed: ${e?.name ?? "error"}`); // no arguments, no message text
		return err(-32603, "internal error");
	}
}

const CORS = {
	"access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
	"access-control-allow-headers": "content-type, accept, mcp-session-id, mcp-protocol-version, authorization",
	"access-control-expose-headers": "mcp-session-id",
	vary: "origin",
};
// Behind Caddy on the same box: the client is the last address Caddy put in X-Forwarded-For (Caddy
// replaces a client's own X-Forwarded-For unless it trusts that client).
const clientIp = (req) => {
	const peer = req.socket.remoteAddress ?? "";
	const fwd = /^(::ffff:)?127\.|^::1$/.test(peer) ? String(req.headers["x-forwarded-for"] ?? "").split(",").pop().trim() : "";
	return fwd || peer;
};
const landing = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>duet MCP server</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#222;background:#fff}@media(prefers-color-scheme:dark){body{color:#eee;background:#161616}}code{background:#8882;padding:1px 5px;border-radius:4px}</style>
<h1>duet MCP server</h1><p>This is duet's hosted MCP server: the duet panel for claude.ai, the Claude apps and ChatGPT. Add <code>${PUBLIC_URL}/mcp</code> as a custom connector; steps on <a href="https://qaioz.github.io/pi-duet/">the duet website</a>.</p>
<p>It keeps no accounts and stores nothing on disk. Room codes are hashed as soon as a panel joins; messages stay in memory only while the panel is open. Two clicks: a request reaches your agent only when you hand it over, and its reply leaves only when you click <b>Send</b>.</p>`;

const inflight = new Map(); // address -> { n, bytes }: requests being read
const poolBytes = { normal: 0, shared: 0 };

export function handler(req, res) {
	const url = new URL(req.url ?? "/", "http://x");
	const ip = clientIp(req);
	const address = addressKey(ip);
	const cls = classOf(ip);
	const origin = req.headers.origin;
	if (!originOk(origin)) return res.writeHead(403, { "content-type": "text/plain" }).end("origin not allowed\n");
	const cors = origin ? { ...CORS, "access-control-allow-origin": origin } : CORS;
	if (!allow(`ip ${address}`, cls.perMin, 60_000)) return res.writeHead(429, { ...cors, "retry-after": "30", "content-type": "text/plain" }).end("too many requests\n");
	if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
	if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION }));
	if (url.pathname === "/" && req.method === "GET") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(landing);
	if (url.pathname !== "/mcp") return res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
	// No server-to-client stream (GET) and no sessions to end (DELETE): the panel polls.
	if (req.method === "GET") return res.writeHead(405, { ...cors, allow: "POST, DELETE" }).end();
	if (req.method === "DELETE") return res.writeHead(200, cors).end();
	if (req.method !== "POST") return res.writeHead(405, { ...cors, allow: "POST, DELETE" }).end();
	const pool = cls === LIMIT.shared ? "shared" : "normal";
	const mine = inflight.get(address) ?? { n: 0, bytes: 0 };
	if (mine.n >= cls.inflight) return res.writeHead(429, { ...cors, "retry-after": "5" }).end();
	mine.n++;
	inflight.set(address, mine);
	let size = 0;
	let done = false;
	const finish = () => {
		if (done) return;
		done = true;
		clearTimeout(slow);
		mine.bytes -= size;
		poolBytes[pool] -= size;
		if (--mine.n <= 0) inflight.delete(address);
	};
	res.on("close", finish);
	const slow = setTimeout(() => {
		if (!res.headersSent) res.writeHead(408, cors).end();
		finish();
		req.destroy();
	}, LIMIT.bodyMs);
	const chunks = [];
	req.on("data", (c) => {
		if (done) return;
		size += c.length;
		mine.bytes += c.length;
		poolBytes[pool] += c.length;
		if (size > LIMIT.bodyBytes || mine.bytes > cls.inflightBytes || poolBytes[pool] > LIMIT.pool[pool]) {
			res.writeHead(size > LIMIT.bodyBytes ? 413 : 503, cors).end();
			finish();
			req.destroy();
		} else chunks.push(c);
	});
	req.on("end", async () => {
		clearTimeout(slow);
		if (res.writableEnded) return;
		let body;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			return res.writeHead(400, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
		} finally {
			chunks.length = 0;
		}
		const batch = Array.isArray(body);
		const messages = batch ? body : [body];
		if (messages.length > LIMIT.batch) return res.writeHead(400, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `at most ${LIMIT.batch} messages per request` } }));
		// Each message in a batch counts against the address's limit, like a request of its own.
		if (messages.length > 1 && !allow(`ip ${address}`, cls.perMin, 60_000, messages.length - 1)) return res.writeHead(429, { ...cors, "retry-after": "30" }).end();
		const out = [];
		for (const m of messages) {
			const r = await rpc(m, ip); // one at a time: a batch can't run its sends in parallel
			if (r) out.push(r);
		}
		if (!out.length) return res.writeHead(202, cors).end(); // only notifications or responses
		res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify(batch ? out : out[0]));
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const server = createServer(handler);
	server.requestTimeout = 15_000;
	server.headersTimeout = 10_000;
	server.listen(PORT, HOST, () => console.log(`duet hosted MCP server ${VERSION} on http://${HOST}:${server.address().port}/mcp (relay ${RELAY})`));
	loadOpenAiRanges();
	setInterval(loadOpenAiRanges, 86_400_000).unref();
	for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => {
		for (const seat of [...seats.values()]) closeSeat(seat);
		setTimeout(() => process.exit(0), 300).unref();
	});
}
