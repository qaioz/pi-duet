// Hook wiring tests for the duet mod, run by `claude plugin test` (no session, no network, no model).
// The pure parts (wire.js, guard.js) are covered by test/mod-unit.mjs.
import { expect, mock, test } from "claude-code/testing";

const CWD = "/work/repo";

// Everything session.start calls, answered in Claude Code's place. Returns what the mod did.
function world(on: any, opts: { interactive?: boolean; fetchStatus?: number; feed?: boolean; env?: Record<string, string> } = {}) {
	const did = { logs: [] as string[], toasts: [] as string[], posts: [] as any[], store: new Map<string, unknown>(), tools: [] as string[], commands: [] as string[], submits: [] as string[], spawned: [] as string[], gates: [] as (() => void)[], feeding: !!opts.feed, seq: 0, push: (env: any) => {} };
	const clock = mock.clock(on, { now: 1_000_000 });
	on("session.start", () => ({ cwd: CWD }));
	const env: Record<string, string | undefined> = { HOME: "/home/g", ...(opts.env ?? {}) };
	on("env.get", ($: any, e: any) => ({ value: env[e.name] }));
	on("env.set", ($: any, e: any) => {
		env[e.name] = e.value;
		return { value: undefined };
	});
	on("store.get", ($: any, e: any) => ({ value: did.store.get(e.key) }));
	on("store.set", ($: any, e: any) => {
		did.store.set(e.key, e.value);
		return { value: undefined };
	});
	on("store.delete", ($: any, e: any) => {
		did.store.delete(e.key);
		return { value: undefined };
	});
	on("session.id", () => ({ value: "sess-1" }));
	on("session.surfaces", () => ({ value: opts.interactive === false ? [] : ["terminal"] }));
	on("tool.list", () => ({ value: [] }));
	on("session.cwd", () => ({ value: CWD }));
	on("process.run", () => ({ value: { exitCode: 0, stdout: "Gaioz Q\n", stderr: "" } }));
	// The relay stream: opens, then yields whatever the test feeds it; ends when the feed is closed.
	const feed: string[] = [];
	let wake: (() => void) | null = null;
	on("process.spawn", async function* ($: any, e: any) {
		did.spawned.push(e.input ?? "");
		yield { stream: "stdout", text: '{"id":"o1","time":1,"event":"open"}\n' };
		for (let n = 0; n < 1000; n++) {
			while (feed.length) yield { stream: "stdout", text: feed.shift()! };
			if (!did.feeding) break;
			await new Promise<void>((r) => (wake = r));
		}
		return { code: 0, signal: null };
	});
	did.push = (env: any) => {
		did.seq++;
		feed.push(JSON.stringify({ id: "m" + did.seq, time: Math.floor(Date.now() / 1000) + did.seq, event: "message", message: JSON.stringify(env) }) + "\n");
		wake?.();
	};
	on("settings.read", () => ({ value: { permissions: { defaultMode: "default" } } }));
	on("tool.register", ($: any, e: any) => {
		did.tools.push(e.name);
		return { value: undefined };
	});
	on("command.register", ($: any, e: any) => {
		did.commands.push(e.name);
		return { value: undefined };
	});
	on("ui.log", ($: any, e: any) => {
		did.logs.push(e.text);
		return { value: undefined };
	});
	on("ui.toast", ($: any, e: any) => {
		did.toasts.push(e.text);
		return { value: undefined };
	});
	on("ui.open", () => ({ value: { isPlaced: true } }));
	on("http.fetch", ($: any, e: any) => {
		did.posts.push({ url: e.url, body: e.init?.body ? JSON.parse(e.init.body) : undefined });
		const status = opts.fetchStatus ?? 200;
		return { value: { status, ok: status < 400, headers: {}, text: "" } };
	});
	on("tool.call", () => ({ result: "ran" }));
	// Like Claude Code, a plugin's submission resolves only once its turn starts: the test starts it
	// with duetTurn(), which fires turn.start and then lets the submission resolve.
	on("prompt.submit", async ($: any, e: any) => {
		did.submits.push(e.text);
		if (e.text.startsWith("[duet] from ")) await new Promise<void>((r) => did.gates.push(r));
		return { text: e.text };
	});
	on("turn.start", ($: any, e: any) => ({ turnId: e.turnId }));
	on("turn.complete", () => ({ text: "" }));
	on("prompt.suggest", () => ({ value: { isShown: true } }));
	on("ui.render", () => ({ type: "Text", props: {}, children: ["drawn by Claude Code"] }));
	on("classic.SessionStart", () => ({}));
	const start = () => ({ surface: opts.interactive === false ? null : "terminal", isInteractive: opts.interactive !== false, cwd: CWD });
	return { did, clock, start };
}

