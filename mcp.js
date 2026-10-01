#!/usr/bin/env node
// duet MCP server: puts Claude Code, Codex or any other MCP host in a duet room, next to pi agents.
// Plain JavaScript with no dependencies: npx runs it straight from GitHub, and Node won't strip
// TypeScript inside node_modules. Speaks MCP over stdio (newline-delimited JSON-RPC).
//
//   npx -y github:qaioz/pi-duet --room <room> --name <name> [--server <url>]
//   npx -y github:qaioz/pi-duet setup codex --room <room> --name <name>   (see setup.js)
//
// How a message reaches the model, by host:
//   Claude Code: duet_wait blocks until a message comes. Claude Code moves a call that runs over
//                ~2 minutes to the background and wakes the session when it returns.
//   Codex:       the server runs `codex queue`, which starts a turn in the open session.
//   any host:    duet_inbox, when the user says "check duet".
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envelope, isForMe, isName, isRelayUrl, publish, subscribe, topicFor } from "./transport.js";

if (process.argv[2] === "setup") {
	await import("./setup.js");
	process.exit(0);
}

const VERSION = "0.2.0";

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const m = argv[i].match(/^--([a-z-]+)(?:=(.*))?$/);
		if (m) out[m[1]] = m[2] ?? argv[++i];
	}
	return out;
}
const args = parseArgs(process.argv.slice(2));
const room = args.room || process.env.DUET_ROOM;
const name = args.name || process.env.DUET_NAME;
const server = (args.server || process.env.DUET_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
if (!isRelayUrl(server)) {
	console.error(`duet: --server must be an http(s) URL like https://ntfy.sh, got ${JSON.stringify(server)}`);
	process.exit(1);
}
// Peers drop messages from names outside the rule, so never send under one.
if (name !== undefined && !isName(name)) {
	console.error(`duet: --name may only use letters, digits, . _ - (at most 40), got ${JSON.stringify(name)}`);
	process.exit(1);
}
// Unattended back-and-forth allowed before the agent must check with its user.
const MAX_AUTO = Math.max(1, Number(process.env.DUET_MAX_AUTO) || 8);
// A short wait must return inside the host's tool timeout; the site sets Codex's to 120s.
const WAIT_MAX = Math.max(1, Number(process.env.DUET_WAIT_MAX) || 50);
// Claude Code backgrounds long calls, so there duet_wait can listen for long. Its stdio idle timeout
// (30 min) is reset by progress notifications.
const LISTEN_MAX = Math.max(1, Number(process.env.DUET_LISTEN_MAX) || 3600);
const PROGRESS_MS = Number(process.env.DUET_PROGRESS_MS) || 5 * 60_000;
const CODEX = process.env.DUET_CODEX_BIN || "codex";
// After a send in Claude Code, a reply that comes back within seconds would reach the session while
// its turn is still ending, and get lost there. Hold it this long so it starts a turn of its own.
const SETTLE_MS = Number(process.env.DUET_SETTLE_MS ?? 20_000);
const INBOX_MAX = 200;
const WINDOWS = (process.env.DUET_TEST_PLATFORM || process.platform) === "win32"; // overridable for tests

// ---------- state on disk: ~/.duet ----------

const home = process.env.DUET_HOME || join(homedir(), ".duet");
const file = (f) => join(home, f);
mkdirSync(home, { recursive: true });

function readJson(f, fallback) {
	try {
		return JSON.parse(readFileSync(file(f), "utf8"));
	} catch {
		return fallback; // missing or corrupt: start fresh
	}
}
function writeJson(f, value) {
	const tmp = file(`${f}.${process.pid}`);
	writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
	renameSync(tmp, file(f)); // a concurrent reader never sees half a file
}

let installId = readJson("install.json", {}).id;
if (!installId) writeJson("install.json", { id: (installId = randomUUID()) });
// Stable across restarts (so our own echoes are recognised after a catch-up), and distinct per
// room and name, so two hosts on one computer in the same room don't drop each other's messages.
const key = `${server} ${room} ${name}`;
const fromId = createHash("sha256").update(`${installId} ${key}`).digest("hex").slice(0, 32);
const lockFile = file(`${createHash("sha256").update(key).digest("hex").slice(0, 16)}.lock`);

const loadCursor = () => readJson("cursors.json", {})[key];
function saveCursor(cursor) {
	try {
		const all = readJson("cursors.json", {});
		all[key] = cursor;
		writeJson("cursors.json", all);
	} catch (err) {
		status = `connected; can't save the resume point: ${err.message}`; // a restart may repeat messages
	}
}

// One server per room and name on this computer owns the room, or every open window would answer
// every message. The lock holds the owner's pid; a dead owner's lock is taken over.
function lockOwner() {
	let pid;
	try {
		pid = Number(readFileSync(lockFile, "utf8"));
	} catch {
		return undefined;
	}
	if (!pid || pid === process.pid) return undefined;
	try {
		process.kill(pid, 0);
	} catch (err) {
		if (err.code !== "EPERM") return undefined; // gone; EPERM means alive, just not ours
	}
	return pid;
}
// Exclusive create, so two windows starting together can't both take the room.
function takeLock() {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(lockFile, String(process.pid), { flag: "wx" });
			return true;
		} catch (err) {
			if (err.code !== "EEXIST") throw err;
			if (lockOwner()) return false;
			try {
				const held = readFileSync(lockFile, "utf8");
				// Empty: another window created it a moment ago and is still writing its pid.
				if (!held && Date.now() - statSync(lockFile).mtimeMs < 5000) return false;
				if (Number(held) === process.pid) return true;
				// A dead owner's: remove it only if it is still that one, not a lock just taken over.
				if (readFileSync(lockFile, "utf8") === held && !lockOwner()) rmSync(lockFile);
			} catch {}
		}
	}
	return false;
}
const heldBy = (pid) =>
	`another duet window on this computer (pid ${pid}) is in this room as ${name} — use that one, or if it is gone delete ${lockFile}`;

