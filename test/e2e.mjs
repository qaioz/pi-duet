// End-to-end tests: two headless pi agents (alice, bob) talking over real ntfy.sh.
//
//   node test/e2e.mjs plumbing            # no model, no cost
//   node test/e2e.mjs talk|do|loop        # real model via OpenRouter (needs OPENROUTER_API_KEY)
//   node test/e2e.mjs install             # installs from GitHub into a throwaway agent dir
//
// Env: PI (pi binary, default "pi"), DUET_TEST_DIR (default ~/coding/personal/duet-test),
//      DUET_MODEL (default deepseek/deepseek-v4-flash), DUET_BUDGET (max OpenRouter key usage, default 3.27).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { envelope, isForMe, MAX_BYTES, publish, subscribe, topicFor } from "../transport.ts";

const PI = process.env.PI || "pi";
const ROOT = process.env.DUET_TEST_DIR || join(homedir(), "coding/personal/duet-test");
// deepseek-chat was flaky at tool calling here (empty completions, invented output); v4-flash was not.
const MODEL = process.env.DUET_MODEL || "deepseek/deepseek-v4-flash";
const BUDGET = Number(process.env.DUET_BUDGET || 3.27);
const EXT = resolve(import.meta.dirname, "../index.ts");
const SERVER = "https://ntfy.sh";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const results = [];
let suite = "";
const live = new Set(); // running agents, stopped (and logged) even when a check throws
function check(name, ok, evidence) {
	results.push({ name, ok, evidence });
	log(ok ? "PASS" : "FAIL", name, "—", evidence);
}
async function until(pred, ms, what) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = pred();
		if (v) return v;
		await sleep(250);
	}
	throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

// ---------- pi agent driver (RPC mode) ----------

function startAgent(name, room, { realModel = false, extraEnv = {}, loadExt = true, agentDir } = {}) {
	const cwd = join(ROOT, name === "alice" ? "a" : "b");
	agentDir ??= join(ROOT, `${name}-agent`);
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, DUET_ROOM: room, DUET_NAME: name, ...extraEnv };
	if (!realModel) env.OPENROUTER_API_KEY = "sk-or-invalid-no-cost"; // turns fail fast, nothing billed
	const args = ["--mode", "rpc", "--no-session", "--provider", "openrouter", "--model", MODEL];
	if (loadExt) args.push("-e", EXT);
	const proc = spawn(PI, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	const agent = { name, cwd, agentDir, proc, events: [], stderr: "", exited: false };
	let buf = "";
	proc.stdout.on("data", (d) => {
		buf += d.toString("utf8");
		let nl;
		// Split on \n only — readline would also split on U+2028 (see pi docs/rpc.md).
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).replace(/\r$/, "");
			buf = buf.slice(nl + 1);
			if (!line) continue;
			try {
				agent.events.push({ at: Date.now(), ...JSON.parse(line) });
			} catch {}
		}
	});
	proc.stderr.on("data", (d) => (agent.stderr += d));
	proc.on("exit", () => (agent.exited = true));
	agent.send = (cmd) => proc.stdin.write(JSON.stringify(cmd) + "\n");
	agent.prompt = (message) => agent.send({ type: "prompt", message });
	agent.stop = async () => {
		// Keep the raw event stream as evidence (never contains the API key).
		mkdirSync(join(ROOT, "logs"), { recursive: true });
		writeFileSync(join(ROOT, "logs", `${suite}-${name}-${Date.now()}.jsonl`), agent.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
		live.delete(agent);
		if (agent.exited) return;
		proc.kill("SIGTERM");
		await until(() => agent.exited, 10_000, `${name} exit`).catch(() => proc.kill("SIGKILL"));
	};
	live.add(agent);
	return agent;
}

const statusOf = (a) => a.events.filter((e) => e.method === "setStatus" && e.statusKey === "duet").at(-1)?.statusText;
const notifies = (a) => a.events.filter((e) => e.method === "notify").map((e) => e.message);
const duetIn = (a) =>
	a.events.filter((e) => e.type === "message_end" && e.message?.customType === "duet").map((e) => e.message.content);
const sends = (a) =>
	a.events.filter((e) => e.type === "tool_execution_start" && e.toolName === "duet_send").map((e) => e.args);
const toolRuns = (a) => a.events.filter((e) => e.type === "tool_execution_start").map((e) => e.toolName);
const bashOutputs = (a) =>
	a.events
		.filter((e) => e.type === "tool_execution_end" && e.toolName === "bash")
		.map((e) => (e.result?.content ?? []).map((c) => c.text ?? "").join(""));
