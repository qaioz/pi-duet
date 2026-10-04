// Hook wiring tests for the duet mod, run by `claude plugin test` (no session, no network, no model).
// The pure parts (wire.js, guard.js) are covered by test/mod-unit.mjs.
import { expect, mock, test } from "claude-code/testing";

const CWD = "/work/repo";

// Everything session.start calls, answered in Claude Code's place. Returns what the mod did.
function world(on: any, opts: { interactive?: boolean; fetchStatus?: number; feed?: boolean; env?: Record<string, string>; answer?: (q: string) => string | undefined; store?: Record<string, unknown> } = {}) {
	const did = { files: new Map<string, string>(), asks: [] as string[], logs: [] as string[], toasts: [] as string[], posts: [] as any[], store: new Map<string, unknown>(), tools: [] as string[], commands: [] as string[], submits: [] as string[], spawned: [] as string[], gates: [] as (() => void)[], feeding: !!opts.feed, seq: 0, push: (env: any, attachmentUrl?: string) => {} };
	const clock = mock.clock(on, { now: 1_000_000 });
	on("session.start", () => ({ cwd: CWD }));
	const env: Record<string, string | undefined> = { HOME: "/home/g", ...(opts.env ?? {}) };
	on("env.get", ($: any, e: any) => ({ value: env[e.name] }));
	on("env.set", ($: any, e: any) => {
		env[e.name] = e.value;
		return { value: undefined };
	});
	for (const [k, v] of Object.entries(opts.store ?? {})) did.store.set(k, v);
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
	did.push = (env: any, attachmentUrl?: string) => {
		did.seq++;
		const evt: any = { id: "m" + did.seq, time: Math.floor(Date.now() / 1000) + did.seq, event: "message", message: JSON.stringify(env) };
		if (attachmentUrl) {
			evt.message = "You received a file: attachment.json";
			evt.attachment = { name: "attachment.json", url: attachmentUrl, size: JSON.stringify(env).length };
		}
		feed.push(JSON.stringify(evt) + "\n");
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
		// A long message's attachment, fetched from the relay's /file/ path.
		if (!e.init?.method) {
			const text = did.files.get(e.url);
			return { value: text === undefined ? { status: 404, ok: false, headers: {}, text: "" } : { status: 200, ok: true, headers: {}, text } };
		}
		did.posts.push({ url: e.url, body: e.init?.body ? JSON.parse(e.init.body) : undefined });
		const status = opts.fetchStatus ?? 200;
		return { value: { status, ok: status < 400, headers: {}, text: "" } };
	});
	// $.ui.ask reaches Claude Code as an AskUserQuestion call: answer it as the test says, or not at all.
	on("tool.call", ($: any, e: any) => {
		if (e.tool !== "AskUserQuestion") return { result: "ran" };
		const q = e.questions?.[0]?.question ?? "";
		did.asks.push(q);
		const a = opts.answer?.(q);
		return a ? { result: { answers: { [q]: a } } } : { result: "ran" };
	});
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

const msg = (text: string, from = "karlo") => ({ v: 1, id: "id-" + text, fromId: "peer-" + from, from, kind: "msg", text, ts: new Date().toISOString() });
const BAND = { plugin: "duet", component: "AbovePrompt", surface: "terminal", viewport: { columns: 120, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} } };
const PANE = { plugin: "duet", component: "Pane", requestId: "duet", viewport: { columns: 120, rows: 40 }, props: { title: "duet", isFocused: true, bodyColumns: 80, placement: "inline", scroll: { offset: 0, bodyRows: 20 }, view: {} } };
const done = (turnId: string) => ({ turnId, answer: "ok", durationMs: 1, isAborted: false, usage: null }) as any;
const startup = (mode: string) => ({ hook_event_name: "SessionStart", source: "startup", permission_mode: mode, session_id: "s", transcript_path: "/t", cwd: CWD }) as any;
const duetSubmits = (did: any) => did.submits.filter((t: string) => t.startsWith("[duet] from "));

async function join($: any, clock: any, args: string) {
	await $.command.run({ command: "duet", args });
	await settle(clock, 20);
}