// ---------- the room ----------

let host = ""; // clientInfo.name from initialize: "claude-code", "codex-mcp-client", …
const isClaude = () => /claude/i.test(host);
let sub;
let status = "not connected";
const peers = new Map();
const inbox = []; // received, not yet shown to the model
let heldCursor; // the resume point, saved once the inbox is empty
const waiters = []; // duet_wait calls blocked until something arrives, oldest first
let exchanges = 0; // replies sent on the agent's own since its user last asked for a send
let receivedSinceSend = false;
let codexThread; // learned from Codex's tool-call metadata; lets us push with `codex queue`
let pushing; // the messages handed to `codex queue`, until it confirms
let dropped = 0; // messages dropped because the inbox was full
let lastSend = 0; // when this session last sent (Claude Code: see SETTLE_MS)
let pushNote = ""; // why Codex isn't being pushed to right now, shown in duet_status
let pushPausedUntil = 0; // after a failed push, leave the messages to duet_inbox / duet_wait for a while

// Take messages out of the inbox to show them to the model.
function take(count = inbox.length) {
	const items = inbox.splice(0, count);
	if (items.length) receivedSinceSend = true;
	if (!inbox.length) pushNote = "";
	consumed();
	return items;
}
// Once nothing received is still waiting or on its way into the session, a restart may skip it all.
function consumed() {
	if (!inbox.length && !pushing && heldCursor) {
		saveCursor(heldCursor);
		heldCursor = undefined;
	}
}

