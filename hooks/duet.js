// duet for Claude Code, as a mod: pair this session with another developer's coding agent (pi,
// Claude Code or Codex) through a shared room on an ntfy relay.
//
//   /duet new            make a room and join it        /duet <room> [name] [relay]   join a room
//   /duet                open the duet pane              /duet ask | auto              gates on / off
//   /duet off            leave the room (and forget it in this folder)
//
// Receiving: `$.process.spawn` runs curl against the relay's JSON stream (mods have no streaming
// network API; Node isn't guaranteed). Sending: `$.http.fetch` POST — which also means a session
// whose policy refuses mod network requests never joins (curl is never used to go around it).
//
// Two gates in ask mode. Gate 1: each request waits as a card above the prompt (1 Process,
// 2 Ignore, 3 Process and send). Gate 2: every reply Claude sends with the duet tool waits as a card
// showing the whole reply (1 Send, 2 Don't send); the tool call holds until the press. "Process and
// send" is the user's OK for one reply ahead: the first send of that request's turn to its sender
// goes out without the gate 2 card. It lives in peerTurn only (never in what Claude reads or sets)
// and ends with the turn; a second send, a send to anyone else, or any other turn still waits. Auto mode: no gates, up to MAX_AUTO
// requests in a row without the user. While Claude works on a peer's request it runs under the
// user's own permission mode, like any other turn: duet adds no checks of its own. So gate 2 holds
// the duet tool only; it is not a fence around what leaves the computer: where commands run unasked,
// a peer can ask Claude to post to the room's relay topic (or anywhere) with curl.
//
// Which turn is the peer's (for the spinner, the notes the peer gets, and which request a reply
// answers): Claude Code hands turn.start the prompt's text wrapped in its own lines ("The duet plugin
// sent a message: …"), so a turn is the peer's when its text contains a frame duet submitted, until
// that turn's own turn.complete. duet submits only while Claude is idle, so its turn is the next one.
//
// Every function that touches `$` is declared at the top level of this file: Claude Code's
// validator refuses `$` passed to an imported function. wire.js is pure.
import {
	DEFAULT_SERVER, LEAVE_WORDS, MAX_AUTO, MAX_BYTES, MAX_TEXT, attachmentUrl, byteLength, envelope, firstLine, fitName, frameForClaude, isEnvelope, isForMe, placeFor,
	isName, isPlaceholderName, isRelayUrl, isRoomCode, newRoomCode, randomId, readJoinFile, sanitize, stripHidden, HIDDEN_MARK, sha256hex, timeOf, topicFor,
} from "./wire.js";

const PANE = "duet";
const SEND_TOOL = "mcp__duet__send";
const REPAIR_POLL_MS = 10_000; // ntfy.sh writes its cache in batches; re-poll a resumed range once
const MAX_BACKOFF_MS = 30_000;
const LOCK_STALE_MS = 60_000;
const JOIN_POLL_MS = 2500; // the join file, looked for while not in a room
const HISTORY_MAX = 200; // per room, kept in $.store across restarts
const HISTORY_TEXT_MAX = 1500; // characters of one history entry saved to $.store (memory keeps it whole)
const HISTORY_BYTES_MAX = 512 * 1024; // one room's saved history, as JSON in UTF-8: 5 rooms stay well under $.store's 4 MiB
const HISTORY_ROOMS = 5; // rooms whose history is kept; older ones are dropped
const QUEUE_MAX = 50;
const BATCH_MAX = 5; // messages handed to Claude in one turn
const VIA = { pi: "pi", "claude-code": "Claude Code", codex: "Codex", chat: "chat panel" };
const TOAST_GAP_MS = 15_000; // one "new request" toast per sender per burst
// Permission modes in which a tool call still asks the user unless a rule allows it. Only used for
// the one confirm when the user turns auto on in a session that runs commands unasked.
const ASKING_MODES = ["default", "acceptEdits", "plan", "dontAsk"];

// ---------- state (module variables; the room and the turn in progress are also kept in $.store) ----------

const moduleId = randomId(); // this module instance; a reload loads a new one (kept in DUET_MODULE)
let token = randomId(); // this window; adopted from $.store after a module reload
let installId = "";
let sessionId = "";
let cwd = "";
let home = "";
let duetDir = ""; // ~/.duet (DUET_HOME): the lock every duet client on this computer shares
let server = DEFAULT_SERVER;
let defaultName = "";
let permissionMode = ""; // "" until Claude Code reports it (classic.* events)

let room = null; // { code, name, key, fromId, topic, lockKey, fileLock, mode, cursor, server, riskOk }
let generation = 0; // bumped on every join and leave; loops of an older room stop
let joinEpoch = 0; // bumped by /duet off: a join still in flight then gives up
let joinedAt = 0; // when this window's own join went out: a join just after it is the others' answer
let wakeSupervisor = null;
let child = null; // the running curl stream
let connected = false;
let connError = "";
let heartbeat = null;
let joinPoll = null; // the join file's timer, while not in a room (interactive sessions only)
let watchJoin = false; // this session looks for the join file (it can draw): again after a leave
let heldCursor = null; // the newest resume point, saved once nothing received is still open
const seen = new Set();
const peers = new Map(); // name -> { via, at, left }

