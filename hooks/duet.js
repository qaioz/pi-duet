// duet for Claude Code, as a mod: pair this session with another developer's coding agent (pi,
// Claude Code or Codex) through a shared room on a relay.
//
//   /duet new            make a room and join it        /duet <room> [name] [relay]   join a room
//   /duet                open the duet pane              /duet ask | auto              gates on / off
//   /duet off            leave the room (and forget it in this folder)
//
// Receiving: `$.process.spawn` runs curl against the relay's JSON stream (mods have no streaming
// network API; Node isn't guaranteed). Sending: `$.http.fetch` POST — which also means a session
// whose policy refuses mod network requests never joins (curl is never used to go around it).
//
// Two gates in ask mode. Gate 1: every waiting message waits as one card above the prompt (1 Process,
// 2 Ignore, 3 Process and send). Gate 2: every reply Claude sends with the duet tool waits as a card
// showing the whole reply (1 Send, 2 Don't send); the tool call holds until the press. "Process and
// send" is the user's OK for one reply ahead: the first send of that request's turn to its sender
// goes out without the gate 2 card. It lives in peerTurn only (never in what Claude reads or sets)
// and ends with the turn. Auto mode: no gates, up to MAX_AUTO requests in a row without the user.
// While Claude works on a peer's request it runs under the user's own permission mode, like any
// other turn: duet adds no checks of its own. Gate 2 holds the duet tool only; it is not a fence
// around what leaves the computer.
//
// Which turn is the peer's (for the spinner and which request a reply answers): Claude Code hands
// turn.start the prompt's text wrapped in its own lines ("The duet plugin sent a message: …"), so a
// turn is the peer's when its text contains a frame duet submitted, until that turn's own
// turn.complete. duet submits only while Claude is idle, so its turn is the next one.
//
// Every function that touches `$` is declared at the top level of this file: Claude Code's
// validator refuses `$` passed to an imported function. wire.js is pure.
import {
	DEFAULT_SERVER, LEAVE_WORDS, MAX_AUTO, MAX_BYTES, MAX_TEXT, attachmentUrl, byteLength, envelope, firstLine, fitName, fitHandover, frameForClaude, isEnvelope, isForMe,
	isName, isPlaceholderName, isRelayUrl, isRoomCode, joinQuestion, newRoomCode, randomId, readJoinFile, sanitize, stripHidden, HIDDEN_MARK, sha256hex, timeOf, topicFor,
} from "./wire.js";

const PANE = "duet";
const SEND_TOOL = "mcp__duet__send";
const REPAIR_POLL_MS = 10_000; // the relay writes its cache in batches; re-poll a resumed range once
const MAX_BACKOFF_MS = 30_000;
const HISTORY_MAX = 200; // entries the pane keeps, in memory, for this session
const VIA = { pi: "pi", "claude-code": "Claude Code", codex: "Codex", chat: "chat panel" };
const BAND_CHARS = 100_000; // Claude Code draws a band's text up to this many characters

// ---------- state (module variables; the room and the turn in progress are also kept in $.store) ----------

const moduleId = randomId(); // this module instance; a reload loads a new one (kept in DUET_MODULE)
let installId = "";
let sessionId = "";
let cwd = "";
let home = "";
let duetDir = ""; // ~/.duet (DUET_HOME): where the website's prompt writes the join file
let server = DEFAULT_SERVER;
let defaultName = "";

let room = null; // { code, name, key, fromId, topic, mode, cursor, server }
let generation = 0; // bumped on every join and leave (and /duet off): loops and joins of an older room stop
let joinedAt = 0; // when this window's own join went out: a join just after it is the others' answer
let wakeSupervisor = null;
let child = null; // the running curl stream
let connected = false;
let connError = "";
let joinOffer = null; // { room, name, relay, question }: a join file taken, waiting for 1 Join / 2 Ignore
let interactive = false; // this session can draw (terminal, Desktop): the only kind that takes a join file
let heldCursor = null; // the newest resume point, saved once nothing received is still open
const seen = new Set();
const peers = new Map(); // name -> { via, at, left }

let queue = []; // messages waiting for the user (ask) or for Claude to be free (auto); never capped
let carry = []; // messages taken (a press, or auto) that didn't fit the last hand-over: Claude's next turn
let carryPreSend = false; // the press that took them was "Process and send"
let events = []; // [{ name, what: "joined" | "left", via, ts, seq }] since Claude's last duet turn: items of the next hand-over
let arrival = 0; // arrival order of messages and events, for the hand-over
let pendingPeer = null; // { envs, text, roomKey, submitted, preSend }: taken, waiting for Claude to be idle
let expected = []; // [{ text, froms, roomKey, envs, at, preSend }]: submitted frames whose turn hasn't started yet
let peerTurn = null; // { froms, roomKey, turnId, answers, preSend }: preSend = the sender whose reply is OK'd ahead ("" once used)
let runningTurn = ""; // the main loop's turn in progress, "" while Claude is idle
let userPromptSince = false; // the user's own prompt entered since duet's last submission
let outbox = []; // [{ id, text, to, decision }]: replies waiting at gate 2
let autoTurns = 0;
let paused = false;

let history = []; // { at, who, text, note }: the room as the pane shows it, read-only, this session
let tab = "history"; // the pane's open tab: "history" | "settings"
let paneNote = ""; // one terse line under Settings ("code copied")
const sent = new Map(); // our messages' ids -> first line, to show what a reply answers
let lineChain = Promise.resolve(); // received lines, one at a time in arrival order (stream and repair poll)

const viaLabel = (via) => (Object.hasOwn(VIA, String(via)) ? VIA[via] : "");
const oneLine = (s) => sanitize(s, 200).replace(/\n/g, " "); // a name or list of names on a card, safe to draw
const livePeers = () => [...peers.entries()].filter(([, p]) => !p.left);
const peerList = () => livePeers().map(([n]) => n).join(", ");
const peerNames = () => (peerTurn ? peerTurn.froms.join(", ") : peerList() || "the room");
const autoActive = () => !!room && room.mode === "auto" && !paused;
const busyWithPeer = () => !!(pendingPeer || peerTurn || expected.length);
// exact: the turn's text holds the frame duet submitted. Only then does a "Process and send" carry over.
const peerTurnFrom = (x, turnId, exact) => ({
	froms: x.froms,
	roomKey: x.roomKey,
	turnId,
	answers: (x.envs ?? []).map((m) => ({ from: m.from, id: m.id })),
	preSend: exact && x.preSend && x.froms.length === 1 ? x.froms[0] : "",
});

// ---------- small helpers that use $ ----------

function redraw($) {
	$.ui.invalidate("ui.render");
}

function wait($, ms) {
	return new Promise((resolve) => {
		$.clock.after(ms, resolve);
	});
}

// Simple history: name · time · text. Notes (joins, leaves) are dim lines. This session only.
function remember($, entry) {
	history.push({ at: new Date().toISOString(), who: entry.who ?? "", text: String(entry.text ?? ""), ...(entry.note ? { note: true } : {}) });
	if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
}

async function canDraw($) {
	try {
		const surfaces = await $.session.surfaces();
		return surfaces.some((s) => s === "terminal" || s === "desktop");
	} catch {
		return false;
	}
}

async function publish($, relay, topic, env) {
	const body = JSON.stringify(env);
	const bytes = byteLength(body);
	if (typeof env.text === "string" && env.text.length > MAX_TEXT) throw new Error(`${env.text.length} characters, limit ${MAX_TEXT}: send the key part, or split it`);
	if (bytes > MAX_BYTES) throw new Error(`${Math.round(bytes / 1000)} KB, limit ${MAX_BYTES / 1000} KB: send the key part, or split it`);
	const res = await Promise.race([
		$.http.fetch(`${relay}/${topic}`, { method: "POST", body }),
		new Promise((_, reject) => {
			$.clock.after(15_000, () => reject(new Error("relay timeout (15 s)")));
		}),
	]);
	if (!res.ok) {
		const hint =
			res.status === 429
				? " (rate limit: wait a minute)"
				: bytes > 4000 && (res.status === 400 || res.status === 413)
					? " (relay takes no long messages: split under 3.8 KB)"
					: "";
		throw new Error(`relay HTTP ${res.status}${hint}`);
	}
}

