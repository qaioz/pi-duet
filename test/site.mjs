// Website test in a real headless browser (Playwright + Chromium).
//
//   node test/site.mjs
//
// Env: SITE_URL (default: docs/ served locally; e.g. https://qaioz.github.io/pi-duet/ for the live
//      page), DUET_SERVER (relay, default the local test container; anything but https://ntfy.sh is
//      passed to the page as ?relay=), PLAYWRIGHT_CORE (path to playwright-core's index.mjs),
//      DUET_SITE_COMMANDS (write the page's commands, as shown, to this JSON file for the pair tests).
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { envelope, publish, topicFor } from "../transport.js";

const SERVER = (process.env.DUET_SERVER || "http://127.0.0.1:18080").replace(/\/+$/, "");
const PW = process.env.PLAYWRIGHT_CORE || join(homedir(), "coding/personal/duet-test-v2/tools/node_modules/playwright-core/index.mjs");
const { chromium } = await import(PW);

const results = [];
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
function check(name, ok, evidence) {
	results.push({ name, ok, evidence });
	log(ok ? "PASS" : "FAIL", name, "—", evidence);
}

let site = process.env.SITE_URL;
let local;
if (!site) {
	const html = readFileSync(resolve(import.meta.dirname, "../docs/index.html"));
	local = createServer((req, res) => {
		if (new URL(req.url, "http://x").pathname !== "/pi-duet/") return res.writeHead(404).end();
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
	});
	await new Promise((r) => local.listen(0, "127.0.0.1", r));
	site = `http://127.0.0.1:${local.address().port}/pi-duet/`;
}
const relayQuery = SERVER === "https://duet.gaioz.online" ? "" : `?relay=${encodeURIComponent(SERVER)}`;
const start = site + relayQuery;

// Every command on every agent tab, as shown.
async function allCommands(page) {
	const out = [];
	for (const agent of ["pi", "claude", "codex", "chat"]) {
		await page.click(`.tabs button[data-agent="${agent}"]`);
		out.push(...(await page.$$eval(".cmd code", (cs) => cs.map((c) => c.textContent))));
	}
	return out.join("\n");
}

