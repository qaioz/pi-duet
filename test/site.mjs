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
const relayQuery = SERVER === "https://ntfy.sh" ? "" : `?relay=${encodeURIComponent(SERVER)}`;
const start = site + relayQuery;

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

	// Name entry fills every command, on every tab; copy buttons copy exactly what is shown.
	await friend.fill("#name", "ni ka!");
	const typed = await friend.inputValue("#name");
	const commands = {};
	const unfilled = [];
	const copyMismatch = [];
	let total = 0;
	for (const agent of ["pi", "claude", "codex"]) {
		await friend.click(`.tabs button[data-agent="${agent}"]`);
		commands[agent] = {};
		for (const kase of ["open", "fresh"]) {
			const rows = await friend.$$(`.case[data-case="${kase}"] .cmd`);
			commands[agent][kase] = [];
			for (const row of rows) {
				const shown = await row.$eval("code", (c) => c.textContent);
				const where = await row.$eval(".where", (w) => w.textContent);
				commands[agent][kase].push({ where, cmd: shown });
				total++;
				const placeholder = /YOUR_NAME|[{}]/.test(shown);
				const joins = /--room|DUET_ROOM|^\/duet /.test(shown);
				if (placeholder || (joins && !(shown.includes(room) && shown.includes("nika")))) unfilled.push(shown);
				await row.$eval("button", (b) => b.click());
				const clip = await friend.evaluate(() => navigator.clipboard.readText());
				if (clip !== shown) copyMismatch.push({ shown, clip });
			}
		}
	}
	const withRoom = Object.values(commands).flatMap((a) => Object.values(a).flat()).filter((c) => c.cmd.includes(room)).length;
	check("name entry fills every command", typed === "nika" && unfilled.length === 0 && withRoom === 6, `name field cleaned to "${typed}"; ${total} commands on 3 tabs, ${withRoom} carry the room and name, unfilled: ${JSON.stringify(unfilled)}`);
	check("copy buttons copy exactly what is shown", copyMismatch.length === 0 && total > 0, `${total} copy buttons checked; mismatches: ${JSON.stringify(copyMismatch)}`);
	await friend.click('[data-copy="invite"]');
	check("invite copy button", (await friend.evaluate(() => navigator.clipboard.readText())) === invite, "clipboard = invite link");

	// Live "who's in the room": a join on the relay shows up on both pages.
	await publish(SERVER, topicFor(room), envelope({ fromId: "site-test", from: "nika", kind: "join" }));
	await page.waitForFunction(() => document.getElementById("people").textContent.includes("nika"), null, { timeout: 15_000 });
	check("who's in the room shows a join", (await page.textContent("#people")).includes("nika"), (await page.textContent("#people")).trim());

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
