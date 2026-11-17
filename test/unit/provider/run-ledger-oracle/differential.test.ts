/**
 * Main's units at R2 beside the ledger build, step by step (CONTRACT.md 3592, the 32.2.17 row).
 * The units the landed 2.1 rows name (markRunning and recordSendReply in the reactor, rows 202,
 * 210, 211, 212 and the ledger effects and evidence of 215 and 216; requeueFailedSteers, rows 206
 * and 207; ProviderTurnService.abort, row 213) are loaded from 6c9ff950's tree into a temp
 * directory over a copy of the current tree; every other module is the current build's source
 * (gap P4, P9). Each catalogue and generator trace (review traces included; Claude and OpenCode,
 * the providers with wire frames) replays through both, and after every step main's events,
 * rows, readInboxState and calls are compared.
 *
 * How it could fail, written before the code:
 * 1. Main's side silently runs the current units: each unit's copy must be its 6c9ff950 source
 *    and differ from the current file, and some trace must list a difference.
 * 2. Minted ids and clocks make every step differ, so the list is noise: the build against itself
 *    lists no difference for any trace. JSON columns are compared parsed.
 * 3. The comparison skips a part: a difference planted in one step's events, rows, inbox or
 *    calls is listed at that step and part.
 * 4. A side cannot run a trace: both sides must settle every step of every trace.
 *
 * Each difference is then masked by the 2.1 row that explains it, a typed mask (CONTRACT.md 210-211,
 * 3592; rows 215 and 216 are mask classes). How the masks could fail, written before the code:
 * 5. A difference no row explains passes: once masked, every trace must differ nowhere.
 * 6. A mask that never applies passes: each mask must, left out alone, leave some trace
 *    differing.
 * 7. A mask hides more than its class: a difference planted in any part still differs once masked.
 * 8. Masks depend on their order: each reads the step as recorded and edits only the masked copy.
 *
 * 9. A step ends before its file reads do, so a busy libuv pool moves the read's work into a later
 *    step (Node's fs/promises readFile is listed by no `getActiveResourcesInfo`): a replay whose
 *    pool is held at each Claude send's capability-cache read equals one whose pool is free.
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LEDGER_EFFECT_TYPES } from "../../../../src/lib/persistence/effect/run-ledger-arm.js";
import type { landedUnitRows } from "../../../../src/lib/provider/run-ledger/run-ledger-unit-rows.js";
import { writeTraceArtifact } from "./harness.js";
import {
	mainTables,
	type ReplayResult,
	replayTrace,
	type StepSnapshot,
} from "./replay.js";
import { allTraces } from "./traces.js";

const r2 = "6c9ff950";
const repo = resolve(import.meta.dirname, "../../../..");
const units = [
	"src/lib/provider/orchestration-side-effect-reactor.ts",
	"src/lib/persistence/effect/input-requeue-effect.ts",
	"src/lib/domain/project-services/Services/provider-turn-service.ts",
] as const;

/**
 * A unit's R2 source, with the paths 82tn.86 renamed after R2 pointed at their new names. R2's
 * reactor asks LegacySendKey whether a main-built runner sent the row; 32.47 deleted the key, as
 * the ledger build refuses every main-built runner, so the answer is always none.
 */
const sourceAtR2 = (unit: string): string =>
	execFileSync("git", [
		"-C",
		repo,
		"show",
		`${r2}:${unit.replace("domain/project-services/", "domain/relay/")}`,
	])
		.toString("utf8")
		.replaceAll("domain/relay/", "domain/project-services/")
		.replaceAll("./relay-event-sink.js", "./project-event-sink.js")
		.replace(
			"const legacy = yield* LegacySendKey.prove(this.options.sql, row);",
			"const legacy = undefined;",
		);

interface Difference {
	readonly fact: number;
	readonly part: string;
	readonly main: unknown;
	readonly build: unknown;
}

