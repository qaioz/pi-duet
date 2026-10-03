// duet for Claude Code, as a mod: pair this session with another developer's coding agent (pi,
// Claude Code or Codex) through a shared room on an ntfy relay.
//
//   /duet new            make a room and join it        /duet <room> [name] [relay]   join a room
//   /duet                open the duet pane              /duet ask | auto              how messages are handled
//   /duet leave          leave the room                  /duet status                  one line of status
//
// Receiving: `$.process.spawn` runs curl against the relay's JSON stream (mods have no streaming
// network API; Node isn't guaranteed). Sending: `$.http.fetch` POST — which also means a session
// whose policy refuses mod network requests never joins (curl is never used to go around it).
// Delivery: in "ask" mode each message waits as a card above the prompt; in "auto" mode it starts a
// turn by itself, up to MAX_AUTO turns without the user. Claude reads it under the engine's own
// "The duet plugin sent a message" line. While Claude works on a peer's request, guard.js decides
// which tool calls go ahead.
//
// Which turn is the peer's: a mod's own `prompt.submit` hook never sees its own submissions, and
// `$.prompt.submit` may resolve when its prompt is only queued. But Claude Code hands turn.start the
// prompt's text wrapped in its own lines ("The duet plugin sent a message: …", seen in 2.1.288),
// so a turn is the peer's when its text contains a frame duet submitted, until that turn's own
// turn.complete. duet submits only while Claude is idle, so its turn is the next one. Other turns
// (the user's prompt, a task notification, another session's message) are not the peer's.
//
// Every function that touches `$` is declared at the top level of this file: Claude Code's
// validator refuses `$` passed to an imported function. wire.js and guard.js are pure.
import { checkPeerTool } from "./guard.js";
import {
	DEFAULT_SERVER, MAX_AUTO, MAX_BYTES, byteLength, envelope, fitName, frameForClaude, isEnvelope, isForMe,
	isPlaceholderName, isRelayUrl, isRoomCode, newRoomCode, preview, randomId, sanitize, sha256hex, timeOf, topicFor,
} from "./wire.js";

const PANE = "duet";
const SEND_TOOL = "mcp__duet__send";
const REPAIR_POLL_MS = 10_000; // ntfy.sh writes its cache in batches; re-poll a resumed range once
const MAX_BACKOFF_MS = 30_000;
const LOCK_STALE_MS = 60_000;
const HISTORY_MAX = 200;
const QUEUE_MAX = 50;
const BATCH_MAX = 5; // messages handed to Claude in one auto turn
const VIA = { pi: "pi", "claude-code": "Claude Code", codex: "Codex" };
// Permission modes in which a tool call still asks the user (or is refused) unless a rule allows it.
const ASKING_MODES = ["default", "acceptEdits", "plan", "dontAsk"];

// ---------- state (module variables; the room and the turn in progress are also kept in $.store) ----------

let token = randomId(); // this window; adopted from $.store after a module reload
let installId = "";
let sessionId = "";
let cwd = "";
let home = "";
let server = DEFAULT_SERVER;
let defaultName = "";
let permissionMode = ""; // "" until Claude Code reports it (classic.* events)
let riskOk = false; // the user confirmed auto mode in a mode that may not ask them
let oldMcp = false; // the old MCP-server setup of duet is active in this session too

let room = null; // { code, name, key, fromId, topic, lockKey, mode, cursor, server }
let generation = 0; // bumped on every join and leave; loops of an older room stop
let wakeSupervisor = null;
let child = null; // the running curl stream
let connected = false;
let connError = "";
let heartbeat = null;
let heldCursor = null; // the newest resume point, saved once nothing received is still open
const seen = new Set();
const peers = new Map(); // name -> { via, at, left }

let queue = []; // messages waiting for the user (ask) or for Claude to be free (auto)
let armed = ""; // "<action>:<id>" whose key was pressed once
let noReply = null; // { peers, answer, id }: a peer turn ended without Claude trying to reply
let rejoinOffer = null; // { code, name, relay }
let pendingPeer = null; // { envs, text, roomKey, submitted }: taken, waiting for Claude to be idle
let expected = []; // [{ text, froms, roomKey, at }]: submitted frames whose turn hasn't started yet
let peerTurn = null; // { froms, roomKey, turnId, attempted (a send was tried), waitNoted }
let lastPeer = null; // { froms, roomKey }: the peer turn that just ended (an empty-text continuation is still its)
let runningTurn = ""; // the main loop's turn in progress, "" while Claude is idle
let peerAgents = []; // subagents started from a peer turn (they may outlive it)
let autoTurns = 0;
let paused = false;

let history = []; // { at, who, text, out, note }
let paneTab = "room";
let replyTo = "";