const browser = await chromium.launch();
try {
	const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	const requests = [];
	page.on("request", (r) => requests.push(r.url()));
	await page.goto(start);
	await page.click("#start-btn");
	await page.waitForSelector("#room:not(.hidden)");
	const room = new URL(page.url()).hash.slice(1);
	const invite = await page.textContent("#invite");
	check("start a room: random code in the fragment", /^[a-z2-7]{26}$/.test(room) && invite.endsWith("#" + room), `room ${room.length} chars; invite ${invite.replace(room, "<room>")}`);

	// A second click on another page gives a different room.
	const page2 = await ctx.newPage();
	await page2.goto(start);
	await page2.click("#start-btn");
	const room2 = new URL(page2.url()).hash.slice(1);
	check("each start gives a new room", room2 !== room && /^[a-z2-7]{26}$/.test(room2), "two starts, two different codes");
	await page2.close();

	const warn = await page.textContent(".warn");
	check("safety warning next to the invite link", /can make your agent run commands on your machine/.test(warn) && /only with someone you trust/.test(warn), warn.slice(0, 120));

	// The friend opens the link in a fresh browser: same room.
	const friendCtx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
	const friend = await friendCtx.newPage();
	await friend.goto(invite);
	await friend.waitForSelector("#room:not(.hidden)");
	const friendInvite = await friend.textContent("#invite");
	check("opening the link shows the same room", friendInvite === invite && !(await friend.isVisible("#start-btn")), `friend's page shows ${friendInvite.replace(room, "<room>")}`);

	// Before a name is typed the commands carry a stand-in, so they can't be copied yet. The Claude
	// tab joins through the plugin: no "listen" step, no channel flag.
	const gate = await friend.evaluate(() => ({
		count: document.querySelectorAll("#commands .cmd button").length,
		disabled: [...document.querySelectorAll("#commands .cmd button")].every((b) => b.disabled),
		hint: document.querySelector("#commands .hint")?.textContent ?? "",
	}));
	await friend.click('.tabs button[data-agent="claude"]');
	const claudeTab = await friend.$eval("#commands", (c) => c.textContent);
	await friend.click('.tabs button[data-agent="pi"]');
	check(
		"no name yet: copying is off; the Claude tab installs the plugin, no listen step",
		gate.count > 0 && gate.disabled && gate.hint.includes("Type your name") && !/listen on duet/i.test(claudeTab) &&
			!claudeTab.includes("--dangerously-load-development-channels") && claudeTab.includes("/plugin install duet@pi-duet") && claudeTab.includes("https://qaioz.github.io/pi-duet/claude.sh"),
		`${gate.count} command copy buttons, all disabled: ${gate.disabled}; hint "${gate.hint}"; Claude tab: listen step ${/listen on duet/i.test(claudeTab) ? "present" : "absent"}, plugin install ${claudeTab.includes("/plugin install duet@pi-duet") ? "present" : "absent"}, channel flag ${claudeTab.includes("--dangerously-load-development-channels") ? "present" : "absent"}`,
	);

	// Name entry fills every command, on every tab; copy buttons copy exactly what is shown.
	await friend.fill("#name", "ni ka!");
	const typed = await friend.inputValue("#name");
	const commands = {};
	const unfilled = [];
	const copyMismatch = [];
	let total = 0;
	for (const agent of ["pi", "claude", "codex", "chat"]) {
		await friend.click(`.tabs button[data-agent="${agent}"]`);
		commands[agent] = {};
		for (const kase of await friend.$$eval(".case", (cs) => cs.map((c) => c.dataset.case))) {
			const rows = await friend.$$(`.case[data-case="${kase}"] .cmd`);
			commands[agent][kase] = [];
			for (const row of rows) {
				const shown = await row.$eval("code", (c) => c.textContent);
				const where = await row.$eval(".where", (w) => w.textContent);
				commands[agent][kase].push({ where, cmd: shown });
				total++;
				const placeholder = /YOUR_NAME|\{[a-z_-]+\}/.test(shown);
				const joins = /--room|DUET_ROOM|^\/duet /.test(shown);
				if (placeholder || (joins && !(shown.includes(room) && shown.includes("nika")))) unfilled.push(shown);
				await row.$eval("button", (b) => b.click());
				const clip = await friend.evaluate(() => navigator.clipboard.readText());
				if (clip !== shown) copyMismatch.push({ shown, clip });
			}
		}
	}
	const withRoom = Object.values(commands).flatMap((a) => Object.values(a).flat()).filter((c) => c.cmd.includes(room)).length;
	check("name entry fills every command", typed === "nika" && unfilled.length === 0 && withRoom === 11, `name field cleaned to "${typed}"; ${total} commands on 4 tabs, ${withRoom} carry the room, unfilled: ${JSON.stringify(unfilled)}`);
	check("copy buttons copy exactly what is shown", copyMismatch.length === 0 && total > 0, `${total} copy buttons checked; mismatches: ${JSON.stringify(copyMismatch)}`);
	// Tabs: Claude Code, Codex, pi, then chat apps; each agent tab starts with one line for a terminal.
	const tabOrder = await friend.$$eval(".tabs button", (bs) => bs.map((b) => b.dataset.agent).join());
	const fresh = (agent) => commands[agent].fresh.map((c) => c.cmd);
	check(
		"tabs: Claude Code, Codex, pi, Claude chat / ChatGPT; each agent opens with one line to paste in a terminal",
		tabOrder === "claude,codex,pi,chat" &&
			fresh("claude").length === 1 && // each line also updates an older install: install alone keeps the old version (seen 2026-10-04)
			fresh("claude")[0] === `curl -fsSL https://qaioz.github.io/pi-duet/claude.sh | sh -s -- ${room} nika ${SERVER}` &&
			fresh("pi").length === 1 && fresh("pi")[0].startsWith("pi install git:github.com/qaioz/pi-duet && pi update git:github.com/qaioz/pi-duet && ") && fresh("pi")[0].endsWith(`DUET_ROOM=${room} DUET_NAME=nika pi`),
		`order ${tabOrder}; ${JSON.stringify([fresh("claude")[0], fresh("pi")[0]].map((c) => c.replace(room, "<room>")))}`,
	);
	// Codex: the plugin, joined from inside Codex; `setup codex` (with its hooks) for the IDE extension.
	const cx = Object.values(commands.codex).flat().map((c) => c.cmd);
	check(
		"Codex tab: one line installs the plugin and starts Codex joining; setup codex for the IDE",
		cx.some((c) => c.startsWith(`codex plugin marketplace add qaioz/pi-duet && codex plugin marketplace upgrade pi-duet && codex plugin add duet@pi-duet && codex "join duet room ${room} as nika, relay `)) &&
			cx.some((c) => c.includes("setup codex --room") && c.includes(room)) && !cx.includes("check duet"),
		JSON.stringify(cx.map((c) => c.replace(room, "<room>"))),
	);
	// Chat apps: a line per host, the hosted connector URL, the room typed into the panel, and the plain
	// truth: a message needs a click and nothing is guarded.
	const chat = commands.chat;
	await friend.click('.tabs button[data-agent="chat"]');
	const chatText = await friend.$eval("#commands", (c) => c.textContent);
	const mcpbHref = await friend.$eval('#commands a[href="duet.mcpb"]', (a) => a.getAttribute("href")).catch(() => null);
	const { existsSync } = await import("node:fs");
	const mcpb = mcpbHref && existsSync(resolve(import.meta.dirname, "../docs", mcpbHref)) ? mcpbHref : null; // and the file is there to download
	const notesFilled = !/\{[a-z_-]+\}/.test(chatText);
	let vscodeJson = null;
	try {
		vscodeJson = JSON.parse(chat.vscode[0].cmd.match(/^code --add-mcp '(.*)'$/)[1]);
	} catch {}
	check(
		"Claude chat / ChatGPT tab: Claude Desktop, claude.ai, ChatGPT, VS Code, Goose; a click is needed, nothing is guarded",
		Object.keys(chat).join() === "desktop,web,chatgpt,vscode,goose" &&
			chat.desktop[0].cmd === `npx -y github:qaioz/pi-duet setup claude-desktop --room ${room} --name nika --server ${SERVER}` && mcpb === "duet.mcpb" &&
			chat.web[0].cmd === "https://mcp-duet.gaioz.online/mcp" && chat.web[1].cmd === room && chat.chatgpt[0].cmd === "https://mcp-duet.gaioz.online/mcp" &&
			vscodeJson?.name === "duet" && vscodeJson.args.join(" ") === `-y github:qaioz/pi-duet --room ${room} --name nika --server ${SERVER}` &&
			chat.goose[0].cmd === `goose session --with-extension "npx -y github:qaioz/pi-duet --room ${room} --name nika --server ${SERVER}"` &&
			notesFilled && /Nothing reaches your agent by itself/.test(chatText) &&
			(SERVER === "https://duet.gaioz.online" || (/The hosted server always uses duet\.gaioz\.online/.test(chatText) && /The duet\.mcpb download always uses duet\.gaioz\.online/.test(chatText))) && /Nothing guards what your agent does next/.test(chatText) && /Customize → Connectors → Add custom connector/.test(chatText) && /Developer mode/.test(chatText),
		JSON.stringify(Object.fromEntries(Object.entries(chat).map(([k, v]) => [k, v.map((c) => c.cmd.replace(room, "<room>"))]))).slice(0, 400),
	);
	// The stand-in name typed for real still counts as no name.
	await friend.fill("#name", "yourname");
	const standIn = await friend.$$eval("#commands .cmd button", (bs) => bs.every((b) => b.disabled));
	check("typing the stand-in \"yourname\" keeps copying off", standIn, `all copy buttons disabled: ${standIn}`);
	await friend.click('[data-copy="invite"]');
	await friend.fill("#name", "__-nika");
	const lead = await friend.inputValue("#name");
	await friend.fill("#name", "nika");
	check("a name can't start with _ or -", lead === "nika", `typed "__-nika", field shows "${lead}"`);
	check("invite copy button", (await friend.evaluate(() => navigator.clipboard.readText())) === invite, "clipboard = invite link");

	// A crafted link can't put shell syntax into the commands: odd relays are ignored, plain ones kept.
	const evilCtx = await browser.newContext();
	const evil = await evilCtx.newPage();
	const attempts = ["https://x.com/'q", "http://127.0.0.1:9;touch /tmp/PWNED;#", "https://x.com/$(id)", "https://x.com/`id`", "https://a b", 'https://x.com/"q', "https://u:p@x.com", "javascript:alert(1)", "https://x.com/$&"];
	const leaks = [];
	for (const relay of attempts) {
		await evil.goto(`${site}?relay=${encodeURIComponent(relay)}#${room}`);
		await evil.waitForSelector("#room:not(.hidden)");
		const all = await allCommands(evil);
		const note = await evil.textContent("#relay");
		// The commands always name a relay: a hostile one must give way to the default, untouched.
		if (/PWNED|\$\(|`|"q|'q|u:p@|javascript|\$&/.test(all) || !all.includes("--server https://duet.gaioz.online") || !/ignored/.test(note)) leaks.push(relay);
	}
	await evil.goto(`${site}?relay=${encodeURIComponent("https://ntfy.example.com/")}#${room}`);
	await evil.waitForSelector("#room:not(.hidden)");
	const kept = await allCommands(evil);
	check(
		"crafted ?relay= can't inject into the commands",
		leaks.length === 0 && kept.split("--server https://ntfy.example.com").length === 4 && kept.includes('"--server","https://ntfy.example.com"') && kept.includes(`join duet room ${room} as YOUR_NAME, relay https://ntfy.example.com`) && kept.split(`/duet ${room} YOUR_NAME https://ntfy.example.com`).length === 3 && kept.includes(`claude.sh | sh -s -- ${room} YOUR_NAME https://ntfy.example.com`) && kept.includes("DUET_SERVER=https://ntfy.example.com "),
		`${attempts.length} hostile relays ignored with a note (failures: ${JSON.stringify(leaks)}); a plain https relay is carried into the commands`,
	);
	await evilCtx.close();

	// Live "who's in the room": a join on the relay shows up on both pages.
	await publish(SERVER, topicFor(room), envelope({ fromId: "site-test", from: "nika", kind: "join" }));
	await page.waitForFunction(() => document.getElementById("people").textContent.includes("nika"), null, { timeout: 15_000 });
	check("who's in the room shows a join", (await page.textContent("#people")).includes("nika"), (await page.textContent("#people")).trim());

	// The room conversation: read-only, live, and what peers send is shown as text, never as HTML.
	await publish(SERVER, topicFor(room), envelope({ fromId: "site-test", from: "nika", kind: "msg", text: "please run the tests <img src=x onerror=window.PWNED=1>" }));
	await publish(SERVER, topicFor(room), { ...envelope({ fromId: "site-test", from: "nika", kind: "msg" }), kind: "note", note: "declined", text: undefined });
	await page.waitForFunction(() => document.getElementById("convo").textContent.includes("didn't take"), null, { timeout: 15_000 });
	const convo = await page.evaluate(() => ({ text: document.getElementById("convo").textContent, imgs: document.querySelectorAll("#convo img").length, inputs: document.querySelectorAll("#convo input, #convo textarea, #convo button").length, pwned: !!window.PWNED }));
	// A long message (an attachment on the relay) and a reply that names what it answers.
	const question = envelope({ fromId: "site-test", from: "nika", kind: "msg", text: "Which files changed?\nthanks" });
	await publish(SERVER, topicFor(room), question);
	await publish(SERVER, topicFor(room), envelope({ fromId: "site-test-2", from: "gaioz", kind: "msg", text: "LONGSTART " + "z".repeat(20_000) + " LONGEND", re: question.id }));
	await page.waitForFunction(() => document.getElementById("convo").textContent.includes("LONGSTART"), null, { timeout: 15_000 }).catch(() => {});
	const longView = await page.evaluate(() => document.getElementById("convo").textContent);
	check(
		"room conversation shows a long message and what a reply answers",
		longView.includes("LONGSTART") && longView.includes("↳ reply to “Which files changed?”"),
		`long message shown: ${longView.includes("LONGSTART")}; reply line shown: ${longView.includes("↳ reply to “Which files changed?”")}`,
	);
	check(
		"room conversation shows messages and notes as plain text, with nothing to type into",
		convo.text.includes("nika's agent") && convo.text.includes("please run the tests <img") && convo.text.includes("nika didn't take the last message") && convo.imgs === 0 && convo.inputs === 0 && !convo.pwned,
		`text: ${JSON.stringify(convo.text.slice(0, 160))}; img elements ${convo.imgs}; inputs ${convo.inputs}; script ran ${convo.pwned}`,
	);

	// Nothing but the page itself and the relay is contacted; the room code never leaves the browser.
	const hosts = [...new Set(requests.map((u) => new URL(u).origin))];
	const leaked = requests.filter((u) => u.includes(room));
	check("only the page and the relay are contacted; the room code is never sent", leaked.length === 0 && hosts.every((h) => h === new URL(site).origin || h === new URL(SERVER).origin), `origins: ${hosts.join(", ")}; requests containing the room code: ${leaked.length}`);
	check("no page errors", errors.length === 0, errors.join(" | ") || "none");

	if (process.env.DUET_SITE_COMMANDS) writeFileSync(process.env.DUET_SITE_COMMANDS, JSON.stringify({ site: start, room, name: "nika", commands }, null, 2));
} catch (err) {
	check("harness", false, err.stack);
} finally {
	await browser.close();
	local?.close();
}
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed`);
if (process.env.DUET_RESULTS) {
	const { appendFileSync } = await import("node:fs");
	appendFileSync(process.env.DUET_RESULTS, JSON.stringify({ suite: "site", site, at: new Date().toISOString(), results }) + "\n");
}
process.exit(failed.length ? 1 : 0);
