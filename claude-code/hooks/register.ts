// duet for Claude Code: this session joins a chat-lab room (Matrix) as "<Owner>'s Claude Code".
//
// Joining. The owner's browser (chat-lab, My agents → Add my agent) shows a prompt to paste into
// Claude Code. Its one command installs or updates duet and writes ~/.duet/join.json with a ticket
// (server, room, owner, owner's account, control-room secret). duet looks at that file at a start, a
// /reload-plugins and the end of every turn, empties it, and shows a card: "Join <room> as <Owner>'s
// Claude Code? <Owner> will answer this agent's gates from the browser" · 1 Join · 2 Ignore. Only the
// press joins: whoever wrote the file, the person at this terminal decides.
//
// Two gates. Gate 1: someone else's request waits as a card (1 Process · 2 Ignore · 3 Process and
// send). Gate 2: every reply Claude sends with the send tool waits as a card with the whole reply
// (1 Send · 2 Don't send); the tool call holds until the press. "Process and send" OKs the first reply
// of that turn to that sender ahead. Both gates also go to the owner's browser through a private
// control room; the first answer wins. What the owner types to the agent there, or @-mentions it with
// in the room, is the owner's own input: no gate 1. Anything in the control room from anyone else is
// refused. While Claude works on a request it runs under the user's own permission mode: duet adds
// no limits of its own.
//
// Every function that touches `$` is in this file: Claude Code refuses `$` passed to an imported
// function. text.ts and matrix.ts are pure.

import type { EngineInterface, Register } from "claude-code";
import { MAX_TEXT, HIDDEN_MARK, byteLength, cleanName, firstLine, frameForClaude, oneLine, randomId, sanitize, stripHidden, timeOf, type Request } from "./text.ts";
import {
	APP, CTL, MAX_EVENT_BYTES, POWER_EVENTS, SEAT, agentName, controlAlias, filterNone, filterRoom, joinQuestion, localPart, membershipFrom,
	readJoinFile, replyContent, requestFrom, roomAlias, serverNameOf, shortId, type Ticket,
} from "./matrix.ts";

type $ = EngineInterface; // the engine interface, as each hook hands it over

const SEND_TOOL = "mcp__duet__send";
const VERSION = "0.20.0";
const AMBER = "#e9b45a";
const BLUE = "#8eb1ff";

// ---------- state (module variables: a reload of the module starts over) ----------

const moduleId = randomId(); // this module instance (kept in DUET_MODULE): an older one's gate 2 wait settles
let cwd = "";
let home = "";
let duetDir = "";
let interactive = false;

type Room = Ticket & { name: string; userId: string; token: string; roomId: string; cursor: string };
let room: Room | null = null;
let generation = 0; // bumped on every join and leave: loops and joins of an older room stop
let wakeSupervisor: (() => void) | null = null;
const names = new Map<string, string>(); // Matrix user id -> display name
const seats = new Map<string, any>(); // Matrix user id -> { kind, owner, app }
const peers = new Map<string, { left: boolean }>(); // who is in the room, by account
const seen = new Set<string>();
const sent = new Map<string, string>(); // our messages' event ids -> first line, to show what a reply answers

let joinOffer: (Ticket & { lines: string[] }) | null = null; // a join file taken, waiting for 1 Join / 2 Ignore
let queue: Request[] = []; // gate 1: requests waiting for the user
type Outgoing = { id: string; text: string; to: string; decision: string; by: string; editedText?: string };
let outbox: Outgoing[] = []; // gate 2: replies waiting for the user
// A request taken (a press), waiting for Claude to be idle; then submitted, waiting for its turn to start.
let pendingPeer: { reqs: Request[]; preSend: boolean; roomKey: string } | null = null;
let expected: { text: string; froms: string[]; reqs: Request[]; preSend: boolean; at: number }[] = [];
let peerTurn: { turnId: string; froms: string[]; askers: string[]; answers: Request[]; preSend: string } | null = null;
let runningTurn = ""; // the main loop's turn in progress, "" while Claude is idle
let userPromptSince = false; // the user typed a prompt since duet's last submission
let choosing = false;

// Owner control: the private control room the owner's browser made (PROTOCOL.md).
let ctl: { roomId: string; since: string } | null = null;
let ctlLastStatus = "";
let ctlStatusAt = 0;
let ctlStatusTimer = false;
let ownerTurns: { text: string; re: string; turnId: string }[] = []; // the owner's own inputs from the browser
let ownerQueue: Request[] = []; // the owner's own @-messages in the room, waiting for Claude to be free

const roomKeyOf = (r: Room) => `${r.server} ${r.room}`;
const nameOf = (id: string) => names.get(id) || shortId(id);
// A member as shown and addressed: the plain name, or "name (account)" when another member looks the same.
function labelOf(id: string): string {
	const base = cleanName(nameOf(id));
	const clash = /[^\x20-\x7e]/.test(base) || [...peers.entries()].some(([pid, p]) => pid !== id && !p.left && cleanName(nameOf(pid)).toLowerCase() === base.toLowerCase());
	return clash ? `${base} (${shortId(id)})` : base;
}
const livePeers = () => [...peers.entries()].filter(([, p]) => !p.left).map(([id]) => ({ id, label: labelOf(id) }));
const peerList = () => livePeers().map((p) => p.label).join(", ");
const busyWithPeer = () => !!(pendingPeer || peerTurn || expected.length);

// ---------- small helpers ----------

function redraw($: $) {
	$.ui.invalidate("ui.render");
	ctlStatusSoon($);
}

function wait($: $, ms: number): Promise<void> {
	return new Promise((resolve) => {
		$.clock.after(ms, resolve);
	});
}

