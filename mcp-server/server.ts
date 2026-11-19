// duet MCP server: a second door into chat-lab rooms, for any MCP client (spec 2026-07-28, SDK v2).
//
// The owner's browser hands a join ticket to POST /agents; we make the agent's Matrix account, join the
// room and answer with the agent's own MCP URL, /mcp/a/<secret>. Whoever adds that URL to a client speaks
// as that agent. The secret is the key: we keep only its hash.
//
// Listening. Each agent has one Matrix /sync loop here and an inbox with a delivery cursor, so nothing is
// lost while its client is busy. wait_for_room hands over what's new; when nothing is, it answers with a
// task (Tasks extension) that completes when a message arrives: Claude Code then wakes by itself. A client
// without the extension gets a call that blocks until a message comes, or 4 minutes pass. Each room is
// also a resource whose updates go to subscribed clients (subscriptions/listen), for hosts that use them.
//
// No gates: an MCP server can't see a client's permission prompts. The duet mod keeps those.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import { CTL, SEAT, controlAlias, filterNone, readTicket, replyContent, requestFrom, roomAlias, serverNameOf, membershipFrom, POWER_EVENTS, type Ticket } from "../claude-code/hooks/matrix.ts";
import { cleanName, sanitize, timeOf, type Request } from "../claude-code/hooks/text.ts";
import { ROOM_HTML, ROOM_URI, SEND_HTML, SEND_URI, UI_MIME } from "./ui.ts";

const PORT = Number(process.env.PORT || 8820);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/+$/, "");
const MATRIX_URL = process.env.MATRIX_URL?.replace(/\/+$/, ""); // our homeserver as this process reaches it; else the ticket's
const REG_TOKEN = process.env.DUET_MATRIX_TOKEN || "chatlab-dev-token";
const STORE = process.env.STORE || new URL("./agents.json", import.meta.url).pathname;
const APP = "MCP";
const TASKS = "io.modelcontextprotocol/tasks";
const WAIT_BLOCK_MS = 4 * 60_000; // no tasks extension: how long one wait_for_room holds
const BATCH_MAX = 50;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- agents (kept on disk) ----------

// An agent starts "pending": only a link, nothing in Matrix. The first MCP request from an app makes it
// (account, room, seat, control room) and names it after that app; until then nobody sees it.
type Agent = {
	id: string; key: string; // key = sha256 of the URL secret
	ownerKey?: string; // sha256 of the ticket's control secret: the owner's browser proves it with the ticket
	state?: "pending" | "active"; created?: number; pending?: Ticket; app?: string;
	name: string; owner: string; ownerId: string; room: string; // room = chat-lab's room code
	server: string; userId: string; token: string; roomId: string; ctlRoomId?: string; since: string;
};
const LINK_TTL_MS = 30 * 60_000;
const isPending = (a: Agent) => a.state === "pending";
const expired = (a: Agent) => isPending(a) && Date.now() - (a.created ?? 0) > LINK_TTL_MS;
const VERSION = "0.1.0";
const filterRooms = (a: Agent) =>
	JSON.stringify({ room: { rooms: [a.roomId, ...(a.ctlRoomId ? [a.ctlRoomId] : [])], timeline: { limit: 100 }, state: { lazy_load_members: false } }, presence: { not_types: ["*"] }, account_data: { not_types: ["*"] } });
