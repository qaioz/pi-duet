// duet for Claude Code, as a mod: pair this session with another developer's coding agent (pi,
// Claude Code or Codex) through a shared room on an ntfy relay.
//
//   /duet new            make a room and join it        /duet <room> [name] [relay]   join a room
//   /duet                open the duet pane              /duet ask | auto              how messages are handled
//   /duet off            leave the room                  /duet trust                   who's in the room
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
	DEFAULT_SERVER, LEAVE_WORDS, MAX_AUTO, MAX_BYTES, MAX_TEXT, attachmentUrl, byteLength, envelope, firstLine, fitName, frameForClaude, isEnvelope, isForMe, placeFor,
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
const UNDO_MS = 3000; // after "Let Claude do it" or "Ignore", time to take it back
const REJOIN_MS = 12 * 3600_000; // rejoin quietly only within this (agents ignore older messages anyway)
const TOAST_GAP_MS = 15_000; // one "message from …" toast per sender per burst
// Who is in the room, asked once per room: it sets how messages are handled.
const TRUST = {
	me: { label: "Only me", mode: "auto", says: "my other window, or my own pi or Codex here; requests start Claude by themselves, with no extra check even under bypassPermissions, and anyone with the room code counts as you" },
	trusted: { label: "Someone I trust completely", mode: "auto", says: "their requests start Claude by themselves, and replies go straight out" },
	others: { label: "Someone else", mode: "ask", says: "each request waits for you, and replies are shown before they're sent" },
};
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
let permissionMode = ""; // "" until Claude Code reports it (classic.* events; not at startup, not to tool.call)
let lastUnasked; // runsUnasked's latest answer, fresher than permissionMode after a Shift+Tab
let oldMcp = false; // the old MCP-server setup of duet is active in this session too

let room = null; // { code, name, key, fromId, topic, lockKey, mode, cursor, server }
let generation = 0; // bumped on every join and leave; loops of an older room stop
let joinEpoch = 0; // bumped by /duet off: a join still in flight then gives up
let wakeSupervisor = null;
let child = null; // the running curl stream
let connected = false;
let connError = "";
let heartbeat = null;
let heldCursor = null; // the newest resume point, saved once nothing received is still open
const seen = new Set();
const peers = new Map(); // name -> { via, at, left }

let queue = []; // messages waiting for the user (ask) or for Claude to be free (auto)
let countdown = null; // { action: "take" | "ignore", envs, timer }: a card choice that can still be undone
const lastToast = new Map(); // sender -> time of the last "message from" toast
let pendingPeer = null; // { envs, text, roomKey, submitted }: taken, waiting for Claude to be idle
let expected = []; // [{ text, froms, roomKey, at }]: submitted frames whose turn hasn't started yet
let peerTurn = null; // { froms, roomKey, turnId, waitNoted }
let lastPeer = null; // { froms, roomKey, guard }: the peer turn that just ended; any turn before the user's own prompt is still its
let lastGuard = null; // { auto, unaskedAtStart }: how the latest peer turn started (its subagents may outlive it)
let runningTurn = ""; // the main loop's turn in progress, "" while Claude is idle
let userPromptSince = false; // the user's own prompt entered since duet's last submission
let userPromptsOpen = 0; // the user's own prompts submitted whose submission hasn't resolved yet
let peerAgents = []; // subagents started from a peer turn (they may outlive it)
let autoTurns = 0;
let paused = false;

let history = []; // { at, who, text, note }: the room as the pane shows it, read-only
const sent = new Map(); // our messages' ids -> first line, to show what a reply answers
let host = ""; // this computer's name, for the folder hash a join carries (see wire.js placeFor)
let lineChain = Promise.resolve(); // received lines, one at a time in arrival order (stream and repair poll)
const warnedAbout = new Set(); // warnings already given: "crowd", "place:<name>"