class MxError extends Error {
	constructor(readonly status: number, readonly body: any) {
		super(`${body?.errcode || "HTTP " + status}: ${body?.error || "request failed"}`);
	}
}
const enc = encodeURIComponent;

// One Matrix Client-Server API call. $.http.fetch has no timeout of its own: race it.
async function mx($: $, base: string, method: string, path: string, opts: { token?: string; body?: unknown; timeoutMs?: number } = {}): Promise<any> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
	const ms = opts.timeoutMs ?? 20_000;
	const res: any = await Promise.race([
		$.http.fetch(base + path, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) }),
		new Promise((_, reject) => {
			$.clock.after(ms, () => reject(new Error(`server timeout (${Math.round(ms / 1000)} s)`)));
		}),
	]);
	let json: any = {};
	try {
		json = res.text ? JSON.parse(res.text) : {};
	} catch {}
	if (!res.ok) throw new MxError(res.status, json);
	return json;
}

// This owner's agent account on this server: made once (chat-lab's sign-up token) and kept.
async function mxAccount($: $, base: string, owner: string): Promise<{ userId: string; token: string }> {
	const key = `mx:acct:${base} ${owner}`;
	const saved = (await $.store.get(key)) as { userId: string; token: string } | undefined;
	if (saved?.token) {
		try {
			await mx($, base, "GET", "/_matrix/client/v3/account/whoami", { token: saved.token });
			return saved;
		} catch (err: any) {
			if (err?.status !== 401) throw err;
		}
	}
	const regToken = (await $.env.get("DUET_MATRIX_TOKEN")) || "chatlab-dev-token";
	const req = { username: localPart(owner, randomId().replace(/-/g, "").slice(0, 5)), password: randomId() + randomId(), initial_device_display_name: "duet for Claude Code" };
	let res: any;
	try {
		res = await mx($, base, "POST", "/_matrix/client/v3/register", { body: req });
	} catch (err: any) {
		if (err?.status !== 401) throw err;
		res = await mx($, base, "POST", "/_matrix/client/v3/register", { body: { ...req, auth: { type: "m.login.registration_token", token: regToken, session: err.body?.session } } });
	}
	const acct = { userId: res.user_id, token: res.access_token };
	await mx($, base, "PUT", `/_matrix/client/v3/profile/${enc(acct.userId)}/displayname`, { token: acct.token, body: { displayname: agentName(owner) } });
	await $.store.set(key, acct);
	return acct;
}

// Join the room for this code, or make it. Two making it at once: the address goes to one; the
// server sometimes accepts both claims (last write wins), so read it back and move if we lost.
async function mxJoinRoom($: $, base: string, token: string, alias: string): Promise<string> {
	const joinIt = async () => (await mx($, base, "POST", `/_matrix/client/v3/join/${enc(alias)}`, { token, body: {} })).room_id;
	try {
		return await joinIt();
	} catch (err: any) {
		if (err?.body?.errcode !== "M_NOT_FOUND") throw err;
	}
	const { room_id } = await mx($, base, "POST", "/_matrix/client/v3/createRoom", {
		token,
		body: { name: "chat-lab room", preset: "public_chat", power_level_content_override: { events: POWER_EVENTS }, initial_state: [{ type: "m.room.history_visibility", state_key: "", content: { history_visibility: "shared" } }] },
	});
	const giveUp = async () => {
		await mx($, base, "POST", `/_matrix/client/v3/rooms/${enc(room_id)}/leave`, { token, body: {} }).catch(() => {});
		return joinIt();
	};
	try {
		await mx($, base, "PUT", `/_matrix/client/v3/directory/room/${enc(alias)}`, { token, body: { room_id } });
	} catch (err: any) {
		if (err?.status !== 409) throw err;
		return giveUp();
	}
	await wait($, 600);
	const holder = (await mx($, base, "GET", `/_matrix/client/v3/directory/room/${enc(alias)}`, { token })).room_id;
	return holder === room_id ? room_id : giveUp();
}

// ---------- receiving ----------

// Runs for the whole session: idles until a room is joined, then long-polls it.
async function supervise($: $) {
	let backoff = 1000;
	for (;;) {
		if (!room) {
			await new Promise<void>((resolve) => (wakeSupervisor = resolve));
			wakeSupervisor = null;
			continue;
		}
		const gen = generation;
		const ok = await syncOnce($, room, gen);
		if (gen !== generation || ok) {
			backoff = 1000;
			continue;
		}
		await wait($, backoff);
		backoff = Math.min(backoff * 2, 30_000);
	}
}

async function syncOnce($: $, r: Room, gen: number): Promise<boolean> {
	const since = r.cursor;
	try {
		const s = await mx($, r.server, "GET", `/_matrix/client/v3/sync?timeout=20000&since=${enc(since)}&filter=${enc(filterRoom(r.roomId))}`, { token: r.token, timeoutMs: 45_000 });
		if (gen !== generation) return true;
		const joined = s.rooms?.join?.[r.roomId];
		for (const ev of joined?.state?.events ?? []) onSeat(ev);
		let evs: any[] = joined?.timeline?.events ?? [];
		// A cut timeline: page back to where the last sync ended, so nothing in between is missed.
		if (joined?.timeline?.limited && joined.timeline.prev_batch) evs = [...(await gapEvents($, r, joined.timeline.prev_batch, since)), ...evs];
		for (const ev of evs) {
			if (gen !== generation) return true;
			onRoomEvent($, r, ev);
		}
		if (gen === generation) r.cursor = s.next_batch;
		return true;
	} catch {
		return gen !== generation;
	}
}

