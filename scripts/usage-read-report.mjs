#!/usr/bin/env node
// Reports how long Usage reads take, from the daemon log. Read-only.
//
//   node scripts/usage-read-report.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [log ...]
//
// Days are local and inclusive. With no log given it reads
// ~/.config/conduit/daemon.log.1 and ~/.config/conduit/daemon.log.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { since: { type: "string" }, until: { type: "string" } },
});
const dayStart = (day, offset = 0) => {
	const start = new Date(`${day}T00:00:00`);
	start.setDate(start.getDate() + offset);
	return start.getTime();
};
const from = values.since ? dayStart(values.since) : -Infinity;
const to = values.until ? dayStart(values.until, 1) : Infinity;
const logs = positionals.length
	? positionals
	: ["daemon.log.1", "daemon.log"]
			.map((name) => join(homedir(), ".config", "conduit", name))
			.filter((path) => existsSync(path));

const entries = logs
	.flatMap((path) => readFileSync(path, "utf8").split("\n"))
	.flatMap((line) => {
		try {
			const entry = JSON.parse(line);
			return entry.time >= from && entry.time < to ? [entry] : [];
		} catch {
			return [];
		}
	});

const percentile = (sorted, p) =>
	sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const durations = (values) => {
	const sorted = values.toSorted((a, b) => a - b);
	if (!sorted.length) return "no samples";
	const ms = (value) => `${Math.round(value)}ms`;
	return [50, 90, 99]
		.map((p) => `p${p} ${ms(percentile(sorted, p))}`)
		.concat(`max ${ms(sorted.at(-1))}`)
		.join(", ");
};
const tally = (values) =>
	Object.entries(Object.groupBy(values, (value) => value))
		.map(([value, group]) => `${value} ${group.length}`)
		.join(", ") || "none";

const settled = entries.filter((entry) => entry.msg === "Usage read settled");
const rpcs = entries
	.filter(
		(entry) => entry.msg === "slow rpc" && entry.method === "QuotaForAccounts",
	)
	.map((entry) => entry.totalMs);
const atOldCeiling = rpcs.filter((ms) => ms >= 5000 && ms < 5400).length;

console.log(`Logs: ${logs.join(", ") || "none found"}`);
console.log(`Settled Usage reads: ${settled.length}`);
console.log(`  outcomes: ${tally(settled.map((entry) => entry.outcome))}`);
console.log(
	`  timed out: ${settled.filter((entry) => entry.reason === "Usage read timed out").length}`,
);
console.log(
	`  duration: ${durations(settled.map((entry) => entry.durationMs))}`,
);
console.log(`  per account: ${tally(settled.map((entry) => entry.accountId))}`);
console.log(`Slow QuotaForAccounts RPCs: ${rpcs.length}`);
console.log(`  at the old 5s read ceiling (5000-5399ms): ${atOldCeiling}`);
console.log(`  duration: ${durations(rpcs)}`);
