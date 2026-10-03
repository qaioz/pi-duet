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
	].map((env, i) => JSON.stringify({ id: "m" + i, time: 1, event: "message", message: JSON.stringify(env) }) + "\n");
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
	ok({ tool: "Read", file_path: ".claude/settings.json" }); // reading inside the folder is fine
	ok({ tool: "Glob", pattern: "src/**/*.ts" });
	ok({ tool: "LSP", operation: "hover", filePath: "src/a.ts", line: 1, character: 1 });
});
