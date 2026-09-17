#!/usr/bin/env node

/**
 * `check`, `lint` and `test:unit` at once, reporting ALL failures rather than
 * the first.
 *
 * Run serially they are roughly 30s + 20s + 90s of mostly-idle waiting, and the
 * `&&` chain means a lint error hides a test failure until the next round trip.
 * Worse, the habit that produces is running them per-ticket instead of
 * per-commit: a unit-test failure introduced by commit `mkah` went unnoticed
 * for three commits because the suite was never run after it.
 *
 * Nothing here is a substitute for the visual gates, which are far slower and
 * have to run against a built storybook. This is the cheap tier.
 */

import { spawn } from "node:child_process";

const JOBS = [
	["check", ["pnpm", "check"]],
	["lint", ["pnpm", "lint"]],
	["unit", ["pnpm", "test:unit"]],
];

const results = await Promise.all(
	JOBS.map(
		([name, [cmd, ...args]]) =>
			new Promise((done) => {
				const started = Date.now();
				let output = "";
				const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
				child.stdout.on("data", (d) => {
					output += d;
				});
				child.stderr.on("data", (d) => {
					output += d;
				});
				child.on("close", (code) => {
					const secs = Math.round((Date.now() - started) / 1000);
					console.log(`${code === 0 ? "PASS" : "FAIL"} ${name} (${secs}s)`);
					done({ name, code, output });
				});
			}),
	),
);

const failed = results.filter((r) => r.code !== 0);
if (failed.length === 0) {
	console.log("\nverify: all green.");
	process.exit(0);
}

// Every failing job's tail, not just the first. Seeing both a type error and a
// test failure in one pass is the whole point.
for (const { name, output } of failed) {
	console.error(`\n===== ${name} =====\n${output.slice(-4000)}`);
}
console.error(`\nverify: ${failed.length} of ${results.length} failed.`);
process.exit(1);