type Live = {
	a: Agent;
	inbox: (Request & { seq: number })[]; seq: number; delivered: number;
	names: Map<string, string>; seats: Map<string, any>;
	waiters: Set<() => void>; stopped: boolean;
	handled: Set<string>; // requests the owner answered or ignored in the panel
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const agents = new Map<string, Agent>();
const live = new Map<string, Live>();
try {
	for (const a of JSON.parse(readFileSync(STORE, "utf8")) as Agent[]) agents.set(a.id, a);
} catch {}
let saveTimer: NodeJS.Timeout | null = null;
function save() {
	saveTimer ??= setTimeout(() => {
		saveTimer = null;
		writeFileSync(STORE + ".tmp", JSON.stringify([...agents.values()], null, 1), { mode: 0o600 });
		renameSync(STORE + ".tmp", STORE);
	}, 200);
}
const bySecret = (secret: string) => [...agents.values()].find((a) => a.key === sha(secret));

// ---------- Matrix ----------

class MxError extends Error {
	status: number;
	body: any;
	constructor(status: number, body: any) {
		super(`${body?.errcode || "HTTP " + status}: ${body?.error || "request failed"}`);
		this.status = status;
		this.body = body;
	}
}
const enc = encodeURIComponent;
async function mx(base: string, method: string, path: string, o: { token?: string; body?: unknown; timeoutMs?: number } = {}) {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (o.token) headers.Authorization = `Bearer ${o.token}`;
	const res = await fetch(base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
	const text = await res.text();
	let json: any = {};
	try { json = text ? JSON.parse(text) : {}; } catch {}
	if (!res.ok) throw new MxError(res.status, json);
	return json;
}

async function register(base: string, owner: string, agent: string) {
	const local = (owner.toLowerCase().replace(/[^a-z0-9._=-]/g, "") || "user") + "s-mcp-" + randomBytes(3).toString("hex");
	const req = { username: local, password: randomBytes(24).toString("base64url"), initial_device_display_name: "duet MCP server" };
	let res: any;
	try {
		res = await mx(base, "POST", "/_matrix/client/v3/register", { body: req });
	} catch (err: any) {
		if (err?.status !== 401) throw err;
		res = await mx(base, "POST", "/_matrix/client/v3/register", { body: { ...req, auth: { type: "m.login.registration_token", token: REG_TOKEN, session: err.body?.session } } });
	}
	await mx(base, "PUT", `/_matrix/client/v3/profile/${enc(res.user_id)}/displayname`, { token: res.access_token, body: { displayname: agent } });
	return { userId: res.user_id as string, token: res.access_token as string };
}

// Join the room for this code, or make it (as the duet mod does).
async function joinRoom(base: string, token: string, alias: string): Promise<string> {
	try {
		return (await mx(base, "POST", `/_matrix/client/v3/join/${enc(alias)}`, { token, body: {} })).room_id;
	} catch (err: any) {
		if (err?.body?.errcode !== "M_NOT_FOUND") throw err;
	}
	const { room_id } = await mx(base, "POST", "/_matrix/client/v3/createRoom", {
		token,
		body: { name: "chat-lab room", preset: "public_chat", power_level_content_override: { events: POWER_EVENTS }, initial_state: [{ type: "m.room.history_visibility", state_key: "", content: { history_visibility: "shared" } }] },
	});
	await mx(base, "PUT", `/_matrix/client/v3/directory/room/${enc(alias)}`, { token, body: { room_id } });
	return room_id;
}

// The link only. One per ticket: a second request for the same ticket replaces a link no app used yet.
function createLink(t: Ticket): { agent: Agent; secret: string } {
	const ownerKey = sha(t.secret);
	for (const [id, x] of agents) if (x.ownerKey === ownerKey && isPending(x)) agents.delete(id);
	const secret = randomBytes(24).toString("base64url");
	const agent: Agent = {
		id: randomBytes(6).toString("hex"), key: sha(secret), ownerKey, state: "pending", created: Date.now(), pending: t,
		name: t.agent, owner: t.owner, ownerId: t.ownerId, room: t.room, server: MATRIX_URL || t.server, userId: "", token: "", roomId: "", since: "",
	};
	agents.set(agent.id, agent);
	save();
	return { agent, secret };
}

// Which app is calling, from the request's clientInfo (2026-07-28: in _meta; earlier: initialize's params).
function clientInfoOf(msg: any): { name?: string; title?: string; version?: string } {
	const m = Array.isArray(msg) ? msg[0] : msg;
	return m?.params?._meta?.["io.modelcontextprotocol/clientInfo"] ?? m?.params?.clientInfo ?? {};
}
function appNameOf(ci: { name?: string; title?: string }): string {
	const s = `${ci.name ?? ""} ${ci.title ?? ""}`.toLowerCase();
	if (/claude[-_ ]?code/.test(s)) return "Claude Code";
	if (/chatgpt|openai/.test(s)) return "ChatGPT";
	if (/codex/.test(s)) return "Codex";
	if (/cursor/.test(s)) return "Cursor";
	if (/vs ?code|visual studio code|copilot/.test(s)) return "VS Code";
	if (/claude|anthropic/.test(s)) return "Claude";
	const raw = cleanName(String(ci.title || ci.name || "")).slice(0, 30).trim();
	return raw || "AI app";
}

// The first request from an app: now the agent becomes real, named after that app.
const activating = new Map<string, Promise<void>>();
function activate(a: Agent, ci: { name?: string; title?: string; version?: string }): Promise<void> {
	let p = activating.get(a.id);
	if (p) return p;
	p = (async () => {
		const t = a.pending!;
		const app = appNameOf(ci);
		const name = `${t.owner}'s ${app}`;
		log("agent", a.id, "connected from", JSON.stringify(ci), "→", name);
		const base = a.server;
		const acct = await register(base, t.owner, name);
		const since = (await mx(base, "GET", `/_matrix/client/v3/sync?timeout=0&filter=${enc(filterNone)}`, { token: acct.token })).next_batch;
		const roomId = await joinRoom(base, acct.token, await roomAlias(t.room, serverNameOf(acct.userId)));
		await mx(base, "PUT", `/_matrix/client/v3/rooms/${enc(roomId)}/state/${SEAT}/${enc(acct.userId)}`, { token: acct.token, body: { kind: "agent", owner: t.owner, ownerId: t.ownerId, app } });
		// The owner's private control room (PROTOCOL.md): our hello there makes their browser pin and lock it.
		let ctlRoomId: string | undefined;
		try {
			ctlRoomId = (await mx(base, "POST", `/_matrix/client/v3/join/${enc(await controlAlias(t.secret, serverNameOf(acct.userId)))}`, { token: acct.token, body: {} })).room_id;
		} catch (err: any) {
			log("control room:", err.message, "· no private thread");
		}
		Object.assign(a, { state: "active", app, name, userId: acct.userId, token: acct.token, roomId, ctlRoomId, since });
		delete a.pending;
		save();
	})().finally(() => activating.delete(a.id));
	activating.set(a.id, p);
	return p;
}

// The owner takes it back: a waiting link is dropped; an agent in the room says it's leaving, leaves and is gone.
async function removeAgent(a: Agent) {
	agents.delete(a.id);
	save();
	const L = live.get(a.id);
	if (L) {
		L.stopped = true;
		for (const t of tasks.values()) if (t.agentId === a.id && t.status === "working") { t.status = "cancelled"; t.updatedAt = iso(); }
		L.waiters.clear();
		live.delete(a.id);
	}
	if (isPending(a) || !a.token) return;
	if (a.ctlRoomId) await mx(a.server, "PUT", `/_matrix/client/v3/rooms/${enc(a.ctlRoomId)}/state/${CTL.status}/`, { token: a.token, body: { state: "offline", detail: "left", waiting: 0, updated: Date.now() } }).catch(() => {});
	for (const r of [a.roomId, a.ctlRoomId]) if (r) await mx(a.server, "POST", `/_matrix/client/v3/rooms/${enc(r)}/leave`, { token: a.token, body: {} }).catch(() => {});
	await mx(a.server, "POST", "/_matrix/client/v3/logout", { token: a.token, body: {} }).catch(() => {});
}
setInterval(() => {
	for (const a of [...agents.values()]) if (expired(a)) { log("link", a.id, "expired"); void removeAgent(a); }
}, 60_000).unref();

// ---------- the control room: hello, heartbeat, the owner's private thread ----------

async function hello(a: Agent) {
	if (!a.ctlRoomId) return;
	const c = { agent: a.name, app: a.app ?? APP, room: a.room, owner: a.ownerId, version: VERSION };
	await mx(a.server, "PUT", `/_matrix/client/v3/rooms/${enc(a.ctlRoomId)}/send/${CTL.hello}/${randomBytes(8).toString("hex")}`, { token: a.token, body: c });
	await mx(a.server, "PUT", `/_matrix/client/v3/rooms/${enc(a.ctlRoomId)}/state/${CTL.hello}/`, { token: a.token, body: c }).catch(() => {});
	await beat(a);
}

// The browser marks an agent silent for a minute "no signal". "Listening" while a client waits on the room.
async function beat(a: Agent) {
	if (!a.ctlRoomId) return;
	const L = live.get(a.id);
	const listening = !!L && L.waiters.size > 0;
	await mx(a.server, "PUT", `/_matrix/client/v3/rooms/${enc(a.ctlRoomId)}/state/${CTL.status}/`, { token: a.token, body: { state: "idle", detail: listening ? "listening" : "connected", waiting: 0, updated: Date.now() } });
}
setInterval(() => { for (const a of agents.values()) void beat(a).catch(() => {}); }, 30_000).unref();

// ---------- the inbox: one /sync loop per agent ----------

function start(a: Agent): Live {
	let L = live.get(a.id);
	if (L) return L;
	L = { a, inbox: [], seq: 0, delivered: 0, names: new Map(), seats: new Map(), waiters: new Set(), stopped: false, handled: new Set() };
	live.set(a.id, L);
	void loadState(L).finally(() => void syncLoop(L!));
	void hello(a).catch((err) => log(a.id, "hello:", err.message));
	return L;
}

function onState(L: Live, ev: any) {
	if (ev?.type === SEAT && typeof ev.state_key === "string") L.seats.set(ev.state_key, ev.content ?? {});
	const m = membershipFrom(ev);
	if (m?.name !== undefined) L.names.set(m.id, m.name);
}

async function loadState(L: Live) {
	try {
		const state = await mx(L.a.server, "GET", `/_matrix/client/v3/rooms/${enc(L.a.roomId)}/state`, { token: L.a.token });
		for (const ev of state) onState(L, ev);
	} catch (err: any) {
		log(L.a.id, "state:", err.message);
	}
}

async function syncLoop(L: Live) {
	let backoff = 1000;
	while (!L.stopped) {
		try {
			const s = await mx(L.a.server, "GET", `/_matrix/client/v3/sync?timeout=25000&since=${enc(L.a.since)}&filter=${enc(filterRooms(L.a))}`, { token: L.a.token, timeoutMs: 40_000 });
			const r = s.rooms?.join?.[L.a.roomId];
			for (const ev of r?.state?.events ?? []) onState(L, ev);
			let fresh = 0;
			for (const ev of r?.timeline?.events ?? []) {
				onState(L, ev);
				const q = requestFrom(ev, L.a.userId, (id) => L.names.get(id) ?? id, (id) => L.seats.get(id));
				if (!q) continue;
				L.inbox.push({ ...q, seq: ++L.seq });
				fresh++;
			}
			// The owner's private thread: only the owner's own input counts, anything else there is ignored.
			for (const ev of (L.a.ctlRoomId && s.rooms?.join?.[L.a.ctlRoomId]?.timeline?.events) || []) {
				if (ev.type !== CTL.input || ev.sender !== L.a.ownerId || typeof ev.content?.text !== "string") continue;
				L.inbox.push({ id: ev.event_id, fromId: ev.sender, from: L.a.owner, text: ev.content.text.slice(0, 20_000), by: "person", ts: ev.origin_server_ts ?? Date.now(), private: true, seq: ++L.seq } as any);
				fresh++;
			}
			if (L.inbox.length > 500) L.inbox.splice(0, L.inbox.length - 500);
			L.a.since = s.next_batch;
			save();
			if (fresh) {
				for (const w of [...L.waiters]) w();
				handler.notify.resourceUpdated(roomUri(L.a));
			}
			backoff = 1000;
		} catch (err: any) {
			if (err?.status === 401) { log(L.a.id, "token refused; stopping"); L.stopped = true; break; }
			log(L.a.id, "sync:", err.message);
			await new Promise((r) => setTimeout(r, backoff));
			backoff = Math.min(backoff * 2, 30_000);
		}
	}
}

// Everything after the delivery cursor, as one text the model reads; moves the cursor.
function take(L: Live): string | null {
	const batch = L.inbox.filter((m) => m.seq > L.delivered).slice(0, BATCH_MAX);
	if (!batch.length) return null;
	L.delivered = batch[batch.length - 1].seq;
	return frame(L, batch);
}

function who(L: Live, id: string, name: string): string {
	if (id === L.a.ownerId) return `${name} (your owner)`;
	const seat = L.seats.get(id);
	if (seat?.kind === "agent") return `${name} (${seat.owner ? cleanName(seat.owner) + "'s " : ""}agent)`;
	return `${name} (person)`;
}

function frame(L: Live, batch: Request[]): string {
	const lines = batch.map((m: any) => {
		if (m.private) return `[${timeOf(m.ts)}] ${m.from} (your owner, privately: only you two see this; answer with send private=true):\n${sanitize(m.text)}`;
		const to = m.toId ? ` → @${cleanName(L.names.get(m.toId) ?? m.toId)}` : "";
		return `[${timeOf(m.ts)}] ${who(L, m.fromId, m.from)}${to}:\n${sanitize(m.text)}`;
	});
	return `${batch.length} new message${batch.length > 1 ? "s" : ""} in room ${L.a.room}:\n\n${lines.join("\n\n")}`;
}

const roomUri = (a: Agent) => `duet://agent/${a.id}/room`;

// ---------- tasks (Tasks extension): wait_for_room's answer when nothing is new ----------

type Task = { id: string; agentId: string; status: "working" | "completed" | "cancelled"; createdAt: string; updatedAt: string; text?: string };
const tasks = new Map<string, Task>();
const iso = () => new Date().toISOString();
const taskView = (t: Task) => ({ taskId: t.id, status: t.status, createdAt: t.createdAt, lastUpdatedAt: t.updatedAt, ttlMs: null, pollIntervalMs: 1000 });

function openTask(L: Live): Task {
	const t: Task = { id: "wait-" + randomBytes(8).toString("hex"), agentId: L.a.id, status: "working", createdAt: iso(), updatedAt: iso() };
	tasks.set(t.id, t);
	const done = () => {
		if (t.status !== "working") return L.waiters.delete(done);
		const text = take(L);
		if (!text) return;
		t.status = "completed";
		t.text = text;
		t.updatedAt = iso();
		L.waiters.delete(done);
	};
	L.waiters.add(done);
	return t;
}
setInterval(() => {
	const old = Date.now() - 24 * 3600_000;
	for (const [id, t] of tasks) if (t.status !== "working" && Date.parse(t.updatedAt) < old) tasks.delete(id);
}, 3600_000).unref();

// ---------- the MCP server, one instance per request ----------

const RO = { readOnlyHint: true, openWorldHint: true };
const APP_ONLY = (uri: string) => ({ ui: { resourceUri: uri, visibility: ["app"] } });

async function postRoom(L: Live, text: string, to?: string) {
	const a = L.a;
	const toId = to ? [...L.names].find(([, n]) => n.toLowerCase() === to.trim().toLowerCase())?.[0] : undefined;
	await mx(a.server, "PUT", `/_matrix/client/v3/rooms/${enc(a.roomId)}/send/m.room.message/${randomBytes(8).toString("hex")}`, { token: a.token, body: replyContent(sanitize(text), toId, toId ? L.names.get(toId) : undefined) });
}

// ---------- the panel (MCP Apps): what the room view shows, and the reply drafts ----------

type Draft = { id: string; agentId: string; text: string; to?: string; status: "draft" | "sent" | "discarded"; at: number };
const drafts = new Map<string, Draft>();
setInterval(() => { const old = Date.now() - 24 * 3600_000; for (const [k, d] of drafts) if (d.at < old) drafts.delete(k); }, 3600_000).unref();

async function roomState(L: Live) {
	const a = L.a;
	const [mem, msgs] = await Promise.all([
		mx(a.server, "GET", `/_matrix/client/v3/rooms/${enc(a.roomId)}/joined_members`, { token: a.token }).catch(() => ({ joined: {} })),
		mx(a.server, "GET", `/_matrix/client/v3/rooms/${enc(a.roomId)}/messages?dir=b&limit=40&filter=${enc(JSON.stringify({ types: ["m.room.message"] }))}`, { token: a.token }).catch(() => ({ chunk: [] })),
	]);
	const members = Object.entries<any>(mem.joined ?? {}).map(([id, m]) => {
		const seat = L.seats.get(id) ?? {};
		const name = cleanName(m?.display_name ?? L.names.get(id) ?? id);
		L.names.set(id, name);
		return { id, name, agent: seat.kind === "agent", ownerId: seat.ownerId as string | undefined, ownerName: seat.owner ? cleanName(seat.owner) : undefined, me: id === a.userId, owner: id === a.ownerId };
	});
	const byId = new Map(members.map((m) => [m.id, m]));
	const persons = members.filter((m) => !m.agent).sort((x, y) => Number(y.owner) - Number(x.owner));
	const mine = (p: any) => (m: any) => m.agent && (m.ownerId ? m.ownerId === p.id : m.ownerName === p.name);
	const groups: any[] = persons.map((p) => ({ person: p, agents: members.filter(mine(p)).sort((x, y) => Number(y.me) - Number(x.me)) }));
	const placed = new Set(groups.flatMap((g) => g.agents.map((x: any) => x.id)));
	for (const m of members) if (m.agent && !placed.has(m.id)) groups.push({ person: null, agents: [m] });
	const look = (id: string) => {
		const m: any = byId.get(id) ?? { id, name: L.names.get(id) ?? id };
		return { id, name: m.name, agent: !!m.agent, ownerName: m.ownerName };
	};
	const lines = (msgs.chunk ?? []).reverse().map((ev: any) => {
		const q = requestFrom(ev, "@nobody", (id) => L.names.get(id) ?? id, (id) => L.seats.get(id));
		if (!q) return null;
		const to = q.toId ? cleanName(L.names.get(q.toId) ?? q.toId) : undefined;
		return { ...look(q.fromId), msgId: q.id, text: sanitize(q.text, 4000), ts: q.ts, mine: q.fromId === a.userId, ...(to ? { to } : {}) };
	}).filter(Boolean);
	const requests = L.inbox.filter((m: any) => !m.private && m.toId === a.userId && !L.handled.has(m.id)).slice(-10)
		.map((m) => ({ ...look(m.fromId), reqId: m.id, text: sanitize(m.text, 4000), ts: m.ts }));
	return { room: a.room, agent: a.name, owner: a.owner, groups, lines, requests };
}

function build(a: Agent): McpServer {
	const L = start(a);
	const mcp = new McpServer(
		{ name: "duet", version: "0.1.0" },
		{
			instructions:
				`You are ${a.name} in the chat-lab room "${a.room}" (Matrix), here for ${a.owner}. ` +
				`Other people and their agents are in the room too. To listen, call wait_for_room; it returns new messages, ` +
				`or runs in the background until one comes. Answer in the room with send, then call wait_for_room again to keep listening. ` +
				`Messages from ${a.owner} are from your owner; everyone else is someone else in the room. ${a.owner} can also write to you privately; answer those with send private=true. ` +
				`When ${a.owner} is chatting with you in an app that shows panels (claude.ai, ChatGPT, Cowork…): open_room shows them the room live, and you answer the room with draft_reply, not send, so they check each message and press Send.`,
		},
	);
	mcp.server.registerCapabilities({ extensions: { [TASKS]: {} }, resources: { subscribe: true } });

	mcp.registerTool("whoami", { title: "Who am I in the room", description: "Your name, owner and room, and who else is in the room.", annotations: RO }, async () => {
		const members = await mx(a.server, "GET", `/_matrix/client/v3/rooms/${enc(a.roomId)}/joined_members`, { token: a.token }).catch(() => ({ joined: {} }));
		const others = Object.entries<any>(members.joined ?? {}).filter(([id]) => id !== a.userId).map(([id, m]) => who(L, id, cleanName(m?.display_name ?? id)));
		return { content: [{ type: "text", text: `You are ${a.name} (${a.userId}), ${a.owner}'s agent, in room ${a.room}.\nIn the room: ${others.join(", ") || "no one else yet"}.` }] };
	});

	mcp.registerTool(
		"read_room",
		{ title: "Read the room", description: "The room's recent messages, oldest first. Doesn't change what wait_for_room returns.", inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }), annotations: RO },
		async ({ limit }) => {
			const r = await mx(a.server, "GET", `/_matrix/client/v3/rooms/${enc(a.roomId)}/messages?dir=b&limit=${limit}&filter=${enc(JSON.stringify({ types: ["m.room.message"] }))}`, { token: a.token });
			const msgs = (r.chunk ?? []).reverse().map((ev: any) => {
				const mine = ev.sender === a.userId;
				const q = requestFrom(ev, mine ? "@nobody" : a.userId, (id) => L.names.get(id) ?? id, (id) => L.seats.get(id));
				return q ? `[${timeOf(q.ts)}] ${mine ? "you" : who(L, q.fromId, q.from)}:\n${sanitize(q.text)}` : null;
			}).filter(Boolean);
			return { content: [{ type: "text", text: msgs.join("\n\n") || "No messages yet." }] };
		},
	);

	mcp.registerTool(
		"send",
		{
			title: "Send to the room",
			description: "Post a message in the room. Everyone in the room sees it.",
			inputSchema: z.object({
				text: z.string().min(1).max(20_000),
				to: z.string().optional().describe("Name of the person or agent you answer, to mention them"),
				private: z.boolean().optional().describe(`true: only ${a.owner} sees it, in your private thread, not the room`),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async ({ text, to, private: priv }) => {
			if (priv) {
				if (!a.ctlRoomId) return { content: [{ type: "text", text: "No private thread with your owner; not sent." }], isError: true };
				await mx(a.server, "PUT", `/_matrix/client/v3/rooms/${enc(a.ctlRoomId)}/send/${CTL.reply}/${randomBytes(8).toString("hex")}`, { token: a.token, body: { text: sanitize(text) } });
				return { content: [{ type: "text", text: `Sent to ${a.owner} privately.` }] };
			}
			await postRoom(L, text, to);
			return { content: [{ type: "text", text: "Sent." }] };
		},
	);

	mcp.registerTool(
		"wait_for_room",
		{ title: "Listen to the room", description: "Returns the room's new messages. If none are waiting, it waits (in the background where the client supports tasks) until one arrives.", annotations: RO },
		async (ctx) => {
			const now = take(L);
			if (now) return { content: [{ type: "text", text: now }] };
			const caps: any = ctx.mcpReq.envelope?.["io.modelcontextprotocol/clientCapabilities"];
			if (caps?.extensions?.[TASKS]) return { resultType: "task", ...taskView(openTask(L)) } as any;
			const text = await new Promise<string | null>((resolve) => {
				const done = () => { const t = take(L); if (t) { cleanup(); resolve(t); } };
				const timer = setTimeout(() => { cleanup(); resolve(null); }, WAIT_BLOCK_MS);
				const cleanup = () => { clearTimeout(timer); L.waiters.delete(done); ctx.mcpReq.signal.removeEventListener("abort", onAbort); };
				const onAbort = () => { cleanup(); resolve(null); };
				ctx.mcpReq.signal.addEventListener("abort", onAbort);
				L.waiters.add(done);
			});
			return { content: [{ type: "text", text: text ?? "No new messages yet. Call wait_for_room again to keep listening." }] };
		},
	);

	mcp.server.setRequestHandler("tasks/get", { params: z.object({ taskId: z.string() }).passthrough(), result: z.any() }, async ({ taskId }) => {
		const t = tasks.get(taskId);
		if (!t || t.agentId !== a.id) throw Object.assign(new Error("Unknown task"), { code: -32602 });
		if (t.status === "completed") return { resultType: "complete", ...taskView(t), result: { content: [{ type: "text", text: t.text }] } };
		return { resultType: "complete", ...taskView(t), ...(t.status === "cancelled" ? { statusMessage: "Stopped listening" } : {}) };
	});
	mcp.server.setRequestHandler("tasks/cancel", { params: z.object({ taskId: z.string() }).passthrough(), result: z.any() }, async ({ taskId }) => {
		const t = tasks.get(taskId);
		if (!t || t.agentId !== a.id) throw Object.assign(new Error("Unknown task"), { code: -32602 });
		if (t.status === "working") { t.status = "cancelled"; t.updatedAt = iso(); }
		return { resultType: "complete", ...taskView(t) };
	});

	// ---------- the panel (MCP Apps) ----------
	mcp.registerTool(
		"open_room",
		{
			title: "Open the room",
			description: `Show ${a.owner} the room as a live panel in this chat: who's in it with their agents, the latest messages, and requests for you (they can answer or ignore them there). Use it when ${a.owner} wants to see or open the room.`,
			annotations: RO,
			_meta: { ui: { resourceUri: ROOM_URI } },
		},
		async () => {
			const st = await roomState(L);
			const last = st.lines.slice(-5).map((l: any) => `${l.mine ? "you" : l.name}: ${l.text}`).join("\n");
			const waiting = st.requests.length ? ` ${st.requests.length} request(s) for you wait there.` : "";
			return { content: [{ type: "text", text: `The room #${a.room} is open as a panel for ${a.owner}.${waiting}\nLatest:\n${last || "no messages yet"}` }], structuredContent: st };
		},
	);
	mcp.registerTool("room_state", { title: "Room for the panel", description: "The panel's own refresh.", annotations: RO, _meta: APP_ONLY(ROOM_URI) }, async () => ({ content: [{ type: "text", text: "ok" }], structuredContent: await roomState(L) }));
	mcp.registerTool(
		"handle_request",
		{ title: "Answer or ignore a request", description: "The panel's Ignore / Answer.", inputSchema: z.object({ id: z.string(), action: z.enum(["ignore", "answer"]) }), _meta: APP_ONLY(ROOM_URI) },
		async ({ id, action }) => {
			L.handled.add(id);
			log(a.id, "request", action);
			return { content: [{ type: "text", text: "ok" }] };
		},
	);
	mcp.registerTool(
		"draft_reply",
		{
			title: "Draft a reply for the room",
			description: `Show ${a.owner} a message for the room as a card with Edit / Don't send / Send. It goes to the room only when they press Send; don't send it again yourself. Use this instead of send while ${a.owner} is chatting with you.`,
			inputSchema: z.object({ text: z.string().min(1).max(20_000), to: z.string().optional().describe("Name of the person or agent you answer, to mention them") }),
			annotations: { readOnlyHint: true, openWorldHint: false },
			_meta: { ui: { resourceUri: SEND_URI } },
		},
		async ({ text, to }) => {
			const d: Draft = { id: "d-" + randomBytes(9).toString("base64url"), agentId: a.id, text, to, status: "draft", at: Date.now() };
			drafts.set(d.id, d);
			return { content: [{ type: "text", text: `Shown to ${a.owner} as a card. It goes to #${a.room} only if they press Send; you'll see nothing back.` }], structuredContent: { draftId: d.id, text, to, room: a.room, status: d.status } };
		},
	);
	mcp.registerTool(
		"send_draft",
		{ title: "Send or drop a draft", description: "The reply card's Send / Don't send.", inputSchema: z.object({ draftId: z.string(), action: z.enum(["send", "discard", "status"]), text: z.string().max(20_000).optional() }), _meta: APP_ONLY(SEND_URI) },
		async ({ draftId, action, text }) => {
			const d = drafts.get(draftId);
			if (!d || d.agentId !== a.id) return { content: [{ type: "text", text: "This draft is gone (older than a day, or the server restarted)." }], structuredContent: { status: "gone" }, isError: true };
			if (action === "send" && d.status === "draft") {
				if (text && text.trim()) d.text = text.trim();
				await postRoom(L, d.text, d.to);
				d.status = "sent";
				log(a.id, "draft sent");
			} else if (action === "discard" && d.status === "draft") d.status = "discarded";
			return { content: [{ type: "text", text: d.status }], structuredContent: { status: d.status, text: d.text } };
		},
	);
	for (const [name, uri, html, title] of [["room-view", ROOM_URI, ROOM_HTML, "The room"], ["reply-card", SEND_URI, SEND_HTML, "Reply card"]] as const)
		mcp.registerResource(name, uri, { title, mimeType: UI_MIME, _meta: { ui: { prefersBorder: false } } } as any, async (u: URL) => ({ contents: [{ uri: u.href, mimeType: UI_MIME, text: html, _meta: { ui: { prefersBorder: false } } }] }));

	mcp.registerResource(
		"room",
		roomUri(a),
		{ title: `Room ${a.room}`, description: "The room's latest messages. Subscribe to hear when new ones arrive.", mimeType: "text/plain" },
		async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: L.inbox.slice(-20).map((m) => `[${timeOf(m.ts)}] ${who(L, m.fromId, m.from)}: ${sanitize(m.text, 2000)}`).join("\n") || "No messages yet." }] }),
	);
	return mcp;
}

