// What Claude may do while it works on a request from the other person's agent ("a peer turn").
// Pure: the mod's tool.call hook asks checkPeerTool and refuses the call with the reason it gives.
// These are rules on tool names and paths, not a sandbox: Bash can still reach anything the user's
// permission mode allows. They stop the common accidents (touching files outside the folder,
// changing what runs later, planting scheduled or background work, using the user's other tools)
// and say why.

// Tools a peer turn may use. Everything else (MCP tools of the user's own servers, skills,
// scheduling, artifacts, messages to other sessions, worktrees, …) is refused. WebFetch too: a URL
// can carry this folder's contents to any server.
const ALLOWED = new Set([
	"Read", "Edit", "Write", "NotebookEdit", "Bash", "Glob", "Grep", "LS", "LSP",
	"TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
	"Agent", "WebSearch", "ToolSearch", "AskUserQuestion",
	"EnterPlanMode", "ExitPlanMode",
]);
const WRITES = new Set(["Edit", "Write", "NotebookEdit"]);
// Built-in subagent types only: a custom agent's definition can carry its own tools and mode.
const AGENT_TYPES = new Set(["general-purpose", "Explore", "Plan"]);
// Path arguments, by the names the built-in tools use.
const PATH_KEYS = ["file_path", "notebook_path", "path", "filePath"];
// Anywhere in a path, names that change what Claude Code, git, an editor or another agent runs on
// their own later. Compared without regard to case (macOS and Windows file systems ignore it).
const PROTECTED = [".claude", ".mcp.json", ".git", "claude.md", "claude.local.md", "agents.md", ".vscode", ".envrc", ".husky", ".pi", ".codex"];

const isWin = (p) => /^[A-Za-z]:\//.test(p);

// An absolute, normalised path with forward slashes; `..` and `.` resolved. Symlinks aren't followed.
export function resolvePath(path, cwd, home) {
	let p = String(path).replace(/\\/g, "/");
	const base = String(cwd).replace(/\\/g, "/");
	if (p === "~" || p.startsWith("~/")) p = String(home ?? "").replace(/\\/g, "/") + p.slice(1);
	if (!p.startsWith("/") && !isWin(p)) p = base.replace(/\/+$/, "") + "/" + p;
	const drive = isWin(p) ? p.slice(0, 2) : "";
	const out = [];
	for (const seg of p.slice(drive.length).split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") out.pop();
		else out.push(seg);
	}
	return drive + "/" + out.join("/");
}

// The path relative to cwd, or null when it is outside. Case matters except on a Windows drive:
// on a case-insensitive disk that only refuses more, never less.
export function inside(path, cwd, home) {
	const p = resolvePath(path, cwd, home);
	const c = resolvePath(cwd, "/", home).replace(/\/+$/, "");
	const win = isWin(c);
	const same = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
	if (same(p, c)) return "";
	const prefix = c + "/";
	return same(p.slice(0, prefix.length), prefix) ? p.slice(prefix.length) : null;
}

// A segment as Windows would open it: no trailing dots or spaces, no ":stream" suffix; any case.
const plainName = (seg) => seg.replace(/:.*$/, "").replace(/[. ]+$/, "").toLowerCase();

// The first protected name anywhere in the path (8.3 short names like CLAUDE~1.MD included).
export function protectedPart(rel) {
	return rel.split("/").find((seg) => {
		const name = plainName(seg);
		return PROTECTED.includes(name) || /^(claude|agents|git|vscode|husky|envrc|codex|pi|mcp)~\d/.test(name);
	});
}

// Every path the call names: the path arguments, and a Glob pattern that is itself a path.
function pathsOf(e) {
	const out = PATH_KEYS.map((k) => e[k]).filter((v) => typeof v === "string" && v !== "");
	if (e.tool === "Glob" && typeof e.pattern === "string" && /^(\/|~|[A-Za-z]:[\\/])|(^|[\\/])\.\.([\\/]|$)/.test(e.pattern)) {
		out.push(e.pattern.split(/[*?[{]/)[0] || "/");
	}
	return out;
}

// null when the call may go ahead; otherwise the reason Claude reads instead of the tool's result.
export function checkPeerTool(e, { cwd, home, peer, sendTool }) {
	const ask = `If it's needed, tell ${peer} that your own user has to do it or ask you for it.`;
	if (e.tool === sendTool) return null;
	if (e.tool === "WebFetch") return `duet: while working on ${peer}'s request, WebFetch is off (a URL can carry this folder's files to any server). ${ask}`;
	if (!ALLOWED.has(e.tool)) return `duet: while working on ${peer}'s request, the ${e.tool} tool is off. ${ask}`;
	if (e.tool === "Bash" && e.run_in_background) return `duet: background commands are off while working on ${peer}'s request; run it in the foreground. ${ask}`;
	if (e.tool === "Agent") {
		if (e.isolation === "remote") return `duet: remote agents are off while working on ${peer}'s request. ${ask}`;
		if (e.run_in_background) return `duet: background agents are off while working on ${peer}'s request; run it in the foreground. ${ask}`;
		if (e.subagent_type && !AGENT_TYPES.has(e.subagent_type)) return `duet: only the built-in agent types are on while working on ${peer}'s request, not ${e.subagent_type}. ${ask}`;
	}
	for (const path of pathsOf(e)) {
		const rel = inside(path, cwd, home);
		if (rel === null) return `duet: while working on ${peer}'s request, only files under ${cwd} may be used; ${path} is outside it. ${ask}`;
		const hit = WRITES.has(e.tool) ? protectedPart(rel) : undefined;
		if (hit) return `duet: ${peer}'s request may not change ${rel}: ${hit} controls what runs on this computer later. ${ask}`;
	}
	return null;
}
