#!/usr/bin/env node
// duet for Codex (chat-lab): this Codex session joins a chat-lab room (Matrix) as "<Owner>'s Codex".
// The Codex twin of claude-code/hooks/register.ts: the same room, the same owner-control contract
// (peer-agents/owner-control/PROTOCOL.md), so the browser can't tell them apart except by name and app.
//
// Codex runs this as the plugin's MCP server (stdio). It has no in-process API, so:
//   - a room message reaches the model by `codex queue --thread <session> --message <text>`, which starts
//     a turn in the open session (or runs after the current one);
//   - the plugin's hooks (hooks/hooks.json) call the `duet_hook` tool: SessionStart and UserPromptSubmit
//     tell us the session id, the folder and when a turn starts; Stop when it ends;
//   - questions to the person at the terminal are MCP forms (elicitation). Codex declines forms on its
//     own in Full Access (approval "never"); then the browser is the only place to answer.
//
// Joining: the browser's "Add agent" command writes ~/.duet/join.json ({ agent: "codex", ticket, at })
// and starts `codex`. At SessionStart (or the next prompt) duet asks "Join <room> as <name>?". Only that
// answer joins: whoever wrote the file, the person at this terminal decides.
// Gate 1: someone else's request waits for Process / Ignore (the form when its turn starts, or the browser).
// Gate 2: every reply sent with the send tool waits for Send / Don't send (the form, or the browser).
// The owner's own input from the browser, and their @-messages to this agent, have no gate 1.
// First answer wins. No dependencies: Node 18+.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "0.1.3";
const APP = "Codex";
const DUET_DIR = process.env.DUET_HOME || join(homedir(), ".duet");
const CODEX = process.env.DUET_CODEX || "codex";
const REG_TOKEN = process.env.DUET_MATRIX_TOKEN || "chatlab-dev-token";
const debug = (s) => {
	if (process.env.DUET_DEBUG_FILE) try { appendFileSync(process.env.DUET_DEBUG_FILE, `${new Date().toISOString()} ${s}\n`); } catch {}
};

// ---------- text (as claude-code/hooks/text.ts) ----------

