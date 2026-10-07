// One owner per room and name on this computer, shared by every duet client: pi, the MCP server
// (Codex) and the Claude Code plugin (hooks/duet.js, through $.fs).
// Without it a Claude Code window and a Codex window in the same room under the same name would both
// answer every message.
//
// The lock is ~/.duet/<hash>.lock (DUET_HOME overrides ~/.duet), where hash is the first 16 hex
// characters of sha256("<relay> <room> <name>"). It holds JSON:
//   { v: 2, client: "pi" | "codex" | "mcp" | "claude-code", token, pid, cwd, at }
// The owner rewrites `at` every LOCK_BEAT_MS. A lock is held while `at` is under LOCK_FRESH_MS old,
// unless its pid is known to be gone. Owners read the lock back at every beat: another token there means
// the room was taken over (the other client found this one stale), and this one leaves. An empty or
// released lock is free.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanText, isName, isPlaceholderName, isRelayUrl, isRoomCode } from "./transport.js";

export const LOCK_FRESH_MS = 60_000;
export const LOCK_BEAT_MS = 20_000;

export const duetHome = () => process.env.DUET_HOME || join(homedir(), ".duet");

/** @param {string} server @param {string} room @param {string} name */
export function lockPath(server, room, name, dir = duetHome()) {
	return join(dir, `${createHash("sha256").update(`${server} ${room} ${name}`).digest("hex").slice(0, 16)}.lock`);
}

/** @returns {{ v: number, client?: string, token?: string, pid?: number, cwd?: string, at?: number } | undefined} */
export function readLock(path) {
	let text;
	try {
		text = readFileSync(path, "utf8").trim();
	} catch {
		return undefined;
	}
	try {
		const l = JSON.parse(text);
		return l && typeof l === "object" ? l : undefined;
	} catch {
		return undefined; // half written or corrupt: as if free
	}
}

const pidAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM"; // alive, just not ours
	}
};

/** Is this lock held by someone (anyone, this process included)? */
export function lockHeld(l, now = Date.now()) {
	if (!l || l.released) return false;
	if (l.pid && l.pid !== process.pid && !pidAlive(l.pid)) return false;
	return now - (Number(l.at) || 0) < LOCK_FRESH_MS;
}

/** Who holds it, said for a person: "Codex (pid 123, /work/repo)". */
export function describeHolder(l) {
	const who = { pi: "pi", codex: "Codex", mcp: "a duet MCP server", "claude-code": "Claude Code" }[l?.client] ?? "another duet client";
	const bits = [l?.pid ? `pid ${l.pid}` : "", l?.cwd ?? ""].filter(Boolean).join(", ");
	return bits ? `${who} (${bits})` : who;
}

function write(path, me) {
	mkdirSync(join(path, ".."), { recursive: true });
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
	writeFileSync(tmp, JSON.stringify({ v: 2, client: me.client, token: me.token, pid: process.pid, cwd: me.cwd, at: Date.now() }) + "\n");
	renameSync(tmp, path); // a reader never sees half a file
}

/**
 * Take the room unless someone else holds it. Two takers at once: the last write wins, and each reads
 * the lock back after a moment and keeps the room only if it is still theirs.
 * @param {{ client: string, token: string, cwd: string }} me
 * @returns {Promise<{ ok: true } | { ok: false, holder: any }>}
 */
export async function takeLock(path, me) {
	const cur = readLock(path);
	if (cur && cur.token !== me.token && lockHeld(cur)) return { ok: false, holder: cur };
	write(path, me);
	await new Promise((r) => setTimeout(r, 150));
	const back = readLock(path);
	return back?.token === me.token ? { ok: true } : { ok: false, holder: back };
}

/** The owner's beat: false when another client holds the lock now (it took the room over). */
export function refreshLock(path, me) {
	const cur = readLock(path);
	if (cur && cur.token !== me.token && !cur.released) return false; // missing or released: ours again
	write(path, me);
	return true;
}

export function releaseLock(path, me) {
	try {
		if (readLock(path)?.token === me.token) rmSync(path);
	} catch {}
}

// ---------- the join file: ~/.duet/join.json ----------
// The site's prompt writes it, then the user starts (or reloads) their agent in that folder:
//   { agent: "claude-code" | "codex" | "pi", room, name, relay, cwd, pcwd, at }   (at: Unix seconds)
// The client it names takes it once, in that folder, within 30 minutes, and only when not in a room.
// Taking it never joins: the client shows "Join <room> as <name>?" and the user's own answer joins.
// Same rules as hooks/wire.js readJoinFile (Claude Code): a relay is required, `at` is a number not
// ahead of this clock (a time ahead is cleared, like a stale one).

