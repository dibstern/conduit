/**
 * The arrival-order permutation gate (CONTRACT.md 3592, the 32.2.17 row; M9 at 5405-5406): for
 * each catalogue, review and generated trace, every order of up to 6 independent settlements gives
 * the same Run ends, reasons, input states and stop end.
 *
 * How it could fail, written before the code:
 * 1. Too loose: it permutes a fact with one it causes and reports an order dependence that is
 *    causality. The independence rule below keeps such pairs in trace order.
 * 2. Vacuous: no window holds two independent facts, so it passes having permuted nothing. A floor
 *    on the orders run per provider fails it.
 * 3. Renamed ids: decide mints ids in step order, so a reordered window swaps them and a later
 *    Answer reaches the wrong send. Each fact's minted ids are mapped to the trace order's.
 * 4. Blind: it compares nothing order can change. A planted order-sensitive ledger must fail it.
 * 5. Clock: a moved fact keeping its own time runs the clock backwards. Each position keeps its
 *    time; only the facts move.
 */
import { assert, describe, expect, it } from "vitest";
import type {
	IssuedEffect,
	LedgerView,
	RunEnded,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import { splitLabel } from "./fake-provider.js";
import {
	type LedgerImplementation,
	policy,
	referenceImplementation,
	writeTraceArtifact,
} from "./harness.js";
import { allTraces, providers, type Timed, type Trace } from "./traces.js";

/** M9 (CONTRACT.md 5405): up to 6 settlements per window. */
const windowSize = 6;

const isFact = ({ command }: Timed) =>
	command.verb === "observe" || command.verb === "settle";

/**
 * The names a fact or an issue carries (gap P2, nearest reading of CONTRACT.md 5405-5406, which
 * leaves "independent" undefined): its token, its command, and the Run and input it names, since
 * main's run.requested opens the Run a hold's answers then join.
 */
function namesOf(value: unknown, into = new Set<string>()) {
	if (Array.isArray(value)) for (const item of value) namesOf(item, into);
	else if (typeof value === "object" && value !== null)
		for (const [field, item] of Object.entries(value)) {
			if (typeof item !== "string") namesOf(item, into);
			else if (
				["token", "commandId", "runId", "requestedRunId", "inputId"].includes(
					field,
				)
			)
				into.add(item);
		}
	return into;
}

/**
 * Facts that act on the whole session: alarm_fired and session_ended reach whatever the facts
 * before them opened (CONTRACT.md 764-768), and a process starting or lost changes the current
 * process every unheld send goes to (CONTRACT.md 355-372).
 */
const sessionWide: readonly string[] = [
	"alarm_fired",
	"session_ended",
	"process_started",
	"process_lost",
];

/** One order of a trace through the bare decider, with each fact's minted ids. */
interface Run {
	readonly rejected: readonly number[];
	readonly minted: ReadonlyMap<number, readonly string[]>;
	readonly issued: ReadonlyMap<number, readonly IssuedEffect[]>;
	/** At the window's end, then at the trace's end, in trace-order ids. */
	readonly outcomes: readonly unknown[];
	/** A fact that minted a different number of ids than in trace order. */
	readonly moved?: number;
}

const rename = <T>(value: T, ids: ReadonlyMap<string, string>): T =>
	ids.size === 0
		? value
		: JSON.parse(
				JSON.stringify(value).replace(
					/"(reference:\d+)"/g,
					(whole, id: string) => JSON.stringify(ids.get(id) ?? id) ?? whole,
				),
			);

const outcome = (view: LedgerView, ended: readonly RunEnded[]) => ({
	ended: ended.map((end) => JSON.stringify(end)).sort(),
	inputs: Object.fromEntries(
		[...view.inbox, ...(view.active?.inputs ?? [])].map((input) => [
			input.inputId,
			input.state,
		]),
	),
	stop:
		view.active?.deadline?.owner === "Stop" ? view.active.deadline.at : null,
});

function run(
	implementation: LedgerImplementation<unknown, unknown>,
	trace: Trace,
	order: readonly number[],
	windowEnd: number,
	baseline?: Run,
): Run {
	let state = implementation.initialSessionLedgerState(
		"trace-session",
		trace.provider,
	);
	let serial = 0;
	const toRun = new Map<string, string>();
	const toTrace = new Map<string, string>();
	const rejected: number[] = [];
	const minted = new Map<number, readonly string[]>();
	const issued = new Map<number, readonly IssuedEffect[]>();
	const ended: RunEnded[] = [];
	const outcomes: unknown[] = [];
	let live = new Set<string>();
	for (const [position, index] of order.entries()) {
		const step = trace.steps[index];
		const now = trace.steps[position]?.now;
		assert(step && now !== undefined, `trace ${trace.id} has no step ${index}`);
		const ids: string[] = [];
		const decision = implementation.decide(state, rename(step.command, toRun), {
			now,
			policy,
			newId: () => {
				const id = `reference:${++serial}`;
				ids.push(id);
				return id;
			},
		});
		minted.set(index, ids);
		const expected = baseline?.minted.get(index) ?? ids;
		if (expected.length !== ids.length)
			return { rejected, minted, issued, outcomes, moved: index };
		for (const [n, id] of ids.entries()) {
			const original = expected[n] ?? id;
			toRun.set(original, id);
			toTrace.set(id, original);
		}
		if (decision.tag === "Rejected") rejected.push(index);
		else {
			state = decision.events.reduce(implementation.evolve, state);
			ended.push(...decision.ended);
			const view = implementation.viewLedger(state);
			const now = new Set(view.live.map((entry) => JSON.stringify(entry)));
			issued.set(index, [
				...decision.effects,
				...view.live.filter((entry) => !live.has(JSON.stringify(entry))),
			]);
			live = now;
		}
		if (position === windowEnd || position === order.length - 1)
			outcomes.push(
				rename(outcome(implementation.viewLedger(state), ended), toTrace),
			);
	}
	return { rejected: rejected.sort(), minted, issued, outcomes };
}

/** Every order of `window` that keeps each dependent pair in trace order, the trace order first. */
function orders(
	window: readonly number[],
	dependent: (a: number, b: number) => boolean,
): number[][] {
	const placeNext = (placed: number[], left: number[]): number[][] =>
		left.length === 0
			? [placed]
			: left
					.filter((candidate) =>
						left.every(
							(other) => other >= candidate || !dependent(other, candidate),
						),
					)
					.flatMap((next) =>
						placeNext(
							[...placed, next],
							left.filter((item) => item !== next),
						),
					);
	return placeNext([], [...window]);
}

interface Difference {
	readonly trace: string;
	readonly window: readonly number[];
	readonly order: readonly number[];
	readonly what: string;
}

function permutationGate(
	implementation: LedgerImplementation<unknown, unknown>,
	traces: readonly Trace[],
) {
	const differences: Difference[] = [];
	let permuted = 0;
	const perTrace: { id: string; steps: number; permuted: number }[] = [];
	let moved = 0;
	for (const trace of traces) {
		const before = permuted;
		const identity = trace.steps.map((_, index) => index);
		const reference = run(implementation, trace, identity, -1);
		// A fact shares every name its earlier steps gave any name it carries: a hold's result names
		// the Run its dispatch named.
		const byToken = new Map<string, Set<string>>();
		const names = trace.steps.map(({ command }, index) => {
			// A wake's turn_started names nothing either: a process runs one turn at a time, so a wake
			// only follows the end of whatever turn ran before it (gap P2).
			if (
				(command.verb === "settle" &&
					sessionWide.includes(command.settlement.kind)) ||
				(command.verb === "observe" &&
					command.observation.tag === "Unsolicited" &&
					command.observation.kind === "turn_started")
			)
				return new Set<string>();
			const own = namesOf(command);
			// A runner's newer label supersedes an older one (H1), so its unsolicited events keep
			// their order.
			if (
				command.verb === "observe" &&
				command.observation.tag === "Unsolicited"
			)
				own.add(`runner:${splitLabel(command.observation.label).runnerId}`);
			for (const id of reference.minted.get(index) ?? []) own.add(id);
			namesOf(reference.issued.get(index) ?? [], own);
			for (const name of own) {
				const shared = byToken.get(name);
				if (shared) for (const inherited of shared) own.add(inherited);
			}
			for (const name of own) byToken.set(name, own);
			return own;
		});
		// A session-wide fact names nothing, so it depends on every fact.
		const dependent = (a: number, b: number) => {
			const left = names[a] ?? new Set<string>();
			const right = names[b] ?? new Set<string>();
			return (
				left.size === 0 ||
				right.size === 0 ||
				[...left].some((name) => right.has(name))
			);
		};
		const windows: number[][] = [];
		for (const [index, step] of trace.steps.entries()) {
			const last = windows.at(-1);
			if (!isFact(step)) continue;
			if (last && last.at(-1) === index - 1 && last.length < windowSize)
				last.push(index);
			else windows.push([index]);
		}
		for (const window of windows.filter((item) => item.length > 1)) {
			const start = window[0] ?? 0;
			const end = start + window.length - 1;
			const baseline = run(implementation, trace, identity, end);
			for (const order of orders(window, dependent).slice(1)) {
				permuted++;
				const full = [
					...identity.slice(0, start),
					...order,
					...identity.slice(end + 1),
				];
				const permutedRun = run(implementation, trace, full, end, baseline);
				const report = (what: string) =>
					differences.push({ trace: trace.id, window, order, what });
				if (permutedRun.moved !== undefined) {
					moved++;
					report(`step ${permutedRun.moved} minted a different number of ids`);
				} else if (
					JSON.stringify(permutedRun.rejected) !==
					JSON.stringify(baseline.rejected)
				)
					report(
						`rejected ${JSON.stringify(permutedRun.rejected)}, trace order ${JSON.stringify(baseline.rejected)}`,
					);
				else
					for (const [n, at] of ["window end", "trace end"].entries())
						if (
							JSON.stringify(permutedRun.outcomes[n]) !==
							JSON.stringify(baseline.outcomes[n])
						)
							report(
								`${at}: ${JSON.stringify(permutedRun.outcomes[n])} against ${JSON.stringify(baseline.outcomes[n])}`,
							);
			}
		}
		perTrace.push({
			id: trace.id,
			steps: trace.steps.length,
			permuted: permuted - before,
		});
	}
	return { differences, permuted, moved, perTrace };
}

/**
 * Failure 4's plant: a result that arrives right after main's or a runner's own fact flips its Run's
 * outcome, so the Run's end depends on arrival order alone.
 */
type PlantedEntry =
	| { readonly tag: "inner"; readonly event: unknown }
	| { readonly tag: "requested"; readonly since: boolean };
const orderSensitive: LedgerImplementation<
	{ readonly inner: unknown; readonly requested: boolean },
	PlantedEntry
> = {
	initialSessionLedgerState: (sessionId, provider) => ({
		inner: referenceImplementation.initialSessionLedgerState(
			sessionId,
			provider,
		),
		requested: false,
	}),
	decide(state, command, ctx) {
		const observation =
			command.verb === "observe" ? command.observation : undefined;
		const result =
			observation?.tag === "Answer" && observation.kind === "result"
				? observation
				: undefined;
		const decision = referenceImplementation.decide(
			state.inner,
			result && state.requested
				? {
						verb: "observe",
						observation: {
							tag: "Answer",
							token: result.token,
							kind: "result",
							outcome:
								result.outcome === "interrupted" ? "completed" : "interrupted",
						},
					}
				: command,
			ctx,
		);
		if (decision.tag === "Rejected") return decision;
		const events = decision.events.map(
			(event): PlantedEntry => ({ tag: "inner", event }),
		);
		const requested = observation !== undefined && observation.tag !== "Answer";
		return {
			...decision,
			events: [...events, { tag: "requested", since: requested }],
		};
	},
	evolve: (state, entry) =>
		entry.tag === "inner"
			? {
					...state,
					inner: referenceImplementation.evolve(state.inner, entry.event),
				}
			: { ...state, requested: entry.since },
	viewLedger: (state) => referenceImplementation.viewLedger(state.inner),
};

/** Failure 5's check: a ledger that rejects a clock running backwards must pass the gate. */
const clockChecked: LedgerImplementation<
	{ readonly inner: unknown; readonly at: number },
	{ readonly inner: unknown } | { readonly at: number }
> = {
	initialSessionLedgerState: (sessionId, provider) => ({
		inner: referenceImplementation.initialSessionLedgerState(
			sessionId,
			provider,
		),
		at: 0,
	}),
	decide(state, command, ctx) {
		if (ctx.now < state.at)
			return { tag: "Rejected", diagnostic: `clock ran back to ${ctx.now}` };
		const decision = referenceImplementation.decide(state.inner, command, ctx);
		return decision.tag === "Rejected"
			? decision
			: {
					...decision,
					events: [
						...decision.events.map((inner) => ({ inner })),
						{ at: ctx.now },
					],
				};
	},
	evolve: (state, entry) =>
		"at" in entry
			? { ...state, at: entry.at }
			: {
					...state,
					inner: referenceImplementation.evolve(state.inner, entry.inner),
				},
	viewLedger: (state) => referenceImplementation.viewLedger(state.inner),
};

describe("Run Ledger arrival-order permutation gate (M9)", () => {
	const traces = allTraces();

	it.each(
		providers,
	)("%s: every order of up to 6 independent settlements gives the same Run ends, inputs and stop", (provider) => {
		const mine = traces.filter((trace) => trace.provider === provider);
		const result = permutationGate(referenceImplementation, mine);
		writeTraceArtifact(`permutations-${provider}`, {
			traces: mine.length,
			...result,
			steps: Object.fromEntries(
				mine
					.filter(({ id }) =>
						result.differences.some(({ trace }) => trace === id),
					)
					.map(({ id, steps }) => [id, steps]),
			),
		});
		expect(result.differences).toEqual([]);
		// Failure 2: a gate that permuted nothing proves nothing.
		expect(result.permuted).toBeGreaterThan(500);
	});

	it("keeps each position's time, so a ledger that rejects a backwards clock passes (failure 5)", () => {
		const result = permutationGate(
			clockChecked as LedgerImplementation<unknown, unknown>,
			traces,
		);
		expect(result.differences).toEqual([]);
	});

	it("fails a ledger whose Run end depends on arrival order (failure 4)", () => {
		const result = permutationGate(
			orderSensitive as LedgerImplementation<unknown, unknown>,
			traces,
		);
		expect(
			result.differences.some(({ what }) => what.startsWith("window end")),
		).toBe(true);
	});
});