let queue = []; // messages waiting for the user (ask) or for Claude to be free (auto)
const lastToast = new Map(); // sender -> time of the last "new request" toast
let pendingPeer = null; // { envs, text, roomKey, submitted, preSend }: taken, waiting for Claude to be idle
let expected = []; // [{ text, froms, roomKey, envs, at, preSend }]: submitted frames whose turn hasn't started yet
let peerTurn = null; // { froms, roomKey, turnId, waitNoted, answers, preSend }: preSend = the sender whose reply is OK'd ahead ("" once used)
let runningTurn = ""; // the main loop's turn in progress, "" while Claude is idle
let userPromptSince = false; // the user's own prompt entered since duet's last submission
let outbox = []; // [{ id, text, to, decision }]: replies waiting at gate 2
let autoTurns = 0;
let paused = false;

let history = []; // { at, who, text, note }: the room as the pane shows it, read-only
let historySave = null; // a pending $.store write of the history
let tab = "history"; // the pane's open tab: "history" | "settings"
let paneNote = ""; // one terse line under Settings ("code copied")
const sent = new Map(); // our messages' ids -> first line, to show what a reply answers
let host = ""; // this computer's name, for the folder hash a join carries (see wire.js placeFor)
let lineChain = Promise.resolve(); // received lines, one at a time in arrival order (stream and repair poll)
const warnedAbout = new Set(); // warnings already given: "crowd", "place:<name>"

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
	waitNoted: false,
	answers: (x.envs ?? []).map((m) => ({ from: m.from, id: m.id })),
	preSend: exact && x.preSend && x.froms.length === 1 ? x.froms[0] : "",
	agents: [], // subagents started during this turn: their sends count as the turn's
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

// Simple history: name · time · text. Notes (joins, leaves) are dim lines. Saved per room.
// The pane keeps the whole text in memory (it is where the user reads a request in full); only the
// copy saved to $.store is cut, to HISTORY_TEXT_MAX characters an entry.
function remember($, entry) {
	const text = String(entry.text ?? "");
	history.push({ at: new Date().toISOString(), who: entry.who ?? "", text, ...(entry.note ? { note: true } : {}) });
	if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
	if (!room || historySave) return;
	const key = "history:" + room.key;
	// One write per burst.
	historySave = $.clock.after(200, () => {
		historySave = null;
		void $.store.set(key, fitHistory(history)).catch(() => {});
	});
}

// The newest entries whose JSON fits HISTORY_BYTES_MAX (non-ASCII text, escapes: a character can be
// several bytes), so a full $.store never blocks the writes of the cursor, the room and the lock.
function fitHistory(full) {
	const list = full.map((h) => (typeof h.text === "string" && h.text.length > HISTORY_TEXT_MAX ? { ...h, text: h.text.slice(0, HISTORY_TEXT_MAX) + "…" } : h));
	let total = 2;
	let i = list.length;
	while (i > 0) {
		const size = byteLength(JSON.stringify(list[i - 1])) + 1;
		if (total + size > HISTORY_BYTES_MAX) break;
		total += size;
		i--;
	}
	return i ? list.slice(i) : list;
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

function sendNote($, note, to) {
	if (!room) return;
	const env = envelope({ fromId: room.fromId, from: room.name, kind: "note", note, ...(to ? { to } : {}) });
	void publish($, room.server, room.topic, env).catch(() => {});
}

// The resume point to keep: just before the oldest message not yet handled, or the newest seen.
function resumePoint() {
	const open = pendingPeer?.envs?.[0] ?? expected[0]?.envs?.[0] ?? queue[0];
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
	await $.store.set("turn:" + sessionId, { pendingPeer, expected, peerTurn, runningTurn, at: Date.now() });
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
	// ntfy answers a since= id it doesn't have with its whole cache: skip what's before the resume point.
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
		// Where to resume so this message comes again if it is still open at a restart or a move.
		// A first message has no previous id: resume from just before its second (ntfy takes a time).
		env._prev = r.cursor ?? { id: "", time: evt.time - 1 };
		onEnvelope($, r, env);
	}
	if (live) {
		r.cursor = { id: evt.id, time: evt.time };
		heldCursor = r.cursor;
		await saveCursor($);
	}
}

// Our own name from another client (another computer: the local lock can't see it). Warn, once per
// client; only for what it sent since this window joined (not a replay from before), and not from
// this very folder (a window taking over).
function sameName($, r, env) {
	if (env.fromId === r.fromId || (env.kind !== "join" && env.kind !== "msg") || warnedAbout.has("same:" + env.fromId)) return;
	if (String(env.from).normalize("NFC").toLowerCase() !== r.name.normalize("NFC").toLowerCase()) return;
	if ((env.place && env.place === r.place) || !(Date.parse(env.ts) >= joinedAt - 5000)) return;
	warnedAbout.add("same:" + env.fromId);
	const via = viaLabel(env.via);
	const text = `another ${oneLine(r.name)} is in this room${via ? ` (${via})` : ""} · use another name`;
	remember($, { text, note: true });
	$.ui.toast("duet: " + text, { timeoutMs: 10_000 }); // needs the user: long enough to be seen
}