// Never throws: a peer controls every field here.
const render = (items) => {
	const froms = [...new Set(items.map((e) => e.from))].join(", ");
	const at = (ts) => {
		const t = Date.parse(ts);
		return Number.isNaN(t) ? "" : `, ${new Date(t).toLocaleTimeString()}`;
	};
	const parts = items.map((e) => `[duet] from ${e.from} (the other person's agent, on their computer)${at(e.ts)}:\n\n${e.text}`);
	return `${parts.join("\n\n---\n\n")}\n\nOnly your own user sees your text replies: to answer ${froms}, call duet_send.`;
};

function onEnvelope(env) {
	if (!isForMe(env, fromId, name)) return;
	peers.set(env.from, new Date());
	if (env.kind === "join") return;
	inbox.push(env);
	if (inbox.length > INBOX_MAX) {
		inbox.shift();
		dropped++;
	}
	deliver();
}

// Hand waiting messages to a listening duet_wait, or push them into Codex.
let settleTimer;
function deliver() {
	if (!inbox.length) return;
	// Right after a send in Claude Code, only a duet_wait started since then may take a message;
	// older (backgrounded) listeners get it once the sending turn has had time to end.
	const settling = isClaude() && Date.now() - lastSend < SETTLE_MS;
	const waiter = waiters.find((w) => !settling || w.since >= lastSend);
	if (waiter) return waiter.wake(take()); // one listener takes it all; others keep listening
	if (settling && waiters.length) {
		clearTimeout(settleTimer);
		settleTimer = setTimeout(deliver, lastSend + SETTLE_MS - Date.now());
		return;
	}
	pushToCodex();
}

function onCursor(cursor) {
	if (inbox.length || pushing) heldCursor = cursor; // not consumed yet: a restart must see it again
	else saveCursor(cursor);
}

// Codex: start a turn in the open session with the waiting messages. Past the loop cap they stay
// in the inbox, like pi holding messages until its user types. Not on Windows: there `codex` is a
// .cmd shim that only runs through cmd.exe, and the other agent's text must never reach a shell.
function pushToCodex() {
	if (pushing || !codexThread || !inbox.length || exchanges >= MAX_AUTO || WINDOWS || Date.now() < pushPausedUntil) return;
	if (!codexWindowOpen()) {
		pushNote = "no Codex window open in this folder, so messages wait for duet_inbox";
		return;
	}
	// A batch at a time keeps the argument well under OS limits. Out of the inbox while on its way,
	// so duet_inbox can't show it too; back in front if the push fails.
	let size = 0;
	let count = 0;
	while (count < inbox.length && count < 8 && size + inbox[count].text.length < 30_000) size += inbox[count++].text.length;
	const batch = (pushing = inbox.splice(0, Math.max(1, count)));
	const finish = (err, stderr) => {
		pushing = undefined;
		if (err) {
			// A timeout may still have queued it: then it shows twice, which beats losing it.
			inbox.unshift(...batch);
			pushNote = `push to Codex failed: ${String(stderr || err.message).trim().slice(0, 200)}`;
			pushPausedUntil = Date.now() + 60_000;
			deliver(); // a duet_wait may be listening
			return;
		}
		pushNote = "";
		receivedSinceSend = true;
		consumed();
		pushToCodex(); // anything that arrived meanwhile
	};
	try {
		execFile(CODEX, ["queue", "--thread", codexThread, "--message", render(batch)], { timeout: 30_000 }, (err, _out, stderr) => finish(err, stderr));
	} catch (err) {
		finish(err); // e.g. an argument execFile refuses outright
	}
}

