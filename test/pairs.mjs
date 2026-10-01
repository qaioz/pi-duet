// Real-model tests: two agents of any kind (pi, Claude Code, Codex) join a fresh room using the
// website's own commands, typed into isolated terminals, and one asks the other to talk or do work.
// Every check reads the agents' own session logs and the file system.
//
//   node test/pairs.mjs <scenario>...      e.g.  pi:claude:talk  pi:claude:do  claude:codex:talk:open
//                                                loop:claude:codex
//   scenario = <asker>:<receiver>:<talk|do>[:<open|fresh>]   (join path for both; default fresh)
//
// Needs: OPENROUTER_API_KEY; DUET_SITE_COMMANDS = the commands JSON written by test/site.mjs (the
// page's commands, as shown); DUET_PIN = the commit to install (default: HEAD of this checkout).
// Env: DUET_SERVER (relay, default the local test container), DUET_RESULTS (append results here),
//      DUET_BUDGET (stop above this OpenRouter key usage, default 4.5).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { subscribe, topicFor } from "../transport.js";
import { Agent, killTmux, sleep, until } from "./agents.mjs";
import { roomFor } from "./remote.mjs";

const SERVER = (process.env.DUET_SERVER || "http://127.0.0.1:18080").replace(/\/+$/, "");
const BUDGET = Number(process.env.DUET_BUDGET || 4.5);
const REPO = resolve(import.meta.dirname, "..");
const PIN = process.env.DUET_PIN || execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!process.env.DUET_SITE_COMMANDS) throw new Error("DUET_SITE_COMMANDS is required: run test/site.mjs with it first");
const SITE = JSON.parse(readFileSync(process.env.DUET_SITE_COMMANDS, "utf8"));

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const results = [];
let scenario = "";
let scenarioCost = 0;
function check(name, ok, evidence) {
	results.push({ scenario, name, ok, evidence });
	log(ok ? "PASS" : "FAIL", `${scenario}: ${name}`, "—", evidence);
}

async function keyUsage() {
	const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } });
	return (await res.json()).data.usage;
}
async function guardBudget() {
	const u = await keyUsage();
	log(`OpenRouter key usage: $${u.toFixed(4)} (stop above $${BUDGET})`);
	if (u > BUDGET) throw new Error(`budget: key usage $${u} > $${BUDGET}; real-model testing stopped`);
}

// The page's commands for one agent and case, for this room and name, pinned to PIN.
function steps(kind, kase, room, name) {
	return SITE.commands[kind][kase].map(({ where, cmd }) => ({
		where,
		cmd: cmd
			.replaceAll(SITE.room, room)
			.replaceAll(` ${SITE.name}`, ` ${name}`)
			.replaceAll(`=${SITE.name} `, `=${name} `)
			.replaceAll("github:qaioz/pi-duet", `github:qaioz/pi-duet#${PIN}`)
			.replaceAll("git:github.com/qaioz/pi-duet", `git:github.com/qaioz/pi-duet@${PIN}`),
	}));
}

// Everything said in the room, as the relay saw it.
function watchRoom(room) {
	const seen = [];
	const sub = subscribe({ server: SERVER, topic: topicFor(room), onEnvelope: (env) => seen.push({ at: Date.now(), ...env }) });
	return { seen, stop: () => sub.stop() };
}

const READY = { pi: /\/ commands/, claude: /❯/, codex: /›/ };
const START = { pi: "pi", claude: "claude", codex: "codex" };