function onEnvelope($, r, env) {
	sameName($, r, env);
	if (!isForMe(env, r.fromId, r.name)) return;
	const before = peers.get(env.from);
	const isNew = !before || before.left;
	peers.set(env.from, { via: env.via ?? before?.via ?? "", at: Date.now(), left: false });
	// Quiet: warnings, joins, leaves and notes go to the history only.
	if (livePeers().length > 1 && !warnedAbout.has("crowd")) {
		warnedAbout.add("crowd");
		remember($, { text: `more than two in the room (${peerList()}): a reply without "to" reaches everyone`, note: true });
	}
	if (env.kind === "join") {
		if (env.place && env.place === r.place && !warnedAbout.has("place:" + env.from)) {
			warnedAbout.add("place:" + env.from);
			remember($, { text: `${env.from} is in this same folder (another window)`, note: true });
		}
		if (isNew) {
			const via = viaLabel(env.via);
			remember($, { text: `${env.from} joined${via ? " · " + via : ""}`, note: true });
			// Answer once, so a newcomer learns who is here; not a join that answers ours (sent twice otherwise).
			if (Date.now() - joinedAt > 5000) void publish($, r.server, r.topic, envelope({ fromId: r.fromId, from: r.name, kind: "join", via: "claude-code", place: r.place })).catch(() => {});
		}
		redraw($);
		return;
	}
	if (env.kind === "note") {
		const text = {
			declined: `${env.from} ignored your message`,
			stopped: `${env.from} stopped your request`,
			failed: `${env.from}'s agent failed on your request`,
			"approval-wait": `${env.from} is approving a step`,
			left: `${env.from} left`,
			moved: `${env.from} moved to another window`,
		}[env.note];
		if (env.note === "left") peers.set(env.from, { ...peers.get(env.from), left: true });
		remember($, { text, note: true });
		redraw($);
		return;
	}
	// A reply to one of ours: say which one (the card and what Claude reads).
	env.reLine = env.re && sent.has(env.re) ? sent.get(env.re) : undefined; // ours only: a peer can't set it
	remember($, { who: env.from, text: env.text });
	if (queue.length >= QUEUE_MAX) {
		queue.shift();
		$.ui.toast(`duet: over ${QUEUE_MAX} waiting · oldest dropped`);
	}
	queue.push(env);
	// The user must act only in ask mode (or auto paused): then one toast per sender per burst.
	const now = Date.now();
	if (!autoActive() && now - (lastToast.get(env.from) ?? 0) > TOAST_GAP_MS) $.ui.toast(`${env.from}: new request`);
	lastToast.set(env.from, now);
	void deliver($).catch(() => {});
	redraw($);
}

// ---------- delivery ----------

async function deliver($) {
	if (!autoActive() || !queue.length || busyWithPeer()) return;
	if (autoTurns >= MAX_AUTO) {
		paused = true;
		$.ui.toast(`duet: ${MAX_AUTO} in a row · rest wait for you`);
		redraw($);
		return;
	}
	autoTurns++;
	await startPeerTurn($, queue.splice(0, BATCH_MAX));
}

// Would a shell command nobody named run without the user being asked, right now? Claude Code's own
// decision for a made-up command answers it ("allow": bypassPermissions or a rule like Bash(*)); its
// "auto" mode counts as unasked (a classifier approves, not the user). Only asked when the user turns
// auto on, for the one confirm.
async function runsUnasked($) {
	if (permissionMode === "auto") return true;
	try {
		const r = await $.tool.check({ tool: "Bash", input: { command: "duet-permission-check" } });
		return r?.decision === "allow";
	} catch {
		return !ASKING_MODES.includes(permissionMode);
	}
}

async function startPeerTurn($, envs, preSend = false) {
	pendingPeer = { envs, text: frameForClaude(envs, cwd, SEND_TOOL), roomKey: room?.key ?? "", submitted: false, preSend };
	await saveTurn($);
	redraw($);
	await submitWhenIdle($);
}

// Hand the taken request to Claude once no turn is running, so the turn it starts is the next one.
async function submitWhenIdle($) {
	const p = pendingPeer;
	if (!p || p.submitted || runningTurn) return;
	p.submitted = true;
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
		if (room?.key === p.roomKey) queue.unshift(...p.envs);
		paused = room?.mode === "auto" ? true : paused;
		await saveTurn($);
		$.ui.toast("duet: Claude Code refused the request: " + sanitize(result.drop, 120));
		redraw($);
	}
}

async function cancelWaiting($) {
	const p = pendingPeer;
	if (!p || p.submitted) return;
	pendingPeer = null;
	if (room?.key === p.roomKey) queue.unshift(...p.envs);
	await saveTurn($);
	redraw($);
}

