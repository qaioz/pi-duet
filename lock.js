// One owner per room and name on this computer, shared by every duet client: pi, the MCP server
// (Codex, and Claude Code's channel route) and the Claude Code plugin (hooks/duet.js, through $.fs).
// Without it a Claude Code window and a Codex window in the same room under the same name would both
// answer every message.
//
// The lock is ~/.duet/<hash>.lock (DUET_HOME overrides ~/.duet), where hash is the first 16 hex
// characters of sha256("<relay> <room> <name>"). It holds JSON:
//   { v: 2, client: "pi" | "codex" | "mcp" | "claude-code", token, pid, cwd, at }
// The owner rewrites `at` every LOCK_BEAT_MS. A lock is held while `at` is under LOCK_FRESH_MS old,
// unless its pid is known to be gone. Version 1, written by older pi and MCP servers, was a bare pid,
// held while that process lives. Owners read the lock back at every beat: another token there means
// the room was taken over (the other client found this one stale), and this one leaves. An empty or
// released lock is free.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
	if (/^\d+$/.test(text)) return { v: 1, pid: Number(text) };
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
	if (l.v === 1) return !!l.pid && pidAlive(l.pid);
	if (l.pid && l.pid !== process.pid && !pidAlive(l.pid)) return false;
	return now - (Number(l.at) || 0) < LOCK_FRESH_MS;
}

/** Who holds it, said for a person: "Codex (pid 123, /work/repo)". */
export function describeHolder(l) {
	const who = { pi: "pi", codex: "Codex", mcp: "a duet MCP server", "claude-code": "Claude Code" }[l?.client] ?? (l?.v === 1 ? "another duet window" : "another duet client");
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
	if (cur && cur.token !== me.token) return false; // missing (deleted by hand, unreadable): ours again
	write(path, me);
	return true;
}

export function releaseLock(path, me) {
	try {
		if (readLock(path)?.token === me.token) rmSync(path);
	} catch {}
}