async function gapEvents($: $, r: Room, from: string, to: string): Promise<any[]> {
	const out: any[] = [];
	for (let page = 0, at = from; at && page < 20; page++) {
		const m = await mx($, r.server, "GET", `/_matrix/client/v3/rooms/${enc(r.roomId)}/messages?dir=b&limit=100&from=${enc(at)}&to=${enc(to)}`, { token: r.token });
		out.push(...(m.chunk ?? []));
		if (!m.end || !m.chunk?.length) break;
		at = m.end;
	}
	return out.reverse();
}

function onSeat(ev: any) {
	if (ev?.type === SEAT && typeof ev.state_key === "string" && ev.state_key.startsWith("@")) seats.set(ev.state_key, ev.content || {});
}

function onRoomEvent($: $, r: Room, ev: any) {
	if (typeof ev?.event_id !== "string" || seen.has(ev.event_id)) return;
	seen.add(ev.event_id);
	if (seen.size > 2000) seen.delete(seen.values().next().value!);
	if (ev.type === SEAT) return onSeat(ev);
	const m = membershipFrom(ev);
	if (m) {
		if (m.name) names.set(m.id, m.name);
		if (m.id !== r.userId && m.what === "joined") peers.set(m.id, { left: false });
		if (m.id !== r.userId && m.what === "left") peers.set(m.id, { left: true });
		return;
	}
	const req = requestFrom(ev, r.userId, nameOf, (id) => seats.get(id));
	if (!req) return;
	if (req.toId && req.toId !== r.userId) return; // addressed to someone else: not for this agent
	if (req.ts < Date.now() - 12 * 3600_000) return; // never act on anything older than 12 h
	if (!peers.has(req.fromId) || peers.get(req.fromId)!.left) peers.set(req.fromId, { left: false });
	req.from = labelOf(req.fromId);
	if (req.re && sent.has(req.re)) req.reLine = sent.get(req.re);
	// The owner's own message: @-addressed to this agent it is their input (no gate 1); anything else
	// they say in the room is for the people there.
	if (req.fromId === r.ownerId) {
		if (req.toId === r.userId) {
			ownerQueue.push(req);
			void flowOwner($).catch(() => {});
		}
		return;
	}
	queue.push(req);
	ctlGate1($, req);
	$.ui.toast(`${req.from}: new request`);
	redraw($);
}

// ---------- handing requests to Claude ----------

async function startPeerTurn($: $, reqs: Request[], preSend: boolean) {
	if (!room) return;
	pendingPeer = { reqs, preSend, roomKey: roomKeyOf(room) };
	redraw($);
	await submitWhenIdle($);
}

// Hand the taken requests to Claude once no turn is running, so the turn it starts is the next one.
async function submitWhenIdle($: $) {
	const p = pendingPeer;
	if (!p || runningTurn) return;
	pendingPeer = null;
	if (!room || roomKeyOf(room) !== p.roomKey) return redraw($); // the room was left meanwhile
	const text = frameForClaude(p.reqs, cwd, SEND_TOOL, livePeers().map((x) => x.label).join(", "), room.name);
	expected = [...expected, { text, froms: [...new Set(p.reqs.map((x) => x.from))], reqs: p.reqs, preSend: p.preSend, at: Date.now() }];
	userPromptSince = false;
	redraw($);
	let result: any;
	try {
		result = await $.prompt.submit({ text }); // never `asUser`: Claude Code marks it as the plugin's
	} catch (err: any) {
		result = { drop: String(err?.message ?? err) };
	}
	if (result?.drop) {
		expected = expected.filter((x) => x.text !== text);
		queue.unshift(...p.reqs);
		for (const q of p.reqs) ctlGate1($, q);
		$.ui.toast("duet: Claude Code refused the request: " + sanitize(result.drop, 120));
		redraw($);
	}
}

// The owner's own @-messages from the room: to Claude when it's free, no gate 1 (gate 2 still guards the room).
async function flowOwner($: $) {
	if (!room || !ownerQueue.length || busyWithPeer() || choosing) return;
	if (!(await sendToolReady($))) return;
	if (!ownerQueue.length || busyWithPeer()) return;
	await startPeerTurn($, ownerQueue.splice(0), false);
}

// ---------- joining and leaving ----------

async function takeJoinFile($: $): Promise<boolean> {
	const path = `${duetDir}/join.json`;
	let text: string;
	try {
		if (!(await $.fs.exists(path))) return false;
		text = String(await $.fs.read(path));
	} catch {
		return false;
	}
	const got = readJoinFile(text, await $.clock.now());
	if (!got) return false;
	try {
		await $.fs.write(path, "{}"); // taken once: whichever Claude Code looks next
	} catch {
		return false;
	}
	if (!got.take) return false;
	joinOffer = { ...got.take, lines: joinQuestion(got.take, cwd, home) };
	redraw($);
	return true;
}

function answerJoinOffer($: $, yes: boolean) {
	const o = joinOffer;
	joinOffer = null;
	redraw($);
	if (o && yes) void join($, o).catch(() => {});
}

