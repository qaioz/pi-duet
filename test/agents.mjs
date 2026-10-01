// Test agents for the real-model tests: pi, Claude Code and Codex, each in its own tmux window on a
// private tmux socket, in an isolated shell (own HOME and config, empty npm cache, only the variables
// it needs). The test types into that shell exactly what a person would. What each agent did is read
// back from the agent's own session log, never from what the model says it did.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const TEST_ROOT = process.env.DUET_TEST_DIR || join(homedir(), "coding/personal/duet-test-v2");
export const TOOLS_BIN = join(TEST_ROOT, "tools/node_modules/.bin"); // the locally installed codex
const SOCKET = ["-L", "duet-v2"];
const LAUNCH = resolve(import.meta.dirname, "launch.mjs");

export const MODELS = {
	pi: process.env.DUET_PI_MODEL || "deepseek/deepseek-v4-flash",
	// deepseek-v4-flash made up text in Claude Code (RESEARCH-v2.md), so Claude Code runs on Haiku.
	claude: process.env.DUET_CLAUDE_MODEL || "anthropic/claude-haiku-4.5",
	codex: process.env.DUET_CODEX_MODEL || "deepseek/deepseek-v4-flash",
};
// OpenRouter prices, USD per token (read from openrouter.ai/api/v1/models on 2026-10-01).
const PRICE = {
	"deepseek/deepseek-v4-flash": { in: 0.042e-6, cacheRead: 0.0084e-6, cacheWrite: 0.042e-6, out: 0.084e-6 },
	"anthropic/claude-haiku-4.5": { in: 1e-6, cacheRead: 0.1e-6, cacheWrite: 1.25e-6, out: 5e-6 },
	"openai/gpt-5.6-luna": { in: 0.2e-6, cacheRead: 0.02e-6, cacheWrite: 0.2e-6, out: 1.2e-6 },
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(pred, ms, what) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = await pred();
		if (v) return v;
		await sleep(1000);
	}
	throw new Error(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}`);
}

// The tmux server is started by the first call, with this process's environment minus everything
// but PATH and the key: the key then reaches launch.mjs through the server, not through argv.
function tmux(...args) {
	const env = { PATH: process.env.PATH, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "", HOME: process.env.HOME, TERM: "xterm-256color" };
	return execFileSync("tmux", [...SOCKET, ...args], { env, encoding: "utf8" });
}
export function killTmux() {
	try {
		tmux("kill-server");
	} catch {}
}

function walk(dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (p.endsWith(".jsonl")) out.push(p);
	}
	return out;
}
const jsonl = (file) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((l) => {
			try {
				return [JSON.parse(l)];
			} catch {
				return [];
			}
		});
const text = (content) =>
	typeof content === "string" ? content : (content ?? []).map((c) => c.text ?? (typeof c.content === "string" ? c.content : "")).join("");

// ---------- one agent ----------

export class Agent {
	constructor(kind, name, { dir, cwd, model = MODELS[kind], permissive = true } = {}) {
		this.kind = kind;
		this.name = name;
		this.dir = dir ?? join(TEST_ROOT, "agents", `${kind}-${name}`);
		this.cwd = cwd ?? join(this.dir, "work");
		this.home = join(this.dir, "home");
		this.model = model;
		this.permissive = permissive;
		this.session = `${kind}-${name}`;
	}

	// Fresh dirs and the agent's own config: model login, trusted folder, nothing of duet installed.
	seed() {
		rmSync(this.dir, { recursive: true, force: true });
		mkdirSync(this.home, { recursive: true });
		mkdirSync(this.cwd, { recursive: true });
		execFileSync("git", ["init", "-q", this.cwd]); // Claude Code stops looking for project files here
		const env = { HOME: this.home, PATH: [dirname(process.execPath), TOOLS_BIN, "/usr/local/bin", "/usr/bin", "/bin"].join(":"), TERM: "xterm-256color", LANG: "C.UTF-8", PS1: "$ " };
		let keyAs = [];
		if (this.kind === "pi") {
			const agentDir = join(this.home, ".pi/agent");
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openrouter", defaultModel: this.model }));
			keyAs = ["OPENROUTER_API_KEY"];
		} else if (this.kind === "claude") {
			const conf = join(this.dir, "claude");
			mkdirSync(conf, { recursive: true });
			writeFileSync(join(conf, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [this.cwd]: { hasTrustDialogAccepted: true } } }));
			const settings = {
				skipDangerousModePermissionPrompt: true,
				// Claude Code reads CLAUDE.md files in every folder above the cwd: keep Gaioz's out.
				claudeMdExcludes: [join(homedir(), "CLAUDE.md"), join(homedir(), ".claude/**"), join(homedir(), "coding/**/CLAUDE.md")],
			};
			// Test agents may skip permission prompts; "disable" also stops the one-time auto-mode offer dialog.
			if (this.permissive) Object.assign(settings, { permissions: { defaultMode: "bypassPermissions" }, disableAutoMode: "disable" });
			writeFileSync(join(conf, "settings.json"), JSON.stringify(settings));
			Object.assign(env, {
				CLAUDE_CONFIG_DIR: conf,
				ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
				ANTHROPIC_API_KEY: "",
				ANTHROPIC_MODEL: this.model,
				ANTHROPIC_DEFAULT_OPUS_MODEL: this.model,
				ANTHROPIC_DEFAULT_SONNET_MODEL: this.model,
				ANTHROPIC_DEFAULT_HAIKU_MODEL: this.model,
				CLAUDE_CODE_SUBAGENT_MODEL: this.model,
			});
			keyAs = ["ANTHROPIC_AUTH_TOKEN"];
		} else if (this.kind === "codex") {
			const codexHome = join(this.home, ".codex"); // the default, so `codex queue` from the MCP server finds it
			mkdirSync(codexHome, { recursive: true });
			writeFileSync(
				join(codexHome, "config.toml"),
				`model = ${JSON.stringify(this.model)}
