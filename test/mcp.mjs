// Plumbing tests for the MCP server (mcp.js), no model and no cost: the test speaks MCP to real
// server processes, each with its own HOME, over an ntfy server.
//
//   node test/mcp.mjs
//
// Env: DUET_SERVER (default the local test container http://127.0.0.1:18080),
//      DUET_TEST_DIR (default ~/coding/personal/duet-test-v2/mcp).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { envelope, publish, topicFor } from "../transport.js";

const SERVER = (process.env.DUET_SERVER || "http://127.0.0.1:18080").replace(/\/+$/, "");
const ROOT = process.env.DUET_TEST_DIR || join(homedir(), "coding/personal/duet-test-v2/mcp");
const BIN = resolve(import.meta.dirname, "../mcp.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const results = [];
function check(name, ok, evidence) {
	results.push({ name, ok, evidence });
	log(ok ? "PASS" : "FAIL", name, "—", evidence);
}
async function until(pred, ms, what) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = pred();
		if (v) return v;
		await sleep(100);
	}
	throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}
const freshRoom = () => `t-${randomUUID()}`;
const live = new Set();

// A minimal MCP client around one server process.
export function startServer(name, room, { home = join(ROOT, name), args = [], env = {}, bin = [process.execPath, BIN] } = {}) {
	mkdirSync(home, { recursive: true });
	const proc = spawn(bin[0], [...bin.slice(1), "--room", room, "--name", name, "--server", SERVER, ...args], {
		env: { HOME: home, PATH: process.env.PATH, LANG: "C.UTF-8", ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const s = { name, home, proc, notes: [], pending: new Map(), nextId: 1, stderr: "", exited: false };
	let buf = "";
	proc.stdout.on("data", (d) => {
		buf += d.toString("utf8");
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const msg = JSON.parse(buf.slice(0, nl));
			buf = buf.slice(nl + 1);
			if (msg.id !== undefined && s.pending.has(msg.id)) {
				s.pending.get(msg.id)(msg);
				s.pending.delete(msg.id);
			} else s.notes.push({ at: Date.now(), ...msg });
		}
	});
	proc.stderr.on("data", (d) => (s.stderr += d));
	proc.on("exit", () => (s.exited = true));
	s.request = (method, params) =>
		new Promise((r) => {
			const id = s.nextId++;
			s.pending.set(id, r);
			proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
			s.lastId = id;
		});
	s.notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
	s.call = async (tool, a = {}, _meta) => {
		const res = await s.request("tools/call", { name: tool, arguments: a, ...(_meta && { _meta }) });
		return { isError: !!res.result?.isError, text: res.result?.content?.[0]?.text ?? JSON.stringify(res.error) };
	};
	s.init = async (client = "test") => {
		const res = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: client, version: "1" } });
		s.notify("notifications/initialized");
		return res.result;
	};
	s.stop = async () => {
		live.delete(s);
		if (s.exited) return;
		proc.stdin.end(); // how a host closes a stdio server
		await until(() => s.exited, 5000, `${name} exit`).catch(() => proc.kill("SIGKILL"));
	};
	s.kill = async () => {
		live.delete(s);
		proc.kill("SIGKILL"); // a crash: no cleanup
		await until(() => s.exited, 5000, `${name} killed`);
	};
	live.add(s);
	return s;
}
async function waitConnected(s) {
	const end = Date.now() + 15_000;
	while (Date.now() < end) {
		if ((await s.call("duet_status")).text.includes("— connected")) return;
		await sleep(200);
	}
	throw new Error(`${s.name} never connected`);
}

