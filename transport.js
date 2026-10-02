// The whole wire: ntfy pub/sub over plain HTTP. Swapping the relay means editing only this file.
// Plain JavaScript (types in JSDoc): the MCP server runs from node_modules via npx, where Node refuses
// to strip TypeScript, and the pi extension imports this same file.
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/**
 * @typedef {object} Envelope
 * @property {1} v
 * @property {string} id
 * @property {string} fromId random per install — how we recognise our own echoes
 * @property {string} from display name, not unique
 * @property {string} [to]
 * @property {"msg" | "join"} kind
 * @property {string} [text]
 * @property {string} ts
 */

/** Where a subscriber left off: the last ntfy message id seen and its time (unix seconds).
 * @typedef {{ id: string, time: number }} Cursor */

// ntfy.sh turns bodies over 4096 bytes into attachments; stay well under.
export const MAX_BYTES = 3800;
const WATCHDOG_MS = 90_000; // ntfy sends a keepalive every ~45s
const MAX_BACKOFF_MS = 30_000;
// ntfy.sh writes its message cache in batches (observed 0.5–4s lag), so a `since=` reconnect can miss
// a message published just before it. Re-poll the same range once the cache has caught up.
const REPAIR_POLL_MS = 10_000;

// The room name is the shared secret; only its hash ever reaches the server.
/** @param {string} room */
export function topicFor(room) {
	return "duet_" + createHash("sha256").update("pi-duet:" + room).digest("hex").slice(0, 40);
}

/** @param {Pick<Envelope, "fromId" | "from" | "kind" | "to" | "text">} fields @returns {Envelope} */
export function envelope(fields) {
	return { v: 1, id: randomUUID(), ...fields, ts: new Date().toISOString() };
}