/** Failure 9: while `held`, each fs/promises readFile first fills libuv's pool with ~50ms jobs. */
const pool = vi.hoisted(() => ({ held: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	const { pbkdf2 } = await import("node:crypto");
	const readFile = new Proxy(real.readFile, {
		apply: (target, self, args) => {
			if (pool.held)
				for (let i = 0; i < Number(process.env["UV_THREADPOOL_SIZE"] ?? 4); i++)
					pbkdf2("", "", 600_000, 32, "sha256", () => {});
			return Reflect.apply(target, self, args);
		},
	});
	return { ...real, readFile, default: { ...real, readFile } };
});

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

/** A 2.1 row's difference, masked on both sides of a step (`recorded` is the step unmasked). */
interface Mask {
	readonly row: (typeof landedUnitRows)[number]["row"] | 215 | 216;
	readonly explains: string;
	readonly mask: (step: StepSnapshot, recorded: StepSnapshot) => StepSnapshot;
}

/**
 * Only rows 215 and 216 explain a difference any trace shows, so only they have masks. D56-202,
 * D56-211, D56-213, D56-206 and D56-207 reach the units rows 202, 211, 213, 206 and 207 change and
 * differ nowhere: main's own gate holds a start through a Claude wake; a Claude start's message is
 * placed at dispatch, so the view never reads it unplaced; the arm folds no tasks, so the view never
 * reads a task live; the in-process Claude runner writes no run.dispatched, so the view never reads
 * a steer possibly reached; and main's inbox refuses an OpenCode steer, so no direct steer is sent.
 * The other rows' branches need a wire fact this replay has none for (gap P10).
 */
const masks: readonly Mask[] = [
	{
		row: 215,
		explains:
			"the evidence events, which main's projectors ignore, and the event sequence they take from the native thread's delivered-through cursor",
		mask: (step) => ({
			...step,
			events: step.events.filter(
				({ type }) => typeof type !== "string" || !type.startsWith("evidence."),
			),
			rows: JSON.parse(
				JSON.stringify(step.rows).replace(
					/(deliveredThrough[\\"]*:)\d+/g,
					"$1-1",
				),
			),
		}),
	},
	{
		row: 216,
		explains:
			"the ledger effects' outbox rows (main has no arm to insert them) and the stop call each cancel_request its executor sent makes",
		mask: (step, recorded) => {
			const sent = recorded.events.filter(
				({ type, data }) =>
					type === "evidence.effect_outcome" &&
					typeof data === "string" &&
					/"commandId":"ledger:[^:"]+:cancel_request:/.test(data) &&
					!data.includes('"tag":"not_sent"'),
			).length;
			const stops = step.calls.flatMap((call, index) =>
				call.kind === "stop" ? [index] : [],
			);
			const dropped = new Set(stops.slice(stops.length - sent));
			return {
				...step,
				rows: {
					...step.rows,
					provider_command_outbox: step.rows.provider_command_outbox.filter(
						(row) =>
							!LEDGER_EFFECT_TYPES.some((type) => type === row["effect_type"]),
					),
				},
				calls: step.calls.filter((_, index) => !dropped.has(index)),
			};
		},
	},
];

const masked = (snapshots: readonly StepSnapshot[], by: readonly Mask[]) =>
	snapshots.map((step) =>
		by.reduce((copy, { mask }) => mask(copy, step), step),
	);

const scratch = mkdtempSync(join(tmpdir(), "conduit-main-units-"));
let mainReplay: typeof replayTrace;
const listed: Difference[] = [];
const applied = new Set<Mask["row"]>();

/**
 * Main's side is a copy of the current tree with R2's units written over it, imported from the
 * temp directory as a module graph of its own (gap P4). Mocking the units in place deadlocks:
 * they sit in import cycles, and a mock factory waits on itself. The frontend is left out: no
 * module outside it imports it, and it is half the tree's files.
 */
// test-waits-allow timeout-override: main's graph is a second transform of ~900 modules on the shared vite server: 1.4s idle, 8s beside a 2-worker oracle run, past 10s under a merge hook's integration sweep, so 60s.
beforeAll(async () => {
	for (const tree of [
		"tsconfig.json",
		"src",
		"test/helpers",
		"test/unit/provider/run-ledger-oracle",
	])
		cpSync(join(repo, tree), join(scratch, tree), {
			recursive: true,
			filter: (from) => from !== join(repo, "src/lib/frontend"),
		});
	symlinkSync(join(repo, "node_modules"), join(scratch, "node_modules"));
	for (const unit of units)
		writeFileSync(join(scratch, unit), sourceAtR2(unit));
	expect(sourceAtR2(units[0])).not.toContain("LegacySendKey.prove");
	// R2's reactor names a Stop's runs in its control context, which R2's runner read
	// (6c9ff950 runner-provider-instance.ts 1306); the current runner reads them from runIds alone.
	const runner = join(
		scratch,
		"src/lib/provider/runner/runner-provider-instance.ts",
	);
	const current = readFileSync(runner, "utf8");
	const bridged = current.replace(
		"// A bound Stop must leave a pre-warm",
		"runIds = control?.stopRunIds ?? runIds;\n\t\t// A bound Stop must leave a pre-warm",
	);
	expect(bridged).not.toBe(current);
	writeFileSync(runner, bridged);
	// R2's turn service provides its own dispatch FiberMap under a tag
	// (6c9ff950 provider-turn-service.ts 402); the current dispatch asks the daemon's turns.
	const dispatch = join(
		scratch,
		"src/lib/domain/project-services/Services/provider-turn-dispatch.ts",
	);
	const daemonFibers = readFileSync(dispatch, "utf8");
	const ownFibers = daemonFibers.replace(
		/yield\* \(yield\* DaemonTurns\)\.dispatchFibers\(\s*resolvedInput\.sessionId,\s*\)/,
		"yield* ProviderTurnDispatchFibersTag",
	);
	expect(ownFibers).not.toBe(daemonFibers);
	writeFileSync(
		dispatch,
		`${ownFibers}\nexport class ProviderTurnDispatchFibersTag extends Context.Service<ProviderTurnDispatchFibersTag, FiberMap.FiberMap<string, void, unknown>>()("ProviderTurnDispatchFibers") {}\n`,
	);
	// R2's turn service exported its own layer (6c9ff950 provider-turn-service.ts 407); the
	// current one is composed in the test harness.
	writeFileSync(
		join(scratch, "test/helpers/provider-turns.ts"),
		'export { ProviderTurnServiceLive } from "../../src/lib/domain/project-services/Services/provider-turn-service.js";\n',
	);
	const main: typeof import("./replay.js") = await import(
		join(scratch, "test/unit/provider/run-ledger-oracle/replay.ts")
	);
	mainReplay = main.replayTrace;
}, 60_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const traces = allTraces().flatMap((trace) =>
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
			expect(atR2).toBe(sourceAtR2(unit));
			expect(atR2, `${unit} at ${r2}`).not.toBe(
				readFileSync(join(repo, unit), "utf8"),
			);
		}
	});

	it("lists a difference planted in any part at its step", async () => {
		const trace = traces[0];
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
		// Failure 7: the masks leave a planted difference standing.
		for (const by of [[], masks])
			for (const [part, plant] of plants)
				expect(
					compare(
						masked(snapshots, by),
						masked(
							snapshots.map((step, index) =>
								index === last ? plant(step) : step,
							),
							by,
						),
					).map(({ fact, part }) => [fact, part]),
				).toEqual([[snapshots[last]?.fact, part]]);
	});

	it.each(
		traces.map((entry) => [entry.trace.id, entry] as const),
	)("%s: the build against itself differs nowhere", async (_id, {
		trace,
		provider,
	}) => {
		const first = await replayTrace(trace, provider);
		const second = await replayTrace(trace, provider);
		expect(compare(first.snapshots, second.snapshots)).toEqual([]);
	});

	it.each([
		"generated claude 5",
		"catalogue R5",
	])("%s: a step waits for its file reads however busy libuv's pool is", async (id) => {
		const entry = traces.find(({ trace }) => trace.id === id);
		expect(entry).toBeDefined();
		if (entry === undefined) return;
		const free = await replayTrace(entry.trace, entry.provider);
		pool.held = true;
		const held = await replayTrace(entry.trace, entry.provider).finally(() => {
			pool.held = false;
		});
		expect(compare(free.snapshots, held.snapshots)).toEqual([]);
	});

	it.each(
		traces.map((entry) => [entry.trace.id, entry] as const),
	)("%s runs on both sides and lists every difference by step", async (_id, {
		trace,
		provider,
	}) => {
		const main = await mainReplay(trace, provider);
		const build = await replayTrace(trace, provider);
		const differences = compare(main.snapshots, build.snapshots);
		const unmasked = compare(
			masked(main.snapshots, masks),
			masked(build.snapshots, masks),
		);
		// Failure 6: a mask applies where leaving it out alone leaves a difference.
		const needed = masks.filter(
			(mask) =>
				compare(
					masked(
						main.snapshots,
						masks.filter((other) => other !== mask),
					),
					masked(
						build.snapshots,
						masks.filter((other) => other !== mask),
					),
				).length > 0,
		);
		listed.push(...differences);
		for (const { row } of needed) applied.add(row);
		writeTraceArtifact(`differential-main-${trace.id}`, {
			trace: trace.id,
			provider,
			differences,
			masks: needed.map(({ row }) => row),
			unmasked,
			main: outcome(main),
			build: outcome(build),
		});
		expect(main.snapshots.map(({ fact }) => fact)).toEqual(
			trace.steps.map((_, fact) => fact),
		);
		expect(build.snapshots.map(({ fact }) => fact)).toEqual(
			trace.steps.map((_, fact) => fact),
		);
		// Failure 5.
		expect(unmasked).toEqual([]);
	});

	// Failure 1: were main's side the current build, nothing would differ.
	it("finds main's units differing from the build in some trace", () => {
		expect(listed.length).toBeGreaterThan(0);
	});

	// Failure 6: a mask that applies to no trace fails.
	it("applies every mask to some trace", () => {
		expect(
			masks.map(({ row }) => row).filter((row) => !applied.has(row)),
		).toEqual([]);
	});
});
