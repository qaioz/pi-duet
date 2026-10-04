// Unit tests for the Claude Code mod's pure parts (hooks/wire.js, hooks/guard.js), and wire
// compatibility with transport.js, which pi and the MCP server use. No network, no model.
//
//   node test/mod-unit.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import * as transport from "../transport.js";
import { checkPeerTool, inside, resolvePath } from "../hooks/guard.js";
import * as wire from "../hooks/wire.js";

test("topic hash matches transport.js", async () => {
	for (const room of ["amber-otter-4821-x7q2", "t-1", "Ünïcode-room"]) {
		assert.equal(await wire.topicFor(room), transport.topicFor(room));
	}
});

test("the mod's envelopes are valid for the mod, and addressed the same way as transport.js", () => {
	const msg = wire.envelope({ fromId: "a", from: "gaioz", kind: "msg", text: "hi", by: "agent", to: "karlo" });
	const join = wire.envelope({ fromId: "a", from: "gaioz", kind: "join", via: "claude-code" });
	const note = wire.envelope({ fromId: "a", from: "gaioz", kind: "note", note: "declined" });
	assert.ok(wire.isEnvelope(msg) && wire.isEnvelope(join) && wire.isEnvelope(note));
	assert.ok(transport.isForMe(msg, "b", "karlo"));
	assert.equal(transport.isForMe(msg, "b", "someone-else"), false);
});