const viaLabel = (via) => VIA[via] ?? "";
const peerNames = () => (peerTurn ? peerTurn.froms.join(", ") : "the other person");
const riskyMode = () => !ASKING_MODES.includes(permissionMode);
const autoActive = () => !!room && room.mode === "auto" && !paused && (!riskyMode() || riskOk);
const livePeers = () => [...peers.entries()].filter(([, p]) => !p.left);
const fromPeerCall = (e) => (e.agentId ? peerAgents.includes(e.agentId) : !!peerTurn);
const busyWithPeer = () => !!(pendingPeer || peerTurn || expected.length);

function remember(entry) {
	history.push({ at: new Date().toISOString(), ...entry });
	if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
}

// Two presses for anything that acts for someone else: a stray digit in an empty prompt is easy.
function confirmPress(key) {
	if (armed === key) {
		armed = "";
		return true;
	}
	armed = key;
	return false;
}

// ---------- small helpers that use $ ----------

function redraw($) {
	$.ui.invalidate("ui.render");
}

function wait($, ms) {
	return new Promise((resolve) => {
		$.clock.after(ms, resolve);
	});
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
	if (bytes > MAX_BYTES) throw new Error(`the message is ${bytes} bytes and the limit is ${MAX_BYTES}: split it into several sends`);
	const res = await Promise.race([
		$.http.fetch(`${relay}/${topic}`, { method: "POST", body }),
		new Promise((_, reject) => {
			$.clock.after(15_000, () => reject(new Error("the relay didn't answer within 15 seconds")));
		}),
	]);
	if (!res.ok) throw new Error(`the relay answered HTTP ${res.status}${res.status === 429 ? " (rate limit: wait a minute)" : ""}`);
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
	await $.store.set("turn:" + sessionId, {
		pendingPeer,
		expected,
		peerTurn,
		lastPeer,
		runningTurn,
		peerAgents,
		at: Date.now(),
	});
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
		if (floor) repair = $.clock.after(REPAIR_POLL_MS, () => void repairPoll($, r, gen, floor));
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
				await handleLine($, r, gen, buf.slice(0, nl), true, floor);
				buf = buf.slice(nl + 1);
			}
		}
	} catch (err) {
		connError = /ENOENT|not found|cannot start/i.test(String(err?.message)) ? "curl is not installed (duet needs it to receive)" : String(err?.message ?? err);
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
		for (const line of res.text.split("\n")) await handleLine($, r, gen, line, false, floor);
	} catch {}
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
	let env = null;
	try {
		env = JSON.parse(evt.message);
	} catch {}
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

function onEnvelope($, r, env) {
	if (!isForMe(env, r.fromId, r.name)) return;
	const before = peers.get(env.from);
	const isNew = !before || before.left;
	peers.set(env.from, { via: env.via ?? before?.via ?? "", at: Date.now(), left: false });
	if (env.kind === "join") {
		if (isNew) {
			const via = viaLabel(env.via);
			$.ui.toast(`${env.from} joined${via ? " (" + via + ")" : ""}`);
			remember({ who: env.from, text: "joined the room", note: true });
			// Answer once, so a newcomer learns who is here (older clients don't answer joins).
			void publish($, r.server, r.topic, envelope({ fromId: r.fromId, from: r.name, kind: "join", via: "claude-code" })).catch(() => {});
		}
		redraw($);
		return;
	}
	if (env.kind === "note") {
		const text = {
			declined: `${env.from} didn't take your last message`,
			stopped: `${env.from} stopped Claude working on your request`,
			failed: `${env.from}'s Claude couldn't finish your request`,
			"approval-wait": `${env.from}'s Claude is waiting for ${env.from} to approve a step`,
			left: `${env.from} left the room`,
			moved: `${env.from} moved to another window`,
		}[env.note];
		if (env.note === "left") peers.set(env.from, { ...peers.get(env.from), left: true });
		remember({ who: env.from, text, note: true });
		$.ui.log(text);
		$.ui.toast(text);
		redraw($);
		return;
	}
	remember({ who: env.from + (env.by === "person" ? "" : "'s agent"), text: env.text });
	if (queue.length >= QUEUE_MAX) {
		queue.shift();
		$.ui.toast(`duet: more than ${QUEUE_MAX} messages waiting — the oldest was dropped (it is in /duet → Talk)`);
	}
	queue.push(env);
	$.ui.toast(`message from ${env.from}${env.by === "person" ? "" : "'s agent"}`);
	void deliver($);
	redraw($);
}

// ---------- delivery ----------

async function deliver($) {
	if (!room || !queue.length || busyWithPeer() || !autoActive()) return;
	if (autoTurns >= MAX_AUTO) {
		paused = true;
		$.ui.toast(`duet: ${MAX_AUTO} requests ran without you — the rest wait for you above the prompt`);
		redraw($);
		return;
	}
	autoTurns++;
	await startPeerTurn($, queue.splice(0, BATCH_MAX));
}