async function join($: $, t: Ticket) {
	if (room) await leave($);
	const gen = generation;
	let r: Room;
	let members: any, state: any;
	try {
		const acct = await mxAccount($, t.server, t.owner);
		const alias = await roomAlias(t.room, serverNameOf(acct.userId));
		// Start from now, taken before joining: nothing said after the join is missed.
		const start = (await mx($, t.server, "GET", `/_matrix/client/v3/sync?timeout=0&filter=${enc(filterNone)}`, { token: acct.token })).next_batch;
		const roomId = await mxJoinRoom($, t.server, acct.token, alias);
		await mx($, t.server, "PUT", `/_matrix/client/v3/rooms/${enc(roomId)}/state/${SEAT}/${enc(acct.userId)}`, { token: acct.token, body: { kind: "agent", owner: t.owner, app: APP } }).catch(() => {});
		members = await mx($, t.server, "GET", `/_matrix/client/v3/rooms/${enc(roomId)}/joined_members`, { token: acct.token });
		state = await mx($, t.server, "GET", `/_matrix/client/v3/rooms/${enc(roomId)}/state`, { token: acct.token });
		r = { ...t, name: agentName(t.owner), userId: acct.userId, token: acct.token, roomId, cursor: start };
	} catch (err: any) {
		$.ui.log(`duet: ${t.server}: ${sanitize(String(err?.message ?? err), 200)} · not joined`);
		$.ui.toast("duet: server unreachable · not joined");
		return;
	}
	if (gen !== generation || room) return;
	room = r;
	generation++;
	queue = [];
	outbox = [];
	ownerQueue = [];
	peers.clear();
	names.clear();
	seats.clear();
	for (const ev of Array.isArray(state) ? state : []) {
		onSeat(ev);
		if (ev?.type === "m.room.member" && typeof ev.content?.displayname === "string") names.set(ev.state_key, ev.content.displayname);
	}
	for (const [id, m] of Object.entries<any>(members?.joined ?? {})) {
		if (m?.display_name) names.set(id, m.display_name);
		if (id !== r.userId) peers.set(id, { left: false });
	}
	wakeSupervisor?.();
	$.ui.log(`duet: joined ${r.room} as ${r.name}`);
	void controlStart($, r, generation).catch((err) => $.ui.log(`duet: control room: ${sanitize(String(err?.message ?? err), 160)} · gates in this terminal only`));
	redraw($);
}

async function leave($: $) {
	if (!room) return;
	const r = room;
	for (const q of queue) ctlDone($, q.id, "dropped", "terminal");
	await ctlStatus($, "offline").catch(() => {});
	ctl = null;
	room = null;
	generation++;
	queue = [];
	ownerQueue = [];
	pendingPeer = null;
	void mx($, r.server, "POST", `/_matrix/client/v3/rooms/${enc(r.roomId)}/leave`, { token: r.token, body: {} }).catch(() => {});
	redraw($);
}

// ---------- gate 1 ----------

// A press acts on every waiting request (the terminal card), or on the ones the browser names.
async function choose($: $, action: "take" | "take-send" | "ignore", ids: string[] | null, by: string) {
	if (choosing || !room) return;
	const reqs = ids ? queue.filter((q) => ids.includes(q.id)) : [...queue];
	if (!reqs.length) return;
	const take = action !== "ignore";
	if (take) {
		if (busyWithPeer()) return void $.ui.toast("duet: busy with the last request");
		// No send tool here: Claude would have no way to answer. Keep the request waiting.
		choosing = true;
		let ready = false;
		try {
			ready = await sendToolReady($);
		} finally {
			choosing = false;
		}
		if (!ready) return void $.ui.toast("duet: the send tool is off in this folder · /mcp → duet → Enable · the request waits");
		if (!room || busyWithPeer() || !reqs.every((q) => queue.includes(q))) return;
	}
	queue = queue.filter((q) => !reqs.includes(q));
	for (const q of reqs) ctlDone($, q.id, take ? "processed" : "ignored", by);
	if (take) await startPeerTurn($, reqs, action === "take-send");
	else redraw($); // ignored: nothing goes to the other side
}

// ---------- the send tool and gate 2 ----------

const SEND_SPEC = {
	name: "send",
	description:
		"Send a message to the other agent(s) in your duet room (another developer's coding agent on their computer). " +
		"Use it to answer a duet request, or when your user asks you to tell the other side something. " +
		"Your text replies are seen only by your own user; this tool is the only way to reach the other side. " +
		"Send one complete reply when you're done, not progress updates. " +
		"Your user sees the whole reply and presses Send or Don't send; if they don't send it, don't send it again.",
	inputSchema: {
		type: "object",
		properties: {
			text: { type: "string", description: "The message." },
			to: { type: "string", description: "Recipient name, if the room has more than one other person." },
		},
		required: ["text"],
	},
};

async function hasSendTool($: $): Promise<boolean | null> {
	try {
		return (await $.tool.list()).some((t: any) => t.name === SEND_TOOL);
	} catch {
		return null; // Claude Code can't say: don't hold the request on a guess
	}
}

async function sendToolReady($: $): Promise<boolean> {
	if ((await hasSendTool($)) !== false) return true;
	try {
		await $.tool.register(SEND_SPEC);
	} catch {}
	return (await hasSendTool($)) !== false;
}

function decide($: $, item: Outgoing, decision: string, by = "terminal") {
	if (item.decision) return;
	item.decision = decision;
	item.by = by;
	redraw($);
}

// Hold the tool call until a press. A hook's time limit stops while a `$` call is in flight but runs on
// through the mod's own promises and $.clock.sleep, so the wait sits in short `sleep` processes (macOS,
// Linux, Git Bash); without `sleep`, `ping` to this computer (Windows). With neither, $.clock.sleep:
// that counts against the hook's 10 s and the hook's .catch refuses the send (fails closed).
const WAITERS = [
	{ argv: ["sleep", "0.25"], timeoutMs: 2000 },
	{ argv: ["ping", "-n", "2", "127.0.0.1"], timeoutMs: 3000 },
];
let waiter = 0;
let waiterFails = 0;
async function waitForPress($: $, item: Outgoing, signal?: AbortSignal): Promise<string> {
	while (!item.decision) {
		if (signal?.aborted) return "stopped";
		if (!room) return "left";
		// The module was reloaded (an update) while this waits: the new one never draws this card.
		if (((await $.env.get("DUET_MODULE").catch(() => "")) || moduleId) !== moduleId) return "reloaded";
		if (item.decision) break;
		if (waiter < WAITERS.length) {
			let missing = false;
			try {
				const r = await $.process.run(WAITERS[waiter]!.argv, { timeoutMs: WAITERS[waiter]!.timeoutMs });
				if (r.exitCode === 0) {
					waiterFails = 0;
					continue;
				}
			} catch (err: any) {
				missing = /ENOENT|not found|cannot find|no such file/i.test(String(err?.message ?? err));
			}
			if (missing || ++waiterFails >= 3) {
				waiter++;
				waiterFails = 0;
			}
			continue;
		}
		try {
			await $.clock.sleep(250, signal ? { signal } : undefined);
		} catch {
			return "stopped";
		}
	}
	return signal?.aborted ? "stopped" : item.decision;
}

