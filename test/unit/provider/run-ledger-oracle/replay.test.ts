/**
 * Every trace as Claude's and OpenCode's wire, and every catalogue trace replayed through main's
 * real stack with each call it makes answered (CONTRACT.md 3592, the 32.2.17 row).
 *
 * How it could fail, written before the code:
 * 1. The wire drops a fact: each trace's steps are checked one per fact, in order.
 * 2. A replay passes with nothing sent: a catalogue trace that admits an input must see main
 *    make at least one call a step answers.
 * 3. The unanswered check is never wired: dropping a trace's first send step must leave that
 *    send unanswered (the red check).
 */
import { describe, expect, it } from "vitest";
import { writeTraceArtifact } from "./harness.js";
import { replayTrace } from "./replay.js";
import { allTraces, catalogueTraces } from "./traces.js";
import { type WireProvider, wireSteps } from "./wire-frames.js";

const wired: readonly WireProvider[] = ["claude", "opencode"];

describe("Run ledger replay over provider wire frames", () => {
	it("turns every trace into each provider's wire, one step per fact", () => {
		const traces = allTraces();
		for (const trace of traces)
			for (const provider of wired)
				expect(
					wireSteps(trace, provider).map(({ fact }) => fact),
					`${trace.id} as ${provider}`,
				).toEqual(trace.steps.map((_, fact) => fact));
		expect(traces.length).toBeGreaterThan(32);
	});

	const catalogue = catalogueTraces().flatMap((trace) =>
		trace.provider === "claude" || trace.provider === "opencode"
			? [{ trace, provider: trace.provider }]
			: [],
	);

	it.each(
		catalogue.map((entry) => [entry.trace.id, entry] as const),
	)("%s replays through main's stack with no unanswered call", async (_id, {
		trace,
		provider,
	}) => {
		const result = await replayTrace(trace, provider);
		writeTraceArtifact(`replay-${trace.id}`, {
			trace: trace.id,
			provider,
			calls: result.calls.map(({ call, bound, fact }) => ({
				call,
				bound,
				fact,
			})),
			unanswered: result.unanswered,
			unmatched: result.unmatched,
			refusals: result.refusals,
			unwired: result.steps.flatMap((step) =>
				step.kind === "unwired" ? [{ fact: step.fact, what: step.what }] : [],
			),
		});
		expect(result.unanswered).toEqual([]);
		if (trace.steps.some(({ command }) => command.verb === "admit"))
			expect(result.calls.some(({ bound }) => bound)).toBe(true);
	});

	it.each(
		wired,
	)("%s: a dropped send step leaves main's send unanswered", async (provider) => {
		const trace = catalogue.find(
			(entry) =>
				entry.provider === provider &&
				wireSteps(entry.trace, provider).some((step) => step.kind === "call"),
		)?.trace;
		expect(trace).toBeDefined();
		if (trace === undefined) return;
		const first = wireSteps(trace, provider).find(
			(step) => step.kind === "call",
		);
		const result = await replayTrace(
			trace,
			provider,
			(step) => step.fact === first?.fact,
		);
		expect(result.unanswered).toContainEqual(
			first?.kind === "call" ? first.call : undefined,
		);
	});
});
