// Plumbing tests for the MCP server (mcp.js), no model and no cost: the test speaks MCP to real
// server processes, each with its own HOME, over an ntfy server.
//
//   node test/mcp.mjs
//
// Env: DUET_SERVER (default the local test container http://127.0.0.1:18080),
//      DUET_TEST_DIR (default ~/coding/personal/duet-test-v2/mcp).
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { envelope, fitName, isForMe, isName, publish, topicFor } from "../transport.js";

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
const windows = []; // fake Codex windows; never left running after the test
process.on("exit", () => windows.forEach((w) => w.kill()));
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
	// Receive the way a host without push does: ask duet_inbox until something comes or time is up.
	s.recv = async (seconds = 10, _meta) => {
		const end = Date.now() + seconds * 1000;
		let r;
		do {
			r = await s.call("duet_inbox", {}, _meta);
			if (r.isError || r.text !== "No new duet messages.") return r;
			await sleep(200);
		} while (Date.now() < end);
		return { ...r, timedOut: true };
	};
	s.init = async (client = "test", { initialized = true, caps = {} } = {}) => {
		const res = await s.request("initialize", { protocolVersion: "2025-06-18", capabilities: caps, clientInfo: { name: client, version: "1" } });
		if (initialized) s.notify("notifications/initialized");
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
	let last = "";
	while (Date.now() < end) {
		last = (await s.call("duet_status")).text;
		if (last.includes("— connected")) return;
		await sleep(200);
	}
	throw new Error(`${s.name} never connected: ${last} ${s.stderr.slice(-300)}`);
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
		init.serverInfo.name === "duet" && // no MCP Apps capability: no panel tools (test/panel.mjs)
			list.result.tools.map((t) => t.name).join() === "duet_send,duet_inbox,duet_status,duet_join,duet_leave,duet_mode,duet_history",
		`server ${init.serverInfo.name} ${init.serverInfo.version}, protocol ${init.protocolVersion}, tools ${list.result.tools.map((t) => t.name).join(", ")}`,
	);
	await Promise.all([waitConnected(a), waitConnected(b)]);

	// Send and receive, with unicode and U+2028 (a line separator inside JSON).
	const text = "héllo ünïcode   line-sep — 17*23?";
	const t0 = Date.now();
	await a.call("duet_send", { text, user_asked: true });
	const got = await b.recv(20);
	check("send → the other side receives it", got.text.includes(text) && got.text.includes("[duet] from alice"), `${Date.now() - t0}ms: ${JSON.stringify(got.text.slice(0, 140))}`);
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
	const handed = await b2.recv(10);
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
		await c.recv(10);
		outcomes.push((await c.call("duet_send", { text: `pong ${i}` })).isError ? "refused" : "sent");
	}
	const reset = await c.call("duet_send", { text: "user said go on", user_asked: true });
	check(
		"loop cap: replies on its own stop at the cap, user_asked resets",
		outcomes.join() === "sent,sent,sent,refused,refused" && !reset.isError,
		`cap 3: replies ${outcomes.join(", ")}; then user_asked send: ${reset.isError ? "refused" : "sent"}`,
	);

	// Codex: once a tool call has shown the thread id, arriving messages are pushed with `codex queue`,
	// but only while a Codex window is open in the server's folder: here a `sleep` named codex.
	mkdirSync(join(ROOT, "bin"), { recursive: true });
	symlinkSync(execFileSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).trim(), join(ROOT, "bin/codex"));
	const codexWindow = windows[windows.push(spawn(join(ROOT, "bin/codex"), ["600"], { cwd: process.cwd(), stdio: "ignore" })) - 1];
	const qlog = join(ROOT, "codex-queue.log");
	const fakeCodex = join(ROOT, "fake-codex.mjs");
	writeFileSync(fakeCodex, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(qlog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nconsole.log("Queued message");\n`);
	chmodSync(fakeCodex, 0o755);
	const queued = () => (existsSync(qlog) ? readFileSync(qlog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
	const cRoom = freshRoom();
	const g = startServer("gina", cRoom, { env: { DUET_MODE: "auto", DUET_CODEX_BIN: fakeCodex, DUET_MAX_AUTO: "2" } });
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

	// Closing the Codex window stops the pushes: Codex would otherwise run the turn with nobody there.
	codexWindow.kill();
	await sleep(500);
	const beforeClose = queued().length;
	await h.call("duet_send", { text: "AFTER-WINDOW-CLOSED", user_asked: true });
	await sleep(2000);
	const closedStatus = (await g.call("duet_status")).text;
	const closedInbox = await g.call("duet_inbox", {}, meta("user"));
	check(
		"Codex: no push once the window is closed",
		queued().length === beforeClose && closedStatus.includes("no Codex window open") && closedInbox.text.includes("AFTER-WINDOW-CLOSED"),
		`pushes after close: ${queued().length - beforeClose}; status: ${closedStatus.split("— ")[1]}`,
	);
	const codexWindow2 = windows[windows.push(spawn(join(ROOT, "bin/codex"), ["600"], { cwd: process.cwd(), stdio: "ignore" })) - 1];

	// A slow `codex queue` racing a duet_inbox: every message reaches the model exactly once.
	const slowLog = join(ROOT, "slow-queue.log");
	const slowCodex = join(ROOT, "slow-codex.mjs");
	writeFileSync(slowCodex, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nawait new Promise((r) => setTimeout(r, 2000));\nappendFileSync(${JSON.stringify(slowLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
	chmodSync(slowCodex, 0o755);
	const rRoom = freshRoom();
	const r1 = startServer("rita", rRoom, { env: { DUET_MODE: "auto", DUET_CODEX_BIN: slowCodex } });
	const r2 = startServer("rob", rRoom);
	await r1.init("codex-mcp-client");
	await r2.init();
	await Promise.all([waitConnected(r1), waitConnected(r2)]);
	await r1.call("duet_status", {}, meta("user"));
	await r2.call("duet_send", { text: "RACE-1", user_asked: true });
	await sleep(700); // RACE-1 is now on its way through the slow codex queue
	await r2.call("duet_send", { text: "RACE-2", user_asked: true });
	await sleep(700);
	const raceInbox = await r1.call("duet_inbox", {}, meta("user"));
	await sleep(5000);
	const slowPushed = existsSync(slowLog) ? readFileSync(slowLog, "utf8") : "";
	const seen = (t) => (raceInbox.text.split(t).length - 1) + (slowPushed.split(t).length - 1);
	check(
		"Codex push racing duet_inbox: each message shown exactly once",
		seen("RACE-1") === 1 && seen("RACE-2") === 1 && slowPushed.includes("RACE-1") && !raceInbox.text.includes("RACE-1"),
		`RACE-1 pushed ${slowPushed.includes("RACE-1")}, in inbox ${raceInbox.text.includes("RACE-1")}; RACE-2 pushed ${slowPushed.includes("RACE-2")}, in inbox ${raceInbox.text.includes("RACE-2")}`,
	);

	// Windows: no push at all (the codex shim would put the peer's text through cmd.exe), even with a
	// Codex window open; the same setup without the Windows switch does push (control).
	const wRoom = freshRoom();
	const wlog = join(ROOT, "win-queue.log");
	const winCodex = join(ROOT, "win-codex.mjs");
	writeFileSync(winCodex, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(wlog)}, "called\\n");\n`);
	chmodSync(winCodex, 0o755);
	const w1 = startServer("wim", wRoom, { env: { DUET_MODE: "auto", DUET_CODEX_BIN: winCodex, DUET_TEST_PLATFORM: "win32" } });
	const w2 = startServer("wes", wRoom);
	await w1.init("codex-mcp-client");
	await w2.init();
	await Promise.all([waitConnected(w1), waitConnected(w2)]);
	await w1.call("duet_status", {}, meta("user"));
	await w2.call("duet_send", { text: "WIN & calc.exe", user_asked: true });
	await sleep(2000);
	const winInbox = await w1.call("duet_inbox", {}, meta("user"));
	const winCalled = existsSync(wlog);
	const c1 = startServer("cal", wRoom, { env: { DUET_MODE: "auto", DUET_CODEX_BIN: winCodex } });
	await c1.init("codex-mcp-client");
	await waitConnected(c1);
	await c1.call("duet_status", {}, meta("user"));
	await w2.call("duet_send", { text: "CONTROL", to: "cal", user_asked: true });
	await until(() => existsSync(wlog), 5000, "control push").catch(() => {});
	const controlPushed = existsSync(wlog);
	await c1.stop();
	codexWindow2.kill();
	check(
		"Windows: never pushes through codex, messages wait in the inbox",
		!winCalled && winInbox.text.includes("WIN & calc.exe") && controlPushed,
		`with a Codex window open: shim called on "win32": ${winCalled}; inbox has the message: ${winInbox.text.includes("WIN & calc.exe")}; control (same, not win32) pushed: ${controlPushed}`,
	);

	// Peer names are letters, digits, . _ - only; anything else is dropped as noise.
	await publish(SERVER, topicFor(wRoom), envelope({ fromId: "evil", from: 'x" & calc', kind: "msg", text: "BAD-NAME" }));
	await publish(SERVER, topicFor(wRoom), envelope({ fromId: "nice", from: "Ünïcode_ok-1.2", kind: "msg", text: "GOOD-NAME" }));
	await sleep(1500);
	const names = await w1.call("duet_inbox", {}, meta("user"));
	check("peer names are checked", !names.text.includes("BAD-NAME") && names.text.includes("GOOD-NAME"), JSON.stringify(names.text.slice(0, 120)));

	// The status line names the room by its first characters only.
	const sRoom = freshRoom();
	const s1 = startServer("sam", sRoom);
	await s1.init();
	await waitConnected(s1);
	const st = await s1.call("duet_status");
	check("status doesn't show the room code", !st.text.includes(sRoom) && st.text.includes(sRoom.slice(0, 4)), st.text);

	// Two windows starting at the same moment: exactly one gets the room.
	const lockRoom = freshRoom();
	let owners = [];
	for (let i = 0; i < 8; i++) {
		const home = join(ROOT, `lock-${i}`);
		const pair = [startServer("lou", lockRoom, { home }), startServer("lou", lockRoom, { home })];
		await Promise.all(pair.map((x) => x.init()));
		await sleep(1500);
		const st2 = await Promise.all(pair.map((x) => x.call("duet_status")));
		owners.push(st2.filter((x) => /— (connected|connecting)/.test(x.text)).length);
		for (const x of pair) await x.stop();
	}
	check("simultaneous start: one owner", owners.every((n) => n === 1), `owners per try: ${owners.join(", ")}`);

	// A relay that isn't a plain http(s) URL is refused before anything runs.
	const bad = await new Promise((r) => {
		const p = spawn(process.execPath, [BIN, "--room", "r", "--name", "n", "--server", "http://x;touch /tmp/duet-pwned"], { env: { HOME: ROOT, PATH: process.env.PATH } });
		let err = "";
		p.stderr.on("data", (d) => (err += d));
		p.on("exit", (code) => r({ code, err }));
	});
	check("bad --server refused", bad.code === 1 && bad.err.includes("--server must be"), `exit ${bad.code}: ${bad.err.trim()}`);

	// A NUL byte in a peer's text is dropped as noise: normal traffic, pushes and tool calls go on.
	const nRoom = freshRoom();
	const nlog = join(ROOT, "nul-queue.log");
	const nulCodex = join(ROOT, "nul-codex.mjs");
	writeFileSync(nulCodex, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(nlog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
	chmodSync(nulCodex, 0o755);
	const nulWindow = windows[windows.push(spawn(join(ROOT, "bin/codex"), ["600"], { cwd: process.cwd(), stdio: "ignore" })) - 1];
	const n1 = startServer("nell", nRoom, { env: { DUET_MODE: "auto", DUET_CODEX_BIN: nulCodex } });
	await n1.init("codex-mcp-client");
	await waitConnected(n1);
	await n1.call("duet_status", {}, meta("user"));
	// Sent raw: our own publish() refuses a NUL, a hostile peer's client needn't.
	await fetch(`${SERVER}/${topicFor(nRoom)}`, { method: "POST", body: JSON.stringify(envelope({ fromId: "evil", from: "eve", kind: "msg", text: "EVIL\u0000NUL" })) });
	await publish(SERVER, topicFor(nRoom), envelope({ fromId: "nice", from: "nate", kind: "msg", text: "NORMAL-AFTER" }));
	await until(() => existsSync(nlog) && readFileSync(nlog, "utf8").includes("NORMAL-AFTER"), 5000, "the normal message pushed").catch(() => {});
	const nulPushed = existsSync(nlog) ? readFileSync(nlog, "utf8") : "";
	const nulSend = await n1.call("duet_send", { text: "still fine", user_asked: true });
	const nulStatus = await n1.request("tools/call", { name: "duet_status", arguments: {} });
	nulWindow.kill();
	check(
		"a NUL in a peer's text can't wedge anything",
		nulPushed.includes("NORMAL-AFTER") && !nulPushed.includes("EVIL") && !nulSend.isError && !!nulStatus.result && !nulStatus.result.isError,
		`normal message pushed: ${nulPushed.includes("NORMAL-AFTER")}; NUL message pushed: ${nulPushed.includes("EVIL")}; duet_send after: ${nulSend.text.slice(0, 30)}; duet_status ok: ${!!nulStatus.result}`,
	);

	// A crafted ts (not a string) is dropped as noise; an unparseable one just shows no time. Neither
	// stops the messages around it.
	const tRoom = freshRoom();
	const t1 = startServer("tess", tRoom);
	await t1.init();
	await waitConnected(t1);
	const raw = (env) => fetch(`${SERVER}/${topicFor(tRoom)}`, { method: "POST", body: JSON.stringify(env) });
	await raw({ ...envelope({ fromId: "evil", from: "eve", kind: "msg", text: "TS-OBJECT" }), ts: { valueOf: "x", toString: "y" } });
	await raw({ ...envelope({ fromId: "odd", from: "oz", kind: "msg", text: "TS-GARBAGE" }), ts: "not a time" });
	await publish(SERVER, topicFor(tRoom), envelope({ fromId: "nice", from: "nate", kind: "msg", text: "TS-NORMAL" }));
	await sleep(1500);
	const tsInbox = await t1.call("duet_inbox");
	const tsAgain = await t1.call("duet_inbox");
	check(
		"a crafted ts can't lose messages",
		!tsInbox.isError && !tsInbox.text.includes("TS-OBJECT") && tsInbox.text.includes("[duet] from oz (the other person's agent, on their computer):") && tsInbox.text.includes("TS-NORMAL") && tsAgain.text === "No new duet messages.",
		JSON.stringify(tsInbox.text.replace(/\n+/g, " ").slice(0, 260)),
	);
	// The sender refuses a NUL itself (receivers would drop it).
	const nulOut = await t1.call("duet_send", { text: "a\u0000b", user_asked: true });
	check("a NUL is refused by the sender", nulOut.isError && nulOut.text.includes("NUL"), nulOut.text);

	// A refused unattended send doesn't use up the cap: with cap 1, after a received message, a
	// refused send leaves the one allowed reply.
	const capRoom2 = freshRoom();
	const u1 = startServer("uma", capRoom2, { env: { DUET_MAX_AUTO: "1" } });
	const u2 = startServer("udo", capRoom2);
	await Promise.all([u1.init(), u2.init()]);
	await Promise.all([waitConnected(u1), waitConnected(u2)]);
	await u2.call("duet_send", { text: "hi", user_asked: true });
	await u1.recv(10);
	const refusedFirst = await u1.call("duet_send", { text: "bad\u0000" });
	const thenReply = await u1.call("duet_send", { text: "the one allowed reply" });
	check("a refused send doesn't use up the cap", refusedFirst.isError && !thenReply.isError, `cap 1: NUL send ${refusedFirst.isError ? "refused" : "sent"}, then the reply ${thenReply.isError ? "refused" : "sent"}`);

	// The name rule and addressing, directly.
	const nameCases = [isName("nika"), !isName("_nika"), !isName("\u0301"), isName("Jose\u0301"), fitName("_x") === "x", fitName("nika@laptop") === "nika-laptop", isForMe({ fromId: "p", to: "Jose\u0301" }, "me", "Jos\u00e9")];
	check("name rule and NFC addressing", nameCases.every(Boolean), `cases: ${nameCases.join(", ")}`);

	// A failed push: the message goes back to duet_inbox as soon as the push fails; then pushes pause,
	// so duet_inbox has the next one too.
	const fRoom = freshRoom();
	const failCodex = join(ROOT, "fail-codex.mjs");
	const failLog = join(ROOT, "fail-queue.log");
	writeFileSync(failCodex, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(failLog)}, "call\\n");\nsetTimeout(() => { console.error("queue is down"); process.exit(1); }, 1500);\n`);
	const failCalls = () => (existsSync(failLog) ? readFileSync(failLog, "utf8").split("\n").filter(Boolean).length : 0);
	chmodSync(failCodex, 0o755);
	const failWindow = windows[windows.push(spawn(join(ROOT, "bin/codex"), ["600"], { cwd: process.cwd(), stdio: "ignore" })) - 1];
	const f1 = startServer("fay", fRoom, { env: { DUET_MODE: "auto", DUET_CODEX_BIN: failCodex, DUET_PUSH_PAUSE_MS: "4000" } });
	const f2 = startServer("finn", fRoom);
	await f1.init("codex-mcp-client");
	await f2.init();
	await Promise.all([waitConnected(f1), waitConnected(f2)]);
	await f1.call("duet_status", {}, meta("user"));
	await f2.call("duet_send", { text: "AFTER-FAILED-PUSH", user_asked: true });
	await sleep(400); // the push is now in flight (it fails after 1.5 s)
	const t0f = Date.now();
	const fGot = await f1.recv(10, meta("user")).then((r) => ({ r, at: Date.now() - t0f }));
	await f2.call("duet_send", { text: "DURING-PAUSE", user_asked: true });
	await sleep(1000);
	const fStatus = await f1.call("duet_status");
	const fInbox = await f1.call("duet_inbox", {}, meta("user"));
	const callsBefore = failCalls();
	await f2.call("duet_send", { text: "WAITS-FOR-RETRY", user_asked: true });
	await sleep(5500); // the 4 s pause ends; the retry must push it without any other nudge
	const retried = failCalls() > callsBefore;
	failWindow.kill();
	check(
		"a failed push hands the message back to duet_inbox, then pauses",
		fGot.r.text.includes("AFTER-FAILED-PUSH") && fGot.at >= 700 && fGot.at < 5000 && callsBefore >= 1 && fInbox.text.includes("DURING-PAUSE") && fStatus.text.includes("push to Codex failed") && retried,
		`duet_inbox, asked during the failing push, had the message after ${fGot.at}ms (push in flight: ${callsBefore} codex call(s)); inbox during the pause: ${JSON.stringify(fInbox.text.slice(0, 60))}; status: ${fStatus.text.split("— ")[1]?.slice(0, 100)}; retried after the pause with no nudge: ${retried}`,
	);

	// What counts as an open Codex window: real argument shapes, as /proc shows them (tail -F stands
	// in for a long-running codex; argv0 gives it the name).
	const wRoom2 = freshRoom();
	const wqlog = join(ROOT, "shape-queue.log");
	const shapeCodex = join(ROOT, "shape-codex.mjs");
	writeFileSync(shapeCodex, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(wqlog)}, "x\\n");\n`);
	chmodSync(shapeCodex, 0o755);
	const s3 = startServer("sid", wRoom2, { env: { DUET_MODE: "auto", DUET_CODEX_BIN: shapeCodex } });
	const s4 = startServer("sol", wRoom2);
	await s3.init("codex-mcp-client");
	await s4.init();
	await Promise.all([waitConnected(s3), waitConnected(s4)]);
	await s3.call("duet_status", {}, meta("user"));
	const tail = execFileSync("sh", ["-c", "command -v tail"], { encoding: "utf8" }).trim();
	const shapes = [
		[["-F", "exec"], false],
		[["-s", "5", "-F", "app-server"], false],
		[["--add-dir", "/x", "-F", "exec"], false],
		[["-F", "fix the mcp tests"], true],
		[["-F", "resume"], true],
		[[], true], // plain `codex`: cat on an open pipe, no arguments at all
	];
	const verdicts = [];
	for (const [args, expected] of shapes) {
		const before = existsSync(wqlog) ? readFileSync(wqlog, "utf8").length : 0;
		const cat = execFileSync("sh", ["-c", "command -v cat"], { encoding: "utf8" }).trim();
		const w = args.length
			? spawn(tail, args, { argv0: join(ROOT, "bin/codex"), cwd: process.cwd(), stdio: "ignore" })
			: spawn(cat, [], { argv0: join(ROOT, "bin/codex"), cwd: process.cwd(), stdio: ["pipe", "ignore", "ignore"] });
		windows.push(w);
		await sleep(300);
		await s4.call("duet_send", { text: `SHAPE ${args.join(" ")}`, user_asked: true });
		await sleep(1200);
		const pushed = (existsSync(wqlog) ? readFileSync(wqlog, "utf8").length : 0) > before;
		w.kill();
		await s3.call("duet_inbox", {}, meta("user")); // empty it for the next shape
		verdicts.push({ shape: `codex ${args.slice(args.indexOf("-F") + 1).join(" ") || "(none)"}${args[0]?.startsWith("-") && args[0] !== "-F" ? ` (after ${args.slice(0, 2).join(" ")})` : ""}`, expected, pushed });
	}
	check(
		"Codex window check: exec / app-server are not windows; a prompt, resume or plain codex are",
		verdicts.every((v) => v.pushed === v.expected),
		verdicts.map((v) => `${v.shape}: ${v.pushed ? "pushed" : "held"}${v.pushed === v.expected ? "" : " (WRONG)"}`).join("; "),
	);

	// A name outside the rule is refused at start: peers would drop everything sent under it.
	const badName = await new Promise((r) => {
		const p = spawn(process.execPath, [BIN, "--room", "r", "--name", "Nika Q", "--server", SERVER], { env: { HOME: ROOT, PATH: process.env.PATH } });
		let err = "";
		p.stderr.on("data", (d) => (err += d));
		p.on("exit", (code) => r({ code, err }));
	});
	const underscore = await new Promise((r) => {
		const p = spawn(process.execPath, [BIN, "--room", "r", "--name", "_x", "--server", SERVER], { env: { HOME: ROOT, PATH: process.env.PATH } });
		let err = "";
		p.stderr.on("data", (d) => (err += d));
		p.on("exit", (code) => r({ code, err }));
	});
	check("bad --name refused", badName.code === 1 && badName.err.includes("--name may only use") && underscore.code === 1 && underscore.err.includes("start with a letter or digit"), `"Nika Q": exit ${badName.code}; "_x": exit ${underscore.code}: ${underscore.err.trim()}`);

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
			toml.includes('args = ["-y", "github:qaioz/pi-duet", "--room", "r00m", "--name", "nika"]') && toml.includes("tool_timeout_sec = 1800") && !toml.includes("PreToolUse") &&
			toml.includes('default_tools_approval_mode = "approve"'),
		toml.replace(/\n/g, " ⏎ "),
	);
	// Its arguments: the site's placeholder name and a flag with no value are refused; Claude Code has
	// the plugin, so there is no `setup claude`.
	const runSetup = (args) =>
		new Promise((r) => {
			const p = spawn(process.execPath, [BIN, "setup", ...args], { env: { HOME: codexHome, PATH: process.env.PATH, CODEX_HOME: codexHome } });
			let out = "";
			p.stdout.on("data", (d) => (out += d));
			p.stderr.on("data", (d) => (out += d));
			p.on("exit", (code) => r({ code, out }));
		});
	const placeholder = await runSetup(["codex", "--room", "r00m", "--name", "YOUR_NAME"]);
	const noValue = await runSetup(["codex", "--room", "--name", "nika"]);
	const claudeSetup = await runSetup(["claude", "--room", "r00m", "--name", "nika"]);
	check(
		"setup: placeholder name and missing values refused; no setup claude",
		placeholder.code === 1 && placeholder.out.includes("placeholder") && noValue.code === 1 && noValue.out.includes("--room needs a value") && claudeSetup.code === 1 && claudeSetup.out.includes("usage: setup codex"),
		`YOUR_NAME: exit ${placeholder.code}; "--room --name nika": exit ${noValue.code}; setup claude: exit ${claudeSetup.code} ${JSON.stringify(claudeSetup.out.trim().slice(0, 80))}`,
	);

	// Interop with the pi extension's wire format: a hand-made envelope from "pi" arrives.
	await publish(SERVER, topicFor(room), envelope({ fromId: "pi-install", from: "pia", kind: "msg", text: "FROM-PI" }));
	const fromPi = await b.recv(10);
	check("receives a pi-format envelope", fromPi.text.includes("[duet] from pia") && fromPi.text.includes("FROM-PI"), fromPi.text.slice(0, 80));

	await gateTwo();

	// No room configured: tools explain instead of crashing.
	const n = startServer("nobody", "", { args: [] });
	await n.init();
	const noRoom = await n.call("duet_send", { text: "x" });
	check("no room: clear error", noRoom.isError && noRoom.text.includes("duet_join"), noRoom.text);

	// Clean exit gives the lock back.
	for (const s of [...live]) await s.stop();
	const locks = readdirSync(join(ROOT, "bob", ".duet")).filter((f) => f.endsWith(".lock"));
	check("closing releases the lock", locks.length === 0, `lock files left in bob's ~/.duet: ${locks.length}`);
}

