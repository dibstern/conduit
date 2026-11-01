/**
 * Main's units at R2 beside the ledger build, step by step (CONTRACT.md 3592, the 32.2.17 row).
 * The units the landed 2.1 rows name (markRunning and recordSendReply in the reactor, rows 202,
 * 210, 211, 212 and the ledger effects and evidence of 215 and 216; requeueFailedSteers, rows 206
 * and 207; ProviderTurnService.abort, row 213) are loaded from 6c9ff950's tree into a temp
 * directory over a copy of the current tree; every other module is the current build's source
 * (gap P4, P9). Each catalogue trace replays through both, and after every step main's events,
 * rows, readInboxState and calls are compared.
 *
 * How it could fail, written before the code:
 * 1. Main's side silently runs the current units: each unit's copy must be its 6c9ff950 source
 *    and differ from the current file, and the catalogue must list some difference.
 * 2. Minted ids and clocks make every step differ, so the list is noise: the build against itself
 *    lists no difference for any trace. JSON columns are compared parsed.
 * 3. The comparison skips a part: a difference planted in one step's events, rows, inbox or
 *    calls is listed at that step and part.
 * 4. A side cannot run a trace: both sides must settle every step of every catalogue trace.
 */
import { execFileSync } from "node:child_process";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTraceArtifact } from "./harness.js";
import {
	mainTables,
	type ReplayResult,
	replayTrace,
	type StepSnapshot,
} from "./replay.js";
import { catalogueTraces } from "./traces.js";

const r2 = "6c9ff950";
const repo = resolve(import.meta.dirname, "../../../..");
const units = [
	"src/lib/provider/orchestration-side-effect-reactor.ts",
	"src/lib/persistence/effect/input-requeue-effect.ts",
	"src/lib/domain/relay/Services/provider-turn-service.ts",
] as const;

interface Difference {
	readonly fact: number;
	readonly part: string;
	readonly main: unknown;
	readonly build: unknown;
}

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Failure 2: ids become names local to the part they appear in, clocks, sequence numbers, hashes
 * and the replay's scratch directory become markers, and JSON columns (data, metadata, details, *_json) are compared parsed.
 */
const normal = (value: unknown): unknown => {
	const names = new Map<string, string>();
	const walk = (found: unknown, key: string): unknown => {
		if (found === null || found === undefined) return found;
		if (/(_at|At|^time|[tT]imestamp|^created|^updated)$/.test(key))
			return "<time>";
		if (/([sS]equence|[vV]ersion)$/.test(key)) return "<sequence>";
		// A command's fingerprint hashes its payload, which the comparison reads itself.
		if (/_hash$/.test(key)) return "<hash>";
		if (typeof found === "string") {
			if (/^(data|metadata|details)$|_json$/.test(key))
				return walk(JSON.parse(found), "");
			return found
				.replace(/conduit-replay-\w+/g, "<scratch>")
				.replace(uuid, (id) => {
					const name = names.get(id) ?? `<id${names.size + 1}>`;
					names.set(id, name);
					return name;
				});
		}
		if (Array.isArray(found)) return found.map((item) => walk(item, key));
		if (typeof found === "object")
			return Object.fromEntries(
				Object.entries(found).map(([field, item]) => [
					field,
					walk(item, field),
				]),
			);
		return found;
	};
	return walk(value, "");
};

const parts = (snapshot: StepSnapshot): readonly [string, unknown][] => [
	["events", snapshot.events],
	...mainTables.map((table): [string, unknown] => [
		`rows:${table}`,
		snapshot.rows[table],
	]),
	["inbox", snapshot.inbox],
	["calls", snapshot.calls],
];

const compare = (
	main: readonly StepSnapshot[],
	build: readonly StepSnapshot[],
): Difference[] =>
	build.flatMap((step, index) => {
		const before = main[index];
		if (before === undefined)
			return [{ fact: step.fact, part: "step", main: undefined, build: step }];
		const mainParts = new Map(parts(before));
		return parts(step).flatMap(([part, value]) => {
			const was = normal(mainParts.get(part));
			const now = normal(value);
			return JSON.stringify(was) === JSON.stringify(now)
				? []
				: [{ fact: step.fact, part, main: was, build: now }];
		});
	});

const scratch = mkdtempSync(join(tmpdir(), "conduit-main-units-"));
let mainReplay: typeof replayTrace;
const listed: Difference[] = [];