async function settle(clock: any, rounds = 10) {
	for (let i = 0; i < rounds; i++) await clock.advance(50);
}

// Start the turn duet asked for: turn.start first, then the submission resolves (as in Claude Code).
async function duetTurn($: any, did: any, clock: any, turnId: string) {
	const text = did.submits.filter((t: string) => t.startsWith("[duet] from ")).at(-1);
	await $.turn.start({ turnId, text: "(Claude Code's own wording around) " + text });
	did.gates.shift()?.();
	await settle(clock, 2);
}

// Run a call that waits on the mod's timers (the lock's read-back), moving the mock clock along.
async function withClock<T>(clock: any, p: Promise<T>): Promise<T> {
	let done = false;
	p.then(() => (done = true), () => (done = true));
	for (let i = 0; i < 50 && !done; i++) await clock.advance(100);
	return p;
}

test("registers the send tool and /duet; outside a terminal /duet only explains", async ($, on) => {
	const { did, start } = world(on, { interactive: false });
	await $.session.start(start());
	expect(did.tools).toEqual(["send"]);
	expect(did.commands).toEqual(["duet"]);
	await $.command.run({ command: "duet", args: "new" });
	expect(did.logs[0]).toMatch(/needs the Claude Code terminal/);
	expect(did.posts.length).toBe(0);
});

