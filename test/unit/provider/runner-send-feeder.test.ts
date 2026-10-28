import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Scheduler } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import {
	type RunnerCommandFailure,
	runnerFailure,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import type { RunRelease } from "../../../src/lib/provider/runner/runner-retirement.js";
import { makeRunnerSendFeeder } from "../../../src/lib/provider/runner/runner-send-feeder.js";

it.effect(
	"surfaces a defective item without a terminal and keeps serving the session",
	() =>
		Effect.gen(function* () {
			const settled = yield* Deferred.make<void>();
			const failures: string[] = [];
			const writes: string[] = [];
			const feeder = yield* makeRunnerSendFeeder({
				hold: (input) =>
					input.runId === "bad"
						? Effect.die("broken hold")
						: Effect.succeed({
								_tag: "Held" as const,
								runner: "runner",
								transmission: 1,
							}),
				start: () => Effect.void,
				release: () => Effect.void,
				failed: (input) =>
					Effect.sync(() => {
						failures.push(input.runId);
					}).pipe(Effect.andThen(Deferred.succeed(settled, undefined))),
				settled: (input) =>
					input.runId === "bad" ? Deferred.await(settled) : Effect.never,
			});
			const bad = yield* feeder
				.send({ sessionId: "s", runId: "bad", commandId: "bad" }, () =>
					Effect.die("bad item cannot transmit"),
				)
				.pipe(Effect.exit, Effect.forkChild);
			yield* TestClock.adjust(0);
			const good = yield* feeder
				.send({ sessionId: "s", runId: "good", commandId: "good" }, () =>
					Effect.sync(() => {
						writes.push("good");
						return undefined;
					}),
				)
				.pipe(Effect.forkChild);
			yield* TestClock.adjust(0);
			expect(failures).toEqual([]);
			expect(writes).toEqual(["good"]);
			expect(bad.pollUnsafe()).toMatchObject({
				_tag: "Success",
				value: { _tag: "Failure" },
			});
			expect(good.pollUnsafe()?._tag).toBe("Success");
		}).pipe(Effect.scoped),
);

for (const outcome of ["Covered", "Exhausted"] as const)
	it.effect(`retries a failed settlement observation after ${outcome}`, () =>
		Effect.gen(function* () {
			let reads = 0;
			const feeder = yield* makeRunnerSendFeeder({
				hold: () => Effect.succeed({ _tag: outcome }),
				start: () => Effect.void,
				release: () => Effect.void,
				failed: () => Effect.void,
				settled: () =>
					Effect.suspend(() =>
						++reads === 1
							? Effect.fail(runnerFailure("observe", "SQLITE_BUSY"))
							: Effect.void,
					),
			});
			const sending = yield* feeder
				.send({ sessionId: "s", runId: "r", commandId: "c" }, () =>
					Effect.die("settled runs cannot transmit"),
				)
				.pipe(Effect.forkChild);
			yield* TestClock.adjust("1 second");
			expect(reads).toBe(2);
			expect(sending.pollUnsafe()?._tag).toBe("Success");
		}).pipe(Effect.scoped),
	);

it.effect("backs off persistent hold failures instead of polling SQLite", () =>
	Effect.gen(function* () {
		let holds = 0;
		const feeder = yield* makeRunnerSendFeeder({
			hold: () =>
				Effect.suspend(() => {
					holds++;
					return Effect.fail({
						...runnerFailure("hold", "SQLITE_BUSY"),
						code: "StoreUnavailable",
					});
				}),
			start: () => Effect.void,
			release: () => Effect.void,
			failed: () => Effect.void,

			settled: () => Effect.never,
		});
		yield* feeder
			.send({ sessionId: "s", runId: "r", commandId: "c" }, () =>
				Effect.die("unheld sends cannot transmit"),
			)
			.pipe(Effect.forkChild);
		for (let tick = 0; tick < 20; tick++) yield* TestClock.adjust("150 millis");
		expect(holds).toBeGreaterThan(2);
		expect(holds).toBeLessThanOrEqual(6);
	}).pipe(Effect.scoped),
);

it.effect(
	"releases a committed hold when its caller is interrupted before transmission",
	() =>
		Effect.gen(function* () {
			const committed = yield* Deferred.make<void>();
			const reply = yield* Deferred.make<void>();
			const proofs: RunRelease[] = [];
			let writes = 0;
			const input = { sessionId: "s", runId: "r", commandId: "c" };
			const feeder = yield* makeRunnerSendFeeder({
				hold: () =>
					Deferred.succeed(committed, undefined).pipe(
						Effect.andThen(Deferred.await(reply)),
						Effect.as({
							_tag: "Held" as const,
							runner: "runner",
							transmission: 1,
						}),
					),
				start: () => Effect.void,
				release: (proof) =>
					Effect.sync(() => {
						proofs.push(proof);
					}),
				failed: () => Effect.void,
				settled: () => Effect.never,
			});
			const sending = yield* feeder
				.send(input, () =>
					Effect.sync(() => {
						writes++;
						return undefined;
					}),
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(committed);
			yield* TestClock.adjust(0);
			yield* Fiber.interrupt(sending);
			yield* Deferred.succeed(reply, undefined);
			yield* TestClock.adjust(0);
			expect(writes).toBe(0);
			expect(proofs).toEqual([
				{ ...input, runnerId: "runner", transmission: 1, reason: "NotSent" },
			]);
		}).pipe(Effect.scoped),
);

it.effect("retries a failed hold without reporting a transient outcome", () =>
	Effect.gen(function* () {
		const failed = yield* Deferred.make<void>();
		let holds = 0;
		let writes = 0;
		const feeder = yield* makeRunnerSendFeeder({
			hold: () =>
				Effect.gen(function* () {
					holds++;
					if (holds === 1) {
						yield* Deferred.succeed(failed, undefined);
						return yield* Effect.fail({
							...runnerFailure("hold", "SQLITE_BUSY"),
							code: "StoreUnavailable",
						});
					}
					return { _tag: "Held" as const, runner: "runner", transmission: 1 };
				}),
			start: () => Effect.void,
			release: () => Effect.void,
			failed: () => Effect.void,

			settled: () => Effect.never,
		});
		const sending = yield* feeder
			.send({ sessionId: "s", runId: "r", commandId: "c" }, () =>
				Effect.sync(() => {
					writes++;
					return undefined;
				}),
			)
			.pipe(Effect.result, Effect.forkChild);
		yield* Deferred.await(failed);
		yield* TestClock.adjust(0);
		expect(sending.pollUnsafe()).toBeUndefined();
		expect(writes).toBe(0);
		yield* TestClock.adjust("150 millis");
		expect((yield* Fiber.join(sending))._tag).toBe("Success");
		expect({ holds, writes }).toEqual({ holds: 2, writes: 1 });
	}).pipe(Effect.scoped),
);

it.effect(
	"continues the same send after an interrupted caller releases its unwritten hold",
	() =>
		Effect.gen(function* () {
			const committed = yield* Deferred.make<void>();
			const reply = yield* Deferred.make<void>();
			const delivered = yield* Deferred.make<void>();
			const proofs: RunRelease[] = [];
			let holds = 0;
			let writes = 0;
			let restored = 0;
			const input = { sessionId: "s", runId: "r", commandId: "c" };
			let acknowledge: (input: RunRelease) => Effect.Effect<void> = () =>
				Effect.void;
			let restore: () => Effect.Effect<void> = () => Effect.void;
			const options = {
				failed: () => Effect.void,
				hold: () =>
					Effect.gen(function* () {
						holds++;
						if (holds === 1) {
							yield* Deferred.succeed(committed, undefined);
							yield* Deferred.await(reply);
						}
						return {
							_tag: "Held" as const,
							runner: "runner",
							transmission: holds,
						};
					}),
				start: () => Effect.void,
				release: (proof: RunRelease) =>
					Effect.sync(() => {
						proofs.push(proof);
					}).pipe(Effect.andThen(acknowledge(proof))),

				settled: () => Effect.never,
				restore: () =>
					Effect.sync(() => {
						restored++;
					}).pipe(Effect.andThen(Effect.suspend(restore))),
			};
			const feeder = yield* makeRunnerSendFeeder(options);
			acknowledge = feeder.released;
			restore = () =>
				feeder
					.send(input, () =>
						Effect.sync(() => {
							writes++;
							return undefined;
						}).pipe(
							Effect.andThen(Deferred.succeed(delivered, undefined)),
							Effect.as(undefined),
						),
					)
					.pipe(Effect.asVoid, Effect.orDie);
			const sending = yield* feeder
				.send(input, () => Effect.die("The interrupted caller cannot transmit"))
				.pipe(Effect.forkChild);
			yield* Deferred.await(committed);
			yield* TestClock.adjust(0);
			yield* Fiber.interrupt(sending);
			yield* Deferred.succeed(reply, undefined);
			yield* TestClock.adjust(0);
			expect({ holds, writes, restored }).toEqual({
				holds: 2,
				writes: 1,
				restored: 1,
			});
			expect(Deferred.isDoneUnsafe(delivered)).toBe(true);
			expect(proofs).toEqual([
				{ ...input, runnerId: "runner", transmission: 1, reason: "NotSent" },
			]);
		}).pipe(Effect.scoped),
);

it.effect("restores a released adopted send that has no live caller", () =>
	Effect.gen(function* () {
		let holds = 0;
		let writes = 0;
		let restore: () => Effect.Effect<void> = () => Effect.void;
		const input = { sessionId: "s", runId: "r", commandId: "c" };
		const feeder = yield* makeRunnerSendFeeder({
			hold: () =>
				Effect.sync(() => {
					holds++;
					return {
						_tag: "Held" as const,
						runner: "replacement",
						transmission: 2,
					};
				}),
			start: () => Effect.void,
			release: () => Effect.void,
			failed: () => Effect.void,

			settled: () => Effect.never,
			restore: () => Effect.suspend(restore),
		});
		restore = () =>
			feeder
				.send(input, () =>
					Effect.sync(() => {
						writes++;
						return undefined;
					}),
				)
				.pipe(Effect.asVoid, Effect.orDie);
		yield* feeder.released({
			...input,
			runnerId: "adopted",
			transmission: 1,
			reason: "NotSent",
		});
		yield* TestClock.adjust(0);
		expect({ holds, writes }).toEqual({ holds: 1, writes: 1 });
	}).pipe(Effect.scoped),
);

it.effect(
	"settles StartLost once when start returns without a serving runner",
	() =>
		Effect.gen(function* () {
			let holds = 0;
			let starts = 0;
			const failures: string[] = [];
			const settled = yield* Deferred.make<void>();
			const feeder = yield* makeRunnerSendFeeder({
				hold: () =>
					Effect.sync(() => {
						holds++;
						return { _tag: "Unserved" as const };
					}),
				start: () =>
					Effect.sync(() => {
						starts++;
					}),
				release: () => Effect.void,
				failed: (_input, failure) =>
					Effect.sync(() => {
						failures.push(String(failure.code));
					}).pipe(Effect.andThen(Deferred.succeed(settled, undefined))),
				settled: () => Deferred.await(settled),
			});
			const sending = yield* feeder
				.send({ sessionId: "s", runId: "r", commandId: "c" }, () =>
					Effect.die("unheld send cannot transmit"),
				)
				.pipe(Effect.forkChild);
			yield* TestClock.adjust(0);
			yield* Fiber.join(sending);
			yield* TestClock.adjust("30 seconds");
			expect({ holds, starts, failures }).toEqual({
				holds: 2,
				starts: 1,
				failures: ["runner_start_lost"],
			});
		}).pipe(Effect.scoped),
);

it.effect("never loses a session wakeup when enqueues race an empty pump", () =>
	Effect.gen(function* () {
		for (let budget = 8; budget <= 96; budget++) {
			yield* Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const held: string[] = [];
				const feeder = yield* makeRunnerSendFeeder({
					hold: (input) =>
						Effect.sync(() => {
							held.push(input.runId);
							if (input.runId === "first")
								Deferred.doneUnsafe(entered, Effect.void);
							return {
								_tag: "Held" as const,
								runner: "runner",
								transmission: 1,
							};
						}),
					start: () => Effect.void,
					release: () => Effect.void,
					failed: () => Effect.void,

					settled: () => Effect.never,
				}).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget));
				const first = yield* feeder
					.send({ sessionId: "s", runId: "first", commandId: "first" }, () =>
						Effect.succeed(undefined),
					)
					.pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				const second = yield* feeder
					.send({ sessionId: "s", runId: "second", commandId: "second" }, () =>
						Effect.succeed(undefined),
					)
					.pipe(Effect.forkChild);
				yield* TestClock.adjust(0);
				yield* Fiber.join(second);
				expect(held, `scheduler budget ${budget}`).toEqual(["first", "second"]);
				yield* Fiber.join(first);
				yield* Fiber.join(second);
			}).pipe(Effect.scoped);
		}
	}).pipe(Effect.scoped),
);

