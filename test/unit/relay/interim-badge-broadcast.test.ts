import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { expect, it, vi } from "vitest";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import { announceBackgroundWork } from "../../../src/lib/domain/relay/Services/session-attention.js";
import { makeSessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { subscribeShell } from "../../../src/lib/domain/relay/Services/shell-subscription.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
} from "../../helpers/mock-factories.js";

it("publishes task additions and removals from onChange without another event", async () => {
	const bus = makeSessionEventBusLive();
	const persistence = makePersistenceEffectLayer(
		":memory:",
		"test-project",
		undefined,
		bus,
	);
	const activity = await Effect.runPromise(makeSessionActivity);
	const onChange = vi.fn((sessionId: string) => {
		runtime.runFork(announceBackgroundWork(sessionId));
	});
	const liveness = activity.background;
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			bus,
			persistence,
			Layer.succeed(SessionActivityTag, activity),
			Layer.succeed(ConfigTag, makeMockConfig()),
			Layer.succeed(AccountDirectory, makeMockAccountDirectory()),
		),
	);
	try {
		runtime.runFork(
			Effect.scoped(
				Effect.flatMap(activity.subscribe, (changes) =>
					Stream.runForEach(changes, (sessionId) =>
						Effect.sync(() => onChange(sessionId)),
					),
				),
			),
		);
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
		const rows: SessionInfo[] = [];
		runtime.runFork(
			Stream.runForEach(subscribeShell(), (envelope) =>
				Effect.sync(() => {
					if (envelope._tag === "snapshot") rows.push(...envelope.rows);
					else if (envelope._tag === "upsert") rows.push(envelope.item);
				}),
			),
		);
		await expect.poll(() => rows.length, { timeout: 1000 }).toBe(1);
		expect(rows[0]).not.toHaveProperty("backgroundTasks");
		const a = {
			id: "a",
			type: "local_agent",
			description: "Audit auth",
			firstSeenAt: 100,
		};
		const b = {
			id: "b",
			type: "local_agent",
			description: "Review tests",
			firstSeenAt: 200,
		};
		liveness.record({ sessionId: "s1", kind: "snapshot", tasks: [a] });
		await expect.poll(() => rows.length, { timeout: 1000 }).toBe(2);
		expect(rows.at(-1)).toMatchObject({
			backgroundWork: "monitoring",
			backgroundTasks: [{ ...a, firstSeenAt: 100 }],
		});
		liveness.record({ sessionId: "s1", kind: "snapshot", tasks: [b, a] });
		await expect.poll(() => rows.length, { timeout: 1000 }).toBe(3);
		expect(rows.at(-1)).toMatchObject({
			backgroundWork: "monitoring",
			backgroundTasks: [
				{ ...a, firstSeenAt: 100 },
				{ ...b, firstSeenAt: 200 },
			],
		});
		liveness.record({ sessionId: "s1", kind: "snapshot", tasks: [b] });
		await expect.poll(() => rows.length, { timeout: 1000 }).toBe(4);
		expect(rows.at(-1)).toMatchObject({
			backgroundWork: "monitoring",
			backgroundTasks: [{ ...b, firstSeenAt: 200 }],
		});
		const reconnected = await runtime.runPromise(
			Stream.runHead(subscribeShell()),
		);
		expect(reconnected).toMatchObject({
			_tag: "Some",
			value: {
				_tag: "snapshot",
				rows: [{ backgroundTasks: [{ ...b, firstSeenAt: 200 }] }],
			},
		});
		liveness.record({ sessionId: "s1", kind: "snapshot", tasks: [{ ...b }] });
		expect(onChange).toHaveBeenCalledTimes(3);
		liveness.record({ sessionId: "s1", kind: "snapshot", tasks: [] });
		await expect.poll(() => rows.length, { timeout: 1000 }).toBe(5);
		expect(rows.at(-1)).toMatchObject({ attention: "idle" });
		expect(rows.at(-1)).not.toHaveProperty("backgroundTasks");
		expect(onChange).toHaveBeenCalledTimes(4);
	} finally {
		await runtime.dispose();
	}
});

it("publishes committed permission counts through the root subscription", async () => {
	const bus = makeSessionEventBusLive();
	const persistence = makePersistenceEffectLayer(
		":memory:",
		"test-project",
		undefined,
		bus,
	);
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			bus,
			persistence,
			Layer.effect(SessionActivityTag, makeSessionActivity),
			Layer.succeed(ConfigTag, makeMockConfig()),
			Layer.succeed(AccountDirectory, makeMockAccountDirectory()),
		),
	);
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