// ---------- joining and leaving ----------

async function claim($, lockKey) {
	const cur = await $.store.get(lockKey);
	if (cur && cur.token !== token && !cur.released && Date.now() - cur.at < LOCK_STALE_MS) return cur;
	await $.store.set(lockKey, { token, cwd, at: Date.now(), released: false });
	// $.store has no compare-and-swap: write, wait, read back, and keep it only if it is still ours.
	await wait($, 300);
	const back = await $.store.get(lockKey);
	return back?.token === token ? null : back;
}

// ---------- the lock every duet client shares ----------
// One window per room and name on this computer, whatever the client: pi, Codex (the MCP server) or
// this plugin. Claude Code windows also agree among themselves through $.store (claim, above), which
// can ask "Move it here?"; the file below keeps the other clients out. Same format as lock.js:
// ~/.duet/<hash>.lock holding { v: 2, client, token, pid, cwd, at }, rewritten every 20 s, held while
// `at` is under a minute old.

async function readFileLock($, path) {
	let text;
	try {
		text = String(await $.fs.read(path)).trim();
	} catch {
		return null;
	}
	try {
		const l = JSON.parse(text);
		return l && typeof l === "object" ? l : null;
	} catch {
		return null;
	}
}

// true / false, or undefined where it can't be told (no `kill`, as on Windows).
async function pidAlive($, pid) {
	try {
		return (await $.process.run(["kill", "-0", String(pid)], { timeoutMs: 3000 })).exitCode === 0;
	} catch {
		return undefined;
	}
}

async function fileLockHeld($, l) {
	if (!l || l.released) return false;
	if (l.pid && (await pidAlive($, l.pid)) === false) return false;
	return Date.now() - (Number(l.at) || 0) < LOCK_STALE_MS;
}

async function writeFileLock($, path, released) {
	try {
		await $.fs.write(path, JSON.stringify({ v: 2, client: "claude-code", token, cwd, at: released ? 0 : Date.now(), ...(released ? { released: true } : {}) }) + "\n");
	} catch (err) {
		$.ui.log(`couldn't write the shared lock ${path}: ${String(err?.message ?? err)}`, { to: "debug" });
	}
}

const describeClient = (l) => ({ pi: "pi", codex: "Codex", mcp: "a duet MCP server", "claude-code": "another Claude Code" })[l?.client] ?? "another duet window";

// Runs detached from the command or button that asked for it, so its waits count against no hook.
// mode: "ask" or "auto" (a module reload keeps the mode it had); quiet: a rejoin nobody typed.
// copy: /duet new puts the fresh code on the clipboard.
// Joins on their way (a rejoin, the env room, /duet, the join file): the join file's poll waits for them.
let joinsInFlight = 0;
async function join($, code, nameArg, mode, quiet, relayArg, copy) {
	joinsInFlight++;
	try {
		return await joinNow($, code, nameArg, mode, quiet, relayArg, copy);
	} finally {
		joinsInFlight--;
	}
}