// Press a card button, then let the 3-second undo window pass.
async function press($: any, clock: any, key: string, wait = true) {
	const band = await $.ui.mount(BAND as any);
	await band.press({ key });
	await band.unmount();
	if (wait) await clock.advance(3100);
	await settle(clock, 2);
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

test("joining announces itself, asks who's in the room, and sending publishes to the room's topic", async ($, on) => {
	const { did, clock, start } = world(on);
	await $.session.start(start());
	await join($, clock, "test-room-1 gaioz");
	expect(did.posts.length).toBe(1);
	expect(did.posts[0].body).toMatchObject({ v: 1, kind: "join", from: "gaioz", via: "claude-code" });
	expect(did.posts[0].url).toMatch(/\/duet_[0-9a-f]{40}$/);
	expect(did.logs.join("\n")).toMatch(/joined room test-room-1 as gaioz\./);
	expect(did.asks[0]).toMatch(/Who is in duet room test-room-1 with you\?/);
	// No clear answer: "someone else", so ask mode.
	expect(did.store.get("room:" + CWD)).toMatchObject({ code: "test-room-1", name: "gaioz", relay: "https://duet.gaioz.online" });
	const r: any = await withClock(clock, $.tool.call({ tool: "mcp__duet__send", text: "hello", to: "karlo" }));
	expect(String(r.result)).toMatch(/^Sent to karlo/);
	expect(did.posts[1].body).toMatchObject({ kind: "msg", text: "hello", to: "karlo", by: "agent" });
	expect(did.posts[1].url).toBe(did.posts[0].url);
});

test("an unreachable relay means no join", async ($, on) => {
	const { did, clock, start } = world(on, { fetchStatus: 403 });
	await $.session.start(start());
	await join($, clock, "test-room-2 gaioz");
	expect(did.logs.join("\n")).toMatch(/couldn't reach the relay .*HTTP 403\. Not joined/);
	expect(did.store.get("room:" + CWD)).toBeUndefined();
});

test("placeholder names, bad codes and leave words are not rooms; /duet off leaves and forgets", async ($, on) => {
	const { did, clock, start } = world(on);
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-3 YOUR_NAME" });
	await $.command.run({ command: "duet", args: "a;b" });
	await $.command.run({ command: "duet", args: "disable" });
	expect(did.posts.length).toBe(0);
	expect(did.logs[0]).toMatch(/placeholder/);
	expect(did.logs[1]).toMatch(/usage/);
	expect(did.logs[2]).toMatch(/not in a room/);
	await join($, clock, "test-room-3 gaioz");
	await $.command.run({ command: "duet", args: "off" });
	await settle(clock, 5);
	expect(did.posts.at(-1)?.body).toMatchObject({ kind: "note", note: "left" });
	expect(did.store.get("room:" + CWD)).toBeUndefined();
});

test("the user's own tool calls are not fenced", async ($, on) => {
	const { start } = world(on);
	await $.session.start(start());
	const r: any = await $.tool.call({ tool: "Write", file_path: "/home/g/.claude/settings.json", content: "{}" });
	expect(r.result).toBe("ran");
});

test("the pane is a read-only history: valid on terminal and desktop, no buttons or fields", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	for (const surface of ["terminal", "desktop"]) {
		const ui = await $.ui.mount({ ...PANE, surface } as any);
		expect(await ui.find({ type: "Text", text: "Not in a duet room." })).toBeDefined();
		await ui.unmount();
	}
	await join($, clock, "test-room-4 gaioz");
	did.push(msg("hello there"));
	did.push({ v: 1, id: "n1", fromId: "peer-karlo", from: "karlo", kind: "note", note: "declined", ts: new Date().toISOString() });
	await settle(clock);
	for (const surface of ["terminal", "desktop"]) {
		const ui = await $.ui.mount({ ...PANE, surface } as any);
		expect(await ui.find({ type: "Text", text: "Room test-room-4" })).toBeDefined();
		expect(await ui.find({ type: "Text", text: "hello there" })).toBeDefined();
		// The name appears once in a note line (it used to read "karlo karlo didn't take…").
		expect(await ui.find({ type: "Text", text: /^\d\d:\d\d  karlo didn't take your last message$/ })).toBeDefined();
		expect(await ui.find({ type: "Button" })).toBeUndefined();
		expect(await ui.find({ type: "Input" })).toBeUndefined();
		await ui.unmount();
	}
	did.feeding = false;
});

test("ask: a card offers Let Claude do it / Ignore; one press starts it after a 3 s undo; the turn is fenced, the user's isn't", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await join($, clock, "test-room-5 gaioz");
	did.push(msg("please run the tests"));
	await settle(clock);
	expect(did.toasts.join("\n")).toMatch(/message from karlo's agent/);
	let band = await $.ui.mount(BAND as any);
	expect(await band.find({ type: "Text", text: /please run the tests/ })).toBeDefined();
	expect(await band.find({ key: "take" })).toMatchObject({ props: { label: "Let Claude do it", hotkey: "1" } });
	expect(await band.find({ key: "ignore" })).toMatchObject({ props: { label: "Ignore", hotkey: "2" } });
	expect(await band.find({ key: "suggest" })).toBeUndefined();
	expect(await band.find({ key: "reply" })).toBeUndefined();
	await band.press({ key: "take" });
	expect(await band.find({ type: "Text", text: /starting karlo's request in 3 s/ })).toBeDefined();
	await band.unmount();
	await settle(clock, 2);
	expect(duetSubmits(did).length).toBe(0); // not before the undo window passes
	await clock.advance(3100);
	await settle(clock, 2);
	expect(duetSubmits(did).length).toBe(1);
	expect(duetSubmits(did)[0]).toMatch(/please run the tests/);
	await duetTurn($, did, clock, "t1");
	const outside: any = await $.tool.call({ tool: "Write", file_path: "/home/g/x.txt", content: "x" });
	expect(String(outside.deny ?? outside.result)).toMatch(/only files under \/work\/repo/);
	const okCall: any = await $.tool.call({ tool: "Edit", file_path: "src/a.js", old_string: "a", new_string: "b" });
	expect(okCall.result).toBe("ran");
	await $.turn.complete(done("t1"));
	// No "Send its answer" offer afterwards.
	band = await $.ui.mount(BAND as any);
	expect(await band.find({ key: "send-answer" })).toBeUndefined();
	await band.unmount();
	await $.prompt.submit({ text: "write ~/x.txt", origin: { kind: "composer" }, wait: false } as any);
	await $.turn.start({ turnId: "t2", text: "write ~/x.txt" } as any);
	const mine: any = await $.tool.call({ tool: "Write", file_path: "/home/g/x.txt", content: "x" });
	expect(mine.result).toBe("ran");
	did.feeding = false;
});

test("Cancel during the 3 s takes the choice back: nothing starts, nothing is sent", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await join($, clock, "test-room-6 gaioz");
	did.push(msg("delete everything"));
	await settle(clock);
	await press($, clock, "take", false);
	await press($, clock, "undo");
	expect(duetSubmits(did).length).toBe(0);
	await press($, clock, "ignore", false);
	await press($, clock, "undo");
	expect(did.posts.filter((p) => p.body?.kind === "note").length).toBe(0);
	const band = await $.ui.mount(BAND as any);
	expect(await band.find({ key: "take" })).toBeDefined();
	await band.unmount();
	did.feeding = false;
});

test("Ignore sends a declined note to the sender after the undo window", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await join($, clock, "test-room-7 gaioz");
	did.push(msg("delete everything"));
	await settle(clock);
	await press($, clock, "ignore");
	const note = did.posts.map((p) => p.body).find((b) => b?.kind === "note");
	expect(note).toMatchObject({ note: "declined", to: "karlo" });
	expect(duetSubmits(did).length).toBe(0);
	did.feeding = false;
});

test("a burst from one sender is one card and one toast, and goes to Claude in one turn", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await join($, clock, "test-room-8 gaioz");
	did.push(msg("first part"));
	did.push(msg("second part"));
	did.push(msg("third part"));
	await settle(clock);
	expect(did.toasts.filter((t) => /message from karlo/.test(t)).length).toBe(1);
	const band = await $.ui.mount(BAND as any);
	expect(await band.find({ type: "Text", text: /karlo's agent · 3 messages/ })).toBeDefined();
	await band.unmount();
	await press($, clock, "take");
	expect(duetSubmits(did).length).toBe(1);
	expect(duetSubmits(did)[0]).toMatch(/first part[\s\S]*second part[\s\S]*third part/);
	did.feeding = false;
});

test("a reply Claude tries to send is confirmed first; declining it sends nothing", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await join($, clock, "test-room-9 gaioz");
	did.push(msg("what files do you have?"));
	await settle(clock);
	await press($, clock, "take");
	await duetTurn($, did, clock, "p1");
	const r: any = await $.tool.call({ tool: "mcp__duet__send", text: "README.md, secrets.env" });
	expect(String(r.result)).toMatch(/your user chose not to send/);
	expect(did.asks.at(-1)).toMatch(/send this to karlo\?/);
	await $.turn.complete(done("p1"));
	expect(did.posts.filter((p) => p.body?.kind === "msg").length).toBe(0);
	did.feeding = false;
});

test("trust 'Only me': auto with no extra question, even under bypassPermissions; remembered for the room", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true, answer: (q) => (/Who is in duet room/.test(q) ? "Only me" : undefined) });
	await $.session.start(start());
	await $.classic.SessionStart(startup("bypassPermissions"));
	await join($, clock, "test-room-10 gaioz");
	expect(did.asks.length).toBe(1);
	did.push(msg("request 1"));
	await settle(clock);
	expect(duetSubmits(did).length).toBe(1); // started by itself
	await duetTurn($, did, clock, "a1");
	const r: any = await $.tool.call({ tool: "mcp__duet__send", text: "done" });
	expect(String(r.result)).toMatch(/^Sent/); // no confirm in auto
	await $.turn.complete(done("a1"));
	await $.command.run({ command: "duet", args: "off" });
	await join($, clock, "test-room-10 gaioz");
	expect(did.asks.length).toBe(1); // not asked again: the answer is remembered
	did.feeding = false;
});

test("trust 'Someone I trust completely' under bypassPermissions asks once more before auto", async ($, on) => {
	const { did, clock, start } = world(on, { answer: (q) => (/Who is in duet room/.test(q) ? "Someone I trust completely" : /Turn auto on\?/.test(q) ? "Turn auto on" : undefined) });
	await $.session.start(start());
	await $.classic.SessionStart(startup("bypassPermissions"));
	await join($, clock, "test-room-11 gaioz");
	expect(did.asks.length).toBe(2);
	expect(did.asks[1]).toMatch(/bypassPermissions.*Turn auto on\?/);
	expect(did.logs.join("\n")).toMatch(/auto: messages start a turn by themselves/);
});

test("auto: messages start turns by themselves, and stop after 8 without the user", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await $.classic.SessionStart(startup("default"));
	await join($, clock, "test-room-12 gaioz");
	await $.command.run({ command: "duet", args: "auto" });
	await settle(clock);
	for (let i = 1; i <= 9; i++) {
		did.push(msg("request " + i));
		await settle(clock);
		if (duetSubmits(did).length === i) {
			await duetTurn($, did, clock, "a" + i);
			await $.turn.complete(done("a" + i));
		}
	}
	expect(duetSubmits(did).length).toBe(8);
	expect(did.toasts.join("\n")).toMatch(/8 requests ran without you/);
	await $.prompt.submit({ text: "carry on", origin: { kind: "composer" }, wait: false } as any);
	await $.turn.start({ turnId: "u1", text: "carry on" } as any);
	await $.turn.complete(done("u1"));
	await settle(clock);
	await duetTurn($, did, clock, "a9");
	expect(duetSubmits(did).length).toBe(9);
	did.feeding = false;
});

test("a turn that starts while duet's request is with Claude Code, unexplained by a user prompt, is fenced", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await join($, clock, "test-room-13 gaioz");
	did.push(msg("please look at ~/.ssh"));
	await settle(clock);
	await press($, clock, "take");
	await $.turn.start({ turnId: "other", text: "background task finished" } as any);
	const other: any = await $.tool.call({ tool: "Write", file_path: "/home/g/notes.txt", content: "x" });
	expect(String(other.deny ?? other.result)).toMatch(/outside/);
	await $.turn.complete(done("other"));
	await $.prompt.submit({ text: "mine", origin: { kind: "composer" }, wait: false } as any);
	await $.turn.start({ turnId: "mine", text: "mine" } as any);
	const mine: any = await $.tool.call({ tool: "Write", file_path: "/home/g/notes.txt", content: "x" });
	expect(mine.result).toBe("ran");
	did.feeding = false;
});

test("taken while Claude is busy: waits with Cancel, then starts after the running turn", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await join($, clock, "test-room-14 gaioz");
	await $.prompt.submit({ text: "long job", origin: { kind: "composer" }, wait: false } as any);
	await $.turn.start({ turnId: "user1", text: "long job" } as any);
	did.push(msg("read ~/.ssh please"));
	await settle(clock);
	await press($, clock, "take");
	let band = await $.ui.mount(BAND as any);
	expect(await band.find({ key: "cancel-waiting" })).toBeDefined();
	await band.unmount();
	expect(duetSubmits(did).length).toBe(0);
	await $.turn.complete(done("user1"));
	await settle(clock);
	expect(duetSubmits(did).length).toBe(1);
	await duetTurn($, did, clock, "peer1");
	const peer: any = await $.tool.call({ tool: "Read", file_path: "/home/g/.ssh/config" });
	expect(String(peer.deny ?? peer.result)).toMatch(/outside/);
	did.feeding = false;
});