async function sendTool($: $, e: any, signal?: AbortSignal): Promise<{ result: string }> {
	if (!room) return { result: "Not sent: not in a duet room" };
	const r = room;
	const raw = String(e.text ?? "");
	const text = sanitize(raw, MAX_TEXT).trim(); // what goes out is exactly what the card shows
	if (!stripHidden(raw).text.trim()) return { result: "Not sent: empty" };
	if (raw.length > MAX_TEXT) return { result: `Not sent: ${raw.length} characters, limit ${MAX_TEXT}` };
	// `to` comes from the model: only someone in the room, by the label Claude was given.
	const toArg = typeof e.to === "string" && e.to.trim() ? e.to.trim() : undefined;
	let toId: string | undefined;
	if (toArg !== undefined) {
		if (stripHidden(toArg).hidden || /[\r\n]/.test(toArg) || toArg.length > 120) return { result: "Not sent: bad name in to" };
		const hits = livePeers().filter((p) => p.label === toArg || shortId(p.id) === toArg || p.id === toArg || cleanName(nameOf(p.id)).toLowerCase() === cleanName(toArg).toLowerCase());
		if (hits.length !== 1) return { result: hits.length ? `Not sent: ${hits.length} members match ${oneLine(toArg)} · use one of: ${hits.map((p) => p.label).join(", ")}` : `Not sent: no ${oneLine(toArg)} in the room · in it: ${peerList() || "no one yet"}` };
		toId = hits[0]!.id;
	}
	// Answering one sender's request, a reply without `to` goes to that sender: an unaddressed message
	// would reach every agent's gate 1 in the room.
	const ownTurn = !!peerTurn && peerTurn.turnId === runningTurn && !e.agentId;
	if (toId === undefined && ownTurn && peerTurn!.askers.length === 1 && peers.get(peerTurn!.askers[0]!)?.left === false) toId = peerTurn!.askers[0];
	const sendTo = toId ? labelOf(toId) : undefined;
	if (byteLength(JSON.stringify(replyContent(text, "@x:x", sendTo, "$x"))) > MAX_EVENT_BYTES) return { result: "Not sent: too long for one Matrix message (about 60 KB) · send the key part, or split it" };
	// "Process and send": the first send of that turn that reaches exactly its sender skips gate 2.
	// Used up before any await, so two sends in parallel can't both use it.
	const preSent = ownTurn && !!peerTurn!.preSend && toId === peerTurn!.preSend;
	if (preSent) peerTurn!.preSend = "";
	let out = text;
	let gate2: Outgoing | null = null;
	if (!preSent) {
		const item: Outgoing = { id: randomId(), text, to: sendTo ?? (peerList() || "the room"), decision: "", by: "" };
		outbox = [...outbox, item];
		ctlSend($, CTL.gate, { id: item.id, gate: 2, draft: text, to: { id: toId ?? "", name: item.to }, ts: Date.now() });
		$.ui.toast(`duet: reply to ${oneLine(item.to)} waiting`);
		redraw($);
		let decision: string;
		try {
			decision = await waitForPress($, item, signal);
		} finally {
			outbox = outbox.filter((x) => x !== item);
			redraw($);
		}
		if (decision !== "send") {
			ctlDone($, item.id, decision === "drop" ? "cancelled" : "dropped", item.by || "terminal");
			if (decision === "drop") return { result: "Not sent: your user said no · don't resend" };
			if (decision === "reloaded") return { result: "Not sent: duet restarted · send it again" };
			return { result: "Not sent" };
		}
		if (room !== r) return { result: "Not sent: left the room" };
		if (item.editedText !== undefined) out = item.editedText;
		gate2 = item;
	}
	try {
		const asked = ownTurn ? peerTurn!.answers.filter((m) => !toId || m.fromId === toId).at(-1) : undefined;
		const content = replyContent(out, toId, toId ? cleanName(nameOf(toId)) : undefined, asked?.id);
		const res = await mx($, r.server, "PUT", `/_matrix/client/v3/rooms/${enc(r.roomId)}/send/m.room.message/${randomId()}`, { token: r.token, body: content });
		sent.set(res.event_id, firstLine(out));
		if (sent.size > 200) sent.delete(sent.keys().next().value!);
		if (gate2) ctlDone($, gate2.id, gate2.editedText !== undefined ? "edited" : "sent", gate2.by || "terminal");
	} catch (err: any) {
		if (gate2) ctlDone($, gate2.id, "failed", gate2.by || "terminal");
		return { result: "Not sent: " + sanitize(String(err?.message ?? err), 200) };
	}
	const where = sendTo ?? (peerList() || "the room");
	if (gate2?.editedText !== undefined) return { result: `Sent to ${where} · your user edited it before sending; what went out: ${out}` };
	return { result: `Sent to ${where}${preSent ? " (OK'd ahead)" : ""}${text.endsWith(HIDDEN_MARK) ? " · hidden characters removed" : ""}` };
}

