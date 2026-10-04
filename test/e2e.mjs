// End-to-end tests: two headless pi agents (alice, bob) talking through an ntfy server.
//
//   node test/e2e.mjs plumbing            # no model, no cost
//   node test/e2e.mjs talk|do|loop        # real model via OpenRouter (needs OPENROUTER_API_KEY)
//   node test/e2e.mjs install             # installs from GitHub into a throwaway agent dir
//
// Env: DUET_SERVER (ntfy server, default the local test container http://127.0.0.1:18080; set
//      https://ntfy.sh for the real relay), PI (pi binary, default "pi"),
//      DUET_TEST_DIR (default ~/coding/personal/duet-test-v2/pi),
//      DUET_MODEL (default deepseek/deepseek-v4-flash), DUET_BUDGET (max OpenRouter key usage, default 4.5).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { envelope, isForMe, MAX_BYTES, MAX_LONG_BYTES, publish, subscribe, topicFor } from "../transport.js";

const PI = process.env.PI || "pi";
const ROOT = process.env.DUET_TEST_DIR || join(homedir(), "coding/personal/duet-test-v2/pi");
// deepseek-chat was flaky at tool calling here (empty completions, invented output); v4-flash was not.
const MODEL = process.env.DUET_MODEL || "deepseek/deepseek-v4-flash";
const BUDGET = Number(process.env.DUET_BUDGET || 4.5);
const EXT = resolve(import.meta.dirname, "../index.ts");
const SERVER = (process.env.DUET_SERVER || "http://127.0.0.1:18080").replace(/\/+$/, "");
// Each agent sees only what it needs: no orchestrator variables, no GitHub credentials, its own HOME.
const isoEnv = (home, extra) => {
	mkdirSync(home, { recursive: true });
	return { HOME: home, PATH: process.env.PATH, TERM: "xterm-256color", LANG: "C.UTF-8", DUET_SERVER: SERVER, ...extra };
};

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