// Join one agent the way the page says. "open": the agent is already running with a conversation,
// and that conversation must survive. "fresh": everything from a terminal.
async function joinAs(agent, kase, room, watch) {
	const list = steps(agent.kind, kase, room, agent.name);
	const t0 = Date.now();
	agent.open();
	await agent.waitShell(15_000, "new terminal");
	if (kase === "open") {
		await agent.clear();
		await agent.type(START[agent.kind]);
		await agent.waitScreen(READY[agent.kind], 60_000, `${agent.kind} started`);
		await sleep(3000);
		await agent.type("Say just: OK");
		await until(() => agent.events().some((e) => e.type === "user" && /Say just: OK/.test(e.text)), 90_000, "the first conversation turn");
		await sleep(8000);
	}
	let launched;
	for (const { where, cmd } of list) {
		const inAgent = where.startsWith("in ");
		log(`${agent.name} (${agent.kind}) ${inAgent ? "types in the agent" : "runs in the terminal"}: ${cmd.replace(room, "<room>")}`);
		if (!inAgent && /^\s*(claude|codex|pi|DUET_)/.test(cmd) && !/ (mcp|install) /.test(cmd)) launched = Date.now();
		if (!inAgent) {
			await agent.waitShell(120_000, "before a terminal command");
			await agent.clear();
			await agent.type(cmd);
			if (/install|setup|mcp add/.test(cmd)) await agent.waitShell(300_000, `"${cmd.slice(0, 40)}…" finished`);
			else await agent.waitScreen(READY[agent.kind], 120_000, `${agent.kind} started`);
			await sleep(3000);
		} else {
			await agent.type(cmd);
			if (/^!!?/.test(cmd)) await sleep(cmd.includes("install") ? 25_000 : 8000);
			else if (cmd === "/exit" || cmd === "/quit") await agent.waitShell(30_000, cmd);
			else await sleep(4000);
		}
	}
	const joined = await until(() => watch.seen.find((e) => e.kind === "join" && e.from === agent.name), 240_000, `${agent.name}'s join on the relay`);
	return { firstJoinSec: ((joined.at - (launched ?? t0)) / 1000).toFixed(1), steps: list.length };
}

// The receiver is ready when its first duet tool call ("listen on duet" / "check duet") is done.
async function ready(agent) {
	if (agent.kind === "pi") return;
	const tool = agent.kind === "claude" ? "mcp__duet__duet_wait" : "duet_inbox";
	await until(() => agent.events().some((e) => e.type === "tool" && e.name === tool), 180_000, `${agent.name}'s first ${tool}`);
	await sleep(5000);
}

const REQUESTS = {
	talk: (peer) => `ask ${peer}'s agent what 17*23 is`,
	do: (peer) => `ask ${peer}'s agent to create a file hello.txt containing 'hi from ${peer}' in its folder, then run \`ls -la\` there and send you the real output`,
};