const SUBCOMMANDS = new Set(
	"agents exec e review login logout mcp mcp-server plugin app-server remote-control completion update doctor sandbox debug apply a resume queue archive delete migrate-rollouts unarchive fork cloud exec-server features help".split(" "),
);
// Codex keeps a closed window's session, and this server, alive for about a minute; a push then would
// run a turn nobody watches (observed). So only push while a Codex window is open in this folder:
// a `codex` process here that isn't its background server or a one-off command.
function codexWindowOpen() {
	// A window is `codex`, `codex resume|fork …` or `codex "<prompt>"`, flags anywhere before; any
	// other subcommand (the background app-server, queue, exec, …) is not.
	const withValue = /^(-[mcCpsai]|--(model|config|cd|profile|sandbox|ask-for-approval|image|enable|disable|local-provider|remote|remote-auth-token-env))$/;
	const isWindow = (argv0, args) => {
		if (!/(^|\/)codex$/.test(argv0)) return false;
		let i = 0;
		while (i < args.length && args[i].startsWith("-")) i += withValue.test(args[i]) ? 2 : 1;
		const sub = args[i];
		return !sub || sub === "resume" || sub === "fork" || !SUBCOMMANDS.has(sub);
	};
	try {
		if (process.platform === "linux") {
			for (const pid of readdirSync("/proc")) {
				if (!/^\d+$/.test(pid)) continue;
				try {
					const [argv0, ...args] = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
					if (isWindow(argv0, args) && readlinkSync(`/proc/${pid}/cwd`) === process.cwd()) return true;
				} catch {} // gone, or not ours to read
			}
		} else if (process.platform === "darwin") {
			for (const line of execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n")) {
				const m = line.trim().match(/^(\d+)\s+(\S+)(.*)$/);
				if (!m || !isWindow(m[2], m[3].trim().split(/\s+/))) continue;
				try {
					const lsof = execFileSync("lsof", ["-a", "-d", "cwd", "-p", m[1], "-Fn"], { encoding: "utf8" });
					if (lsof.split("\n").some((l) => l === `n${process.cwd()}`)) return true;
				} catch {} // that process is gone or not ours
			}
		}
	} catch {}
	return false;
}

function joinRoom() {
	if (sub) return true;
	const owner = lockOwner();
	if (owner) {
		status = `off: ${heldBy(owner)}`;
		return false;
	}
	let took;
	try {
		took = takeLock();
	} catch (err) {
		status = `off: can't write ${lockFile}: ${err.message}`;
		return false;
	}
	if (!took) {
		status = `off: ${heldBy(lockOwner())}`;
		return false;
	}
	status = "connecting…";
	sub = subscribe({
		server,
		topic: topicFor(room),
		since: loadCursor(),
		onEnvelope,
		onCursor,
		onState: (up, error) => (status = up ? "connected" : `offline: ${error}`),
	});
	publish(server, topicFor(room), envelope({ fromId, from: name, kind: "join" })).catch(() => {});
	return true;
}

function leave() {
	sub?.stop();
	sub = undefined;
	try {
		if (readFileSync(lockFile, "utf8") === String(process.pid)) rmSync(lockFile);
	} catch {}
}

// ---------- tools ----------

function toolList() {
	const listen = isClaude();
	const waitMax = listen ? LISTEN_MAX : WAIT_MAX;
	return [
		{
			name: "duet_send",
			description:
				"Send a message to the other person's coding agent in the duet room (another developer's agent, on their computer). " +
				"Use it when your user asks you to tell, ask or have the other agent do something, and to answer requests that came from the other agent. " +
				"When the other agent asks for something, do it with your normal tools and send back the real tool output, never a reconstruction. " +
				"Your plain-text replies are seen only by your own user. Do not send pure thank-you or acknowledgement messages.",
			inputSchema: {
				type: "object",
				properties: {
					text: { type: "string", description: "The message. Max ~3.8KB; split longer content into several calls." },
					to: { type: "string", description: "Recipient name, if the room has more than one other agent." },
					user_asked: {
						type: "boolean",
						description: "true only if your own user's latest message asked for this send; leave it out when you are replying to the other agent on your own.",
					},
				},
				required: ["text"],
			},
		},
		{
			name: "duet_wait",
			description: listen
				? "Listen for the next message from the other agent. Call it when your user asks you to join or listen on duet, and again after handling each message. " +
					"It runs in the background (after about 2 minutes) while you and your user carry on, and you are woken when a message arrives. " +
					"Keep one listening at a time."
				: `Wait up to ${WAIT_MAX} seconds for the next message from the other agent. Use it after duet_send when your user wants the answer in this turn; ` +
					"if nothing came, you may call it again a few times, then tell your user the answer will arrive later.",
			inputSchema: {
				type: "object",
				properties: { seconds: { type: "number", description: `How long to wait, at most ${waitMax}.` } },
			},
		},
		{
			name: "duet_inbox",
			description:
				"Read messages from the other agent that are waiting. Returns at once. Call it when your user says 'check duet' or similar, " +
				"then handle each message: do what was asked and answer with duet_send.",
			inputSchema: { type: "object", properties: {} },
		},
		{
			name: "duet_status",
			description: "Show the duet room status: your name, connected or not, peers seen, messages waiting.",
			inputSchema: { type: "object", properties: {} },
		},
	];
}