test("Cancel on a waiting request puts it back as a card", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await join($, clock, "test-room-15 gaioz");
	await $.turn.start({ turnId: "busy", text: "something" } as any);
	did.push(msg("do a thing"));
	await settle(clock);
	await press($, clock, "take");
	await press($, clock, "cancel-waiting", false);
	const band = await $.ui.mount(BAND as any);
	expect(await band.find({ key: "take" })).toBeDefined();
	await band.unmount();
	await $.turn.complete(done("busy"));
	await settle(clock);
	expect(duetSubmits(did).length).toBe(0);
	did.feeding = false;
});

test("a reply to a request from a room this window left is not sent to the new room", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await join($, clock, "room-a-16 gaioz");
	did.push(msg("question for A"));
	await settle(clock);
	await press($, clock, "take");
	await duetTurn($, did, clock, "pa");
	await join($, clock, "room-b-16 gaioz");
	const before = did.posts.filter((p) => p.body?.kind === "msg").length;
	const r: any = await $.tool.call({ tool: "mcp__duet__send", text: "answer meant for A" });
	expect(String(r.result)).toMatch(/room this window has left/);
	expect(did.posts.filter((p) => p.body?.kind === "msg").length).toBe(before);
	did.feeding = false;
});

test("an empty-text continuation of a peer turn stays fenced; the user's next prompt ends that", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await join($, clock, "test-room-17 gaioz");
	did.push(msg("work"));
	await settle(clock);
	await press($, clock, "take");
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

test("after a restart the window rejoins its room quietly (ask mode), but not after 12 hours", async ($, on) => {
	const { did, clock, start } = world(on, { store: { ["room:" + CWD]: { code: "test-room-18", name: "gaioz", relay: "https://duet.gaioz.online", at: Date.now() - 60_000 } } });
	await $.session.start(start());
	await settle(clock, 20);
	expect(did.posts[0]?.body).toMatchObject({ kind: "join", from: "gaioz" });
	expect(did.toasts.join("\n")).toMatch(/rejoined test-room-18 · \/duet off to leave/);
	expect(did.asks.length).toBe(0); // quiet: no question, no card
});

test("no quiet rejoin when the window left more than 12 hours ago", async ($, on) => {
	const { did, clock, start } = world(on, { store: { ["room:" + CWD]: { code: "test-room-19", name: "gaioz", relay: "https://duet.gaioz.online", at: Date.now() - 13 * 3600_000 } } });
	await $.session.start(start());
	await settle(clock, 20);
	expect(did.posts.length).toBe(0);
});

test("a new process forgets a peer turn a crashed one left behind", async ($, on) => {
	const { did, start } = world(on);
	did.store.set("turn:sess-1", { peerTurn: { froms: ["karlo"], roomKey: "k", turnId: "dead", waitNoted: false }, expected: [], peerAgents: [], at: Date.now() });
	await $.session.start(start());
	await $.turn.start({ turnId: "u", text: "mine" } as any);
	const mine: any = await $.tool.call({ tool: "Write", file_path: "/home/g/x", content: "x" });
	expect(mine.result).toBe("ran");
});

test("a module reload in the same process keeps a peer turn fenced", async ($, on) => {
	const { did, start } = world(on, { env: { DUET_PROCESS: "p1" } });
	did.store.set("turn:sess-1", { peerTurn: { froms: ["karlo"], roomKey: "k", turnId: "live", waitNoted: false }, expected: [], peerAgents: [], at: Date.now(), runningTurn: "live" });
	await $.session.start(start());
	const peer: any = await $.tool.call({ tool: "Write", file_path: "/home/g/x", content: "x" });
	expect(String(peer.deny ?? peer.result)).toMatch(/outside/);
});

test("a relay given after the name is used, and an odd one is refused", async ($, on) => {
	const { did, clock, start } = world(on);
	await $.session.start(start());
	await $.command.run({ command: "duet", args: "test-room-20 gaioz http://x.com/$(id)" });
	expect(did.posts.length).toBe(0);
	expect(did.logs[0]).toMatch(/plain http\(s\) URL/);
	await join($, clock, "test-room-20 gaioz https://ntfy.example.com/");
	expect(did.posts[0].url).toMatch(/^https:\/\/ntfy\.example\.com\/duet_[0-9a-f]{40}$/);
});

test("a fresh join listens from just before it, and shows who answers the join", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await join($, clock, "test-room-21 nika");
	expect(did.spawned[0]).toMatch(/\/json\?since=\d{10}"/);
	did.push({ v: 1, id: "j1", fromId: "peer-gaioz", from: "gaioz", kind: "join", via: "claude-code", ts: new Date().toISOString() });
	await settle(clock);
	const ui = await $.ui.mount({ ...PANE, surface: "terminal" } as any);
	expect(await ui.find({ type: "Text", text: /With gaioz \(Claude Code\)/ })).toBeDefined();
	await ui.unmount();
	did.feeding = false;
});

test("a yes to auto in one room doesn't carry to another room", async ($, on) => {
	const { did, clock, start } = world(on, { answer: (q) => (/Who is in duet room room-a/.test(q) ? "Only me" : /Who is in duet room room-b/.test(q) ? "Someone I trust completely" : undefined) });
	await $.session.start(start());
	await $.classic.SessionStart(startup("bypassPermissions"));
	await join($, clock, "room-a-30 gaioz");
	await join($, clock, "room-b-30 gaioz");
	// Room B asked for auto under bypass: it must ask "Turn auto on?" itself (unanswered here, so ask).
	expect(did.asks.some((q) => /Turn auto on\?/.test(q))).toBe(true);
	// Only room A ("Only me") switched auto on; room B stayed in ask.
	expect(did.logs.filter((l) => /auto: messages start a turn by themselves/.test(l)).length).toBe(1);
});

test("the trust question is honest about shell commands, and free text counts as someone else", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true, answer: (q) => (/Who is in duet room/.test(q) ? "Only me and nika from work" : undefined) });
	await $.session.start(start());
	await $.classic.SessionStart(startup("bypassPermissions"));
	await join($, clock, "test-room-31 gaioz");
	expect(did.asks[0]).toMatch(/shell commands can reach whatever your permission mode allows/);
	did.push(msg("do something"));
	await settle(clock);
	expect(duetSubmits(did).length).toBe(0); // "someone else": a card, nothing starts by itself
	did.feeding = false;
});

