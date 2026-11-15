// duet's hooks against a fake chat-lab Matrix server, run by `claude plugin test claude-code`
// (no session, no network, no model).
import { expect, mock, test } from "claude-code/testing";

const CWD = "/work/repo";
const HOME = "/home/g";
const ME = "@davits-claude-x1:lab";
const OWNER = "@davit:lab";
const ROOM = "!room:lab";
const CTLROOM = "!ctl:lab";
const BAND = { plugin: "duet", component: "AbovePrompt", surface: "terminal", viewport: { columns: 120, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 }, view: {} } };

function b64url(s: string): string {
	const bytes = new TextEncoder().encode(s);
	const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	let out = "", bits = 0, value = 0;
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 6) {
			bits -= 6;
			out += abc[(value >> bits) & 63];
		}
	}
	if (bits) out += abc[(value << (6 - bits)) & 63];
	return out;
}
const TICKET = { server: "http://localhost:8790", room: "harbor-fjord-2614", owner: "Davit", ownerId: OWNER, secret: "abcdefghijklmnopqrstuvwxyz012345" };
const joinFile = (t: any = TICKET, at = 1_000) => JSON.stringify({ agent: "claude-code", ticket: b64url(JSON.stringify(t)), at });

function world(on: any) {
	const did = {
		files: new Map<string, string>([[`${HOME}/.duet/join.json`, joinFile()]]),
		logs: [] as string[], toasts: [] as string[], submits: [] as { text: string; asUser?: boolean }[],
		roomPosts: [] as any[], ctlPosts: [] as { type: string; body: any }[], status: [] as any[], seat: null as any, left: false, displayName: "" as string,
		sleepers: [] as (() => void)[], gates: [] as (() => void)[],
		push: (_room: string, _ev: any) => {},
	};
	const clock = mock.clock(on, { now: 1_000_000 });
	on("session.start", () => ({ cwd: CWD }));
	const env: Record<string, string | undefined> = { HOME };
	on("env.get", ($: any, e: any) => ({ value: env[e.name] }));
	on("env.set", ($: any, e: any) => ((env[e.name] = e.value), { value: undefined }));
	const store = new Map<string, unknown>();
	on("store.get", ($: any, e: any) => ({ value: store.get(e.key) }));
	on("store.set", ($: any, e: any) => (store.set(e.key, e.value), { value: undefined }));
	on("store.delete", ($: any, e: any) => (store.delete(e.key), { value: undefined }));
	on("session.cwd", () => ({ value: CWD }));
	on("session.id", () => ({ value: "sess-1" }));
	const tools: string[] = [];
	on("tool.register", ($: any, e: any) => (tools.push(e.name), { value: undefined }));
	on("tool.list", () => ({ value: tools.map((t) => ({ name: `mcp__duet__${t}`, description: "", mcp: true })) }));
	on("command.register", () => ({ value: undefined }));
	on("ui.log", ($: any, e: any) => (did.logs.push(e.text), { value: undefined }));
	on("ui.toast", ($: any, e: any) => (did.toasts.push(e.text), { value: undefined }));
	on("fs.exists", ($: any, e: any) => ({ value: did.files.has(e.path) }));
	on("fs.read", ($: any, e: any) => {
		if (!did.files.has(e.path)) throw new Error("ENOENT");
		return { value: did.files.get(e.path) };
	});
	on("fs.write", ($: any, e: any) => (did.files.set(e.path, e.text), { value: undefined }));
	// gate 2 waits in `sleep` processes: held until a test presses something.
	on("process.run", async () => {
		await new Promise<void>((r) => did.sleepers.push(r));
		return { value: { exitCode: 0, stdout: "", stderr: "" } };
	});
	// Like Claude Code, a plugin's submission resolves once its turn starts (the test starts it).
	on("prompt.submit", async ($: any, e: any) => {
		const asUser = e.asUser ?? e.origin?.asUser;
		did.submits.push({ text: e.text, asUser });
		if (!asUser) await new Promise<void>((r) => did.gates.push(r));
		return { text: e.text };
	});
	on("turn.start", ($: any, e: any) => ({ turnId: e.turnId }));
	on("turn.complete", () => ({ text: "" }));
	on("ui.render", () => ({ type: "Text", props: {}, children: ["drawn by Claude Code"] }));
	on("session.end", () => ({ sessionId: "sess-1" }));

	// The fake Matrix server.
	const queues = new Map<string, any[]>([[ROOM, []], [CTLROOM, []]]);
	const wakers = new Map<string, () => void>();
	let n = 0;
	did.push = (roomId, ev) => {
		queues.get(roomId)!.push({ event_id: `$e${++n}`, origin_server_ts: Date.now(), ...ev });
		wakers.get(roomId)?.();
	};
	const reply = (status: number, body: any) => ({ value: { status, ok: status < 400, headers: {}, text: JSON.stringify(body) } });
	on("http.fetch", async ($: any, e: any) => {
		const u = new URL(e.url);
		const path = decodeURIComponent(u.pathname);
		const body = e.init?.body ? JSON.parse(e.init.body) : undefined;
		if (path.endsWith("/register")) return body?.auth ? reply(200, { user_id: ME, access_token: "tok" }) : reply(401, { session: "s1" });
		if (path.includes("/profile/")) return (did.displayName = body?.displayname), reply(200, {});
		if (path.includes("/join/#ctl-")) return reply(200, { room_id: CTLROOM });
		if (path.includes("/join/#chatlab-")) return reply(200, { room_id: ROOM });
		if (path.includes("/state/chatlab.member/")) return (did.seat = body), reply(200, {});
		if (path.includes("/state/chatlab.agent.status/")) return did.status.push(body), reply(200, {});
		if (path.endsWith("/joined_members")) return reply(200, { joined: { [ME]: { display_name: "Davit's Claude Code" }, "@karlo:lab": { display_name: "karlo" }, [OWNER]: { display_name: "Davit" } } });
		if (path.endsWith(`/rooms/${ROOM}/state`)) return reply(200, []);
		if (path.endsWith("/leave")) return (did.left = true), reply(200, {});
		if (path.endsWith("/sync")) {
			if (!u.searchParams.get("since")) return reply(200, { next_batch: "s0" });
			const roomId = JSON.parse(u.searchParams.get("filter")!).room.rooms[0];
			const q = queues.get(roomId)!;
			while (!q.length) await new Promise<void>((r) => wakers.set(roomId, r));
			return reply(200, { next_batch: `s${++n}`, rooms: { join: { [roomId]: { timeline: { events: q.splice(0), limited: false } } } } });
		}
		const send = path.match(/\/rooms\/([^/]+)\/send\/([^/]+)\//);
		if (send && send[1] === ROOM) return did.roomPosts.push(body), reply(200, { event_id: `$out${did.roomPosts.length}` });
		if (send && send[1] === CTLROOM) return did.ctlPosts.push({ type: send[2]!, body }), reply(200, { event_id: `$c${did.ctlPosts.length}` });
		return reply(404, { errcode: "M_UNRECOGNIZED" });
	});
	const start = () => ({ surface: "terminal" as const, isInteractive: true, cwd: CWD });
	return { did, clock, start };
}

const settle = async (clock: any, rounds = 10) => {
	for (let i = 0; i < rounds; i++) await clock.advance(50);
};
const wake = (did: any) => did.sleepers.splice(0).forEach((r: () => void) => r());

async function band($: any) {
	const ui = await $.ui.mount(BAND as any);
	const text = JSON.stringify(ui.tree ?? (await ui.find({ type: "Box" })) ?? "");
	return { ui, text };
}
async function press($: any, clock: any, did: any, key: string) {
	const ui = await $.ui.mount(BAND as any);
	await ui.press({ key });
	await ui.unmount();
	wake(did);
	await settle(clock, 4);
}
async function has($: any, key: string) {
	const ui = await $.ui.mount(BAND as any);
	const found = await ui.find({ key });
	await ui.unmount();
	return !!found;
}

// Start the turn duet asked for: turn.start first, then the submission resolves (as in Claude Code).
async function duetTurn($: any, did: any, clock: any, turnId: string) {
	const text = did.submits.filter((s: any) => !s.asUser).at(-1).text;
	await $.turn.start({ turnId, text: "The duet plugin sent a message: " + text });
	did.gates.shift()?.();
	await settle(clock, 2);
}

// Joined through the join file and the card's 1.
async function joined($: any, on: any) {
	const w = world(on);
	await $.session.start(w.start());
	await settle(w.clock, 4);
	await press($, w.clock, w.did, "join");
	await settle(w.clock, 20);
	return w;
}

const request = (text: string, from = "@karlo:lab") => ({ type: "m.room.message", sender: from, content: { msgtype: "m.text", body: text } });

test("join file: emptied at start, the card names room and owner; nothing joins before 1", async ($, on) => {
	const { did, clock, start } = world(on);
	await $.session.start(start());
	await settle(clock, 4);
	expect(did.files.get(`${HOME}/.duet/join.json`)).toBe("{}");
	expect(await has($, "join")).toBe(true);
	const ui = await $.ui.mount(BAND as any);
	expect(await ui.find({ type: "Text", text: /Join harbor-fjord-2614 as Davit's Claude Code\? · \/work\/repo/ })).toBeDefined();
	expect(await ui.find({ type: "Text", text: /Davit \(@davit:lab\) will answer this agent's gates from the browser/ })).toBeDefined();
	await ui.unmount();
	expect(did.seat).toBe(null);
	expect(did.ctlPosts.length).toBe(0);
});

test("join file: 2 ignores it: nothing joined", async ($, on) => {
	const { did, clock, start } = world(on);
	await $.session.start(start());
	await settle(clock, 4);
	await press($, clock, did, "join-ignore");
	await settle(clock, 10);
	expect(did.seat).toBe(null);
	expect(await has($, "join")).toBe(false);
});

test("join file: a stale one, or one without a valid ticket, is emptied and offers nothing", async ($, on) => {
	const { did, clock, start } = world(on);
	did.files.set(`${HOME}/.duet/join.json`, joinFile({ ...TICKET, ownerId: "davit" }));
	await $.session.start(start());
	await settle(clock, 4);
	expect(did.files.get(`${HOME}/.duet/join.json`)).toBe("{}");
	expect(await has($, "join")).toBe(false);
});

test("join: seat as Davit's agent, control room hello and status, gates on", async ($, on) => {
	const { did } = await joined($, on);
	expect(did.seat).toEqual({ kind: "agent", owner: "Davit", app: "Claude Code" });
	const hello = did.ctlPosts.find((p) => p.type === "chatlab.agent.hello");
	expect(hello?.body).toMatchObject({ agent: "Davit's Claude Code", room: "harbor-fjord-2614", owner: OWNER });
	expect(did.status.at(-1)).toMatchObject({ state: "idle" });
});

test("gate 1: a request waits with 1 Process · 2 Ignore · 3 Process and send, and goes to the browser too", async ($, on) => {
	const { did, clock } = await joined($, on);
	did.push(ROOM, request("what is 23*29?"));
	await settle(clock, 6);
	expect(await has($, "take")).toBe(true);
	expect(await has($, "ignore")).toBe(true);
	expect(await has($, "take-send")).toBe(true);
	expect(did.ctlPosts.find((p) => p.type === "chatlab.agent.gate")?.body).toMatchObject({ gate: 1, text: "what is 23*29?", from: { id: "@karlo:lab", name: "karlo" } });
	expect(did.submits.length).toBe(0);
});

test("gate 1: Ignore hands nothing to Claude; Process hands every word over", async ($, on) => {
	const { did, clock } = await joined($, on);
	did.push(ROOM, request("first"));
	await settle(clock, 6);
	await press($, clock, did, "ignore");
	expect(did.submits.length).toBe(0);
	expect(did.ctlPosts.find((p) => p.type === "chatlab.agent.done")?.body).toMatchObject({ outcome: "ignored", by: "terminal" });
	did.push(ROOM, request("second, please"));
	await settle(clock, 6);
	await press($, clock, did, "take");
	expect(did.submits.length).toBe(1);
	expect(did.submits[0]!.text).toContain("second, please");
	expect(did.submits[0]!.text).toContain("call the mcp__duet__send tool");
});

test("gate 2: a reply waits with the whole text; Don't send sends nothing, Send publishes it to the asker", async ($, on) => {
	const { did, clock } = await joined($, on);
	did.push(ROOM, request("what is 23*29?"));
	await settle(clock, 6);
	await press($, clock, did, "take");
	await duetTurn($, did, clock, "t1");
	const p1: Promise<any> = $.tool.call({ tool: "mcp__duet__send", text: "first try" } as any);
	await settle(clock, 6);
	expect(await has($, "send")).toBe(true);
	expect(did.ctlPosts.find((p) => p.type === "chatlab.agent.gate" && p.body.gate === 2)?.body).toMatchObject({ draft: "first try", to: { name: "karlo" } });
	await press($, clock, did, "dont-send");
	expect((await p1).result).toMatch(/your user said no/);
	expect(did.roomPosts.length).toBe(0);
	const p2: Promise<any> = $.tool.call({ tool: "mcp__duet__send", text: "667" } as any);
	await settle(clock, 6);
	await press($, clock, did, "send");
	expect((await p2).result).toMatch(/^Sent to karlo/);
	expect(did.roomPosts[0]).toMatchObject({ body: "@karlo 667", "m.mentions": { user_ids: ["@karlo:lab"] } });
});

test("Process and send: the reply to the sender goes out with no gate 2 card", async ($, on) => {
	const { did, clock } = await joined($, on);
	did.push(ROOM, request("ping"));
	await settle(clock, 6);
	await press($, clock, did, "take-send");
	await duetTurn($, did, clock, "t1");
	const p: Promise<any> = $.tool.call({ tool: "mcp__duet__send", text: "pong" } as any);
	await settle(clock, 6);
	expect((await p).result).toMatch(/OK'd ahead/);
	expect(did.roomPosts.length).toBe(1);
});

test("browser: the owner's Process and Send answer the gates; first answer wins", async ($, on) => {
	const { did, clock } = await joined($, on);
	did.push(ROOM, request("from the browser"));
	await settle(clock, 6);
	const gate1 = did.ctlPosts.find((p) => p.type === "chatlab.agent.gate")!.body;
	did.push(CTLROOM, { type: "chatlab.owner.decision", sender: OWNER, content: { id: gate1.id, action: "process", rev: 0 } });
	await settle(clock, 8);
	expect(did.submits.length).toBe(1);
	expect(did.ctlPosts.find((p) => p.type === "chatlab.agent.done")?.body).toMatchObject({ id: gate1.id, outcome: "processed", by: "browser" });
	await duetTurn($, did, clock, "t1");
	const p: Promise<any> = $.tool.call({ tool: "mcp__duet__send", text: "draft" } as any);
	await settle(clock, 6);
	const gate2 = did.ctlPosts.find((x) => x.type === "chatlab.agent.gate" && x.body.gate === 2)!.body;
	did.push(CTLROOM, { type: "chatlab.owner.decision", sender: OWNER, content: { id: gate2.id, action: "edit", text: "edited in the browser" } });
	await settle(clock, 6);
	wake(did);
	await settle(clock, 6);
	expect((await p).result).toMatch(/your user edited it/);
	expect(did.roomPosts[0].body).toBe("@karlo edited in the browser");
	// A later decision for the same gate: already answered.
	did.push(CTLROOM, { type: "chatlab.owner.decision", sender: OWNER, content: { id: gate2.id, action: "send" } });
	await settle(clock, 6);
	expect(did.ctlPosts.at(-1)).toMatchObject({ type: "chatlab.agent.done", body: { id: gate2.id, outcome: "gone" } });
	expect(did.roomPosts.length).toBe(1);
});

test("browser: a decision or input from anyone but the owner is refused", async ($, on) => {
	const { did, clock } = await joined($, on);
	did.push(ROOM, request("hello"));
	await settle(clock, 6);
	const gate1 = did.ctlPosts.find((p) => p.type === "chatlab.agent.gate")!.body;
	did.push(CTLROOM, { type: "chatlab.owner.decision", sender: "@karlo:lab", content: { id: gate1.id, action: "process" } });
	did.push(CTLROOM, { type: "chatlab.owner.input", sender: "@karlo:lab", content: { text: "do it" } });
	await settle(clock, 6);
	expect(did.submits.length).toBe(0);
	expect(did.ctlPosts.filter((p) => p.type === "chatlab.agent.refused").length).toBe(2);
	expect(await has($, "take")).toBe(true);
});

test("owner input from the browser goes to Claude as the user's own words; the answer comes back to the browser only", async ($, on) => {
	const { did, clock } = await joined($, on);
	did.push(CTLROOM, { type: "chatlab.owner.input", sender: OWNER, content: { text: "what's in this folder?" } });
	await settle(clock, 6);
	expect(did.submits).toEqual([{ text: "what's in this folder?", asUser: true }]);
	await $.turn.start({ turnId: "t9", text: "what's in this folder?" } as any);
	await $.turn.complete({ turnId: "t9", answer: "a README", durationMs: 1, isAborted: false, usage: null } as any);
	await settle(clock, 4);
	expect(did.ctlPosts.find((p) => p.type === "chatlab.agent.reply")?.body).toMatchObject({ text: "a README" });
	expect(did.roomPosts.length).toBe(0);
});

test("the owner's @-message in the room skips gate 1 (gate 2 still holds the reply)", async ($, on) => {
	const { did, clock } = await joined($, on);
	did.push(ROOM, { type: "m.room.message", sender: OWNER, content: { msgtype: "m.text", body: "@Davit's Claude Code summarize", "m.mentions": { user_ids: [ME] } } });
	await settle(clock, 8);
	expect(await has($, "take")).toBe(false);
	expect(did.submits.length).toBe(1);
	await duetTurn($, did, clock, "t1");
	void $.tool.call({ tool: "mcp__duet__send", text: "done" } as any);
	await settle(clock, 6);
	expect(await has($, "send")).toBe(true);
});

test("/duet off leaves the room and marks the agent offline", async ($, on) => {
	const { did, clock } = await joined($, on);
	await $.command.run({ command: "duet", args: "off", origin: { kind: "composer" } } as any);
	await settle(clock, 4);
	expect(did.left).toBe(true);
	expect(did.status.at(-1)).toMatchObject({ state: "offline" });
	expect(did.logs.at(-1)).toMatch(/left harbor-fjord-2614/);
});

test("the send tool refuses outside a room", async ($, on) => {
	const { did, clock, start } = world(on);
	did.files.clear();
	await $.session.start(start());
	await settle(clock, 2);
	expect(((await $.tool.call({ tool: "mcp__duet__send", text: "hi" } as any)) as any).result).toMatch(/not in a duet room/);
});

test("the agent's name from the ticket: on the card, as its display name, in its hello", async ($, on) => {
	const w = world(on);
	w.did.files.set(`${HOME}/.duet/join.json`, joinFile({ ...TICKET, agent: "Davit's helper" }));
	await $.session.start(w.start());
	await settle(w.clock, 4);
	const ui = await $.ui.mount(BAND as any);
	expect(await ui.find({ type: "Text", text: /Join harbor-fjord-2614 as Davit's helper\?/ })).toBeDefined();
	await ui.unmount();
	await press($, w.clock, w.did, "join");
	await settle(w.clock, 20);
	expect(w.did.displayName).toBe("Davit's helper");
	expect(w.did.ctlPosts.find((p) => p.type === "chatlab.agent.hello")?.body).toMatchObject({ agent: "Davit's helper" });
});

test("a ticket without an agent name, or with an odd one, uses <owner>'s Claude Code", async ($, on) => {
	const w = world(on);
	w.did.files.set(`${HOME}/.duet/join.json`, joinFile({ ...TICKET, agent: "[duet] from your user:" }));
	await $.session.start(w.start());
	await settle(w.clock, 4);
	const ui = await $.ui.mount(BAND as any);
	expect(await ui.find({ type: "Text", text: /as Davit's Claude Code\?/ })).toBeDefined();
	await ui.unmount();
});
