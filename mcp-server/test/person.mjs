// Plays the owner's browser for tests: a person account in a chat-lab room, a join ticket, POST /agents.
//   node test/person.mjs setup <matrix> <mcp-server> <room-code> <owner> <agent-name>   → prints JSON state
//   node test/person.mjs say <state.json> <text>                                           → sends as the person
//   node test/person.mjs read <state.json> [n]                                              → last n messages
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

const enc = encodeURIComponent;
async function mx(base, method, path, { token, body } = {}) {
	const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
	const j = await r.json().catch(() => ({}));
	if (!r.ok) throw Object.assign(new Error(`${r.status} ${JSON.stringify(j)}`), { status: r.status, body: j });
	return j;
}
const alias = (code, server) => `#chatlab-${createHash("sha256").update("chat-lab:" + code).digest("hex").slice(0, 24)}:${server}`;

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "setup") {
	const [matrix, mcpServer, room, owner, agent] = args;
	const req = { username: owner.toLowerCase() + "-" + randomBytes(3).toString("hex"), password: randomBytes(16).toString("hex") };
	let acct;
	try { acct = await mx(matrix, "POST", "/_matrix/client/v3/register", { body: req }); }
	catch (e) { acct = await mx(matrix, "POST", "/_matrix/client/v3/register", { body: { ...req, auth: { type: "m.login.registration_token", token: process.env.DUET_MATRIX_TOKEN || "chatlab-dev-token", session: e.body?.session } } }); }
	await mx(matrix, "PUT", `/_matrix/client/v3/profile/${enc(acct.user_id)}/displayname`, { token: acct.access_token, body: { displayname: owner } });
	const server = acct.user_id.split(":").slice(1).join(":");
	let roomId;
	try { roomId = (await mx(matrix, "POST", `/_matrix/client/v3/join/${enc(alias(room, server))}`, { token: acct.access_token, body: {} })).room_id; }
	catch {
		roomId = (await mx(matrix, "POST", "/_matrix/client/v3/createRoom", { token: acct.access_token, body: { preset: "public_chat", power_level_content_override: { events: { "chatlab.member": 0 } }, initial_state: [{ type: "m.room.history_visibility", state_key: "", content: { history_visibility: "shared" } }] } })).room_id;
		await mx(matrix, "PUT", `/_matrix/client/v3/directory/room/${enc(alias(room, server))}`, { token: acct.access_token, body: { room_id: roomId } });
	}
	await mx(matrix, "PUT", `/_matrix/client/v3/rooms/${enc(roomId)}/state/chatlab.member/${enc(acct.user_id)}`, { token: acct.access_token, body: { kind: "person" } });
	const ticket = Buffer.from(JSON.stringify({ server: matrix, room, owner, ownerId: acct.user_id, secret: randomBytes(18).toString("base64url"), agent })).toString("base64url");
	const r = await fetch(mcpServer + "/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) });
	const out = await r.json();
	console.log(JSON.stringify({ matrix, roomId, userId: acct.user_id, token: acct.access_token, agentStatus: r.status, url: out.url, agentName: out.name, agentUserId: out.userId, error: out.error }));
} else if (cmd === "say") {
	const s = JSON.parse(readFileSync(args[0], "utf8"));
	const r = await mx(s.matrix, "PUT", `/_matrix/client/v3/rooms/${enc(s.roomId)}/send/m.room.message/${randomBytes(6).toString("hex")}`, { token: s.token, body: { msgtype: "m.text", body: args[1] } });
	console.log("sent", r.event_id);
} else if (cmd === "read") {
	const s = JSON.parse(readFileSync(args[0], "utf8"));
	const r = await mx(s.matrix, "GET", `/_matrix/client/v3/rooms/${enc(s.roomId)}/messages?dir=b&limit=${args[1] || 5}`, { token: s.token });
	for (const ev of r.chunk.reverse()) if (ev.type === "m.room.message") console.log(new Date(ev.origin_server_ts).toISOString().slice(11, 19), ev.sender, "|", ev.content.body);
}