function needRoom() {
	if (!room || !name) throw new Error("No duet room configured: the server needs --room <room> --name <name>.");
	if (!joinRoom()) throw new Error(`Not in the room: ${lockOwner() ? heldBy(lockOwner()) : status.replace(/^off: /, "")}.`);
}

// Resolves with the messages handed to this wait (none on timeout or cancel).
function wait(seconds, signal, progress) {
	if (inbox.length) return Promise.resolve(take());
	return new Promise((resolve) => {
		let timer, beat;
		const done = (items = []) => {
			clearTimeout(timer);
			clearInterval(beat);
			signal.removeEventListener("abort", stop);
			const i = waiters.indexOf(waiter);
			if (i >= 0) waiters.splice(i, 1);
			resolve(items);
		};
		const stop = () => done();
		const waiter = { since: Date.now(), wake: done };
		timer = setTimeout(stop, seconds * 1000);
		if (progress) beat = setInterval(progress, PROGRESS_MS);
		signal.addEventListener("abort", stop);
		waiters.push(waiter);
	});
}

async function callTool(tool, a = {}, ctx) {
	switch (tool) {
		case "duet_send": {
			needRoom();
			if (typeof a.text !== "string" || !a.text) throw new Error("text is required");
			if (a.user_asked === true) exchanges = 0;
			else if (receivedSinceSend || ctx.pushedTurn) {
				if (exchanges >= MAX_AUTO) {
					throw new Error(
						`Not sent: auto-reply limit. ${MAX_AUTO} replies have gone to the other agent without your user asking. ` +
							"Stop here and ask your user whether to continue; only if they say so, send again with user_asked: true.",
					);
				}
				exchanges++;
			}
			receivedSinceSend = false;
			await publish(server, topicFor(room), envelope({ fromId, from: name, kind: "msg", to: a.to, text: a.text }), ctx.signal);
			lastSend = Date.now();
			pushToCodex(); // a user turn may have lifted the cap
			return "sent — the other agent has not answered yet; its reply will arrive later";
		}
		case "duet_wait": {
			needRoom();
			const max = isClaude() ? LISTEN_MAX : WAIT_MAX;
			const seconds = Math.min(max, Math.max(1, Number(a.seconds) || max));
			const got = await wait(seconds, ctx.signal, ctx.progress);
			if (got.length) return render(got) + (isClaude() ? "\n\nWhen you have handled this, call duet_wait again to keep listening." : "");
			if (ctx.signal.aborted) return "Stopped waiting.";
			return isClaude()
				? "No duet message yet; still in the room. Call duet_wait again to keep listening."
				: `No duet message in the last ${seconds}s.`;
		}
		case "duet_inbox": {
			needRoom();
			if (!inbox.length) return "No new duet messages.";
			const text = render(inbox); // before taking: nothing leaves the inbox unless shown
			take();
			return text;
		}
		case "duet_status": {
			if (room && name) joinRoom();
			const seen = [...peers].map(([p, at]) => `${p} (${at.toLocaleTimeString()})`).join(", ") || "none yet";
			// Only the start of the room code: the whole code would go to the model's provider.
			const shown = room ? `"${room.slice(0, 4)}…"` : "(none)";
			const lost = dropped ? `; ${dropped} older message(s) dropped (inbox full)` : "";
			const note = pushNote && sub ? `; ${pushNote}` : "";
			return `duet: ${name ?? "(no name)"} in room ${shown} via ${server} — ${status}${note}; peers seen: ${seen}; messages waiting: ${inbox.length}${lost}`;
		}
	}
	throw new Error(`unknown tool ${tool}`);
}

