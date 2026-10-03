// duet for Claude Code, as a mod: pair this session with another developer's coding agent (pi,
// Claude Code or Codex) through a shared room on an ntfy relay.
//
//   /duet new            make a room and join it        /duet <room> [name]   join a room
//   /duet                open the duet pane              /duet ask | auto      how messages are handled
//   /duet leave          leave the room                  /duet status          one line of status
//
// Receiving: `$.process.spawn` runs curl against the relay's JSON stream (mods have no streaming
// network API; Node isn't guaranteed). Sending: `$.http.fetch` POST — which also means a session
// whose policy refuses mod network requests never joins (curl is never used to go around it).
// Delivery: in "ask" mode each message waits as a card above the prompt; in "auto" mode it starts a
// turn by itself, up to MAX_AUTO turns without the user. Claude reads it under the engine's own
// "The duet plugin sent a message" line. While Claude works on a peer's request, guard.js decides
// which tool calls go ahead.
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
const VIA = { pi: "pi", "claude-code": "Claude Code", codex: "Codex" };

// ---------- state (module variables; the room is also kept in $.store across restarts) ----------

let token = randomId(); // this window; adopted from $.store after a module reload
let installId = "";
let sessionId = "";
let cwd = "";
let home = "";
let server = DEFAULT_SERVER;
let interactive = false; // a terminal or Desktop session that draws
let defaultName = "";
let permissionMode = "";
let bypassOk = false; // the user confirmed auto mode under bypassPermissions
let oldMcp = false; // the old MCP-server setup of duet is active in this session too

let room = null; // { code, name, key, fromId, topic, lockKey, mode, cursor }
let generation = 0; // bumped on every join and leave; loops of an older room stop
let wakeSupervisor = null;
let child = null; // the running curl stream
let connected = false;
let connError = "";
let heartbeat = null;
let heldCursor = null; // the resume point, saved once nothing received is still waiting
const seen = new Set();
const peers = new Map(); // name -> { via, at, left }

let queue = []; // messages waiting for the user (ask) or for Claude to be free (auto)
let armed = ""; // the card whose "1" was pressed once
let noReply = null; // { peers, answer }: a peer turn ended without a reply
let rejoinOffer = null; // { code, name, mode }
let pendingPeer = null; // { envs, auto }: handed to $.prompt.submit, turn not started yet
let userSubmitted = false; // the user's own prompt since the last turn.start
let peerTurn = null; // { froms, attempted (a send was tried), waitNoted }
const peerAgents = new Set(); // subagents started from a peer turn (they may outlive it)
let autoTurns = 0;
let paused = false;

let history = []; // { at, who, text, out }
let paneTab = "room";
let replyTo = "";

const viaLabel = (via) => VIA[via] ?? "";
const peerNames = () => (peerTurn ? peerTurn.froms.join(", ") : "the other person");
const autoActive = () => !!room && room.mode === "auto" && !paused && (permissionMode !== "bypassPermissions" || bypassOk);
const livePeers = () => [...peers.entries()].filter(([, p]) => !p.left);

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

async function publish($, topic, env) {
	const body = JSON.stringify(env);
	const bytes = byteLength(body);
	if (bytes > MAX_BYTES) throw new Error(`the message is ${bytes} bytes and the limit is ${MAX_BYTES}: split it into several sends`);
	const res = await Promise.race([
		$.http.fetch(`${server}/${topic}`, { method: "POST", body }),
		new Promise((_, reject) => {
			$.clock.after(15_000, () => reject(new Error("the relay didn't answer within 15 seconds")));
		}),
	]);
	if (!res.ok) throw new Error(`the relay answered HTTP ${res.status}${res.status === 429 ? " (rate limit: wait a minute)" : ""}`);
}

function sendNote($, note, to) {
	if (!room) return;
	const env = envelope({ fromId: room.fromId, from: room.name, kind: "note", note, ...(to ? { to } : {}) });
	void publish($, room.topic, env).catch(() => {});
}