// ---------- owner control (peer-agents/owner-control/PROTOCOL.md) ----------

async function controlStart($: $, r: Room, gen: number) {
	const since = (await mx($, r.server, "GET", `/_matrix/client/v3/sync?timeout=0&filter=${enc(filterNone)}`, { token: r.token })).next_batch;
	const alias = await controlAlias(r.secret, serverNameOf(r.userId));
	const roomId = (await mx($, r.server, "POST", `/_matrix/client/v3/join/${enc(alias)}`, { token: r.token, body: {} })).room_id;
	if (gen !== generation || room !== r) return;
	ctl = { roomId, since };
	ctlLastStatus = "";
	ctlSend($, CTL.hello, { agent: r.name, app: APP, room: r.room, cwd, owner: r.ownerId, version: VERSION });
	for (const q of queue) ctlGate1($, q); // anything already waiting shows in the browser too
	await ctlStatus($, null, true);
	$.ui.log(`duet: ${r.owner}'s browser can answer this agent's gates`);
	void controlLoop($, r, gen).catch(() => {});
}

async function controlLoop($: $, r: Room, gen: number) {
	let backoff = 1000;
	while (ctl && gen === generation && room === r) {
		try {
			const s = await mx($, r.server, "GET", `/_matrix/client/v3/sync?timeout=20000&since=${enc(ctl.since)}&filter=${enc(filterRoom(ctl.roomId))}`, { token: r.token, timeoutMs: 45_000 });
			if (!ctl || gen !== generation) return;
			for (const ev of s.rooms?.join?.[ctl.roomId]?.timeline?.events ?? []) onControlEvent($, r, ev);
			ctl.since = s.next_batch;
			backoff = 1000;
			// A heartbeat: the browser marks an agent silent for a minute as stale.
			if (Date.now() - ctlStatusAt > 30_000) await ctlStatus($, null, true);
		} catch {
			await wait($, backoff);
			backoff = Math.min(backoff * 2, 30_000);
		}
	}
}

// A decision or input in the control room. Only the owner's own events count.
function onControlEvent($: $, r: Room, ev: any) {
	if (typeof ev?.event_id !== "string" || seen.has(ev.event_id)) return;
	seen.add(ev.event_id);
	if (ev.type !== CTL.decision && ev.type !== CTL.input) return;
	if (ev.sender !== r.ownerId) {
		ctlSend($, CTL.refused, { event_id: ev.event_id, sender: String(ev.sender), reason: "not this agent's owner" });
		$.ui.log(`duet: refused a control event from ${sanitize(String(ev.sender), 80)} (not the owner)`);
		return;
	}
	const c = ev.content ?? {};
	if (ev.type === CTL.input) {
		const text = sanitize(String(c.text ?? "")).trim();
		if (!text) return;
		ownerTurns.push({ text, re: ev.event_id, turnId: "" });
		userPromptSince = true;
		void $.prompt.submit({ text, asUser: true }).catch(() => {
			ctlSend($, CTL.notice, { text: "Claude Code refused the input" });
			ownerTurns = ownerTurns.filter((t) => t.re !== ev.event_id);
		});
		return;
	}
	const id = String(c.id ?? "");
	const action = String(c.action ?? "");
	const item = outbox.find((x) => x.id === id && !x.decision);
	if (item) {
		if (action === "send") decide($, item, "send", "browser");
		else if (action === "cancel") decide($, item, "drop", "browser");
		else if (action === "edit" && typeof c.text === "string" && sanitize(c.text).trim()) {
			const t = sanitize(c.text).trim();
			if (byteLength(JSON.stringify(replyContent(t, "@x:x", "x", "$x"))) > MAX_EVENT_BYTES) return void ctlSend($, CTL.notice, { id, text: "edited text too long for one Matrix message" });
			item.editedText = t;
			decide($, item, "send", "browser");
		} else ctlSend($, CTL.notice, { id, text: `can't ${sanitize(action, 20)} a reply waiting at gate 2` });
		return;
	}
	if (queue.some((q) => q.id === id)) {
		const map: Record<string, "take" | "take-send" | "ignore"> = { process: "take", process_send: "take-send", ignore: "ignore" };
		const act = map[action];
		if (!act) return void ctlSend($, CTL.notice, { id, text: `can't ${sanitize(action, 20)} a request waiting at gate 1` });
		void choose($, act, [id], "browser")
			.then(() => {
				if (queue.some((q) => q.id === id)) ctlSend($, CTL.notice, { id, text: busyWithPeer() ? "busy with the last request · try again when it's done" : "not taken" });
			})
			.catch(() => {});
		return;
	}
	ctlSend($, CTL.done, { id, outcome: "gone", by: "browser" }); // already answered (first answer wins)
}

function ctlSend($: $, type: string, content: unknown) {
	if (!ctl || !room) return;
	const r = room;
	void mx($, r.server, "PUT", `/_matrix/client/v3/rooms/${enc(ctl.roomId)}/send/${enc(type)}/${randomId()}`, { token: r.token, body: content }).catch(() => {});
}

const ctlGate1 = ($: $, q: Request) => ctlSend($, CTL.gate, { id: q.id, gate: 1, rev: 0, from: { id: q.fromId, name: q.from }, text: q.text, ts: q.ts });
const ctlDone = ($: $, id: string, outcome: string, by: string) => ctlSend($, CTL.done, { id, outcome, by });

function ctlStatusSoon($: $) {
	if (!ctl || ctlStatusTimer) return;
	ctlStatusTimer = true;
	$.clock.after(300, () => {
		ctlStatusTimer = false;
		void ctlStatus($, null).catch(() => {});
	});
}

