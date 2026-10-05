// Builds docs/duet.mcpb, the one-click install for Claude Desktop (an MCP Bundle: a zip with
// manifest.json and the server). Run after changing mcp.js, panel.js, basecoat.js, transport.js or
// lock.js; test/panel.mjs fails while the bundle is out of date.
//
//   node mcpb/build.mjs        (uses `npx @anthropic-ai/mcpb` to validate and pack)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
export const BUNDLED = ["mcp.js", "panel.js", "transport.js", "lock.js", "basecoat.js"];
const version = readFileSync(join(repo, "mcp.js"), "utf8").match(/const VERSION = "([^"]+)"/)[1];
const dir = mkdtempSync(join(tmpdir(), "duet-mcpb-"));
try {
	mkdirSync(join(dir, "server"));
	for (const f of BUNDLED) cpSync(join(repo, f), join(dir, "server", f));
	writeFileSync(join(dir, "server", "package.json"), JSON.stringify({ type: "module" }) + "\n");
	const manifest = JSON.parse(readFileSync(join(repo, "mcpb", "manifest.json"), "utf8"));
	manifest.version = version;
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
	const mcpb = ["-y", "@anthropic-ai/mcpb@2.1.2"];
	execFileSync("npx", [...mcpb, "validate", join(dir, "manifest.json")], { stdio: "inherit" });
	execFileSync("npx", [...mcpb, "pack", dir, join(repo, "docs", "duet.mcpb")], { stdio: "inherit" });
	console.log(`docs/duet.mcpb: duet ${version}`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
