import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeContinuation } from "../../../../src/lib/domain/relay/Services/continuation.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";

// Failure modes and agreed seams are recorded in the account-switch report.
it("records one limit per user turn, closes only the cut-off on Dismiss, and clears recovery on a reply", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const store = yield* EventStoreEffectTag;
			const read = yield* ReadQueryEffectTag;
			const continuation = yield* makeContinuation;
			yield* commit([
				canonicalEvent("session.created", "s1", {
					sessionId: "s1",
					title: "Limited",
					provider: "account-1",
				}),
				canonicalEvent("message.created", "s1", {
					sessionId: "s1",
					messageId: "u1",
					role: "user",
				}),
			]);
			const signal = {
				instanceId: "account-1",
				rateLimitType: "seven_day",
				resetsAt: 1791234000,
				cutOffMessageId: "u1",
			};
			yield* Effect.all(
				[
					continuation.intakeLimit(
						canonicalEvent("session.usage_limited", "s1", signal, {
							provider: "claude",
						}),
					),
					continuation.intakeLimit(
						canonicalEvent("session.usage_limited", "s1", signal, {
							provider: "claude",
						}),
					),
				],
				{ concurrency: 2 },
			);
			const limits = () =>
				store
					.readAllBySession("s1")
					.pipe(
						Effect.map((events) =>
							events.filter((event) => event.type === "session.usage_limited"),
						),
					);
			expect(yield* limits()).toHaveLength(1);
			expect((yield* read.listSessionInfos())[0]?.limitRecovery).toEqual({
				...signal,
				rearms: 0,
				continued: false,
			});
			yield* continuation.dismissCutOff("s1");
			yield* continuation.dismissCutOff("s1");
			yield* continuation.dismissCutOff("missing");
			expect((yield* read.listSessionInfos())[0]?.limitRecovery).toEqual({
				instanceId: "account-1",
				rateLimitType: "seven_day",
				resetsAt: 1791234000,
				rearms: 0,
				continued: false,
			});
			expect(
				(yield* store.readAllBySession("s1")).filter(
					(event) => event.type === "session.cut_off_dismissed",
				),
			).toHaveLength(1);
			// A stale repeat after Dismiss must not re-open the cut-off.
			yield* continuation.intakeLimit(
				canonicalEvent("session.usage_limited", "s1", signal, {
					provider: "claude",
				}),
			);
			expect(yield* limits()).toHaveLength(1);
			// The same limit tuple is a new limit once a newer user turn exists.
			yield* commit([
				canonicalEvent("message.created", "s1", {
					sessionId: "s1",
					messageId: "u2",
					role: "user",
				}),
			]);
			yield* continuation.intakeLimit(
				canonicalEvent("session.usage_limited", "s1", signal, {
					provider: "claude",
				}),
			);
			yield* continuation.intakeLimit(
				canonicalEvent("session.usage_limited", "s1", signal, {
					provider: "claude",
				}),
			);
			expect(yield* limits()).toHaveLength(2);
			expect(
				(yield* read.listSessionInfos())[0]?.limitRecovery?.cutOffMessageId,
			).toBe("u1");
			yield* commit([
				canonicalEvent("message.created", "s1", {
					sessionId: "s1",
					messageId: "a2",
					role: "assistant",
				}),
			]);
			expect((yield* read.listSessionInfos())[0]?.limitRecovery).toBeNull();
			// A dismissed cut-off still leaves the strip until the session replies.
			yield* commit([
				canonicalEvent("message.created", "s1", {
					sessionId: "s1",
					messageId: "u3",
					role: "user",
				}),
			]);
			yield* continuation.intakeLimit(
				canonicalEvent(
					"session.usage_limited",
					"s1",
					{ ...signal, cutOffMessageId: "u3" },
					{ provider: "claude" },
				),
			);
			yield* continuation.dismissCutOff("s1");
			yield* commit([
				canonicalEvent("message.created", "s1", {
					sessionId: "s1",
					messageId: "a3",
					role: "assistant",
				}),
			]);
			expect((yield* read.listSessionInfos())[0]?.limitRecovery).toBeNull();
		}).pipe(Effect.provide(makePersistenceEffectLayer(":memory:"))),
	);
});