async function startPeerTurn($, envs) {
	pendingPeer = { envs, text: frameForClaude(envs, cwd, SEND_TOOL), roomKey: room?.key ?? "", submitted: false };
	noReply = null;
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
	expected = [...expected, { text: p.text, froms, roomKey: p.roomKey, envs: p.envs, at: Date.now() }];
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
		$.ui.toast("duet: Claude Code didn't take the request: " + sanitize(result.drop, 200));
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

// Runs detached from the command or button that asked for it, so its waits count against no hook.
async function join($, code, nameArg, mode, quiet, relayArg) {
	if (!isRoomCode(code)) {
		$.ui.log("a room code is 3–64 letters, digits, - or _ — or use /duet new");
		return;
	}
	if (isPlaceholderName(nameArg)) {
		$.ui.log(`"${nameArg}" is the placeholder: use your own name, as in /duet ${code} karlo`);
		return;
	}
	if (relayArg && !isRelayUrl(relayArg)) {
		$.ui.log(`the relay must be a plain http(s) URL like https://ntfy.sh, got ${sanitize(relayArg, 100)}`);
		return;
	}
	const relay = (relayArg || server).replace(/\/+$/, "");
	const name = fitName(nameArg || defaultName || "anon");
	if (room) {
		if (room.code === code && room.name === name && room.server === relay) return openPane($, "room");
		await leave($, "left", false);
	}
	try {
		oldMcp = oldMcp || (await $.tool.list()).some((t) => /^mcp__duet__duet_/.test(t.name));
	} catch {}
	if (oldMcp) {
		$.ui.log("the older duet setup (an MCP server named duet) is also active here, so every message would arrive twice. In your shell run: npx -y github:qaioz/pi-duet setup claude --off");
	}
	const key = `${relay} ${code} ${name}`;
	const fromId = (await sha256hex(`${installId} ${key}`)).slice(0, 32);
	const topic = await topicFor(code);
	const lockKey = "owner:" + (await sha256hex(key)).slice(0, 16);

	const held = await claim($, lockKey);
	if (held) {
		let answer = "Cancel";
		try {
			answer = await $.ui.ask(`${code} is open as ${name} in another Claude Code window on this computer (${held.cwd}). Move it to this window?`, ["Move it here", "Cancel"]);
		} catch {}
		if (answer !== "Move it here") return;
		await $.store.set(lockKey, { ...held, release: token });
		let released = false;
		for (let i = 0; i < 20 && !released; i++) {
			await wait($, 500);
			const cur = await $.store.get(lockKey);
			released = !cur || !!cur.released;
		}
		// No answer in 10 s: that window is gone or stuck; take the room anyway, and say so.
		if (!released) $.ui.log("the other window didn't answer; taking the room over");
		await $.store.set(lockKey, { token, cwd, at: Date.now(), released: false });
	}

	const r = { code, name, key, fromId, topic, lockKey, server: relay, mode: mode === "auto" ? "auto" : "ask", cursor: (await $.store.get("cursor:" + key)) ?? undefined };
	try {
		// The first network request: if the relay can't be reached, or this session's policy refuses
		// network requests from mods, duet doesn't join.
		await publish($, relay, topic, envelope({ fromId, from: name, kind: "join", via: "claude-code" }));
	} catch (err) {
		const cur = await $.store.get(lockKey);
		if (cur?.token === token) await $.store.set(lockKey, { ...cur, released: true });
		$.ui.log(`couldn't reach the relay ${relay}: ${String(err?.message ?? err)}. Not joined.`);
		$.ui.toast("duet: couldn't reach the relay — not joined");
		return;
	}
	server = relay;
	room = r;
	generation++;
	queue = [];
	peers.clear();
	history = [];
	autoTurns = 0;
	paused = false;
	heldCursor = null;
	rejoinOffer = null;
	await $.store.set("room:" + cwd, { code, name, relay });
	await $.store.set("name", name);
	await $.store.set("active:" + sessionId, { lockKey, token, code, name, mode: r.mode, relay });
	defaultName = name;
	heartbeat?.cancel?.();
	heartbeat = $.clock.every(2000, () => void beat($));
	wakeSupervisor?.();
	remember({ who: "you", text: `joined ${code} as ${name}`, note: true });
	if (!quiet) $.ui.log(`joined room ${code} as ${name} (${r.mode} mode). Give the other person this room code: ${code}`);
	redraw($);
}

// Every 2 s: notice another window taking the room, hand it over when asked, refresh the lock.
let lastBeat = 0;
async function beat($) {
	if (!room) return;
	const r = room;
	const cur = await $.store.get(r.lockKey);
	if (room !== r) return;
	if (cur && cur.token !== token && !cur.released) {
		await leave($, null, false, true);
		$.ui.log(`room ${r.code} moved to another window (${cur.cwd})`);
		$.ui.toast("duet: the room moved to another window");
		return;
	}
	if (cur?.release && cur.release !== token) {
		// Save where to resume (before any card still open here) before letting go of the room.
		await leave($, "moved", false);
		$.ui.log(`handed room ${r.code} to another window`);
		return;
	}
	if (Date.now() - lastBeat > 20_000) {
		lastBeat = Date.now();
		await $.store.set(r.lockKey, { token, cwd, at: lastBeat, released: false });
	}
}

// A request already handed to Claude keeps running (and stays fenced) after a leave; its reply
// can't be sent once the room is gone.
async function leave($, note, forget, lost) {
	if (!room) return;
	const r = room;
	if (note) sendNote($, note);
	await saveCursor($);
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
	armed = "";
	noReply = null;
	heldCursor = null;
	if (!lost) {
		const cur = await $.store.get(r.lockKey);
		if (cur?.token === token) await $.store.set(r.lockKey, { ...cur, released: true });
	}
	await $.store.delete("active:" + sessionId);
	if (forget) await $.store.delete("room:" + cwd);
	redraw($);
}

async function setMode($, mode) {
	if (!room) {
		$.ui.log("not in a room: /duet new, or /duet <room code>");
		return;
	}
	if (mode === "auto" && riskyMode() && !riskOk) {
		const why =
			permissionMode === "bypassPermissions"
				? "This session runs with bypassPermissions"
				: permissionMode
					? `This session runs in ${permissionMode} mode`
					: "duet can't tell yet whether this session asks before running commands";
		let answer = "Keep ask";
		try {
			answer = await $.ui.ask(
				`${why}: in auto mode the other person's agent may be able to run commands on this computer without asking you. Turn auto on?`,
				["Turn auto on", "Keep ask"],
			);
		} catch {}
		if (answer !== "Turn auto on") return;
		riskOk = true;
	}
	room.mode = mode;
	autoTurns = 0;
	paused = false;
	const active = await $.store.get("active:" + sessionId);
	if (active) await $.store.set("active:" + sessionId, { ...active, mode });
	$.ui.log(mode === "auto" ? `auto: messages start a turn by themselves, up to ${MAX_AUTO} in a row without you` : "ask: each message waits above the prompt for you");
	redraw($);
	void deliver($);
}

// ---------- what the user does with a card ----------

async function take($, env) {
	if (busyWithPeer()) {
		$.ui.toast("Claude is still on the last duet request — this one can start after it");
		return;
	}
	if (!confirmPress("take:" + env.id)) return redraw($);
	queue = queue.filter((e) => e !== env);
	await startPeerTurn($, [env]);
}

async function putInPrompt($, env) {
	const who = env.by === "person" ? env.from : `${env.from}'s agent`;
	const r = await $.prompt.suggest({ text: `${who} asks (via duet): "${sanitize(env.text, 4000)}"` });
	if (!r?.isShown) {
		$.ui.toast("duet can only suggest into an empty prompt while Claude is idle — try again then");
		return;
	}
	queue = queue.filter((e) => e !== env);
	armed = "";
	redraw($);
	await saveCursor($);
}

async function replyMyself($, env) {
	queue = queue.filter((e) => e !== env);
	armed = "";
	replyTo = env.from;
	await saveCursor($);
	await openPane($, "talk");
}

async function ignore($, env) {
	if (!confirmPress("ignore:" + env.id)) return redraw($);
	queue = queue.filter((e) => e !== env);
	sendNote($, "declined", env.from);
	redraw($);
	await saveCursor($);
}

async function sendAnswer($) {
	const offer = noReply;
	if (!offer || !confirmPress("answer:" + offer.id)) return redraw($);
	noReply = null;
	redraw($);
	if (!room || !offer.answer.trim()) return;
	try {
		for (const to of offer.peers) {
			await publish($, room.server, room.topic, envelope({ fromId: room.fromId, from: room.name, kind: "msg", text: offer.answer, by: "agent", to }));
		}
		remember({ who: "you → " + offer.peers.join(", "), text: offer.answer, out: true });
		$.ui.toast("sent Claude's answer");
	} catch (err) {
		$.ui.toast("not sent: " + String(err?.message ?? err));
	}
}

async function sayDirect($, text) {
	if (!room || !text.trim()) return;
	const to = replyTo && peers.has(replyTo) ? replyTo : undefined;
	try {
		await publish($, room.server, room.topic, envelope({ fromId: room.fromId, from: room.name, kind: "msg", text: text.trim(), by: "person", ...(to ? { to } : {}) }));
		remember({ who: "you" + (to ? " → " + to : ""), text: text.trim(), out: true });
	} catch (err) {
		$.ui.toast("not sent: " + String(err?.message ?? err));
	}
	redraw($);
}

async function openPane($, tab) {
	paneTab = tab;
	await $.ui.open({ id: PANE, title: "duet", focus: true, closeOnEscape: true });
	redraw($);
}

async function offerRejoin($) {
	if (room || rejoinOffer || !(await canDraw($))) return;
	rejoinOffer = (await $.store.get("room:" + cwd)) ?? null;
	if (rejoinOffer) redraw($);
}

// ---------- the send tool ----------

async function sendTool($, e) {
	if (!room) return { result: "Not sent: this session isn't in a duet room. Your user can join one with /duet." };
	const text = String(e.text ?? "").trim();
	if (!text) return { result: "Not sent: the message is empty." };
	const to = typeof e.to === "string" && e.to.trim() ? e.to.trim() : undefined;
	const fromPeer = fromPeerCall(e);
	if (fromPeer && (!peerTurn || peerTurn.roomKey !== room.key)) {
		return { result: "Not sent: the request you're working on came from a room this window has left, or has ended. Tell your user instead." };
	}
	if (peerTurn && fromPeer) peerTurn.attempted = true;
	// In ask mode the user sees what leaves the computer during a peer's request.
	if (fromPeer && !autoActive()) {
		let answer = "Don't send";
		try {
			answer = await $.ui.ask(`duet: send this to ${to ?? peerNames()}? “${preview(text, 12, 160, "")}”`, ["Send", "Don't send"]);
		} catch {}
		if (answer !== "Send") return { result: "Not sent: your user chose not to send this. Don't send it again unless they ask." };
	}
	try {
		await publish($, room.server, room.topic, envelope({ fromId: room.fromId, from: room.name, kind: "msg", text, by: "agent", ...(to ? { to } : {}) }));
	} catch (err) {
		return { result: "Not sent: " + String(err?.message ?? err) };
	}
	remember({ who: "Claude → " + (to ?? (livePeers().map(([n]) => n).join(", ") || "room")), text, out: true });
	redraw($);
	return { result: `Sent to ${to ?? "the room"}.` };
}

// ---------- drawing ----------

function drawCard($, e) {
	const { Box, Text, Button } = $.ui.resolve(e);
	const frame = (title, body, buttons) =>
		Box({
			flexDirection: "column",
			borderStyle: "round",
			paddingX: 1,
			children: [
				Text({ bold: true, children: [title] }),
				...body,
				Box({ flexDirection: "row", columnGap: 3, flexWrap: "wrap", children: buttons }),
			],
		});
	const twice = (key, label, again) => (armed === key ? `Press ${again} again to ${label[0].toLowerCase()}${label.slice(1)}` : label);
	if (rejoinOffer && !room) {
		const o = rejoinOffer;
		// Always back in ask mode: auto is switched on again on purpose, never by one key.
		return frame(`duet · rejoin ${o.code} as ${o.name}?`, [], [
			Button({ key: "rejoin-yes", label: "Rejoin", hotkey: "1", plain: true, onPress: () => void join($, o.code, o.name, "ask", false, o.relay) }),
			Button({ key: "rejoin-no", label: "Not now", hotkey: "2", plain: true, onPress: () => { rejoinOffer = null; redraw($); } }),
		]);
	}
	if (!room) return null;
	if (pendingPeer && !pendingPeer.submitted) {
		const p = pendingPeer;
		return frame(`duet · ${p.envs.map((x) => x.from).join(", ")}'s request starts when Claude is free`, [], [
			Button({ key: "cancel-waiting", label: "Cancel", hotkey: "2", plain: true, onPress: () => void cancelWaiting($) }),
		]);
	}
	if (expected.length && !peerTurn) {
		return frame(`duet · ${expected[0].froms.join(", ")}'s request is with Claude Code, starting next`, [], []);
	}
	if (queue.length && autoActive()) {
		const froms = [...new Set(queue.map((x) => x.from))].join(", ");
		return frame(`duet · ${queue.length} message${queue.length > 1 ? "s" : ""} from ${froms} start${queue.length > 1 ? "" : "s"} when Claude is free (auto)`, [], [
			Button({ key: "to-ask", label: "Switch to ask", hotkey: "1", plain: true, onPress: () => void setMode($, "ask") }),
		]);
	}
	if (queue.length) {
		const env = queue[0];
		const who = env.by === "person" ? `${env.from} (in person)` : `${env.from}'s agent`;
		const via = viaLabel(peers.get(env.from)?.via);
		const more = queue.length > 1 ? `   +${queue.length - 1} more` : "";
		return frame(`duet · from ${who}${via ? " (" + via + ")" : ""} · ${timeOf(env.ts)}${more}${paused ? "   (auto paused)" : ""}`, [Text({ children: [preview(env.text)] })], [
			Button({ key: "take", label: twice("take:" + env.id, "Let Claude do it", 1), hotkey: "1", plain: true, onPress: () => void take($, env) }),
			Button({ key: "suggest", label: "Put it in my prompt", hotkey: "2", plain: true, onPress: () => void putInPrompt($, env) }),
			Button({ key: "reply", label: "Reply myself", hotkey: "3", plain: true, onPress: () => void replyMyself($, env) }),
			Button({ key: "ignore", label: twice("ignore:" + env.id, "Ignore", 4), hotkey: "4", plain: true, onPress: () => void ignore($, env) }),
		]);
	}
	if (noReply) {
		const n = noReply;
		return frame(`duet · Claude finished ${n.peers.join(", ")}'s request without replying`, [Text({ dimColor: true, children: [preview(n.answer, 2, 140)] })], [
			Button({ key: "send-answer", label: twice("answer:" + n.id, "Send its answer", 1), hotkey: "1", plain: true, onPress: () => void sendAnswer($) }),
			Button({ key: "skip-answer", label: "Skip", hotkey: "2", plain: true, onPress: () => { noReply = null; redraw($); } }),
		]);
	}
	return null;
}

function drawPane($, e) {
	const { Box, Text, Button, Input } = $.ui.resolve(e);
	const tabs = Box({
		flexDirection: "row",
		columnGap: 3,
		children: [
			Button({ key: "tab-room", label: "Room", hotkey: "1", plain: true, dimColor: paneTab !== "room", onPress: () => { paneTab = "room"; redraw($); } }),
			Button({ key: "tab-talk", label: "Talk", hotkey: "2", plain: true, dimColor: paneTab !== "talk", onPress: () => { paneTab = "talk"; redraw($); } }),
		],
	});
	const blank = Text({ children: [" "] });
	let body;
	if (paneTab === "talk") {
		const shown = history.slice(-30);
		body = [
			...(shown.length
				? shown.map((h, i) =>
						Box({
							key: "h" + i,
							flexDirection: "column",
							children: [
								Text({ bold: !h.note, dimColor: !!h.note, children: [`${timeOf(h.at)}  ${h.who}${h.note ? " " + sanitize(h.text, 300) : ""}`] }),
								...(h.note ? [] : [Text({ children: [sanitize(h.text, 1500)] })]),
							],
						}),
					)
				: [Text({ dimColor: true, children: ["Nothing yet."] })]),
			blank,
			room
				? Input({ key: "say", label: `You → ${replyTo || "everyone"}`, placeholder: "type to the other person directly (your Claude doesn't see this)", value: "", submitLabel: "send", autoFocus: true, onSubmit: (v) => void sayDirect($, v) })
				: Text({ dimColor: true, children: ["Join a room first."] }),
		];
	} else if (!room) {
		body = [
			Text({ children: ["Pair this Claude Code with another developer's agent (pi, Claude Code or Codex)."] }),
			blank,
			Input({ key: "name", label: "Your name", placeholder: "letters, digits, . _ -", value: defaultName, submitLabel: "save", onSubmit: (v) => { if (v.trim()) defaultName = fitName(v.trim()); redraw($); } }),
			Input({ key: "code", label: "Room code", placeholder: "paste the code you were given", value: "", submitLabel: "join", autoFocus: true, onSubmit: (v) => void join($, v.trim(), defaultName, "ask") }),
			Button({ key: "new", label: "New room (makes a code to share)", onPress: () => void join($, newRoomCode(), defaultName, "ask") }),
			blank,
			Text({ dimColor: true, children: ["Tab moves between fields · Esc closes · or type /duet new"] }),
		];
	} else {
		const ps = livePeers();
		body = [
			Text({ bold: true, children: [`Room ${room.code}`] }),
			Text({ dimColor: true, children: ["Share this code with the other person. Anyone who has it can read and send messages here."] }),
			Text({ children: [`You: ${room.name} · relay ${connected ? "connected" : connError ? "not connected: " + connError : "connecting…"}`] }),
			Text({
				children: [
					room.mode === "auto"
						? `Mode: auto — messages start Claude by themselves (up to ${MAX_AUTO} in a row without you)${paused ? " · paused" : ""}`
						: "Mode: ask — each message waits above the prompt for you to decide",
				],
			}),
			Text({ children: [ps.length ? "Here: " + ps.map(([n, p]) => n + (p.via ? ` (${viaLabel(p.via)})` : "")).join(", ") : "No one else seen yet (older pi and Codex show up once they send something)."] }),
			blank,
			Box({
				flexDirection: "row",
				columnGap: 2,
				flexWrap: "wrap",
				children: [
					Button({ key: "copy", label: "Copy code", onPress: () => void $.ui.copy({ text: room?.code ?? "" }).then((c) => $.ui.toast(c?.isCopied === false ? "couldn't copy — select the code above" : "room code copied")) }),
					Button({ key: "mode", label: room.mode === "auto" ? "Switch to ask" : "Switch to auto", onPress: () => void setMode($, room?.mode === "auto" ? "ask" : "auto") }),
					Button({ key: "leave", label: "Leave room", onPress: () => void leave($, "left", true) }),
				],
			}),
		];
	}
	return Box({ flexDirection: "column", children: [tabs, blank, ...body] });
}

function modeLabel() {
	if (!room) return "";
	const ps = livePeers().map(([n]) => n);
	const who = ps.length ? ps.join(", ") : "no one seen yet";
	const link = connected ? "" : " · offline";
	return `duet ${room.code} · ${who} · ${room.mode}${paused ? " (paused)" : ""}${link}`;
}

// No turn of this process or conversation is running: forget what a crashed or other one left.
async function clearTurn($) {
	pendingPeer = null;
	expected = [];
	peerTurn = null;
	lastPeer = null;
	runningTurn = "";
	peerAgents = [];
	await $.store.delete("turn:" + sessionId);
	redraw($);
}

function notePermissionMode(e) {
	if (typeof e.permission_mode === "string" && e.permission_mode) permissionMode = e.permission_mode;
}

// ---------- hooks ----------

export function register(on) {
	on("session.start", async ($, e, next) => {
		cwd = e.cwd || (await $.session.cwd());
		home = (await $.env.get("HOME")) || (await $.env.get("USERPROFILE")) || "";
		const relay = (await $.env.get("DUET_SERVER")) || "";
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
		// After a module reload in this same process, the request in progress stays fenced: its turn,
		// a frame Claude Code has queued, its subagents. (A new process clears this: classic.SessionStart.)
		const turn = await $.store.get("turn:" + sessionId);
		if (turn && Date.now() - (turn.at ?? 0) < 6 * 3600_000) {
			pendingPeer = turn.pendingPeer ?? null;
			expected = Array.isArray(turn.expected) ? turn.expected : [];
			peerTurn = turn.peerTurn ?? null;
			lastPeer = turn.lastPeer ?? null;
			runningTurn = turn.runningTurn ?? "";
			peerAgents = Array.isArray(turn.peerAgents) ? turn.peerAgents : [];
		}
		void supervise($);
		if (e.isInteractive || (await canDraw($))) {
			// After a module reload this window was in a room: take it up again, silently.
			const active = await $.store.get("active:" + sessionId);
			const owner = active ? await $.store.get(active.lockKey) : null;
			if (active && owner?.token === active.token && !owner.released) {
				token = active.token;
				void join($, active.code, active.name, active.mode, true, active.relay);
			} else {
				await offerRejoin($);
			}
		}
		try {
			await $.tool.register({
				name: "send",
				description:
					"Send a message to the other agent(s) in your duet room (another developer's coding agent on their computer). " +
					"Use it to answer a duet request, or when your user asks you to tell the other side something. " +
					"Your text replies are seen only by your own user; this tool is the only way to reach the other side. Max ~3.5KB per message.",
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
		try {
			await $.command.register({ name: "duet", description: "Pair with another developer's agent: /duet new, /duet <room>, /duet leave", argumentHint: "[new | <room> [name] [relay] | ask | auto | leave | status]", immediate: true });
		} catch {}
		return next(e);
	});

	// The Desktop app may attach after the session started: offer to rejoin then.
	on("session.attach", async ($, e, next) => {
		const result = await next(e);
		void offerRejoin($);
		return result;
	});

	on("classic.SessionStart", { source: "startup" }, async ($, e, next) => {
		notePermissionMode(e);
		await clearTurn($);
		return next(e);
	});

	on("classic.SessionStart", { source: ["clear", "resume", "fork"] }, async ($, e, next) => {
		notePermissionMode(e);
		if (e.source === "resume") await clearTurn($);
		// /clear and friends may give the session a new id; the room stays with this window.
		const old = sessionId;
		sessionId = await $.session.id();
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
			// All session.end hooks share 1.5 s: best effort, and nothing on a crash.
			void publish($, r.server, r.topic, envelope({ fromId: r.fromId, from: r.name, kind: "note", note: "left" })).catch(() => {});
			void $.store.set(r.lockKey, { token, cwd, at: 0, released: true });
			void $.store.delete("active:" + sessionId);
		}
		if (e.reason !== "clear" && e.reason !== "resume") void $.store.delete("turn:" + sessionId);
		return next(e);
	});

	on("command.run", { command: "duet" }, async ($, e) => {
		if (!(await canDraw($))) {
			$.ui.log("duet needs the Claude Code terminal or the Desktop app's Code tab.");
			return {};
		}
		const [first = "", second, third] = String(e.args ?? "").trim().split(/\s+/);
		const arg = first.toLowerCase();
		// Joining and moving wait on the relay and the other window: run them detached, so the
		// command returns at once and no hook time limit applies.
		if (!first) void openPane($, room ? "talk" : "room");
		else if (arg === "new") void join($, newRoomCode(), second, "ask");
		else if (arg === "leave") {
			if (room) void leave($, "left", true);
			else $.ui.log("not in a room");
		} else if (arg === "ask" || arg === "auto") void setMode($, arg);
		else if (arg === "status") $.ui.log(room ? `${modeLabel()} · you are ${room.name}` : "not in a room");
		else if (isRoomCode(first)) void join($, first, second, "ask", false, third);
		else $.ui.log("usage: /duet new · /duet <room code> [your name] [relay URL] · /duet ask|auto · /duet leave · /duet (pane)");
		return {};
	});

	on("tool.describe", { tool: SEND_TOOL }, async ($, e) => ({ description: e.description, isDeferred: false }));
	on("tool.describe", { tool: /^mcp__duet__duet_/ }, async ($, e, next) => {
		oldMcp = true;
		return next(e);
	});

	on("tool.call", async ($, e, next) => {
		if (e.tool === SEND_TOOL) return sendTool($, e);
		if (fromPeerCall(e)) {
			const reason = checkPeerTool(e, { cwd, home, peer: peerNames(), sendTool: SEND_TOOL });
			if (reason) return { deny: reason };
		}
		return next(e);
	}).catch(async ($, e) => ({ deny: `duet's check on this call failed, so it was not run. Try again.` }));

	on("agent.spawn", async ($, e, next) => {
		const fromPeer = e.parentAgentId ? peerAgents.includes(e.parentAgentId) : !!peerTurn;
		const result = await next(e);
		if (fromPeer && result?.agentId) {
			peerAgents = [...peerAgents, result.agentId].slice(-200);
			await saveTurn($);
		}
		return result;
	});

	on("prompt.submit", async ($, e, next) => {
		const result = await next(e);
		// Claude Code's own stamp: Enter at the prompt, or Remote Control; a prompt that entered.
		const kind = e.origin?.kind;
		if (!result?.drop && (kind === "composer" || kind === "bridge")) {
			lastPeer = null;
			autoTurns = 0;
			if (paused) {
				paused = false;
				redraw($);
			}
		}
		return result;
	});

	on("turn.start", async ($, e, next) => {
		if (e.agentId) return next(e);
		runningTurn = e.turnId;
		expected = expected.filter((x) => Date.now() - x.at < 30 * 60_000);
		const i = expected.findIndex((x) => e.text.includes(x.text));
		if (i >= 0) {
			const x = expected[i];
			expected = expected.filter((_, j) => j !== i);
			peerTurn = { froms: x.froms, roomKey: x.roomKey, turnId: e.turnId, attempted: false, waitNoted: false };
			lastPeer = null;
		} else if (!e.text && lastPeer) {
			// A continuation of the peer's turn (a Stop hook asked for more): still the peer's request.
			peerTurn = { ...lastPeer, turnId: e.turnId, attempted: false, waitNoted: false };
		} else {
			lastPeer = null;
		}
		await saveTurn($);
		await saveCursor($);
		redraw($);
		return next(e);
	});

	on("turn.complete", async ($, e, next) => {
		if (!e.agentId && e.turnId === runningTurn) runningTurn = "";
		if (!e.agentId && peerTurn && peerTurn.turnId === e.turnId) {
			const t = peerTurn;
			peerTurn = null;
			lastPeer = e.isAborted ? null : { froms: t.froms, roomKey: t.roomKey };
			if (e.isAborted) for (const p of t.froms) sendNote($, "stopped", p);
			else if (e.reason === "error" || e.reason === "refusal") for (const p of t.froms) sendNote($, "failed", p);
			else if (!t.attempted && room && String(e.answer ?? "").trim()) noReply = { peers: t.froms, answer: String(e.answer), id: randomId() };
			redraw($);
		}
		if (!e.agentId) await saveTurn($);
		const result = await next(e);
		void submitWhenIdle($);
		void deliver($);
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

	on("classic.PreToolUse", async ($, e, next) => {
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
		if (!peerTurn) return next(e);
		return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix ?? ""} · for ${peerNames()}` } });
	});
}