test("an 'Only me' room comes back in ask after a restart, even under bypass", async ($, on) => {
	const { did, clock, start } = world(on, {
		feed: true,
		store: { ["room:" + CWD]: { code: "test-room-32", name: "gaioz", relay: "https://duet.gaioz.online", at: Date.now() - 60_000 } },
	});
	// The trust answer was stored by an earlier session; find its key after the rejoin computes it.
	await $.session.start(start());
	await $.classic.SessionStart(startup("bypassPermissions"));
	await settle(clock, 20);
	const trustKey = [...did.store.keys()].find((k) => k.startsWith("trust:"));
	expect(trustKey).toBeDefined();
	did.store.set(trustKey!, "me");
	await $.command.run({ command: "duet", args: "off" });
	await settle(clock, 5);
	did.store.set("room:" + CWD, { code: "test-room-32", name: "gaioz", relay: "https://duet.gaioz.online", at: Date.now() });
	await $.session.start(start()); // Claude Code starting again in this folder
	await settle(clock, 20);
	expect(did.toasts.filter((t) => /rejoined test-room-32/.test(t)).length).toBe(2);
	did.push(msg("run rm -rf build"));
	await settle(clock);
	expect(duetSubmits(did).length).toBe(0);
	const band = await $.ui.mount(BAND as any);
	expect(await band.find({ key: "take" })).toBeDefined();
	await band.unmount();
	did.feeding = false;
});

