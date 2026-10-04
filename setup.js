// `npx -y github:qaioz/pi-duet setup codex --room <room> --name <name> [--server <url>] [--mode auto]`
// `npx -y github:qaioz/pi-duet setup codex --off` removes it again. (Claude Code has the plugin.)
//
// Writes the duet MCP server into Codex's config.toml. `codex mcp add` can't set the timeouts
//   or the tool approval, and `-c` flags would cut the session off from `codex queue` (our push).
//   `required`: Codex otherwise starts the first turn ~1s in, before a first-time npx download is done.
//   Also duet's hooks (codex/hooks.json as TOML, between marker lines): they ask before a request runs
//   (ask mode), fence what it may do, and hand messages over when a turn ends. Codex asks the user to
//   trust them once (/hooks). The Codex plugin (codex plugin marketplace add qaioz/pi-duet) brings the
//   same server and hooks without this; setup stays for the IDE extension, which has no plugins.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isName, isPlaceholderName, isRelayUrl } from "./transport.js";

const argv = process.argv.slice(3);
const opt = (flag) => {
	const i = argv.indexOf(flag);
	if (i < 0) return undefined;
	const value = argv[i + 1];
	if (value === undefined || value.startsWith("-")) fail(`${flag} needs a value`);
	return value;
};
const fail = (msg) => {
	console.error(`duet setup: ${msg}`);
	process.exit(1);
};

const target = argv[0];
if (target !== "codex") {
	fail("usage: setup codex --room <room> --name <name> [--server <url>] [--mode auto] | setup codex --off (Claude Code: install the duet plugin)");
}
const off = argv.includes("--off");
const room = opt("--room");
const name = opt("--name");
const server = opt("--server");
const mode = opt("--mode");
const pkg = opt("--package") || "github:qaioz/pi-duet";
if (!off) {
	if (!room || !name) fail("--room and --name are required");
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(room)) fail("--room may only use a-z, A-Z, 0-9, . _ - (at most 64)");
	if (isPlaceholderName(name)) fail(`--name is still the placeholder "${name}": use your own name`);
	if (!isName(name)) fail("--name may only use letters, digits, . _ -, must start with a letter or digit, at most 40");
	if (server && !isRelayUrl(server)) fail("--server must be an http(s) URL like https://ntfy.example.com");
	if (mode && mode !== "ask" && mode !== "auto") fail("--mode is ask or auto");
}
const run = ["-y", pkg, "--room", room, "--name", name, ...(server ? ["--server", server] : []), ...(mode === "auto" ? ["--mode", "auto"] : [])];
const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "npx", ...run]] : ["npx", run];

setupCodex();

// codex/hooks.json as TOML tables. JSON strings are valid TOML basic strings.
function hooksToml() {
	const { hooks } = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "codex/hooks.json"), "utf8"));
	const value = (v) => (typeof v === "object" ? `{ ${Object.entries(v).map(([k, x]) => `${k} = ${value(x)}`).join(", ")} }` : JSON.stringify(v));
	let out = "";
	for (const [event, groups] of Object.entries(hooks)) {
		for (const group of groups) {
			out += `\n[[hooks.${event}]]\n${group.matcher ? `matcher = ${JSON.stringify(group.matcher)}\n` : ""}`;
			for (const h of group.hooks) out += `\n[[hooks.${event}.hooks]]\n${Object.entries(h).map(([k, v]) => `${k} = ${value(v)}`).join("\n")}\n`;
		}
	}
	return out;
}

function setupCodex() {
	const MARK = "# duet: written by `npx github:qaioz/pi-duet setup codex`";
	const HOOKS_BEGIN = "# duet hooks: begin (written by setup codex; `setup codex --off` removes them)";
	const HOOKS_END = "# duet hooks: end";
	const dir = process.env.CODEX_HOME || join(homedir(), ".codex");
	const path = join(dir, "config.toml");
	const old = existsSync(path) ? readFileSync(path, "utf8") : "";

	// Our hooks go between two marker lines. Only a complete pair is ever removed: a begin marker with
	// no end would otherwise take everything after it.
	const lines = old.split("\n").map((l) => l.trim());
	const begins = lines.filter((l) => l === HOOKS_BEGIN).length;
	const ends = lines.filter((l) => l === HOOKS_END).length;
	if (begins !== ends || lines.indexOf(HOOKS_BEGIN) > lines.indexOf(HOOKS_END)) {
		fail(`${path} has a "${HOOKS_BEGIN}" line without its "${HOOKS_END}" (or the other way round). Fix or remove duet's hook lines by hand, then run setup again.`);
	}
	// Drop any earlier duet block: its hooks between the markers, its tables and our marker comment.
	const kept = [];
	let inDuet = false;
	let inHooks = false;
	for (const line of old.split("\n")) {
		if (line.trim() === HOOKS_BEGIN) inHooks = true;
		if (inHooks) {
			if (line.trim() === HOOKS_END) inHooks = false;
			continue;
		}
		const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
		if (header) inDuet = /^mcp_servers\.(duet|"duet")(\.|$)/.test(header[1]);
		if (!inDuet && line.trim() !== MARK) kept.push(line);
	}
	let text = kept.join("\n").replace(/\n+$/, "");
	// Hooks the user defines inline (`[hooks]` with `Stop = [...]`, or `hooks = {…}`) can't take our
	// `[[hooks.Stop]]` tables: Codex would refuse the whole file. Leave the hooks out and say how.
	const events = Object.keys(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "codex/hooks.json"), "utf8")).hooks);
	const inline = new RegExp(`^\\s*(["']?hooks["']?\\s*=|(["']?hooks["']?\\.)?["']?(${events.join("|")})["']?\\s*=)`, "m");
	const hooksClash = inline.test(text);
	if (!off) {
		const q = JSON.stringify; // a TOML basic string, for the characters allowed above
		text += `${text ? "\n\n" : ""}${MARK}
[mcp_servers.duet]
command = ${q(command)}
args = [${args.map(q).join(", ")}]
required = true
startup_timeout_sec = 120
tool_timeout_sec = 120
default_tools_approval_mode = "approve"
env_vars = ["CODEX_HOME"]
${hooksClash ? "" : `\n${HOOKS_BEGIN}${hooksToml()}${HOOKS_END}\n`}`;
		if (hooksClash) {
			console.error(
				`duet setup: ${path} defines Codex hooks inline, so duet's hooks were left out (adding them would break the file). ` +
					"Without them, requests from the other agent wait until you say 'check duet' (ask mode). Add the hooks in codex/hooks.json of this package by hand to get the form.",
			);
		}
	}

	mkdirSync(dir, { recursive: true });
	if (old && !existsSync(`${path}.before-duet`)) copyFileSync(path, `${path}.before-duet`); // the original, once
	writeFileSync(`${path}.tmp`, text.endsWith("\n") || !text ? text : text + "\n");
	renameSync(`${path}.tmp`, path);
	console.log(
		off
			? `duet removed from ${path}`
			: `duet added to ${path}: room ${room}, name ${name}, ${mode === "auto" ? "auto" : "ask"} mode. Start (or resume) codex: it asks you once to trust duet's hooks (choose "Trust all"). ` +
					"Then requests from the other agent ask you before they run" + (mode === "auto" ? " (auto: they start by themselves)" : "") + ".",
	);
}
