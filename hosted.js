#!/usr/bin/env node
// The hosted duet server: the duet panel (panel.js) for chat apps that can only reach a public HTTPS
// MCP server (claude.ai on the web and mobile, Cowork, ChatGPT). MCP over Streamable HTTP, answered
// as plain JSON (no server-to-client stream: a panel polls). No dependencies, like mcp.js.
//
//   node hosted.js            PORT (8092), HOST (127.0.0.1), DUET_SERVER (relay, https://duet.gaioz.online)
//
// Each open panel has a seat: its own room, name, inbox and history, found by a random token the
// panel makes for itself (hosts don't reliably keep one MCP session per conversation). What the server
// holds, and only in memory:
//   - per seat: the room's topic hash (never the room code: it is hashed at join and dropped), the
//     name, the messages since the seat joined, and a short "seat" handle the agent's duet_send uses;
//   - nothing on disk, and no log line with a room, a token, a name or a message.
// The relay sees every message in plain text (as for every duet client: F12); this server sees the
// messages of the rooms its panels are in, while they are open.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { appTools, handOver, PANEL_URI, panelResult, preview, resourceContents, resourceEntry, roomTool } from "./panel.js";
import { envelope, firstLine, isForMe, isName, isPlaceholderName, isRelayUrl, MAX_TEXT, publish, subscribe, topicFor } from "./transport.js";