async function consumed($) {
	if (!room || !heldCursor || queue.length || pendingPeer) return;
	const cursor = heldCursor;
	heldCursor = null;
	await $.store.set("cursor:" + room.key, cursor);
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
	const q = floor ? `?since=${encodeURIComponent(floor.id)}` : "";
	let buf = "";
	let repair = null;
	try {
		// The URL holds the topic, which is the room's secret: pass it on stdin, not in argv (ps).
		const stream = $.process.spawn({
			argv: ["curl", "-sSN", "--speed-limit", "1", "--speed-time", "90", "-K", "-"],
			input: `url = "${server}/${r.topic}/json${q}"\n`,
		});
		child = stream;
		if (floor) repair = $.clock.after(REPAIR_POLL_MS, () => void repairPoll($, r, gen, floor));
		for await (const piece of stream) {
			if (gen !== generation) break;
			if (piece.stream === "stderr") {
				connError = sanitize(piece.text, 200).trim();
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
		const res = await $.http.fetch(`${server}/${r.topic}/json?poll=1&since=${encodeURIComponent(floor.id)}`);
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
	if (floor && (evt.id === floor.id || evt.time < floor.time)) return;
	seen.add(evt.id);
	if (seen.size > 1000) seen.delete(seen.values().next().value);
	let env = null;
	try {
		env = JSON.parse(evt.message);
	} catch {}
	if (isEnvelope(env)) onEnvelope($, r, env);
	if (live) {
		r.cursor = { id: evt.id, time: evt.time };
		heldCursor = r.cursor;
		await consumed($);
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
			// Answer once, so a newcomer learns who is here (old clients don't answer joins).
			void publish($, r.topic, envelope({ fromId: r.fromId, from: r.name, kind: "join", via: "claude-code" })).catch(() => {});
		}
		redraw($);
		return;
	}
	if (env.kind === "note") {
		const text = {
			declined: `${env.from} didn't take your last message`,
			stopped: `${env.from} stopped Claude working on your request`,
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
	queue.push(env);
	$.ui.toast(`message from ${env.from}${env.by === "person" ? "" : "'s agent"}`);
	void deliver($);
	redraw($);
}

// ---------- delivery ----------

async function deliver($) {
	if (!room || !queue.length || pendingPeer || peerTurn || !interactive || room.mode !== "auto") return;
	if (!autoActive()) return; // paused, or bypassPermissions not confirmed: the cards ask instead
	if (autoTurns >= MAX_AUTO) {
		paused = true;
		$.ui.toast(`duet: ${MAX_AUTO} requests ran without you — the rest wait for you above the prompt`);
		redraw($);
		return;
	}
	autoTurns++;
	await startPeerTurn($, queue.splice(0), true);
}

async function startPeerTurn($, envs, auto) {
	pendingPeer = { envs, auto };
	noReply = null;
	redraw($);
	try {
		// Resolves when the turn starts (after Claude finishes what it is doing); never `asUser`.
		await $.prompt.submit({ text: frameForClaude(envs, cwd, SEND_TOOL) });
	} catch (err) {
		pendingPeer = null;
		queue.unshift(...envs);
		$.ui.toast("duet couldn't start a turn: " + String(err?.message ?? err));
		redraw($);
	}
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

async function join($, code, nameArg, mode, quiet, relay) {
	if (!isRoomCode(code)) {
		$.ui.log("a room code is 3–64 letters, digits, - or _ — or use /duet new");
		return;
	}
	if (isPlaceholderName(nameArg)) {
		$.ui.log(`"${nameArg}" is the placeholder: use your own name, as in /duet ${code} karlo`);
		return;
	}
	if (relay && !isRelayUrl(relay)) {
		$.ui.log(`the relay must be a plain http(s) URL like https://ntfy.sh, got ${sanitize(relay, 100)}`);
		return;
	}
	const name = fitName(nameArg || defaultName || "anon");
	if (room) {
		if (room.code === code && room.name === name) return openPane($, "room");
		await leave($, "left", false);
	}
	if (oldMcp) {
		$.ui.log("the older duet setup (an MCP server named duet) is also active here, so every message would arrive twice. In your shell run: npx -y github:qaioz/pi-duet setup claude --off");
	}
	if (relay) server = relay.replace(/\/+$/, "");
	const key = `${server} ${code} ${name}`;
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
		for (let i = 0; i < 20; i++) {
			await wait($, 500);
			const cur = await $.store.get(lockKey);
			if (!cur || cur.released) break;
		}
		await $.store.set(lockKey, { token, cwd, at: Date.now(), released: false });
	}

	const r = { code, name, key, fromId, topic, lockKey, mode: mode === "auto" ? "auto" : "ask", cursor: (await $.store.get("cursor:" + key)) ?? undefined };
	try {
		// The first network request: if the relay can't be reached, or this session's policy refuses
		// network requests from mods, duet doesn't join.
		await publish($, topic, envelope({ fromId, from: name, kind: "join", via: "claude-code" }));
	} catch (err) {
		await $.store.set(lockKey, { token, cwd, at: 0, released: true });
		const why = String(err?.message ?? err);
		$.ui.log(`couldn't reach the relay ${server}: ${why}. Not joined.`);
		$.ui.toast("duet: couldn't reach the relay — not joined");
		return;
	}
	if (r.mode === "auto" && permissionMode === "bypassPermissions" && !bypassOk) r.mode = "ask";
	room = r;
	generation++;
	queue = [];
	peers.clear();
	history = [];
	autoTurns = 0;
	paused = false;
	rejoinOffer = null;
	await $.store.set("room:" + cwd, { code, name, mode: r.mode, relay: server });
	await $.store.set("name", name);
	await $.store.set("active:" + sessionId, { lockKey, token, code, name, mode: r.mode, relay: server });
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
		await leave($, null, false);
		$.ui.log(`room ${r.code} moved to another window (${cur.cwd})`);
		$.ui.toast("duet: the room moved to another window");
		return;
	}
	if (cur?.release && cur.release !== token) {
		await $.store.set(r.lockKey, { ...cur, released: true });
		await leave($, "moved", false);
		$.ui.log(`handed room ${r.code} to another window`);
		return;
	}
	if (Date.now() - lastBeat > 20_000) {
		lastBeat = Date.now();
		await $.store.set(r.lockKey, { token, cwd, at: lastBeat, released: false });
	}
}

async function leave($, note, forget) {
	if (!room) return;
	const r = room;
	if (note) sendNote($, note);
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
	if (heldCursor) await $.store.set("cursor:" + r.key, heldCursor);
	heldCursor = null;
	const cur = await $.store.get(r.lockKey);
	if (cur?.token === token) await $.store.set(r.lockKey, { ...cur, released: true });
	await $.store.delete("active:" + sessionId);
	if (forget) await $.store.delete("room:" + cwd);
	redraw($);
}

async function setMode($, mode) {
	if (!room) {
		$.ui.log("not in a room: /duet new, or /duet <room code>");
		return;
	}
	if (mode === "auto" && permissionMode === "bypassPermissions" && !bypassOk) {
		let answer = "Keep ask";
		try {
			answer = await $.ui.ask(
				"This session runs with bypassPermissions: in auto mode the other person's agent can run any command on this computer without asking you. Turn auto on?",
				["Turn auto on", "Keep ask"],
			);
		} catch {}
		if (answer !== "Turn auto on") return;
		bypassOk = true;
	}
	room.mode = mode;
	autoTurns = 0;
	paused = false;
	await $.store.set("room:" + cwd, { code: room.code, name: room.name, mode, relay: server });
	$.ui.log(mode === "auto" ? `auto: messages start a turn by themselves, up to ${MAX_AUTO} in a row without you` : "ask: each message waits above the prompt for you");
	redraw($);
	void deliver($);
}

// ---------- what the user does with a card ----------

async function take($, env) {
	if (pendingPeer || peerTurn) {
		$.ui.toast("Claude is still on the last duet request — this one can start after it");
		return;
	}
	if (armed !== env.id) {
		armed = env.id;
		redraw($);
		return;
	}
	armed = "";
	queue = queue.filter((e) => e !== env);
	await startPeerTurn($, [env], false);
}

async function putInPrompt($, env) {
	const who = env.by === "person" ? env.from : `${env.from}'s agent`;
	const r = await $.prompt.suggest({ text: `${who} asks (via duet): "${sanitize(env.text, 4000)}"` });
	if (!r?.isShown) {
		$.ui.toast("Empty the prompt box first, then press 2 again");
		return;
	}
	queue = queue.filter((e) => e !== env);
	armed = "";
	redraw($);
	await consumed($);
}

async function replyMyself($, env) {
	queue = queue.filter((e) => e !== env);
	armed = "";
	replyTo = env.from;
	await consumed($);
	await openPane($, "talk");
}

async function ignore($, env) {
	queue = queue.filter((e) => e !== env);
	armed = "";
	sendNote($, "declined", env.from);
	redraw($);
	await consumed($);
}

async function sendAnswer($) {
	const offer = noReply;
	noReply = null;
	redraw($);
	if (!offer || !room || !offer.answer.trim()) return;
	try {
		for (const to of offer.peers) {
			await publish($, room.topic, envelope({ fromId: room.fromId, from: room.name, kind: "msg", text: offer.answer, by: "agent", to }));
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
		await publish($, room.topic, envelope({ fromId: room.fromId, from: room.name, kind: "msg", text: text.trim(), by: "person", ...(to ? { to } : {}) }));
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

// ---------- the send tool ----------

async function sendTool($, e) {
	if (!room) return { result: "Not sent: this session isn't in a duet room. Your user can join one with /duet." };
	const text = String(e.text ?? "").trim();
	if (!text) return { result: "Not sent: the message is empty." };
	const to = typeof e.to === "string" && e.to.trim() ? e.to.trim() : undefined;
	const fromPeer = e.agentId ? peerAgents.has(e.agentId) : !!peerTurn;
	// In ask mode the user sees what leaves the computer during a peer's request.
	if (peerTurn && fromPeer) peerTurn.attempted = true;
	if (fromPeer && !autoActive()) {
		let answer = "Don't send";
		try {
			answer = await $.ui.ask(`duet: send this to ${to ?? peerNames()}? “${preview(text, 12, 160, "")}”`, ["Send", "Don't send"]);
		} catch {}
		if (answer !== "Send") return { result: "Not sent: your user chose not to send this. Don't send it again unless they ask." };
	}
	try {
		await publish($, room.topic, envelope({ fromId: room.fromId, from: room.name, kind: "msg", text, by: "agent", ...(to ? { to } : {}) }));
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
	if (rejoinOffer && !room) {
		const o = rejoinOffer;
		return frame(`duet · rejoin ${o.code} as ${o.name}?`, [], [
			Button({ key: "rejoin-yes", label: "Rejoin", hotkey: "1", plain: true, onPress: () => void join($, o.code, o.name, o.mode, false, o.relay) }),
			Button({ key: "rejoin-no", label: "Not now", hotkey: "2", plain: true, onPress: () => { rejoinOffer = null; redraw($); } }),
		]);
	}
	if (!room) return null;
	if (pendingPeer) {
		return frame(`duet · ${pendingPeer.envs.map((x) => x.from).join(", ")}'s request starts when Claude is free`, [], []);
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
			Button({ key: "take", label: armed === env.id ? "Press 1 again to let Claude do it" : "Let Claude do it", hotkey: "1", plain: true, onPress: () => void take($, env) }),
			Button({ key: "suggest", label: "Put it in my prompt", hotkey: "2", plain: true, onPress: () => void putInPrompt($, env) }),
			Button({ key: "reply", label: "Reply myself", hotkey: "3", plain: true, onPress: () => void replyMyself($, env) }),
			Button({ key: "ignore", label: "Ignore", hotkey: "4", plain: true, onPress: () => void ignore($, env) }),
		]);
	}
	if (noReply) {
		return frame(`duet · Claude finished ${noReply.peers.join(", ")}'s request without replying`, [Text({ dimColor: true, children: [preview(noReply.answer, 2, 140)] })], [
			Button({ key: "send-answer", label: "Send its answer", hotkey: "1", plain: true, onPress: () => void sendAnswer($) }),
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
				? Input({ key: "say", label: `You → ${replyTo || "everyone"}`, placeholder: "type to the other person directly (Claude doesn't see this)", value: "", submitLabel: "send", autoFocus: true, onSubmit: (v) => void sayDirect($, v) })
				: Text({ dimColor: true, children: ["Join a room first."] }),
		];
	} else if (!room) {
		body = [
			Text({ children: ["Pair this Claude Code with another developer's agent (pi, Claude Code or Codex)."] }),
			blank,
			Input({ key: "name", label: "Your name", placeholder: "letters, digits, . _ -", value: defaultName, submitLabel: "save", onSubmit: (v) => { if (v.trim()) defaultName = fitName(v.trim()); redraw($); } }),
			Input({ key: "code", label: "Room code", placeholder: "paste the code you were given", value: "", submitLabel: "join", autoFocus: true, onSubmit: (v) => void join($, v.trim(), defaultName) }),
			Button({ key: "new", label: "New room (makes a code to share)", onPress: () => void join($, newRoomCode(), defaultName) }),
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
			Text({ children: [ps.length ? "Here: " + ps.map(([n, p]) => n + (p.via ? ` (${viaLabel(p.via)})` : "")).join(", ") : "No one else seen yet."] }),
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

// ---------- hooks ----------

export function register(on) {
	on("session.start", async ($, e, next) => {
		cwd = e.cwd || (await $.session.cwd());
		interactive = !!e.isInteractive && (e.surface === "terminal" || e.surface === "desktop");
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
		try {
			const settings = await $.settings.read();
			permissionMode = settings?.permissions?.defaultMode ?? "";
		} catch {}
		void supervise($);
		if (interactive) {
			// After a module reload this window was in a room: take it up again, silently.
			const active = await $.store.get("active:" + sessionId);
			const owner = active ? await $.store.get(active.lockKey) : null;
			if (active && owner?.token === active.token && !owner.released) {
				token = active.token;
				void join($, active.code, active.name, active.mode, true, active.relay);
			} else {
				rejoinOffer = (await $.store.get("room:" + cwd)) ?? null;
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

	on("classic.SessionStart", { source: ["clear", "resume", "fork"] }, async ($, e, next) => {
		// /clear and friends may give the session a new id; the room stays with this window.
		const old = sessionId;
		sessionId = await $.session.id();
		if (room && old !== sessionId) {
			await $.store.delete("active:" + old);
			await $.store.set("active:" + sessionId, { lockKey: room.lockKey, token, code: room.code, name: room.name, mode: room.mode, relay: server });
		}
		pendingPeer = null;
		peerTurn = null;
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
			void publish($, r.topic, envelope({ fromId: r.fromId, from: r.name, kind: "note", note: "left" })).catch(() => {});
			void $.store.set(r.lockKey, { token, cwd, at: 0, released: true });
			void $.store.delete("active:" + sessionId);
		}
		return next(e);
	});

	on("command.run", { command: "duet" }, async ($, e) => {
		if (!interactive) {
			$.ui.log("duet needs the Claude Code terminal or the Desktop app's Code tab.");
			return {};
		}
		const [first = "", second, third] = String(e.args ?? "").trim().split(/\s+/);
		const arg = first.toLowerCase();
		if (!first) await openPane($, room ? "talk" : "room");
		else if (arg === "new") await join($, newRoomCode(), second);
		else if (arg === "leave") {
			if (room) await leave($, "left", true);
			else $.ui.log("not in a room");
		} else if (arg === "ask" || arg === "auto") await setMode($, arg);
		else if (arg === "status") $.ui.log(room ? `${modeLabel()} · you are ${room.name}` : "not in a room");
		else if (isRoomCode(first)) await join($, first, second, "ask", false, third);
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
		const fromPeer = e.agentId ? peerAgents.has(e.agentId) : !!peerTurn;
		if (fromPeer) {
			const reason = checkPeerTool(e, { cwd, home, peer: peerNames(), sendTool: SEND_TOOL });
			if (reason) return { deny: reason };
		}
		return next(e);
	});

	on("agent.spawn", async ($, e, next) => {
		const fromPeer = e.parentAgentId ? peerAgents.has(e.parentAgentId) : !!peerTurn;
		const result = await next(e);
		if (fromPeer && result?.agentId) peerAgents.add(result.agentId);
		return result;
	});

	on("prompt.submit", async ($, e, next) => {
		const kind = e.origin?.kind;
		// The engine's own stamp: Enter at the prompt, or Remote Control. A prompt typed into a running
		// turn (turnId set) joins that turn and doesn't decide who starts the next one.
		if ((kind === "composer" || kind === "bridge") && !e.turnId) {
			userSubmitted = true;
			autoTurns = 0;
			if (paused) {
				paused = false;
				redraw($);
			}
		}
		return next(e);
	});

	on("turn.start", async ($, e, next) => {
		if (!e.agentId) {
			if (pendingPeer && !userSubmitted) {
				peerTurn = { froms: [...new Set(pendingPeer.envs.map((x) => x.from))], attempted: false, waitNoted: false };
				pendingPeer = null;
				redraw($);
				await consumed($);
			}
			userSubmitted = false;
		}
		return next(e);
	});

	on("turn.complete", async ($, e, next) => {
		if (!e.agentId && peerTurn) {
			const t = peerTurn;
			peerTurn = null;
			if (e.isAborted || e.reason === "error" || e.reason === "refusal") {
				for (const p of t.froms) sendNote($, "stopped", p);
			} else if (!t.attempted && room && String(e.answer ?? "").trim()) {
				noReply = { peers: t.froms, answer: String(e.answer ?? "") };
			}
			redraw($);
		}
		const result = await next(e);
		void deliver($);
		return result;
	});

	on("classic.PermissionRequest", async ($, e, next) => {
		if (e.permission_mode) permissionMode = e.permission_mode;
		if (peerTurn && !peerTurn.waitNoted) {
			peerTurn.waitNoted = true;
			for (const p of peerTurn.froms) sendNote($, "approval-wait", p);
		}
		return next(e);
	});

	on("classic.PreToolUse", async ($, e, next) => {
		if (e.permission_mode) permissionMode = e.permission_mode;
		return next(e);
	});

	on("classic.UserPromptSubmit", async ($, e, next) => {
		if (e.permission_mode) permissionMode = e.permission_mode;
		return next(e);
	});

	on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
		const card = drawCard($, e);
		return card ?? next(e);
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