// Gate 2 on the stdio server, by host: a host with forms (any, not only Codex) asks Send / Don't send
// in ask mode; a chat app that draws panels gets the reply card and duet holds the reply until the
// click (duet_reply), and a held reply expires unsent; a host with neither sends at once.
async function gateTwo() {
	const room = freshRoom();
	const peerSeen = [];
	const { subscribe } = await import("../transport.js");
	const sub = subscribe({ server: SERVER, topic: topicFor(room), onEnvelope: (e) => peerSeen.push(e) });
	const said = (t) => peerSeen.some((e) => e.kind === "msg" && e.text === t);

	// A host with forms: the whole reply in the form.
	const f = startServer("formhost", room);
	await f.init("some-ide", { caps: { elicitation: { form: {} } } });
	await waitConnected(f);
	await sleep(500);
	const answer = async (choice) => {
		const ask = await until(() => f.notes.find((n) => n.method === "elicitation/create" && !n.answered), 10_000, "a form");
		ask.answered = true;
		f.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ask.id, result: { action: "accept", content: { answer: choice } } }) + "\n");
		return ask;
	};
	const p1 = f.call("duet_send", { text: "FORM-SEND", user_asked: true });
	const a1 = await answer("Send");
	const r1 = await p1;
	const p2 = f.call("duet_send", { text: "FORM-DROP", user_asked: true });
	await answer("Don't send");
	const r2 = await p2;
	await until(() => said("FORM-SEND"), 8000, "FORM-SEND").catch(() => {});
	await sleep(1000);
	check(
		"gate 2 (forms): every reply in ask mode waits for Send; Don't send sends nothing",
		/^duet · send to .+\? · full reply\n\nFORM-SEND$/.test(a1.params.message) && r1.text.startsWith("Sent to") && said("FORM-SEND") && /^Not sent/.test(r2.text) && !said("FORM-DROP"),
		`form ${JSON.stringify(a1.params.message)}; ${r1.text}; ${r2.text.slice(0, 40)}; at the peer: FORM-SEND ${said("FORM-SEND")}, FORM-DROP ${said("FORM-DROP")}`,
	);
	await f.stop();

	// A chat app (draws MCP Apps): duet_send only holds; the card's click sends.
	const UI = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
	const c = startServer("chatapp", room, { env: { DUET_HOLD_MS: "4000" } });
	await c.init("claude-ai", { caps: UI });
	await waitConnected(c);
	await sleep(500);
	const tools = (await c.request("tools/list")).result.tools;
	const sendTool = tools.find((t) => t.name === "duet_send");
	const replyTool = tools.find((t) => t.name === "duet_reply");
	const card = (await c.request("resources/read", { uri: "ui://duet/send" })).result?.contents?.[0];
	const raw = async (name, a) => (await c.request("tools/call", { name, arguments: a })).result;
	const held = await raw("duet_send", { text: "HOLD-1\nall of it" });
	const again = await raw("duet_send", { text: "HOLD-1\nall of it" }); // the model resends: the same card
	const id = held._meta?.["duet/hold"];
	await sleep(1500);
	const notYet = said("HOLD-1\nall of it");
	const panel = (await raw("duet_room_state", {})).structuredContent;
	const st = (await raw("duet_reply", { id, action: "status" })).structuredContent;
	const sent = (await raw("duet_reply", { id, action: "send" })).structuredContent;
	await until(() => said("HOLD-1\nall of it"), 8000, "held reply after the click").catch(() => {});
	const twice = (await raw("duet_reply", { id, action: "send" })).structuredContent;
	await sleep(800);
	const copies = peerSeen.filter((e) => e.text === "HOLD-1\nall of it").length;
	check(
		"gate 2 (chat app): duet_send holds the reply (\"Waiting for your OK in the duet card\"), the card has it; sent only on the click, once",
		sendTool?._meta?.ui?.resourceUri === "ui://duet/send" && JSON.stringify(replyTool?._meta?.ui?.visibility) === '["app"]' && card?.mimeType === "text/html;profile=mcp-app" &&
			held.content[0].text === "Waiting for your OK in the duet card" && !JSON.stringify(held.content).includes(id) && held.structuredContent.text === "HOLD-1\nall of it" &&
			again._meta?.["duet/hold"] === id && !notYet && panel.outgoing?.length === 1 && st.status === "waiting" && sent.status === "sent" && twice.status === "sent" && copies === 1,
		`result: ${held.content[0].text}; card ${card?.text?.length} bytes; resend → same hold: ${again._meta?.["duet/hold"] === id}; before the click at the peer: ${notYet}; panel lists ${panel.outgoing?.length}; status ${st.status} → ${sent.status}; copies at the peer: ${copies}`,
	);
	const dropped = await raw("duet_send", { text: "HOLD-DROP" });
	const dr = (await raw("duet_reply", { id: dropped._meta["duet/hold"], action: "drop" })).structuredContent;
	const expiring = await raw("duet_send", { text: "HOLD-EXPIRE" });
	await sleep(5000);
	const ex = (await raw("duet_reply", { id: expiring._meta["duet/hold"], action: "send" })).structuredContent;
	const guess = (await raw("duet_reply", { id: "not-a-hold", action: "send" })).structuredContent;
	await sleep(1000);
	check(
		"gate 2 (chat app): Don't send drops it; a reply nobody clicks expires unsent; a made-up id sends nothing",
		dr.status === "dropped" && ex.status === "expired" && guess.status === "expired" && !said("HOLD-DROP") && !said("HOLD-EXPIRE"),
		`drop → ${dr.status}; after the hold time → ${ex.status}; made-up id → ${guess.status}; at the peer: ${["HOLD-DROP", "HOLD-EXPIRE"].filter(said).join(", ") || "neither"}`,
	);
	await c.stop();
	sub.stop();
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
