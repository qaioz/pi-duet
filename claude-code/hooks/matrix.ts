// Matrix and chat-lab rules, pure: no `$`. register.ts makes every request (through $.http.fetch) and
// keeps the state; this file builds requests, reads answers and checks the join ticket.
// The same room rules as chat-lab's browser (chat-lab/ui/backends/matrix.js), and the owner-control
// contract in peer-agents/owner-control/PROTOCOL.md.

import { MAX_TEXT, cleanName, sanitize, stripHidden, type Request } from "./text.ts";

export const APP = "Claude Code";
export const SEAT = "chatlab.member"; // state event, state_key = user id: { kind: "person" | "agent", owner, app }
const CARD = "chatlab.card"; // chat-lab's own msgtype for a request card

// The control room's event types (PROTOCOL.md).
export const CTL = {
	hello: "chatlab.agent.hello",
	status: "chatlab.agent.status",
	gate: "chatlab.agent.gate",
	done: "chatlab.agent.done",
	reply: "chatlab.agent.reply",
	refused: "chatlab.agent.refused",
	notice: "chatlab.agent.notice",
	decision: "chatlab.owner.decision",
	input: "chatlab.owner.input",
} as const;

// Matrix defaults, plus anyone may set their own seat (a state_key starting with "@" must equal the sender).
export const POWER_EVENTS: Record<string, number> = {
	"m.room.power_levels": 100, "m.room.history_visibility": 100, "m.room.tombstone": 100, "m.room.server_acl": 100,
	"m.room.encryption": 100, "m.room.name": 50, "m.room.avatar": 50, "m.room.canonical_alias": 50, [SEAT]: 0,
};

// The Matrix spec caps one event at 64 KiB.
export const MAX_EVENT_BYTES = 60_000;

// chat-lab's room code: lowercase letters, digits, dashes, 12–40 characters.
export const isRoomCode = (c: unknown): c is string => typeof c === "string" && c.length >= 12 && c.length <= 40 && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(c);

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const sha256hex = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

// The room's address is a hash of its code: the code itself never reaches the server.
export const roomAlias = async (code: string, serverName: string) => `#chatlab-${(await sha256hex("chat-lab:" + code)).slice(0, 24)}:${serverName}`;
// The owner's control room is joined by an alias made from the secret in the ticket.
export const controlAlias = async (secret: string, serverName: string) => `#ctl-${(await sha256hex(secret)).slice(0, 24)}:${serverName}`;

export const serverNameOf = (userId: string) => userId.split(":").slice(1).join(":");
export const shortId = (id: string) => String(id).replace(/^@/, "").split(":")[0] ?? "";
export const agentName = (owner: string) => `${owner}'s ${APP}`;
// An account's local part: the owner's name plus a random tail, so two people can both be "dato".
export const localPart = (owner: string, rand: string) => (owner.toLowerCase().replace(/[^a-z0-9._=-]/g, "") || "user") + "s-claude-" + rand;

export const filterNone = JSON.stringify({ room: { rooms: [] }, presence: { not_types: ["*"] }, account_data: { not_types: ["*"] } });
export const filterRoom = (roomId: string) =>
	JSON.stringify({ room: { rooms: [roomId], timeline: { limit: 100 }, state: { lazy_load_members: false } }, presence: { not_types: ["*"] }, account_data: { not_types: ["*"] } });

// ---------- the join ticket ----------

// What the browser's "Add my agent" hands over, base64url JSON: the Matrix server, the room, the owner's
// name and account, the control room's secret, and the agent's name as the owner typed it (else "<owner>'s Claude Code").
export type Ticket = { server: string; room: string; owner: string; ownerId: string; secret: string; agent: string };