const agentStarts = (a) => a.events.filter((e) => e.type === "agent_start").length;
const busy = (a) => agentStarts(a) > a.events.filter((e) => e.type === "agent_end").length;
const connected = (a) => until(() => statusOf(a) === `duet: ${a.name}`, 20_000, `${a.name} connected`);
const freshRoom = () => `e2e-${randomUUID()}`;
const fromIdOf = (a) => JSON.parse(readFileSync(join(a.agentDir, "duet.json"), "utf8")).fromId;
// Both idle, and nothing new for `quietMs` — the conversation has settled.
async function settle(agents, quietMs, maxMs) {
	const end = Date.now() + maxMs;
	while (Date.now() < end) {
		const last = Math.max(...agents.flatMap((a) => a.events.map((e) => e.at)), 0);
		if (agents.every((a) => !busy(a)) && Date.now() - last > quietMs) return true;
		await sleep(1000);
	}
	return false;
}

// ---------- OpenRouter spend ----------

async function usage() {
	const res = await fetch("https://openrouter.ai/api/v1/key", {
		headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
	});
	return (await res.json()).data.usage;
}
async function guardBudget() {
	const u = await usage();
	log(`OpenRouter usage so far: $${u.toFixed(4)} (stop above $${BUDGET})`);
	if (u > BUDGET) throw new Error(`budget exceeded: usage $${u} > $${BUDGET}; real-model testing stopped`);
	return u;
}
async function withSpend(name, fn) {
	const before = await guardBudget();
	try {
		await fn();
	} finally {
		// OpenRouter's usage counter lags by 10s+; wait for it to move (or give up after 60s).
		let after = await usage();
		for (let i = 0; i < 12 && after === before; i++) {
			await sleep(5000);
			after = await usage();
		}
		log(`$ spent in ${name}: ${(after - before).toFixed(4)} (key usage now $${after.toFixed(4)})`);
		results.push({ name: `${name}: spend`, ok: true, evidence: `$${(after - before).toFixed(4)}` });
	}
}

// ---------- 1. plumbing (no model) ----------

async function plumbing() {
	// Transport level, real ntfy.sh.
	const topic = topicFor(freshRoom());
	const got = [];
	let cursor;
	let sub = subscribe({ server: SERVER, topic, onEnvelope: (env) => got.push({ env }), onCursor: (id) => (cursor = id) });
	await sleep(2000);
	const e1 = envelope({ fromId: "x", from: "alice", kind: "msg", text: "héllo   ünïcode" });
	await publish(SERVER, topic, e1);
	await until(() => got.length === 1, 15_000, "round-trip");
	check("transport round-trip", got[0].env.text === e1.text, `received id=${got[0].env.id} text=${JSON.stringify(got[0].env.text)}`);

	let oversize;
	try {
		await publish(SERVER, topic, envelope({ fromId: "x", from: "a", kind: "msg", text: "x".repeat(MAX_BYTES) }));
	} catch (err) {
		oversize = err.message;
	}
	check("oversize rejected before sending", /limit is 3800.*split/i.test(oversize ?? ""), oversize);

	// Reconnect + catch-up: stop, publish while "offline", resubscribe from the last id.
	sub.stop();
	const lastId = cursor;
	const e2 = envelope({ fromId: "x", from: "alice", kind: "msg", text: "sent while you were away" });
	await publish(SERVER, topic, e2);
	await sleep(1000);
	const caught = [];
	sub = subscribe({ server: SERVER, topic, since: lastId, onEnvelope: (env) => caught.push(env) });
	await sleep(15_000); // covers the 10s repair poll
	sub.stop();
	check(
		"transport catch-up via since",
		caught.length === 1 && caught[0].id === e2.id,
		`after resubscribe since=${lastId}: ${caught.length} message(s): ${caught.map((e) => e.text).join(" | ")}`,
	);

	check(
		"isForMe filter",
		!isForMe({ fromId: "me", from: "bob" }, "me", "bob") &&
			!isForMe({ fromId: "p", to: "carol" }, "me", "bob") &&
			isForMe({ fromId: "p", to: "BOB" }, "me", "bob") &&
			isForMe({ fromId: "p" }, "me", "bob"),
		"own fromId dropped, to=carol dropped, to=BOB and no-to accepted",
	);

	await dedupeAndWatchdog();

	// Extension level: bob in a real pi process, alice's side simulated by publishing envelopes.
	const room = freshRoom();
	const bobTopic = topicFor(room);
	let bob = startAgent("bob", room);
	await connected(bob);
	const bobId = fromIdOf(bob);
	const peer = (fields) => publish(SERVER, bobTopic, envelope({ fromId: "alice-install", from: "alice", kind: "msg", ...fields }));
	await publish(SERVER, bobTopic, envelope({ fromId: bobId, from: "bob", kind: "msg", text: "ECHO-SELF" }));
	await peer({ to: "carol", text: "FOR-CAROL" });
	await peer({ to: "bob", text: "FOR-BOB" });
	await until(() => duetIn(bob).some((c) => c.includes("FOR-BOB")), 20_000, "FOR-BOB injected");
	await sleep(3000);
	const inj = duetIn(bob);
	check("extension injects msg addressed to me", inj.length === 1 && inj[0].includes("[duet] from alice"), JSON.stringify(inj[0]).slice(0, 160));
	check("extension drops own echo and to=other", !inj.some((c) => /ECHO-SELF|FOR-CAROL/.test(c)), `${inj.length} injected message(s) total`);

	await publish(SERVER, bobTopic, envelope({ fromId: "alice-install", from: "alice", kind: "join" }));
	await until(() => notifies(bob).some((m) => m.includes("alice joined")), 15_000, "join notify");
	check("join → notify only, no turn", duetIn(bob).length === 1, `notify: "duet: alice joined"; injected still ${duetIn(bob).length}`);

	// Kill bob, send while he is down, restart: lastIds in duet.json drives the catch-up.
	await bob.stop();
	await peer({ text: "MISSED-WHILE-OFFLINE" });
	bob = startAgent("bob", room);
	await connected(bob);
	await until(() => duetIn(bob).some((c) => c.includes("MISSED-WHILE-OFFLINE")), 30_000, "catch-up after restart");
	await sleep(12_000); // a second copy would come from the repair poll
	const after = duetIn(bob);
	check(
		"pi restart catches up exactly once",
		after.length === 1 && after[0].includes("MISSED-WHILE-OFFLINE"),
		`restarted bob got ${after.length} message(s): ${after.map((c) => c.split("\n\n")[1]).join(" | ")}`,
	);

	bob.prompt("/duet");
	await until(() => notifies(bob).some((m) => m.includes("peers seen")), 10_000, "status");
	check("/duet status", true, notifies(bob).find((m) => m.includes("peers seen")).replace(room, "<room>"));
	await bob.stop();
}