export const JOIN_FRESH_S = 30 * 60;
export { isRoomCode }; // transport.js: one rule for every client
export const joinFilePath = (dir = duetHome()) => join(dir, "join.json");
const noSlash = (p) => String(p ?? "").replace(/[\\/]+$/, "");

/**
 * Whether this client takes the join file: { room, name, relay }, or { skip } with why not.
 * "stale" may be cleared; any other skip is left for the client (or folder) it is for.
 * @param {any} j @param {{ agent: string, folder: string, now?: number }} me
 */
// A folder as both sides write it: Git Bash's /c/x and Windows' C:\x are one folder; no trailing slash.
const folderKey = (p) => (typeof p === "string" && p ? p.replace(/\\/g, "/").replace(/^\/([A-Za-z])(?=\/|$)/, "$1:").replace(/\/+$/, "") || "/" : "");
// Windows paths (C:\x, \\server\x) compare without case; Linux and macOS ones as written.
const isWindowsPath = (p) => typeof p === "string" && (/^[A-Za-z]:/.test(p) || p.includes("\\"));
// The join file's folder is this one or, on this window's own start or reload (nested), one inside it:
// the agent's shell may have cd'd into a subfolder. A poll takes only its own folder, so a window open
// in ~ doesn't take every prompt pasted below it.
export const sameFolder = (paths, folder, nested = false) => {
	const here0 = folderKey(folder);
	return !!here0 && paths.some((p) => {
		const fold = isWindowsPath(folder) || isWindowsPath(p);
		const here = fold ? here0.toLowerCase() : here0;
		const k = fold ? folderKey(p).toLowerCase() : folderKey(p);
		const root = here === "/" || /^[A-Za-z]:$/.test(here); // / or C:\ is no one's project
		return !!k && (k === here || (nested && !root && k.startsWith(here + "/")));
	});
};
export function acceptJoin(j, { agent, folder, nested = false, now = Date.now() }) {
	if (!j || typeof j !== "object" || !j.agent) return { skip: "empty" };
	if (typeof j.at !== "number") return { skip: "invalid" };
	const age = now / 1000 - j.at;
	if (!(age <= JOIN_FRESH_S)) return { skip: "stale" };
	if (age < 0) return { skip: "stale" }; // ahead of this clock: not the prompt's `date +%s`, and never taken
	if (j.agent !== agent) return { skip: "agent" };
	if (!sameFolder([j.cwd, j.pcwd], folder, nested)) return { skip: "folder" };
	const relay = typeof j.relay === "string" ? noSlash(j.relay) : "";
	if (!isRoomCode(j.room) || !isName(j.name) || isPlaceholderName(j.name) || !isRelayUrl(relay)) return { skip: "invalid" };
	// The folder shown is this window's own: the file's cwd is free text, and only one of cwd/pcwd matched.
	return { room: j.room, name: j.name, relay, folder };
}

/** Take the join file if it is for this client: removed before the caller asks the user, so it is offered once. */
export function takeJoinFile(me, path = joinFilePath()) {
	let j;
	try {
		j = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined; // missing (the usual case) or half written
	}
	const got = acceptJoin(j, me);
	if (got.skip === "stale") rmSync(path, { force: true });
	if (got.skip) return undefined;
	rmSync(path, { force: true });
	return got;
}

// What the user is asked before a join file joins (every client): "Join <room> as <name>? · <folder>",
// with "· relay <host>" before the folder when it isn't duet's own relay. The relay is never cut; the
// folder (the window's own, home as ~) is one line, its end kept, at most FOLDER_MAX characters.
const FOLDER_MAX = 60;
export const DUET_RELAY = "https://duet.gaioz.online";
export function joinQuestion({ room, name, relay, folder }, home = "") {
	let where = String(folder ?? "").replace(/[\\/]+$/, "") || "/";
	const h = String(home ?? "").replace(/[\\/]+$/, "");
	if (h && (where === h || where.startsWith(h + "/") || where.startsWith(h + "\\"))) where = "~" + where.slice(h.length);
	where = where.replace(/\s+/g, " ");
	if (where.length > FOLDER_MAX) where = "…" + where.slice(-(FOLDER_MAX - 1));
	let relayHost = "";
	if (relay && relay !== DUET_RELAY) {
		try {
			relayHost = new URL(relay).host;
		} catch {
			relayHost = String(relay);
		}
		if (relay.startsWith("http://")) relayHost = "http://" + relayHost;
	}
	return cleanText(`Join ${room} as ${name}?${relayHost ? ` · relay ${relayHost}` : ""} · ${where}`).replace(/\s+/g, " ");
}
