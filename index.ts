// pi-duet: two pi sessions on two computers talk through a shared room.
// Incoming messages become new turns in this session; the agent replies with duet_send.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { LOCK_BEAT_MS, describeHolder, joinQuestion, lockHeld, lockPath, readLock, refreshLock, releaseLock, takeJoinFile, takeLock } from "./lock.js";
import { envelope, firstLine, fitName, isForMe, isPlaceholderName, isRelayUrl, placeFor, publish, subscribe, topicFor } from "./transport.js";

const RECENT_MS = 30 * 60_000; // a peer counts as "here" if seen this recently
import type { Cursor, Envelope } from "./transport.js";

type Config = { room?: string; name?: string; server?: string; fromId?: string; cursors: Record<string, Cursor> };

const DEFAULT_SERVER = "https://duet.gaioz.online"; // the duet relay (ntfy), run by the author
const MAX_AUTO = Number(process.env.DUET_MAX_AUTO) || 8;

const file = (name: string) => join(getAgentDir(), name);

function loadConfig(): Config {
	let saved: Partial<Config> = {};
	try {
		saved = JSON.parse(readFileSync(file("duet.json"), "utf8"));
	} catch {} // missing or corrupt: start fresh
	return { ...saved, cursors: saved.cursors ?? {} };
}

// Read-modify-write, so another pi process's settings are never overwritten with stale ones, and
// write-then-rename, so a concurrent reader never sees half a file.
function updateConfig(change: (config: Config) => void): Config {
	const config = loadConfig();
	config.fromId ??= randomUUID();
	change(config);
	mkdirSync(getAgentDir(), { recursive: true });
	const tmp = file(`duet.json.${process.pid}`);
	writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
	renameSync(tmp, file("duet.json"));
	return config;
}