// The resume point to keep: just before the oldest message not yet handled, or the newest seen.
function resumePoint() {
	const open = pendingPeer?.envs?.[0] ?? expected[0]?.envs?.[0] ?? carry[0] ?? queue[0];
	if (open) return open._prev ?? null;
	return heldCursor;
}

async function saveCursor($) {
	if (!room) return;
	const cursor = resumePoint();
	if (!cursor) return;
	if (cursor === heldCursor) heldCursor = null;
	await $.store.set("cursor:" + room.key, cursor);
}

// The turn in progress, kept across a module reload (which resets module variables).
async function saveTurn($) {
	await $.store.set("turn:" + sessionId, { pendingPeer, expected, peerTurn, runningTurn, carry, carryPreSend, events, arrival, at: Date.now() });
}

// ---------- receiving ----------

// Runs for the whole session: idles until a room is joined, then keeps one curl stream open.
async function supervise($) {
	let backoff = 1000;
	for (;;) {
		if (!room) {
			await new Promise((resolve) => {
				wakeSupervisor = resolve;
			});
			wakeSupervisor = null;
			continue;
		}
		const gen = generation;
		const started = Date.now();
		await streamOnce($, room, gen);
		if (gen !== generation) {
			backoff = 1000;
			continue;
		}
		if (Date.now() - started > 60_000) backoff = 1000;
		await wait($, backoff);
		backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
	}
}

async function streamOnce($, r, gen) {
	const floor = r.cursor;
	const q = floor ? `?since=${encodeURIComponent(floor.id || String(floor.time))}` : "";
	let buf = "";
	let repair = null;
	try {
		// The URL holds the topic, which is the room's secret: pass it on stdin, not in argv (ps).
		// Every part is ours: the relay passed isRelayUrl, the topic is hex, the id is URI-encoded.
		const stream = $.process.spawn({
			argv: ["curl", "-sSfN", "--speed-limit", "1", "--speed-time", "90", "-K", "-"],
			input: `url = "${r.server}/${r.topic}/json${q}"\n`,
		});
		child = stream;
		if (floor) repair = $.clock.after(REPAIR_POLL_MS, () => void repairPoll($, r, gen, floor).catch(() => {}));
		for await (const piece of stream) {
			if (gen !== generation) break;
			if (piece.stream === "stderr") {
				connError = sanitize(piece.text, 200).trim();
				redraw($);
				continue;
			}
			buf += piece.text;
			let nl;
			while ((nl = buf.indexOf("\n")) >= 0) {
				await queueLine($, r, gen, buf.slice(0, nl), true, floor);
				buf = buf.slice(nl + 1);
			}
		}
	} catch (err) {
		connError = /ENOENT|not found|cannot start/i.test(String(err?.message)) ? "curl missing (needed to receive)" : String(err?.message ?? err);
	} finally {
		child = null;
		repair?.cancel?.();
		if (connected) {
			connected = false;
			redraw($);
		}
	}
}

async function repairPoll($, r, gen, floor) {
	if (gen !== generation) return;
	try {
		const res = await $.http.fetch(`${r.server}/${r.topic}/json?poll=1&since=${encodeURIComponent(floor.id || String(floor.time))}`);
		for (const line of res.text.split("\n")) await queueLine($, r, gen, line, false, floor);
	} catch {}
}

// One line at a time, in arrival order: a long message's download mustn't let a later line (or a
// repair-poll line) overtake it.
function queueLine($, r, gen, line, live, floor) {
	lineChain = lineChain.then(() => handleLine($, r, gen, line, live, floor)).catch(() => {});
	return lineChain;
}

async function handleLine($, r, gen, line, live, floor) {
	if (gen !== generation || !line.trim()) return;
	let evt;
	try {
		evt = JSON.parse(line);
	} catch {
		return;
	}
	if (evt.event === "open") {
		connected = true;
		connError = "";
		redraw($);
		return;
	}
	if (evt.event !== "message" || typeof evt.id !== "string" || seen.has(evt.id)) return;
	// The relay answers a since= id it doesn't have with its whole cache: skip what's before the resume point.
	if (floor && ((floor.id && evt.id === floor.id) || evt.time < floor.time)) return;
	seen.add(evt.id);
	if (seen.size > 1000) seen.delete(seen.values().next().value);
	const fresh = !(evt.time < Date.now() / 1000 - 12 * 3600); // never act on anything older than 12 h
	let body = fresh ? evt.message : null;
	// A long message's body is an attachment on the relay: fetch it only from this relay's own /file/
	// path, since anyone can post an attachment that points anywhere.
	const a = evt.attachment;
	if (fresh && a && typeof a.url === "string") {
		body = null;
		const url = attachmentUrl(a, r.server, MAX_BYTES + 4096);
		if (url) {
			let why = "";
			try {
				// Never wait on a download for long: a stuck one would stop everything after it.
				const res = await Promise.race([
					$.http.fetch(url),
					new Promise((_, reject) => {
						$.clock.after(20_000, () => reject(new Error("timeout")));
					}),
				]);
				if (res.ok) body = res.text;
				else why = "expired on the relay";
			} catch {
				why = "couldn't be downloaded";
			}
			if (why) {
				remember($, { text: `long message ${why} · lost`, note: true });
				$.ui.toast(`duet: long message ${why} · lost`);
			}
		}
	}
	let env = null;
	try {
		env = body == null ? null : JSON.parse(body);
	} catch {}
	if (gen !== generation) return;
	if (isEnvelope(env)) {
		// Where to resume so this message comes again if it is still open at a restart.
		// A first message has no previous id: resume from just before its second (the relay takes a time).
		env._prev = r.cursor ?? { id: "", time: evt.time - 1 };
		onEnvelope($, r, env);
	}
	if (live) {
		r.cursor = { id: evt.id, time: evt.time };
		heldCursor = r.cursor;
		await saveCursor($);
	}
}

function onEnvelope($, r, env) {
	if (!isForMe(env, r.fromId, r.name)) return;
	const before = peers.get(env.from);
	const isNew = !before || before.left;
	peers.set(env.from, { via: env.via ?? before?.via ?? "", at: Date.now(), left: false });
	if (env.kind === "join") {
		if (isNew) {
			const via = viaLabel(env.via);
			remember($, { text: `${env.from} joined${via ? " · " + via : ""}`, note: true });
			// A join answering ours (sent within seconds of it) isn't a change: those peers are the room
			// line's. Any later join is an item of the next hand-over, and gets one answer so the
			// newcomer learns who is here.
			if (Date.now() - joinedAt > 5000) {
				events.push({ name: env.from, what: "joined", via, ts: env.ts, seq: ++arrival });
				void publish($, r.server, r.topic, envelope({ fromId: r.fromId, from: r.name, kind: "join", via: "claude-code" })).catch(() => {});
			}
		}
		redraw($);
		return;
	}
	if (env.kind === "note") {
		// The only note on the wire: a leave.
		peers.set(env.from, { ...peers.get(env.from), left: true });
		events.push({ name: env.from, what: "left", ts: env.ts, seq: ++arrival });
		remember($, { text: `${env.from} left`, note: true });
		redraw($);
		return;
	}
	// A reply to one of ours: say which one (the card and what Claude reads).
	env.reLine = env.re && sent.has(env.re) ? sent.get(env.re) : undefined; // ours only: a peer can't set it
	remember($, { who: env.from, text: env.text });
	env._seq = ++arrival;
	queue.push(env); // never dropped: what doesn't fit one turn comes in the next
	// The user must act only in ask mode (or auto paused): one toast per message.
	if (!autoActive()) $.ui.toast(`${env.from}: new request`);
	void deliver($).catch(() => {});
	redraw($);
}

// ---------- delivery ----------