export const VERSION = "0.7.0"; // the MCP server's version, as in mcp.js
const PORT = Number(process.env.PORT ?? 8092); // 0: any free port (tests)
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://mcp-duet.gaioz.online").replace(/\/+$/, "");
const RELAY = (process.env.DUET_SERVER || "https://duet.gaioz.online").replace(/\/+$/, "");
if (!isRelayUrl(RELAY)) throw new Error(`DUET_SERVER must be an http(s) URL, got ${JSON.stringify(RELAY)}`);
const num = (k, d) => Number(process.env[k]) || d;
// Limits. Tool calls from claude.ai and ChatGPT come from their own servers, so one IP can carry
// many users: the per-IP limits are wide, and the seat and room caps bound the rest.
const LIMIT = {
	seats: num("DUET_MAX_SEATS", 300), // open panels in rooms
	rooms: num("DUET_MAX_ROOMS", 50), // distinct rooms: one relay subscription each (the relay allows 60 per IP)
	seatIdleMs: num("DUET_SEAT_IDLE_MS", 30 * 60_000), // a panel that stops polling leaves after this
	ipPerMin: num("DUET_IP_PER_MIN", 1200), // requests per IP per minute
	joinsPerIp: num("DUET_JOINS_PER_IP", 30), // joins per IP per 10 minutes
	sendsPerSeat: num("DUET_SENDS_PER_SEAT", 30), // messages a seat sends per 10 minutes
	bodyBytes: 1_100_000, // one request: a 200 000-character message fits
};
const MAX_AUTO = 8; // replies without a click before the agent must check with its user (as in mcp.js)
const INBOX_MAX = 50;
const RECENT_MS = 30 * 60_000;
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VIA = { pi: "pi", "claude-code": "Claude Code", codex: "Codex" };
const isRoomCode = (r) => typeof r === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(r);
const isToken = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(t);
const sha = (s) => createHash("sha256").update(s).digest("hex");

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
		onState: (up, error) => ([r.up, r.error] = [up, up ? "" : `offline: ${error}`]),
	});
	rooms.set(topic, r);
	return r;
}
function closeSeat(seat, why = "left") {
	const r = rooms.get(seat.topic);
	seats.delete(seat.key);
	handles.delete(seat.handle);
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

class Seat {
	constructor(key, topic, name) {
		Object.assign(this, { key, topic, name });
		this.fromId = randomBytes(16).toString("hex");
		this.handle = randomBytes(9).toString("base64url"); // what the agent passes to duet_send
		this.inbox = [];
		this.history = [];
		this.peers = new Map();
		this.peerVia = new Map();
		this.lastFrom = new Map();
		this.sent = new Map();
		this.sends = [];
		this.exchanges = 0;
		this.seq = 0;
		this.seen = Date.now();
		this.dropped = 0;
	}
	remember(entry) {
		this.history.push({ at: new Date().toISOString(), ...entry });
		if (this.history.length > 60) this.history.shift();
	}
	onEnvelope(env) {
		if (!isForMe(env, this.fromId, this.name)) return;
		this.peers.set(env.from, Date.now());
		if (VIA[env.via]) this.peerVia.set(env.from, env.via);
		if (env.kind === "join") return this.remember({ who: env.from, text: "joined", note: true });
		this.remember({ who: env.from, text: env.text });
		this.lastFrom.set(env.from, { id: env.id, at: Date.now() });
		this.inbox.push({ ...env, pid: String(++this.seq) });
		if (this.inbox.length > INBOX_MAX) {
			this.inbox.shift();
			this.dropped++;
		}
	}
	state() {
		const r = rooms.get(this.topic);
		const s = {
			hosted: true,
			inRoom: true,
			connected: !!r?.up,
			status: r?.up ? "connected" : (r?.error ?? "offline"),
			room: this.label,
			name: this.name,
			peers: [...this.peers].map(([p, at]) => ({ name: p, via: VIA[this.peerVia.get(p)] ?? "", here: Date.now() - at < RECENT_MS })),
			waiting: this.inbox.map((e) => ({ id: e.pid, from: e.from, at: e.ts, text: preview(e.text), size: e.text.length })),
			history: this.history.slice(-40).map((h) => ({ who: h.who, mine: !!h.mine, text: preview(h.text, 1200), at: h.at, note: !!h.note })),
			warnings: this.dropped ? [`${this.dropped} older request(s) dropped: more than ${INBOX_MAX} were waiting`] : [],
			modelNote:
				`duet: your user is in a duet room as ${this.name} (the duet panel in this chat shows it). Requests from the other person's agent reach you only when your user hands one over from the panel. ` +
				`When your user asks you to tell or ask the other agent something, call duet_send with seat "${this.handle}".`,
		};
		const last = this.history.at(-1);
		s.rev = sha(JSON.stringify([s.status, s.peers, s.waiting.map((w) => w.id), this.history.length, last?.at, last?.text?.length, s.warnings])).slice(0, 16);
		return s;
	}
}
const notInRoom = { hosted: true, inRoom: false, connected: false, status: "", room: "", name: "", peers: [], waiting: [], history: [], warnings: [], modelNote: "", rev: "out" };

// ---------- limits ----------

const buckets = new Map(); // key -> { n, reset }
function allow(key, max, windowMs) {
	const now = Date.now();
	let b = buckets.get(key);
	if (!b || now >= b.reset) buckets.set(key, (b = { n: 0, reset: now + windowMs }));
	return ++b.n <= max;
}

// A panel that stopped polling (closed chat, scrolled away for long) gives its seat back.
setInterval(() => {
	const now = Date.now();
	for (const s of [...seats.values()]) if (now - s.seen > LIMIT.seatIdleMs) closeSeat(s, "left");
	for (const [k, b] of buckets) if (now >= b.reset) buckets.delete(k);
}, 60_000).unref();

// ---------- tools ----------

const sendTool = {
	name: "duet_send",
	description:
		"Send a message to the other person's coding agent in your user's duet room (another developer's agent, on their computer). " +
		"Use it to answer a request your user handed to you from the duet panel, or when your user asks you to tell or ask the other agent something. " +
		"Pass the seat code from the handed-over message (or from the duet note in your context). Your plain-text replies are seen only by your own user. " +
		"Send one complete reply with real results, not progress updates or thank-you messages.",
	inputSchema: {
		type: "object",
		properties: {
			seat: { type: "string", description: 'The seat code duet gave you (in the handed-over message: call duet_send with seat "…").' },
			text: { type: "string", description: "The message: one complete reply, up to ~200 KB." },
			to: { type: "string", description: "Recipient name, if the room has more than one other agent." },
			user_asked: { type: "boolean", description: "true only if your own user's latest message asked for this send." },
		},
		required: ["seat", "text"],
	},
	annotations: { openWorldHint: true },
};

const fail = (error) => ({ ...panelResult({ error }), isError: true });
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

async function callTool(name, a, ip) {
	a = a && typeof a === "object" ? a : {};
	if (name === "duet_room") {
		return text("The duet panel is open in the chat. Your user joins a room there: they type the room code into the panel, not into this chat.");
	}
	if (name === "duet_send") {
		const seat = handles.get(String(a.seat ?? ""));
		if (!seat) return text("No duet room with that seat code: it may have closed (a panel nobody looked at for 30 minutes leaves its room). Ask your user to open the duet panel and join again.", true);
		seat.seen = Date.now();
		if (typeof a.text !== "string" || !a.text) return text("text is required", true);
		if (a.text.length > MAX_TEXT) return text(`The message is ${a.text.length} characters; the limit is ${MAX_TEXT}.`, true);
		const userAsked = a.user_asked === true;
		if (!userAsked && seat.exchanges >= MAX_AUTO) {
			return text(`Not sent: auto-reply limit. ${MAX_AUTO} replies have gone to the other agent since your user last handed one over. Ask your user whether to continue; only if they say so, send again with user_asked: true.`, true);
		}
		const now = Date.now();
		seat.sends = seat.sends.filter((t) => now - t < 10 * 60_000);
		if (seat.sends.length >= LIMIT.sendsPerSeat) return text("Not sent: too many messages from this room in 10 minutes. Wait a little.", true);
		const peer = a.to ? seat.lastFrom.get(String(a.to)) : [...seat.lastFrom.values()].sort((x, y) => y.at - x.at)[0];
		const re = peer && now - peer.at < 30 * 60_000 ? peer.id : undefined;
		const env = envelope({ fromId: seat.fromId, from: seat.name, kind: "msg", ...(a.to ? { to: String(a.to) } : {}), text: a.text, ...(re ? { re } : {}) });
		try {
			await publish(RELAY, seat.topic, env);
		} catch (err) {
			return text(String(err.message), true);
		}
		seat.sends.push(now);
		seat.exchanges = userAsked ? 0 : seat.exchanges + 1;
		seat.sent.set(env.id, firstLine(a.text));
		if (seat.sent.size > 100) seat.sent.delete(seat.sent.keys().next().value);
		seat.remember({ who: "you", mine: true, text: a.text });
		return text("sent — the other agent has not answered yet; your user will see its reply in the duet panel");
	}
	// The panel's own tools: each needs the panel's token.
	if (!appTools.some((t) => t.name === name)) return text(`unknown tool ${name}`, true);
	if (!isToken(a.token)) return fail("This panel has no id: reload it.");
	const key = sha(a.token);
	let seat = seats.get(key);
	if (seat) seat.seen = Date.now();
	switch (name) {
		case "duet_room_state": {
			if (!seat) return panelResult(notInRoom);
			const s = seat.state();
			return panelResult(a.rev && a.rev === s.rev ? { unchanged: true, rev: s.rev } : s);
		}
		case "duet_room_join": {
			const room = String(a.room ?? "").trim();
			const name = String(a.name ?? "").trim();
			if (!isRoomCode(room)) return fail("A room code is 3-64 letters, digits, . _ -");
			if (!isName(name) || isPlaceholderName(name)) return fail("Your name: letters, digits, . _ - (up to 40), starting with a letter or digit.");
			if (!allow(`join ${ip}`, LIMIT.joinsPerIp, 10 * 60_000)) return fail("Too many joins from here: wait a few minutes.");
			const topic = topicFor(room); // the code itself goes no further than this line
			if (seat && seat.topic === topic && seat.name === name) return panelResult(seat.state());
			if (seat) closeSeat(seat);
			if (seats.size >= LIMIT.seats) return fail("The hosted duet is full right now: try again later, or use duet from Claude Code, Codex or pi.");
			if (!rooms.has(topic) && rooms.size >= LIMIT.rooms) return fail("The hosted duet has too many rooms open right now: try again later, or use duet from Claude Code, Codex or pi.");
			seat = new Seat(key, topic, name);
			seat.label = `${room.slice(0, 4)}…`;
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
		case "duet_take":
		case "duet_ignore": {
			if (!seat) return fail("Not in a room.");
			const i = seat.inbox.findIndex((e) => e.pid === String(a.id));
			if (i < 0) return fail("That request isn't waiting any more: it was handed over or ignored already.");
			const [e] = seat.inbox.splice(i, 1);
			if (name === "duet_ignore") {
				publish(RELAY, seat.topic, envelope({ fromId: seat.fromId, from: seat.name, kind: "note", note: "declined", to: e.from })).catch(() => {});
				seat.remember({ who: "", text: `you didn't take ${e.from}'s request`, note: true });
				return panelResult(seat.state());
			}
			seat.exchanges = 0; // the user's click: they are here
			seat.remember({ who: "", text: `you handed ${e.from}'s request to your agent`, note: true });
			return panelResult({ text: handOver(e, { reply: e.re && seat.sent.has(e.re) ? seat.sent.get(e.re) : "", seat: seat.handle }) });
		}
	}
	return text(`unknown tool ${name}`, true);
}

// ---------- MCP over Streamable HTTP (JSON responses only) ----------

const instructions =
	"duet connects your user with another developer's coding agent through a shared room. The duet panel (duet_room) shows the room; " +
	"your user hands you a request from the other agent with a click, and you answer it with duet_send. Your plain-text replies reach only your own user.";

async function rpc(msg, ip) {
	const { id, method, params } = msg ?? {};
	if (id === undefined || id === null || typeof method !== "string") return null; // notifications and stray responses
	const ok = (result) => ({ jsonrpc: "2.0", id, result });
	const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
	try {
		switch (method) {
			case "initialize":
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
				return ok({ resources: [resourceEntry] });
			case "resources/templates/list":
				return ok({ resourceTemplates: [] });
			case "resources/read":
				return params?.uri === PANEL_URI ? ok(resourceContents(VERSION)) : err(-32002, "resource not found");
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
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
	"access-control-allow-headers": "content-type, accept, mcp-session-id, mcp-protocol-version, authorization",
	"access-control-expose-headers": "mcp-session-id",
};
// Behind Caddy on the same box: the client is the last address Caddy put in X-Forwarded-For.
const clientIp = (req) => {
	const peer = req.socket.remoteAddress ?? "";
	const fwd = /^(::ffff:)?127\.|^::1$/.test(peer) ? String(req.headers["x-forwarded-for"] ?? "").split(",").pop().trim() : "";
	return fwd || peer;
};
const landing = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>duet MCP server</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#222;background:#fff}@media(prefers-color-scheme:dark){body{color:#eee;background:#161616}}code{background:#8882;padding:1px 5px;border-radius:4px}</style>
<h1>duet MCP server</h1><p>This is duet's hosted MCP server: the duet panel for claude.ai, the Claude apps and ChatGPT. Add <code>${PUBLIC_URL}/mcp</code> as a custom connector; steps on <a href="https://qaioz.github.io/pi-duet/">the duet website</a>.</p>
<p>It keeps no accounts and stores nothing on disk. Room codes are hashed as soon as a panel joins; messages stay in memory only while the panel is open. A request reaches your agent only when you click <b>Hand to agent</b>, and nothing guards what the agent does with it.</p>`;

export function handler(req, res) {
	const url = new URL(req.url ?? "/", "http://x");
	const ip = clientIp(req);
	if (!allow(`ip ${ip}`, LIMIT.ipPerMin, 60_000)) return res.writeHead(429, { ...CORS, "retry-after": "30", "content-type": "text/plain" }).end("too many requests\n");
	if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
	if (url.pathname === "/healthz") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION, seats: seats.size, rooms: rooms.size }));
	if (url.pathname === "/" && req.method === "GET") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(landing);
	if (url.pathname !== "/mcp") return res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
	// No server-to-client stream (GET) and no sessions to end (DELETE): the panel polls.
	if (req.method === "GET") return res.writeHead(405, { ...CORS, allow: "POST, DELETE" }).end();
	if (req.method === "DELETE") return res.writeHead(200, CORS).end();
	if (req.method !== "POST") return res.writeHead(405, { ...CORS, allow: "POST, DELETE" }).end();
	let size = 0;
	const chunks = [];
	req.on("data", (c) => {
		size += c.length;
		if (size > LIMIT.bodyBytes) {
			res.writeHead(413, CORS).end();
			req.destroy();
		} else chunks.push(c);
	});
	req.on("end", async () => {
		if (res.writableEnded) return;
		let body;
		try {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			return res.writeHead(400, { ...CORS, "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
		}
		const batch = Array.isArray(body);
		const out = (await Promise.all((batch ? body : [body]).slice(0, 20).map((m) => rpc(m, ip)))).filter(Boolean);
		if (!out.length) return res.writeHead(202, CORS).end(); // only notifications or responses
		res.writeHead(200, { ...CORS, "content-type": "application/json" }).end(JSON.stringify(batch ? out : out[0]));
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const server = createServer(handler);
	server.requestTimeout = 30_000;
	server.headersTimeout = 15_000;
	server.listen(PORT, HOST, () => console.log(`duet hosted MCP server ${VERSION} on http://${HOST}:${server.address().port}/mcp (relay ${RELAY})`));
	for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => {
		for (const seat of [...seats.values()]) closeSeat(seat);
		setTimeout(() => process.exit(0), 300).unref();
	});
}
