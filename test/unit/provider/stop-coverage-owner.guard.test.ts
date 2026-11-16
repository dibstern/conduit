import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// CONTRACT.md 2067-2073, 2093: `stopCovers` is the one coverage predicate. `legacyStopOwnersQuery`
// stays main's as a read-only fallback for rows without `payload.stop`, so it is guarded, not deleted.
const root = process.cwd();

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = join(directory, entry.name);
		return entry.isDirectory()
			? sources(file)
			: file.endsWith(".ts")
				? [relative(root, file)]
				: [];
	});
}

const files = sources(join(root, "src/lib")).map((file) => ({
	file,
	text: readFileSync(join(root, file), "utf8"),
}));
const readers = (pattern: RegExp) =>
	files.filter(({ text }) => pattern.test(text)).map(({ file }) => file);

describe("Stop coverage has one reader", () => {
	it("reads committed Stop owners in SQL only in stopCovers and main's stopping recovery", () => {
		expect(readers(/'\$\.stop\.owners'/)).toEqual([
			// main's stopping wait restores fences whose owners still run (CONTRACT.md 2095-2096).
			"src/lib/domain/project-services/Services/provider-turn-service.ts",
			"src/lib/provider/session-run-settlement.ts",
		]);
	});

	it("keeps the legacy owners fallback to stopCovers, the reactor and the engine's replay", () => {
		expect(readers(/\blegacyStopOwnersQuery\b/)).toEqual([
			"src/lib/provider/orchestration-engine.ts",
			"src/lib/provider/orchestration-side-effect-reactor.ts",
			"src/lib/provider/session-run-settlement.ts",
		]);
	});

	it("filters the reactor's stop owners through stopCovers", () => {
		const reactor = files.find(
			({ file }) =>
				file === "src/lib/provider/orchestration-side-effect-reactor.ts",
		)?.text;
		expect(reactor).toMatch(
			/Effect\.filter\(candidates,\s*\(\{ runId \}\) =>\s*stopCovers\(/,
		);
	});

	it("names every code reader of a Stop's owners", () => {
		// Frames, the sidebar's and session row's empty-Stop check and the model's note read the
		// list; none answers whether a run is covered (CONTRACT.md 2069, 2087).
		expect(readers(/\bstop\??\.owners\b/)).toEqual([
			"src/lib/domain/daemon/Services/session-rows.ts",
			"src/lib/domain/project-services/Services/provider-turn-service.ts",
			"src/lib/persistence/effect/sidebar-projection.ts",
			"src/lib/provider/orchestration-engine.ts",
			"src/lib/provider/orchestration-side-effect-reactor.ts",
			"src/lib/provider/run-ledger/run-ledger-model.ts",
			"src/lib/provider/session-run-settlement.ts",
		]);
	});
});