async function joinNow($, code, nameArg, mode, quiet, relayArg, copy) {
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
	const epoch = joinEpoch;
	if (room) {
		if (room.code === code && room.name === name && room.server === relay) return openPane($);
		await leave($, "left", false);
	}
	const key = `${relay} ${code} ${name}`;
	const fromId = (await sha256hex(`${installId} ${key}`)).slice(0, 32);
	const topic = await topicFor(code);
	const hash16 = (await sha256hex(key)).slice(0, 16);
	const lockKey = "owner:" + hash16;
	const fileLock = `${duetDir}/${hash16}.lock`;

	const held = await claim($, lockKey);
	if (held && quiet) return; // another window has it: a quiet rejoin leaves it there
	let moved = false;
	if (held) {
		let answer = "Cancel";
		try {
			answer = await $.ui.ask(`duet: ${code} · ${name} · open in another window (${held.cwd}) · move here?`, ["Move here", "Cancel"]);
		} catch {}
		if (answer !== "Move here") return;
		await $.store.set(lockKey, { ...held, release: token });
		let released = false;
		for (let i = 0; i < 20 && !released; i++) {
			await wait($, 500);
			const cur = await $.store.get(lockKey);
			released = !cur || !!cur.released;
		}
		// No answer in 10 s: that window is gone or stuck; take the room anyway.
		if (!released) $.ui.log("other window silent · took the room");
		await $.store.set(lockKey, { token, cwd, at: Date.now(), released: false });
		moved = true;
	}
	// Another client (pi, Codex), or a Claude Code with its own config, in this room under this name.
	const other = await readFileLock($, fileLock);
	if (other && other.token !== token && !(moved && other.client === "claude-code") && (await fileLockHeld($, other))) {
		const cur = await $.store.get(lockKey);
		if (cur?.token === token) await $.store.set(lockKey, { ...cur, released: true });
		if (!quiet) {
			const where = other.cwd ? ` (${other.cwd})` : other.pid ? ` (pid ${other.pid})` : "";
			$.ui.log(`${name} already in ${code} here · ${describeClient(other)}${where} · not joined`);
			$.ui.toast(`duet: ${name} already in this room · ${describeClient(other)}`);
		}
		return;
	}
	await writeFileLock($, fileLock);

	// No saved place in this room: listen from just before joining, so the others' answers to our
	// join (sent within a second or two) aren't missed while the stream is still opening.
	const saved = await $.store.get("cursor:" + key);
	const cursor = saved ?? { id: "", time: Math.floor(Date.now() / 1000) - 2 };
	const r = { code, name, key, fromId, topic, lockKey, fileLock, server: relay, mode: mode === "auto" ? "auto" : "ask", cursor, riskOk: false };
	try {
		// The first network request: if the relay can't be reached, or this session's policy refuses
		// network requests from mods, duet doesn't join.
		r.place = await placeFor(cwd, topic, host);
		await publish($, relay, topic, envelope({ fromId, from: name, kind: "join", via: "claude-code", place: r.place }));
		joinedAt = Date.now();
	} catch (err) {
		const cur = await $.store.get(lockKey);
		if (cur?.token === token) await $.store.set(lockKey, { ...cur, released: true });
		await writeFileLock($, fileLock, true);
		$.ui.log(`relay ${relay} unreachable: ${String(err?.message ?? err)} · not joined`);
		$.ui.toast("duet: relay unreachable · not joined");
		return;
	}
	if (epoch !== joinEpoch) {
		// /duet off came while this join was on its way: don't join after all.
		const cur = await $.store.get(lockKey);
		if (cur?.token === token) await $.store.set(lockKey, { ...cur, released: true });
		await writeFileLock($, fileLock, true);
		return;
	}
	room = r;
	generation++;
	queue = [];
	outbox = [];
	peers.clear();
	const stored = await $.store.get("history:" + key);
	// Keep the histories of the last few rooms only: $.store is 4 MiB for everything.
	try {
		const recent = [key, ...(((await $.store.get("history-rooms")) ?? []).filter((k) => k !== key))];
		for (const old of recent.slice(HISTORY_ROOMS)) await $.store.delete("history:" + old);
		await $.store.set("history-rooms", recent.slice(0, HISTORY_ROOMS));
	} catch {}
	history = Array.isArray(stored) ? stored.slice(-HISTORY_MAX) : [];
	autoTurns = 0;
	paused = false;
	heldCursor = null;
	await $.store.set("room:" + cwd, { code, name, relay, at: Date.now() });
	await $.store.set("name", name);
	await $.store.set("active:" + sessionId, { lockKey, token, code, name, mode: r.mode, relay });
	defaultName = name;
	heartbeat?.cancel?.();
	heartbeat = $.clock.every(2000, () => void beat($).catch(() => {}));
	joinPoll?.cancel?.();
	joinPoll = null;
	wakeSupervisor?.();
	remember($, { text: quiet ? `you rejoined as ${name}` : `you joined as ${name}`, note: true });
	let copied = false;
	if (copy) {
		try {
			copied = !!(await $.ui.copy({ text: code }))?.isCopied;
		} catch {}
	}
	if (!quiet) $.ui.log(`joined ${code} as ${name}${copied ? " · code copied" : ""}`);
	redraw($);
	void deliver($).catch(() => {});
}

// Every 2 s: notice another window taking the room, hand it over when asked, refresh the lock.
let lastBeat = 0;
async function beat($) {
	const fresh = expected.filter((x) => Date.now() - x.at < 30 * 60_000);
	if (fresh.length !== expected.length) {
		expected = fresh;
		await saveTurn($);
		redraw($);
	}
	if (!room) return;
	const r = room;
	const cur = await $.store.get(r.lockKey);
	if (room !== r) return;
	if (cur && cur.token !== token && !cur.released) {
		await leave($, null, false, true);
		$.ui.log(`${r.code} moved to another window (${cur.cwd})`);
		return;
	}
	if (cur?.release && cur.release !== token) {
		// Save where to resume (before any card still open here) before letting go of the room.
		await leave($, "moved", false);
		$.ui.log(`${r.code} handed to another window`);
		return;
	}
	if (Date.now() - lastBeat > 20_000) {
		lastBeat = Date.now();
		// Someone else holds the shared lock: another client found this window stale and took over.
		const shared = await readFileLock($, r.fileLock);
		if (room !== r) return;
		if (shared && shared.token !== token && shared.client !== "claude-code" && (await fileLockHeld($, shared))) {
			// Not a failure and nothing to do: history and the transcript only (quiet).
			remember($, { text: `room moved to ${describeClient(shared)}`, note: true });
			await leave($, null, false, true);
			$.ui.log(`${r.code} is now open as ${r.name} in ${describeClient(shared)}${shared.cwd ? ` (${shared.cwd})` : ""} · left here`);
			return;
		}
		await writeFileLock($, r.fileLock);
		await $.store.set(r.lockKey, { token, cwd, at: lastBeat, released: false });
		await $.store.set("room:" + cwd, { code: r.code, name: r.name, relay: r.server, at: lastBeat });
	}
}