async function deliver($) {
	if (!autoActive() || !(queue.length || carry.length) || busyWithPeer()) return;
	if (autoTurns >= MAX_AUTO && queue.length) {
		paused = true;
		pausedForTool = false;
		$.ui.toast(`duet: ${MAX_AUTO} in a row · rest wait for you`);
		redraw($);
		return;
	}
	if (!(await sendToolReady($))) {
		if (!toolOff) return void deliver($).catch(() => {}); // found again while this looked: look again
		// No way to answer: wait (the line above the prompt says why); resumes when the tool is back.
		paused = true;
		pausedForTool = true;
		redraw($);
		return;
	}
	if (!autoActive() || !(queue.length || carry.length) || busyWithPeer()) return;
	// The rest of a split hand-over is the same request continued: it never counts toward MAX_AUTO.
	if (queue.length) autoTurns++;
	await startPeerTurn($, queue.splice(0));
}

// Messages already taken (a press, or auto) that didn't fit the last hand-over: Claude's next turn.
async function flowCarry($) {
	if (!room || !carry.length || busyWithPeer()) return;
	if (autoActive()) return deliver($);
	await startPeerTurn($, carry.splice(0), carryPreSend);
}

// Hand over everything, in order, as much as fits one turn; the rest is carried to the next turn.
async function startPeerTurn($, envs, preSend = false) {
	const { take, rest } = fitHandover([...carry.splice(0), ...envs]); // carried first: they are older
	carry = rest;
	carryPreSend = preSend;
	pendingPeer = { envs: take, roomKey: room?.key ?? "", submitted: false, preSend };
	await saveTurn($);
	redraw($);
	await submitWhenIdle($);
}

// Hand the taken request to Claude once no turn is running, so the turn it starts is the next one.
async function submitWhenIdle($) {
	const p = pendingPeer;
	if (!p || p.submitted || runningTurn) return;
	if (!room || room.key !== p.roomKey) {
		pendingPeer = null; // the room was left while this waited: its request stays with the room (resume point saved)
		await saveTurn($);
		redraw($);
		return;
	}
	p.submitted = true;
	// Everything taken meanwhile goes in this turn too (auto: everything that arrived while Claude
	// worked), in order, as much as fits; the rest is carried to the next turn.
	const pool = fitHandover([...p.envs, ...carry.splice(0), ...(autoActive() ? queue.splice(0) : [])]);
	p.envs = pool.take;
	carry = pool.rest;
	// Built now, not when taken: the room line, and the joins and leaves so far, are as of this hand-over.
	p.text = frameForClaude(p.envs, cwd, SEND_TOOL, { room: livePeers().map(([name, x]) => ({ name, via: viaLabel(x.via) })), me: room?.name, events, more: carry.length });
	p.events = events;
	events = [];
	const froms = [...new Set(p.envs.map((x) => x.from))];
	expected = [...expected, { text: p.text, froms, roomKey: p.roomKey, envs: p.envs, at: Date.now(), preSend: !!p.preSend }];
	userPromptSince = false;
	pendingPeer = null;
	await saveTurn($);
	let result;
	try {
		result = await $.prompt.submit({ text: p.text }); // never `asUser`
	} catch (err) {
		result = { drop: String(err?.message ?? err) };
	}
	if (result?.drop) {
		// Refused (another mod, or a UserPromptSubmit hook): back to waiting, and no auto retry loop.
		expected = expected.filter((x) => x.text !== p.text);
		if (room?.key === p.roomKey) {
			queue.unshift(...p.envs, ...carry.splice(0));
			events = [...(p.events ?? []), ...events];
		}
		paused = room?.mode === "auto" ? true : paused;
		pausedForTool = false;
		await saveTurn($);
		$.ui.toast("duet: Claude Code refused the request: " + sanitize(result.drop, 120));
		redraw($);
	}
}

async function cancelWaiting($) {
	const p = pendingPeer;
	if (!p || p.submitted) return;
	pendingPeer = null;
	if (room?.key === p.roomKey) queue.unshift(...p.envs, ...carry.splice(0));
	await saveTurn($);
	redraw($);
}

// ---------- joining and leaving ----------

// Runs detached from the command or button that asked for it, so its waits count against no hook.
// mode: "ask" or "auto" (a module reload keeps the mode it had); quiet: a rejoin nobody typed.
// copy: /duet new puts the fresh code on the clipboard.
async function join($, code, nameArg, mode, quiet, relayArg, copy) {
	if (!isRoomCode(code)) {
		$.ui.log("room code: 3–64 letters, digits, . _ - · or /duet new");
		return;
	}
	if (isPlaceholderName(nameArg)) {
		$.ui.log(`"${nameArg}" is a placeholder · /duet ${code} <your name>`);
		return;
	}
	if (relayArg && !isRelayUrl(relayArg)) {
		$.ui.log(`bad relay ${sanitize(relayArg, 100)} · http(s) URL only, e.g. https://duet.gaioz.online`);
		return;
	}
	const relay = (relayArg || server).replace(/\/+$/, "");
	const name = fitName(nameArg || defaultName || "anon");
	if (room) {
		if (room.code === code && room.name === name && room.server === relay) return openPane($);
		await leave($, true, false);
	}
	const gen = generation; // a leave or /duet off while this join is on its way: don't join after all
	const key = `${relay} ${code} ${name}`;
	const fromId = (await sha256hex(`${installId} ${key}`)).slice(0, 32);
	const topic = await topicFor(code);

	// No saved place in this room: listen from just before joining, so the others' answers to our
	// join (sent within a second or two) aren't missed while the stream is still opening.
	const saved = await $.store.get("cursor:" + key);
	const cursor = saved ?? { id: "", time: Math.floor(Date.now() / 1000) - 2 };
	const r = { code, name, key, fromId, topic, server: relay, mode: mode === "auto" ? "auto" : "ask", cursor };
	try {
		// The first network request: if the relay can't be reached, or this session's policy refuses
		// network requests from mods, duet doesn't join.
		await publish($, relay, topic, envelope({ fromId, from: name, kind: "join", via: "claude-code" }));
		joinedAt = Date.now();
	} catch (err) {
		$.ui.log(`relay ${relay} unreachable: ${String(err?.message ?? err)} · not joined`);
		$.ui.toast("duet: relay unreachable · not joined");
		return;
	}
	if (gen !== generation || room) return;
	room = r;
	generation++;
	queue = [];
	carry = [];
	events = [];
	outbox = [];
	peers.clear();
	history = [];
	autoTurns = 0;
	paused = false;
	pausedForTool = false;
	heldCursor = null;
	await $.store.set("room:" + cwd, { code, name, relay, at: Date.now() });
	await $.store.set("name", name);
	await $.store.set("active:" + sessionId, { code, name, mode: r.mode, relay });
	defaultName = name;
	wakeSupervisor?.();
	remember($, { text: quiet ? `you rejoined as ${name}` : `you joined as ${name}`, note: true });
	let copied = false;
	if (copy) {
		try {
			copied = !!(await $.ui.copy({ text: code }))?.isCopied;
		} catch {}
	}
	if (!quiet) $.ui.log(`joined ${code} as ${name}${copied ? " · code copied" : ""}`);
	logToolOff($);
	redraw($);
	void deliver($).catch(() => {});
}

// A request already handed to Claude keeps running after a leave; its reply can't be sent once the
// room is gone. forget: /duet off — the folder forgets its room.
async function leave($, tell, forget) {
	if (!room) return;
	const r = room;
	if (tell) void publish($, r.server, r.topic, envelope({ fromId: r.fromId, from: r.name, kind: "note", note: "left" })).catch(() => {});
	await saveCursor($);
	// A request taken but not yet handed to Claude stays with the room (its resume point is saved).
	if (pendingPeer && !pendingPeer.submitted) pendingPeer = null;
	await saveTurn($);
	room = null;
	generation++;
	try {
		child?.return?.();
	} catch {}
	child = null;
	connected = false;
	queue = [];
	heldCursor = null;
	await $.store.delete("active:" + sessionId);
	if (forget) await $.store.delete("room:" + cwd);
	redraw($);
}

async function setMode($, mode) {
	if (!room) {
		$.ui.log("not in a room · /duet new or /duet <code>");
		return;
	}
	room.mode = mode;
	autoTurns = 0;
	paused = false;
	pausedForTool = false;
	const active = await $.store.get("active:" + sessionId);
	if (active) await $.store.set("active:" + sessionId, { ...active, mode });
	$.ui.log(mode === "auto" ? `auto · no gates · max ${MAX_AUTO} in a row` : "ask · both gates on");
	redraw($);
	void deliver($).catch(() => {});
}

