import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { expect, it } from "vitest";
import { makeSessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { subscribeShell } from "../../../src/lib/domain/relay/Services/shell-subscription.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

it("publishes committed permission counts through the root subscription", async () => {
	const bus = makeSessionEventBusLive();
	const persistence = makePersistenceEffectLayer(":memory:", undefined, bus);
	const runtime = ManagedRuntime.make(Layer.merge(bus, persistence));
	try {
		await runtime.runPromise(
			Effect.flatMap(ProjectionRunnerEffectTag, (runner) => runner.recover()),
		);
		const commit = await runtime.runPromise(makeCommitAndSignal);
		await runtime.runPromise(
			commit([
				canonicalEvent(
					"session.created",
					"s1",
					{ sessionId: "s1", title: "session", provider: "claude" },
					{ provider: "claude" },
				),
			]),
		);
		const counts: Array<number | undefined> = [];
		runtime.runFork(
			Stream.runForEach(subscribeShell(), (envelope) =>
				Effect.sync(() => {
					if (envelope._tag === "snapshot") {
						counts.push(
							envelope.rows.find((row) => row.id === "s1")
								?.pendingPermissionCount,
						);
					} else if (envelope._tag === "upsert" && envelope.item.id === "s1") {
						counts.push(envelope.item.pendingPermissionCount);
					}
				}),
			),
		);
		await expect.poll(() => counts.length, { timeout: 700 }).toBeGreaterThan(0);
		await runtime.runPromise(
			commit([
				canonicalEvent(
					"permission.asked",
					"s1",
					{ id: "p1", sessionId: "s1", toolName: "bash", input: {} },
					{ provider: "claude" },
				),
			]),
		);
		await expect.poll(() => counts.includes(1), { timeout: 700 }).toBe(true);
		await runtime.runPromise(
			commit([
				canonicalEvent(
					"permission.resolved",
					"s1",
					{ id: "p1", decision: "once" },
					{ provider: "claude" },
				),
			]),
		);
		await expect.poll(() => counts.at(-1), { timeout: 700 }).toBeUndefined();
	} finally {
		await runtime.dispose();
	}
});