async function pair(askerKind, receiverKind, what, kase = "fresh") {
	scenario = `${askerKind}→${receiverKind} ${what} (${kase})`;
	await guardBudget();
	const room = randomBytes(16).toString("hex");
	const watch = watchRoom(room);
	const names = askerKind === receiverKind ? ["alice", "bob"] : ["ana", "ben"];
	// "talk" needs no tools beyond duet's, so those agents keep their default permissions: that checks
	// the page's own allowances (--allowedTools mcp__duet, Codex's approve) are enough.
	const permissive = what === "do";
	const a = new Agent(askerKind, names[0], { permissive }).seed();
	const b = new Agent(receiverKind, names[1], { permissive }).seed();
	const agents = [a, b];
	let nudged = false;
	try {
		const [ja, jb] = await Promise.all([joinAs(a, kase, room, watch), joinAs(b, kase, room, watch)]);
		check("both joined with the page's commands", true, `${a.name}/${a.kind}: ${ja.steps} steps, first launch to join ${ja.firstJoinSec}s; ${b.name}/${b.kind}: ${jb.steps} steps, ${jb.firstJoinSec}s`);
		await Promise.all([ready(a), ready(b)]);
		const bSeenBefore = b.events().filter((e) => e.type === "in").length;
		await a.type(REQUESTS[what](b.name));
		await until(() => a.events().some((e) => e.type === "send" && !e.error), 300_000, `${a.name} sends the request with duet_send`);
		// The receiver must get it by itself; if it doesn't within 3 minutes, the harness may only type
		// the page's fixed nudge, and that is reported.
		try {
			await until(() => b.events().filter((e) => e.type === "in").length > bSeenBefore, 180_000, `${b.name} receives the request`);
		} catch (err) {
			if (b.kind === "pi") throw err; // pi has push and no "check duet"
			nudged = true;
			log(`${b.name} did not receive by itself: typing the page's nudge "check duet"`);
			await b.type("check duet");
			await until(() => b.events().filter((e) => e.type === "in").length > bSeenBefore, 120_000, `${b.name} receives after the nudge`);
		}
		const expect = what === "talk" ? (t) => t.includes("391") : (t) => /hello\.txt/.test(t);
		await until(() => a.events().some((e) => e.type === "in" && expect(e.text)), 360_000, `${a.name} receives the answer`);
		await sleep(15_000); // let both finish their turns
		const ea = a.events();
		const eb = b.events();
		const bIn = eb.filter((e) => e.type === "in").at(-1) ?? eb.find((e) => e.type === "in");
		const how = `receiving turn started by ${nudged ? 'the human nudge "check duet"' : bIn?.how === "turn" ? "push (a new turn by itself)" : "a listening duet_wait returning"}`;
		check(`${a.name} sent the request with duet_send`, ea.some((e) => e.type === "send" && !e.error), JSON.stringify(ea.find((e) => e.type === "send")?.text));
		check(`${b.name} received it`, !!bIn, `${how}; ${JSON.stringify(bIn?.text.slice(0, 160))}`);
		if (what === "talk") {
			check(`${b.name} answered 391 with duet_send`, eb.some((e) => e.type === "send" && e.text?.includes("391")), JSON.stringify(eb.filter((e) => e.type === "send").map((e) => e.text)));
			check(`${a.name} received 391`, ea.some((e) => e.type === "in" && e.text.includes("391")), JSON.stringify(ea.filter((e) => e.type === "in").map((e) => e.text.slice(0, 200))));
		} else {
			const file = join(b.cwd, "hello.txt");
			const content = existsSync(file) ? readFileSync(file, "utf8") : null;
			check(`hello.txt on disk in ${b.name}'s folder`, content?.trim() === `hi from ${b.name}`, `${file}: ${JSON.stringify(content)}`);
			// The line from the receiver's real ls output, as its tool printed it.
			const real = eb.filter((e) => e.type === "tool" && /ls -la/.test(JSON.stringify(e.input)) && /hello\.txt/.test(e.output ?? "")).at(-1);
			const line = real?.output.split("\n").find((l) => l.includes("hello.txt"))?.trim();
			check(`${b.name}'s real ls -la listed hello.txt`, !!line, `${real?.name}: ${JSON.stringify(line)}`);
			const got = ea.filter((e) => e.type === "in").map((e) => e.text);
			check(`${a.name} received that real ls output`, !!line && got.some((t) => t.includes(line)), `real line ${JSON.stringify(line)}; ${a.name} got ${JSON.stringify(got.map((t) => t.slice(0, 400)))}`);
		}
		if (kase === "open") {
			// The conversation from before the join is still the one in use.
			const kept = (x) => x.events().filter((e) => e.type === "user" && /Say just: OK/.test(e.text)).length === 1 && x.events().some((e) => e.type === "user" && !/Say just: OK/.test(e.text));
			check("conversation kept across the join", agents.every((x) => sameSession(x) && kept(x)), agents.map((x) => `${x.name}: ${sessionCount(x)} session file(s)`).join("; "));
		}
		if (a.kind === "claude" || b.kind === "claude") {
			const c = agents.find((x) => x.kind === "claude");
			check("Claude Code ran the pinned model", c.seenModel === c.model, `transcript model: ${c.seenModel}`);
		}
	} catch (err) {
		check("scenario", false, err.message);
		for (const x of agents) log(`--- ${x.name} screen ---\n${x.screen().split("\n").filter(Boolean).slice(-25).join("\n")}`);
	} finally {
		watch.stop();
		scenarioCost = agents.reduce((s, x) => s + x.cost(), 0);
		log(`$ ${scenario}: ${scenarioCost.toFixed(4)} (tokens × OpenRouter prices, from the agents' logs)`);
		results.push({ scenario, name: "spend", ok: true, usd: scenarioCost, nudged });
		for (const x of agents) x.stop();
	}
}