// A request already handed to Claude keeps running after a leave; its reply can't be sent once the
// room is gone. forget: /duet off — the folder forgets its room.
async function leave($, note, forget, lost) {
	if (!room) return;
	const r = room;
	if (note) sendNote($, note);
	await saveCursor($);
	if (historySave) {
		historySave.cancel?.();
		historySave = null;
	}
	await $.store.set("history:" + r.key, fitHistory(history)).catch(() => {});
	// A request taken but not yet handed to Claude stays with the room (its resume point is saved).
	if (pendingPeer && !pendingPeer.submitted) pendingPeer = null;
	await saveTurn($);
	room = null;
	generation++;
	heartbeat?.cancel?.();
	heartbeat = null;
	try {
		child?.return?.();
	} catch {}
	child = null;
	connected = false;
	queue = [];
	heldCursor = null;
	if (!lost) {
		const cur = await $.store.get(r.lockKey);
		if (cur?.token === token) await $.store.set(r.lockKey, { ...cur, released: true });
		if ((await readFileLock($, r.fileLock))?.token === token) await writeFileLock($, r.fileLock, true);
	}
	await $.store.delete("active:" + sessionId);
	if (forget) await $.store.delete("room:" + cwd);
	if (watchJoin) pollJoinFile($);
	redraw($);
}

async function setMode($, mode) {
	if (!room) {
		$.ui.log("not in a room · /duet new or /duet <code>");
		return;
	}
	if (mode === "auto" && !room.riskOk && (await runsUnasked($))) {
		// The one confirm: commands run unasked here, so auto lets the other side's agent run them.
		let answer = "Keep ask";
		try {
			answer = await $.ui.ask("duet auto? · commands run unasked here · the other agent could run them", ["Turn auto on", "Keep ask"]);
		} catch {}
		if (!room) return;
		if (answer !== "Turn auto on") {
			redraw($);
			return;
		}
		room.riskOk = true;
	}
	if (!room) return;
	room.mode = mode;
	autoTurns = 0;
	paused = false;
	const active = await $.store.get("active:" + sessionId);
	if (active) await $.store.set("active:" + sessionId, { ...active, mode });
	$.ui.log(mode === "auto" ? `auto · no gates · max ${MAX_AUTO} in a row` : "ask · both gates on");
	redraw($);
	void deliver($).catch(() => {});
}

// ---------- what the user does with a card ----------

// The card shows, and acts on, the waiting messages from one sender together (up to a batch).
function firstGroup() {
	if (!queue.length) return [];
	const from = queue[0].from;
	return queue.filter((e) => e.from === from).slice(0, BATCH_MAX);
}