// A transport failure is not a run outcome. Only a committed release re-drives it.
it.effect(
	"keeps a failed write held until release, then delivers once on its successor",
	() =>
		Effect.gen(function* () {
			const terminal = yield* Deferred.make<void>();
			const failedWrite = yield* Deferred.make<void>();
			const successor = yield* Deferred.make<void>();
			let holds = 0;
			const delivered: number[] = [];
			const feeder = yield* makeRunnerSendFeeder({
				hold: () =>
					Effect.sync(() => ({
						_tag: "Held" as const,
						runner: holds++ === 0 ? "old" : "new",
						transmission: holds,
					})),
				start: () => Effect.void,
				release: () => Effect.void,
				failed: () => Effect.void,
				settled: () => Deferred.await(terminal),
			});
			const input = { sessionId: "s", runId: "r", commandId: "c" };
			const sending = yield* feeder
				.send(input, (hold) =>
					hold.runner === "old"
						? Deferred.succeed(failedWrite, undefined).pipe(
								Effect.andThen(
									Effect.fail(runnerFailure("write runner", "closed")),
								),
							)
						: Effect.sync(() => {
								delivered.push(hold.transmission);
							}).pipe(
								Effect.andThen(Deferred.succeed(successor, undefined)),
								Effect.as(undefined),
							),
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(failedWrite);
			yield* Effect.yieldNow;
			expect(holds).toBe(1);
			expect(sending.pollUnsafe()).toBeUndefined();
			yield* feeder.released({
				...input,
				runnerId: "old",
				transmission: 1,
				reason: "JournalAbsent",
			});
			yield* Deferred.await(successor);
			yield* Fiber.join(sending);
			expect(delivered).toEqual([2]);
			yield* Deferred.succeed(terminal, undefined);
		}).pipe(Effect.scoped),
);

it.effect(
	"completes covered and exhausted sends only after ledger observation closes their handles",
	() =>
		Effect.gen(function* () {
			for (const outcome of ["Covered", "Exhausted"] as const) {
				let starts = 0;
				let writes = 0;
				const checked = yield* Deferred.make<void>();
				const terminal = yield* Deferred.make<void>();
				let closed = false;
				const feeder = yield* makeRunnerSendFeeder({
					hold: () =>
						Deferred.succeed(checked, undefined).pipe(
							Effect.as({ _tag: outcome }),
						),
					start: () =>
						Effect.sync(() => {
							starts++;
						}),
					release: () => Effect.void,
					failed: () => Effect.void,
					settled: () =>
						Deferred.await(terminal).pipe(
							Effect.andThen(
								Effect.sync(() => {
									closed = true;
								}),
							),
						),
				});
				const sending = yield* feeder
					.send({ sessionId: "s", runId: outcome, commandId: outcome }, () =>
						Effect.sync(() => {
							writes++;
							return undefined;
						}),
					)
					.pipe(Effect.forkChild);
				yield* Deferred.await(checked);
				yield* Effect.yieldNow;
				expect(sending.pollUnsafe()).toBeUndefined();
				yield* Deferred.succeed(terminal, undefined);
				yield* Fiber.join(sending);
				expect(closed).toBe(true);
				expect({ starts, writes }).toEqual({ starts: 0, writes: 0 });
			}
		}).pipe(Effect.scoped),
);

it.effect(
	"a covered held send rechecks coverage after its holder releases it",
	() =>
		Effect.gen(function* () {
			const firstGate = yield* Deferred.make<void>();
			const terminal = yield* Deferred.make<void>();
			let holds = 0;
			const feeder = yield* makeRunnerSendFeeder({
				hold: () =>
					Effect.gen(function* () {
						holds++;
						if (holds === 1) yield* Deferred.succeed(firstGate, undefined);
						else yield* Deferred.succeed(terminal, undefined);
						return { _tag: "Covered" as const };
					}),
				start: () => Effect.die("Covered sends never start a runner"),
				release: () => Effect.void,
				failed: () => Effect.void,
				settled: () => Deferred.await(terminal),
			});
			const input = { sessionId: "s", runId: "r", commandId: "c" };
			const sending = yield* feeder
				.send(input, () => Effect.die("Covered sends never transmit"))
				.pipe(Effect.forkChild);
			yield* Deferred.await(firstGate);
			yield* feeder.released({
				...input,
				runnerId: "holder",
				transmission: 1,
				reason: "NotSent",
			});
			yield* Effect.yieldNow;
			expect(holds).toBe(2);
			yield* Fiber.join(sending);
		}).pipe(Effect.scoped),
);

it.effect(
	"a committed release racing the hold reply never writes the released transmission",
	() =>
		Effect.gen(function* () {
			const committed = yield* Deferred.make<void>();
			const reply = yield* Deferred.make<void>();
			let holds = 0;
			const writes: string[] = [];
			const feeder = yield* makeRunnerSendFeeder({
				hold: () =>
					Effect.gen(function* () {
						holds++;
						if (holds === 1) {
							yield* Deferred.succeed(committed, undefined);
							yield* Deferred.await(reply);
							return { _tag: "Held" as const, runner: "old", transmission: 1 };
						}
						return { _tag: "Held" as const, runner: "new", transmission: 2 };
					}),
				start: () => Effect.void,
				release: () => Effect.void,
				failed: () => Effect.void,

				settled: () => Effect.never,
			});
			const input = { sessionId: "s", runId: "r", commandId: "c" };
			const sending = yield* feeder
				.send(input, (hold) =>
					Effect.sync(() => {
						writes.push(hold.runner);
						return undefined;
					}),
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(committed);
			yield* feeder.released({
				...input,
				runnerId: "old",
				transmission: 1,
				reason: "JournalAbsent",
			});
			yield* Deferred.succeed(reply, undefined);
			yield* Fiber.join(sending);
			expect(writes).toEqual(["new"]);
			expect(holds).toBe(2);
		}).pipe(Effect.scoped),
);

for (const evidence of [
	"Refused",
	"NotSent",
	"resume-result",
	"resume-failure",
] as const)
	it.effect(`retains ${evidence} release evidence across a failed commit`, () =>
		Effect.gen(function* () {
			const failedCommit = yield* Deferred.make<void>();
			const proofs: RunRelease[] = [];
			let holds = 0;
			let delivered = 0;
			let acknowledge: (input: RunRelease) => Effect.Effect<void> = () =>
				Effect.void;
			const feeder = yield* makeRunnerSendFeeder({
				hold: () =>
					Effect.sync(() => ({
						_tag: "Held" as const,
						runner: ++holds === 1 ? "old" : "new",
						transmission: holds,
					})),
				start: () => Effect.void,
				release: (proof) =>
					Effect.gen(function* () {
						proofs.push(proof);
						if (proofs.length === 1) {
							yield* Deferred.succeed(failedCommit, undefined);
							return yield* Effect.fail(
								runnerFailure("release", "database unavailable"),
							);
						}
						yield* acknowledge(proof);
					}),
				failed: () => Effect.void,
				settled: () => Effect.never,
			});
			acknowledge = feeder.released;
			const input = { sessionId: "s", runId: "r", commandId: "c" };
			const result = {
				status: "completed" as const,
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [],
			};
			const native = evidence.startsWith("resume");
			const sending = yield* feeder
				.send(input, (hold) => {
					if (hold.runner === "new")
						return Effect.sync(() => {
							delivered++;
							return result;
						});
					if (evidence === "resume-result")
						return Effect.succeed({
							...result,
							status: "error" as const,
							nativeResumeRejected: true,
						});
					if (evidence === "resume-failure")
						return Effect.fail<RunnerCommandFailure>({
							...runnerFailure("native resume", "refused before input"),
							code: "claude_resume_refused",
							replied: true,
						});
					return Effect.fail<RunnerCommandFailure>({
						...runnerFailure("delivery proof", evidence),
						delivery:
							evidence === "Refused"
								? { _tag: "Refused", reason: "exiting" }
								: { _tag: "NotSent" },
					});
				})
				.pipe(Effect.result, Effect.forkChild);
			yield* Deferred.await(failedCommit);
			yield* Effect.yieldNow;
			expect(sending.pollUnsafe()).toBeUndefined();
			expect(holds).toBe(1);
			yield* TestClock.adjust("150 millis");
			expect(proofs).toHaveLength(2);
			expect(proofs[1]).toEqual(proofs[0]);
			const completed = yield* Fiber.join(sending);
			if (native) {
				expect(completed._tag).toBe(
					evidence === "resume-failure" ? "Failure" : "Success",
				);
				yield* feeder.send({ ...input, nativeResumeFallback: true }, () =>
					Effect.sync(() => {
						delivered++;
						return result;
					}),
				);
			}
			expect(delivered).toBe(1);
			expect(holds).toBe(2);
		}).pipe(Effect.scoped),
	);