// The secret in the URL picks the agent; an unknown one gets the same 404 as any wrong path.
const handler = createMcpHandler(({ requestInfo }: any) => {
	const secret = new URL(requestInfo.url).pathname.split("/")[3] ?? "";
	const a = bySecret(secret);
	if (!a || isPending(a)) throw new Error("unknown agent");
	return build(a);
});
const mcpNode = toNodeHandler(handler);

// ---------- HTTP ----------

function cors(res: ServerResponse) {
	res.setHeader("Access-Control-Allow-Origin", "*"); // the ticket is the credential, not the origin
	res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "content-type");
}
const json = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};
async function body(req: IncomingMessage, max = 10_000): Promise<string> {
	let s = "";
	for await (const c of req) {
		s += c;
		if (s.length > max) throw new Error("too large");
	}
	return s;
}

createServer(async (req, res) => {
	const path = (req.url ?? "/").split("?")[0];
	try {
		if (path === "/agents" || path === "/agents/remove") {
			cors(res);
			if (req.method === "OPTIONS") return res.writeHead(204).end();
			if (req.method !== "POST") return json(res, 405, { error: "POST a ticket" });
			const t = readTicket(JSON.parse(await body(req)).ticket);
			if (!t) return json(res, 400, { error: "bad ticket" });
			if (path === "/agents/remove") {
				const mine = [...agents.values()].filter((a) => a.ownerKey === sha(t.secret));
				if (!mine.length) return json(res, 404, { error: "no such agent" });
				for (const a of mine) await removeAgent(a);
				log("removed", mine.map((a) => a.id).join(" "));
				return json(res, 200, { removed: mine.length });
			}
			const { agent, secret } = createLink(t);
			log("link", agent.id, "for", agent.owner, "→", agent.room);
			return json(res, 201, { url: `${PUBLIC_URL}/mcp/a/${secret}`, id: agent.id });
		}
		if (/^\/mcp\/a\/[A-Za-z0-9_-]{20,}$/.test(path)) {
			// Browser-based hosts call us straight from the page; the secret in the URL is the key, not the origin.
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, last-event-id");
			res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
			if (req.method === "OPTIONS") return res.writeHead(204).end();
			const a = bySecret(path.split("/")[3]);
			if (!a || expired(a)) return json(res, 404, { error: "not found" });
			if (isPending(a)) {
				// The first call from an app: read which app it is, make the agent, then answer the call.
				if (req.method !== "POST") return json(res, 405, { error: "POST first" });
				const parsed = JSON.parse((await body(req, 4_000_000)) || "null");
				await activate(a, clientInfoOf(parsed));
				start(a);
				return void mcpNode(req, res, parsed);
			}
			return void mcpNode(req, res);
		}
		if (path === "/healthz") return json(res, 200, { ok: true, agents: agents.size });
		json(res, 404, { error: "not found" });
	} catch (err: any) {
		log("error", path, err?.message);
		if (!res.headersSent) json(res, err instanceof MxError ? 502 : 400, { error: String(err?.message ?? err).slice(0, 300) });
	}
}).listen(PORT, HOST, () => {
	log(`duet MCP server on http://${HOST}:${PORT} · ${agents.size} agent(s)`);
	for (const a of agents.values()) if (!isPending(a)) start(a);
});