function fromBase64Url(s: string): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	const bytes: number[] = [];
	let bits = 0;
	let value = 0;
	for (const ch of s) {
		const v = alphabet.indexOf(ch);
		if (v < 0) throw new Error("not base64url");
		value = (value << 6) | v;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((value >> bits) & 0xff);
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

export function readTicket(s: unknown): Ticket | null {
	if (typeof s !== "string" || s.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
	let j: any;
	try {
		j = JSON.parse(fromBase64Url(s));
	} catch {
		return null;
	}
	if (!j || typeof j !== "object") return null;
	const server = typeof j.server === "string" ? j.server.replace(/\/+$/, "") : "";
	if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(server)) return null;
	if (!isRoomCode(j.room)) return null;
	if (typeof j.owner !== "string" || stripHidden(j.owner).hidden || cleanName(j.owner) !== j.owner.trim()) return null;
	if (typeof j.ownerId !== "string" || !/^@[^:\s]+:\S+$/.test(j.ownerId)) return null;
	if (typeof j.secret !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(j.secret)) return null;
	const owner = j.owner.trim();
	// The agent's name: plain characters only, like any name shown to people and to Claude; anything else, the default.
	const agent = typeof j.agent === "string" && !stripHidden(j.agent).hidden && j.agent.trim() && cleanName(j.agent) === j.agent.trim() ? j.agent.trim() : agentName(owner);
	return { server, room: j.room, owner, ownerId: j.ownerId, secret: j.secret, agent };
}

// The join file the prompt's command writes: { agent: "claude-code", ticket, at } with `at` in Unix
// seconds. "take": a ticket to offer on the card; "clear": stale or unreadable, to empty; null: not ours.
export const JOIN_FRESH_S = 30 * 60;
export function readJoinFile(text: string, nowMs: number): { take?: Ticket; clear?: true } | null {
	let j: any;
	try {
		j = JSON.parse(text);
	} catch {
		return null;
	}
	if (!j || typeof j !== "object" || typeof j.at !== "number") return null;
	if (j.agent !== "claude-code") return null; // another client's (pi, Codex)
	const age = nowMs / 1000 - j.at;
	if (!(age >= -60 && age <= JOIN_FRESH_S)) return { clear: true };
	const t = readTicket(j.ticket);
	return t ? { take: t } : { clear: true };
}

// ---------- events ----------

// A room message as a Request, or null for anything that isn't one for the queue (our own, an edit).
export function requestFrom(ev: any, me: string, nameOf: (id: string) => string, seatOf: (id: string) => any): Request | null {
	if (ev?.type !== "m.room.message" || typeof ev.event_id !== "string" || typeof ev.sender !== "string") return null;
	if (ev.sender === me) return null;
	const c = ev.content || {};
	// An edit only changes a message as people see it; what waits at gate 1 is what was sent.
	if (c["m.relates_to"]?.rel_type === "m.replace") return null;
	let text: string;
	if (c.msgtype === CARD && c[CARD] && typeof c[CARD].title === "string") text = `[request card] ${c[CARD].title}\n\n${String(c[CARD].body ?? "")}`;
	else if (c.msgtype === "m.file" || c.msgtype === "m.image") text = `[file] ${String(c.body ?? "file")} (the file itself isn't passed on)`;
	else if (typeof c.body === "string") text = c.body;
	else return null;
	if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
	const mentions: string[] = Array.isArray(c["m.mentions"]?.user_ids) ? c["m.mentions"].user_ids.filter((x: unknown) => typeof x === "string") : [];
	const toId = mentions.includes(me) ? me : mentions[0];
	const re = c["m.relates_to"]?.["m.in_reply_to"]?.event_id;
	return {
		id: ev.event_id,
		fromId: ev.sender,
		from: cleanName(nameOf(ev.sender)),
		text,
		by: seatOf(ev.sender)?.kind === "agent" ? "agent" : "person",
		...(toId ? { toId } : {}),
		...(typeof re === "string" ? { re } : {}),
		ts: typeof ev.origin_server_ts === "number" ? ev.origin_server_ts : Date.now(),
	};
}

// What a membership event changes.
export function membershipFrom(ev: any): { id: string; what: "joined" | "left" | "renamed" | null; name?: string } | null {
	if (ev?.type !== "m.room.member" || typeof ev.state_key !== "string") return null;
	const now = ev.content?.membership;
	const before = ev.prev_content?.membership ?? ev.unsigned?.prev_content?.membership;
	const name = typeof ev.content?.displayname === "string" ? ev.content.displayname : undefined;
	const what = now === "join" ? (before === "join" ? "renamed" : "joined") : (now === "leave" || now === "ban") && before === "join" ? "left" : null;
	return { id: ev.state_key, what, ...(name !== undefined ? { name } : {}) };
}

// Our reply's content: the text, who it's for (a mention), what it answers (a reply relation).
export function replyContent(text: string, toId?: string, toName?: string, reId?: string) {
	return {
		msgtype: "m.text",
		body: toName ? `@${toName} ${text}` : text,
		"m.mentions": toId ? { user_ids: [toId] } : {},
		...(reId ? { "m.relates_to": { "m.in_reply_to": { event_id: reId } } } : {}),
	};
}

// "Join <room> as <Owner>'s Claude Code?" and who answers its gates, for the join card.
export function joinQuestion(t: Ticket, folder: string, home: string): string[] {
	let where = folder.replace(/\/+$/, "") || "/";
	const h = home.replace(/\/+$/, "");
	if (h && (where === h || where.startsWith(h + "/"))) where = "~" + where.slice(h.length);
	if (where.length > 60) where = "…" + where.slice(-59);
	return [sanitize(`Join ${t.room} as ${t.agent}? · ${where}`, 300), sanitize(`${t.owner} (${t.ownerId}) will answer this agent's gates from the browser.`, 300)];
}
