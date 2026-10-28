import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { expect } from "vitest";
import {
	makeRunnerUpgrade,
	type RunnerUpgrade,
} from "../../../src/lib/provider/runner/runner-upgrade.js";

it.effect("rewarms when eligibility returns during replacement cleanup", () =>
	Effect.gen(function* () {
		type Runner = { id: number; upgrade: RunnerUpgrade };
		const entered = yield* Deferred.make<void>();
		const release = yield* Deferred.make<void>();
		const pending: Effect.Effect<void>[] = [];
		const fibers: Fiber.Fiber<void>[] = [];
		const warmed: number[] = [];
		const committed: number[] = [];
		const cancelled: number[] = [];
		const failures: unknown[] = [];
		const observed: {
			eligible: boolean;
			inFlight: boolean;
			activity: number;
		}[] = [];
		let eligible = true;
		let cleanupHeld = false;
		let created = 0;
		const old: Runner = {
			id: 0,
			upgrade: { activity: 7, inFlight: false, failures: 0, retryAt: 0 },
		};
		const consider = makeRunnerUpgrade<Runner>({
			eligible: (_, runner) => {
				if (cleanupHeld)
					observed.push({
						eligible,
						inFlight: runner.upgrade.inFlight,
						activity: runner.upgrade.activity,
					});
				return eligible;
			},
			create: () =>
				Effect.sync(() => ({
					id: ++created,
					upgrade: { activity: 0, inFlight: false, failures: 0, retryAt: 0 },
				})),
			warm: (_, __, replacement) =>
				Effect.sync(() => {
					warmed.push(replacement.id);
					if (replacement.id === 1) eligible = false;
				}),
			commit: (_, __, replacement) =>
				Effect.sync(() => {
					if (eligible) committed.push(replacement.id);
					return eligible;
				}),
			stop: () =>
				Effect.gen(function* () {
					cleanupHeld = true;
					yield* Deferred.succeed(entered, undefined);
					yield* Deferred.await(release);
					cleanupHeld = false;
				}),
			runFork: (effect) => pending.push(effect),
			failed: (_, __, cause) => failures.push(cause),
			cancelled: (_, __, replacement) => cancelled.push(replacement.id),
		});
		yield* Effect.gen(function* () {
			consider("session", old);
			const first = pending.shift();
			if (!first) throw new Error("First upgrade was not scheduled");
			const fiber = yield* Effect.forkChild(first);
			fibers.push(fiber);
			yield* Deferred.await(entered);
			expect(warmed).toEqual([1]);
			expect(committed).toHaveLength(0);
			expect(cancelled).toEqual([1]);
			expect(cleanupHeld).toBe(true);
			expect(Deferred.isDoneUnsafe(release)).toBe(false);
			eligible = true;
			consider("session", old);
			expect(observed).toEqual([
				{ eligible: true, inFlight: true, activity: 7 },
			]);
			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(fiber);
			expect(cleanupHeld).toBe(false);
			expect(pending).toHaveLength(1);
			const second = pending.shift();
			if (!second) throw new Error("Eligible observation was not reconsidered");
			yield* second;
			expect(warmed).toEqual([1, 2]);
			expect(committed).toEqual([2]);
			expect(cancelled).toEqual([1]);
			expect(failures).toHaveLength(0);
			expect(old.upgrade.activity).toBe(7);
			expect(old.upgrade.inFlight).toBe(false);
			expect(pending).toHaveLength(0);
			expect(fibers.every((owned) => owned.pollUnsafe() !== undefined)).toBe(
				true,
			);
		}).pipe(
			Effect.ensuring(
				Effect.gen(function* () {
					eligible = false;
					yield* Deferred.succeed(release, undefined);
					yield* Deferred.succeed(entered, undefined);
					yield* Fiber.interruptAll(fibers);
					const pendingBeforeCleanup = pending.length;
					pending.length = 0;
					console.log(
						JSON.stringify({
							case: "runner-upgrade-overlap",
							observed,
							warmed,
							committed,
							cancelled,
							failures: failures.map(String),
							pendingBeforeCleanup,
							ownedFibersDone: fibers.every(
								(fiber) => fiber.pollUnsafe() !== undefined,
							),
						}),
					);
				}),
			),
		);
	}),
);