function sessionFiles(x) {
	const dir = { pi: join(x.home, ".pi/agent/sessions"), claude: join(x.dir, "claude/projects"), codex: join(x.home, ".codex/sessions") }[x.kind];
	try {
		return execFileSync("find", [dir, "-name", "*.jsonl", "-not", "-path", "*/subagents/*"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}
const sessionCount = (x) => sessionFiles(x).length;
const sameSession = (x) => sessionCount(x) === 1;

// Two MCP agents told to keep a conversation going forever must come to rest.
async function loop(kindA, kindB) {
	scenario = `loop ${kindA}↔${kindB}`;
	await guardBudget();
	const room = randomBytes(16).toString("hex");
	const watch = watchRoom(room);
	const a = new Agent(kindA, "ana").seed();
	const b = new Agent(kindB, "ben").seed();
	try {
		await Promise.all([joinAs(a, "fresh", room, watch), joinAs(b, "fresh", room, watch)]);
		await Promise.all([ready(a), ready(b)]);
		await b.type("Whenever ana's agent messages you, always answer with duet_send and ask her a new question, to keep the conversation going forever.");
		await sleep(20_000);
		await a.type("Start a conversation with ben's agent: ask him about his favourite food, and always reply to keep the conversation going forever.");
		// At rest: no new message on the relay for 3 minutes, within 15 minutes.
		const end = Date.now() + 15 * 60_000;
		let rest = false;
		while (Date.now() < end) {
			const last = Math.max(0, ...watch.seen.filter((e) => e.kind === "msg").map((e) => e.at));
			if (last && Date.now() - last > 180_000) {
				rest = true;
				break;
			}
			await sleep(5000);
		}
		const msgs = watch.seen.filter((e) => e.kind === "msg");
		const refused = [a, b].flatMap((x) => x.events().filter((e) => e.type === "send" && /auto-reply limit/.test(e.error ?? "")).map(() => x.name));
		check("unattended conversation comes to rest", rest, `${msgs.length} messages on the relay (ana ${msgs.filter((m) => m.from === "ana").length}, ben ${msgs.filter((m) => m.from === "ben").length}); sends refused by the cap: ${refused.join(", ") || "none"}`);
	} catch (err) {
		check("scenario", false, err.message);
	} finally {
		watch.stop();
		scenarioCost = a.cost() + b.cost();
		log(`$ ${scenario}: ${scenarioCost.toFixed(4)}`);
		results.push({ scenario, name: "spend", ok: true, usd: scenarioCost });
		a.stop();
		b.stop();
	}
}

// Cross-device: a pi agent on a GitHub-hosted runner (another OS and network) joins over the relay;
// an agent here asks it to run `uname -a`. The run is started with the workflow's public nonce.
async function remote(os, askerKind = "pi") {
	scenario = `cross-device ${askerKind}→runner on ${os}`;
	await guardBudget();
	const nonce = randomBytes(8).toString("hex");
	const room = roomFor(process.env.OPENROUTER_API_KEY, nonce);
	const watch = watchRoom(room);
	const a = new Agent(askerKind, "devbox").seed();
	let runUrl = "";
	try {
		const before = new Date().toISOString();
		execFileSync("gh", ["workflow", "run", "cross-device.yml", "-R", "qaioz/pi-duet", "--ref", "main", "-f", `nonce=${nonce}`, "-f", `os=${os}`, "-f", "minutes=9", "-f", `server=${SERVER}`]);
		const run = await until(() => {
			const runs = JSON.parse(execFileSync("gh", ["run", "list", "-R", "qaioz/pi-duet", "--workflow", "cross-device.yml", "-L", "5", "--json", "url,createdAt,databaseId"], { encoding: "utf8" }));
			return runs.find((r) => r.createdAt >= before.slice(0, 19));
		}, 60_000, "the workflow run to appear");
		runUrl = run.url;
		log(`workflow run: ${runUrl}`);
		await joinAs(a, "fresh", room, watch);
		await ready(a);
		const joined = await until(() => watch.seen.find((e) => e.kind === "join" && e.from === "runner"), 420_000, "the runner's join");
		check("runner joined over the relay", !!joined, `runner's join seen at ${new Date(joined.at).toISOString()}`);
		await a.type("ask runner's agent to run `uname -a` in its folder and send you the real output");
		const want = os.startsWith("macos") ? /Darwin/ : os.startsWith("windows") ? /MINGW|MSYS|CYGWIN|Windows/i : /Linux/;
		const got = await until(() => a.events().find((e) => e.type === "in" && want.test(e.text)), 360_000, "the runner's uname output");
		check(`answer came from ${os}`, true, JSON.stringify(got.text.slice(0, 300)));
		const done = await until(() => {
			const r = JSON.parse(execFileSync("gh", ["run", "view", String(run.databaseId), "-R", "qaioz/pi-duet", "--json", "status,conclusion"], { encoding: "utf8" }));
			return r.status === "completed" && r;
		}, 900_000, "the workflow run to finish");
		const runLog = execFileSync("gh", ["run", "view", String(run.databaseId), "-R", "qaioz/pi-duet", "--log"], { encoding: "utf8", maxBuffer: 50e6 });
		const tools = runLog.split("\n").find((l) => l.includes("tool runs:")) ?? "";
		const line = got.text.split("\n").find((l) => want.test(l))?.trim() ?? "";
		const keyInLog = runLog.includes(process.env.OPENROUTER_API_KEY);
		check("the runner's real tool output matches what arrived", !!line && tools.includes(line.slice(0, 40)) && !keyInLog, `run ${done.conclusion}; line ${JSON.stringify(line)} in the runner's tool output: ${tools.includes(line.slice(0, 40))}; key in the run log: ${keyInLog}`);
	} catch (err) {
		check("scenario", false, `${err.message} ${runUrl}`);
		log(`--- ${a.name} screen ---\n${a.screen().split("\n").filter(Boolean).slice(-25).join("\n")}`);
	} finally {
		watch.stop();
		scenarioCost = a.cost();
		log(`$ ${scenario}: ${scenarioCost.toFixed(4)} here (the runner's spend is on the same key; see OpenRouter usage)`);
		results.push({ scenario, name: "spend", ok: true, usd: scenarioCost, runUrl });
		a.stop();
	}
}

killTmux();
try {
	for (const arg of process.argv.slice(2)) {
		const parts = arg.split(":");
		if (parts[0] === "loop") await loop(parts[1], parts[2]);
		else if (parts[0] === "remote") await remote(parts[1], parts[2]);
		else await pair(parts[0], parts[1], parts[2], parts[3]);
	}
} catch (err) {
	check("harness", false, err.message);
}
killTmux();
const failed = results.filter((r) => !r.ok);
const total = results.filter((r) => r.name === "spend").reduce((s, r) => s + r.usd, 0);
log(`${results.length - failed.length}/${results.length} passed; $${total.toFixed(4)} spent (from the agents' logs); pinned to ${PIN.slice(0, 7)}; relay ${SERVER}`);
if (process.env.DUET_RESULTS) appendFileSync(process.env.DUET_RESULTS, JSON.stringify({ suite: "pairs", pin: PIN, server: SERVER, at: new Date().toISOString(), results }) + "\n");
process.exit(failed.length ? 1 : 0);
