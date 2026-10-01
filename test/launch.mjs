// Runs one test agent's shell in a clean environment: `node test/launch.mjs <spec.json>`.
// The spec lists the variables the agent may see; the API key is copied from this process's own
// environment (the tmux server's), so it never appears in a command line, a keystroke or a file.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const env = { ...spec.env };
for (const name of spec.keyAs ?? []) env[name] = process.env.OPENROUTER_API_KEY ?? "";
const child = spawn(spec.cmd, spec.args ?? [], { cwd: spec.cwd, env, stdio: "inherit" });
for (const s of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(s, () => child.kill(s));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
