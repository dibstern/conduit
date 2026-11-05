#!/usr/bin/env node
// The Run Ledger crash matrix (82tn.32.14; CONTRACT.md 11.3): runs every proved cell against the
// built dist and writes test-results/82tn-32-14-crash-matrix.json, listing every catalogue case,
// every matrix cell and each invariant's result. Timings sit under `timings` alone, so two runs'
// artifacts match once that key is dropped.
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const manifest = JSON.parse(
	readFileSync("scripts/run-ledger/crash-matrix-manifest.json", "utf8"),
);
const CELLS = "test-results/82tn-32-14-crash-matrix/cells";
const OUT = "test-results/82tn-32-14-crash-matrix.json";
const REPORT = "test-results/82tn-32-14-crash-matrix/vitest.json";

const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Each proved cell's test is the `it` that calls proveCrashMatrixCell with its name.
const titleOf = ({ cell, file }) => {
	const source = readFileSync(file, "utf8");
	const call = source.search(
		new RegExp(`proveCrashMatrixCell\\(\\s*"${literal(cell)}"`),
	);
	if (call < 0) throw new Error(`${file} proves no cell ${cell}`);
	const titles = [
		...source.slice(0, call).matchAll(/\n\t+it\(\s*"((?:[^"\\]|\\.)*)"/g),
	];
	const title = titles.at(-1)?.[1];
	if (!title) throw new Error(`${file}: no test before cell ${cell}`);
	return JSON.parse(`"${title}"`);
};
const proved = manifest.cells
	.filter(({ status }) => status === "proved")
	.map((cell) => ({ ...cell, title: titleOf(cell) }));
const files = [...new Set(proved.map(({ file }) => file))];
const pattern = proved.map(({ title }) => literal(title)).join("|");

rmSync(join(CELLS, ".."), { recursive: true, force: true });
mkdirSync(CELLS, { recursive: true });
const run = spawnSync(
	"pnpm",
	[
		"exec",
		"vitest",
		"run",
		"--config",
		"vitest.integration.config.ts",
		...files,
		"-t",
		pattern,
		"--reporter=default",
		"--reporter=json",
		`--outputFile.json=${REPORT}`,
	],
	{ stdio: ["ignore", "inherit", "inherit"] },
);
const report = existsSync(REPORT)
	? JSON.parse(readFileSync(REPORT, "utf8"))
	: { testResults: [] };
const results = report.testResults.flatMap((file) =>
	file.assertionResults.map((test) => ({ ...test, file: resolve(file.name) })),
);

const timings = {};
const cells = manifest.cells.map((cell) => {
	if (cell.status !== "proved") return cell;
	const { title } = proved.find(({ cell: name }) => name === cell.cell);
	const result = results.find(
		(test) => test.file === resolve(cell.file) && test.title === title,
	);
	timings[cell.cell] = result?.duration ?? null;
	const fragment = join(CELLS, `${cell.cell.replaceAll("/", "--")}.json`);
	const invariants = existsSync(fragment)
		? JSON.parse(readFileSync(fragment, "utf8")).invariants
		: null;
	return { ...cell, title, result: result?.status ?? "not run", invariants };
});
const invariants = Object.fromEntries(
	manifest.invariants.map((name) => {
		const failing = cells
			.filter(({ invariants: held }) => held && held[name] !== true)
			.map(({ cell }) => cell);
		const unproved = cells
			.filter(({ status, invariants: held }) => status === "proved" && !held)
			.map(({ cell }) => cell);
		return [
			name,
			{
				holds: failing.length === 0 && unproved.length === 0,
				cells: cells.filter(({ invariants: held }) => held).length,
				failing,
				unproved,
			},
		];
	}),
);
const count = (rows) =>
	rows.reduce((counts, { status }) => {
		counts[status] = (counts[status] ?? 0) + 1;
		return counts;
	}, {});
const passed = cells.every(
	({ status, result }) => status !== "proved" || result === "passed",
);
mkdirSync("test-results", { recursive: true });
writeFileSync(
	OUT,
	`${JSON.stringify(
		{
			ticket: manifest.ticket,
			passed: passed && Object.values(invariants).every(({ holds }) => holds),
			counts: { catalogue: count(manifest.catalogue), cells: count(cells) },
			invariants,
			catalogue: manifest.catalogue,
			cells,
			timings,
		},
		null,
		2,
	)}\n`,
);
console.log(`wrote ${OUT}`);
process.exit(passed && run.status === 0 ? 0 : 1);