/**
 * Main's side is a copy of the current tree with R2's units written over it, imported from the
 * temp directory as a module graph of its own (gap P4). Mocking the units in place deadlocks:
 * they sit in import cycles, and a mock factory waits on itself.
 */
beforeAll(async () => {
	for (const tree of [
		"tsconfig.json",
		"src",
		"test/helpers",
		"test/unit/provider/run-ledger-oracle",
	])
		cpSync(join(repo, tree), join(scratch, tree), { recursive: true });
	symlinkSync(join(repo, "node_modules"), join(scratch, "node_modules"));
	for (const unit of units)
		writeFileSync(
			join(scratch, unit),
			execFileSync("git", ["-C", repo, "show", `${r2}:${unit}`]),
		);
	const main: typeof import("./replay.js") = await import(
		join(scratch, "test/unit/provider/run-ledger-oracle/replay.ts")
	);
	mainReplay = main.replayTrace;
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const catalogue = catalogueTraces().flatMap((trace) =>
	trace.provider === "claude" || trace.provider === "opencode"
		? [{ trace, provider: trace.provider }]
		: [],
);

const outcome = (result: ReplayResult) => ({
	unanswered: result.unanswered,
	unmatched: result.unmatched,
	refusals: result.refusals,
});

describe("Run ledger: main's units beside the ledger build", () => {
	it("loads each unit from R2's tree, never the current file", () => {
		for (const unit of units) {
			const atR2 = readFileSync(join(scratch, unit), "utf8");
			expect(atR2).toBe(
				execFileSync("git", ["-C", repo, "show", `${r2}:${unit}`], {
					encoding: "utf8",
				}),
			);
			expect(atR2, `${unit} at ${r2}`).not.toBe(
				readFileSync(join(repo, unit), "utf8"),
			);
		}
	});

	it("lists a difference planted in any part at its step", async () => {
		const trace = catalogue[0];
		expect(trace).toBeDefined();
		if (trace === undefined) return;
		const { snapshots } = await replayTrace(trace.trace, trace.provider);
		const last = snapshots.length - 1;
		const plants: readonly [string, (step: StepSnapshot) => StepSnapshot][] = [
			[
				"events",
				(step) => ({ ...step, events: [...step.events, { type: "x" }] }),
			],
			...mainTables.map(
				(table): [string, (step: StepSnapshot) => StepSnapshot] => [
					`rows:${table}`,
					(step) => ({ ...step, rows: { ...step.rows, [table]: [{ x: 1 }] } }),
				],
			),
			["inbox", (step) => ({ ...step, inbox: { planted: true } })],
			[
				"calls",
				(step) => ({ ...step, calls: [{ kind: "stop" }, ...step.calls] }),
			],
		];
		for (const [part, plant] of plants)
			expect(
				compare(
					snapshots,
					snapshots.map((step, index) => (index === last ? plant(step) : step)),
				).map(({ fact, part }) => [fact, part]),
			).toEqual([[snapshots[last]?.fact, part]]);
	});

	it.each(
		catalogue.map((entry) => [entry.trace.id, entry] as const),
	)("%s: the build against itself differs nowhere", async (_id, {
		trace,
		provider,
	}) => {
		const first = await replayTrace(trace, provider);
		const second = await replayTrace(trace, provider);
		expect(compare(first.snapshots, second.snapshots)).toEqual([]);
	});

	it.each(
		catalogue.map((entry) => [entry.trace.id, entry] as const),
	)("%s runs on both sides and lists every difference by step", async (_id, {
		trace,
		provider,
	}) => {
		const main = await mainReplay(trace, provider);
		const build = await replayTrace(trace, provider);
		const differences = compare(main.snapshots, build.snapshots);
		listed.push(...differences);
		writeTraceArtifact(`differential-main-${trace.id}`, {
			trace: trace.id,
			provider,
			differences,
			main: outcome(main),
			build: outcome(build),
		});
		expect(main.snapshots.map(({ fact }) => fact)).toEqual(
			trace.steps.map((_, fact) => fact),
		);
		expect(build.snapshots.map(({ fact }) => fact)).toEqual(
			trace.steps.map((_, fact) => fact),
		);
	});

	// Failure 1: were main's side the current build, nothing would differ.
	it("finds main's units differing from the build somewhere in the catalogue", () => {
		expect(listed.length).toBeGreaterThan(0);
	});
});
