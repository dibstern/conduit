import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
// The holder on the run row is the one copy of which runs a runner owns (CONTRACT.md 6.5), and the
// serving row picks a session's runner (6.9). These names belonged to the copies 32.13 deleted.
const deleted =
	/\bowned_run_ids\b|\bownedRunIds?\b|\bGonePending\b|\bnewestRunnerFirst\b/;
// Migration history keeps 0089's column, which 0093 drops.
const history = "src/lib/persistence/effect/migrations.ts";

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = join(directory, entry.name);
		return entry.isDirectory()
			? sources(file)
			: /\.(ts|svelte)$/.test(file)
				? [file]
				: [];
	});
}

describe("old run-state copies", () => {
	it("stay deleted from src", () => {
		const offenders = sources(join(root, "src")).flatMap((file) => {
			const name = relative(root, file);
			if (name === history) return [];
			return readFileSync(file, "utf8")
				.split("\n")
				.flatMap((line, index) =>
					deleted.test(line) ? [`${name}:${index + 1}`] : [],
				);
		});
		expect(offenders).toEqual([]);
	});
});