// Gate 1: a press acts at once. "take" (Process), "take-send" (Process and send), "ignore".
async function choose($, action) {
	const envs = firstGroup();
	if (!envs.length || !room) return;
	const take = action === "take" || action === "take-send";
	if (take && busyWithPeer()) {
		$.ui.toast("duet: busy with the last request");
		return;
	}
	queue = queue.filter((e) => !envs.includes(e));
	if (take) {
		await startPeerTurn($, envs, action === "take-send");
	} else {
		sendNote($, "declined", envs[0].from);
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
	if (room || joinsInFlight || !(await canDraw($))) return;
	const rec = await $.store.get("room:" + cwd);
	if (!rec?.code || room || joinsInFlight) return; // a join started while this looked
	await join($, rec.code, rec.name, "ask", true, rec.relay);
}

// The website's prompt writes ~/.duet/join.json and the user types /reload-plugins (or, with duet
// already loaded, nothing: the poll finds it). Taken once: emptied before joining, so no other window
// takes it too. A file for another agent or folder is left alone; a stale one is emptied.
// The newest thing the user did wins: after a reload the window first takes up its room again, then a
// join file pasted since moves it (switch); a /duet typed after the prompt empties the file (dropJoinFile).
async function takeJoinFile($, switchRoom = false, nested = false) {
	if ((room && !switchRoom) || joinsInFlight) return false;
	const path = `${duetDir}/join.json`;
	let text;
	try {
		// Asked every 2.5 s: a missing file is the usual answer, and not an error.
		if (!(await $.fs.exists(path))) return false;
		text = String(await $.fs.read(path));
	} catch {
		return false;
	}
	const got = readJoinFile(text, "claude-code", cwd, Date.now(), nested);
	if (!got || (room && !switchRoom) || joinsInFlight) return false;
	try {
		await $.fs.write(path, "{}");
	} catch {
		return false;
	}
	if (!got.take) return false;
	void join($, got.take.room, got.take.name, "ask", false, got.take.relay).catch(() => {});
	return true;
}

// A /duet <room> or /duet new typed by the user: a join file for this window is older than it, so it goes.
async function dropJoinFile($) {
	const path = `${duetDir}/join.json`;
	try {
		if (!(await $.fs.exists(path))) return;
		if (readJoinFile(String(await $.fs.read(path)), "claude-code", cwd, Date.now(), true)) await $.fs.write(path, "{}");
	} catch {}
}

function pollJoinFile($) {
	joinPoll?.cancel?.();
	joinPoll = $.clock.every(JOIN_POLL_MS, () => void takeJoinFile($).catch(() => {}));
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
	// (subagents included) that reaches exactly its sender; used up before any await, so two sends in
	// parallel can't both use it.
	const live = livePeers().map(([n]) => n);
	const reaches = to ?? (live.length === 1 ? live[0] : "");
	// Only from the turn that runs now, or a subagent it started.
	const ownTurn = fromPeer && peerTurn.turnId === runningTurn && (!e.agentId || (peerTurn.agents ?? []).includes(e.agentId));
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
		const item = { id: randomId(), text, to: to ?? (peerList() || "the room"), decision: "", agentId: e.agentId };
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
	if (!room) return null;
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
		const group = firstGroup();
		const env = group[0];
		const via = viaLabel(peers.get(env.from)?.via);
		const others = queue.length - 1;
		const reply = (g) => (g.reLine ? [Text({ dimColor: true, children: [`↳ re “${sanitize(g.reLine, 80)}”`] })] : []);
		// Every word Claude would get on "Process": the whole text of each message in the group, every
		// line, wrapped, never cut to the band's width or a line count (a peer could hide an
		// instruction past the cut).
		const body = group.flatMap((g, i) => [...(i > 0 ? [Text({ key: `sep${i}`, dimColor: true, children: ["—"] })] : []), ...reply(g), ...textRows(Text, g.text, `q${i}.`)]);
		const head = Box({
			flexDirection: "row",
			justifyContent: "space-between",
			children: [
				Box({ flexDirection: "row", children: [Text({ bold: true, color: AMBER, children: [env.from] }), Text({ dimColor: true, children: [`${via ? " · " + via : ""} · ${timeOf(env.ts)}${paused ? " · auto paused" : ""}`] })] }),
				...(others > 0 ? [Text({ dimColor: true, children: [`+${others}`] })] : []),
			],
		});
		const keys = buttons([
			Button({ key: "take", label: "Process", hotkey: "1", plain: true, onPress: () => void choose($, "take").catch(() => {}) }),
			Button({ key: "ignore", label: "Ignore", hotkey: "2", plain: true, onPress: () => void choose($, "ignore").catch(() => {}) }),
			// 3, not 2: a habit press of 2 (Ignore here, Don't send on the reply card) must never skip gate 2.
			Button({ key: "take-send", label: "Process and send", hotkey: "3", plain: true, onPress: () => void choose($, "take-send").catch(() => {}) }),
		]);
		// As gate 2: a request taller than the band keeps its keys under the title, inside the window.
		const rows = group.reduce((n, g, i) => n + rowsFor(g.text, e.props?.bodyColumns ?? 80) + (g.reLine ? 1 : 0) + (i > 0 ? 1 : 0), 0);
		const fits = rows + 4 <= (e.props?.maxRows ?? 10);
		return frame(AMBER, fits ? [head, ...body, keys] : [head, keys, ...body]);
	}
	return null;
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
							joinEpoch++;
							void leave($, "left", true).catch(() => {});
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
	const n = queue.length + outbox.length;
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

function notePermissionMode(e) {
	if (typeof e.permission_mode === "string" && e.permission_mode) permissionMode = e.permission_mode;
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
		cwd = e.cwd || (await $.session.cwd());
		home = (await $.env.get("HOME")) || (await $.env.get("USERPROFILE")) || "";
		duetDir = ((await $.env.get("DUET_HOME")) || `${home.replace(/[\\/]+$/, "")}/.duet`).replace(/\\/g, "/");
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
		// This computer and folder, hashed: a join carries it, so two windows in one folder notice.
		// `hostname` prints what Node's os.hostname() returns (pi and the MCP server use that).
		host = "";
		try {
			const h = await $.process.run(["hostname"], { timeoutMs: 3000 });
			if (h.exitCode === 0) host = h.stdout.trim();
		} catch {}
		if (!host) host = (await $.env.get("HOSTNAME")) || "";

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
		}
		void supervise($).catch(() => {});
		if (e.isInteractive || (await canDraw($))) {
			// After a module reload this window was in a room: take it up again, silently.
			const active = await $.store.get("active:" + sessionId);
			const owner = active ? await $.store.get(active.lockKey) : null;
			if (active && owner?.token === active.token && !owner.released) {
				token = active.token;
				void join($, active.code, active.name, active.mode, true, active.relay)
					.then(() => takeJoinFile($, true, true))
					.catch(() => {});
			} else if (envRoom) {
				// Started as DUET_ROOM=<room> DUET_NAME=<name> claude (the website's line).
				void join($, envRoom, envName || undefined, "ask", false).catch(() => {});
			} else if (!(await takeJoinFile($, false, true).catch(() => false))) {
				void autoRejoin($).catch(() => {});
			}
			watchJoin = true;
			if (!room) pollJoinFile($);
		}
		markReady();
		try {
			await $.tool.register({
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
			});
		} catch {}
		return next(e);
	});

	// The Desktop app may attach after the session started: rejoin then.
	on("session.attach", async ($, e, next) => {
		const result = await next(e);
		void autoRejoin($).catch(() => {});
		return result;
	});

	on("classic.SessionStart", { source: "startup" }, async ($, e, next) => {
		notePermissionMode(e);
		return next(e);
	});

	on("classic.SessionStart", { source: ["clear", "resume", "fork"] }, async ($, e, next) => {
		notePermissionMode(e);
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
			await $.store.set("active:" + sessionId, { lockKey: room.lockKey, token, code: room.code, name: room.name, mode: room.mode, relay: room.server });
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
			void $.store.set("history:" + r.key, fitHistory(history)).catch(() => {});
			void $.store.set(r.lockKey, { token, cwd, at: 0, released: true }).catch(() => {});
			if (r.fileLock) void readFileLock($, r.fileLock).then((l) => (l?.token === token ? writeFileLock($, r.fileLock, true) : undefined)).catch(() => {});
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
		// Joining and moving wait on the relay and the other window: run them detached, so the
		// command returns at once and no hook time limit applies.
		if (!first) void openPane($).catch(() => {});
		else if (arg === "new") {
			await dropJoinFile($);
			void join($, newRoomCode(), second, "ask", false, undefined, true).catch(() => {});
		}
		else if (LEAVE_WORDS.includes(arg)) {
			joinEpoch++;
			await dropJoinFile($); // leaving: a join file written meanwhile mustn't put the window straight back
			if (room) void leave($, "left", true).catch(() => {});
			else {
				await $.store.delete("room:" + cwd);
				$.ui.log("not in a room");
			}
		} else if (arg === "ask" || arg === "auto") void setMode($, arg).catch(() => {});
		else if (arg === "status") $.ui.log(room ? `${modeLabel()} · ${room.code} · you are ${room.name}` : "not in a room");
		else if (isRoomCode(first)) {
			await dropJoinFile($);
			void join($, first, second, "ask", false, third).catch(() => {});
		}
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
				redraw($);
				void deliver($).catch(() => {});
			}
		}
		return result;
	});

	on("turn.start", async ($, e, next) => {
		if (e.agentId) {
			// A subagent the peer's turn starts: its reply counts as the turn's ("Process and send").
			if (peerTurn && peerTurn.turnId === runningTurn && !(peerTurn.agents ?? []).includes(e.agentId)) {
				peerTurn.agents = [...(peerTurn.agents ?? []), e.agentId].slice(-50);
				await saveTurn($);
			}
			return next(e);
		}
		runningTurn = e.turnId;
		expected = expected.filter((x) => Date.now() - x.at < 30 * 60_000);
		const i = expected.findIndex((x) => String(e.text ?? "").includes(x.text));
		if (i >= 0) {
			const x = expected[i];
			expected = expected.filter((_, j) => j !== i);
			peerTurn = peerTurnFrom(x, e.turnId, true);
		} else if (expected.length && !userPromptSince) {
			// duet's request is pending and no prompt of the user's came since: its text may have been
			// changed on the way. Count it as the peer's, so the notes and the reply link still work.
			const x = expected.shift();
			peerTurn = peerTurnFrom(x, e.turnId, false);
		}
		await saveTurn($);
		await saveCursor($);
		redraw($);
		return next(e);
	});

	on("turn.complete", async ($, e, next) => {
		if (!e.agentId && e.turnId === runningTurn) runningTurn = "";
		// A turn ended (Esc, an error) while a reply it sent still waits at gate 2: its call was
		// abandoned, so settle it, unsent. (next.signal normally does this first.) Only that loop's
		// own replies: a background subagent's send keeps waiting after the main turn ends.
		for (const item of outbox) if ((item.agentId ?? "") === (e.agentId ?? "")) decide($, item, "stopped");
		if (!e.agentId && peerTurn && peerTurn.turnId === e.turnId) {
			const t = peerTurn;
			peerTurn = null;
			if (e.isAborted) for (const p of t.froms) sendNote($, "stopped", p);
			else if (e.reason === "error" || e.reason === "refusal") for (const p of t.froms) sendNote($, "failed", p);
			redraw($);
		}
		if (!e.agentId) await saveTurn($);
		const result = await next(e);
		void submitWhenIdle($).catch(() => {});
		void deliver($).catch(() => {});
		return result;
	});

	on("classic.PermissionRequest", async ($, e, next) => {
		notePermissionMode(e);
		if (peerTurn && !peerTurn.waitNoted) {
			peerTurn.waitNoted = true;
			for (const p of peerTurn.froms) sendNote($, "approval-wait", p);
		}
		return next(e);
	});

	on("classic.PostToolUse", async ($, e, next) => {
		notePermissionMode(e);
		return next(e);
	});

	on("classic.UserPromptSubmit", async ($, e, next) => {
		notePermissionMode(e);
		return next(e);
	});

	on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
		const card = drawCard($, e);
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