// idle / working / waiting / offline, a short line, and how many wait for the owner.
async function ctlStatus($: $, force: string | null, heartbeat = false) {
	if (!ctl || !room) return;
	const open = outbox.find((x) => !x.decision);
	const waiting = queue.length + outbox.filter((x) => !x.decision).length;
	const state = force || (waiting ? "waiting" : runningTurn ? "working" : "idle");
	const detail =
		state === "waiting" ? (open ? `reply to ${oneLine(open.to)} waiting` : `${oneLine(queue[0]?.from ?? "someone")}: ${oneLine(firstLine(queue[0]?.text ?? "")).slice(0, 80)}`)
		: state === "working" ? (ownerTurns.some((t) => t.turnId === runningTurn) ? "on your request" : peerTurn ? `on a request from ${peerTurn.froms.join(", ")}` : "working")
		: state === "offline" ? "left"
		: "both gates on";
	const content = { state, detail, waiting, updated: Date.now() };
	const key = JSON.stringify({ ...content, updated: 0 });
	if (key === ctlLastStatus && !heartbeat) return;
	ctlLastStatus = key;
	ctlStatusAt = Date.now();
	await mx($, room.server, "PUT", `/_matrix/client/v3/rooms/${enc(ctl.roomId)}/state/${enc(CTL.status)}/`, { token: room.token, body: content });
}

// ---------- drawing: the card above the prompt ----------

// A long text as Text rows, each well under one Text child's 10,000 characters.
function textRows(Text: any, text: string, keyPrefix: string): any[] {
	const rows: any[] = [];
	sanitize(text).split("\n").forEach((line, i) => {
		for (let at = 0, j = 0; at < Math.max(line.length, 1); at += 5000, j++) rows.push(Text({ key: `${keyPrefix}${i}.${j}`, children: [line.slice(at, at + 5000) || " "] }));
	});
	return rows;
}

const rowsFor = (text: string, columns: number) => String(text).split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / Math.max(columns - 4, 20))), 0);

function drawCard($: $, e: any): any {
	const { Box, Text, Button } = $.ui.resolve(e);
	const frame = (color: string, children: any[]) => Box({ flexDirection: "column", borderStyle: "round", borderColor: color, paddingX: 1, children });
	const buttons = (list: any[]) => Box({ flexDirection: "row", columnGap: 3, flexWrap: "wrap", children: list });
	const fits = (rows: number) => rows + 4 <= (e.props?.maxRows ?? 10);
	const columns = e.props?.bodyColumns ?? 80;
	// A join file taken: only the user's own press joins.
	if (joinOffer) {
		return frame(BLUE, [
			Text({ bold: true, children: [joinOffer.lines[0]! + (room ? ` · leaves ${oneLine(room.room)}` : "")] }),
			Text({ dimColor: true, children: [joinOffer.lines[1]!] }),
			buttons([
				Button({ key: "join", label: "Join", hotkey: "1", plain: true, onPress: () => answerJoinOffer($, true) }),
				Button({ key: "join-ignore", label: "Ignore", hotkey: "2", plain: true, onPress: () => answerJoinOffer($, false) }),
			]),
		]);
	}
	if (!room) return null;
	// Gate 2 first: Claude's tool call is waiting on it.
	const item = outbox.find((x) => !x.decision);
	if (item) {
		const more = outbox.length > 1 ? ` · +${outbox.length - 1}` : "";
		const title = Text({ bold: true, children: [`Send to ${oneLine(item.to)}? · full reply${more}`] });
		const keys = buttons([
			Button({ key: "send", label: "Send", hotkey: "1", plain: true, onPress: () => decide($, item, "send") }),
			Button({ key: "dont-send", label: "Don't send", hotkey: "2", plain: true, onPress: () => decide($, item, "drop") }),
		]);
		const body = textRows(Text, item.text, "r");
		// A bare digit presses only Buttons inside the band's window: a tall reply keeps its keys at the top.
		return frame(BLUE, fits(rowsFor(item.text, columns)) ? [title, ...body, keys] : [title, keys, ...body]);
	}
	if (pendingPeer) return frame(AMBER, [Text({ dimColor: true, children: [`${oneLine(pendingPeer.reqs[0]!.from)} · starts when Claude is free`] })]);
	if (!queue.length) return null;
	// Gate 1: every waiting request, every word Claude would get, in arrival order. One press takes all.
	const froms = [...new Set(queue.map((q) => q.from))];
	const body = queue.flatMap((q, i) => [
		...(i > 0 ? [Text({ key: `sep${i}`, dimColor: true, children: ["—"] })] : []),
		...(froms.length > 1 ? [Text({ key: `who${i}`, dimColor: true, children: [`${oneLine(q.from)} · ${timeOf(q.ts)}`] })] : []),
		...(q.reLine ? [Text({ key: `re${i}`, dimColor: true, children: [`↳ re “${sanitize(q.reLine, 80)}”`] })] : []),
		...textRows(Text, q.text, `q${i}.`),
	]);
	const head = Box({
		flexDirection: "row",
		justifyContent: "space-between",
		children: [
			Text({ bold: true, color: AMBER, children: [`${oneLine(froms.join(", "))} · ${timeOf(queue[0]!.ts)}`] }),
			...(queue.length > 1 ? [Text({ dimColor: true, children: [`${queue.length} messages`] })] : []),
		],
	});
	const keys = buttons([
		Button({ key: "take", label: "Process", hotkey: "1", plain: true, onPress: () => void choose($, "take", null, "terminal").catch(() => {}) }),
		Button({ key: "ignore", label: "Ignore", hotkey: "2", plain: true, onPress: () => void choose($, "ignore", null, "terminal").catch(() => {}) }),
		// 3, not 2: a habit press of 2 (Ignore here, Don't send on the reply card) must never skip gate 2.
		Button({ key: "take-send", label: "Process and send", hotkey: "3", plain: true, onPress: () => void choose($, "take-send", null, "terminal").catch(() => {}) }),
	]);
	const rows = queue.reduce((n, q) => n + rowsFor(q.text, columns) + 1, 0);
	return frame(AMBER, fits(rows) ? [head, ...body, keys] : [head, keys, ...body]);
}

