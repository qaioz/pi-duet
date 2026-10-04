// pi-duet: two pi sessions on two computers talk through a shared room.
// Incoming messages become new turns in this session; the agent replies with duet_send.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { envelope, fitName, isForMe, isPlaceholderName, isRelayUrl, publish, subscribe, topicFor } from "./transport.js";
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

// Only one pi process per agent dir may be in the room, or every open window would answer
// every message. The lock holds the owner's pid; a dead owner's lock is ignored.
function lockOwner(): number | undefined {
	try {
		const pid = Number(readFileSync(file("duet.lock"), "utf8"));
		if (pid === process.pid) return undefined;
		process.kill(pid, 0); // throws if that process is gone
		return pid;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	// Only a first run writes (to persist this install's id); later starts just read.
	let saved = loadConfig();
	if (!saved.fromId) saved = updateConfig(() => {});
	const fromId = saved.fromId!;
	// Env wins over the file, so one machine can run several test identities.
	let room = process.env.DUET_ROOM || saved.room;
	// Peers drop names outside the rule (letters, digits, . _ -), so an older saved name is made to fit.
	let name = process.env.DUET_NAME || saved.name;
	if (name) name = fitName(name);
	// A relay is remembered only when one was typed. Versions before the default moved to
	// duet.gaioz.online remembered https://ntfy.sh on every /duet: treat that as "the default".
	const savedServer = saved.server && saved.server.replace(/\/+$/, "") !== "https://ntfy.sh" ? saved.server : undefined;
	let server = (process.env.DUET_SERVER || savedServer || DEFAULT_SERVER).replace(/\/+$/, "");
	const cursorKey = () => `${server} ${room}`;

	let sub: { stop(): void } | undefined;
	let status = "";
	let ui: ExtensionContext["ui"] | undefined;
	const peers = new Map<string, Date>();
	// Peer-triggered turns since the human last typed — stops two polite agents ping-ponging forever.
	let autoTurns = 0;
	let warned = false;
	let announced = false; // an env join says hello once per process, not on every /reload

	const notify = (text: string, level: "info" | "warning" | "error" = "info") => ui?.notify(text, level);
	// Said wherever the lock stops this window; a crashed owner whose pid got reused needs the hint.
	const heldBy = (pid: number) => `another pi on this computer (pid ${pid}) has the room — use that one, or if it is gone delete ${file("duet.lock")}`;
	const setStatus = (text: string) => {
		status = text;
		ui?.setStatus("duet", room ? `duet: ${name}${text && ` (${text})`}` : undefined);
	};

	function onEnvelope(env: Envelope) {
		if (!isForMe(env, fromId, name!)) return;
		peers.set(env.from, new Date());
		if (env.kind === "join") return notify(`duet: ${env.from} joined`);

		const content = `[duet] from ${env.from} (the other person's agent, on their computer):\n\n${env.text}\n\nOnly your own user sees your text replies: to answer ${env.from}, call duet_send.`;
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

	function joinRoom() {
		leave();
		const owner = lockOwner();
		if (owner) return setStatus(`off: pi pid ${owner} has the room`);
		writeFileSync(file("duet.lock"), String(process.pid));
		const key = cursorKey();
		setStatus("connecting…");
		sub = subscribe({
			server,
			topic: topicFor(room!),
			since: loadConfig().cursors[key],
			onEnvelope,
			onCursor: (cursor) => updateConfig((c) => (c.cursors[key] = cursor)), // resume point after a restart
			onState: (isUp, error) => setStatus(isUp ? "" : `offline: ${error}`),
		});
	}

	function leave() {
		if (!sub) return;
		sub.stop();
		sub = undefined;
		try {
			if (readFileSync(file("duet.lock"), "utf8") === String(process.pid)) rmSync(file("duet.lock"));
		} catch {}
	}

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.hasUI ? ctx.ui : undefined;
		// No UI means `pi -p` or similar one-shot: it must not grab the room or eat its messages.
		if (!ui || !room || !name) return;
		joinRoom();
		// A join from the environment (the site's "start fresh" command) says hello like /duet does.
		if (sub && process.env.DUET_ROOM && !announced) {
			announced = true;
			publish(server, topicFor(room), envelope({ fromId, from: name, kind: "join" })).catch(() => {});
		}
	});

	// The runtime is rebuilt on /new, /resume, /reload…; session_start will rejoin.
	pi.on("session_shutdown", async () => leave());

	pi.on("input", async (event) => {
		if (event.source !== "extension") [autoTurns, warned] = [0, false];
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
				if (!sub) setStatus(owner ? `off: pi pid ${owner} has the room` : "off: /duet <room> <name> to join here");
				const state = sub ? status || "connected" : owner ? heldBy(owner) : "off here — /duet <room> <name> to join";
				return notify(`duet: ${name} in room "${room}" via ${server} — ${state}; peers seen: ${seen}`);
			}
			if (parts[0] === "off") {
				const owner = !sub && lockOwner();
				if (owner) return notify(`duet: this window is not in the room; ${heldBy(owner)}`, "error"); // leave its settings alone
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
			const owner = lockOwner();
			if (owner) return notify(`duet: ${heldBy(owner)}`, "error");
			[room, name] = [parts[0], fitName(parts[1])];
			server = (parts[2] || process.env.DUET_SERVER || DEFAULT_SERVER).replace(/\/+$/, "");
			updateConfig((c) => Object.assign(c, { room, name, server: parts[2] ? server : undefined }));
			joinRoom();
			try {
				await publish(server, topicFor(room), envelope({ fromId, from: name, kind: "join" }));
				notify(`duet: joined as ${name}`);
			} catch (err) {
				notify(`duet: joined, but announcing failed: ${(err as Error).message}`, "warning");
			}
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
		],
		parameters: Type.Object({
			text: Type.String({ description: "The message. Max ~3.8KB; split longer content into several calls." }),
			to: Type.Optional(Type.String({ description: "Recipient name, if the room has more than one other agent" })),
		}),
		async execute(_id, params, signal) {
			if (!ui) throw new Error("pi -p (no UI) can't use the duet room: use the interactive pi window that is in it.");
			// Only the window that holds the room may send: replies go to whoever is subscribed.
			const owner = !sub && lockOwner();
			if (owner) throw new Error(`Not sending: ${heldBy(owner)}.`);
			if (!sub || !room || !name) throw new Error("Not in a duet room. Ask the user to run /duet <room> <name>.");
			await publish(server, topicFor(room), envelope({ fromId, from: name, kind: "msg", to: params.to, text: params.text }), signal);
			return {
				content: [{ type: "text", text: "sent — not yet answered; their reply will arrive later as a new message" }],
				details: {},
			};
		},
	});
}