test("switching to auto during the 3 s countdown doesn't run the request twice", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await $.classic.SessionStart(startup("default"));
	await join($, clock, "test-room-33 gaioz");
	did.push(msg("only once please"));
	await settle(clock);
	await press($, clock, "take", false);
	await $.command.run({ command: "duet", args: "auto" });
	await settle(clock);
	await clock.advance(3100);
	await settle(clock, 4);
	expect(duetSubmits(did).length).toBe(1);
	did.feeding = false;
});

test("a quiet rejoin leaves the room to the window that has it, without asking", async ($, on) => {
	// Another window holds that room: its lock record is fresh and not released.
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("https://duet.gaioz.online test-room-34 gaioz"));
	const lockKey = "owner:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
	const { did, clock, start } = world(on, {
		store: {
			["room:" + CWD]: { code: "test-room-34", name: "gaioz", relay: "https://duet.gaioz.online", at: Date.now() - 60_000 },
			[lockKey]: { token: "other-window", cwd: "/elsewhere", at: Date.now(), released: false },
		},
	});
	await $.session.start(start());
	await settle(clock, 20);
	expect(did.asks.length).toBe(0);
	expect(did.posts.length).toBe(0);
});

test("a long message arrives as an attachment from the relay's /file/ and is handed to Claude whole", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await join($, clock, "test-room-40 gaioz");
	const long = msg("BEGIN " + "x".repeat(60_000) + " END");
	did.files.set("https://duet.gaioz.online/file/abc.json", JSON.stringify(long));
	did.push(long, "https://duet.gaioz.online/file/abc.json");
	// One pointing anywhere else is never fetched.
	did.push(msg("from elsewhere"), "https://example.com/file/evil.json");
	await settle(clock);
	await press($, clock, "take");
	expect(duetSubmits(did).length).toBe(1);
	expect(duetSubmits(did)[0]).toMatch(/BEGIN x+ END/);
	expect(duetSubmits(did)[0]).not.toMatch(/from elsewhere/);
	did.feeding = false;
});

