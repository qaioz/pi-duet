// `npx -y github:qaioz/pi-duet setup codex --room <room> --name <name> [--server <url>]`
// Writes the duet MCP server into Codex's config.toml. `codex mcp add` can't set the timeouts or
// the tool approval, and `-c` flags would cut the session off from `codex queue` (our push).
// `required`: Codex otherwise starts the first turn ~1s in, before a first-time npx download is done.
// `setup codex --off` removes it again.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRelayUrl } from "./transport.js";

const argv = process.argv.slice(3);
const opt = (flag) => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const fail = (msg) => {
	console.error(`duet setup: ${msg}`);
	process.exit(1);
};

if (argv[0] !== "codex") fail("usage: setup codex --room <room> --name <name> [--server <url>] | setup codex --off");
const off = argv.includes("--off");
const room = opt("--room");
const name = opt("--name");
const server = opt("--server");
const pkg = opt("--package") || "github:qaioz/pi-duet";
if (!off) {
	if (!room || !name) fail("--room and --name are required");
	for (const [k, v] of Object.entries({ room, name })) if (!/^[A-Za-z0-9._-]+$/.test(v)) fail(`${k} may only use letters, digits, . _ -`);
	if (server && !isRelayUrl(server)) fail("--server must be an http(s) URL like https://ntfy.example.com");
}

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
	const run = ["-y", pkg, "--room", room, "--name", name, ...(server ? ["--server", server] : [])];
	const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "npx", ...run]] : ["npx", run];
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