// ---------- MCP over stdio ----------

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const inflight = new Map(); // request id -> AbortController, for notifications/cancelled

const instructions = () =>
	"duet connects you with another developer's coding agent through a shared room. " +
	"Messages from it are shown as [duet] from <name>. When it asks for something, do it with your normal tools, then answer with duet_send, sending real tool output. " +
	"Your plain-text replies reach only your own user. " +
	(isClaude()
		? "To receive messages, keep a duet_wait call listening: start one when your user asks you to join or listen, and again after each message."
		: WINDOWS
			? "Messages wait in duet_inbox: check it when your user says 'check duet'."
			: "Messages are delivered into this session as they arrive; duet_inbox shows any that are waiting.");

async function handle(msg) {
	const { id, method, params } = msg;
	if (process.env.DUET_DEBUG_FILE) {
		try {
			appendFileSync(process.env.DUET_DEBUG_FILE, `${new Date().toISOString()} ${JSON.stringify(msg)}\n`);
		} catch {}
	}
	if (method === "notifications/cancelled") return inflight.get(params?.requestId)?.abort();
	if (id === undefined) return; // other notifications need no answer
	try {
		let result;
		if (method === "initialize") {
			host = params?.clientInfo?.name ?? "";
			result = {
				protocolVersion: params?.protocolVersion || "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "duet", version: VERSION },
				instructions: instructions(),
			};
			if (room && name) setImmediate(joinRoom); // be in the room before the first tool call
		} else if (method === "ping") result = {};
		else if (method === "tools/list") result = { tools: toolList() };
		else if (method === "tools/call") {
			const turn = params?._meta?.["x-codex-turn-metadata"];
			if (turn?.thread_id) codexThread = turn.thread_id;
			if (turn?.turn_trigger === "user") exchanges = 0; // the user is here: lift the loop cap
			const token = params?._meta?.progressToken;
			let beats = 0;
			const ctrl = new AbortController();
			inflight.set(id, ctrl);
			const ctx = {
				signal: ctrl.signal,
				// Codex says who started the turn; replies in a turn our own push started are unattended.
				pushedTurn: turn?.turn_trigger === "queue",
				progress: token === undefined ? undefined : () => send({ method: "notifications/progress", params: { progressToken: token, progress: ++beats } }),
			};
			try {
				result = { content: [{ type: "text", text: await callTool(params?.name, params?.arguments, ctx) }] };
			} catch (err) {
				result = { content: [{ type: "text", text: err.message }], isError: true };
			} finally {
				inflight.delete(id);
			}
			send({ id, result });
			try {
				pushToCodex(); // the first tool call tells us the session to push to
			} catch {}
			return;
		} else return send({ id, error: { code: -32601, message: `method not found: ${method}` } });
		send({ id, result });
	} catch (err) {
		send({ id, error: { code: -32603, message: err.message } });
	}
}

// Split on \n only: readline would also split inside JSON strings holding U+2028.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (!line) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			send({ id: null, error: { code: -32700, message: "parse error" } });
			continue;
		}
		handle(msg);
	}
});
// The host closed us: give the room back so another window can take it.
process.stdin.on("end", () => {
	leave();
	process.exit(0);
});
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => (leave(), process.exit(0)));