test("the send tool refuses outside a room", async ($, on) => {
	const { start } = world(on);
	await $.session.start(start());
	const r: any = await $.tool.call({ tool: "mcp__duet__send", text: "hi" });
	expect(String(r.result)).toMatch(/isn't in a duet room/);
});

test("joining announces itself, labels the footer, and sending publishes to the room's topic", async ($, on) => {
	const { did, clock, start } = world(on);
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-1 gaioz" });
	await settle(clock, 20);
	expect(did.posts.length).toBe(1);
	expect(did.posts[0].body).toMatchObject({ v: 1, kind: "join", from: "gaioz", via: "claude-code" });
	expect(did.posts[0].url).toMatch(/\/duet_[0-9a-f]{40}$/);
	expect(did.logs.join("\n")).toMatch(/joined room test-room-1 as gaioz \(ask mode\)/);
	expect(did.store.get("room:" + CWD)).toEqual({ code: "test-room-1", name: "gaioz", relay: "https://duet.gaioz.online" });

	const footer = await $.ui.mount({ plugin: "duet", component: "SessionMode", surface: "terminal", props: { modes: [] } } as any);
	await footer.unmount();

	const r: any = await withClock(clock, $.tool.call({ tool: "mcp__duet__send", text: "hello", to: "karlo" }));
	expect(String(r.result)).toMatch(/^Sent to karlo/);
	expect(did.posts[1].body).toMatchObject({ kind: "msg", text: "hello", to: "karlo", by: "agent" });
	expect(did.posts[1].url).toBe(did.posts[0].url);
});

test("an unreachable relay means no join", async ($, on) => {
	const { did, clock, start } = world(on, { fetchStatus: 403 });
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-2 gaioz" });
	await settle(clock, 20);
	expect(did.logs.join("\n")).toMatch(/couldn't reach the relay .*HTTP 403\. Not joined/);
	expect(did.store.get("room:" + CWD)).toBeUndefined();
	const r: any = await $.tool.call({ tool: "mcp__duet__send", text: "hi" });
	expect(String(r.result)).toMatch(/isn't in a duet room/);
});

test("placeholder names and bad room codes are refused", async ($, on) => {
	const { did, start } = world(on);
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-3 YOUR_NAME" });
	await $.command.run({ command: "duet", args: "a;b" });
	expect(did.posts.length).toBe(0);
	expect(did.logs[0]).toMatch(/placeholder/);
	expect(did.logs[1]).toMatch(/usage/);
});

test("the user's own tool calls are not fenced", async ($, on) => {
	const { start } = world(on);
	await $.session.start(start());
	const r: any = await $.tool.call({ tool: "Write", file_path: "/home/g/.claude/settings.json", content: "{}" });
	expect(r.result).toBe("ran");
});

test("the pane draws valid trees on terminal and desktop, before and after joining", async ($, on) => {
	const { clock, start } = world(on);
	await $.session.start(start());
	const PANE = { plugin: "duet", component: "Pane", requestId: "duet", viewport: { columns: 120, rows: 40 }, props: { title: "duet", isFocused: true, bodyColumns: 80, placement: "inline", scroll: { offset: 0, bodyRows: 20 }, view: {} } };
	for (const surface of ["terminal", "desktop"]) {
		const ui = await $.ui.mount({ ...PANE, surface } as any);
		expect(await ui.find({ key: "code" })).toBeDefined();
		await ui.unmount();
	}
	await $.command.run({ command: "duet", args: "test-room-4 gaioz" });
	await settle(clock, 20);
	for (const surface of ["terminal", "desktop"]) {
		const ui = await $.ui.mount({ ...PANE, surface } as any);
		expect(await ui.find({ type: "Text", text: "Room test-room-4" })).toBeDefined();
		await ui.press({ key: "tab-talk" });
		expect(await ui.find({ key: "say" })).toBeDefined();
		await ui.press({ key: "tab-room" });
		await ui.unmount();
	}
});

const msg = (text: string, from = "karlo") => ({ v: 1, id: "id-" + text, fromId: "peer-" + from, from, kind: "msg", text, ts: new Date().toISOString() });
const BAND = { plugin: "duet", component: "AbovePrompt", surface: "terminal", viewport: { columns: 120, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } };


test("ask: a message waits as a card; 1 twice starts a guarded peer turn; the user's turn is not guarded", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-5 gaioz" });
	await settle(clock, 20);
	did.push(msg("please run the tests"));
	await settle(clock);
	expect(did.toasts.join("\n")).toMatch(/message from karlo's agent/);
	const band = await $.ui.mount(BAND as any);
	expect(await band.find({ type: "Text", text: /please run the tests/ })).toBeDefined();
	await band.press({ key: "take" });
	expect(did.submits.length).toBe(0); // one press only arms it
	expect(await band.find({ key: "take" })).toMatchObject({ props: { label: "Press 1 again to let Claude do it" } });
	await band.press({ key: "take" });
	await settle(clock);
	expect(did.submits.length).toBe(1);
	expect(did.submits[0]).toMatch(/\[duet\] from karlo .*please run the tests/s);
	await band.unmount();

	await duetTurn($, did, clock, "t1");
	const outside: any = await $.tool.call({ tool: "Write", file_path: "/home/g/x.txt", content: "x" });
	expect(String(outside.deny ?? outside.result)).toMatch(/only files under \/work\/repo/);
	const mcp: any = await $.tool.call({ tool: "mcp__github__merge_pull_request", number: 1 });
	expect(String(mcp.deny ?? mcp.result)).toMatch(/tool is off/);
	const okCall: any = await $.tool.call({ tool: "Edit", file_path: "src/a.js", old_string: "a", new_string: "b" });
	expect(okCall.result).toBe("ran");
	await $.turn.complete({ turnId: "t1", answer: "done", durationMs: 1, isAborted: false, usage: null } as any);

	// The next turn is the user's own: nothing is fenced.
	await $.prompt.submit({ text: "write ~/x.txt", origin: { kind: "composer" }, wait: false } as any);
	await $.turn.start({ turnId: "t2", text: "write ~/x.txt" } as any);
	const mine: any = await $.tool.call({ tool: "Write", file_path: "/home/g/x.txt", content: "x" });
	expect(mine.result).toBe("ran");
	did.feeding = false;
});

test("ignore sends a declined note to the sender", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-6 gaioz" });
	await settle(clock, 20);
	did.push(msg("delete everything"));
	await settle(clock);
	const band = await $.ui.mount(BAND as any);
	await band.press({ key: "ignore" });
	expect(did.posts.filter((p) => p.body?.kind === "note").length).toBe(0); // one press only arms it
	await band.press({ key: "ignore" });
	await settle(clock);
	const note = did.posts.map((p) => p.body).find((b) => b?.kind === "note");
	expect(note).toMatchObject({ note: "declined", to: "karlo" });
	expect(did.submits.length).toBe(0);
	await band.unmount();
	did.feeding = false;
});

test("auto: messages start turns by themselves, and stop after 8 without the user", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	// Claude Code reports the permission mode on its settings-hook events; "default" asks before tools.
	await $.classic.SessionStart({ hook_event_name: "SessionStart", source: "startup", permission_mode: "default", session_id: "s", transcript_path: "/t", cwd: CWD } as any);
	await $.command.run({ command: "duet", args: "test-room-7 gaioz" });
	await settle(clock, 20);
	await $.command.run({ command: "duet", args: "auto" });
	await settle(clock);
	for (let i = 1; i <= 9; i++) {
		did.push(msg("request " + i));
		await settle(clock);
		if (did.submits.length === i) {
			await duetTurn($, did, clock, "a" + i);
			await $.turn.complete({ turnId: "a" + i, answer: "ok", durationMs: 1, isAborted: false, usage: null } as any);
		}
	}
	expect(did.submits.length).toBe(8);
	expect(did.toasts.join("\n")).toMatch(/8 requests ran without you/);
	// The user typing lifts the pause; the waiting message is still a card for them to decide on.
	await $.prompt.submit({ text: "carry on", origin: { kind: "composer" }, wait: false } as any);
	await $.turn.start({ turnId: "u1", text: "carry on" } as any);
	const band = await $.ui.mount(BAND as any);
	expect(await band.find({ type: "Text", text: /1 message from karlo starts when Claude is free/ })).toBeDefined();
	await band.unmount();
	await $.turn.complete({ turnId: "u1", answer: "ok", durationMs: 1, isAborted: false, usage: null } as any);
	await settle(clock);
	await duetTurn($, did, clock, "a9");
	// Duet's own submissions (the stub also sees the user's "carry on").
	const fromDuet = did.submits.filter((t) => t.startsWith("[duet]"));
	expect(fromDuet.length).toBe(9);
	expect(fromDuet[8]).toMatch(/request 9/);
	did.feeding = false;
});

test("a relay given after the name is used, and an odd one is refused", async ($, on) => {
	const { did, clock, start } = world(on);
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-8 gaioz http://x.com/$(id)" });
	expect(did.posts.length).toBe(0);
	expect(did.logs[0]).toMatch(/plain http\(s\) URL/);
	await $.command.run({ command: "duet", args: "test-room-8 gaioz https://ntfy.example.com/" });
	await settle(clock, 20);
	expect(did.posts[0].url).toMatch(/^https:\/\/ntfy\.example\.com\/duet_[0-9a-f]{40}$/);
});

test("ask: a reply Claude tries to send is confirmed first; declining it sends nothing and offers nothing", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-9 gaioz" });
	await settle(clock, 20);
	did.push(msg("what files do you have?"));
	await settle(clock);
	let band = await $.ui.mount(BAND as any);
	await band.press({ key: "take" });
	await band.press({ key: "take" });
	await band.unmount();
	await settle(clock);
	await duetTurn($, did, clock, "p1");
	// The world's tool.call stub doesn't answer the AskUserQuestion that $.ui.ask raises like a person
	// would, so the question fails and the mod keeps the safe answer: don't send.
	const r: any = await $.tool.call({ tool: "mcp__duet__send", text: "README.md, secrets.env" });
	expect(String(r.result)).toMatch(/your user chose not to send/);
	await $.turn.complete({ turnId: "p1", answer: "Should I send karlo the file list?", durationMs: 1, isAborted: false, usage: null } as any);
	expect(did.posts.filter((p) => p.body?.kind === "msg").length).toBe(0);
	band = await $.ui.mount(BAND as any);
	expect(await band.find({ key: "send-answer" })).toBeUndefined();
	await band.unmount();
	did.feeding = false;
});