// ---------- what the user does with a card ----------

// Gate 1: a press acts at once on every waiting message, from every sender, in arrival order.
// "take" (Process), "take-send" (Process and send), "ignore".
let choosing = false; // a gate-1 press is checking the send tool: a second press waits its turn
async function choose($, action) {
	if (choosing) return;
	const envs = [...queue];
	if (!envs.length || !room) return;
	const r = room;
	const gen = generation; // /duet off bumps it at once: a press whose check was still running then does nothing
	const take = action === "take" || action === "take-send";
	if (take && busyWithPeer()) {
		$.ui.toast("duet: busy with the last request");
		return;
	}
	// No send tool here: Claude would have no way to answer but another tool. Keep the request waiting.
	if (take) {
		choosing = true;
		let ready = false;
		try {
			ready = await sendToolReady($);
		} finally {
			choosing = false;
		}
		if (!ready) {
			// The line above the prompt stays; the toast answers this press.
			$.ui.toast("duet: " + toolOffText());
			return;
		}
		// The check waited: a leave, another press or a turn may have come in meanwhile.
		if (gen !== generation || room !== r || !envs.every((e) => queue.includes(e))) return;
		if (busyWithPeer()) {
			$.ui.toast("duet: busy with the last request");
			return;
		}
	}
	queue = queue.filter((e) => !envs.includes(e));
	if (take) await startPeerTurn($, envs, action === "take-send");
	else {
		// Ignored: nothing goes to the other side, like a person not answering.
		redraw($);
		await saveCursor($);
	}
}

// Gate 2: the press that settles a waiting reply.
function decide($, item, decision) {
	if (!item || item.decision) return;
	item.decision = decision;
	redraw($);
}

// Hold the send tool's call until the user presses Send or Don't send. The hook's time limit stops
// while a mods API call is in flight and runs on through a promise of the mod's own (and through
// $.clock.sleep), so the wait sits inside short blocking processes: `sleep` (macOS, Linux, Git Bash),
// else `ping` to this computer (Windows' own, System32: about a second a round), else PowerShell's
// Start-Sleep. A waiter that can't start is dropped for the rest of this module's life; one that
// fails (a non-zero exit, its time limit) is dropped only after WAITER_FAILS in a row, so one hiccup
// doesn't move the wait to a slower one. Each has a short time limit of its own: `ping -n 2` on
// Linux/macOS never ends by itself. Only with none of them left does the wait fall back to
// $.clock.sleep, which counts against the hook's 10 s; the hook's .catch then refuses the send
// (fails closed).
const WAITERS = [
	{ argv: ["sleep", "0.25"], timeoutMs: 2000 },
	{ argv: ["ping", "-n", "2", "127.0.0.1"], timeoutMs: 3000 },
	{ argv: ["powershell", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 250"], timeoutMs: 5000 },
];
const WAITER_FAILS = 3;
let waiter = 0; // the first of WAITERS not yet given up on here
let waiterFails = 0; // failures in a row of WAITERS[waiter]
async function awaitDecision($, item, signal) {
	const decision = await waitForPress($, item, signal);
	// The hook's budget may have run out (the tool already answered "Not sent: duet error") while a
	// press came in: never send after that.
	return signal?.aborted ? "stopped" : decision;
}
async function waitForPress($, item, signal) {
	while (!item.decision) {
		if (signal?.aborted) return "stopped";
		if (!room) return "left";
		// A module reload (a plugin update) while this reply waits: the new module never draws this
		// card, so settle the call, unsent, instead of holding it until Esc.
		let current = "";
		try {
			current = (await $.env.get("DUET_MODULE")) || "";
		} catch {}
		if (current && current !== moduleId) return "reloaded";
		if (item.decision) break;
		if (waiter < WAITERS.length) {
			let missing = false;
			try {
				const r = await $.process.run(WAITERS[waiter].argv, { timeoutMs: WAITERS[waiter].timeoutMs });
				if (r.exitCode === 0) {
					waiterFails = 0;
					continue;
				}
			} catch (err) {
				missing = /ENOENT|not found|cannot find|no such file/i.test(String(err?.message ?? err));
			}
			if (missing || ++waiterFails >= WAITER_FAILS) {
				waiter++;
				waiterFails = 0;
			}
			continue;
		}
		try {
			await $.clock.sleep(250, signal ? { signal } : undefined);
		} catch {
			return signal?.aborted ? "stopped" : "reloaded";
		}
	}
	return item.decision;
}

async function openPane($) {
	await $.ui.open({ id: PANE, title: "duet", focus: true, closeOnEscape: true });
	redraw($);
}

// Back in the room after a restart, without asking: the folder remembers its room until /duet off.
async function autoRejoin($) {
	if (room || joinOffer || !(await canDraw($))) return;
	const rec = await $.store.get("room:" + cwd);
	if (!rec?.code || room) return; // a join started while this looked
	await join($, rec.code, rec.name, "ask", true, rec.relay);
}

// The website's prompt writes ~/.duet/join.json: the agent runs the prompt's command, and when that
// turn ends the file is looked at, so the card shows with no reload (a fresh install needs
// /reload-plugins, which is a start). Looked at only at a start, a reload and the end of a turn,
// never polled: whichever Claude Code looks next takes it (emptied at once).
// Taking it never joins: it shows the card "Join <room> as <name>? · <folder>" (1 Join, 2 Ignore), so a
// room is joined by the user's own hand even when something else wrote the file. In a room already,
// the card says which room it leaves.
async function takeJoinFile($) {
	const path = `${duetDir}/join.json`;
	let text;
	try {
		if (!(await $.fs.exists(path))) return false;
		text = String(await $.fs.read(path));
	} catch {
		return false;
	}
	const got = readJoinFile(text, "claude-code", Date.now());
	if (!got) return false;
	try {
		await $.fs.write(path, "{}");
	} catch {
		return false;
	}
	if (!got.take) return false;
	joinOffer = { ...got.take, question: joinQuestion({ ...got.take, folder: cwd }, home) };
	logToolOff($);
	redraw($);
	return true;
}

// The join card's press: 1 joins (ask mode), 2 drops it (the file is already gone either way).
function answerJoinOffer($, yes) {
	const o = joinOffer;
	joinOffer = null;
	redraw($);
	if (!o) return;
	if (yes) void join($, o.room, o.name, "ask", false, o.relay).catch(() => {});
	else void autoRejoin($).catch(() => {}); // a start that showed the card first: back to the folder's room
}

// The send tool: registered first thing in session.start (before anything that could throw or wait),
// and checked again before a request is handed to Claude. Seen on a Mac (2026-10-07, issue #33):
// a session where Claude had no mcp__duet__send, and on Process it reached for another duet tool (a
// claude.ai connector) instead. Never silently: a refusal is said.
const SEND_SPEC = {
	name: "send",
	description:
		"Send a message to the other agent(s) in your duet room (another developer's coding agent on their computer). " +
		"Use it to answer a duet request, or when your user asks you to tell the other side something. " +
		"Your text replies are seen only by your own user; this tool is the only way to reach the other side. " +
		"Send one complete reply when you're done, not progress updates or several small messages; split only if it is over ~3.5 KB. " +
		"In ask mode your user sees the whole reply and presses Send or Don't send; if they don't send it, don't send it again.",
	inputSchema: {
		type: "object",
		properties: {
			text: { type: "string", description: "The message. Split longer content into several calls." },
			to: { type: "string", description: "Recipient name, if the room has more than one other person." },
		},
		required: ["text"],
	},
};
let sendToolError = "";
// The send tool missing from Claude's tools, seen on a Mac (issue #33): ~/.claude.json had
// projects["<folder>"].disabledMcpServers = ["duet"] (switched off in /mcp there), so Claude Code
// never connects the server $.tool.register runs. Said on a line above the prompt that stays (while
// in a room or offered one) and once in the transcript; requests wait. Looked at again on every
// Process press and every TOOL_POLL_MS while missing; the line goes once the tool is there.
const TOOL_POLL_MS = 10_000;
const MCP_SERVER = "duet"; // the server name $.tool.register gives this plugin's tools
let toolOff = null; // null while the tool is there (or Claude Code can't say); { switchedOff } while missing
let toolPoll = null;
let toolOffLogged = false;
let toolSeen = 0; // bumped each time the tool is found: an older "missing" answer then doesn't count
let pausedForTool = false; // auto paused only because the tool was missing: resumes when it is back (any other pause or unpause clears it)
const toolOffText = () =>
	toolOff?.switchedOff
		? "duet's send tool is switched off in /mcp for this folder · /mcp → duet → Enable · requests wait until then"
		: "duet's send tool is off in this folder · /mcp → duet → Enable, or /reload-plugins · requests wait until then";
// Said only where it matters: in a room, or with a Join card up.
const toolOffShown = () => !!toolOff && !!(room || joinOffer);

// Is "duet" in this folder's disabledMcpServers in Claude Code's global config (read only, never
// written)? Claude Code keys it by the git checkout's root, else by the folder it started in.
// false whenever it can't be told.
async function mcpSwitchedOff($) {
	try {
		const dir = ((await $.env.get("CLAUDE_CONFIG_DIR")) || home).replace(/\/+$/, "");
		if (!dir) return false;
		const projects = JSON.parse(String(await $.fs.read(`${dir}/.claude.json`)))?.projects;
		if (!projects || typeof projects !== "object") return false;
		let key = cwd;
		try {
			const top = await $.process.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 3000 });
			if (top.exitCode === 0 && top.stdout.trim()) key = top.stdout.trim();
		} catch {}
		const entry = Object.hasOwn(projects, key) ? projects[key] : undefined;
		const list = entry?.disabledMcpServers;
		return Array.isArray(list) && list.includes(MCP_SERVER);
	} catch {
		return false;
	}
}

