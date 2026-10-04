#!/usr/bin/env node
// duet MCP server: puts Claude Code, Codex or any other MCP host in a duet room, next to pi agents.
// Plain JavaScript with no dependencies: npx runs it straight from GitHub, and Node won't strip
// TypeScript inside node_modules. Speaks MCP over stdio (newline-delimited JSON-RPC).
//
//   npx -y github:qaioz/pi-duet --room <room> --name <name> [--server <url>]
//   npx -y github:qaioz/pi-duet setup codex --room <room> --name <name>   (see setup.js)
//
// How a message reaches the model, by host:
//   Claude Code: a channel. The server declares `claude/channel` and pushes each message as a
//                notifications/claude/channel event; Claude Code puts it in the session and starts a
//                turn (or queues it while one runs). Needs Claude Code started with
//                --dangerously-load-development-channels server:duet (research preview).
//   Codex:       the server runs `codex queue`, which starts a turn in the open session.
//   any host:    duet_inbox, when the user says "check duet".
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envelope, firstLine, isForMe, isName, isPlaceholderName, isRelayUrl, placeFor, publish, subscribe, topicFor } from "./transport.js";

if (process.argv[2] === "setup") {
	await import("./setup.js");
	process.exit(0);
}

const VERSION = "0.4.0";

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
const server = (args.server || process.env.DUET_SERVER || "https://duet.gaioz.online").replace(/\/+$/, "");
if (!isRelayUrl(server)) {
	console.error(`duet: --server must be an http(s) URL like https://duet.gaioz.online, got ${JSON.stringify(server)}`);
	process.exit(1);
}
// The site's placeholder: someone copied the commands before typing their name.
if (name !== undefined && isPlaceholderName(name)) {
	console.error(`duet: --name is still the placeholder ${JSON.stringify(name)}; use your own name`);
	process.exit(1);
}
// Peers drop messages from names outside the rule, so never send under one.
if (name !== undefined && !isName(name)) {
	console.error(`duet: --name may only use letters, digits, . _ -, must start with a letter or digit, at most 40; got ${JSON.stringify(name)}`);
	process.exit(1);
}
// Unattended back-and-forth allowed before the agent must check with its user.
const MAX_AUTO = Math.max(1, Number(process.env.DUET_MAX_AUTO) || 8);
const CODEX = process.env.DUET_CODEX_BIN || "codex";
const INBOX_MAX = 200;
const RECENT_MAX = 20; // messages already pushed into Claude Code, for "check duet"
// Claude Code registers its channel listener only after it has fetched our tools, and drops events
// sent before that. Push this long after the first tools/list.
const READY_MS = Number(process.env.DUET_READY_MS ?? 2000);
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]; // newest first
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
const isClaude = () => host === "claude-code";
// Was Claude Code started with the channel flag naming duet? true / false / undefined (can't tell,
// e.g. on Windows). Without it Claude Code drops every channel event silently, so we don't push.
let channelFlag;
const pushesToClaude = () => isClaude() && channelFlag !== false;
let sub;
let status = "not connected";
const peers = new Map();
const inbox = []; // received, not yet shown to the model
const recent = []; // pushed into Claude Code through the channel (no delivery receipt exists)
let heldCursor; // the resume point, saved once the inbox is empty
let ready = false; // Claude Code has fetched our tools (and READY_MS passed): its channel listener exists
let unconfirmed = false; // pushed into Claude Code, no tool call since: the resume point isn't saved yet
let exchanges = 0; // replies sent on the agent's own since its user last asked for a send
const sent = new Map(); // our messages' ids -> first line, to show what a reply answers
const lastFrom = new Map(); // peer name -> { id, at } of its latest message
const warnings = new Set(); // a same-folder window, a long message lost: shown in duet_status
const RECENT_MS = 30 * 60_000; // a peer counts as "here" if seen this recently
let receivedSinceSend = false;
let codexThread; // learned from Codex's tool-call metadata; lets us push with `codex queue`
let pushing; // the messages handed to `codex queue`, until it confirms
let dropped = 0; // messages dropped because the inbox was full
let pushNote = ""; // why Codex isn't being pushed to right now, shown in duet_status
let pushPausedUntil = 0; // after a failed push, leave the messages to duet_inbox for a while
const PUSH_PAUSE_MS = Number(process.env.DUET_PUSH_PAUSE_MS) || 60_000;