const MAX_TEXT = 100_000; // one message; `codex queue --message` is one argument (Linux caps it at 128 KiB)
const HIDDEN = new RegExp(String.raw`\x1b\[[0-9;?]*[ -\/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f-\x9f  ⠀\u{E0000}-\u{E0FFF}]|\p{Cf}|\p{Default_Ignorable_Code_Point}`, "gu");
const HIDDEN_MARK = " [hidden characters removed]";
function stripHidden(text) {
	let hidden = false;
	const clean = String(text ?? "").replace(/\r\n?/g, "\n").replace(HIDDEN, () => ((hidden = true), ""));
	return { text: clean, hidden };
}
function sanitize(text, max = MAX_TEXT) {
	const { text: clean, hidden } = stripHidden(text);
	const cut = clean.length > max ? clean.slice(0, max) + `… [${clean.length - max} more characters]` : clean;
	return hidden ? cut + HIDDEN_MARK : cut;
}
const cleanName = (n) =>
	sanitize(stripHidden(n).text, 200).normalize("NFKC").replace(/[^\p{L}\p{N}' ._-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim() || "someone";
const oneLine = (s) => sanitize(s, 200).replace(/\n/g, " ");
const firstLine = (t) => {
	const line = String(t).split("\n").find((l) => l.trim()) ?? "";
	return line.length > 80 ? line.slice(0, 79) + "…" : line;
};
const timeOf = (ts) => {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// ---------- Matrix and chat-lab rules (as claude-code/hooks/matrix.ts) ----------

const SEAT = "chatlab.member";
const CARD = "chatlab.card";
const CTL = {
	hello: "chatlab.agent.hello",
	status: "chatlab.agent.status",
	gate: "chatlab.agent.gate",
	done: "chatlab.agent.done",
	reply: "chatlab.agent.reply",
	refused: "chatlab.agent.refused",
	notice: "chatlab.agent.notice",
	decision: "chatlab.owner.decision",
	input: "chatlab.owner.input",
};
const POWER_EVENTS = {
	"m.room.power_levels": 100, "m.room.history_visibility": 100, "m.room.tombstone": 100, "m.room.server_acl": 100,
	"m.room.encryption": 100, "m.room.name": 50, "m.room.avatar": 50, "m.room.canonical_alias": 50, [SEAT]: 0,
};
const MAX_EVENT_BYTES = 60_000;
const isRoomCode = (c) => typeof c === "string" && c.length >= 12 && c.length <= 40 && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(c);
const sha256hex = (t) => createHash("sha256").update(t).digest("hex");
const roomAlias = (code, server) => `#chatlab-${sha256hex("chat-lab:" + code).slice(0, 24)}:${server}`;
const controlAlias = (secret, server) => `#ctl-${sha256hex(secret).slice(0, 24)}:${server}`;
const serverNameOf = (userId) => userId.split(":").slice(1).join(":");
const shortId = (id) => String(id).replace(/^@/, "").split(":")[0] ?? "";
const agentName = (owner) => `${owner}'s ${APP}`;
const localPart = (owner) => (owner.toLowerCase().replace(/[^a-z0-9._=-]/g, "") || "user") + "s-codex-" + randomUUID().replace(/-/g, "").slice(0, 5);
const filterNone = JSON.stringify({ room: { rooms: [] }, presence: { not_types: ["*"] }, account_data: { not_types: ["*"] } });
const filterRoom = (roomId) =>
	JSON.stringify({ room: { rooms: [roomId], timeline: { limit: 100 }, state: { lazy_load_members: false } }, presence: { not_types: ["*"] }, account_data: { not_types: ["*"] } });

// The browser's join ticket, base64url JSON: { server, room, owner, ownerId, secret, agent }.
function readTicket(s) {
	if (typeof s !== "string" || s.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
	let j;
	try {
		j = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (!j || typeof j !== "object") return null;
	const server = typeof j.server === "string" ? j.server.replace(/\/+$/, "") : "";
	if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(server)) return null;
	if (!isRoomCode(j.room)) return null;
	if (typeof j.owner !== "string" || stripHidden(j.owner).hidden || cleanName(j.owner) !== j.owner.trim()) return null;
	if (typeof j.ownerId !== "string" || !/^@[^:\s]+:\S+$/.test(j.ownerId)) return null;
	if (typeof j.secret !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(j.secret)) return null;
	const owner = j.owner.trim();
	const agent = typeof j.agent === "string" && !stripHidden(j.agent).hidden && j.agent.trim() && cleanName(j.agent) === j.agent.trim() ? j.agent.trim() : agentName(owner);
	return { server, room: j.room, owner, ownerId: j.ownerId, secret: j.secret, agent };
}

// ~/.duet/join.json, taken once: { take } a ticket to ask about, or null (none, stale, someone else's).
const JOIN_FRESH_S = 30 * 60;
function takeJoinFile() {
	const path = join(DUET_DIR, "join.json");
	let j;
	try {
		j = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
	if (!j || j.agent !== "codex" || typeof j.at !== "number") return null; // another client's (Claude Code, pi)
	try {
		writeFileSync(path, "{}");
	} catch {
		return null;
	}
	const age = Date.now() / 1000 - j.at;
	return age >= -60 && age <= JOIN_FRESH_S ? readTicket(j.ticket) : null;
}

function requestFrom(ev, me) {
	if (ev?.type !== "m.room.message" || typeof ev.event_id !== "string" || typeof ev.sender !== "string" || ev.sender === me) return null;
	const c = ev.content || {};
	if (c["m.relates_to"]?.rel_type === "m.replace") return null;
	let text;
	if (c.msgtype === CARD && typeof c[CARD]?.title === "string") text = `[request card] ${c[CARD].title}\n\n${String(c[CARD].body ?? "")}`;
	else if (c.msgtype === "m.file" || c.msgtype === "m.image") text = `[file] ${String(c.body ?? "file")} (the file itself isn't passed on)`;
	else if (typeof c.body === "string") text = c.body;
	else return null;
	const mentions = Array.isArray(c["m.mentions"]?.user_ids) ? c["m.mentions"].user_ids.filter((x) => typeof x === "string") : [];
	const toId = mentions.includes(me) ? me : mentions[0];
	const re = c["m.relates_to"]?.["m.in_reply_to"]?.event_id;
	return {
		id: ev.event_id,
		fromId: ev.sender,
		text: text.slice(0, MAX_TEXT),
		by: seats.get(ev.sender)?.kind === "agent" ? "agent" : "person",
		toId,
		re: typeof re === "string" ? re : undefined,
		ts: typeof ev.origin_server_ts === "number" ? ev.origin_server_ts : Date.now(),
	};
}

const replyContent = (text, toId, toName, reId) => ({
	msgtype: "m.text",
	body: toName ? `@${toName} ${text}` : text,
	"m.mentions": toId ? { user_ids: [toId] } : {},
	...(reId ? { "m.relates_to": { "m.in_reply_to": { event_id: reId } } } : {}),
});

class MxError extends Error {
	constructor(status, body) {
		super(`${body?.errcode || "HTTP " + status}: ${body?.error || "request failed"}`);
		this.status = status;
		this.body = body;
	}
}
const enc = encodeURIComponent;
async function mx(base, method, path, { token, body, timeoutMs = 20_000 } = {}) {
	const res = await fetch(base + path, {
		method,
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	let json = {};
	try {
		json = await res.json();
	} catch {}
	if (!res.ok) throw new MxError(res.status, json);
	return json;
}

// This owner's agent account on this server, made once and kept in ~/.duet/codex-accounts.json.
async function mxAccount(base, owner) {
	const file = join(DUET_DIR, "codex-accounts.json");
	let all = {};
	try {
		all = JSON.parse(readFileSync(file, "utf8"));
	} catch {}
	const key = `${base} ${owner}`;
	if (all[key]?.token) {
		try {
			await mx(base, "GET", "/_matrix/client/v3/account/whoami", { token: all[key].token });
			return all[key];
		} catch (err) {
			if (err?.status !== 401) throw err;
		}
	}
	const req = { username: localPart(owner), password: randomUUID() + randomUUID(), initial_device_display_name: "duet for Codex" };
	let res;
	try {
		res = await mx(base, "POST", "/_matrix/client/v3/register", { body: req });
	} catch (err) {
		if (err?.status !== 401) throw err;
		res = await mx(base, "POST", "/_matrix/client/v3/register", { body: { ...req, auth: { type: "m.login.registration_token", token: REG_TOKEN, session: err.body?.session } } });
	}
	all[key] = { userId: res.user_id, token: res.access_token };
	mkdirSync(DUET_DIR, { recursive: true });
	writeFileSync(file, JSON.stringify(all, null, 1), { mode: 0o600 });
	return all[key];
}

// Join the room for this code, or make it (the same rules as the browser and the Claude Code mod).
async function mxJoinRoom(base, token, alias) {
	const joinIt = async () => (await mx(base, "POST", `/_matrix/client/v3/join/${enc(alias)}`, { token, body: {} })).room_id;
	try {
		return await joinIt();
	} catch (err) {
		if (err?.body?.errcode !== "M_NOT_FOUND") throw err;
	}
	const { room_id } = await mx(base, "POST", "/_matrix/client/v3/createRoom", {
		token,
		body: { name: "chat-lab room", preset: "public_chat", power_level_content_override: { events: POWER_EVENTS }, initial_state: [{ type: "m.room.history_visibility", state_key: "", content: { history_visibility: "shared" } }] },
	});
	const giveUp = async () => {
		await mx(base, "POST", `/_matrix/client/v3/rooms/${enc(room_id)}/leave`, { token, body: {} }).catch(() => {});
		return joinIt();
	};
	try {
		await mx(base, "PUT", `/_matrix/client/v3/directory/room/${enc(alias)}`, { token, body: { room_id } });
	} catch (err) {
		if (err?.status !== 409) throw err;
		return giveUp();
	}
	await new Promise((r) => setTimeout(r, 600));
	const holder = (await mx(base, "GET", `/_matrix/client/v3/directory/room/${enc(alias)}`, { token })).room_id;
	return holder === room_id ? room_id : giveUp();
}

// ---------- state ----------

let thread = ""; // the Codex session id (from the hooks)
let folder = ""; // the session's folder
let room = null; // { ...ticket, name, userId, token, roomId, cursor }
let ctl = null; // { roomId, since }
let generation = 0;
const names = new Map();
const seats = new Map();
const peers = new Map(); // id -> { left }
const seen = new Set();
const sent = new Map(); // our event ids -> first line
let joinOffer = null; // a ticket taken from the join file, waiting for the terminal's answer
let requests = []; // gate 1: { req, from, decision: "" | "process" | "ignore", by, owner, settle }
let outbox = []; // gate 2: { id, text, to, decision, by, editedText, settle }
const ownerInputs = []; // the owner's own inputs from the browser, waiting for their turn: { text, re }
const turns = new Map(); // turn id -> { kind: "owner", re } | { kind: "peer", req }
let runningTurn = "";
let ctlLastStatus = "";
let ctlStatusAt = 0;

const nameOf = (id) => names.get(id) || shortId(id);
function labelOf(id) {
	const base = cleanName(nameOf(id));
	const clash = /[^\x20-\x7e]/.test(base) || [...peers.entries()].some(([pid, p]) => pid !== id && !p.left && cleanName(nameOf(pid)).toLowerCase() === base.toLowerCase());
	return clash ? `${base} (${shortId(id)})` : base;
}
const livePeers = () => [...peers.entries()].filter(([, p]) => !p.left).map(([id]) => ({ id, label: labelOf(id) }));
const peerList = () => livePeers().map((p) => p.label).join(", ");

// ---------- MCP over stdio (JSON-RPC, one message per line) ----------

let clientCaps = {};
const pending = new Map();
let nextId = 1;
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");

// A form for the person at the terminal: the answer (one of `choices`) or null with why.
function ask(message, choices, signal) {
	if (!clientCaps?.elicitation) return Promise.resolve({ answer: null, why: "unsupported" });
	const id = `duet-ask-${nextId++}`;
	return new Promise((resolve) => {
		const done = (r) => {
			pending.delete(id);
			resolve(r);
		};
		pending.set(id, (m) => {
			const a = m.result?.action === "accept" ? m.result.content?.answer : null;
			done(choices.includes(a) ? { answer: a } : { answer: null, why: m.result?.action || "error" });
		});
		signal?.addEventListener("abort", () => {
			if (!pending.has(id)) return;
			out({ method: "notifications/cancelled", params: { requestId: id, reason: "answered in the browser" } });
			done({ answer: null, why: "elsewhere" });
		});
		out({ id, method: "elicitation/create", params: { mode: "form", message, requestedSchema: { type: "object", properties: { answer: { type: "string", title: "Your answer", enum: choices } }, required: ["answer"] } } });
	});
}

const SEND_TOOL = {
	name: "send",
	description:
		"Send a message to the other people and agents in your duet room (chat-lab). Use it to answer a duet request, or when your user asks you to tell the room something. " +
		"Your text replies are seen only by your own user; this tool is the only way to reach the room. Send one complete reply when you're done, not progress updates. " +
		"Your user sees the whole reply and chooses Send or Don't send; if they don't send it, don't send it again.",
	inputSchema: {
		type: "object",
		properties: { text: { type: "string", description: "The message." }, to: { type: "string", description: "Recipient name, if the room has more than one other member." } },
		required: ["text"],
	},
};
const HOOK_TOOL = {
	name: "duet_hook",
	description: "Internal: called by duet's own Codex hooks. Never call it yourself.",
	inputSchema: { type: "object", properties: { event: { type: "string" } }, required: ["event"] },
};

const textResult = (text, isError) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

async function onMessage(line) {
	let m;
	try {
		m = JSON.parse(line);
	} catch {
		return;
	}
	if (m.id !== undefined && !m.method) {
		const r = pending.get(m.id);
		if (r) r(m);
		return;
	}
	if (m.method === "initialize") {
		clientCaps = m.params?.capabilities || {};
		debug(`initialize ${JSON.stringify(m.params?.clientInfo)} caps ${JSON.stringify(clientCaps)}`);
		return out({
			id: m.id,
			result: {
				protocolVersion: m.params?.protocolVersion || "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "duet", version: VERSION },
				instructions: "duet puts this Codex session in a chat-lab room. Room requests arrive as messages starting with [duet]; answer them only with the send tool.",
			},
		});
	}
	if (m.method === "tools/list") return out({ id: m.id, result: { tools: [SEND_TOOL, HOOK_TOOL] } });
	if (m.method === "tools/call") {
		const p = m.params || {};
		const meta = p._meta || {};
		const turnMeta = meta["x-codex-turn-metadata"];
		if (turnMeta?.thread_id) thread = turnMeta.thread_id;
		else if (typeof meta.threadId === "string" && meta.threadId) thread = meta.threadId;
		let result;
		try {
			if (p.name === "send") result = await sendTool(p.arguments || {});
			else if (p.name === "duet_hook") result = textResult(meta.callId ? "" : await onHook(p.arguments || {}));
			else result = textResult(`unknown tool ${p.name}`, true);
		} catch (err) {
			debug(`tool ${p.name}: ${err?.stack || err}`);
			result = textResult(p.name === "send" ? "Not sent: duet error · ask your user before resending" : "", p.name === "send");
		}
		return out({ id: m.id, result });
	}
	if (m.method === "ping") return out({ id: m.id, result: {} });
	if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: `no method ${m.method}` } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
	buf += d;
	for (let i; (i = buf.indexOf("\n")) >= 0; ) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (line.trim()) void onMessage(line).catch((err) => debug(`message: ${err?.stack || err}`));
	}
});
process.stdin.on("end", () => void leave().finally(() => process.exit(0)));

// ---------- hooks ----------

const hookOut = (event, { context, system, block } = {}) =>
	block
		? JSON.stringify({ decision: "block", reason: block, ...(system ? { systemMessage: system } : {}) })
		: context || system
			? JSON.stringify({ ...(system ? { systemMessage: system } : {}), ...(context ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : {}) })
			: "";

const REQ_MARK = /\[duet request ([A-Za-z0-9_-]{6,64})\]/;
const saysJoinDuet = (p) => /^\W*join duet\W*$/i.test(String(p ?? ""));

async function onHook(a) {
	if (typeof a.thread === "string" && a.thread) thread = a.thread;
	if (typeof a.folder === "string" && a.folder) folder = a.folder;
	const event = String(a.event || "");
	debug(`hook ${event} thread=${thread} turn=${a.turn || ""}`);
	if (event === "SessionStart") {
		const t = takeJoinFile();
		if (t) joinOffer = t;
		setImmediate(pushWaiting);
		if (!joinOffer) return "";
		const line = await askJoin();
		return hookOut("SessionStart", { system: line });
	}
	if (event === "UserPromptSubmit") {
		const turn = String(a.turn || "");
		const prompt = String(a.prompt ?? "");
		if (!joinOffer) {
			const t = takeJoinFile();
			if (t) joinOffer = t;
		}
		const m = prompt.match(REQ_MARK);
		const r = m ? requests.find((x) => x.id === m[1]) : undefined;
		if (r) return gate1AtTurn(r, turn);
		if (m) return hookOut(event, { block: "duet · this request is gone (answered, or duet restarted)" });
		const o = ownerInputs.findIndex((x) => x.text === prompt.trim());
		if (o >= 0) {
			turns.set(turn, { kind: "owner", re: ownerInputs[o].re });
			ownerInputs.splice(o, 1);
		}
		// "join duet" is for duet only: answered here, the prompt never reaches the model (no turn runs).
		if (saysJoinDuet(prompt)) return hookOut(event, { block: (joinOffer ? await askJoin(prompt) : "") || (room ? `duet: already in ${room.room}` : "duet: no join waiting · copy the command from chat-lab again") });
		runningTurn = turn;
		void ctlStatus();
		if (joinOffer) {
			const line = await askJoin(prompt);
			return line ? hookOut(event, { system: line }) : "";
		}
		return "";
	}
	if (event === "Stop") {
		const turn = String(a.turn || "");
		const t = turns.get(turn);
		turns.delete(turn);
		if (t?.kind === "owner") ctlSend(CTL.reply, { text: sanitize(String(a.last ?? "")) || "(no text)", re: t.re });
		if (turn === runningTurn) runningTurn = "";
		for (const item of outbox) decideOut(item, "stopped", "terminal");
		if (!joinOffer) {
			const tk = takeJoinFile();
			if (tk) joinOffer = tk;
		}
		void ctlStatus();
		setImmediate(pushWaiting);
		const line = joinOffer ? await askJoin() : "";
		return line ? hookOut("Stop", { system: line }) : "";
	}
	return "";
}

// The join question: a form; without one (Full Access declines forms), the user says "join duet".
let asking = null;
async function askJoin(prompt) {
	const o = joinOffer;
	if (!o) return "";
	if (saysJoinDuet(prompt)) {
		joinOffer = null;
		return join_(o);
	}
	if (asking || o.told) return ""; // said once per join offer
	if (!formsOff) {
		asking = ask(`duet · Join ${o.room} as ${o.agent}? · ${folder || "this folder"}\n${o.owner} (${o.ownerId}) will answer this agent's gates from the browser.`, ["Join", "Ignore"]);
		const r = await asking;
		asking = null;
		if (joinOffer !== o) return "";
		if (r.answer === "Ignore") {
			joinOffer = null;
			return "duet: join ignored";
		}
		if (r.answer === "Join") {
			joinOffer = null;
			return join_(o);
		}
		if (r.why === "decline" || r.why === "unsupported") formsOff = true; // Full Access: Codex declines every form
	}
	o.told = true;
	return `duet: join ${o.room} as ${o.agent}? Type "join duet" to join (${o.owner} answers its gates in the browser)`;
}
let formsOff = false;

// ---------- joining and leaving ----------

async function join_(t) {
	if (room) await leave();
	const gen = generation;
	let r, members, state;
	try {
		const acct = await mxAccount(t.server, t.owner);
		await mx(t.server, "PUT", `/_matrix/client/v3/profile/${enc(acct.userId)}/displayname`, { token: acct.token, body: { displayname: t.agent } });
		const alias = roomAlias(t.room, serverNameOf(acct.userId));
		const start = (await mx(t.server, "GET", `/_matrix/client/v3/sync?timeout=0&filter=${enc(filterNone)}`, { token: acct.token })).next_batch;
		const roomId = await mxJoinRoom(t.server, acct.token, alias);
		await mx(t.server, "PUT", `/_matrix/client/v3/rooms/${enc(roomId)}/state/${SEAT}/${enc(acct.userId)}`, { token: acct.token, body: { kind: "agent", owner: t.owner, app: APP } }).catch(() => {});
		members = await mx(t.server, "GET", `/_matrix/client/v3/rooms/${enc(roomId)}/joined_members`, { token: acct.token });
		state = await mx(t.server, "GET", `/_matrix/client/v3/rooms/${enc(roomId)}/state`, { token: acct.token });
		r = { ...t, name: t.agent, userId: acct.userId, token: acct.token, roomId, cursor: start };
	} catch (err) {
		debug(`join: ${err?.stack || err}`);
		return `duet: ${t.server}: ${oneLine(err?.message ?? err)} · not joined`;
	}
	if (gen !== generation || room) return "";
	room = r;
	generation++;
	requests = [];
	outbox = [];
	peers.clear();
	names.clear();
	seats.clear();
	for (const ev of Array.isArray(state) ? state : []) {
		if (ev?.type === SEAT && ev.state_key?.startsWith("@")) seats.set(ev.state_key, ev.content || {});
		if (ev?.type === "m.room.member" && typeof ev.content?.displayname === "string") names.set(ev.state_key, ev.content.displayname);
	}
	for (const [id, m] of Object.entries(members?.joined ?? {})) {
		if (m?.display_name) names.set(id, m.display_name);
		if (id !== r.userId) peers.set(id, { left: false });
	}
	void syncLoop(r, generation);
	void controlStart(r, generation).catch((err) => debug(`control: ${err?.stack || err}`));
	return `duet: joined ${r.room} as ${r.name} · ${r.owner} answers its gates in the browser too`;
}

async function leave() {
	if (!room) return;
	const r = room;
	for (const q of requests) if (!q.decision) ctlDone(q.id, "dropped", "terminal");
	await ctlStatus("offline").catch(() => {});
	ctl = null;
	room = null;
	generation++;
	requests = [];
	await mx(r.server, "POST", `/_matrix/client/v3/rooms/${enc(r.roomId)}/leave`, { token: r.token, body: {} }).catch(() => {});
}

// ---------- receiving ----------

async function syncLoop(r, gen) {
	let backoff = 1000;
	while (room === r && gen === generation) {
		try {
			const s = await mx(r.server, "GET", `/_matrix/client/v3/sync?timeout=20000&since=${enc(r.cursor)}&filter=${enc(filterRoom(r.roomId))}`, { token: r.token, timeoutMs: 45_000 });
			if (room !== r || gen !== generation) return;
			const joined = s.rooms?.join?.[r.roomId];
			for (const ev of joined?.state?.events ?? []) if (ev?.type === SEAT && ev.state_key?.startsWith("@")) seats.set(ev.state_key, ev.content || {});
			for (const ev of joined?.timeline?.events ?? []) onRoomEvent(r, ev);
			r.cursor = s.next_batch;
			backoff = 1000;
		} catch (err) {
			debug(`sync: ${err?.message || err}`);
			await new Promise((res) => setTimeout(res, backoff));
			backoff = Math.min(backoff * 2, 30_000);
		}
	}
}

function onRoomEvent(r, ev) {
	if (typeof ev?.event_id !== "string" || seen.has(ev.event_id)) return;
	seen.add(ev.event_id);
	if (ev.type === SEAT && ev.state_key?.startsWith("@")) return void seats.set(ev.state_key, ev.content || {});
	if (ev.type === "m.room.member" && typeof ev.state_key === "string") {
		if (typeof ev.content?.displayname === "string") names.set(ev.state_key, ev.content.displayname);
		if (ev.state_key !== r.userId) peers.set(ev.state_key, { left: ev.content?.membership !== "join" });
		return;
	}
	const req = requestFrom(ev, r.userId);
	if (!req) return;
	if (req.toId && req.toId !== r.userId) return; // addressed to someone else
	if (req.ts < Date.now() - 12 * 3600_000) return;
	if (!peers.has(req.fromId) || peers.get(req.fromId).left) peers.set(req.fromId, { left: false });
	const from = labelOf(req.fromId);
	const reLine = req.re && sent.has(req.re) ? sent.get(req.re) : "";
	const owner = req.fromId === r.ownerId;
	// The owner's own message: @-addressed to this agent it's their input (no gate 1); else it's for the people.
	if (owner && req.toId !== r.userId) return;
	const item = { id: req.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || randomUUID(), req, from, reLine, decision: owner ? "process" : "", by: owner ? "owner" : "", owner, pushed: false, settle: null };
	requests.push(item);
	if (!owner) ctlSend(CTL.gate, { id: req.id, gate: 1, rev: 0, from: { id: req.fromId, name: from }, text: req.text, ts: req.ts });
	void ctlStatus();
	pushWaiting();
}

// What the model reads for one request. The marker lets the UserPromptSubmit hook find it.
function frame(q) {
	const who = q.req.by === "person" ? (q.owner ? "your own user, from the room" : "a person in the room, typing to you directly") : "another person's agent, on their computer";
	const answers = q.reLine ? ` — a reply to your message “${sanitize(q.reLine, 100)}”` : "";
	return (
		`[duet request ${q.id}] In the room: ${peerList() || "no one else yet"} · you are ${room?.name} · your folder: ${folder || "this one"}\n\n` +
		`[duet] from ${q.from} (${who}), ${timeOf(q.req.ts)}${answers}:\n\n${sanitize(q.req.text)}\n\n` +
		`Only your own user sees your text replies: to answer ${q.from}, call the duet send tool. Send one complete reply when you're done.`
	);
}

// Hand each waiting request to Codex: `codex queue` starts a turn in the open session (or after the current one).
let pushing = false;
async function pushWaiting() {
	if (pushing || !thread || !room) return;
	const q = requests.find((x) => !x.pushed && x.decision !== "ignore");
	if (!q) return;
	pushing = true;
	q.pushed = true;
	const text = frame(q);
	execFile(CODEX, ["queue", "--thread", thread, "--message", text], { timeout: 30_000 }, (err, _o, stderr) => {
		pushing = false;
		if (err) {
			q.pushed = false;
			debug(`codex queue: ${oneLine(stderr || err.message)}`);
			ctlSend(CTL.notice, { text: `couldn't hand a request to Codex (${oneLine(stderr || err.message).slice(0, 160)})` });
			return void setTimeout(pushWaiting, 10_000);
		}
		debug(`queued ${q.id}`);
		setImmediate(pushWaiting);
	});
}

// Gate 1 when the request's turn starts: decided in the browser already, or asked now (first answer wins).
async function gate1AtTurn(q, turn) {
	if (!q.decision) {
		const ac = new AbortController();
		const browser = new Promise((res) => (q.settle = res));
		const preview = sanitize(q.req.text, 4000);
		const form = ask(`duet · ${q.from} · ${timeOf(q.req.ts)}\n\n${preview}\n\nProcess this request?`, ["Process", "Ignore"], ac.signal).then((r) =>
			r.answer ? { decision: r.answer === "Process" ? "process" : "ignore", by: "terminal" } : r.why === "elsewhere" ? null : new Promise(() => {}),
		);
		void ctlStatus();
		const got = await Promise.race([browser, form]);
		ac.abort();
		q.settle = null;
		if (got && !q.decision) {
			q.decision = got.decision;
			q.by = got.by;
			ctlDone(q.req.id, got.decision === "process" ? "processed" : "ignored", got.by);
		}
	}
	requests = requests.filter((x) => x !== q);
	void ctlStatus();
	setImmediate(pushWaiting);
	if (q.decision !== "process") return hookOut("UserPromptSubmit", { block: `duet · ignored · ${q.from}` });
	turns.set(turn, { kind: "peer", req: q.req });
	runningTurn = turn;
	return "";
}

// ---------- the send tool and gate 2 ----------

function decideOut(item, decision, by) {
	if (item.decision) return;
	item.decision = decision;
	item.by = by;
	item.settle?.();
}

async function sendTool(e) {
	if (!room) return textResult("Not sent: not in a duet room");
	const r = room;
	const raw = String(e.text ?? "");
	const text = sanitize(raw).trim();
	if (!stripHidden(raw).text.trim()) return textResult("Not sent: empty");
	const toArg = typeof e.to === "string" && e.to.trim() ? e.to.trim() : undefined;
	let toId;
	if (toArg !== undefined) {
		const hits = livePeers().filter((p) => p.label === toArg || shortId(p.id) === toArg || p.id === toArg || cleanName(nameOf(p.id)).toLowerCase() === cleanName(toArg).toLowerCase());
		if (hits.length !== 1) return textResult(hits.length ? `Not sent: ${hits.length} members match ${oneLine(toArg)} · use one of: ${hits.map((p) => p.label).join(", ")}` : `Not sent: no ${oneLine(toArg)} in the room · in it: ${peerList() || "no one yet"}`);
		toId = hits[0].id;
	}
	// Answering one sender's request, a reply without `to` goes to that sender.
	const asked = turns.get(runningTurn)?.kind === "peer" ? turns.get(runningTurn).req : undefined;
	if (toId === undefined && asked && peers.get(asked.fromId)?.left === false) toId = asked.fromId;
	const sendTo = toId ? labelOf(toId) : undefined;
	if (Buffer.byteLength(JSON.stringify(replyContent(text, "@x:x", sendTo, "$x"))) > MAX_EVENT_BYTES) return textResult("Not sent: too long for one Matrix message (about 60 KB) · send the key part, or split it");
	const item = { id: randomUUID(), text, to: sendTo ?? (peerList() || "the room"), decision: "", by: "", editedText: undefined, settle: null };
	outbox.push(item);
	ctlSend(CTL.gate, { id: item.id, gate: 2, draft: text, to: { id: toId ?? "", name: item.to }, ts: Date.now() });
	void ctlStatus();
	const ac = new AbortController();
	const browser = new Promise((res) => (item.settle = res));
	const form = ask(`duet · Send to ${item.to}?\n\n${sanitize(text, 60_000)}`, ["Send", "Don't send"], ac.signal).then((x) => {
		if (x.answer) decideOut(item, x.answer === "Send" ? "send" : "drop", "terminal");
	});
	await Promise.race([browser, form.then(() => (item.decision ? undefined : new Promise(() => {})))]);
	ac.abort();
	outbox = outbox.filter((x) => x !== item);
	void ctlStatus();
	if (item.decision !== "send") {
		ctlDone(item.id, item.decision === "drop" ? "cancelled" : "dropped", item.by || "terminal");
		return textResult(item.decision === "drop" ? "Not sent: your user said no · don't resend" : "Not sent");
	}
	if (room !== r) return textResult("Not sent: left the room");
	const outText = item.editedText ?? text;
	try {
		const content = replyContent(outText, toId, toId ? cleanName(nameOf(toId)) : undefined, asked && (!toId || asked.fromId === toId) ? asked.id : undefined);
		const res = await mx(r.server, "PUT", `/_matrix/client/v3/rooms/${enc(r.roomId)}/send/m.room.message/${randomUUID()}`, { token: r.token, body: content });
		sent.set(res.event_id, firstLine(outText));
		ctlDone(item.id, item.editedText !== undefined ? "edited" : "sent", item.by || "terminal");
	} catch (err) {
		ctlDone(item.id, "failed", item.by || "terminal");
		return textResult("Not sent: " + oneLine(err?.message ?? err));
	}
	const where = sendTo ?? (peerList() || "the room");
	return textResult(item.editedText !== undefined ? `Sent to ${where} · your user edited it before sending; what went out: ${outText}` : `Sent to ${where}`);
}

// ---------- owner control (peer-agents/owner-control/PROTOCOL.md) ----------

async function controlStart(r, gen) {
	const since = (await mx(r.server, "GET", `/_matrix/client/v3/sync?timeout=0&filter=${enc(filterNone)}`, { token: r.token })).next_batch;
	const roomId = (await mx(r.server, "POST", `/_matrix/client/v3/join/${enc(controlAlias(r.secret, serverNameOf(r.userId)))}`, { token: r.token, body: {} })).room_id;
	if (gen !== generation || room !== r) return;
	ctl = { roomId, since };
	ctlLastStatus = "";
	ctlSend(CTL.hello, { agent: r.name, app: APP, room: r.room, cwd: folder, owner: r.ownerId, version: VERSION });
	await ctlStatus(null, true);
	let backoff = 1000;
	while (ctl && gen === generation && room === r) {
		try {
			const s = await mx(r.server, "GET", `/_matrix/client/v3/sync?timeout=20000&since=${enc(ctl.since)}&filter=${enc(filterRoom(ctl.roomId))}`, { token: r.token, timeoutMs: 45_000 });
			if (!ctl || gen !== generation) return;
			for (const ev of s.rooms?.join?.[ctl.roomId]?.timeline?.events ?? []) onControlEvent(r, ev);
			ctl.since = s.next_batch;
			backoff = 1000;
			if (Date.now() - ctlStatusAt > 15_000) await ctlStatus(null, true); // heartbeat: the browser marks a minute of silence as stale
		} catch {
			await new Promise((res) => setTimeout(res, backoff));
			backoff = Math.min(backoff * 2, 30_000);
		}
	}
}

function onControlEvent(r, ev) {
	if (typeof ev?.event_id !== "string" || seen.has(ev.event_id)) return;
	seen.add(ev.event_id);
	if (ev.type !== CTL.decision && ev.type !== CTL.input) return;
	if (ev.sender !== r.ownerId) return void ctlSend(CTL.refused, { event_id: ev.event_id, sender: String(ev.sender), reason: "not this agent's owner" });
	const c = ev.content ?? {};
	if (ev.type === CTL.input) {
		const text = sanitize(String(c.text ?? "")).trim();
		if (!text) return;
		if (!thread) return void ctlSend(CTL.notice, { text: "Codex hasn't started a turn yet · type anything in the terminal once" });
		ownerInputs.push({ text, re: ev.event_id });
		execFile(CODEX, ["queue", "--thread", thread, "--message", text], { timeout: 30_000 }, (err, _o, stderr) => {
			if (err) ctlSend(CTL.notice, { text: `Codex refused the input (${oneLine(stderr || err.message).slice(0, 160)})` });
		});
		return;
	}
	const id = String(c.id ?? "");
	const action = String(c.action ?? "");
	const item = outbox.find((x) => x.id === id && !x.decision);
	if (item) {
		if (action === "send") decideOut(item, "send", "browser");
		else if (action === "cancel") decideOut(item, "drop", "browser");
		else if (action === "edit" && typeof c.text === "string" && sanitize(c.text).trim()) {
			item.editedText = sanitize(c.text).trim();
			decideOut(item, "send", "browser");
		} else ctlSend(CTL.notice, { id, text: `can't ${oneLine(action).slice(0, 20)} a reply waiting at gate 2` });
		return;
	}
	const q = requests.find((x) => x.req.id === id && !x.decision);
	if (q) {
		if (action !== "process" && action !== "ignore") return void ctlSend(CTL.notice, { id, text: `can't ${oneLine(action).slice(0, 20)} a request waiting at gate 1` });
		q.decision = action;
		q.by = "browser";
		ctlDone(id, action === "process" ? "processed" : "ignored", "browser");
		if (q.settle) q.settle({ decision: action, by: "browser" });
		else if (action === "ignore" && !q.pushed) requests = requests.filter((x) => x !== q); // never reaches Codex
		void ctlStatus();
		return;
	}
	ctlSend(CTL.done, { id, outcome: "gone", by: "browser" }); // already answered: first answer wins
}

function ctlSend(type, content) {
	if (!ctl || !room) return;
	void mx(room.server, "PUT", `/_matrix/client/v3/rooms/${enc(ctl.roomId)}/send/${enc(type)}/${randomUUID()}`, { token: room.token, body: content }).catch(() => {});
}
const ctlDone = (id, outcome, by) => ctlSend(CTL.done, { id, outcome, by });

async function ctlStatus(force = null, heartbeat = false) {
	if (!ctl || !room) return;
	const open = outbox.find((x) => !x.decision);
	const q = requests.find((x) => !x.decision);
	const waiting = requests.filter((x) => !x.decision).length + outbox.filter((x) => !x.decision).length;
	const state = force || (waiting ? "waiting" : runningTurn ? "working" : "idle");
	const t = turns.get(runningTurn);
	const detail =
		state === "waiting" ? (open ? `reply to ${oneLine(open.to)} waiting` : `${oneLine(q?.from ?? "someone")}: ${oneLine(firstLine(q?.req.text ?? "")).slice(0, 80)}`)
		: state === "working" ? (t?.kind === "owner" ? "on your request" : t?.kind === "peer" ? `on a request from ${labelOf(t.req.fromId)}` : "working")
		: state === "offline" ? "left"
		: "both gates on";
	const content = { state, detail, waiting, updated: Date.now() };
	const key = JSON.stringify({ ...content, updated: 0 });
	if (key === ctlLastStatus && !heartbeat) return;
	ctlLastStatus = key;
	ctlStatusAt = Date.now();
	await mx(room.server, "PUT", `/_matrix/client/v3/rooms/${enc(ctl.roomId)}/state/${enc(CTL.status)}/`, { token: room.token, body: content }).catch(() => {});
}