async function main() {
	rmSync(ROOT, { recursive: true, force: true });
	const room = freshRoom();
	let a = startServer("alice", room);
	let b = startServer("bob", room);
	const init = await a.init();
	await b.init();
	const list = await a.request("tools/list");
	check(
		"initialize + tools/list",
		init.serverInfo.name === "duet" && list.result.tools.map((t) => t.name).join() === "duet_send,duet_wait,duet_inbox,duet_status",
		`server ${init.serverInfo.name} ${init.serverInfo.version}, protocol ${init.protocolVersion}, tools ${list.result.tools.map((t) => t.name).join(", ")}`,
	);
	await Promise.all([waitConnected(a), waitConnected(b)]);

	// Send and receive through duet_wait, with unicode and U+2028 (a line separator inside JSON).
	const text = "héllo ünïcode   line-sep — 17*23?";
	const t0 = Date.now();
	const waiting = b.call("duet_wait", { seconds: 20 });
	await sleep(500);
	await a.call("duet_send", { text, user_asked: true });
	const got = await waiting;
	check("send → duet_wait returns it", got.text.includes(text) && got.text.includes("[duet] from alice"), `${Date.now() - t0}ms: ${JSON.stringify(got.text.slice(0, 140))}`);
	check("no own echo", !(await a.call("duet_inbox")).text.includes(text), "alice's inbox after her own send: no new messages");

	// Inbox: queued until read, read once.
	await a.call("duet_send", { text: "INBOX-1", user_asked: true });
	await a.call("duet_send", { text: "INBOX-2", to: "carol", user_asked: true });
	await a.call("duet_send", { text: "INBOX-3", to: "Bob", user_asked: true });
	await sleep(1500);
	const inbox = await b.call("duet_inbox");
	const again = await b.call("duet_inbox");
	check(
		"inbox: queued, filtered by recipient, read once",
		inbox.text.includes("INBOX-1") && inbox.text.includes("INBOX-3") && !inbox.text.includes("INBOX-2") && again.text === "No new duet messages.",
		`first read ${JSON.stringify(inbox.text.replace(/\n+/g, " ").slice(0, 200))}; second read ${JSON.stringify(again.text)}`,
	);

	const w0 = Date.now();
	const timeout = await b.call("duet_wait", { seconds: 2 });
	check("duet_wait times out", /No duet message in the last 2s/.test(timeout.text) && Date.now() - w0 < 4000, `${Date.now() - w0}ms: ${timeout.text}`);

	// A cancelled duet_wait ends at once (the host gave up on the call).
	const c0 = Date.now();
	const cancelled = b.call("duet_wait", { seconds: 30 });
	await sleep(300);
	b.notify("notifications/cancelled", { requestId: b.lastId });
	await cancelled;
	check("cancelled duet_wait returns", Date.now() - c0 < 3000, `${Date.now() - c0}ms`);

	// Restart: a message that arrived but was never read survives a crash; one sent while down is caught up.
	await a.call("duet_send", { text: "UNREAD-BEFORE-CRASH", user_asked: true });
	await sleep(1500);
	check("unread message is held", (await b.call("duet_status")).text.includes("messages waiting: 1"), "bob status shows 1 waiting");
	await b.kill();
	await a.call("duet_send", { text: "SENT-WHILE-DOWN", user_asked: true });
	b = startServer("bob", room);
	await b.init();
	await waitConnected(b);
	await sleep(12_000); // past the 10s repair poll: a duplicate would show up by now
	const caught = await b.call("duet_inbox");
	const count = (s) => caught.text.split(s).length - 1;
	check(
		"restart: unread kept, missed caught up, each once",
		count("UNREAD-BEFORE-CRASH") === 1 && count("SENT-WHILE-DOWN") === 1 && count("INBOX-1") === 0,
		JSON.stringify(caught.text.replace(/\n+/g, " ").slice(0, 300)),
	);

	// A second window with the same HOME, room and name stays out, and takes over when the first closes.
	const b2 = startServer("bob", room);
	await b2.init();
	const refused = await b2.call("duet_send", { text: "FROM-B2", user_asked: true });
	check("second window can't send", refused.isError && refused.text.includes("is in this room as bob"), refused.text);
	await a.call("duet_send", { text: "ONE-OWNER", user_asked: true });
	await sleep(1500);
	const ownerGot = (await b.call("duet_inbox")).text.includes("ONE-OWNER");
	const b2Got = await b2.call("duet_inbox");
	check("only the owner receives", ownerGot && b2Got.isError, `owner got it: ${ownerGot}; second window: ${b2Got.text.slice(0, 80)}`);
	await b.stop();
	await waitConnected(b2);
	await a.call("duet_send", { text: "AFTER-HANDOVER", user_asked: true });
	const handed = await b2.call("duet_wait", { seconds: 10 });
	check("second window takes over when the first closes", handed.text.includes("AFTER-HANDOVER"), handed.text.slice(0, 120));
	b = b2;

	// Loop cap: replies on the agent's own are limited; a user-asked send resets the count.
	const capRoom = freshRoom();
	const c = startServer("carol", capRoom, { env: { DUET_MAX_AUTO: "3" } });
	const d = startServer("dave", capRoom);
	await Promise.all([c.init(), d.init()]);
	await Promise.all([waitConnected(c), waitConnected(d)]);
	const outcomes = [];
	for (let i = 1; i <= 5; i++) {
		await d.call("duet_send", { text: `ping ${i}`, user_asked: true });
		await c.call("duet_wait", { seconds: 10 });
		outcomes.push((await c.call("duet_send", { text: `pong ${i}` })).isError ? "refused" : "sent");
	}
	const reset = await c.call("duet_send", { text: "user said go on", user_asked: true });
	check(
		"loop cap: replies on its own stop at the cap, user_asked resets",
		outcomes.join() === "sent,sent,sent,refused,refused" && !reset.isError,
		`cap 3: replies ${outcomes.join(", ")}; then user_asked send: ${reset.isError ? "refused" : "sent"}`,
	);

	// Claude Code: duet_wait listens long (Claude backgrounds it), keeps the call alive with progress
	// notifications, and one message wakes one listener.
	const lRoom = freshRoom();
	const e = startServer("erin", lRoom, { env: { DUET_PROGRESS_MS: "300" } });
	const f = startServer("frank", lRoom);
	await e.init("claude-code");
	await f.init();
	const eTools = (await e.request("tools/list")).result.tools;
	await Promise.all([waitConnected(e), waitConnected(f)]);
	const l1 = e.request("tools/call", { name: "duet_wait", arguments: {}, _meta: { progressToken: "p1" } });
	const l2 = e.call("duet_wait", {});
	await sleep(1500);
	await f.call("duet_send", { text: "FOR-ONE-LISTENER", user_asked: true });
	const first = await l1;
	await sleep(500);
	const beats = e.notes.filter((n) => n.method === "notifications/progress" && n.params.progressToken === "p1").length;
	await f.call("duet_send", { text: "SECOND", user_asked: true });
	const second = await l2;
	check(
		"Claude Code: long listen, progress keepalive, one listener per message",
		/background/.test(eTools.find((t) => t.name === "duet_wait").description) &&
			first.result.content[0].text.includes("FOR-ONE-LISTENER") && first.result.content[0].text.includes("call duet_wait again") &&
			beats >= 3 && second.text.includes("SECOND") && !second.text.includes("FOR-ONE-LISTENER"),
		`progress beats during ~1.5s wait (every 300ms): ${beats}; first listener got FOR-ONE-LISTENER, second listener got SECOND`,
	);

	// Codex: once a tool call has shown the thread id, arriving messages are pushed with `codex queue`.
	const qlog = join(ROOT, "codex-queue.log");
	const fakeCodex = join(ROOT, "fake-codex.mjs");
	writeFileSync(fakeCodex, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(qlog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nconsole.log("Queued message");\n`);
	chmodSync(fakeCodex, 0o755);
	const queued = () => (existsSync(qlog) ? readFileSync(qlog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
	const cRoom = freshRoom();
	const g = startServer("gina", cRoom, { env: { DUET_CODEX_BIN: fakeCodex, DUET_MAX_AUTO: "2" } });
	const h = startServer("hal", cRoom);
	await g.init("codex-mcp-client");
	await h.init();
	await Promise.all([waitConnected(g), waitConnected(h)]);
	await h.call("duet_send", { text: "BEFORE-THREAD-KNOWN", user_asked: true });
	await sleep(1500);
	const beforeThread = queued().length;
	const meta = (trigger) => ({ "x-codex-turn-metadata": { thread_id: "thread-123", turn_trigger: trigger } });
	await g.call("duet_status", {}, meta("user")); // the first tool call: now the session is known
	await until(() => queued().length === 1, 5000, "queued after the thread is known");
	await h.call("duet_send", { text: "PUSHED-LIVE", user_asked: true });
	await until(() => queued().length === 2, 5000, "live push");
	const q = queued();
	const inboxAfter = await g.call("duet_inbox", {}, meta("queue"));
	check(
		"Codex: pushed with codex queue once the thread is known",
		beforeThread === 0 && q[0].slice(0, 3).join(" ") === "queue --thread thread-123" && q[0][4].includes("BEFORE-THREAD-KNOWN") &&
			q[1][4].includes("PUSHED-LIVE") && q[1][4].includes("call duet_send") && inboxAfter.text === "No new duet messages.",
		`queued before thread known: ${beforeThread}; then ${q.length} pushes: ${q.map((a) => JSON.stringify(a[4].split("\n\n")[1])).join(", ")}; inbox after: ${inboxAfter.text}`,
	);
	// The loop cap holds for pushed turns: replies in queue-started turns count, pushing stops at the cap.
	const replies = [];
	for (let i = 1; i <= 3; i++) {
		replies.push((await g.call("duet_send", { text: `auto reply ${i}` }, meta("queue"))).isError ? "refused" : "sent");
		await h.call("duet_send", { text: `PING-${i}`, user_asked: true });
		await sleep(1200);
	}
	const pushedPings = queued().filter((a) => /PING-/.test(a[4])).length;
	const held = (await g.call("duet_status")).text.match(/messages waiting: (\d+)/)[1];
	const checked = await g.call("duet_inbox", {}, meta("user")); // "check duet", typed by the user
	await h.call("duet_send", { text: "PING-AFTER", user_asked: true });
	await until(() => queued().some((a) => a[4].includes("PING-AFTER")), 5000, "push resumes after a user turn");
	check(
		"Codex: loop cap stops replies and pushes; the user's next duet request resumes",
		replies.join() === "sent,sent,refused" && pushedPings === 1 && held === "2" && checked.text.includes("PING-2") && checked.text.includes("PING-3"),
		`cap 2: replies ${replies.join(", ")}; pings pushed before the user came back: ${pushedPings}, held: ${held}; "check duet" returned the held ones; the next message was pushed again`,
	);

	// setup codex writes the server into config.toml (and replaces an earlier duet block).
	const codexHome = join(ROOT, "codex-home");
	mkdirSync(codexHome, { recursive: true });
	writeFileSync(join(codexHome, "config.toml"), 'model = "m"\n\n[mcp_servers.duet]\ncommand = "old"\n[mcp_servers.duet.tools.x]\napproval_mode = "prompt"\n');
	const setupOut = await new Promise((r) => {
		const p = spawn(process.execPath, [BIN, "setup", "codex", "--room", "r00m", "--name", "nika"], { env: { HOME: codexHome, PATH: process.env.PATH, CODEX_HOME: codexHome } });
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.on("exit", (code) => r(`exit=${code} ${out.trim()}`));
	});
	const toml = readFileSync(join(codexHome, "config.toml"), "utf8");
	check(
		"setup codex writes the duet block",
		setupOut.startsWith("exit=0") && !toml.includes('"old"') && !toml.includes("approval_mode = \"prompt\"") && toml.includes('model = "m"') &&
			toml.includes('args = ["-y", "github:qaioz/pi-duet", "--room", "r00m", "--name", "nika"]') && toml.includes("tool_timeout_sec = 120") &&
			toml.includes('default_tools_approval_mode = "approve"'),
		toml.replace(/\n/g, " ⏎ "),
	);

	// Interop with the pi extension's wire format: a hand-made envelope from "pi" arrives.
	await publish(SERVER, topicFor(room), envelope({ fromId: "pi-install", from: "pia", kind: "msg", text: "FROM-PI" }));
	const fromPi = await b.call("duet_wait", { seconds: 10 });
	check("receives a pi-format envelope", fromPi.text.includes("[duet] from pia") && fromPi.text.includes("FROM-PI"), fromPi.text.slice(0, 80));

	// No room configured: tools explain instead of crashing.
	const n = startServer("nobody", "", { args: [] });
	await n.init();
	const noRoom = await n.call("duet_send", { text: "x" });
	check("no room: clear error", noRoom.isError && noRoom.text.includes("--room"), noRoom.text);

	// Clean exit gives the lock back.
	for (const s of [...live]) await s.stop();
	const locks = readdirSync(join(ROOT, "bob", ".duet")).filter((f) => f.endsWith(".lock"));
	check("closing releases the lock", locks.length === 0, `lock files left in bob's ~/.duet: ${locks.length}`);
}

try {
	await main();
} catch (err) {
	check("harness", false, err.stack);
}
for (const s of [...live]) await s.kill().catch(() => {});
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed`);
if (process.env.DUET_RESULTS) {
	const { appendFileSync } = await import("node:fs");
	appendFileSync(process.env.DUET_RESULTS, JSON.stringify({ suite: "mcp-plumbing", at: new Date().toISOString(), results }) + "\n");
}
process.exit(failed.length ? 1 : 0);