function logToolOff($) {
	if (!toolOffShown() || toolOffLogged) return;
	toolOffLogged = true;
	$.ui.log(toolOffText());
}

async function noteToolOff($) {
	const seen = toolSeen;
	const switchedOff = await mcpSwitchedOff($);
	if (seen !== toolSeen) return; // found meanwhile (a Process press, the timer)
	const changed = !toolOff || toolOff.switchedOff !== switchedOff;
	toolOff = { switchedOff };
	if (changed) toolOffLogged = false;
	if (!toolPoll) toolPoll = $.clock.every(TOOL_POLL_MS, () => void checkSendTool($).catch(() => {}));
	logToolOff($);
	redraw($);
}

function noteToolOn($) {
	toolSeen++;
	toolPoll?.cancel?.();
	toolPoll = null;
	if (!toolOff) return;
	const said = toolOffLogged;
	toolOff = null;
	toolOffLogged = false;
	if (said) $.ui.log("duet's send tool is on · requests can be processed");
	if (pausedForTool) {
		pausedForTool = false;
		paused = false;
		void deliver($).catch(() => {});
	}
	redraw($);
}

// true / false, or null when Claude Code can't say (no tool list).
async function hasSendTool($) {
	try {
		return (await $.tool.list()).some((t) => t.name === SEND_TOOL);
	} catch {
		return null;
	}
}

// The start's check and the slow timer's: only looks (registering again waits up to 8 s).
async function checkSendTool($) {
	const has = await hasSendTool($);
	if (has === true) noteToolOn($);
	else if (has === false && !toolOff) await noteToolOff($); // still missing: nothing new to read
}

async function registerSendTool($) {
	try {
		await $.tool.register(SEND_SPEC);
		sendToolError = "";
		return true;
	} catch (err) {
		sendToolError = String(err?.message ?? err);
		return false;
	}
}
// Is the send tool among the tools Claude can call now? Registered again if not. true when Claude
// Code can't say (no tool list): the hand-over isn't held up on a guess.
// Switched off in /mcp: registering again changes nothing (and waits up to 8 s), so it is skipped.
async function sendToolReady($) {
	const first = await hasSendTool($);
	if (first === true) noteToolOn($);
	if (first !== false) return true;
	if (!(await mcpSwitchedOff($))) {
		await registerSendTool($);
		if ((await hasSendTool($)) !== false) {
			noteToolOn($);
			return true;
		}
	}
	await noteToolOff($);
	return false;
}

// ---------- the send tool ----------

async function sendTool($, e, signal) {
	if (!room) return { result: "Not sent: not in a duet room" };
	const raw = String(e.text ?? "");
	if (raw.length > MAX_TEXT) return { result: `Not sent: ${raw.length} characters, limit ${MAX_TEXT} · send the key part, or split it` };
	// What goes out is exactly what the gate 2 card shows: no control or invisible characters.
	const text = sanitize(raw, MAX_TEXT).trim();
	if (!stripHidden(raw).text.trim()) return { result: "Not sent: empty" };
	if (text.length > MAX_TEXT) return { result: `Not sent: ${text.length} characters, limit ${MAX_TEXT} · send the key part, or split it` };
	const to = typeof e.to === "string" && e.to.trim() ? e.to.trim() : undefined;
	// `to` comes from the model: only the name of someone in the room (it shows on the card, the
	// spinner and the toast, and a name nobody has would reach no one).
	if (to !== undefined && !isName(to)) return { result: "Not sent: bad name in to" };
	if (to !== undefined && !livePeers().some(([n]) => n === to)) return { result: `Not sent: no ${to} in the room · in it: ${peerList() || "no one yet"}` };
	const fromPeer = !!peerTurn;
	if (fromPeer && peerTurn.roomKey !== room.key) return { result: "Not sent: request from a room you left · tell your user" };
	const r = room;
	// "Process and send": the user OK'd this request's reply ahead. Only the first send of its turn
	// that reaches exactly its sender; used up before any await, so two sends in parallel can't both use it.
	const live = livePeers().map(([n]) => n);
	const reaches = to ?? (live.length === 1 ? live[0] : "");
	const ownTurn = fromPeer && peerTurn.turnId === runningTurn && !e.agentId; // the main loop's turn, not a subagent's
	const preTo = ownTurn && !autoActive() && peerTurn.preSend && reaches === peerTurn.preSend ? peerTurn.preSend : "";
	const preSent = !!preTo;
	if (preSent) {
		peerTurn.preSend = "";
		await saveTurn($); // a module reload must not bring it back
	}
	// What was OK'd is a reply to the sender: it goes to the sender only, even without `to`.
	const sendTo = to ?? (preTo || undefined);
	// Gate 2, in ask mode: the whole reply waits above the prompt for Send / Don't send. Without
	// `to` a reply reaches everyone in the room, so the card names everyone.
	if (!autoActive() && !preSent) {
		const item = { id: randomId(), text, to: to ?? (peerList() || "the room"), decision: "" };
		outbox = [...outbox, item];
		$.ui.toast(`duet: reply to ${oneLine(item.to)} waiting`);
		redraw($);
		let decision;
		try {
			decision = await awaitDecision($, item, signal);
		} finally {
			outbox = outbox.filter((x) => x !== item);
			redraw($);
		}
		if (decision === "drop") return { result: "Not sent: your user said no · don't resend" };
		if (decision === "reloaded") return { result: "Not sent: duet restarted · send it again" };
		if (decision !== "send") return { result: "Not sent" };
		if (room !== r) return { result: "Not sent: left the room" };
	}
	try {
		// Working on a peer's request: say which message this answers (the latest from that sender).
		const asked = fromPeer && peerTurn?.answers ? peerTurn.answers.filter((m) => !sendTo || m.from === sendTo).at(-1) : undefined;
		const env = envelope({ fromId: r.fromId, from: r.name, kind: "msg", text, by: "agent", ...(sendTo ? { to: sendTo } : {}), ...(asked ? { re: asked.id } : {}) });
		await publish($, r.server, r.topic, env);
		sent.set(env.id, firstLine(text));
		if (sent.size > 200) sent.delete(sent.keys().next().value);
	} catch (err) {
		return { result: "Not sent: " + String(err?.message ?? err) };
	}
	// A reply sent on "Process and send" says so, in History and in what Claude reads.
	remember($, { who: preSent ? "you · auto" : "you", text });
	redraw($);
	return { result: `Sent to ${sendTo ?? (peerList() || "the room")}${preSent ? " (auto)" : ""}${text.endsWith(HIDDEN_MARK) ? " · hidden characters removed" : ""}` };
}