// Names end up in prompts, status lines and command lines: letters, digits, . _ - only.
const NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._-]{0,39}$/u; // starts with a letter or digit
/** @param {unknown} name */
export const isName = (name) => typeof name === "string" && NAME.test(name);
// The site's stand-in before a name is typed; joining under it means the commands were copied too early.
/** @param {unknown} name */
export const isPlaceholderName = (name) => typeof name === "string" && /^your[-_ ]?name$/i.test(name);
// A name that breaks the rule, made to fit it (e.g. a name saved by an older version).
/** @param {string} name */
export const fitName = (name) =>
	isName(name)
		? name
		: Array.from(name.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-").replace(/^[^\p{L}\p{N}]+/u, "")).slice(0, 40).join("") || "anon";

// A relay is a plain http(s) server URL. It goes into shell commands and config files, so it may
// hold nothing a shell or TOML would read specially.
/** @param {string} url */
export function isRelayUrl(url) {
	return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(url);
}

// Anything on the topic that isn't a well-formed envelope is someone else's noise.
/** @returns {e is Envelope} */
function isEnvelope(/** @type {any} */ e) {
	return (
		e?.v === 1 &&
		typeof e.fromId === "string" &&
		typeof e.from === "string" &&
		NAME.test(e.from) &&
		typeof e.ts === "string" &&
		(e.to === undefined || typeof e.to === "string") &&
		// No NUL (it can't be passed to a program) and nothing far over what a sender may publish.
		(e.kind === "join" || (e.kind === "msg" && typeof e.text === "string" && e.text.length <= 4 * MAX_BYTES && !e.text.includes("\0")))
	);
}

// Drop our own echoes (by install id, since two people may share a display name) and
// messages addressed to someone else.
/** @param {Envelope} env @param {string} myFromId @param {string} myName */
export function isForMe(env, myFromId, myName) {
	if (env.fromId === myFromId) return false;
	return !env.to || env.to.normalize("NFC").toLowerCase() === myName.normalize("NFC").toLowerCase();
}

/** @param {string} server @param {string} topic @param {Envelope} env @param {AbortSignal} [signal] */
export async function publish(server, topic, env, signal) {
	// Receivers drop a text with NUL, so don't pretend it was delivered.
	if (env.text?.includes("\0")) throw new Error("message contains a NUL character; remove it and send again.");
	const body = JSON.stringify(env);
	const bytes = Buffer.byteLength(body);
	if (bytes > MAX_BYTES) {
		throw new Error(`message is ${bytes} bytes, the limit is ${MAX_BYTES}. Split it into several duet_send calls.`);
	}
	const timeout = AbortSignal.timeout(15_000);
	const res = await fetch(`${server}/${topic}`, { method: "POST", body, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
	if (!res.ok) {
		const hint = res.status === 429 ? " (ntfy rate limit — wait a bit and retry)" : "";
		throw new Error(`publish failed: HTTP ${res.status}${hint}: ${(await res.text()).slice(0, 200)}`);
	}
}

// Streams {server}/{topic}/json until stop(), reconnecting with backoff. A subscriber resumed from
// `since` catches up on anything cached after it. Every new live message moves the cursor, reported
// through onCursor so the caller can persist it for the next restart.
/**
 * @param {{
 *   server: string, topic: string, since?: Cursor,
 *   onEnvelope(env: Envelope): void,
 *   onCursor?(cursor: Cursor): void,
 *   onState?(connected: boolean, error?: string): void,
 * }} opts
 * @returns {{ stop(): void }}
 */
export function subscribe(opts) {
	const life = new AbortController(); // aborted by stop(): ends streams, polls and sleeps
	let since = opts.since;
	const seen = new Set();

	// `live` lines come from the stream in order; repair-poll lines may be older, so they don't move the cursor.
	/** @param {string} line @param {boolean} live @param {Cursor} [floor] */
	const handleLine = (line, live, floor) => {
		let evt;
		let env;
		try {
			evt = JSON.parse(line);
			if (evt.event !== "message" || typeof evt.id !== "string" || seen.has(evt.id)) return;
			// ntfy answers a since= id it doesn't have (expired, or <1s old and not yet cached — observed)
			// with its whole cache. Skip everything at or before the point we resumed from. Times are whole
			// seconds, so an older message from the cursor's own second can come through twice: a rare
			// duplicate beats a lost message.
			if (floor && (evt.id === floor.id || evt.time < floor.time)) return;
			env = JSON.parse(evt.message);
		} catch {
			return;
		}
		seen.add(evt.id);
		if (seen.size > 1000) seen.delete(seen.values().next().value);
		// Hand the message over before reporting the cursor past it, so a caller can hold the cursor
		// back until the message is really consumed. A failing handler must not end the stream.
		if (isEnvelope(env)) {
			try {
				opts.onEnvelope(env);
			} catch {}
		}
		if (live) {
			since = { id: evt.id, time: evt.time };
			opts.onCursor?.(since);
		}
	};

	const connectOnce = async () => {
		const ctrl = new AbortController();
		const signal = AbortSignal.any([life.signal, ctrl.signal]);
		let watchdog;
		const pet = () => {
			clearTimeout(watchdog);
			watchdog = setTimeout(() => ctrl.abort(new Error("no data for 90s")), WATCHDOG_MS);
		};
		try {
			pet();
			const floor = since;
			const q = floor ? `?since=${encodeURIComponent(floor.id)}` : "";
			const res = await fetch(`${opts.server}/${opts.topic}/json${q}`, { signal });
			if (!res.ok || !res.body) throw new Error(`subscribe failed: HTTP ${res.status}`);
			opts.onState?.(true);
			if (floor) {
				delay(REPAIR_POLL_MS, undefined, { signal })
					.then(() => fetch(`${opts.server}/${opts.topic}/json?poll=1&since=${encodeURIComponent(floor.id)}`, { signal }))
					.then((r) => r.text())
					.then((text) => text.split("\n").forEach((line) => handleLine(line, false, floor)))
					.catch(() => {});
			}
			const decoder = new TextDecoder();
			let buf = "";
			for await (const chunk of res.body) {
				pet();
				buf += decoder.decode(chunk, { stream: true });
				let nl;
				while ((nl = buf.indexOf("\n")) >= 0) {
					handleLine(buf.slice(0, nl), true, floor);
					buf = buf.slice(nl + 1);
				}
			}
			throw new Error("stream ended");
		} finally {
			clearTimeout(watchdog);
			ctrl.abort(); // ends the repair poll with its connection
		}
	};

	(async () => {
		let backoff = 1000;
		while (!life.signal.aborted) {
			const startedAt = Date.now();
			try {
				await connectOnce();
			} catch (err) {
				if (life.signal.aborted) break;
				opts.onState?.(false, err.message);
			}
			if (Date.now() - startedAt > 60_000) backoff = 1000; // it was a healthy connection
			await delay(backoff, undefined, { signal: life.signal }).catch(() => {});
			backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
		}
	})();

	return { stop: () => life.abort() };
}
