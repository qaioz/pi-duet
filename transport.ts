// The whole wire: ntfy pub/sub over plain HTTP. Swapping the relay means editing only this file.
// Kept to erasable TypeScript so Node can also import it directly (test/e2e.mjs).
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export type Envelope = {
	v: 1;
	id: string;
	fromId: string; // random per install — how we recognise our own echoes
	from: string; // display name, not unique
	to?: string;
	kind: "msg" | "join";
	text?: string;
	ts: string;
};

// Where a subscriber left off: the last ntfy message id seen and its time (unix seconds).
export type Cursor = { id: string; time: number };

// ntfy.sh turns bodies over 4096 bytes into attachments; stay well under.
export const MAX_BYTES = 3800;
const WATCHDOG_MS = 90_000; // ntfy sends a keepalive every ~45s
const MAX_BACKOFF_MS = 30_000;
// ntfy.sh writes its message cache in batches (observed 0.5–4s lag), so a `since=` reconnect can miss
// a message published just before it. Re-poll the same range once the cache has caught up.
const REPAIR_POLL_MS = 10_000;

// The room name is the shared secret; only its hash ever reaches the server.
export function topicFor(room: string): string {
	return "duet_" + createHash("sha256").update("pi-duet:" + room).digest("hex").slice(0, 40);
}

export function envelope(fields: Pick<Envelope, "fromId" | "from" | "kind" | "to" | "text">): Envelope {
	return { v: 1, id: randomUUID(), ...fields, ts: new Date().toISOString() };
}

// Anything on the topic that isn't a well-formed envelope is someone else's noise.
function isEnvelope(e: any): e is Envelope {
	return (
		e?.v === 1 &&
		typeof e.fromId === "string" &&
		typeof e.from === "string" &&
		(e.to === undefined || typeof e.to === "string") &&
		(e.kind === "join" || (e.kind === "msg" && typeof e.text === "string"))
	);
}

// Drop our own echoes (by install id, since two people may share a display name) and
// messages addressed to someone else.
export function isForMe(env: Envelope, myFromId: string, myName: string): boolean {
	if (env.fromId === myFromId) return false;
	return !env.to || env.to.toLowerCase() === myName.toLowerCase();
}

export async function publish(server: string, topic: string, env: Envelope, signal?: AbortSignal): Promise<void> {
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
export function subscribe(opts: {
	server: string;
	topic: string;
	since?: Cursor;
	onEnvelope(env: Envelope): void;
	onCursor?(cursor: Cursor): void;
	onState?(connected: boolean, error?: string): void;
}): { stop(): void } {
	const life = new AbortController(); // aborted by stop(): ends streams, polls and sleeps
	let since = opts.since;
	const seen = new Set<string>();

	// `live` lines come from the stream in order; repair-poll lines may be older, so they don't move the cursor.
	const handleLine = (line: string, live: boolean, floor?: Cursor) => {
		let evt: any;
		let env: any;
		try {
			evt = JSON.parse(line);
			if (evt.event !== "message" || typeof evt.id !== "string" || seen.has(evt.id)) return;
			// ntfy answers a since= id it doesn't have (expired, or <1s old and not yet cached — observed)
			// with its whole cache. Skip everything at or before the point we resumed from.
			if (floor && (evt.id === floor.id || evt.time < floor.time)) return;
			env = JSON.parse(evt.message);
		} catch {
			return;
		}
		seen.add(evt.id);
		if (seen.size > 1000) seen.delete(seen.values().next().value!);
		if (live) {
			since = { id: evt.id, time: evt.time };
			opts.onCursor?.(since);
		}
		if (isEnvelope(env)) opts.onEnvelope(env);
	};

	const connectOnce = async () => {
		const ctrl = new AbortController();
		const signal = AbortSignal.any([life.signal, ctrl.signal]);
		let watchdog: NodeJS.Timeout | undefined;
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
				let nl: number;
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
				opts.onState?.(false, (err as Error).message);
			}
			if (Date.now() - startedAt > 60_000) backoff = 1000; // it was a healthy connection
			await delay(backoff, undefined, { signal: life.signal }).catch(() => {});
			backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
		}
	})();

	return { stop: () => life.abort() };
}