// Dedupe and watchdog need a misbehaving server, so they run against a local fake ntfy.
async function dedupeAndWatchdog() {
	let connections = 0;
	const server = createServer((req, res) => {
		connections++;
		res.writeHead(200, { "content-type": "application/x-ndjson" });
		const msg = (id) =>
			JSON.stringify({ id, event: "message", message: JSON.stringify(envelope({ fromId: "p", from: "p", kind: "msg", text: id })) }) + "\n";
		res.write(msg("dup1") + msg("dup1") + msg("m2"));
		// ...then silence: the client's watchdog must give up on this connection. No keepalives.
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const got = [];
	const origSetTimeout = globalThis.setTimeout;
	// Compress time 1000x so the 90s watchdog fires in 90ms.
	globalThis.setTimeout = (fn, ms, ...rest) => origSetTimeout(fn, Math.ceil(ms / 1000), ...rest);
	const sub = subscribe({ server: base, topic: "t", onEnvelope: (env) => got.push(env.text) });
	await new Promise((r) => origSetTimeout(r, 1500));
	sub.stop();
	globalThis.setTimeout = origSetTimeout;
	server.closeAllConnections();
	server.close();
	check("dedupe by ntfy id", got.filter((t) => t === "dup1").length === 1, `delivered: ${[...new Set(got)].join(",")} (dup1 sent twice per connection)`);
	check("watchdog reconnects a silent stream", connections >= 2, `${connections} connections to a server that goes silent`);
}

// ---------- 2–4. real model ----------

async function pair(extraEnv) {
	const room = freshRoom();
	rmSync(join(ROOT, "b", "hello.txt"), { force: true });
	const alice = startAgent("alice", room, { realModel: true, extraEnv });
	const bob = startAgent("bob", room, { realModel: true, extraEnv });
	await Promise.all([connected(alice), connected(bob)]);
	return { alice, bob };
}

async function talk() {
	const { alice, bob } = await pair();
	await withSpend("talk", async () => {
		alice.prompt("ask bob what 17*23 is");
		await until(() => duetIn(bob).length, 90_000, "bob receives the question");
		await until(() => duetIn(alice).some((c) => c.includes("391")), 120_000, "alice receives 391");
		await settle([alice, bob], 10_000, 60_000);
	});
	check("talk: alice sent via duet_send", sends(alice).length >= 1, JSON.stringify(sends(alice)[0]));
	check("talk: bob got a turn and replied", sends(bob).some((s) => s.text.includes("391")), `bob in: ${JSON.stringify(duetIn(bob)[0])} → bob sent: ${JSON.stringify(sends(bob))}`);
	check("talk: alice received 391", duetIn(alice).some((c) => c.includes("391")), JSON.stringify(duetIn(alice)));
	await Promise.all([alice.stop(), bob.stop()]);
}

async function doWork() {
	const { alice, bob } = await pair();
	await withSpend("do", async () => {
		alice.prompt("ask bob's agent to create hello.txt containing 'hi from bob' in its folder and run `ls -la` and send you the output");
		await until(() => duetIn(alice).some((c) => c.includes("hello.txt")), 180_000, "alice receives ls output");
		await settle([alice, bob], 10_000, 60_000);
	});
	const file = join(bob.cwd, "hello.txt");
	const content = existsSync(file) ? readFileSync(file, "utf8") : null;
	check("do: bob's tools ran", toolRuns(bob).some((t) => t !== "duet_send"), `bob tools: ${toolRuns(bob).join(", ")}`);
	check("do: hello.txt on disk in bob's folder", content?.trim() === "hi from bob", `${file}: ${JSON.stringify(content)}`);
	// Compare against what bob's bash tool really printed: a model can run ls in parallel with the
	// write (so hello.txt is missing) and then invent the line when reporting. Seen with deepseek-chat.
	const realLs = bashOutputs(bob).find((o) => /hello\.txt/.test(o));
	const lsLine = realLs?.split("\n").find((l) => l.includes("hello.txt"));
	check(
		"do: bob's real ls output listed hello.txt",
		!!lsLine,
		`bob's bash outputs: ${JSON.stringify(bashOutputs(bob))}`,
	);
	check(
		"do: alice received that real ls output",
		!!lsLine && duetIn(alice).some((c) => c.includes(lsLine.trim())),
		`real line ${JSON.stringify(lsLine)}; alice got ${JSON.stringify(duetIn(alice))}`,
	);
	await Promise.all([alice.stop(), bob.stop()]);
}

async function loopCap() {
	const cap = 8;
	const { alice, bob } = await pair({ DUET_MAX_AUTO: String(cap) });
	await withSpend("loop", async () => {
		bob.prompt("Whenever alice's agent messages you, always answer with duet_send and ask her a new question, to keep the conversation going forever. Don't do anything else now.");
		await settle([bob], 3000, 60_000);
		alice.prompt("Start a conversation with bob's agent via duet_send: ask him a question about his favourite food. Always reply and keep the conversation going forever.");
		const stopped = await settle([alice, bob], 30_000, 8 * 60_000);
		check("loop: conversation came to rest", stopped, stopped ? "both idle for 30s" : "still running after 8 min");
	});
	const triggered = (a) => agentStarts(a) - 1; // minus the one human prompt
	const warn = (a) => notifies(a).find((m) => m.includes("auto-reply limit"));
	check(
		"loop: capped",
		triggered(alice) <= cap && triggered(bob) <= cap && (warn(alice) || warn(bob)),
		`peer-triggered turns: alice=${triggered(alice)} bob=${triggered(bob)} (cap ${cap}); duet_send calls: alice=${sends(alice).length} bob=${sends(bob).length}; warnings: alice=${JSON.stringify(warn(alice))} bob=${JSON.stringify(warn(bob))}`,
	);
	await Promise.all([alice.stop(), bob.stop()]);
}

// ---------- 5. install from GitHub ----------

async function install() {
	const agentDir = join(ROOT, "install-agent");
	rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
	const out = await new Promise((r) => {
		const p = spawn(PI, ["install", "git:github.com/qaioz/pi-duet"], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
		let s = "";
		p.stdout.on("data", (d) => (s += d));
		p.stderr.on("data", (d) => (s += d));
		p.on("exit", (code) => r(`exit=${code} ${s.trim()}`));
	});
	log("pi install:", out);
	const room = freshRoom();
	const a = startAgent("alice", room, { loadExt: false, agentDir, extraEnv: { DUET_ROOM: "", DUET_NAME: "" } });
	await sleep(3000);
	a.prompt(`/duet ${room} alice`);
	await until(() => notifies(a).some((m) => m.includes("joined as alice")), 20_000, "join via installed package");
	a.prompt("/duet");
	await until(() => notifies(a).some((m) => m.includes("peers seen")), 10_000, "status");
	check("install: extension loads from git and /duet works", true, `${out.slice(0, 200)} | ${notifies(a).at(-1).replace(room, "<room>")}`);
	await a.stop();
}

// ---------- main ----------

const suites = { plumbing, talk, do: doWork, loop: loopCap, install };
const which = process.argv.slice(2);
try {
	for (const name of which.length ? which : ["plumbing"]) {
		log(`=== ${name} ===`);
		suite = name;
		await suites[name]();
	}
} catch (err) {
	check("harness", false, err.message);
}
await Promise.all([...live].map((a) => a.stop()));
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
