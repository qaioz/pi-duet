// What Codex may do while it works on a request from the other person's agent (a "peer turn"),
// checked by duet's PreToolUse hook (mcp.js, duet_hook). Pure. The path rules are the Claude Code
// plugin's (hooks/guard.js).
//
// This is a guardrail, not a sandbox, and Codex runs it as a hook that fails open: if duet's server
// is slow, gone or errors, the tool runs (Codex: "a PreToolUse callback error, timeout, or malformed
// response can fail the hook without blocking the tool"). Codex's own sandbox and approvals still
// apply. Shell commands are only checked for background and scheduled work; what a command reads or
// writes is the sandbox's business.
import { inside, protectedPart } from "./hooks/guard.js";

// Work that outlives the request: background jobs, schedulers, detached terminals. A program counts in
// command position (start, after ; & | ( ` $( or a quote, or after sudo/env/exec/nohup-like words),
// with or without a path; `&` at the end of a command (not && or 2>&1) is a background job.
const BACKGROUND =
	/(^|[;&|(`'"]|\$\(|\b(?:sudo|env|exec|command|time|xargs)\s)\s*(?:[\w.\/-]*\/)?(nohup|setsid|disown|crontab|at|batch|systemd-run|launchctl|schtasks|tmux|screen|daemonize|start-stop-daemon)(\s|$|['";)])|(^|[^&>])&\s*($|[;)\n'"])/;
// Tools that reach past this session: other agents and messages to them, plugins, extra permissions,
// other MCP servers' resources.
const OFF = /agent|plugin|permission|mcp_resource|send_input|send_message|followup|spawn/i;

/** Every file an apply_patch touches. */
export function patchPaths(patch) {
	const out = [];
	// Codex trims each line before it reads a header, so leading spaces count too.
	for (const m of String(patch ?? "").matchAll(/^[ \t]*\*\*\*[ \t]*(?:(?:Add|Update|Delete) File|Move to):[ \t]*(.+?)[ \t]*\r?$/gm)) out.push(m[1].trim());
	return out;
}

/**
 * @param {{ tool: string, input: any }} call   the hook's tool_name and tool_input
 * @param {{ folder: string, home: string, peer: string, ownServer?: string }} ctx
 * @returns {string | null} why the call is refused, or null
 */
export function checkCodexTool(call, { folder, home, peer, ownServer = "duet" }) {
	const tool = String(call.tool ?? "");
	const input = call.input && typeof call.input === "object" ? call.input : {};
	const ask = `If it's needed, tell ${peer} that your own user has to do it or ask you for it.`;
	if (tool.startsWith("mcp__")) {
		if (tool.startsWith(`mcp__${ownServer}__`)) return null;
		return `duet: while working on ${peer}'s request, your user's other tools (${tool}) are off. ${ask}`;
	}
	if (OFF.test(tool)) return `duet: while working on ${peer}'s request, ${tool} is off. ${ask}`;
	let paths;
	let patching = tool === "apply_patch";
	if (tool === "Bash") {
		const command = Array.isArray(input.command) ? input.command.join(" ") : String(input.command ?? input.cmd ?? "");
		// Codex models often run apply_patch through the shell (`apply_patch <<'PATCH' …`): check its files.
		if (/\*\*\*\s*Begin Patch/.test(command)) {
			patching = true;
			paths = patchPaths(command);
		} else {
			if (BACKGROUND.test(command)) return `duet: background and scheduled commands are off while working on ${peer}'s request; run it in the foreground. ${ask}`;
			return null;
		}
	}
	paths ??= patching ? patchPaths(input.command ?? input.patch ?? input.input) : [input.path, input.file_path].filter((p) => typeof p === "string" && p);
	if (patching && !paths.length) return `duet: duet couldn't read which files this patch changes, so ${peer}'s request may not run it. ${ask}`;
	if (!folder) return paths.length ? `duet: duet doesn't know this session's folder yet, so ${peer}'s request may not change files. ${ask}` : null;
	for (const path of paths) {
		// A Windows drive-relative path ("D:a.txt") is relative to that drive's own current folder.
		if (/^[A-Za-z]:(?![\\/])/.test(path)) return `duet: ${path} isn't a plain path; ${peer}'s request may not use it. ${ask}`;
		const rel = inside(path, folder, home);
		if (rel === null) return `duet: while working on ${peer}'s request, only files under ${folder} may be used; ${path} is outside it. ${ask}`;
		const hit = patching ? protectedPart(rel) : undefined;
		if (hit) return `duet: ${peer}'s request may not change ${rel}: ${hit} controls what runs on this computer later. ${ask}`;
	}
	return null;
}
