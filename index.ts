// pi-duet: two pi sessions on two computers talk through a shared room.
// Incoming messages become new turns in this session; the agent replies with duet_send.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { type Envelope, envelope, isForMe, publish, type Subscription, subscribe, topicFor } from "./transport.ts";

type Config = { room?: string; name?: string; server?: string; fromId: string; lastIds: Record<string, string> };

const DEFAULT_SERVER = "https://ntfy.sh";
const MAX_AUTO = process.env.DUET_MAX_AUTO ? Number(process.env.DUET_MAX_AUTO) : 8;

const configPath = () => join(getAgentDir(), "duet.json");

function loadConfig(): Config {
	const file: Partial<Config> = existsSync(configPath()) ? JSON.parse(readFileSync(configPath(), "utf8")) : {};
	const config: Config = { ...file, fromId: file.fromId ?? randomUUID(), lastIds: file.lastIds ?? {} };
	if (!file.fromId) saveConfig(config);
	return config;
}

function saveConfig(config: Config) {
	mkdirSync(dirname(configPath()), { recursive: true });
	writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n");
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	// Env wins over the file, so one machine can run several test identities.
	let room = process.env.DUET_ROOM || config.room;
	let name = process.env.DUET_NAME || config.name;
	let server = (process.env.DUET_SERVER || config.server || DEFAULT_SERVER).replace(/\/+$/, "");

	let sub: Subscription | undefined;
	let connected = false;
	let lastError: string | undefined;
	let ui: ExtensionContext["ui"] | undefined;
	const peers = new Map<string, Date>();
	// Peer-triggered turns since the human last typed — stops two polite agents ping-ponging forever.
	let autoTurns = 0;
	let warned = false;

	const notify = (text: string, level: "info" | "warning" | "error" = "info") => ui?.notify(text, level);
	const showStatus = () =>
		ui?.setStatus("duet", room ? `duet: ${name}${connected ? "" : lastError ? ` (offline: ${lastError})` : " (connecting…)"}` : undefined);

	function onEnvelope(env: Envelope) {
		if (!isForMe(env, config.fromId, name!)) return;
		peers.set(env.from, new Date());
		if (env.kind === "join") return notify(`duet: ${env.from} joined`);

		const content = `[duet] from ${env.from} (the other person's agent, on their computer):\n\n${env.text}\n\nReply with duet_send if a reply is needed.`;
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

	function join() {
		const joined = room!;
		sub?.stop();
		connected = false;
		sub = subscribe({
			server,
			topic: topicFor(joined),
			since: config.lastIds[joined],
			onEnvelope,
			onCursor(ntfyId) {
				config.lastIds[joined] = ntfyId; // resume point for catch-up after a restart
				saveConfig(config);
			},
			onState(isUp, error) {
				connected = isUp;
				lastError = error;
				showStatus();
			},
		});
		showStatus();
	}

	function leave() {
		sub?.stop();
		sub = undefined;
		connected = false;
	}

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.hasUI ? ctx.ui : undefined;
		if (room && name) join();
	});

	// The runtime is rebuilt on /new, /resume, /reload…; session_start will rejoin.
	pi.on("session_shutdown", async () => leave());

	pi.on("input", async (event) => {
		if (event.source !== "extension") {
			autoTurns = 0;
			warned = false;
		}
	});

	pi.registerCommand("duet", {
		description: "Join a duet room: /duet <room> <name> [server] · /duet off · /duet (status)",
		handler: async (args, ctx) => {
			ui = ctx.hasUI ? ctx.ui : undefined;
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				if (!room) return notify("duet: not in a room. Use /duet <room> <name>");
				const seen = [...peers].map(([p, at]) => `${p} (${at.toLocaleTimeString()})`).join(", ") || "none yet";
				return notify(`duet: ${name} in room "${room}" via ${server} — ${connected ? "connected" : `offline${lastError ? ` (${lastError})` : ""}`}; peers seen: ${seen}`);
			}
			if (parts[0] === "off") {
				leave();
				room = name = undefined;
				delete config.room;
				delete config.name;
				saveConfig(config);
				showStatus();
				return notify("duet: left the room");
			}
			if (parts.length < 2) return notify("usage: /duet <room> <name> [server]", "error");
			[room, name] = parts;
			if (parts[2]) server = parts[2].replace(/\/+$/, "");
			Object.assign(config, { room, name, server });
			saveConfig(config);
			join();
			try {
				await publish(server, topicFor(room), envelope({ fromId: config.fromId, from: name, kind: "join" }));
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
			"Use duet_send when the user asks you to tell, ask or have the other person's agent do something. duet_send does not wait for an answer — never poll or wait for a reply.",
			"Do not use duet_send for pure thank-you or acknowledgement messages; when nothing is left to do or say, stop without sending.",
		],
		parameters: Type.Object({
			text: Type.String({ description: "The message. Max ~3.8KB; split longer content into several calls." }),
			to: Type.Optional(Type.String({ description: "Recipient name, if the room has more than one other agent" })),
		}),
		async execute(_id, params) {
			if (!room || !name) throw new Error("Not in a duet room. Ask the user to run /duet <room> <name>.");
			const env = envelope({ fromId: config.fromId, from: name, kind: "msg", to: params.to, text: params.text });
			await publish(server, topicFor(room), env);
			return {
				content: [{ type: "text", text: "sent — not yet answered; their reply will arrive later as a new message" }],
				details: {},
			};
		},
	});
}