export default function (pi: ExtensionAPI) {
	// Only a first run writes (to persist this install's id); later starts just read.
	let saved = loadConfig();
	if (!saved.fromId) saved = updateConfig(() => {});
	const fromId = saved.fromId!;
	// Env wins over the file, so one machine can run several test identities.
	let room = process.env.DUET_ROOM || saved.room;
	// Peers drop names outside the rule (letters, digits, . _ -), so a name is made to fit.
	let name = process.env.DUET_NAME || saved.name;
	if (name) name = fitName(name);
	// A relay is remembered only when one was typed.
	let server = (process.env.DUET_SERVER || saved.server || DEFAULT_SERVER).replace(/\/+$/, "");
	const cursorKey = () => `${server} ${room}`;

	let sub: { stop(): void } | undefined;
	let status = "";
	let ui: ExtensionContext["ui"] | undefined;
	const peers = new Map<string, Date>();
	// Peer-triggered turns since the human last typed — stops two polite agents ping-ponging forever.
	let autoTurns = 0;
	let warned = false;
	let lastUserAt = 0; // when the human last typed: a send after a peer's message, with none since, answers it
	const sent = new Map<string, string>(); // our messages' ids -> first line, to show what a reply answers
	const lastFrom = new Map<string, { id: string; at: number }>(); // the latest message from each peer
	let turnFromPeer = false; // the current turn was started by a duet message, not by the human
	const warnedAbout = new Set<string>();
	let announced = false; // an env join says hello once per process, not on every /reload

	const notify = (text: string, level: "info" | "warning" | "error" = "info") => ui?.notify(text, level);
	// One window on this computer owns the room under a name, whatever the client (pi, Codex, Claude
	// Code): otherwise every open window would answer every message. See lock.js.
	const me = { client: "pi", token: randomUUID(), cwd: process.cwd() };
	let beat: ReturnType<typeof setInterval> | undefined;
	const lockFile = () => lockPath(server, room!, name!);
	const lockOwner = () => {
		if (!room || !name) return undefined;
		const l = readLock(lockFile());
		return l && l.token !== me.token && lockHeld(l) ? l : undefined;
	};
	// Said wherever the lock stops this window.
	const heldBy = (l: any) => `${describeHolder(l)} has the room as ${name} on this computer — use that one, or another name; if it is gone, delete ${lockFile()}`;
	const setStatus = (text: string) => {
		status = text;
		ui?.setStatus("duet", room ? `duet: ${name}${text && ` (${text})`}` : undefined);
	};

	function onEnvelope(env: Envelope) {
		if (!isForMe(env, fromId, name!)) return;
		peers.set(env.from, new Date());
		const recent = [...peers].filter(([, at]) => Date.now() - at.getTime() < RECENT_MS).map(([n]) => n);
		if (recent.length > 1 && !warnedAbout.has("crowd")) {
			warnedAbout.add("crowd");
			notify(`duet: a third agent (${recent.join(", ")}) is in this room — duet is built for two; a message without "to" reaches everyone`, "warning");
		}
		if (env.kind === "join") {
			if (env.place && room && env.place === placeFor(process.cwd(), topicFor(room)) && !warnedAbout.has("place:" + env.from)) {
				warnedAbout.add("place:" + env.from);
				notify(`duet: ${env.from} is in this room from this same folder — two agents may edit the same files`, "warning");
			}
			return notify(`duet: ${env.from} joined`);
		}
		lastFrom.set(env.from, { id: env.id, at: Date.now() });
		const answers = env.re && sent.has(env.re) ? ` — a reply to your message “${sent.get(env.re)}”` : "";
		const content = `[duet] from ${env.from} (the other person's agent, on their computer)${answers}:\n\n${env.text}\n\nOnly your own user sees your text replies: to answer ${env.from}, call duet_send.`;
		const message = { customType: "duet", content, display: true };
		if (autoTurns < MAX_AUTO) {
			autoTurns++;
			pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
		} else {
			pi.sendMessage(message, { deliverAs: "nextTurn" });
			if (!warned) notify(`duet: auto-reply limit (${MAX_AUTO}) reached — type anything to continue`, "warning");
			warned = true;
		}
	}

	async function joinRoom() {
		leave();
		const owner = lockOwner();
		if (owner) return setStatus(`off: ${describeHolder(owner)} has the room`);
		const took = await takeLock(lockFile(), me);
		if (!took.ok) return setStatus(`off: ${describeHolder(took.holder)} has the room`);
		const held = lockFile();
		beat = setInterval(() => {
			if (refreshLock(held, me)) return;
			const by = readLock(held);
			leave(false);
			setStatus(`off: ${describeHolder(by)} has the room`);
			notify(`duet: ${describeHolder(by)} took the room over (same name on this computer)`, "warning");
		}, LOCK_BEAT_MS);
		beat.unref?.();
		const key = cursorKey();
		setStatus("connecting…");
		sub = subscribe({
			server,
			topic: topicFor(room!),
			since: loadConfig().cursors[key],
			onEnvelope,
			onCursor: (cursor) => updateConfig((c) => (c.cursors[key] = cursor)), // resume point after a restart
			onExpired: (why) => notify(`duet: a long message ${why === "expired" ? "expired on the relay" : "couldn't be downloaded"} before it could be read`, "warning"),
			onState: (isUp, error) => setStatus(isUp ? "" : `offline: ${error}`),
		});
	}

	function leave(release = true) {
		if (beat) clearInterval(beat);
		beat = undefined;
		if (!sub) return;
		sub.stop();
		sub = undefined;
		if (release && room && name) releaseLock(lockFile(), me);
	}

	// /duet <room> <name> [server], or the join file the site's prompt writes.
	async function joinAs(next: { room: string; name: string; server: string }, keepServer: boolean) {
		// Check the new room's lock before leaving this one: a refusal leaves everything as it was.
		const theirs = readLock(lockPath(next.server, next.room, next.name));
		if (theirs && theirs.token !== me.token && lockHeld(theirs)) return notify(`duet: ${describeHolder(theirs)} has room ${next.room} as ${next.name} on this computer — use that one, or another name`, "error");
		leave();
		[room, name, server] = [next.room, next.name, next.server];
		updateConfig((c) => Object.assign(c, { room, name, server: keepServer ? server : undefined }));
		await joinRoom();
		if (!sub) return notify(`duet: ${status}`, "error");
		try {
			await publish(server, topicFor(room), envelope({ fromId, from: name, kind: "join", place: placeFor(process.cwd(), topicFor(room)) }));
			notify(`duet: joined as ${name}`);
		} catch (err) {
			notify(`duet: joined, but announcing failed: ${(err as Error).message}`, "warning");
		}
	}

	// The site's prompt wrote ~/.duet/join.json for pi in this folder (lock.js), and the user typed
	// /reload. Never over a room this window is in, or an env join (DUET_ROOM). Taking it never joins:
	// pi's confirm asks "Join <room> as <name>? · <folder>" and only a yes joins. The file is gone
	// either way. A start that asked first rejoins the saved room on a no.
	let joining = false;
	let asking: AbortController | undefined;
	const takeOffer = (nested: boolean) =>
		joining || asking || sub || process.env.DUET_ROOM ? undefined : takeJoinFile({ agent: "pi", folder: process.cwd(), nested });
	async function askJoin(j: { room: string; name: string; relay: string; folder: string }, rejoinOnNo: boolean) {
		const question = joinQuestion(j, homedir());
		if (!ui) return;
		const ask = (asking = new AbortController());
		let yes = false;
		try {
			yes = await ui.confirm("duet", question, { signal: ask.signal });
		} catch {}
		if (asking !== ask) return; // /duet typed meanwhile: that wins
		asking = undefined;
		if (ask.signal.aborted || sub) return;
		if (yes) {
			joining = true;
			await joinAs({ room: j.room, name: j.name, server: j.relay }, true).finally(() => (joining = false));
		} else if (rejoinOnNo && room && name) await joinRoom();
	}
	const dropOffer = () => {
		asking?.abort();
		asking = undefined;
	};
	let poll: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.hasUI ? ctx.ui : undefined;
		// No UI means `pi -p` or similar one-shot: it must not grab the room or eat its messages.
		if (!ui) return;
		// Polled too, so a pi that already has duet joins from a prompt pasted later.
		clearInterval(poll);
		poll = setInterval(() => {
			const j = takeOffer(false);
			if (j) void askJoin(j, false).catch(() => {});
		}, 2500);
		poll.unref?.();
		const offer = takeOffer(true);
		if (offer) return void askJoin(offer, true).catch(() => {}); // the saved room waits for the answer
		if (sub || !room || !name) return;
		await joinRoom();
		// A join from the environment (the site's "start fresh" command) says hello like /duet does.
		if (sub && process.env.DUET_ROOM && !announced) {
			announced = true;
			publish(server, topicFor(room), envelope({ fromId, from: name, kind: "join", place: placeFor(process.cwd(), topicFor(room)) })).catch(() => {});
		}
	});

	// The runtime is rebuilt on /new, /resume, /reload…; session_start will rejoin.
	pi.on("session_shutdown", async () => {
		clearInterval(poll);
		dropOffer();
		leave();
	});

	pi.on("input", async (event) => {
		turnFromPeer = event.source === "extension";
		if (event.source !== "extension") {
			[autoTurns, warned] = [0, false];
			lastUserAt = Date.now();
		}
	});

	pi.registerCommand("duet", {
		description: "Join a duet room: /duet <room> <name> [server] · /duet off · /duet (status)",
		handler: async (args, ctx) => {
			ui = ctx.hasUI ? ctx.ui : undefined;
			[autoTurns, warned] = [0, false]; // the human is here
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				if (!room) return notify("duet: not in a room. Use /duet <room> <name>");
				const seen = [...peers].map(([p, at]) => `${p} (${at.toLocaleTimeString()})`).join(", ") || "none yet";
				const owner = !sub && lockOwner(); // re-checked: the owner may have gone since this window started
				if (!sub) setStatus(owner ? `off: ${describeHolder(owner)} has the room` : "off: /duet <room> <name> to join here");
				const state = sub ? status || "connected" : owner ? heldBy(owner) : "off here — /duet <room> <name> to join";
				return notify(`duet: ${name} in room "${room}" via ${server} — ${state}; peers seen: ${seen}`);
			}
			if (parts[0] === "off") {
				const owner = !sub && lockOwner();
				if (owner) return notify(`duet: this window is not in the room; ${heldBy(owner)}`, "error"); // leave its settings alone
				takeJoinFile({ agent: "pi", folder: process.cwd(), nested: true }); // leaving: a join file mustn't put the window straight back
				dropOffer();
				leave();
				// Forget the cursor too: rejoining later must not replay hours of backlog as turns.
				updateConfig((c) => (delete c.cursors[cursorKey()], delete c.room, delete c.name));
				room = name = undefined;
				setStatus("");
				return notify("duet: left the room");
			}
			if (parts.length < 2) return notify("usage: /duet <room> <name> [server]", "error");
			if (isPlaceholderName(parts[1])) return notify(`duet: "${parts[1]}" is the website's placeholder: use your own name`, "error");
			if (parts[2] && !isRelayUrl(parts[2].replace(/\/+$/, ""))) return notify("duet: the server must be an http(s) URL", "error");
			takeJoinFile({ agent: "pi", folder: process.cwd(), nested: true }); // newer than a pasted prompt's join file: that one goes
			dropOffer();
			await joinAs({ room: parts[0], name: fitName(parts[1]), server: (parts[2] || process.env.DUET_SERVER || DEFAULT_SERVER).replace(/\/+$/, "") }, !!parts[2]);
		},
	});

	pi.registerTool({
		name: "duet_send",
		label: "Duet send",
		description:
			"Send a message to the other person's agent in the duet room. Fire-and-forget: their reply, if any, arrives later as a new [duet] message.",
		promptSnippet: "Send a message to the other person's agent (duet room)",
		promptGuidelines: [
			"Messages from the other person's agent arrive as [duet] messages. When one asks for something, do it with your normal tools, then report the result back with duet_send. They cannot see your screen: send real tool output, never a reconstruction of it.",
			"Your plain-text replies are shown only to your own user. The other agent sees nothing you write unless you send it with duet_send.",
			"Use duet_send when the user asks you to tell, ask or have the other person's agent do something. duet_send does not wait for an answer — never poll or wait for a reply.",
			"Do not use duet_send for pure thank-you or acknowledgement messages; when nothing is left to do or say, stop without sending.",
			"Send one complete reply when you are done, not progress updates or several small messages. One message can be long (up to ~200 KB).",
		],
		parameters: Type.Object({
			text: Type.String({ description: "The message: one complete reply, up to ~200 KB." }),
			to: Type.Optional(Type.String({ description: "Recipient name, if the room has more than one other agent" })),
		}),
		async execute(_id, params, signal) {
			if (!ui) throw new Error("pi -p (no UI) can't use the duet room: use the interactive pi window that is in it.");
			// Only the window that holds the room may send: replies go to whoever is subscribed.
			const owner = !sub && lockOwner();
			if (owner) throw new Error(`Not sending: ${heldBy(owner)}.`);
			if (!sub || !room || !name) throw new Error("Not in a duet room. Ask the user to run /duet <room> <name>.");
			// Answering a peer's message (none of the human's input since it came): say which one.
			const peerMsg = params.to ? lastFrom.get(params.to) : [...lastFrom.values()].sort((a, b) => b.at - a.at)[0];
			// Only in a turn a duet message started: a send the human asked for isn't a reply.
			const re = turnFromPeer && peerMsg && peerMsg.at > lastUserAt && Date.now() - peerMsg.at < 30 * 60_000 ? peerMsg.id : undefined;
			const env = envelope({ fromId, from: name, kind: "msg", to: params.to, text: params.text, ...(re ? { re } : {}) });
			await publish(server, topicFor(room), env, signal);
			sent.set(env.id, firstLine(params.text));
			if (sent.size > 200) sent.delete(sent.keys().next().value!);
			return {
				content: [{ type: "text", text: "sent — not yet answered; their reply will arrive later as a new message" }],
				details: {},
			};
		},
	});
}