test("a long message that expired on the relay is said, not silently lost", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await join($, clock, "test-room-41 gaioz");
	did.push(msg("gone"), "https://duet.gaioz.online/file/gone.json");
	await settle(clock);
	expect(did.toasts.join("\n")).toMatch(/a long message expired before it could be read/);
	did.feeding = false;
});

test("a reply names the message it answers; our reply to a peer says which request it answers", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true, answer: (q) => (/send this to/.test(q) ? "Send" : undefined) });
	await $.session.start(start());
	await join($, clock, "test-room-42 gaioz");
	// We ask something; the answer comes back with re = our message's id.
	const r: any = await withClock(clock, $.tool.call({ tool: "mcp__duet__send", text: "Which Node version do you use?\nThanks" }));
	expect(String(r.result)).toMatch(/^Sent/);
	const ours = did.posts.at(-1).body;
	did.push({ ...msg("v24.21"), re: ours.id });
	await settle(clock);
	let band = await $.ui.mount(BAND as any);
	expect(await band.find({ type: "Text", text: /↳ reply to your message “Which Node version do you use\?”/ })).toBeDefined();
	await band.unmount();
	await press($, clock, "take");
	expect(duetSubmits(did)[0]).toMatch(/a reply to your message “Which Node version do you use\?”/);
	await duetTurn($, did, clock, "r1");
	// Answering the peer's request: re = the id of the request.
	did.push(msg("and one more question"));
	await settle(clock);
	const sentReply: any = await withClock(clock, $.tool.call({ tool: "mcp__duet__send", text: "done" }));
	expect(String(sentReply.result)).toMatch(/^Sent/);
	expect(did.posts.at(-1).body).toMatchObject({ kind: "msg", text: "done", re: "id-v24.21" });
	// The second message waits while Claude works: the footer says so.
	const footer = await $.ui.mount({ plugin: "duet", component: "SessionMode", surface: "terminal", props: { modes: [] } } as any);
	await footer.unmount();
	did.feeding = false;
});

test("a third agent, or another window in this same folder, is warned about once", async ($, on) => {
	const { did, clock, start } = world(on, { feed: true });
	await $.session.start(start());
	await join($, clock, "test-room-43 gaioz");
	const ourJoin = did.posts[0].body;
	expect(typeof ourJoin.place).toBe("string");
	did.push({ v: 1, id: "j1", fromId: "peer-nika", from: "nika", kind: "join", via: "claude-code", place: ourJoin.place, ts: new Date().toISOString() });
	did.push({ v: 1, id: "j2", fromId: "peer-dato", from: "dato", kind: "join", via: "pi", ts: new Date().toISOString() });
	await settle(clock);
	expect(did.toasts.filter((t) => /nika is in this room from this same folder/.test(t)).length).toBe(1);
	expect(did.toasts.filter((t) => /more than one other agent is in this room/.test(t)).length).toBe(1);
	did.feeding = false;
});
