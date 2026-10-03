// What Claude may do while it works on a request from the other person's agent ("a peer turn").
// Pure: the mod's tool.call hook asks checkPeerTool and refuses the call with the reason it gives.
// These are rules on tool names and paths, not a sandbox: Bash can still reach anything the user's
// permission mode allows. They stop the common accidents (writing outside the folder, planting
// scheduled or background work, using the user's other connected tools) and say why.

// Tools a peer turn may use. Everything else (MCP tools of the user's own servers, scheduling,
// artifacts, messages to other sessions, worktrees, …) is refused.
const ALLOWED = new Set([
	"Read", "Edit", "Write", "NotebookEdit", "Bash", "Glob", "Grep", "LS", "LSP",
	"TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
	"Agent", "WebFetch", "WebSearch", "ToolSearch", "AskUserQuestion", "Skill",
	"EnterPlanMode", "ExitPlanMode",
]);
const WRITES = new Set(["Edit", "Write", "NotebookEdit"]);
// Inside the folder, files that change what Claude Code, git or an editor runs on their own later.
const PROTECTED = [".claude", ".mcp.json", ".git", "CLAUDE.md", "CLAUDE.local.md", ".vscode", ".envrc", ".husky"];

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

const same = (a, b, win) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);

// The path relative to cwd, or null when it is outside.
export function inside(path, cwd, home) {
	const p = resolvePath(path, cwd, home);
	const c = resolvePath(cwd, "/", home).replace(/\/+$/, "");
	const win = isWin(c);
	if (same(p, c, win)) return "";
	const prefix = c + "/";
	return same(p.slice(0, prefix.length), prefix, win) ? p.slice(prefix.length) : null;
}

function pathOf(e) {
	if (e.tool === "NotebookEdit") return e.notebook_path;
	if (e.tool === "Glob" || e.tool === "Grep" || e.tool === "LS") return e.path;
	return e.file_path;
}

// null when the call may go ahead; otherwise the reason Claude reads instead of the tool's result.
export function checkPeerTool(e, { cwd, home, peer, sendTool }) {
	const ask = `If it's needed, tell ${peer} that your own user has to do it or ask you for it.`;
	if (e.tool === sendTool) return null;
	if (!ALLOWED.has(e.tool)) return `duet: while working on ${peer}'s request, the ${e.tool} tool is off. ${ask}`;
	if (e.tool === "Bash" && e.run_in_background) return `duet: background commands are off while working on ${peer}'s request; run it in the foreground. ${ask}`;
	if (e.tool === "Agent" && e.isolation === "remote") return `duet: remote agents are off while working on ${peer}'s request. ${ask}`;
	const path = pathOf(e);
	if (path === undefined || path === null || path === "") return null;
	const rel = inside(path, cwd, home);
	if (rel === null) return `duet: while working on ${peer}'s request, only files under ${cwd} may be used; ${path} is outside it. ${ask}`;
	if (WRITES.has(e.tool)) {
		const first = rel.split("/")[0];
		if (PROTECTED.some((p) => same(first, p, isWin(resolvePath(cwd, "/", home))))) {
			return `duet: ${peer}'s request may not change ${rel}: it controls what runs on this computer later. ${ask}`;
		}
	}
	return null;
}
