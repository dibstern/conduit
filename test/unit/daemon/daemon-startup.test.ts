import { InstanceMgmtTag } from "../../../src/lib/domain/daemon/Services/management-service.js";
// ─── Daemon Startup Effects Tests ──────────────────────────────────────────
// TDD tests for startup effect functions: crash counting, instance rehydration,
// and error isolation policy.

import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	type CrashCounter,
	CrashCounterTag,
	recordCrashCounter,
	rehydrateInstances,
} from "../../../src/lib/domain/daemon/Services/daemon-startup.js";
import {
	type DaemonInstanceConfig,
	makeDaemonStateLive,
} from "../../../src/lib/domain/daemon/Services/daemon-state.js";

import { OpenCodeConnectionError } from "../../../src/lib/errors.js";
import type { InstanceManagementDeps } from "../../../src/lib/handlers/types.js";

// ─── Mock helpers ──────────────────────────────────────────────────────────

function makeMockCrashCounter(overrides?: {
	record?: CrashCounter["record"];
	reset?: CrashCounter["reset"];
}): CrashCounter {
	return {
		record:
			overrides?.record ??
			vi.fn().mockReturnValue(Effect.succeed({ count: 1, shouldAbort: false })),
		reset: overrides?.reset ?? vi.fn().mockReturnValue(Effect.void),
	};
}

function makeMockInstanceMgmt(
	overrides?: Partial<{
		[K in keyof InstanceManagementDeps]: InstanceManagementDeps[K];
	}>,
): InstanceManagementDeps {
	return {
		getInstances: overrides?.getInstances ?? vi.fn().mockReturnValue([]),
		addInstance:
			overrides?.addInstance ??
			vi.fn().mockReturnValue({
				id: "test",
				name: "test",
				port: 4000,
				managed: true,
				status: "stopped",
				restartCount: 0,
				createdAt: Date.now(),
			}),
		removeInstance: overrides?.removeInstance ?? vi.fn(),
		startInstance:
			overrides?.startInstance ?? vi.fn().mockResolvedValue(undefined),
		stopInstance: overrides?.stopInstance ?? vi.fn(),
		updateInstance:
			overrides?.updateInstance ??
			vi.fn().mockReturnValue({
				id: "test",
				name: "test",
				port: 4000,
				managed: true,
				status: "stopped",
				restartCount: 0,
				createdAt: Date.now(),
			}),
		persistConfig: overrides?.persistConfig ?? vi.fn(),
	};
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("daemon startup effects", () => {
	describe("recordCrashCounter", () => {
		it.effect("records crash and proceeds when under limit", () =>
			Effect.gen(function* () {
				const result = yield* recordCrashCounter;

				expect(result).toBe(false);
			}).pipe(
				Effect.provide(
					Layer.succeed(
						CrashCounterTag,
						makeMockCrashCounter({
							record: () => Effect.succeed({ count: 1, shouldAbort: false }),
						}),
					),
				),
			),
		);

		it.effect("aborts when crash limit exceeded", () =>
			Effect.gen(function* () {
				const result = yield* recordCrashCounter;

				expect(result).toBe(true);
			}).pipe(
				Effect.provide(
					Layer.succeed(
						CrashCounterTag,
						makeMockCrashCounter({
							record: () => Effect.succeed({ count: 5, shouldAbort: true }),
						}),
					),
				),
			),
		);
	});

	describe("rehydrateInstances", () => {
		it.effect("restores instances from persisted state", () =>
			Effect.gen(function* () {
				const instances: DaemonInstanceConfig[] = [
					{
						id: "inst-1",
						name: "Instance 1",
						port: 4001,
						managed: true,
					},
					{
						id: "inst-2",
						name: "Instance 2",
						port: 4002,
						managed: false,
						url: "http://external:4002",
					},
				];

				const addInstance = vi.fn().mockReturnValue({
					id: "test",
					name: "test",
					port: 4000,
					managed: true,
					status: "stopped",
					restartCount: 0,
					createdAt: Date.now(),
				});

				const mockMgmt = makeMockInstanceMgmt({ addInstance });

				yield* rehydrateInstances.pipe(
					Effect.provide(
						Layer.mergeAll(
							makeDaemonStateLive({ instances }),
							Layer.succeed(InstanceMgmtTag, mockMgmt),
						),
					),
				);

				expect(addInstance).toHaveBeenCalledTimes(2);
				expect(addInstance).toHaveBeenCalledWith("inst-1", {
					name: "Instance 1",
					port: 4001,
					managed: true,
				});
				expect(addInstance).toHaveBeenCalledWith("inst-2", {
					name: "Instance 2",
					port: 4002,
					managed: false,
					url: "http://external:4002",
				});
			}),
		);
	});

	describe("error isolation", () => {
		it.effect("rehydrateInstances is non-fatal — logs and continues", () =>
			Effect.gen(function* () {
				const instances: DaemonInstanceConfig[] = [
					{
						id: "inst-bad",
						name: "Bad Instance",
						port: 4001,
						managed: true,
					},
					{
						id: "inst-good",
						name: "Good Instance",
						port: 4002,
						managed: true,
					},
				];

				const addInstance = vi.fn().mockImplementation((id: string) => {
					if (id === "inst-bad") {
						throw new OpenCodeConnectionError({
							message: "DB corrupt",
							cause: "DB corrupt",
						});
					}
					return {
						id,
						name: "Good Instance",
						port: 4002,
						managed: true,
						status: "stopped",
						restartCount: 0,
						createdAt: Date.now(),
					};
				});

				const mockMgmt = makeMockInstanceMgmt({ addInstance });

				// Should NOT throw — error isolation catches the tagged error
				yield* rehydrateInstances.pipe(
					Effect.provide(
						Layer.mergeAll(
							makeDaemonStateLive({ instances }),
							Layer.succeed(InstanceMgmtTag, mockMgmt),
						),
					),
				);

				// Both instances were attempted
				expect(addInstance).toHaveBeenCalledTimes(2);
			}),
		);
	});
});