function startAgent(name, room, { realModel = false, extraEnv = {}, loadExt = true, agentDir, cwd, fake } = {}) {
	cwd ??= join(ROOT, name === "alice" ? "a" : "b");
	agentDir ??= join(ROOT, `${name}-agent`);
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const key = realModel ? process.env.OPENROUTER_API_KEY : "sk-or-invalid-no-cost"; // fake: turns fail fast, nothing billed
	const env = isoEnv(join(agentDir, "home"), { PI_CODING_AGENT_DIR: agentDir, OPENROUTER_API_KEY: key, DUET_ROOM: room, DUET_NAME: name, ...extraEnv });
	const args = ["--mode", "rpc", "--no-session", ...modelArgs(agentDir, fake)];
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

// A free, deterministic stand-in model: its first answer in a turn is always a duet_send call, then
// it ends the turn quoting the tool results. Lets plumbing exercise the tool path at no cost.
async function fakeModel() {
	const sse = (res, delta, finish = null) =>
		res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		const { messages } = JSON.parse(body);
		const toolResults = messages.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (toolResults.length) {
			sse(res, { role: "assistant", content: `done: ${toolResults.join(" | ")}` });
			sse(res, {}, "stop");
		} else {
			const call = { index: 0, id: "call1", type: "function", function: { name: "duet_send", arguments: JSON.stringify({ text: "hello from the fake model" }) } };
			sse(res, { role: "assistant", tool_calls: [call] });
			sse(res, {}, "tool_calls");
		}
		res.end("data: [DONE]\n\n");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${server.address().port}/v1`, close: () => (server.closeAllConnections(), server.close()) };
}
function modelArgs(agentDir, fake) {
	if (!fake) return ["--provider", "openrouter", "--model", MODEL];
	mkdirSync(agentDir, { recursive: true });
	const provider = { baseUrl: fake.url, api: "openai-completions", apiKey: "x", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "fake" }] };
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: provider } }));
	return ["--provider", "fake", "--model", "fake"];
}
const duetSendResults = (a) =>
	a.events
		.filter((e) => e.type === "tool_execution_end" && e.toolName === "duet_send")
		.map((e) => ({ isError: e.isError, text: (e.result?.content ?? []).map((c) => c.text).join("") }));

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
// What pi itself billed for every model call (OpenRouter's key counter lags too much to diff).
const cost = (a) =>
	a.events
		.filter((e) => e.type === "message_end" && e.message?.role === "assistant")
		.reduce((sum, e) => sum + (e.message.usage?.cost?.total ?? 0), 0);
async function withSpend(name, agents, fn) {
	await guardBudget();
	try {
		await fn();
	} finally {
		const usd = agents.reduce((sum, a) => sum + cost(a), 0);
		log(`$ spent in ${name}: ${usd.toFixed(4)} (per pi's usage records)`);
		results.push({ name: "spend", ok: true, usd });
	}
}

// ---------- 1. plumbing (no model) ----------

async function plumbing() {
	// Transport level, real ntfy.sh.
	const topic = topicFor(freshRoom());
	const got = [];
	let cursor;
	let sub = subscribe({ server: SERVER, topic, onEnvelope: (env) => got.push({ env }), onCursor: (c) => (cursor = c) });
	await sleep(2000);
	const e1 = envelope({ fromId: "x", from: "alice", kind: "msg", text: "héllo   ünïcode" });
	await publish(SERVER, topic, e1);
	await until(() => got.length === 1, 15_000, "round-trip");
	check("transport round-trip", got[0].env.text === e1.text, `received id=${got[0].env.id} text=${JSON.stringify(got[0].env.text)}`);

	// A long message goes out as one: the relay keeps it as an attachment and the receiver fetches it.
	const long = envelope({ fromId: "x", from: "alice", kind: "msg", text: "L".repeat(50_000) });
	await publish(SERVER, topic, long);
	await until(() => got.some((g) => g.env.id === long.id), 20_000, "long message round-trip");
	check("long message round-trip (attachment)", got.find((g) => g.env.id === long.id)?.env.text.length === 50_000, "50,000 characters sent as one message, received whole");

	let oversize;
	try {
		await publish(SERVER, topic, envelope({ fromId: "x", from: "a", kind: "msg", text: "x".repeat(MAX_LONG_BYTES) }));
	} catch (err) {
		oversize = err.message;
	}
	check("oversize rejected before sending", /limit is (256 KB|200000)/i.test(oversize ?? ""), oversize);

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
		`after resubscribe since=${lastId.id}: ${caught.length} message(s): ${caught.map((e) => e.text).join(" | ")}`,
	);

	// ntfy.sh answers a since= id it doesn't have (e.g. <1s old, not yet cached) with its whole cache.
	// Resuming must still not replay what came before the cursor.
	const old = envelope({ fromId: "x", from: "alice", kind: "msg", text: "OLD" });
	await publish(SERVER, topic, old);
	await sleep(3000); // now surely cached
	const raw = await (await fetch(`${SERVER}/${topic}/json?poll=1&since=notcachedyet`)).text();
	// Seen on both ntfy.sh and the local container; ntfy.sh additionally lags ~1s before caching.
	check("premise: ntfy answers an unknown since= id with its whole cache", raw.includes(old.id), `${raw.split("\n").filter(Boolean).length} cached message(s) returned`);
	const replayed = [];
	sub = subscribe({ server: SERVER, topic, since: { id: "notcachedyet", time: Math.floor(Date.now() / 1000) }, onEnvelope: (env) => replayed.push(env.text) });
	await sleep(2000);
	await publish(SERVER, topic, envelope({ fromId: "x", from: "alice", kind: "msg", text: "NEW" }));
	await until(() => replayed.includes("NEW"), 15_000, "NEW after unknown-id resume");
	sub.stop();
	check("resume from an id ntfy doesn't know replays nothing older", replayed.join() === "NEW", `delivered: ${replayed.join(", ")}`);

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
	const heard = [];
	const listener = subscribe({ server: SERVER, topic: bobTopic, onEnvelope: (env) => heard.push(env) });
	await sleep(1000);
	let bob = startAgent("bob", room);
	await connected(bob);
	await until(() => heard.some((e) => e.kind === "join" && e.from === "bob"), 10_000, "join from an env join").catch(() => {});
	listener.stop();
	check("env join (DUET_ROOM=… pi) announces itself", heard.some((e) => e.kind === "join" && e.from === "bob"), `heard: ${heard.map((e) => `${e.kind} from ${e.from}`).join(", ") || "nothing"}`);
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

	// Kill bob, send while he is down, restart: the cursor in duet.json drives the catch-up.
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

	// A second pi window on the same agent dir must not also join, or both would answer everything.
	const fake = await fakeModel();
	const bob2 = startAgent("bob", room, { cwd: join(ROOT, "b2"), fake });
	await until(() => statusOf(bob2)?.includes("has the room"), 20_000, "second window refused");
	await peer({ text: "ONE-OWNER" });
	await until(() => duetIn(bob).some((c) => c.includes("ONE-OWNER")), 20_000, "owner receives");
	await sleep(3000);
	check(
		"second pi on the same agent dir stays out",
		duetIn(bob2).length === 0,
		`bob2 status ${JSON.stringify(statusOf(bob2))}; ONE-OWNER injected in bob: 1, in bob2: ${duetIn(bob2).length}`,
	);
	// ...and must not send either: the reply would land in the window that holds the room.
	bob2.prompt("say hi to alice");
	await until(() => duetSendResults(bob2).length, 20_000, "bob2's duet_send attempt");
	const [attempt] = duetSendResults(bob2);
	check("second pi cannot send", attempt.isError && attempt.text.includes("has the room"), JSON.stringify(attempt));
	await Promise.all([bob.stop(), bob2.stop()]);

	await printModeStaysOut(fake);

	// A name outside the rule is made to fit, or peers would drop everything it sends.
	const odd = startAgent("bob", freshRoom(), { agentDir: join(ROOT, "fit-agent"), cwd: join(ROOT, "fit"), extraEnv: { DUET_NAME: "bob q@laptop" } });
	const fitted = await until(() => statusOf(odd)?.startsWith("duet: bob-q-laptop") && statusOf(odd), 20_000, "fitted name").catch(() => statusOf(odd));
	await odd.stop();
	check("a name outside the rule is made to fit", fitted === "duet: bob-q-laptop", `DUET_NAME="bob q@laptop" → status ${JSON.stringify(fitted)}`);
	fake.close();
}