model_provider = "openrouter"
${this.permissive ? 'approval_policy = "never"\nsandbox_mode = "workspace-write"\n' : ""}
[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
wire_api = "responses"

[model_providers.openrouter.auth]
command = "sh"
args = ["-c", "echo $OPENROUTER_API_KEY"]

[projects.${JSON.stringify(this.cwd)}]
trust_level = "trusted"
`,
			);
			env.CODEX_HOME = codexHome;
			keyAs = ["OPENROUTER_API_KEY"];
		}
		this.env = env;
		writeFileSync(join(this.dir, "launch.json"), JSON.stringify({ cmd: "bash", args: ["--noprofile", "--norc"], cwd: this.cwd, env, keyAs }));
		return this;
	}

	// An isolated shell in its own tmux window, as if the person opened a terminal in the project.
	open() {
		this.started = Date.now();
		tmux("new-session", "-d", "-s", this.session, "-x", "220", "-y", "50", `${process.execPath} ${LAUNCH} ${join(this.dir, "launch.json")}`);
		return this;
	}

	// Type one line and press Enter. Never used for anything secret.
	async type(line) {
		tmux("send-keys", "-t", this.session, "-l", line);
		await sleep(400);
		tmux("send-keys", "-t", this.session, "Enter");
		await sleep(600);
	}
	key(k) {
		tmux("send-keys", "-t", this.session, k);
	}
	screen() {
		try {
			return tmux("capture-pane", "-p", "-t", this.session, "-S", "-200");
		} catch {
			return "";
		}
	}
	// Start the next command on a clean screen, so old output can't satisfy a wait.
	async clear() {
		await this.type("clear");
		tmux("clear-history", "-t", this.session);
	}
	atShell() {
		const lines = this.screen().split("\n").filter((l) => l.trim());
		return /^\$\s*$/.test(lines.at(-1) ?? "");
	}
	waitShell(ms, what) {
		return until(() => this.atShell(), ms, `${this.name} back at the shell prompt: ${what}`);
	}
	waitScreen(re, ms, what) {
		return until(() => re.test(this.screen()), ms, `${this.name}'s screen: ${what ?? re}`);
	}

	// Close the window and anything it left behind (Codex's background server, MCP servers).
	stop() {
		try {
			tmux("kill-session", "-t", this.session);
		} catch {}
		for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
			let cwd = "";
			let exe = "";
			try {
				cwd = readlinkSync(`/proc/${pid}/cwd`);
				exe = readlinkSync(`/proc/${pid}/exe`);
			} catch {}
			if (cwd.startsWith(this.dir) || exe.startsWith(this.dir)) {
				try {
					process.kill(Number(pid), "SIGKILL");
				} catch {}
			}
		}
	}

	// ---------- what the agent really did, from its own session log ----------
	// A list of { at, type, ... }:
	//   in    — a duet message shown to the model ({text}, how: "turn" (pushed) | "tool" (wait/inbox))
	//   send  — a duet_send call ({text, error})
	//   tool  — any other tool call ({name, input, output})
	//   user  — a prompt typed by the person ({text})
	//   cost  — spend of one model call ({usd})
	events() {
		if (this.kind === "pi") return this.piEvents();
		if (this.kind === "claude") return this.claudeEvents();
		return this.codexEvents();
	}
	cost() {
		return this.events().filter((e) => e.type === "cost").reduce((s, e) => s + e.usd, 0);
	}
	price(usage) {
		const p = PRICE[this.model] ?? PRICE["anthropic/claude-haiku-4.5"];
		return (usage.in ?? 0) * p.in + (usage.cacheRead ?? 0) * p.cacheRead + (usage.cacheWrite ?? 0) * p.cacheWrite + (usage.out ?? 0) * p.out;
	}

	piEvents() {
		const out = [];
		const results = new Map();
		const entries = walk(join(this.home, ".pi/agent/sessions")).flatMap(jsonl);
		for (const e of entries) if (e.type === "message" && e.message?.role === "toolResult") results.set(e.message.toolCallId, e.message);
		for (const e of entries) {
			const at = Date.parse(e.timestamp);
			if (e.type === "custom_message" && e.customType === "duet") out.push({ at, type: "in", how: "turn", text: text(e.content) });
			if (e.type !== "message") continue;
			const m = e.message;
			if (m.role === "user") out.push({ at, type: "user", text: text(m.content) });
			if (m.role === "assistant") {
				if (m.usage?.cost?.total) out.push({ at, type: "cost", usd: m.usage.cost.total, model: m.model });
				for (const c of m.content ?? []) {
					if (c.type !== "toolCall") continue;
					const r = results.get(c.id);
					if (c.name === "duet_send") out.push({ at, type: "send", text: c.arguments?.text, error: r?.isError ? text(r.content) : undefined });
					else out.push({ at, type: "tool", name: c.name, input: c.arguments, output: r ? text(r.content) : undefined });
				}
			}
		}
		return out;
	}

	claudeEvents() {
		const out = [];
		const entries = walk(join(this.dir, "claude/projects")).flatMap(jsonl);
		const results = new Map();
		for (const e of entries) {
			if (e.type !== "user" || !Array.isArray(e.message?.content)) continue;
			for (const c of e.message.content) if (c.type === "tool_result") results.set(c.tool_use_id, c);
		}
		const billed = new Set();
		for (const e of entries) {
			const at = Date.parse(e.timestamp);
			const m = e.message;
			if (e.type === "user" && m) {
				const t = text(m.content);
				if (typeof m.content === "string" || (Array.isArray(m.content) && !m.content.some((c) => c.type === "tool_result"))) {
					if (/<task-notification>/.test(t)) {
						if (t.includes("[duet] from")) out.push({ at, type: "in", how: "turn", text: t });
					} else if (!e.isMeta && t.trim()) out.push({ at, type: "user", text: t });
				}
			}
			if (e.type !== "assistant" || !m) continue;
			if (m.model) this.seenModel = m.model;
			if (m.usage && m.id && !billed.has(m.id)) {
				billed.add(m.id);
				const u = m.usage;
				out.push({ at, type: "cost", model: m.model, usd: this.price({ in: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, out: u.output_tokens }) });
			}
			for (const c of m.content ?? []) {
				if (c.type !== "tool_use") continue;
				const r = results.get(c.id);
				const output = r ? text(r.content) : undefined;
				if (c.name === "mcp__duet__duet_send") out.push({ at, type: "send", text: c.input?.text, error: r?.is_error ? output : undefined });
				else if (/^mcp__duet__duet_(wait|inbox)$/.test(c.name)) {
					out.push({ at, type: "tool", name: c.name, input: c.input, output });
					if (output?.includes("[duet] from")) out.push({ at, type: "in", how: "tool", text: output });
				} else out.push({ at, type: "tool", name: c.name, input: c.input, output });
			}
		}
		return out;
	}

	codexEvents() {
		const out = [];
		for (const e of walk(join(this.home, ".codex/sessions")).flatMap(jsonl)) {
			const at = Date.parse(e.timestamp);
			const p = e.payload;
			if (e.type === "event_msg" && p?.type === "token_count" && p.info?.last_token_usage) {
				const u = p.info.last_token_usage;
				out.push({ at, type: "cost", model: this.model, usd: this.price({ in: (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0), cacheRead: u.cached_input_tokens, out: u.output_tokens }) });
			}
			if (e.type !== "event_msg" || p?.type !== "item_completed") continue;
			const it = p.item;
			if (it.type === "UserMessage") {
				const t = text(it.content);
				out.push(t.includes("[duet] from") ? { at, type: "in", how: "turn", text: t } : { at, type: "user", text: t });
			} else if (it.type === "McpToolCall" && it.server === "duet") {
				const output = text(it.result?.Ok?.content ?? it.result?.content ?? []) || JSON.stringify(it.result ?? it.error ?? "");
				if (it.tool === "duet_send") out.push({ at, type: "send", text: it.arguments?.text, error: /"isError":true|Err/.test(JSON.stringify(it.result)) ? output : undefined });
				else {
					out.push({ at, type: "tool", name: `duet_${it.tool.replace(/^duet_/, "")}`, input: it.arguments, output });
					if (output.includes("[duet] from")) out.push({ at, type: "in", how: "tool", text: output });
				}
			} else if (it.type === "CommandExecution") {
				out.push({ at, type: "tool", name: "shell", input: it.command, output: it.aggregated_output ?? it.stdout ?? "" });
			}
		}
		return out.sort((a, b) => a.at - b.at);
	}
}