// ---------- drawing ----------

const AMBER = "#e9b45a";
const BLUE = "#8eb1ff";

// A long text as Text rows: every line, each under the 10,000-character limit of one Text child.
function textRows(Text, text, keyPrefix) {
	const rows = [];
	sanitize(text, MAX_TEXT).split("\n").forEach((line, i) => {
		for (let at = 0, j = 0; at < Math.max(line.length, 1); at += 5000, j++) rows.push(Text({ key: `${keyPrefix}${i}.${j}`, children: [line.slice(at, at + 5000) || " "] }));
	});
	return rows;
}

// About how many rows a text takes at this width, wrapped.
function rowsFor(text, columns) {
	const w = Math.max(columns - 4, 20);
	return String(text).split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / w)), 0);
}

function drawCard($, e) {
	const { Box, Text, Button } = $.ui.resolve(e);
	const frame = (color, children) => Box({ flexDirection: "column", borderStyle: "round", borderColor: color, paddingX: 1, children });
	const buttons = (list) => Box({ flexDirection: "row", columnGap: 3, flexWrap: "wrap", children: list });
	// A join file taken: the user's own press joins. Under any card of the room this window is in.
	const offerCard = () =>
		joinOffer &&
		frame(BLUE, [
			// Not cut to oneLine's 200: the relay must stay on the card (joinQuestion caps the folder itself).
			Text({ bold: true, children: [`${sanitize(joinOffer.question, 1000).replace(/\n/g, " ")}${room ? ` · leaves ${oneLine(room.code)}` : ""}`] }),
			buttons([
				Button({ key: "join-offer", label: "Join", hotkey: "1", plain: true, onPress: () => answerJoinOffer($, true) }),
				Button({ key: "join-ignore", label: "Ignore", hotkey: "2", plain: true, onPress: () => answerJoinOffer($, false) }),
			]),
		]);
	if (!room) return offerCard() || null;
	// Gate 2 first: Claude's tool call is waiting on it.
	if (outbox.length) {
		const item = outbox[0];
		const more = outbox.length > 1 ? ` · +${outbox.length - 1}` : "";
		const title = Text({ bold: true, children: [`Send to ${oneLine(item.to)}? · full reply${more}`] });
		const keys = buttons([
			Button({ key: "send", label: "Send", hotkey: "1", plain: true, onPress: () => decide($, item, "send") }),
			Button({ key: "dont-send", label: "Don't send", hotkey: "2", plain: true, onPress: () => decide($, item, "drop") }),
		]);
		const body = textRows(Text, item.text, "r");
		// A bare digit presses only Buttons inside the band's window: a reply taller than the band
		// keeps the keys under the title, where the window starts.
		const fits = rowsFor(item.text, e.props?.bodyColumns ?? 80) + 4 <= (e.props?.maxRows ?? 10);
		return frame(BLUE, fits ? [title, ...body, keys] : [title, keys, ...body]);
	}
	if (pendingPeer && !pendingPeer.submitted) {
		const p = pendingPeer;
		return frame(AMBER, [
			Text({ bold: true, children: [`${p.envs[0].from} · starts when Claude is free`] }),
			buttons([Button({ key: "cancel-waiting", label: "Cancel", hotkey: "2", plain: true, onPress: () => void cancelWaiting($).catch(() => {}) })]),
		]);
	}
	if (expected.length && !peerTurn) return frame(AMBER, [Text({ dimColor: true, children: [`${expected[0].froms.join(", ")} · handed to Claude`] })]);
	if (queue.length && autoActive()) return frame(AMBER, [Text({ dimColor: true, children: [`${queue.length} waiting · auto`] })]);
	if (queue.length) {
		// Gate 1.
		const group = queue; // every waiting message, from every sender, in arrival order: one press takes them all
		const env = group[0];
		const froms = [...new Set(group.map((g) => g.from))];
		const via = viaLabel(peers.get(env.from)?.via);
		const reply = (g) => (g.reLine ? [Text({ dimColor: true, children: [`↳ re “${sanitize(g.reLine, 80)}”`] })] : []);
		// Every word Claude would get on "Process": the whole text of each message, every line, wrapped,
		// never cut to the band's width or a line count (a peer could hide an instruction past the cut).
		// With more than one sender, each message says who sent it.
		const label = (g) => (froms.length > 1 ? [Text({ dimColor: true, children: [`${oneLine(g.from)} · ${timeOf(g.ts)}`] })] : []);
		const body = group.flatMap((g, i) => [...(i > 0 ? [Text({ key: `sep${i}`, dimColor: true, children: ["—"] })] : []), ...label(g), ...reply(g), ...textRows(Text, g.text, `q${i}.`)]);
		// Claude Code draws a band up to 100,000 characters: past that the card can't show every word, so it says so.
		const chars = group.reduce((n, g) => n + g.text.length, 0);
		if (chars > BAND_CHARS) body.unshift(Text({ key: "clip", dimColor: true, children: [`${chars.toLocaleString("en-US")} characters: the band shows the first ${BAND_CHARS.toLocaleString("en-US")} · /duet History has every word`] }));
		const head = Box({
			flexDirection: "row",
			justifyContent: "space-between",
			children: [
				Box({ flexDirection: "row", children: [Text({ bold: true, color: AMBER, children: [oneLine(froms.join(", "))] }), Text({ dimColor: true, children: [`${froms.length === 1 && via ? " · " + via : ""} · ${timeOf(env.ts)}${paused ? " · auto paused" : ""}`] })] }),
				...(group.length > 1 ? [Text({ dimColor: true, children: [`${group.length} messages`] })] : []),
			],
		});
		const keys = buttons([
			Button({ key: "take", label: "Process", hotkey: "1", plain: true, onPress: () => void choose($, "take").catch(() => {}) }),
			Button({ key: "ignore", label: "Ignore", hotkey: "2", plain: true, onPress: () => void choose($, "ignore").catch(() => {}) }),
			// 3, not 2: a habit press of 2 (Ignore here, Don't send on the reply card) must never skip gate 2.
			Button({ key: "take-send", label: "Process and send", hotkey: "3", plain: true, onPress: () => void choose($, "take-send").catch(() => {}) }),
		]);
		// As gate 2: a request taller than the band keeps its keys under the title, inside the window.
		const rows = group.reduce((n, g, i) => n + rowsFor(g.text, e.props?.bodyColumns ?? 80) + (g.reLine ? 1 : 0) + (froms.length > 1 ? 1 : 0) + (i > 0 ? 1 : 0), 0);
		const fits = rows + 4 <= (e.props?.maxRows ?? 10);
		return frame(AMBER, fits ? [head, ...body, keys] : [head, keys, ...body]);
	}
	return offerCard() || null;
}