// Take messages out of the inbox to show them to the model.
function take(count = inbox.length) {
	const items = inbox.splice(0, count);
	if (items.length) receivedSinceSend = true;
	if (!inbox.length && !pushPausedUntil) pushNote = "";
	consumed();
	return items;
}
// Once nothing received is still waiting or on its way into the session, a restart may skip it all.
function consumed() {
	if (!inbox.length && !pushing && !unconfirmed && heldCursor) {
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
	const answers = (e) => (e.re && sent.has(e.re) ? ` — a reply to your message “${sent.get(e.re)}”` : "");
	const parts = items.map((e) => `[duet] from ${e.from} (the other person's agent, on their computer)${at(e.ts)}${answers(e)}:\n\n${e.text}`);
	return (
		`${parts.join("\n\n---\n\n")}\n\nOnly your own user sees your text replies: to answer ${froms}, call duet_send.` +
		// Observed in Claude Code: asked to work "in your folder", the model used the home directory.
		// Claude Code starts us in its project folder; other hosts may not (e.g. codex -C), so only there.
		(isClaude() ? ` "Your folder" means ${process.cwd()}: work there, and nowhere else unless your own user says so.` : "")
	);
};

function onEnvelope(env) {
	if (!isForMe(env, fromId, name)) return;
	peers.set(env.from, new Date());
	if (env.kind === "join") {
		if (env.place && env.place === placeFor(process.cwd(), topicFor(room))) warnings.add(`${env.from} is in this room from this same folder: two agents may edit the same files`);
		return;
	}
	lastFrom.set(env.from, { id: env.id, at: Date.now() });
	inbox.push(env);
	if (inbox.length > INBOX_MAX) {
		inbox.shift();
		dropped++;
	}
	deliver();
}

// Push waiting messages into the session: a channel event for Claude Code, `codex queue` for Codex.
function deliver() {
	if (!inbox.length) return;
	if (isClaude()) pushToClaude();
	else pushToCodex();
}

// Claude Code: one channel event per message. Claude Code queues events while a turn runs and
// delivers them in order. Past the loop cap they stay in the inbox until the user asks for a send
// (or says "check duet"). Claude Code sends no receipt, and drops events silently when it wasn't
// started with the channel flag, so pushed messages are also kept in `recent` for duet_inbox.
function pushToClaude() {
	if (!pushesToClaude() || !ready || !inbox.length || exchanges >= MAX_AUTO) return;
	// No receipt exists: keep the resume point until the session shows it is alive (its next tool
	// call). A restart before that pushes these again: a duplicate beats a loss.
	unconfirmed = true;
	const items = take();
	for (const e of items) {
		send({ method: "notifications/claude/channel", params: { content: render([e]), meta: { from: e.from } } });
	}
	recent.push(...items);
	recent.splice(0, Math.max(0, recent.length - RECENT_MAX));
}

function onCursor(cursor) {
	if (inbox.length || pushing || unconfirmed) heldCursor = cursor; // not consumed yet: a restart must see it again
	else saveCursor(cursor);
}

// Codex: start a turn in the open session with the waiting messages. Past the loop cap they stay
// in the inbox, like pi holding messages until its user types. Not on Windows: there `codex` is a
// .cmd shim that only runs through cmd.exe, and the other agent's text must never reach a shell.
function pushToCodex() {
	if (pushPausedUntil && Date.now() >= pushPausedUntil) {
		pushPausedUntil = 0;
		pushNote = ""; // the pause is over
	}
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
			pushPausedUntil = Date.now() + PUSH_PAUSE_MS;
			pushNote = `push to Codex failed (${String(stderr || err.message).trim().slice(0, 200)}); paused until ${new Date(pushPausedUntil).toLocaleTimeString()}, duet_inbox has the messages`;
			setTimeout(pushToCodex, PUSH_PAUSE_MS + 100).unref(); // try again once the pause is over
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
	"agents app exec e execpolicy review login logout mcp mcp-server plugin app-server remote-control completion update doctor sandbox debug apply a resume queue archive delete migrate-rollouts unarchive fork cloud cloud-tasks exec-server features help".split(" "),
);
// Codex keeps a closed window's session, and this server, alive for about a minute; a push then would
// run a turn nobody watches (observed). So only push while a Codex window is open in this folder:
// a `codex` process here that isn't its background server or a one-off command.
function codexWindowOpen() {
	// A window is `codex`, `codex resume|fork …` or `codex "<prompt>"`, flags anywhere before; any
	// other subcommand (the background app-server, queue, exec, …) is not.
	const withValue = /^(-[mcCpsai]|--(model|config|cd|profile|sandbox|ask-for-approval|image|add-dir|enable|disable|local-provider|remote|remote-auth-token-env))$/;
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

// The host's command line, walking up from our parent (Claude Code may start us through npx and a
// shell). Linux reads /proc, macOS asks ps; elsewhere the answer is "can't tell".
function ancestorArgs() {
	const out = [];
	let pid = process.ppid;
	for (let depth = 0; depth < 8 && pid >= 1; depth++) {
		try {
			if (process.platform === "linux") {
				out.push(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean));
				if (pid === 1) break;
				pid = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop().split(" ")[1]);
			} else if (process.platform === "darwin") {
				const line = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" }).trim();
				const m = line.match(/^(\d+)\s+(.*)$/);
				if (!m) break;
				out.push(m[2].split(/\s+/));
				if (pid === 1) break;
				pid = Number(m[1]);
			} else return undefined;
		} catch {
			break;
		}
	}
	return out;
}
// The nearest Claude Code process up the tree decides: did it get --dangerously-load-development-
// channels with server:duet? (--channels takes only approved plugins, so a bare server there is
// refused by Claude Code.) No Claude Code process found: can't tell.
function detectChannelFlag() {
	if (process.env.DUET_CHANNEL_FLAG) return process.env.DUET_CHANNEL_FLAG === "on"; // tests
	const chain = ancestorArgs();
	if (!chain) return undefined;
	for (const args of chain) {
		if (!args.some((a) => /(^|[\/\\])claude(\.exe)?$/.test(a) || a.includes("@anthropic-ai/claude-code"))) continue;
		for (let i = 0; i < args.length; i++) {
			const [flag, inline] = args[i].split("=", 2);
			if (flag !== "--dangerously-load-development-channels") continue;
			const values = inline ? [inline] : [];
			for (let j = i + 1; j < args.length && !args[j].startsWith("-"); j++) values.push(args[j]);
			if (values.join(" ").split(/[\s,]+/).includes("server:duet")) return true;
		}
		return false;
	}
	return undefined;
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
		onExpired: (why) => warnings.add(`a long message ${why === "expired" ? "expired on the relay" : "couldn't be downloaded"} before it could be read (${new Date().toLocaleTimeString()})`),
		onState: (up, error) => (status = up ? "connected" : `offline: ${error}`),
	});
	publish(server, topicFor(room), envelope({ fromId, from: name, kind: "join", place: placeFor(process.cwd(), topicFor(room)) })).catch(() => {});
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
	// Claude Code: load duet's tools up front even if duet was added by hand without alwaysLoad.
	const meta = isClaude() ? { _meta: { "anthropic/alwaysLoad": true } } : {};
	return [
		{
			name: "duet_send",
			...meta,
			description:
				"Send a message to the other person's coding agent in the duet room (another developer's agent, on their computer). " +
				"Use it when your user asks you to tell, ask or have the other agent do something, and to answer requests that came from the other agent. " +
				"When the other agent asks for something, do it with your normal tools and send back the real tool output, never a reconstruction. " +
				"Your plain-text replies are seen only by your own user. Do not send pure thank-you or acknowledgement messages. " +
				"Send one complete reply when you are done, not progress updates or several small messages; one message can be long (up to ~200 KB).",
			inputSchema: {
				type: "object",
				properties: {
					text: { type: "string", description: "The message: one complete reply, up to ~200 KB." },
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
			name: "duet_inbox",
			...meta,
			description: pushesToClaude()
				? "Messages from the other agent are pushed into this session by themselves. Call this only when your user says 'check duet': " +
					"it shows any held back (after the auto-reply limit) and the latest ones already pushed."
				: "Read messages from the other agent that are waiting. Returns at once. Call it when your user says 'check duet' or similar, " +
					"then handle each message: do what was asked and answer with duet_send.",
			inputSchema: { type: "object", properties: {} },
		},
		{
			name: "duet_status",
			...meta,
			description: "Show the duet room status: your name, connected or not, peers seen, messages waiting.",
			inputSchema: { type: "object", properties: {} },
		},
	];
}

function needRoom() {
	if (!room || !name) throw new Error("No duet room configured: the server needs --room <room> --name <name>.");
	if (!joinRoom()) throw new Error(`Not in the room: ${lockOwner() ? heldBy(lockOwner()) : status.replace(/^off: /, "")}.`);
}

async function callTool(tool, a = {}, ctx) {
	switch (tool) {
		case "duet_send": {
			needRoom();
			if (typeof a.text !== "string" || !a.text) throw new Error("text is required");
			const unattended = a.user_asked !== true && (receivedSinceSend || ctx.pushedTurn);
			if (unattended && exchanges >= MAX_AUTO) {
				throw new Error(
					`Not sent: auto-reply limit. ${MAX_AUTO} replies have gone to the other agent without your user asking. ` +
						"Stop here and ask your user whether to continue; only if they say so, send again with user_asked: true.",
				);
			}
			// Counted before the await, so parallel sends can't slip past the cap; given back if it
			// never went out.
			const before = { exchanges, receivedSinceSend };
			if (a.user_asked === true) exchanges = 0;
			else if (unattended) exchanges++;
			receivedSinceSend = false;
			// Answering a peer (not the user's own request): say which message this answers.
			const peerMsg = a.to ? lastFrom.get(a.to) : [...lastFrom.values()].sort((x, y) => y.at - x.at)[0];
			const re = unattended && peerMsg && Date.now() - peerMsg.at < 30 * 60_000 ? peerMsg.id : undefined;
			const env = envelope({ fromId, from: name, kind: "msg", to: a.to, text: a.text, ...(re ? { re } : {}) });
			try {
				await publish(server, topicFor(room), env, ctx.signal);
				sent.set(env.id, firstLine(a.text));
				if (sent.size > 200) sent.delete(sent.keys().next().value);
			} catch (err) {
				exchanges = before.exchanges;
				receivedSinceSend ||= before.receivedSinceSend;
				throw err;
			}
			deliver(); // a user-asked send lifts the cap: anything held back goes out now
			return "sent — the other agent has not answered yet; its reply will arrive later";
		}
		case "duet_inbox": {
			needRoom();
			if (!inbox.length) {
				if (!pushesToClaude() || !recent.length) return "No new duet messages.";
				return "No new duet messages. The latest ones, already pushed into this session (act on them only if you haven't yet):\n\n" + render(recent);
			}
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
			const how = !isClaude()
				? ""
				: channelFlag === false
					? "; Claude Code was not started with --dangerously-load-development-channels server:duet, so messages are NOT pushed: they wait here until your user says 'check duet'. To get them pushed, restart with: claude --continue --dangerously-load-development-channels server:duet --allowedTools mcp__duet"
					: exchanges >= MAX_AUTO
						? "; auto-reply limit reached: new messages wait until your user asks for a send (say 'check duet' to read them)"
						: channelFlag === true
							? "; messages are pushed into this session through a Claude Code channel"
							: "; messages are pushed through a Claude Code channel (duet couldn't check Claude Code's command line: if none appear, start it with --dangerously-load-development-channels server:duet, and say 'check duet' to read them)";
			const recentPeers = [...peers].filter(([, at]) => Date.now() - at.getTime() < RECENT_MS).map(([n]) => n);
			const crowd = recentPeers.length > 1 ? [`more than one other agent is in this room (${recentPeers.join(", ")}): duet is built for two`] : [];
			const warn = [...crowd, ...warnings].map((w) => `; warning: ${w}`).join("");
			return `duet: ${name ?? "(no name)"} in room ${shown} via ${server} — ${status}${note}${how}; peers seen: ${seen}; messages waiting: ${inbox.length}${lost}${warn}`;
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
	(pushesToClaude()
		? 'Messages from it arrive by themselves as <channel source="duet" from="NAME"> events. Handle each one: do what it asks, then answer with duet_send. Never wait or poll for messages.'
		: isClaude()
			? "Claude Code was started without the duet channel, so messages wait in duet_inbox: read it when your user says 'check duet'."
			: /codex/i.test(host) && !WINDOWS
			? "After your first duet tool call, messages are delivered into this session as they arrive; duet_inbox shows any that are waiting."
			: "Messages wait in duet_inbox: check it when your user says 'check duet'.");

async function handle(msg) {
	const { id, method, params } = msg;
	if (process.env.DUET_DEBUG_FILE) {
		try {
			appendFileSync(process.env.DUET_DEBUG_FILE, `${new Date().toISOString()} ${JSON.stringify(msg)}\n`);
		} catch {}
	}
	if (method === "notifications/cancelled") return inflight.get(params?.requestId)?.abort();
	if (method === "notifications/initialized") return deliver(); // Codex: anything waiting
	if (id === undefined) return; // other notifications need no answer
	try {
		let result;
		if (method === "initialize") {
			host = params?.clientInfo?.name ?? "";
			if (isClaude()) channelFlag = detectChannelFlag();
			result = {
				protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
				// Claude Code registers a channel listener for this. Unknown methods, such as its server/discover
				// probe, get "method not found", which keeps it on this handshake: Claude Code doesn't register
				// a channel that negotiates the 2026-07-28 revision.
				capabilities: isClaude() ? { tools: {}, experimental: { "claude/channel": {} } } : { tools: {} },
				serverInfo: { name: "duet", version: VERSION },
				instructions: instructions(),
			};
			if (room && name) setImmediate(joinRoom); // be in the room before the first tool call
		} else if (method === "ping") result = {};
		else if (method === "tools/list") {
			result = { tools: toolList() };
			if (isClaude() && !ready) {
				setTimeout(() => {
					ready = true;
					deliver(); // a catch-up that arrived before Claude Code was listening
				}, READY_MS).unref();
			}
		}
		else if (method === "tools/call") {
			const turn = params?._meta?.["x-codex-turn-metadata"];
			if (turn?.thread_id) codexThread = turn.thread_id;
			if (turn?.turn_trigger === "user") exchanges = 0; // the user is here: lift the loop cap
			// Our pushes reached the session if it then answers (duet_send, with the flag seen on its command
			// line) or reads them (duet_inbox). Anything else doesn't prove it: Claude Code drops channel
			// events silently when channels are blocked, so keep the resume point (a duplicate beats a loss).
			const tool = params?.name;
			if (unconfirmed && (tool === "duet_inbox" || (tool === "duet_send" && channelFlag === true))) {
				unconfirmed = false;
				consumed();
			}
			const ctrl = new AbortController();
			inflight.set(id, ctrl);
			const ctx = {
				signal: ctrl.signal,
				// Codex says who started the turn; replies in a turn our own push started are unattended.
				pushedTurn: turn?.turn_trigger === "queue",
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
				deliver(); // Codex: the first tool call tells us the session to push to
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
