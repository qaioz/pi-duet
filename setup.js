// `npx -y github:qaioz/pi-duet setup claude|codex --room <room> --name <name> [--server <url>]`
// `npx -y github:qaioz/pi-duet setup claude|codex --off` removes it again.
//
// claude: replaces any earlier duet server in this project folder through Claude Code's own
//   `claude mcp remove` / `claude mcp add-json`. `alwaysLoad` keeps duet's tools loaded from the start:
//   Claude Code otherwise defers MCP tools, and a model answering a pushed message may not look one up.
// codex: writes the duet MCP server into Codex's config.toml. `codex mcp add` can't set the timeouts
//   or the tool approval, and `-c` flags would cut the session off from `codex queue` (our push).
//   `required`: Codex otherwise starts the first turn ~1s in, before a first-time npx download is done.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
if (target !== "claude" && target !== "codex") {
	fail("usage: setup claude|codex --room <room> --name <name> [--server <url>] | setup claude|codex --off");
}
const off = argv.includes("--off");
const room = opt("--room");
const name = opt("--name");
const server = opt("--server");
const pkg = opt("--package") || "github:qaioz/pi-duet";
if (!off) {
	if (!room || !name) fail("--room and --name are required");
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(room)) fail("--room may only use a-z, A-Z, 0-9, . _ - (at most 64)");
	if (isPlaceholderName(name)) fail(`--name is still the placeholder "${name}": use your own name`);
	if (!isName(name)) fail("--name may only use letters, digits, . _ -, must start with a letter or digit, at most 40");
	if (server && !isRelayUrl(server)) fail("--server must be an http(s) URL like https://ntfy.example.com");
}
const run = ["-y", pkg, "--room", room, "--name", name, ...(server ? ["--server", server] : [])];
const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "npx", ...run]] : ["npx", run];

if (target === "claude") setupClaude();
else setupCodex();

function setupClaude() {
	const config = JSON.stringify({ type: "stdio", command, args, alwaysLoad: true });
	// Returns { ok, out }; never throws. ENOENT: no claude.exe/binary on PATH (an npm install on
	// Windows is claude.cmd, which needs a shell; JSON arguments through cmd.exe aren't safe to quote).
	const claude = (a) => {
		try {
			return { ok: true, out: execFileSync(process.env.DUET_CLAUDE_BIN || "claude", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
		} catch (err) {
			return { ok: false, missing: err.code === "ENOENT", out: String(err.stderr || err.message).trim() };
		}
	};
	const removed = claude(["mcp", "remove", "-s", "local", "duet"]); // an earlier room, if any
	if (removed.missing) {
		// No JSON to hand-quote (PowerShell doesn't take \" escapes); alwaysLoad comes from duet's tools.
		const add = process.platform === "win32" ? "claude.cmd mcp add -s local duet -- " : "claude mcp add -s local duet -- ";
		fail(
			"can't run the claude command from here. If Claude Code isn't installed, install it first (https://code.claude.com). " +
				"If it is (e.g. installed with npm on Windows), run this yourself in this folder:\n\n" +
				`  ${process.platform === "win32" ? "claude.cmd" : "claude"} mcp remove -s local duet\n` +
				(off ? "" : `  ${add}${[command, ...args].join(" ")}\n`),
		);
	}
	if (off) {
		console.log(removed.ok ? "duet removed from this project folder's Claude Code config." : `nothing to remove here (${removed.out})`);
		return;
	}
	const added = claude(["mcp", "add-json", "-s", "local", "duet", config]);
	if (!added.ok) fail(added.out);
	console.log(
		`duet added for this project folder: room ${room}, name ${name}. Start Claude Code here with:\n\n` +
			"  claude --dangerously-load-development-channels server:duet --allowedTools mcp__duet\n\n" +
			"(add --continue to keep your last conversation). At each start, choose “I am using this for local development” " +
			"on the development-channels notice; messages from the other agent then arrive in the session by themselves.",
	);
}

function setupCodex() {
	const MARK = "# duet: written by `npx github:qaioz/pi-duet setup codex`";
	const dir = process.env.CODEX_HOME || join(homedir(), ".codex");
	const path = join(dir, "config.toml");
	const old = existsSync(path) ? readFileSync(path, "utf8") : "";

	// Drop any earlier duet block: its tables and our marker comment.
	const kept = [];
	let inDuet = false;
	for (const line of old.split("\n")) {
		const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
		if (header) inDuet = /^mcp_servers\.(duet|"duet")(\.|$)/.test(header[1]);
		if (!inDuet && line.trim() !== MARK) kept.push(line);
	}
	let text = kept.join("\n").replace(/\n+$/, "");

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
`;
	}

	mkdirSync(dir, { recursive: true });
	if (old && !existsSync(`${path}.before-duet`)) copyFileSync(path, `${path}.before-duet`); // the original, once
	writeFileSync(`${path}.tmp`, text.endsWith("\n") || !text ? text : text + "\n");
	renameSync(`${path}.tmp`, path);
	console.log(off ? `duet removed from ${path}` : `duet added to ${path}: room ${room}, name ${name}. Start (or resume) codex, then say "check duet".`);
}