// Two tabs: 1 History (read-only) and 2 Settings (c copy code, a ask/auto, l leave).
function drawPane($, e) {
	const { Box, Text, Button } = $.ui.resolve(e);
	const blank = Text({ children: [" "] });
	if (!room) {
		return Box({
			flexDirection: "column",
			children: [Text({ children: ["Not in a room"] }), Text({ dimColor: true, children: ["/duet new · /duet <code> [name]"] })],
		});
	}
	const tabButton = (name, label, hotkey) =>
		Button({
			key: "tab-" + name,
			label,
			hotkey,
			plain: true,
			dimColor: tab !== name,
			onPress: () => {
				tab = name;
				paneNote = "";
				redraw($);
			},
		});
	const ps = livePeers();
	const head = Box({
		flexDirection: "row",
		justifyContent: "space-between",
		children: [
			Box({ flexDirection: "row", columnGap: 3, children: [tabButton("history", "History", "1"), tabButton("settings", "Settings", "2")] }),
			Text({ dimColor: true, children: [ps.length ? "with " + ps.map(([n]) => n).join(", ") : "no one yet"] }),
		],
	});
	let body;
	if (tab === "settings") {
		const row = (label, value) => Box({ flexDirection: "row", children: [Box({ width: 10, children: [Text({ dimColor: true, children: [label] })] }), value] });
		const relayHost = room.server.replace(/^https?:\/\//, "");
		body = [
			row("Room", Text({ children: [room.code] })),
			row("You", Text({ children: [room.name] })),
			row(
				"Relay",
				connected
					? Box({ flexDirection: "row", children: [Text({ color: "green", children: ["● "] }), Text({ children: [relayHost] })] })
					: Box({ flexDirection: "row", children: [Text({ color: "red", children: ["○ "] }), Text({ children: [`${relayHost} · ${connError ? sanitize(connError, 80) : "offline"}`] })] }),
			),
			row(
				"Gates",
				Box({ flexDirection: "row", columnGap: 1, children: [Text({ bold: room.mode === "ask", dimColor: room.mode !== "ask", children: ["ask"] }), Text({ bold: room.mode === "auto", dimColor: room.mode !== "auto", children: [`auto${paused ? " (paused)" : ""}`] })] }),
			),
			blank,
			Box({
				flexDirection: "row",
				columnGap: 3,
				flexWrap: "wrap",
				children: [
					Button({
						key: "copy",
						label: "Copy code",
						hotkey: "c",
						plain: true,
						onPress: (press) =>
							void (async () => {
								let ok = false;
								try {
									ok = !!(await $.ui.copy({ text: room?.code ?? "", surface: press?.surface }))?.isCopied;
								} catch {}
								paneNote = ok ? "code copied" : "copy failed";
								redraw($);
							})(),
					}),
					Button({ key: "mode", label: "Ask / auto", hotkey: "a", plain: true, onPress: () => void setMode($, room?.mode === "auto" ? "ask" : "auto").catch(() => {}) }),
					Button({
						key: "leave",
						label: "Leave",
						hotkey: "l",
						plain: true,
						onPress: () => {
							generation++;
							void leave($, true, true).catch(() => {});
						},
					}),
				],
			}),
			...(paneNote ? [Text({ dimColor: true, children: [paneNote] })] : []),
		];
	} else {
		body = history.length
			? history.map((h, i) =>
					h.note
						? Text({ key: "h" + i, dimColor: true, children: [`${timeOf(h.at)}  ${sanitize(h.text, 300)}`] })
						: Box({
								key: "h" + i,
								flexDirection: "column",
								children: [Box({ flexDirection: "row", children: [Text({ bold: true, color: h.who === "you" ? BLUE : AMBER, children: [h.who] }), Text({ dimColor: true, children: [" " + timeOf(h.at)] })] }), ...textRows(Text, h.text, `h${i}.`)],
							}),
				)
			: [Text({ dimColor: true, children: ["Nothing yet"] })];
	}
	return Box({ flexDirection: "column", children: [head, blank, ...body, blank, Text({ dimColor: true, children: [tab === "settings" ? "Esc" : "/duet off · Esc"] })] });
}

function modeLabel() {
	if (!room) return "";
	const ps = peerList() || "no one yet";
	// Both gates: requests (gate 1) and replies (gate 2) waiting for the user.
	const n = queue.length + carry.length + outbox.length;
	const waiting = n ? ` · ${n} waiting` : "";
	return `duet · ${ps} · ${room.mode}${paused ? " · paused" : ""}${waiting}${connected ? "" : " · offline"}`;
}

// No turn of this process or conversation is running: forget what a crashed or other one left.
async function clearTurn($) {
	if (!sessionId) sessionId = await $.session.id();
	pendingPeer = null;
	expected = [];
	peerTurn = null;
	runningTurn = "";
	await saveTurn($);
	redraw($);
}

// ---------- hooks ----------

// Resolved once session.start has its settings; /duet (registered before them) waits for it.
let markReady = () => {};
let ready = Promise.resolve();

export function register(on) {
	on("session.start", async ($, e, next) => {
		// First: a /duet typed (or given on the command line) as Claude Code starts must find the
		// command. Registered after the work below, it lost that race on a Mac (seen 2026-10-04).
		try {
			await $.command.register({ name: "duet", description: "Pair with another developer's agent: /duet new, /duet <room>, /duet off", argumentHint: "[new | <room> [name] [relay] | off | ask | auto | status]", immediate: true });
		} catch {}
		ready = new Promise((r) => (markReady = r));
		if (!(await registerSendTool($))) $.ui.log(`duet: the send tool didn't register (${sanitize(sendToolError, 120)}) · /reload-plugins`);
		cwd = e.cwd || (await $.session.cwd());
		home = (await $.env.get("HOME")) || (await $.env.get("USERPROFILE")) || "";
		duetDir = ((await $.env.get("DUET_HOME")) || `${home.replace(/\/+$/, "")}/.duet`).replace(/\\/g, "/");
		// The registration has waited (Claude Code holds it up to 8 s): is the tool among Claude's?
		void checkSendTool($).catch(() => {});
		const relay = (await $.env.get("DUET_SERVER")) || "";
		// The website's line starts Claude Code with the room in DUET_ROOM / DUET_NAME. Read once, then
		// cleared: nothing Claude Code starts (a shell, pi, an MCP server) inherits them, and a /clear
		// doesn't join again.
		const envRoom = (await $.env.get("DUET_ROOM")) || "";
		const envName = (await $.env.get("DUET_NAME")) || "";
		if (envRoom) await $.env.set("DUET_ROOM", "");
		if (envName) await $.env.set("DUET_NAME", "");
		if (relay && isRelayUrl(relay)) server = relay.replace(/\/+$/, "");
		installId = (await $.store.get("install")) || "";
		if (!installId) {
			installId = randomId();
			await $.store.set("install", installId);
		}
		sessionId = await $.session.id();

		defaultName = (await $.store.get("name")) || "";
		if (!defaultName) {
			try {
				const git = await $.process.run(["git", "config", "user.name"], { timeoutMs: 3000 });
				if (git.exitCode === 0 && git.stdout.trim()) defaultName = fitName(git.stdout.trim().split(/\s+/)[0].toLowerCase());
			} catch {}
		}
		// After a module reload in this same process, the request in progress is still the peer's: its
		// turn, a frame Claude Code has queued. A variable in Claude Code's own environment tells a
		// reload (it's set) from a new process (it isn't), whatever order the events come in.
		const sameProcess = !!(await $.env.get("DUET_PROCESS"));
		if (!sameProcess) await $.env.set("DUET_PROCESS", randomId());
		// The module now running here: a reply an older module still holds at gate 2 settles, unsent.
		try {
			await $.env.set("DUET_MODULE", moduleId);
		} catch {}
		const turn = sameProcess ? await $.store.get("turn:" + sessionId) : null;
		if (!sameProcess) await $.store.delete("turn:" + sessionId);
		if (turn && Date.now() - (turn.at ?? 0) < 6 * 3600_000) {
			pendingPeer = turn.pendingPeer ?? null;
			expected = Array.isArray(turn.expected) ? turn.expected : [];
			peerTurn = turn.peerTurn ?? null;
			runningTurn = turn.runningTurn ?? "";
			carry = Array.isArray(turn.carry) ? turn.carry : [];
			carryPreSend = !!turn.carryPreSend;
			events = Array.isArray(turn.events) ? turn.events : [];
			arrival = Math.max(Number(turn.arrival) || 0, ...carry.map((e) => e._seq ?? 0), ...events.map((e) => e.seq ?? 0));
		}
		void supervise($).catch(() => {});
		interactive = !!e.isInteractive || (await canDraw($));
		if (interactive) {
			// After a module reload this window was in a room: take it up again, silently. A join file
			// pasted since shows its card over it (never a switch by itself).
			const active = sameProcess ? await $.store.get("active:" + sessionId) : null;
			if (active?.code) {
				void join($, active.code, active.name, active.mode, true, active.relay)
					.then(() => takeJoinFile($))
					.catch(() => {});
			} else if (envRoom) {
				// Started as DUET_ROOM=<room> DUET_NAME=<name> claude (the website's line).
				void join($, envRoom, envName || undefined, "ask", false).catch(() => {});
			} else if (!(await takeJoinFile($).catch(() => false))) {
				void autoRejoin($).catch(() => {});
			}
		}
		markReady();
		return next(e);
	});

	// The Desktop app may attach after the session started: rejoin then.
	on("session.attach", async ($, e, next) => {
		const result = await next(e);
		void autoRejoin($).catch(() => {});
		return result;
	});

	on("classic.SessionStart", { source: ["clear", "resume", "fork"] }, async ($, e, next) => {
		// /clear and friends may give the session a new id; the room stays with this window.
		const old = sessionId;
		sessionId = await $.session.id();
		// /resume and /branch (a fork) continue another conversation: no turn of this one runs there.
		if (e.source === "resume" || e.source === "fork") {
			await clearTurn($);
			if (old && old !== sessionId) await $.store.delete("turn:" + old);
		}
		if (room && old !== sessionId) {
			await $.store.delete("active:" + old);
			await $.store.set("active:" + sessionId, { code: room.code, name: room.name, mode: room.mode, relay: room.server });
		}
		return next(e);
	});

	on("session.end", async ($, e, next) => {
		// /clear, /resume and /branch end the conversation, not the window: stay in the room.
		if (room && e.reason !== "clear" && e.reason !== "resume") {
			const r = room;
			room = null;
			generation++;
			try {
				child?.return?.();
			} catch {}
			// All session.end hooks share 1.5 s: best effort, and nothing on a crash. The folder keeps
			// its room ("room:<cwd>"), so the next session here rejoins quietly.
			void publish($, r.server, r.topic, envelope({ fromId: r.fromId, from: r.name, kind: "note", note: "left" })).catch(() => {});
			void $.store.delete("active:" + sessionId).catch(() => {});
		}
		if (e.reason !== "clear" && e.reason !== "resume") void $.store.delete("turn:" + sessionId).catch(() => {});
		return next(e);
	});

	on("command.run", { command: "duet" }, async ($, e) => {
		// Typed while the session is still starting: wait for its settings (folder, name, relay).
		await Promise.race([ready, wait($, 8_000)]);
		if (!(await canDraw($))) {
			$.ui.log("duet: Claude Code terminal or Desktop Code tab only");
			return {};
		}
		const [first = "", second, third] = String(e.args ?? "").trim().split(/\s+/);
		const arg = first.toLowerCase();
		// Turning the gates off, or joining a room, only from the user's own hand: Enter at the prompt
		// (composer), Remote Control (bridge) or the SDK host's own turn (the Desktop app). Never from
		// a plugin's $.command.run, a skill the model reaches, or anything unstamped.
		const byUser = ["composer", "bridge", "sdk"].includes(e.origin?.kind);
		if (!byUser && (arg === "auto" || arg === "new" || (isRoomCode(first) && !["ask", "status", ...LEAVE_WORDS].includes(arg)))) {
			$.ui.log(`/duet ${sanitize(arg, 64)}: type it yourself`);
			return {};
		}
		// A typed /duet outranks a join card still up.
		const joinsOrLeaves = arg === "new" || LEAVE_WORDS.includes(arg) || (isRoomCode(first) && !["ask", "auto", "status"].includes(arg));
		if (joinOffer && joinsOrLeaves) {
			joinOffer = null;
			redraw($);
		}
		// Joining waits on the relay: run it detached, so the command returns at once and no hook time
		// limit applies.
		if (!first) void openPane($).catch(() => {});
		else if (arg === "new") void join($, newRoomCode(), second, "ask", false, undefined, true).catch(() => {});
		else if (LEAVE_WORDS.includes(arg)) {
			generation++; // a join still on its way gives up
			if (room) void leave($, true, true).catch(() => {});
			else {
				await $.store.delete("room:" + cwd);
				$.ui.log("not in a room");
			}
		} else if (arg === "ask" || arg === "auto") void setMode($, arg).catch(() => {});
		else if (arg === "status") $.ui.log(room ? `${modeLabel()} · ${room.code} · you are ${room.name}` : "not in a room");
		else if (isRoomCode(first)) void join($, first, second, "ask", false, third).catch(() => {});
		else $.ui.log("usage: /duet new · /duet <code> [name] [relay] · /duet off · /duet ask|auto · /duet");
		return {};
	});

	on("tool.describe", { tool: SEND_TOOL }, async ($, e) => ({ description: e.description, isDeferred: false }));

	on("tool.call", { tool: SEND_TOOL }, async ($, e, next) => sendTool($, e, next.signal)).catch(async () => ({ result: "Not sent: duet error · ask your user before resending" }));

	on("prompt.submit", async ($, e, next) => {
		// Claude Code's own stamp: Enter at the prompt, or Remote Control.
		const kind = e.origin?.kind;
		const mine = kind === "composer" || kind === "bridge";
		const result = await next(e);
		if (!result?.drop && mine) {
			userPromptSince = true;
			autoTurns = 0;
			if (paused) {
				paused = false;
				pausedForTool = false;
				redraw($);
				void deliver($).catch(() => {});
			}
		}
		return result;
	});

	on("turn.start", async ($, e, next) => {
		if (e.agentId) return next(e); // a subagent's turn: not the main loop's
		runningTurn = e.turnId;
		expected = expected.filter((x) => Date.now() - x.at < 30 * 60_000);
		const i = expected.findIndex((x) => String(e.text ?? "").includes(x.text));
		if (i >= 0) {
			const x = expected[i];
			expected = expected.filter((_, j) => j !== i);
			peerTurn = peerTurnFrom(x, e.turnId, true);
		} else if (expected.length && !userPromptSince) {
			// duet's request is pending and no prompt of the user's came since: its text may have been
			// changed on the way. Count it as the peer's, so the reply link still works.
			const x = expected.shift();
			peerTurn = peerTurnFrom(x, e.turnId, false);
		}
		await saveTurn($);
		await saveCursor($);
		redraw($);
		return next(e);
	});

	on("turn.complete", async ($, e, next) => {
		if (e.agentId) return next(e);
		if (e.turnId === runningTurn) runningTurn = "";
		// The turn ended (Esc, an error) while a reply it sent still waits at gate 2: its call was
		// abandoned, so settle it, unsent. (next.signal normally does this first.)
		for (const item of outbox) decide($, item, "stopped");
		if (peerTurn && peerTurn.turnId === e.turnId) {
			peerTurn = null;
			redraw($);
		}
		await saveTurn($);
		const result = await next(e);
		void submitWhenIdle($).catch(() => {});
		void flowCarry($).catch(() => {});
		void deliver($).catch(() => {});
		// The website's prompt, pasted into this session: its command wrote the join file during this turn.
		if (!joinOffer && interactive) void takeJoinFile($).catch(() => {});
		return result;
	});

	on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
		// The send tool is missing: one line that stays above any card until the tool is back.
		let notice = null;
		let ev = e;
		if (toolOffShown()) {
			const { Text } = $.ui.resolve(e);
			const text = toolOffText();
			notice = Text({ key: "tool-off", bold: true, color: "red", children: [text] });
			ev = { ...e, props: { ...e.props, maxRows: Math.max((e.props?.maxRows ?? 10) - rowsFor(text, e.props?.bodyColumns ?? 80), 4) } };
		}
		const drawn = drawCard($, ev);
		let card = drawn;
		if (notice) {
			const { Box } = $.ui.resolve(e);
			card = Box({ flexDirection: "column", children: drawn ? [notice, drawn] : [notice] });
		}
		if (!card) return next(e);
		// Keep what other mods draw in the band, under the card.
		const theirs = await next(e);
		if (!theirs) return card;
		const { Box } = $.ui.resolve(e);
		return Box({ flexDirection: "column", children: [card, theirs] });
	});

	on("ui.render", { component: "Pane" }, async ($, e, next) => {
		if (e.requestId !== PANE) return next(e);
		return drawPane($, e);
	});

	on("ui.render", { component: "SessionMode" }, async ($, e, next) => {
		const label = modeLabel();
		if (!label) return next(e);
		return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } });
	});

	on("ui.render", { component: "Spinner" }, async ($, e, next) => {
		if (!peerTurn && !outbox.length) return next(e);
		const suffix = outbox.length ? ` · reply to ${oneLine(outbox[0].to)} waiting` : ` · for ${peerNames()}`;
		return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix ?? ""}${suffix}` } });
	});
}