// `pi -p` (no UI) in a configured agent dir must not subscribe: it would eat the room's pending
// messages and advance the saved cursor past them. Counted against a local fake ntfy.
async function printModeStaysOut(fake) {
	const paths = [];
	const server = createServer((req, res) => {
		paths.push(req.url);
		res.writeHead(200, { "content-type": "application/x-ndjson" });
		res.write(JSON.stringify({ event: "open" }) + "\n");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const extraEnv = { DUET_SERVER: `http://127.0.0.1:${server.address().port}` };
	const agentDir = join(ROOT, "print-agent");
	const room = freshRoom();
	const args = ["-p", "say hi", ...modelArgs(agentDir, fake), "-e", EXT];
	// A join, however brief, takes the lock: watch for it rather than rely on the connection racing exit.
	const lockEvents = [];
	const lockDir = join(agentDir, "home", ".duet"); // the shared lock lives in ~/.duet (lock.js)
	mkdirSync(lockDir, { recursive: true });
	const watcher = watch(lockDir, (_type, f) => String(f).endsWith(".lock") && lockEvents.push(f));
	const out = await new Promise((r) => {
		const env = isoEnv(join(agentDir, "home"), { PI_CODING_AGENT_DIR: agentDir, DUET_ROOM: room, DUET_NAME: "carol", ...extraEnv });
		// stdin "ignore": with a pipe, pi -p waits for EOF on it before running.
		const p = spawn(PI, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
		let text = "";
		p.stdout.on("data", (d) => (text += d));
		const kill = setTimeout(() => p.kill("SIGKILL"), 60_000);
		p.on("exit", (code, sig) => (clearTimeout(kill), r(`exit=${code ?? sig} ${JSON.stringify(text.trim().slice(0, 120))}`)));
	});
	await sleep(500);
	watcher.close();
	const printConnections = paths.length;
	// Control: the same setup in RPC mode does reach the fake server, so zero above means something.
	const control = startAgent("carol", room, { agentDir, cwd: join(ROOT, "c"), extraEnv });
	await until(() => paths.length > printConnections, 20_000, "control agent connects");
	await control.stop();
	server.closeAllConnections();
	server.close();
	check(
		"pi -p does not join the room or send",
		printConnections === 0 && lockEvents.length === 0 && out.includes("can't use the duet room"),
		`pi -p ${out}; lock file events: ${lockEvents.length}; subscriptions: ${printConnections}; RPC control opened ${paths.length - printConnections}`,
	);
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
	await withSpend("talk", [alice, bob], async () => {
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
	await withSpend("do", [alice, bob], async () => {
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
	await withSpend("loop", [alice, bob], async () => {
		bob.prompt("Whenever alice's agent messages you, always answer with duet_send and ask her a new question, to keep the conversation going forever. Don't do anything else now.");
		await settle([bob], 3000, 60_000);
		alice.prompt("Start a conversation with bob's agent via duet_send: ask him a question about his favourite food. Always reply and keep the conversation going forever.");
		const stopped = await settle([alice, bob], 30_000, 8 * 60_000);
		check("loop: conversation came to rest", stopped, stopped ? "both idle for 30s" : "still running after 8 min");
	});
	// The side that hit the cap must have had exactly `cap` messages delivered as turns, at least one
	// more held back (the peer sent more than cap), and no agent run started after the warning.
	const warnAt = (a) => a.events.find((e) => e.method === "notify" && e.message.includes("auto-reply limit"))?.at;
	const [capped, other] = warnAt(alice) ? [alice, bob] : [bob, alice];
	const after = warnAt(capped) ? capped.events.filter((e) => e.type === "agent_start" && e.at > warnAt(capped)).length : -1;
	check(
		"loop: capped",
		!!warnAt(capped) && duetIn(capped).length === cap && sends(other).length > cap && after === 0,
		`${capped.name} warned; ${capped.name} got ${duetIn(capped).length} [duet] turns (cap ${cap}) of ${sends(other).length} sent by ${other.name}; runs started after the warning: ${after}. ${other.name} got ${duetIn(other).length} of ${sends(capped).length}.`,
	);
	await Promise.all([alice.stop(), bob.stop()]);
}

// ---------- 5. install from GitHub ----------

async function install() {
	const agentDir = join(ROOT, "install-agent");
	rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
	const out = await new Promise((r) => {
		const p = spawn(PI, ["install", "git:github.com/qaioz/pi-duet"], { env: isoEnv(join(agentDir, "home"), { PI_CODING_AGENT_DIR: agentDir }) });
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
const checks = results.filter((r) => r.name !== "spend");
const failed = checks.filter((r) => !r.ok);
log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (process.env.DUET_RESULTS) {
	const { appendFileSync } = await import("node:fs");
	appendFileSync(process.env.DUET_RESULTS, JSON.stringify({ suite: `pi-${which.join("+") || "plumbing"}`, server: SERVER, at: new Date().toISOString(), results }) + "\n");
}
process.exit(failed.length ? 1 : 0);