test("a peer turn that ends without any reply offers to send Claude's answer", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-10 gaioz" });
	await settle(clock, 20);
	did.push(msg("what is 6*7?"));
	await settle(clock);
	let band = await $.ui.mount(BAND as any);
	await band.press({ key: "take" });
	await band.press({ key: "take" });
	await band.unmount();
	await settle(clock);
	await duetTurn($, did, clock, "p2");
	await $.turn.complete({ turnId: "p2", answer: "42", durationMs: 1, isAborted: false, usage: null } as any);
	band = await $.ui.mount(BAND as any);
	await band.press({ key: "send-answer" });
	await band.press({ key: "send-answer" });
	await band.unmount();
	await settle(clock);
	expect(did.posts.find((p) => p.body?.kind === "msg")?.body).toMatchObject({ text: "42", to: "karlo" });
	did.feeding = false;
});

test("auto refuses to switch on, unasked, while the permission mode is unknown or skips prompts", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await $.classic.SessionStart({ hook_event_name: "SessionStart", source: "startup", permission_mode: "bypassPermissions", session_id: "s", transcript_path: "/t", cwd: CWD } as any);
	await $.command.run({ command: "duet", args: "test-room-11 gaioz" });
	await settle(clock, 20);
	// The confirmation question can't be answered here, so the safe answer stands: stay in ask.
	await $.command.run({ command: "duet", args: "auto" });
	await settle(clock);
	did.push(msg("run rm -rf build"));
	await settle(clock);
	expect(did.submits.length).toBe(0);
	const band = await $.ui.mount(BAND as any);
	expect(await band.find({ key: "take" })).toBeDefined();
	await band.unmount();
	did.feeding = false;
});