// ---------- hooks ----------

export const register: Register = (on) => {
	on("session.start", async ($, e, next) => {
		try {
			await $.command.register({ name: "duet", description: "duet: /duet status · /duet off (leave the room)", argumentHint: "[status | off]", immediate: true });
		} catch {}
		try {
			await $.tool.register(SEND_SPEC);
		} catch (err: any) {
			$.ui.log(`duet: the send tool didn't register (${sanitize(String(err?.message ?? err), 120)}) · /reload-plugins`);
		}
		cwd = e.cwd || (await $.session.cwd());
		home = (await $.env.get("HOME")) || (await $.env.get("USERPROFILE")) || "";
		duetDir = ((await $.env.get("DUET_HOME")) || `${home.replace(/\/+$/, "")}/.duet`).replace(/\\/g, "/");
		await $.env.set("DUET_MODULE", moduleId).catch(() => {});
		void supervise($).catch(() => {});
		interactive = !!e.isInteractive;
		if (interactive) void takeJoinFile($).catch(() => {});
		return next(e);
	});

	on("session.end", async ($, e, next) => {
		// /clear and /resume end the conversation, not the window: stay in the room.
		if (room && e.reason !== "clear" && e.reason !== "resume") void leave($).catch(() => {});
		return next(e);
	});

	on("command.run", { command: "duet" }, async ($, e) => {
		const arg = String(e.args ?? "").trim().toLowerCase();
		if (["off", "leave", "stop", "quit", "exit"].includes(arg)) {
			const was = room;
			if (was) await leave($);
			$.ui.log(was ? `duet: left ${was.room}` : "duet: not in a room");
		} else if (!room) $.ui.log("duet: not in a room · paste the prompt from chat-lab's My agents panel to join one");
		else $.ui.log(`duet: in ${room.room} as ${room.name} · with ${peerList() || "no one yet"} · ${queue.length + outbox.length} waiting · /duet off to leave`);
		return {};
	});

	on("tool.describe", { tool: SEND_TOOL }, async ($, e) => ({ description: e.description, isDeferred: false }));

	on("tool.call", { tool: SEND_TOOL }, async ($, e, next) => sendTool($, e, next.signal)).catch(async () => ({ result: "Not sent: duet error · ask your user before resending" }));

	on("prompt.submit", async ($, e, next) => {
		const result = await next(e);
		if (!result?.drop && (e.origin?.kind === "composer" || e.origin?.kind === "bridge")) userPromptSince = true;
		return result;
	}).catch(($, e, next) => next(e));

	on("turn.start", async ($, e, next) => {
		if (e.agentId) return next(e); // a subagent's turn
		runningTurn = e.turnId;
		const text = String(e.text ?? "");
		const o = ownerTurns.findIndex((t) => !t.turnId && text.trim() === t.text);
		if (o >= 0) ownerTurns[o]!.turnId = e.turnId;
		else {
			expected = expected.filter((x) => Date.now() - x.at < 30 * 60_000);
			let i = expected.findIndex((x) => text.includes(x.text));
			// duet's frame is pending and the user typed nothing since: its text may have been changed on the way.
			const exact = i >= 0;
			if (i < 0 && expected.length && !userPromptSince && !ownerTurns.some((t) => !t.turnId)) i = 0;
			if (i >= 0) {
				const x = expected[i]!;
				expected = expected.filter((_, j) => j !== i);
				const askers = [...new Set(x.reqs.map((q) => q.fromId))];
				peerTurn = { turnId: e.turnId, froms: x.froms, askers, answers: x.reqs, preSend: exact && x.preSend && askers.length === 1 ? askers[0]! : "" };
			}
		}
		redraw($);
		return next(e);
	});

	on("turn.complete", async ($, e, next) => {
		if (e.agentId) return next(e);
		if (e.turnId === runningTurn) runningTurn = "";
		// Claude's answer to the owner's own input goes back to the owner only: no gate, it never enters the room.
		const mine = ownerTurns.find((t) => t.turnId === e.turnId);
		if (mine) {
			ctlSend($, CTL.reply, { text: String(e.answer ?? "").slice(0, MAX_TEXT) || (e.isAborted ? "(stopped)" : "(no text)"), re: mine.re });
			ownerTurns = ownerTurns.filter((t) => t !== mine);
		}
		// The turn ended (Esc, an error) while a reply waits at gate 2: its call was abandoned.
		for (const item of outbox) decide($, item, "stopped");
		if (peerTurn?.turnId === e.turnId) peerTurn = null;
		redraw($);
		const result = await next(e);
		void submitWhenIdle($).catch(() => {});
		void flowOwner($).catch(() => {});
		// The pasted prompt's command wrote the join file during this turn.
		if (!joinOffer && interactive) void takeJoinFile($).catch(() => {});
		return result;
	});

	on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
		const card = drawCard($, e);
		if (!card) return next(e);
		const theirs = await next(e); // keep what other mods draw there, under the card
		if (!theirs) return card;
		const { Box } = $.ui.resolve(e);
		return Box({ flexDirection: "column", children: [card, theirs] });
	});
};
