import { Effect, Exit, Layer, Option, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import { OpenCodeInstancesLive } from "../../../src/lib/domain/daemon/Layers/opencode-instances-layer.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { InstanceHealthCheckTag } from "../../../src/lib/domain/daemon/Services/instance-health-service.js";
import {
	getInstance,
	getPersistedInstanceConfigs,
	ManagedOpenCodeLifecycleTag,
	makeInstanceManagerStateLive,
	scheduleRestart,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { stopManagedOpenCode } from "../../../src/lib/instance/managed-opencode-process.js";

vi.mock(
	"../../../src/lib/instance/managed-opencode-process.js",
	async (original) => ({
		...(await original<
			typeof import("../../../src/lib/instance/managed-opencode-process.js")
		>()),
		stopManagedOpenCode: vi.fn(),
		isProcessAlive: vi.fn(() => true),
	}),
);

// Failure modes: restart exhaustion is mistaken for termination, a refused
// stop clears live work, or a failed start publishes the same false stop proof.
describe("managed OpenCode stop confirmation", () => {
	afterEach(() => vi.clearAllMocks());

	it("does not publish termination proof for an unregistered default alias", async () => {
		vi.mocked(stopManagedOpenCode).mockResolvedValue(false);
		const dependencies = Layer.mergeAll(
			makeInstanceManagerStateLive(undefined, [
				{
					id: "named-opencode",
					name: "Named OpenCode",
					port: 4310,
					managed: true,
					pid: 1234,
					processIdentity: {
						supervisorPid: 1233,
						controlPort: 4311,
						token: "a".repeat(64),
					},
				},
			]),
			DaemonEventBusLive,
			ConfigPersistenceNoopLive,
			Layer.succeed(InstanceHealthCheckTag, {
				check: () => Effect.succeed(true),
			}),
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const instances = yield* OpenCodeInstancesTag;
					yield* instances.stop("opencode");
					const event = Option.getOrThrow(
						yield* Stream.runHead(instances.events(["/project-a"])),
					);
					expect(event._tag).toBe("connection");
					if (event._tag !== "connection")
						throw new Error("Expected lifecycle replay");
					const record = (yield* getPersistedInstanceConfigs).find(
						({ id }) => id === "named-opencode",
					);
					expect(record?.processIdentity?.supervisorPid).toBe(1233);
					expect(event.managedStopped).toBeUndefined();
				}),
			).pipe(
				Effect.provide(
					OpenCodeInstancesLive.pipe(Layer.provideMerge(dependencies)),
				),
			),
		);
	});

	it("does not publish termination proof for an unverified live legacy PID", async () => {
		vi.mocked(stopManagedOpenCode).mockResolvedValue(false);
		const dependencies = Layer.mergeAll(
			makeInstanceManagerStateLive(undefined, [
				{
					id: "opencode",
					name: "Legacy OpenCode",
					port: 4310,
					managed: true,
					pid: 1234,
				},
			]),
			DaemonEventBusLive,
			ConfigPersistenceNoopLive,
			Layer.succeed(InstanceHealthCheckTag, {
				check: () => Effect.succeed(true),
			}),
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const instances = yield* OpenCodeInstancesTag;
					yield* instances.stop("opencode");
					const event = Option.getOrThrow(
						yield* Stream.runHead(instances.events(["/project-a"])),
					);
					expect(event._tag).toBe("connection");
					if (event._tag !== "connection")
						throw new Error("Expected lifecycle replay");
					expect(stopManagedOpenCode).toHaveBeenCalled();
					expect(event.managedStopped).toBeUndefined();
					const record = (yield* getPersistedInstanceConfigs).find(
						({ id }) => id === "opencode",
					);
					// Discarding unverified legacy metadata is not termination proof.
					expect(record?.pid).toBeUndefined();
				}),
			).pipe(
				Effect.provide(
					OpenCodeInstancesLive.pipe(Layer.provideMerge(dependencies)),
				),
			),
		);
	});

	it.each([
		{ operation: "stop", terminated: false },
		{ operation: "failed start", terminated: false },
		{ operation: "stop", terminated: true },
		{ operation: "failed start", terminated: true },
	])("publishes termination proof only after confirmed $operation (terminated=$terminated)", async ({
		operation,
		terminated,
	}) => {
		vi.mocked(stopManagedOpenCode).mockResolvedValue(terminated);
		const dependencies = Layer.mergeAll(
			makeInstanceManagerStateLive({ maxRestartsPerWindow: 0 }, [
				{
					id: "opencode",
					name: "Exhausted OpenCode",
					port: 4310,
					managed: true,
					pid: 1234,
					processIdentity: {
						supervisorPid: 1233,
						controlPort: 4311,
						token: "a".repeat(64),
					},
				},
			]),
			DaemonEventBusLive,
			ConfigPersistenceNoopLive,
			Layer.succeed(InstanceHealthCheckTag, {
				check: () => Effect.succeed(true),
			}),
		);
		const lifecycle = Layer.effect(
			ManagedOpenCodeLifecycleTag,
			Effect.map(
				Effect.context<Layer.Layer.Success<typeof dependencies>>(),
				(context) => ({
					start: () =>
						scheduleRestart("opencode").pipe(
							Effect.asVoid,
							Effect.provide(context),
						),
					withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
				}),
			),
		).pipe(Layer.provide(dependencies));
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const instances = yield* OpenCodeInstancesTag;
					yield* scheduleRestart("opencode");
					expect((yield* getInstance("opencode")).status).toBe("stopped");
					if (operation === "stop") yield* instances.stop("opencode");
					else {
						const started = yield* Effect.exit(
							Effect.scoped(instances.use("opencode")),
						);
						expect(Exit.isFailure(started)).toBe(true);
					}
					const replay = yield* Stream.runHead(
						instances.events(["/project-a"]),
					);
					const event = Option.getOrThrow(replay);
					expect(event._tag).toBe("connection");
					if (event._tag !== "connection")
						throw new Error("Expected lifecycle replay");
					expect(event.state).toBe(operation === "stop" ? "stopped" : "failed");
					expect(event.managedStopped).toBe(terminated ? true : undefined);
					expect(stopManagedOpenCode).toHaveBeenCalled();
					const record = (yield* getPersistedInstanceConfigs).find(
						({ id }) => id === "opencode",
					);
					expect(record?.processIdentity?.supervisorPid).toBe(
						terminated ? undefined : 1233,
					);
				}),
			).pipe(
				Effect.provide(
					OpenCodeInstancesLive.pipe(
						Layer.provideMerge(Layer.merge(dependencies, lifecycle)),
					),
				),
			),
		);
	});
});
