/** Verify a copied store without opening or modifying the live Conduit store. */
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { verifyReplayParity } from "../src/lib/persistence/replay-parity.js";

const { values } = parseArgs({
	options: {
		source: { type: "string" },
		output: { type: "string" },
		help: { type: "boolean", short: "h" },
	},
});

if (values.help) {
	console.log(`Usage: node --import tsx scripts/verify-replay-parity.ts --source <store-copy.db> --output <report.json>

Replay the kept event log and compare all live-session projection rows.
Ignores version and session_sidebar.row.version. Sources under ~/.config/conduit are refused.
Exits non-zero for projection differences or dangling tool-result pointers.`);
} else {
	assert(
		values.source && values.output,
		"--source and --output are required; use --help for usage",
	);
	const sourceFilename = realpathSync(values.source);
	assert(
		!sourceFilename.startsWith(join(homedir(), ".config", "conduit")),
		"Use a copy outside ~/.config/conduit",
	);
	const outputFilename = resolve(values.output);
	assert(
		outputFilename !== sourceFilename,
		"--output must not overwrite the source store",
	);
	if (existsSync(outputFilename)) {
		const sourceStat = statSync(sourceFilename);
		const outputStat = statSync(outputFilename);
		assert(
			sourceStat.dev !== outputStat.dev || sourceStat.ino !== outputStat.ino,
			"--output must not overwrite the source store",
		);
	}
	const report = await Effect.runPromise(verifyReplayParity(sourceFilename));
	mkdirSync(dirname(outputFilename), { recursive: true });
	writeFileSync(outputFilename, `${JSON.stringify(report, null, "\t")}\n`);
	console.error(`Wrote ${outputFilename}`);
	if (report.diffs.length || report.danglingPartPointers.length)
		process.exitCode = 1;
}