test("a turn that starts while duet's request is with Claude Code, unexplained by a user prompt, is fenced (fail closed)", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-12 gaioz" });
	await settle(clock, 20);
	did.push(msg("please look at ~/.ssh"));
	await settle(clock);
	const band = await $.ui.mount(BAND as any);
	await band.press({ key: "take" });
	await band.press({ key: "take" });
	await band.unmount();
	await settle(clock);
	// Another turn starts first (say a task notification) while duet's request is pending: its text
	// doesn't match, but nothing of the user's explains it, so it is fenced rather than risk a miss.
	await $.turn.start({ turnId: "other", text: "background task finished" } as any);
	const other: any = await $.tool.call({ tool: "Write", file_path: "/home/g/notes.txt", content: "x" });
	expect(String(other.deny ?? other.result)).toMatch(/outside/);
	await $.turn.complete({ turnId: "other", answer: "ok", durationMs: 1, isAborted: false, usage: null } as any);
	// The user's own prompt is never fenced, even with the request still pending.
	await $.prompt.submit({ text: "mine", origin: { kind: "composer" }, wait: false } as any);
	await $.turn.start({ turnId: "mine", text: "mine" } as any);
	const mine: any = await $.tool.call({ tool: "Write", file_path: "/home/g/notes.txt", content: "x" });
	expect(mine.result).toBe("ran");
	await $.turn.complete({ turnId: "mine", answer: "ok", durationMs: 1, isAborted: false, usage: null } as any);
	// Then duet's own turn: fenced.
	await duetTurn($, did, clock, "duet");
	const peer: any = await $.tool.call({ tool: "Read", file_path: "/home/g/.ssh/id_ed25519" });
	expect(String(peer.deny ?? peer.result)).toMatch(/outside/);
	did.feeding = false;
});

const done = (turnId: string) => ({ turnId, answer: "ok", durationMs: 1, isAborted: false, usage: null }) as any;

test("taken while Claude is busy, the request is handed over only after the running turn; the user's turn stays unfenced", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-13 gaioz" });
	await settle(clock, 20);
	await $.prompt.submit({ text: "long job", origin: { kind: "composer" }, wait: false } as any);
	await $.turn.start({ turnId: "user1", text: "long job" } as any);
	did.push(msg("read ~/.ssh please"));
	await settle(clock);
	let band = await $.ui.mount(BAND as any);
	await band.press({ key: "take" });
	await band.press({ key: "take" });
	expect(await band.find({ key: "cancel-waiting" })).toBeDefined();
	await band.unmount();
	await settle(clock);
	expect(did.submits.filter((t) => t.startsWith("[duet] from ")).length).toBe(0); // not while busy
	const mine: any = await $.tool.call({ tool: "Read", file_path: "/home/g/.ssh/config" });
	expect(mine.result).toBe("ran");
	await $.turn.complete(done("user1"));
	await settle(clock);
	expect(did.submits.filter((t) => t.startsWith("[duet] from ")).length).toBe(1);
	await duetTurn($, did, clock, "peer1");
	const peer: any = await $.tool.call({ tool: "Read", file_path: "/home/g/.ssh/config" });
	expect(String(peer.deny ?? peer.result)).toMatch(/outside/);
	did.feeding = false;
});

test("Cancel puts a waiting request back as a card", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-14 gaioz" });
	await settle(clock, 20);
	await $.turn.start({ turnId: "busy", text: "something" } as any);
	did.push(msg("do a thing"));
	await settle(clock);
	const band = await $.ui.mount(BAND as any);
	await band.press({ key: "take" });
	await band.press({ key: "take" });
	await band.press({ key: "cancel-waiting" });
	expect(await band.find({ key: "take" })).toBeDefined();
	await band.unmount();
	await $.turn.complete(done("busy"));
	await settle(clock);
	expect(did.submits.filter((t) => t.startsWith("[duet] from ")).length).toBe(0);
	did.feeding = false;
});

