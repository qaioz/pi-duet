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

// ntfy.sh turns bodies over 4096 bytes into attachments; stay well under.
export const MAX_BYTES = 3800;
const WATCHDOG_MS = 90_000; // ntfy sends a keepalive every ~45s
const MAX_BACKOFF_MS = 30_000;
// ntfy.sh writes its message cache in batches (observed 1–3s lag), so a `since=` reconnect can miss
// a message published just before it. Re-poll the same range once the cache has caught up.
const REPAIR_POLL_MS = 10_000;

// The room name is the shared secret; only its hash ever reaches the server.
export function topicFor(room: string): string {
	return "duet_" + createHash("sha256").update("pi-duet:" + room).digest("hex").slice(0, 40);
}

export function envelope(fields: Pick<Envelope, "fromId" | "from" | "kind" | "to" | "text">): Envelope {
	return { v: 1, id: randomUUID(), ...fields, ts: new Date().toISOString() };
}

// Drop our own echoes (by install id, since two people may share a display name) and
// messages addressed to someone else.
export function isForMe(env: Envelope, myFromId: string, myName: string): boolean {
	if (env.fromId === myFromId) return false;
	return !env.to || env.to.toLowerCase() === myName.toLowerCase();
}

export async function publish(server: string, topic: string, env: Envelope): Promise<void> {
	const body = JSON.stringify(env);
	const bytes = Buffer.byteLength(body);
	if (bytes > MAX_BYTES) {
		throw new Error(`message is ${bytes} bytes, the limit is ${MAX_BYTES}. Split it into several duet_send calls.`);
	}
	const res = await fetch(`${server}/${topic}`, { method: "POST", body });
	if (!res.ok) {
		const hint = res.status === 429 ? " (ntfy rate limit — wait a bit and retry)" : "";
		throw new Error(`publish failed: HTTP ${res.status}${hint}: ${(await res.text()).slice(0, 200)}`);
	}
}

export type Subscription = { stop(): void };

export type SubscribeOptions = {
	server: string;
	topic: string;
	since?: string; // last ntfy message id seen; catches up on anything cached after it
	onEnvelope(env: Envelope): void;
	onCursor?(ntfyId: string): void; // persist this and pass it back as `since` after a restart
	onState?(connected: boolean, error?: string): void;
};

// Streams {server}/{topic}/json forever, reconnecting with backoff, until stop().
export function subscribe(opts: SubscribeOptions): Subscription {
	let stopped = false;
	let current: AbortController | undefined;
	let wake: (() => void) | undefined; // cuts the backoff sleep short on stop()
	let since = opts.since;
	const seen = new Set<string>();

	// `live` lines come from the stream in order; repair-poll lines may be older, so they don't move the cursor.
	const handleLine = (line: string, live: boolean) => {
		let evt: any;
		try {
			evt = JSON.parse(line);
		} catch {
			return;
		}
		if (evt.event !== "message" || typeof evt.id !== "string" || seen.has(evt.id)) return;
		seen.add(evt.id);
		if (seen.size > 1000) seen.delete(seen.values().next().value!);
		if (live) {
			since = evt.id;
			opts.onCursor?.(evt.id);
		}
		let env: any;
		try {
			env = JSON.parse(evt.message);
		} catch {
			return; // someone else's noise on the topic
		}
		if (env?.v === 1 && (env.kind === "msg" || env.kind === "join") && typeof env.fromId === "string") {
			opts.onEnvelope(env);
		}
	};

	const repairPoll = async (from: string, signal: AbortSignal) => {
		await delay(REPAIR_POLL_MS, undefined, { signal });
		const res = await fetch(`${opts.server}/${opts.topic}/json?poll=1&since=${encodeURIComponent(from)}`, { signal });
		for (const line of (await res.text()).split("\n")) handleLine(line, false);
	};

	const connectOnce = async () => {
		const ctrl = new AbortController();
		current = ctrl;
		let watchdog: NodeJS.Timeout | undefined;
		const pet = () => {
			clearTimeout(watchdog);
			watchdog = setTimeout(() => ctrl.abort(new Error("no data for 90s")), WATCHDOG_MS);
		};
		try {
			pet();
			const url = `${opts.server}/${opts.topic}/json` + (since ? `?since=${encodeURIComponent(since)}` : "");
			const res = await fetch(url, { signal: ctrl.signal });
			if (!res.ok || !res.body) throw new Error(`subscribe failed: HTTP ${res.status}`);
			opts.onState?.(true);
			if (since) repairPoll(since, ctrl.signal).catch(() => {});
			const decoder = new TextDecoder();
			let buf = "";
			for await (const chunk of res.body) {
				pet();
				buf += decoder.decode(chunk, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					handleLine(buf.slice(0, nl), true);
					buf = buf.slice(nl + 1);
				}
			}
			throw new Error("stream ended");
		} finally {
			clearTimeout(watchdog);
		}
	};

	(async () => {
		let backoff = 1000;
		while (!stopped) {
			const startedAt = Date.now();
			try {
				await connectOnce();
			} catch (err) {
				if (stopped) break;
				opts.onState?.(false, (err as Error).message);
			}
			if (Date.now() - startedAt > 60_000) backoff = 1000; // it was a healthy connection
			await new Promise<void>((r) => {
				const t = setTimeout(r, backoff);
				wake = () => (clearTimeout(t), r());
			});
			backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
		}
	})();

	return {
		stop() {
			stopped = true;
			current?.abort();
			wake?.();
		},
	};
}
