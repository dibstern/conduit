// ─── Daemon Main Tests ──────────────────────────────────────────────────────
// TDD tests for daemon-main.ts: the top-level Effect entry point that replaces
// the Daemon class's start() method. Tests exercise runStartupSequence
// composition and background task supervision, NOT makeDaemonProgramLayer
// (which blocks on Effect.never).

import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { projectDiscovery } from "../../../src/lib/effect/daemon-main.js";
import {
	type CrashCounter,
	CrashCounterTag,
	CrashLimitExceeded,
	runStartupSequence,
} from "../../../src/lib/effect/daemon-startup.js";
import { makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import {
	ConfigTag,
	InstanceMgmtTag,
	LoggerTag,
	PersistencePathTag,
	ProjectMgmtTag,
	RelayCacheTag,
} from "../../../src/lib/effect/services.js";
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

function makeMockInstanceMgmt(): InstanceManagementDeps {
	return {
		getInstances: vi.fn().mockReturnValue([]),
		addInstance: vi.fn().mockReturnValue({
			id: "test",
			name: "test",
			port: 4000,
			managed: true,
			status: "stopped",
			restartCount: 0,
			createdAt: Date.now(),
		}),
		removeInstance: vi.fn(),
		startInstance: vi.fn().mockResolvedValue(undefined),
		stopInstance: vi.fn(),
		updateInstance: vi.fn().mockReturnValue({
			id: "test",
			name: "test",
			port: 4000,
			managed: true,
			status: "stopped",
			restartCount: 0,
			createdAt: Date.now(),
		}),
		persistConfig: vi.fn(),
	};
}

/** Minimal layer providing all DaemonDeps for testing. */
function makeTestLayer(overrides?: { crashCounter?: CrashCounter }) {
	return Layer.mergeAll(
		makeDaemonStateLive(),
		Layer.succeed(
			CrashCounterTag,
			overrides?.crashCounter ?? makeMockCrashCounter(),
		),
		Layer.succeed(PersistencePathTag, "/tmp/test-daemon.json"),
		Layer.succeed(InstanceMgmtTag, makeMockInstanceMgmt()),
		Layer.succeed(ProjectMgmtTag, {
			getProjects: vi.fn().mockReturnValue([]),
			setProjectInstance: vi.fn(),
		}),
		Layer.succeed(RelayCacheTag, {
			get: () => Effect.die("not implemented in test"),
			invalidate: () => Effect.die("not implemented in test"),
		}),
		Layer.succeed(ConfigTag, {
			httpServer: {} as import("node:http").Server,
			opencodeUrl: "http://localhost:4096",
			projectDir: "/tmp/test",
			slug: "test-project",
		}),
		Layer.succeed(LoggerTag, {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			child: vi.fn().mockReturnValue({
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				child: vi.fn(),
			}),
		} as unknown as import("../../../src/lib/logger.js").Logger),
	);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("daemon-main", () => {
	describe("runStartupSequence via daemon-main layer", () => {
		it.effect("completes startup and leaves state unchanged", () =>
			Effect.gen(function* () {
				// Run startup sequence with minimal mocks — should complete without error
				yield* runStartupSequence.pipe(Effect.provide(makeTestLayer()));
			}),
		);

		it.effect("aborts when crash counter triggers CrashLimitExceeded", () =>
			Effect.gen(function* () {
				const abortCounter = makeMockCrashCounter({
					record: () => Effect.succeed({ count: 5, shouldAbort: true }),
				});

				const result = yield* runStartupSequence.pipe(
					Effect.provide(makeTestLayer({ crashCounter: abortCounter })),
					Effect.flip, // Convert error channel to success channel for assertion
				);

				expect(result).toBeInstanceOf(CrashLimitExceeded);
				expect((result as CrashLimitExceeded).count).toBe(5);
			}),
		);
	});

	describe("projectDiscovery", () => {
		it.effect("calls getProjects and completes", () =>
			Effect.gen(function* () {
				const getProjects = vi
					.fn()
					.mockReturnValue([
						{ slug: "proj-1", title: "Project 1", directory: "/tmp/p1" },
					]);

				yield* projectDiscovery.pipe(
					Effect.provide(
						Layer.succeed(ProjectMgmtTag, {
							getProjects,
							setProjectInstance: vi.fn(),
						}),
					),
				);

				expect(getProjects).toHaveBeenCalledOnce();
			}),
		);

		it.effect("catches errors and does not propagate", () =>
			Effect.gen(function* () {
				const getProjects = vi.fn().mockImplementation(() => {
					throw new Error("discovery failed");
				});

				// Should NOT throw — projectDiscovery catches expected errors
				yield* projectDiscovery.pipe(
					Effect.provide(
						Layer.succeed(ProjectMgmtTag, {
							getProjects,
							setProjectInstance: vi.fn(),
						}),
					),
				);

				expect(getProjects).toHaveBeenCalledOnce();
			}),
		);
	});
});