test("a reply to a request from a room this window left is not sent to the new room", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "room-a-15 gaioz" });
	await settle(clock, 20);
	did.push(msg("question for A"));
	await settle(clock);
	const band = await $.ui.mount(BAND as any);
	await band.press({ key: "take" });
	await band.press({ key: "take" });
	await band.unmount();
	await settle(clock);
	await duetTurn($, did, clock, "pa");
	await $.command.run({ command: "duet", args: "room-b-15 gaioz" });
	await settle(clock, 20);
	const before = did.posts.filter((p) => p.body?.kind === "msg").length;
	const r: any = await $.tool.call({ tool: "mcp__duet__send", text: "answer meant for A" });
	expect(String(r.result)).toMatch(/room this window has left/);
	expect(did.posts.filter((p) => p.body?.kind === "msg").length).toBe(before);
	did.feeding = false;
});

test("an empty-text continuation of a peer turn stays fenced; the user's next prompt ends that", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-16 gaioz" });
	await settle(clock, 20);
	did.push(msg("work"));
	await settle(clock);
	const band = await $.ui.mount(BAND as any);
	await band.press({ key: "take" });
	await band.press({ key: "take" });
	await band.unmount();
	await settle(clock);
	await duetTurn($, did, clock, "w1");
	await $.turn.complete(done("w1"));
	await $.turn.start({ turnId: "w2", text: "" } as any);
	const cont: any = await $.tool.call({ tool: "Write", file_path: "/home/g/x", content: "x" });
	expect(String(cont.deny ?? cont.result)).toMatch(/outside/);
	await $.turn.complete(done("w2"));
	await $.prompt.submit({ text: "mine", origin: { kind: "composer" }, wait: false } as any);
	await $.turn.start({ turnId: "u", text: "mine" } as any);
	const mine: any = await $.tool.call({ tool: "Write", file_path: "/home/g/x", content: "x" });
	expect(mine.result).toBe("ran");
	did.feeding = false;
});

test("a new process forgets a peer turn a crashed one left behind", async ($, on) => {
	const { did, start } = world(on);
	did.store.set("turn:sess-1", { peerTurn: { froms: ["karlo"], roomKey: "k", turnId: "dead", attempted: false, waitNoted: false }, expected: [], peerAgents: [], at: Date.now() });
	await $.session.start(start());
	await $.turn.start({ turnId: "u", text: "mine" } as any);
	const mine: any = await $.tool.call({ tool: "Write", file_path: "/home/g/x", content: "x" });
	expect(mine.result).toBe("ran");
	expect((did.store.get("turn:sess-1") as any)?.peerTurn ?? null).toBe(null);
});

test("a module reload in the same process keeps a peer turn fenced", async ($, on) => {
	// DUET_PROCESS set: this process loaded duet before, so session.start is a reload.
	const { did, start } = world(on, { env: { DUET_PROCESS: "p1" } });
	did.store.set("turn:sess-1", { peerTurn: { froms: ["karlo"], roomKey: "k", turnId: "live", attempted: false, waitNoted: false }, expected: [], peerAgents: [], at: Date.now(), runningTurn: "live" });
	await $.session.start(start());
	const peer: any = await $.tool.call({ tool: "Write", file_path: "/home/g/x", content: "x" });
	expect(String(peer.deny ?? peer.result)).toMatch(/outside/);
});

test("a fresh join listens from just before it, so a quick answer to the join isn't missed", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-17 nika" });
	await settle(clock, 20);
	expect(did.spawned[0]).toMatch(/\/json\?since=\d{10}"/);
	did.push({ v: 1, id: "j1", fromId: "peer-gaioz", from: "gaioz", kind: "join", via: "claude-code", ts: new Date().toISOString() });
	await settle(clock);
	const footer = await $.ui.mount({ plugin: "duet", component: "Pane", requestId: "duet", surface: "terminal", viewport: { columns: 120, rows: 40 }, props: { title: "duet", isFocused: true, bodyColumns: 80, placement: "inline", scroll: { offset: 0, bodyRows: 20 }, view: {} } } as any);
	expect(await footer.find({ type: "Text", text: /Here: gaioz \(Claude Code\)/ })).toBeDefined();
	await footer.unmount();
	did.feeding = false;
});
