// ─── IPC Dispatch Tests ──────────────────────────────────────────────────────
// Verify that decodeAndDispatch correctly routes commands and handles errors.

import { FileSystem } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { PersistencePathTag } from "../../../src/lib/effect/daemon-config-persistence.js";
import type { DaemonState } from "../../../src/lib/effect/daemon-state.js";
import { makeDaemonStateLive } from "../../../src/lib/effect/daemon-state.js";
import { decodeAndDispatch } from "../../../src/lib/effect/ipc-dispatch.js";
import {
	InstanceMgmtTag,
	ProjectMgmtTag,
	SessionOverridesTag,
} from "../../../src/lib/effect/services.js";
import { SessionOverrides } from "../../../src/lib/session/session-overrides.js";

// ─── In-memory test FileSystem ────────────────────────────────────────────────

const makeTestFileSystem = () => {
	const files = new Map<string, string>();

	const fs: FileSystem.FileSystem = FileSystem.makeNoop({
		readFileString: (path: string) =>
			Effect.gen(function* () {
				const content = files.get(path);
				if (content === undefined) {
					return yield* Effect.fail(
						new SystemError({
							reason: "NotFound",
							module: "FileSystem",
							method: "readFileString",
							description: `File not found: ${path}`,
							pathOrDescriptor: path,
						}),
					);
				}
				return content;
			}),
		writeFileString: (path: string, data: string) =>
			Effect.sync(() => {
				files.set(path, data);
			}),
		rename: (oldPath: string, newPath: string) =>
			Effect.sync(() => {
				const content = files.get(oldPath);
				if (content !== undefined) {
					files.set(newPath, content);
					files.delete(oldPath);
				}
			}),
		makeDirectory: () => Effect.void,
	});

	return { files, layer: Layer.succeed(FileSystem.FileSystem, fs) };
};

// ─── Mock factories ──────────────────────────────────────────────────────────

const CONFIG_PATH = "/test-config/daemon.json";

const makeTestLayers = (stateOverrides?: Partial<DaemonState>) => {
	const testFs = makeTestFileSystem();
	return Layer.mergeAll(
		testFs.layer,
		Layer.succeed(PersistencePathTag, CONFIG_PATH),
		makeDaemonStateLive(stateOverrides),
		Layer.succeed(ProjectMgmtTag, {
			getProjects: () => [
				{ slug: "proj-1", title: "Project 1", directory: "/home/proj-1" },
			],
			setProjectInstance: () => {},
		}),
		Layer.succeed(InstanceMgmtTag, {
			getInstances: () => [
				{
					id: "inst-1",
					name: "Dev",
					port: 4096,
					managed: true,
					status: "healthy" as const,
					restartCount: 0,
					createdAt: Date.now(),
				},
			],
			addInstance: (id, config) => ({
				id,
				...config,
				status: "stopped" as const,
				restartCount: 0,
				createdAt: Date.now(),
			}),
			removeInstance: () => {},
			startInstance: () => Promise.resolve(),
			stopInstance: () => {},
			updateInstance: (id, updates) => ({
				id,
				name: updates.name ?? "Updated",
				port: updates.port ?? 4096,
				managed: true,
				status: "healthy" as const,
				restartCount: 0,
				createdAt: Date.now(),
			}),
			persistConfig: () => {},
		}),
		Layer.succeed(SessionOverridesTag, new SessionOverrides()),
	);
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("IPC dispatch", () => {
	it.effect("dispatches valid add_project command", () =>
		Effect.gen(function* () {
			const raw = JSON.stringify({
				cmd: "add_project",
				directory: "/home/new-proj",
			});

			const result = yield* decodeAndDispatch(raw);

			expect(result.ok).toBe(true);
			expect(result.slug).toBeDefined();
		}).pipe(Effect.provide(makeTestLayers())),
	);

	it.effect("dispatches valid get_status command", () =>
		Effect.gen(function* () {
			const raw = JSON.stringify({ cmd: "get_status" });

			const result = yield* decodeAndDispatch(raw);

			expect(result.ok).toBe(true);
			expect(result.uptime).toBeDefined();
		}).pipe(Effect.provide(makeTestLayers({ port: 7777 }))),
	);

	it.effect("dispatches valid shutdown command", () =>
		Effect.gen(function* () {
			const raw = JSON.stringify({ cmd: "shutdown" });

			const result = yield* decodeAndDispatch(raw);

			expect(result.ok).toBe(true);
		}).pipe(Effect.provide(makeTestLayers())),
	);

	it.effect("dispatches valid list_projects command", () =>
		Effect.gen(function* () {
			const raw = JSON.stringify({ cmd: "list_projects" });

			const result = yield* decodeAndDispatch(raw);

			expect(result.ok).toBe(true);
			expect(result.projects).toBeDefined();
		}).pipe(Effect.provide(makeTestLayers())),
	);

	it.effect("dispatches valid instance_list command", () =>
		Effect.gen(function* () {
			const raw = JSON.stringify({ cmd: "instance_list" });

			const result = yield* decodeAndDispatch(raw);

			expect(result.ok).toBe(true);
			expect(result.instances).toBeDefined();
		}).pipe(Effect.provide(makeTestLayers())),
	);

	it.effect("dispatches valid set_pin command", () =>
		Effect.gen(function* () {
			const raw = JSON.stringify({ cmd: "set_pin", pin: "5678" });

			const result = yield* decodeAndDispatch(raw);

			expect(result.ok).toBe(true);
		}).pipe(Effect.provide(makeTestLayers())),
	);

	it.effect("returns error for invalid JSON", () =>
		Effect.gen(function* () {
			const result = yield* decodeAndDispatch("not valid json {{{");

			expect(result.ok).toBe(false);
			expect(result.error).toBeDefined();
		}).pipe(Effect.provide(makeTestLayers())),
	);

	it.effect("returns error for unknown command", () =>
		Effect.gen(function* () {
			const raw = JSON.stringify({ cmd: "nonexistent_command" });

			const result = yield* decodeAndDispatch(raw);

			expect(result.ok).toBe(false);
			expect(result.error).toBeDefined();
		}).pipe(Effect.provide(makeTestLayers())),
	);

	it.effect("returns error for missing required fields", () =>
		Effect.gen(function* () {
			// add_project without directory
			const raw = JSON.stringify({ cmd: "add_project" });

			const result = yield* decodeAndDispatch(raw);

			expect(result.ok).toBe(false);
			expect(result.error).toBeDefined();
		}).pipe(Effect.provide(makeTestLayers())),
	);
});
