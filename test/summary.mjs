// Folds the per-run results (DUET_RESULTS, one JSON line per suite run) into one table:
//   node test/summary.mjs <results.jsonl> <results.json>
// Every check keeps its pass/fail and evidence; each real-model scenario carries its $ (from the
// agents' own logs), the relay it ran on and the commit it was pinned to.
import { readFileSync, writeFileSync } from "node:fs";

const [src, dst] = process.argv.slice(2);
const runs = readFileSync(src, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const tests = [];
for (const run of runs) {
	const byScenario = new Map();
	for (const r of run.results) {
		const key = r.scenario ?? run.suite;
		if (!byScenario.has(key)) byScenario.set(key, { suite: run.suite, test: key, at: run.at, server: run.server, pin: run.pin, usd: 0, checks: [] });
		const t = byScenario.get(key);
		if (r.name === "spend") {
			t.usd += r.usd;
			if (r.nudged !== undefined) t.nudged = r.nudged;
			if (r.runUrl) t.runUrl = r.runUrl;
		} else t.checks.push({ name: r.name, ok: r.ok, evidence: r.evidence });
	}
	for (const t of byScenario.values()) tests.push({ ...t, ok: t.checks.length > 0 && t.checks.every((c) => c.ok) });
}
const total = tests.reduce((s, t) => s + t.usd, 0);
writeFileSync(dst, JSON.stringify({ generated: new Date().toISOString(), usd_total_from_agent_logs: Number(total.toFixed(4)), tests }, null, 2) + "\n");
for (const t of tests) console.log(`${t.ok ? "PASS" : "FAIL"}  $${t.usd.toFixed(4)}  ${t.at.slice(0, 16)}  ${t.server ?? ""}  ${t.test}`);
console.log(`${tests.filter((t) => t.ok).length}/${tests.length} tests passed; $${total.toFixed(4)} from the agents' logs`);
