// The runner side of the cross-device test (.github/workflows/cross-device.yml): a pi agent on a
// GitHub-hosted machine joins a duet room and stays for DUET_MINUTES, doing what the devbox's agent
// asks. The room is derived from the API key and a public nonce, so the run's public inputs and logs
// never reveal it. Never prints the environment.
//
// Env: OPENROUTER_API_KEY, DUET_NONCE, DUET_NAME, DUET_SERVER, DUET_MINUTES, DUET_PIN (commit to install)
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const roomFor = (key, nonce) => createHash("sha256").update(`duet-ci:${key}:${nonce}`).digest("hex").slice(0, 32);

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("remote.mjs")) {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error("OPENROUTER_API_KEY is not set");
	const room = roomFor(key, process.env.DUET_NONCE);
	console.log(`::add-mask::${room}`);
	const name = process.env.DUET_NAME || "runner";
	const minutes = Number(process.env.DUET_MINUTES || 8);
	const work = resolve("duet-work");
	const agentDir = resolve("duet-agent");
	mkdirSync(work, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const win = process.platform === "win32";
	const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, DUET_ROOM: room, DUET_NAME: name, DUET_SERVER: process.env.DUET_SERVER || "https://ntfy.sh" };

	const src = `git:github.com/qaioz/pi-duet${process.env.DUET_PIN ? "@" + process.env.DUET_PIN : ""}`;
	const install = spawnSync("pi", ["install", src], { env, encoding: "utf8", shell: win });
	console.log(`pi install ${src}: exit ${install.status}`);
	if (install.status !== 0) {
		console.log((install.stdout + install.stderr).replaceAll(room, "<room>").slice(-2000));
		process.exit(1);
	}

	const pi = spawn("pi", ["--mode", "rpc", "--no-session", "--provider", "openrouter", "--model", "deepseek/deepseek-v4-flash"], { cwd: work, env, shell: win });
	const events = [];
	let buf = "";
	pi.stdout.on("data", (d) => {
		buf += d.toString("utf8");
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).replace(/\r$/, "");
			buf = buf.slice(nl + 1);
			try {
				events.push({ at: Date.now(), ...JSON.parse(line) });
			} catch {}
		}
	});
	let stderr = "";
	pi.stderr.on("data", (d) => (stderr += d));
	console.log(`${name} on ${process.platform} (${process.arch}), node ${process.version}: in the room for ${minutes} min`);
	await new Promise((r) => setTimeout(r, minutes * 60_000));
	pi.kill();

	// Evidence: the event stream, minus anything that could carry the room or the key.
	const clean = events.map((e) => JSON.stringify(e)).filter((l) => !l.includes(room) && !l.includes(key));
	writeFileSync(join(process.cwd(), "remote-events.jsonl"), clean.join("\n") + "\n");
	const duetIn = events.filter((e) => e.type === "message_end" && e.message?.customType === "duet").map((e) => e.message.content);
	const sends = events.filter((e) => e.type === "tool_execution_start" && e.toolName === "duet_send").map((e) => e.args?.text);
	const tools = events.filter((e) => e.type === "tool_execution_end").map((e) => ({ tool: e.toolName, output: (e.result?.content ?? []).map((c) => c.text ?? "").join("").slice(0, 600) }));
	const status = events.filter((e) => e.method === "setStatus" && e.statusKey === "duet").map((e) => e.statusText).at(-1);
	const say = (s) => console.log(String(s).replaceAll(room, "<room>").replaceAll(key, "<key>"));
	say(`duet status: ${status}`);
	say(`received ${duetIn.length} duet message(s): ${JSON.stringify(duetIn)}`);
	say(`sent ${sends.length}: ${JSON.stringify(sends)}`);
	say(`tool runs: ${JSON.stringify(tools)}`);
	if (!duetIn.length) say(`pi stderr (tail): ${stderr.slice(-1500)}`);
	process.exit(sends.length ? 0 : 1);
}