const viaLabel = (via) => VIA[via] ?? "";
const peerNames = () => (peerTurn ? peerTurn.froms.join(", ") : "the other person");
const riskyMode = () => lastUnasked ?? !ASKING_MODES.includes(permissionMode);
// Auto runs only where the session asks before tools, or where the user said yes for this room.
const autoActive = () => !!room && room.mode === "auto" && !paused && (!riskyMode() || !!room.riskOk);
const livePeers = () => [...peers.entries()].filter(([, p]) => !p.left);
const fromPeerCall = (e) => (e.agentId ? peerAgents.includes(e.agentId) : !!peerTurn);
const busyWithPeer = () => !!(pendingPeer || peerTurn || expected.length);
const peerTurnFrom = (x, turnId) => ({ froms: x.froms, roomKey: x.roomKey, turnId, waitNoted: false, answers: (x.envs ?? []).map((m) => ({ from: m.from, id: m.id })), guard: x.guard ?? null });

function remember(entry) {
	history.push({ at: new Date().toISOString(), ...entry });
	if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
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
	if (typeof env.text === "string" && env.text.length > MAX_TEXT) throw new Error(`the message is ${env.text.length} characters and the limit is ${MAX_TEXT}: send the most important part, or split it`);
	if (bytes > MAX_BYTES) throw new Error(`the message is ${Math.round(bytes / 1000)} KB and the limit is ${MAX_BYTES / 1000} KB: send the most important part, or split it`);
	const res = await Promise.race([
		$.http.fetch(`${relay}/${topic}`, { method: "POST", body }),
		new Promise((_, reject) => {
			$.clock.after(15_000, () => reject(new Error("the relay didn't answer within 15 seconds")));
		}),
	]);
	if (!res.ok) {
		const hint =
			res.status === 429
				? " (rate limit: wait a minute)"
				: bytes > 4000 && (res.status === 400 || res.status === 413)
					? " (this relay doesn't take long messages — it may not store attachments; send it in parts under 3.8 KB)"
					: "";
		throw new Error(`the relay answered HTTP ${res.status}${hint}`);
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
	await $.store.set("turn:" + sessionId, {
		pendingPeer,
		expected,
		peerTurn,
		lastPeer,
		lastGuard,
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
				await queueLine($, r, gen, buf.slice(0, nl), true, floor);
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
				remember({ who: "", text: `a long message ${why} before it could be read`, note: true });
				$.ui.toast(`duet: a long message ${why} before it could be read`);
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

function onEnvelope($, r, env) {
	if (!isForMe(env, r.fromId, r.name)) return;
	const before = peers.get(env.from);
	const isNew = !before || before.left;
	peers.set(env.from, { via: env.via ?? before?.via ?? "", at: Date.now(), left: false });
	if (livePeers().length > 1 && !warnedAbout.has("crowd")) {
		warnedAbout.add("crowd");
		const text = `more than one other agent is in this room (${livePeers().map(([n]) => n).join(", ")}): duet is built for two, and a reply without "to" reaches everyone`;
		$.ui.log(text);
		$.ui.toast("duet: " + text);
	}
	if (env.kind === "join") {
		if (env.place && env.place === r.place && !warnedAbout.has("place:" + env.from)) {
			warnedAbout.add("place:" + env.from);
			const text = `${env.from} is in this room from this same folder (another window): two agents may edit the same files`;
			$.ui.log(text);
			$.ui.toast("duet: " + text);
		}
		if (isNew) {
			const via = viaLabel(env.via);
			$.ui.toast(`${env.from} joined${via ? " (" + via + ")" : ""}`);
			remember({ who: "", text: `${env.from} joined${via ? " (" + via + ")" : ""}`, note: true });
			// Answer once, so a newcomer learns who is here (older clients don't answer joins).
			void publish($, r.server, r.topic, envelope({ fromId: r.fromId, from: r.name, kind: "join", via: "claude-code", place: r.place })).catch(() => {});
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
		remember({ who: "", text, note: true });
		$.ui.log(text);
		$.ui.toast(text);
		redraw($);
		return;
	}
	// A reply to one of ours: say which one (the card, the history, and what Claude reads).
	env.reLine = env.re && sent.has(env.re) ? sent.get(env.re) : undefined; // ours only: a peer can't set it
	remember({ who: env.from + (env.by === "person" ? "" : "'s agent") + (env.reLine ? ` ↳ reply to “${env.reLine}”` : ""), text: env.text });
	if (queue.length >= QUEUE_MAX) {
		queue.shift();
		$.ui.toast(`duet: more than ${QUEUE_MAX} messages waiting — the oldest was dropped (it is in /duet)`);
	}
	queue.push(env);
	const now = Date.now();
	if (now - (lastToast.get(env.from) ?? 0) > TOAST_GAP_MS) $.ui.toast(`message from ${env.from}${env.by === "person" ? "" : "'s agent"}`);
	lastToast.set(env.from, now);
	void deliver($).catch(() => {});
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
	// Shift+Tab fires no hook: ask Claude Code itself whether commands now run without asking.
	const unasked = await runsUnasked($);
	if (!room || !queue.length || busyWithPeer()) return;
	if (unasked && !room.riskOk) return backToAsk($, "");
	if (!autoActive()) return;
	autoTurns++;
	await startPeerTurn($, queue.splice(0, BATCH_MAX), { auto: true, unaskedAtStart: unasked });
}

// Would a shell command nobody allowed run without asking the user right now? Claude Code tells a
// tool.call hook nothing about the permission mode, and switching it (Shift+Tab) fires no hook, but
// its own decision for a made-up command answers it: "allow" with no rule behind it is the mode
// (bypassPermissions). It runs nothing. undefined when Claude Code can't say.
async function runsUnasked($) {
	try {
		const r = await $.tool.check({ tool: "Bash", input: { command: "duet-permission-check" } });
		lastUnasked = r?.decision === "allow" && !r.rule;
		return lastUnasked;
	} catch {
		return undefined;
	}
}

// Commands run unasked now, and the user hasn't said yes to that for this room: back to cards.
async function backToAsk($, peer) {
	if (!room || room.mode !== "auto") return;
	room.mode = "ask";
	const active = await $.store.get("active:" + sessionId);
	if (active) await $.store.set("active:" + sessionId, { ...active, mode: "ask" });
	const text = `this session now runs commands without asking you${peer ? `, so ${peer}'s request was stopped there` : ""}: duet is back in ask mode. /duet auto turns auto on again (it asks you first)`;
	$.ui.log(text);
	$.ui.toast("duet: " + text);
	redraw($);
}

// guard: { auto, unaskedAtStart } — how it started, for checkPermissionMode.
async function startPeerTurn($, envs, guard) {
	pendingPeer = { envs, text: frameForClaude(envs, cwd, SEND_TOOL), roomKey: room?.key ?? "", submitted: false, guard };
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
	expected = [...expected, { text: p.text, froms, roomKey: p.roomKey, envs: p.envs, guard: p.guard, at: Date.now() }];
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
		$.ui.log(`the relay must be a plain http(s) URL like https://duet.gaioz.online, got ${sanitize(relayArg, 100)}`);
		return;
	}
	const relay = (relayArg || server).replace(/\/+$/, "");
	const name = fitName(nameArg || defaultName || "anon");
	const epoch = joinEpoch;
	if (room) {
		if (room.code === code && room.name === name && room.server === relay) return openPane($);
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
	if (held && quiet) return; // another window has it: a quiet rejoin leaves it there
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

	// No saved place in this room: listen from just before joining, so the others' answers to our
	// join (sent within a second or two) aren't missed while the stream is still opening.
	const saved = await $.store.get("cursor:" + key);
	const cursor = saved ?? { id: "", time: Math.floor(Date.now() / 1000) - 2 };
	const r = { code, name, key, fromId, topic, lockKey, server: relay, mode: mode === "auto" ? "auto" : "ask", cursor };
	try {
		// The first network request: if the relay can't be reached, or this session's policy refuses
		// network requests from mods, duet doesn't join.
		r.place = await placeFor(cwd, topic, host);
		await publish($, relay, topic, envelope({ fromId, from: name, kind: "join", via: "claude-code", place: r.place }));
	} catch (err) {
		const cur = await $.store.get(lockKey);
		if (cur?.token === token) await $.store.set(lockKey, { ...cur, released: true });
		$.ui.log(`couldn't reach the relay ${relay}: ${String(err?.message ?? err)}. Not joined.`);
		$.ui.toast("duet: couldn't reach the relay — not joined");
		return;
	}
	if (epoch !== joinEpoch) {
		// /duet off came while this join was on its way: don't join after all.
		const cur = await $.store.get(lockKey);
		if (cur?.token === token) await $.store.set(lockKey, { ...cur, released: true });
		return;
	}
	room = r;
	generation++;
	queue = [];
	peers.clear();
	history = [];
	autoTurns = 0;
	paused = false;
	heldCursor = null;
	countdown = null;
	await $.store.set("room:" + cwd, { code, name, relay, at: Date.now() });
	await $.store.set("name", name);
	await $.store.set("active:" + sessionId, { lockKey, token, code, name, mode: r.mode, relay });
	defaultName = name;
	heartbeat?.cancel?.();
	heartbeat = $.clock.every(2000, () => void beat($));
	wakeSupervisor?.();
	remember({ who: "", text: `you joined ${code} as ${name}`, note: true });
	// Who's in the room decides ask or auto: asked once per room, then remembered.
	let trust = await $.store.get("trust:" + key);
	if (!TRUST[trust]) trust = quiet ? "others" : await askTrust($, code);
	// A quiet (re)join never goes above the mode it was given: a restart comes back in ask.
	await applyTrust($, trust, quiet, quiet && mode !== "auto" ? "ask" : undefined);
	if (!quiet) $.ui.log(`joined room ${code} as ${name}. Give the other person this room code: ${code}`);
	redraw($);
}

// One question when joining a room for the first time. Anything but a clear answer means "someone else".
async function askTrust($, code) {
	const order = ["others", "trusted", "me"];
	let answer = "";
	try {
		answer = await $.ui.ask(
			`Who is in duet room ${code} with you? ` +
				order.map((t) => `${TRUST[t].label}: ${TRUST[t].says}.`).join(" ") +
				" Either way, Claude's file tools stay in this folder; shell commands can reach whatever your permission mode allows.",
			{ header: "duet", options: order.map((t) => TRUST[t].label + (t === "others" ? " (recommended)" : "")) },
		);
	} catch {}
	// Exactly one of the labels; anything typed under "Other" means someone else.
	return order.find((t) => answer === TRUST[t].label || answer === TRUST[t].label + " (recommended)") ?? "others";
}

async function applyTrust($, trust, quiet, capMode) {
	if (!room) return;
	room.trust = trust;
	await $.store.set("trust:" + room.key, trust);
	// "Only me" needs no extra check, but only when the user just said so, not on a quiet rejoin.
	room.riskOk = trust === "me" && !quiet;
	await setMode($, capMode ?? TRUST[trust].mode, quiet);
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
		await $.store.set("room:" + cwd, { code: r.code, name: r.name, relay: r.server, at: lastBeat });
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
	countdown?.timer?.cancel?.();
	countdown = null;
	heldCursor = null;
	if (!lost) {
		const cur = await $.store.get(r.lockKey);
		if (cur?.token === token) await $.store.set(r.lockKey, { ...cur, released: true });
	}
	await $.store.delete("active:" + sessionId);
	if (forget) await $.store.delete("room:" + cwd);
	redraw($);
}

async function setMode($, mode, quiet) {
	if (!room) {
		$.ui.log("not in a room: /duet new, or /duet <room code>");
		return;
	}
	if (mode === "auto") await runsUnasked($); // the mode may have changed since Claude Code last said
	if (mode === "auto" && riskyMode() && !room.riskOk) {
		const why =
			lastUnasked || permissionMode === "bypassPermissions"
				? "This session runs commands without asking you (bypassPermissions)"
				: permissionMode
					? `This session runs in ${permissionMode} mode`
					: "duet can't tell yet whether this session asks before running commands";
		let answer = "Keep ask";
		if (quiet) {
			// A quiet rejoin never asks: it waits as ask until the user confirms auto again.
			room.mode = "ask";
			$.ui.toast("duet: auto is waiting for you to confirm it — /duet auto");
			redraw($);
			return;
		}
		try {
			answer = await $.ui.ask(
				`${why}: in auto mode the other person's agent may be able to run commands on this computer without asking you. Turn auto on?`,
				["Turn auto on", "Keep ask"],
			);
		} catch {}
		if (answer !== "Turn auto on") {
			room.mode = "ask";
			redraw($);
			return;
		}
		room.riskOk = true;
	}
	countdown?.timer?.cancel?.();
	countdown = null;
	room.mode = mode;
	autoTurns = 0;
	paused = false;
	const active = await $.store.get("active:" + sessionId);
	if (active) await $.store.set("active:" + sessionId, { ...active, mode });
	if (!quiet) $.ui.log(mode === "auto" ? `auto: messages start a turn by themselves, up to ${MAX_AUTO} in a row without you` : "ask: each message waits above the prompt for you");
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

// One press, then a few seconds to take it back: a stray digit in an empty prompt is easy.
function choose($, action) {
	const envs = firstGroup();
	if (!envs.length || countdown) return;
	if (action === "take" && busyWithPeer()) {
		$.ui.toast("Claude is still on the last duet request — this one can start after it");
		return;
	}
	const timer = $.clock.after(UNDO_MS, () => void settle($).catch(() => {}));
	countdown = { action, envs, timer };
	redraw($);
}

function undo($) {
	countdown?.timer?.cancel?.();
	countdown = null;
	redraw($);
}

async function settle($) {
	const c = countdown;
	countdown = null;
	if (!c || !room) return redraw($);
	// Whether commands ask first right now, for the request's guard (asked before anything changes).
	const unasked = c.action === "take" ? await runsUnasked($) : undefined;
	if (!room) return redraw($);
	const envs = c.envs.filter((e) => queue.includes(e));
	if (!envs.length) return redraw($);
	if (c.action === "take" && busyWithPeer()) {
		$.ui.toast("Claude is still on the last duet request — this one can start after it");
		return redraw($);
	}
	queue = queue.filter((e) => !envs.includes(e));
	if (c.action === "take") {
		await startPeerTurn($, envs, { auto: false, unaskedAtStart: unasked });
	} else {
		sendNote($, "declined", c.envs[0].from);
		redraw($);
		await saveCursor($);
	}
}

async function openPane($) {
	await $.ui.open({ id: PANE, title: "duet", focus: true, closeOnEscape: true });
	redraw($);
}

// Back in the room after a restart, without asking: only if the window was in it when it closed,
// recently. /duet off forgets the room, so nothing comes back after leaving on purpose.
async function autoRejoin($) {
	if (room || !(await canDraw($))) return;
	const rec = await $.store.get("room:" + cwd);
	if (!rec?.code || Date.now() - (rec.at ?? 0) > REJOIN_MS) return;
	await join($, rec.code, rec.name, "ask", true, rec.relay);
	if (room) $.ui.toast(`duet: rejoined ${room.code} · /duet off to leave`);
}

// ---------- the send tool ----------

async function sendTool($, e) {
	if (!room) return { result: "Not sent: this session isn't in a duet room. Your user can join one with /duet." };
	const text = String(e.text ?? "").trim();
	if (!text) return { result: "Not sent: the message is empty." };
	// Too long to send: say so before asking the user about it.
	if (text.length > MAX_TEXT) return { result: `Not sent: the message is ${text.length} characters and the limit is ${MAX_TEXT}. Send the most important part, or split it.` };
	const to = typeof e.to === "string" && e.to.trim() ? e.to.trim() : undefined;
	const fromPeer = fromPeerCall(e);
	if (fromPeer && (!peerTurn || peerTurn.roomKey !== room.key)) {
		return { result: "Not sent: the request you're working on came from a room this window has left, or has ended. Tell your user instead." };
	}
	// In ask mode the user sees what leaves the computer during a peer's request.
	if (fromPeer && !autoActive()) {
		let answer = "Don't send";
		try {
			answer = await $.ui.ask(`duet: send this to ${to ?? peerNames()}? “${preview(text, 12, 160, "")}”`, ["Send", "Don't send"]);
		} catch {}
		if (answer !== "Send") return { result: "Not sent: your user chose not to send this. Don't send it again unless they ask." };
	}
	try {
		// Working on a peer's request: say which message this answers (the latest from that sender).
		const asked = fromPeer && peerTurn?.answers ? peerTurn.answers.filter((m) => !to || m.from === to).at(-1) : undefined;
		const env = envelope({ fromId: room.fromId, from: room.name, kind: "msg", text, by: "agent", ...(to ? { to } : {}), ...(asked ? { re: asked.id } : {}) });
		await publish($, room.server, room.topic, env);
		sent.set(env.id, firstLine(text));
		if (sent.size > 200) sent.delete(sent.keys().next().value);
	} catch (err) {
		return { result: "Not sent: " + String(err?.message ?? err) };
	}
	remember({ who: "your Claude → " + (to ?? (livePeers().map(([n]) => n).join(", ") || "the room")), text });
	redraw($);
	const long = byteLength(text) > 3800 ? " It went as one long message: the other side needs an up-to-date duet to read it." : "";
	return { result: `Sent to ${to ?? "the room"}.${long}` };
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
	if (!room) return null;
	if (countdown) {
		const c = countdown;
		const who = c.envs[0].from;
		return c.action === "take"
			? frame(`duet · starting ${who}'s request in ${UNDO_MS / 1000} s…`, [], [
					Button({ key: "undo", label: "Cancel", hotkey: "2", plain: true, onPress: () => undo($) }),
				])
			: frame(`duet · ignoring ${who}'s message in ${UNDO_MS / 1000} s…`, [], [
					Button({ key: "undo", label: "Undo", hotkey: "1", plain: true, onPress: () => undo($) }),
				]);
	}
	if (pendingPeer && !pendingPeer.submitted) {
		const p = pendingPeer;
		return frame(`duet · ${p.envs[0].from}'s request starts when Claude is free`, [], [
			Button({ key: "cancel-waiting", label: "Cancel", hotkey: "2", plain: true, onPress: () => void cancelWaiting($) }),
		]);
	}
	if (expected.length && !peerTurn) {
		return frame(`duet · ${expected[0].froms.join(", ")}'s request is with Claude Code, starting next`, [], []);
	}
	if (queue.length && autoActive()) {
		const froms = [...new Set(queue.map((x) => x.from))].join(", ");
		return frame(`duet · ${queue.length} message${queue.length > 1 ? "s" : ""} from ${froms} start${queue.length > 1 ? "" : "s"} when Claude is free (auto)`, [], []);
	}
	if (queue.length) {
		const group = firstGroup();
		const env = group[0];
		const who = env.by === "person" ? `${env.from} (in person)` : `${env.from}'s agent`;
		const via = viaLabel(peers.get(env.from)?.via);
		const count = group.length > 1 ? ` · ${group.length} messages` : "";
		const others = queue.length - group.length;
		const more = others > 0 ? `   +${others} more after` : "";
		const reply = (g) => (g.reLine ? [Text({ dimColor: true, children: [`↳ reply to your message “${sanitize(g.reLine, 100)}”`] })] : []);
		const body =
			group.length > 1
				? group.flatMap((g) => [...reply(g), Text({ children: ["• " + preview(g.text, 2, 150)] })])
				: [...reply(env), Text({ children: [preview(env.text)] })];
		return frame(`duet · from ${who}${via ? " (" + via + ")" : ""}${count} · ${timeOf(env.ts)}${more}${paused ? "   (auto paused)" : ""}`, body, [
			Button({ key: "take", label: "Let Claude do it", hotkey: "1", plain: true, onPress: () => choose($, "take") }),
			Button({ key: "ignore", label: "Ignore", hotkey: "2", plain: true, onPress: () => choose($, "ignore") }),
		]);
	}
	return null;
}

// Read-only: what was said in the room. People don't type here; their Claude does the talking.
function drawPane($, e) {
	const { Box, Text } = $.ui.resolve(e);
	const blank = Text({ children: [" "] });
	if (!room) {
		return Box({
			flexDirection: "column",
			children: [
				Text({ children: ["Not in a duet room."] }),
				Text({ dimColor: true, children: ["/duet new makes a room · /duet <room code> joins one"] }),
			],
		});
	}
	const ps = livePeers();
	const head = [
		Text({ bold: true, children: [`Room ${room.code}`] }),
		Text({
			dimColor: true,
			children: [
				`${ps.length ? "With " + ps.map(([n, p]) => n + (p.via ? ` (${viaLabel(p.via)})` : "")).join(", ") : "No one else seen yet"} · ` +
					`${TRUST[room.trust]?.label ?? "Someone else"} · ${room.mode}${paused ? " (paused)" : ""} · ` +
					`relay ${connected ? "connected" : connError ? "not connected: " + connError : "connecting…"}`,
			],
		}),
		Text({ dimColor: true, children: ["/duet off leaves · /duet trust changes who's in the room · Esc closes"] }),
	];
	const shown = history.slice(-40);
	const lines = shown.length
		? shown.map((h, i) =>
				h.note
					? Box({ key: "h" + i, children: [Text({ dimColor: true, children: [`${timeOf(h.at)}  ${sanitize(h.text, 300)}`] })] })
					: Box({
							key: "h" + i,
							flexDirection: "column",
							children: [Text({ bold: true, children: [`${timeOf(h.at)}  ${h.who}`] }), Text({ children: [sanitize(h.text, 1500)] })],
						}),
			)
		: [Text({ dimColor: true, children: ["Nothing said yet."] })];
	return Box({ flexDirection: "column", children: [...head, blank, ...lines] });
}

function modeLabel() {
	if (!room) return "";
	const ps = livePeers().map(([n]) => n);
	const who = ps.length ? ps.join(", ") : "no one seen yet";
	const link = connected ? "" : " · offline";
	const waiting = queue.length && (peerTurn || pendingPeer || expected.length) ? ` · ${queue.length} waiting` : "";
	return `duet ${room.code} · ${who} · ${room.mode}${paused ? " (paused)" : ""}${waiting}${link}`;
}

// A peer's request that started where commands asked first (or started by auto mode) may not go on
// once they run unasked (Shift+Tab to bypass mid-request), unless the user said yes to that for this
// room. Checked on each of its tool calls, since no hook fires when the mode changes.
async function checkPermissionMode($) {
	const g = peerTurn?.guard ?? lastGuard;
	if (!g || (!g.auto && g.unaskedAtStart !== false)) return null;
	if (room?.riskOk || (await runsUnasked($)) !== true) return null;
	const peer = peerNames();
	if (peerTurn && !peerTurn.modeNoted) {
		peerTurn.modeNoted = true;
		if (room?.mode !== "auto") $.ui.toast(`duet: commands now run without asking you, so ${peer}'s request was stopped there`);
	}
	await backToAsk($, peer);
	const how = g.auto ? "switch the mode back (Shift+Tab), or say yes to it with /duet auto" : "switch the mode back (Shift+Tab) and ask you to go on";
	return `duet: this session's permission mode changed while you worked on ${peer}'s request, and commands would now run without your user being asked, so this call was not run. Stop working on this request and tell your user; they can ${how}.`;
}

// No turn of this process or conversation is running: forget what a crashed or other one left.
async function clearTurn($) {
	if (!sessionId) sessionId = await $.session.id();
	pendingPeer = null;
	expected = [];
	peerTurn = null;
	lastPeer = null;
	lastGuard = null;
	runningTurn = "";
	peerAgents = [];
	await $.store.delete("turn:" + sessionId);
	redraw($);
}

function notePermissionMode(e) {
	if (typeof e.permission_mode !== "string" || !e.permission_mode) return;
	if (e.permission_mode !== permissionMode) lastUnasked = undefined; // the mode says more until the next check
	permissionMode = e.permission_mode;
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
		// After a module reload in this same process, the request in progress stays fenced: its turn,
		// a frame Claude Code has queued, its subagents. A variable in Claude Code's own environment
		// tells a reload (it's set) from a new process (it isn't), whatever order the events come in.
		const sameProcess = !!(await $.env.get("DUET_PROCESS"));
		if (!sameProcess) await $.env.set("DUET_PROCESS", randomId());
		const turn = sameProcess ? await $.store.get("turn:" + sessionId) : null;
		if (!sameProcess) await $.store.delete("turn:" + sessionId);
		if (turn && Date.now() - (turn.at ?? 0) < 6 * 3600_000) {
			pendingPeer = turn.pendingPeer ?? null;
			expected = Array.isArray(turn.expected) ? turn.expected : [];
			peerTurn = turn.peerTurn ?? null;
			lastPeer = turn.lastPeer ?? null;
			lastGuard = turn.lastGuard ?? null;
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
				void autoRejoin($);
			}
		}
		try {
			await $.tool.register({
				name: "send",
				description:
					"Send a message to the other agent(s) in your duet room (another developer's coding agent on their computer). " +
					"Use it to answer a duet request, or when your user asks you to tell the other side something. " +
					"Your text replies are seen only by your own user; this tool is the only way to reach the other side. " +
					"Send one complete reply when you're done, not progress updates or several small messages; split only if it is over ~3.5 KB.",
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
			await $.command.register({ name: "duet", description: "Pair with another developer's agent: /duet new, /duet <room>, /duet off", argumentHint: "[new | <room> [name] [relay] | off | trust | ask | auto | status]", immediate: true });
		} catch {}
		return next(e);
	});

	// The Desktop app may attach after the session started: rejoin then.
	on("session.attach", async ($, e, next) => {
		const result = await next(e);
		void autoRejoin($);
		return result;
	});

	on("classic.SessionStart", { source: "startup" }, async ($, e, next) => {
		notePermissionMode(e);
		return next(e);
	});

	on("classic.SessionStart", { source: ["clear", "resume", "fork"] }, async ($, e, next) => {
		notePermissionMode(e);
		// /resume and /branch (a fork) continue another conversation: no turn of this one runs there.
		if (e.source === "resume" || e.source === "fork") await clearTurn($);
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
		if (!first) void openPane($);
		else if (arg === "new") void join($, newRoomCode(), second, "ask");
		else if (LEAVE_WORDS.includes(arg)) {
			joinEpoch++;
			if (room) void leave($, "left", true);
			else {
				await $.store.delete("room:" + cwd);
				$.ui.log("not in a room");
			}
		} else if (arg === "trust") {
			if (room) void askTrust($, room.code).then((t) => applyTrust($, t));
			else $.ui.log("not in a room");
		} else if (arg === "ask" || arg === "auto") void setMode($, arg);
		else if (arg === "status") $.ui.log(room ? `${modeLabel()} · you are ${room.name}` : "not in a room");
		else if (isRoomCode(first)) void join($, first, second, "ask", false, third);
		else $.ui.log("usage: /duet new · /duet <room code> [your name] [relay URL] · /duet off · /duet trust · /duet ask|auto · /duet (the room's history)");
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
			const modeReason = await checkPermissionMode($);
			if (modeReason) return { deny: modeReason };
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
		// Claude Code's own stamp: Enter at the prompt, or Remote Control. Its turn starts before the
		// submission resolves here (observed in 2.1.289), so turn.start must know of it already.
		const kind = e.origin?.kind;
		const mine = kind === "composer" || kind === "bridge";
		if (mine) userPromptsOpen++;
		let result;
		try {
			result = await next(e);
		} finally {
			if (mine) userPromptsOpen--;
		}
		if (!result?.drop && mine) {
			lastPeer = null;
			userPromptSince = true;
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
			peerTurn = peerTurnFrom(x, e.turnId);
			lastPeer = null;
		} else if (expected.length && !userPromptSince) {
			// duet's request is pending and no prompt of the user's explains this turn: its text may
			// have been changed on the way. Fence it rather than risk running the request unfenced.
			const x = expected[0];
			peerTurn = peerTurnFrom(x, e.turnId);
			lastPeer = null;
			$.ui.log("a turn started while duet's request was pending and its text didn't match: treating it as the other side's", { to: "debug" });
		} else if (userPromptsOpen) {
			// The user's own prompt, on its way in: theirs, and the end of any fence after a peer turn.
			lastPeer = null;
		} else if (lastPeer) {
			// Any turn after the peer's, before the user's own prompt, is still the peer's: a hook that
			// woke Claude, a continuation, a task notification. Fail closed; the user's prompt ends it.
			peerTurn = { ...lastPeer, turnId: e.turnId, waitNoted: false };
			$.ui.log("a turn started after the other side's request, before your own prompt: still fenced as theirs", { to: "debug" });
		}
		if (peerTurn?.turnId === e.turnId && peerTurn.guard) lastGuard = peerTurn.guard;
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
			// Stopped (Esc), or the user typed during it: what comes next is the user's.
			lastPeer = e.isAborted || userPromptSince ? null : { froms: t.froms, roomKey: t.roomKey, guard: t.guard ?? null };
			if (e.isAborted) for (const p of t.froms) sendNote($, "stopped", p);
			else if (e.reason === "error" || e.reason === "refusal") for (const p of t.froms) sendNote($, "failed", p);
			redraw($);
		}
		if (!e.agentId) await saveTurn($);
		const result = await next(e);
		void submitWhenIdle($);
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

	// classic.PreToolUse carries no permission_mode (2.1.289); PostToolUse does.
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
		if (!peerTurn) return next(e);
		return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix ?? ""} · for ${peerNames()}` } });
	});
}