test("transport.js's isEnvelope rejects note and accepts msg/join with extra fields", async () => {
	// Feed envelopes through transport.subscribe against a tiny fake ntfy server.
	const { createServer } = await import("node:http");
	const lines = [
		wire.envelope({ fromId: "a", from: "gaioz", kind: "note", note: "declined" }),
		wire.envelope({ fromId: "a", from: "gaioz", kind: "msg", text: "hello", by: "person" }),
		wire.envelope({ fromId: "a", from: "gaioz", kind: "join", via: "claude-code" }),
	].map((env, i) => JSON.stringify({ id: "m" + i, time: Math.floor(Date.now() / 1000), event: "message", message: JSON.stringify(env) }) + "\n");
	const srv = createServer((req, res) => {
		res.writeHead(200, { "content-type": "application/x-ndjson" });
		for (const l of lines) res.write(l);
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const got = [];
	const sub = transport.subscribe({ server: `http://127.0.0.1:${srv.address().port}`, topic: "t", onEnvelope: (e) => got.push(e.kind) });
	const end = Date.now() + 3000;
	while (got.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
	sub.stop();
	srv.closeAllConnections();
	srv.close();
	assert.deepEqual(got, ["msg", "join"]);
});

test("isEnvelope rejects malformed and unknown notes", () => {
	const base = { v: 1, fromId: "a", from: "gaioz", ts: new Date().toISOString() };
	assert.equal(wire.isEnvelope({ ...base, kind: "note", note: "pwned" }), false);
	assert.equal(wire.isEnvelope({ ...base, kind: "msg", text: "a\0b" }), false);
	assert.equal(wire.isEnvelope({ ...base, kind: "msg", text: "x".repeat(4 * wire.MAX_BYTES + 1) }), false);
	assert.equal(wire.isEnvelope({ ...base, from: "bad name", kind: "join" }), false);
	assert.equal(wire.isEnvelope({ ...base, kind: "other" }), false);
});

test("names and room codes", () => {
	assert.equal(wire.fitName("Gaioz Q"), "Gaioz-Q");
	assert.equal(wire.fitName("--x"), "x");
	assert.ok(wire.isPlaceholderName("YOUR_NAME"));
	for (let i = 0; i < 50; i++) assert.ok(wire.isRoomCode(wire.newRoomCode()));
	assert.equal(wire.isRoomCode("ab"), false);
	assert.equal(wire.isRoomCode("a b c"), false);
	assert.equal(wire.isRoomCode('x"; rm'), false);
});

test("sanitize strips control characters and ANSI, caps length", () => {
	assert.equal(wire.sanitize("a\r\nb\x1b[31mred\x1b[0m\x07\u2028c"), "a\nbredc");
	assert.equal(wire.sanitize("tab\there"), "tab\there");
	const long = wire.sanitize("y".repeat(20000));
	assert.ok(long.length < 10000 && long.includes("more characters"));
	assert.ok(wire.preview("1\n2\n3\n4\n5\n6", 4).includes("2 more lines"));
});

test("frameForClaude names the sender, the folder and the tool", () => {
	const env = wire.envelope({ fromId: "a", from: "karlo", kind: "msg", text: "run tests" });
	const t = wire.frameForClaude([env], "/work/repo", "mcp__duet__send");
	assert.match(t, /from karlo \(the other person's agent/);
	assert.match(t, /"Your folder" means \/work\/repo/);
	assert.match(t, /call the mcp__duet__send tool/);
	const person = wire.frameForClaude([{ ...env, by: "person" }], "/w", "x");
	assert.match(person, /typing to you directly/);
});

test("guard: paths", () => {
	assert.equal(resolvePath("a/../b/./c", "/w/r", "/h"), "/w/r/b/c");
	assert.equal(resolvePath("~/x", "/w", "/home/g"), "/home/g/x");
	assert.equal(inside("/w/r/src/a.js", "/w/r", "/h"), "src/a.js");
	assert.equal(inside("/w/r", "/w/r", "/h"), "");
	assert.equal(inside("/w/rx/a", "/w/r", "/h"), null);
	assert.equal(inside("../other/a", "/w/r", "/h"), null);
	assert.equal(inside("C:\\Users\\k\\repo\\a.txt", "c:/users/k/repo", ""), "a.txt");
});

test("guard: what a peer turn may do", () => {
	const ctx = { cwd: "/w/r", home: "/home/g", peer: "karlo", sendTool: "mcp__duet__send" };
	const ok = (e) => assert.equal(checkPeerTool(e, ctx), null, JSON.stringify(e));
	const no = (e, re) => assert.match(checkPeerTool(e, ctx) ?? "", re, JSON.stringify(e));
	ok({ tool: "Read", file_path: "/w/r/README.md" });
	ok({ tool: "Edit", file_path: "src/a.js" });
	ok({ tool: "Bash", command: "npm test" });
	ok({ tool: "mcp__duet__send", text: "hi" });
	ok({ tool: "Grep", pattern: "x" });
	no({ tool: "Read", file_path: "/home/g/.ssh/id_ed25519" }, /outside/);
	no({ tool: "Write", file_path: "~/notes.txt" }, /outside/);
	no({ tool: "Write", file_path: "/w/r/../escape.txt" }, /outside/);
	no({ tool: "Edit", file_path: "/w/r/.claude/settings.json" }, /controls what runs/);
	no({ tool: "Write", file_path: ".git/hooks/pre-commit" }, /controls what runs/);
	no({ tool: "Write", file_path: "CLAUDE.md" }, /controls what runs/);
	no({ tool: "NotebookEdit", notebook_path: "/tmp/n.ipynb" }, /outside/);
	no({ tool: "Bash", command: "sleep 99", run_in_background: true }, /background/);
	no({ tool: "CronCreate", cron: "* * * * *", prompt: "x" }, /CronCreate tool is off/);
	no({ tool: "ScheduleWakeup" }, /off/);
	no({ tool: "mcp__github__create_pull_request" }, /off/);
	no({ tool: "Agent", prompt: "x", isolation: "remote" }, /remote/);
	no({ tool: "Agent", prompt: "x", run_in_background: true }, /background agents/);
	no({ tool: "WebFetch", url: "https://example.com/?d=secret", prompt: "x" }, /WebFetch is off/);
	ok({ tool: "WebSearch", query: "x" });
	no({ tool: "Grep", pattern: "x", path: "/etc" }, /outside/);
	// Review findings: every segment, any case, Windows spellings, other path fields, skills, agents.
	no({ tool: "Write", file_path: "src/CLAUDE.md" }, /controls what runs/);
	no({ tool: "Edit", file_path: "pkg/.claude/settings.json" }, /controls what runs/);
	no({ tool: "Write", file_path: ".Claude/settings.json" }, /controls what runs/);
	no({ tool: "Write", file_path: "claude.md" }, /controls what runs/);
	no({ tool: "Write", file_path: ".git./hooks/pre-commit" }, /controls what runs/);
	no({ tool: "Write", file_path: ".git::$INDEX_ALLOCATION/hooks/x" }, /controls what runs/);
	no({ tool: "Write", file_path: "CLAUDE~1.MD" }, /controls what runs/);
	no({ tool: "Write", file_path: "AGENTS.md" }, /controls what runs/);
	no({ tool: "LSP", operation: "hover", filePath: "/home/g/secret.ts", line: 1, character: 1 }, /outside/);
	no({ tool: "Glob", pattern: "/home/g/**/*.pem" }, /outside/);
	no({ tool: "Glob", pattern: "../**/*" }, /outside/);
	no({ tool: "Skill", skill: "anything" }, /Skill tool is off/);
	no({ tool: "Agent", prompt: "x", subagent_type: "my-custom-agent" }, /built-in agent types/);
	ok({ tool: "Agent", prompt: "x", subagent_type: "Explore" });
	no({ tool: "Write", file_path: "GIT~1/hooks/pre-commit" }, /controls what runs/);
	no({ tool: "Glob", pattern: "src/../../**/*.pem" }, /outside/);
	ok({ tool: "Read", file_path: ".claude/settings.json" }); // reading inside the folder is fine
	ok({ tool: "Glob", pattern: "src/**/*.ts" });
	ok({ tool: "LSP", operation: "hover", filePath: "src/a.ts", line: 1, character: 1 });
});

test("transport.js ignores messages older than 12 hours (a relay may keep 30 days)", async () => {
	const { createServer } = await import("node:http");
	const now = Math.floor(Date.now() / 1000);
	const lines = [
		[now - 13 * 3600, "old request"],
		[now - 60, "fresh request"],
	].map(([time, text], i) => JSON.stringify({ id: "a" + i, time, event: "message", message: JSON.stringify(wire.envelope({ fromId: "x", from: "dato", kind: "msg", text })) }) + "\n");
	const srv = createServer((req, res) => {
		res.writeHead(200, { "content-type": "application/x-ndjson" });
		for (const l of lines) res.write(l);
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const got = [];
	const sub = transport.subscribe({ server: `http://127.0.0.1:${srv.address().port}`, topic: "t", onEnvelope: (e) => got.push(e.text) });
	const end = Date.now() + 3000;
	while (!got.length && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
	await new Promise((r) => setTimeout(r, 200));
	sub.stop();
	srv.closeAllConnections();
	srv.close();
	assert.deepEqual(got, ["fresh request"]);
});

test("the computer-and-folder hash is the same in the plugin and in pi/MCP", async () => {
	assert.equal(await wire.placeFor("/work/repo", "duet_t1", "box-1"), transport.placeFor("/work/repo", "duet_t1", "box-1"));
	assert.notEqual(await wire.placeFor("/work/repo", "duet_t1", "box-1"), await wire.placeFor("/work/other", "duet_t1", "box-1"));
	// Salted per room: the same folder can't be recognised across rooms.
	assert.notEqual(await wire.placeFor("/work/repo", "duet_t1", "box-1"), await wire.placeFor("/work/repo", "duet_t2", "box-1"));
	assert.equal(wire.firstLine("\n  \nfirst real line\nsecond"), "first real line");
	assert.equal(transport.firstLine("x".repeat(100)).length, 80);
});

test("transport.js: a long message arrives from the relay's own /file/; one pointing elsewhere is ignored; an expired one is reported", async () => {
	const { createServer } = await import("node:http");
	const now = Math.floor(Date.now() / 1000);
	const long = wire.envelope({ fromId: "x", from: "dato", kind: "msg", text: "L".repeat(50_000) });
	const evil = wire.envelope({ fromId: "x", from: "dato", kind: "msg", text: "from elsewhere" });
	let base = "";
	const srv = createServer((req, res) => {
		if (req.url === "/file/good.json") return res.writeHead(200).end(JSON.stringify(long));
		if (req.url === "/file/gone.json") return res.writeHead(404).end();
		if (req.url === "/evil.json") return res.writeHead(200).end(JSON.stringify(evil));
		res.writeHead(200, { "content-type": "application/x-ndjson" });
		const att = (id, url) => JSON.stringify({ id, time: now, event: "message", message: "You received a file: attachment.json", attachment: { url, size: 50_100 } }) + "\n";
		res.write(att("a1", "http://127.0.0.1:1/evil.json".replace("127.0.0.1:1", req.headers.host) .replace("/evil", "/evil")));
		res.write(att("a2", `${base}/file/gone.json`));
		res.write(att("a3", `${base}/file/good.json`));
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${srv.address().port}`;
	const got = [];
	let expired = 0;
	const sub = transport.subscribe({ server: base, topic: "t", onEnvelope: (e) => got.push(e.text.length), onExpired: () => expired++ });
	const end = Date.now() + 4000;
	while (!got.length && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
	await new Promise((r) => setTimeout(r, 200));
	sub.stop();
	srv.closeAllConnections();
	srv.close();
	assert.deepEqual(got, [50_000]); // the /evil.json one (not under /file/) never arrives
	assert.equal(expired, 1);
});

test("transport.js publish: up to ~250 KB in one message; more is refused with a clear reason", async () => {
	const { createServer } = await import("node:http");
	let size = 0;
	const srv = createServer((req, res) => {
		let n = 0;
		req.on("data", (c) => (n += c.length));
		req.on("end", () => {
			size = n;
			res.writeHead(200).end("{}");
		});
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${srv.address().port}`;
	await transport.publish(base, "t", wire.envelope({ fromId: "x", from: "gaioz", kind: "msg", text: "y".repeat(150_000) }));
	assert.ok(size > 150_000);
	await assert.rejects(transport.publish(base, "t", wire.envelope({ fromId: "x", from: "gaioz", kind: "msg", text: "y".repeat(300_000) })), /limit is (256 KB|200000)/);
	srv.close();
});

test("a card preview counts the lines of the whole message, not of the shortened one", () => {
	const text = Array.from({ length: 1500 }, (_, i) => "line " + i + " " + "x".repeat(20)).join("\n");
	assert.match(wire.preview(text, 4), /1496 more lines/);
});

test("long-message URLs: only a real upload on this very relay", () => {
	const S = "https://duet.gaioz.online";
	for (const f of [transport.attachmentUrl, wire.attachmentUrl]) {
		assert.equal(f({ url: S + "/file/abc123.json", size: 10 }, S, 300_000), S + "/file/abc123.json");
		for (const url of [S + "/file/../x/json", S + "/file/%2e%2e/x", "https://duet.gaioz.online.evil.com/file/a.json", "https://u@duet.gaioz.online/file/a.json", S + "/file/a.json?x=1", "http://duet.gaioz.online/file/a.json", "https://example.com/file/a.json", S + "/duet_t/json"]) {
			assert.equal(f({ url, size: 10 }, S, 300_000), null, url);
		}
		assert.equal(f({ url: S + "/file/a.json" }, S, 300_000), null, "no size: someone's X-Attach link");
		assert.equal(f({ url: S + "/file/a.json", size: 400_000 }, S, 300_000), null, "too big");
		assert.equal(f({ url: "http://127.0.0.1:18080/sub/file/a.txt", size: 5 }, "http://127.0.0.1:18080/sub", 100), "http://127.0.0.1:18080/sub/file/a.txt");
	}
});

test("transport.js publish refuses more than 200,000 characters (receivers would drop it)", async () => {
	await assert.rejects(transport.publish("http://127.0.0.1:9", "t", wire.envelope({ fromId: "x", from: "a", kind: "msg", text: "é".repeat(200_001) })), /limit is 200000/);
});

test("lock.js: one lock per room and name for every client; stale or dead owners don't count", async () => {
	const { mkdtempSync, writeFileSync, existsSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const lock = await import("../lock.js");
	const dir = mkdtempSync(join(tmpdir(), "duet-lock-"));
	const path = lock.lockPath("https://duet.gaioz.online", "room-1", "gaioz", dir);
	// The plugin names the same file (hooks/duet.js: sha256 of "<relay> <room> <name>", 16 hex).
	assert.equal(path, join(dir, (await wire.sha256hex("https://duet.gaioz.online room-1 gaioz")).slice(0, 16) + ".lock"));
	const a = { client: "codex", token: "a", cwd: "/w/a" };
	const b = { client: "pi", token: "b", cwd: "/w/b" };
	assert.deepEqual(await lock.takeLock(path, a), { ok: true });
	const refused = await lock.takeLock(path, b);
	assert.equal(refused.ok, false);
	assert.match(lock.describeHolder(refused.holder), /^Codex \(pid \d+, \/w\/a\)$/);
	// A Claude Code window's lock (no pid) counts while its beat is fresh.
	writeFileSync(path, JSON.stringify({ v: 2, client: "claude-code", token: "cc", cwd: "/w/c", at: Date.now() }));
	assert.equal((await lock.takeLock(path, b)).ok, false);
	writeFileSync(path, JSON.stringify({ v: 2, client: "claude-code", token: "cc", cwd: "/w/c", at: Date.now() - 61_000 }));
	assert.equal((await lock.takeLock(path, b)).ok, true);
	// The old owner's beat sees another token and lets go; the new one's beat keeps it.
	assert.equal(lock.refreshLock(path, a), false);
	assert.equal(lock.refreshLock(path, b), true);
	// A released lock is free; release removes only one's own.
	writeFileSync(path, JSON.stringify({ v: 2, client: "claude-code", token: "cc", at: 0, released: true }));
	assert.equal(lock.lockHeld(lock.readLock(path)), false);
	await lock.takeLock(path, a);
	lock.releaseLock(path, b);
	assert.equal(existsSync(path), true);
	lock.releaseLock(path, a);
	assert.equal(existsSync(path), false);
});
