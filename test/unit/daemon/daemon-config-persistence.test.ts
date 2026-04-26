// ─── Tests: Effect-based config persistence with coalesced saves ──────────────

import { FileSystem } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import {
	loadConfig,
	PersistencePathTag,
	persistConfig,
} from "../../../src/lib/effect/daemon-config-persistence.js";
import type { DaemonState } from "../../../src/lib/effect/daemon-state.js";
import {
	DaemonStateTag,
	emptyDaemonState,
	makeDaemonStateLive,
} from "../../../src/lib/effect/daemon-state.js";

// ─── In-memory test FileSystem ────────────────────────────────────────────────

const makeTestFileSystem = () => {
	const files = new Map<string, string>();
	const renames: Array<{ from: string; to: string }> = [];
	const directories = new Set<string>();

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
				renames.push({ from: oldPath, to: newPath });
			}),
		makeDirectory: (path: string) =>
			Effect.sync(() => {
				directories.add(path);
			}),
	});

	const layer = Layer.succeed(FileSystem.FileSystem, fs);

	return { files, renames, directories, layer };
};

// ─── Helper: provide all test layers ──────────────────────────────────────────

const CONFIG_PATH = "/test-config/daemon.json";

const makeTestLayers = (
	testFs: ReturnType<typeof makeTestFileSystem>,
	stateOverrides?: Partial<DaemonState>,
) =>
	Layer.mergeAll(
		testFs.layer,
		Layer.succeed(PersistencePathTag, CONFIG_PATH),
		makeDaemonStateLive(stateOverrides),
	);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("daemon-config-persistence", () => {
	// ── persistConfig ──────────────────────────────────────────────────────

	it.effect("persistConfig writes current state to disk", () =>
		Effect.gen(function* () {
			const testFs = makeTestFileSystem();

			yield* persistConfig.pipe(
				Effect.provide(
					makeTestLayers(testFs, {
						port: 9999,
						pinHash: "test-hash",
						dismissedPaths: new Set(["/a", "/b"]),
						projects: [
							{
								path: "/app",
								slug: "app",
								title: "My App",
								addedAt: 1000,
							},
						],
					}),
				),
			);

			// Verify atomic rename happened
			expect(testFs.renames.length).toBeGreaterThanOrEqual(1);
			const lastRename = testFs.renames.at(-1);
			expect(lastRename).toBeDefined();
			expect(lastRename?.to).toBe(CONFIG_PATH);
			expect(lastRename?.from).toContain(".tmp");

			// Verify written content
			const written = testFs.files.get(CONFIG_PATH);
			expect(written).toBeDefined();
			const parsed = JSON.parse(written ?? "{}");
			expect(parsed.port).toBe(9999);
			expect(parsed.pinHash).toBe("test-hash");
			// dismissedPaths serialized as array
			expect(parsed.dismissedPaths).toEqual(["/a", "/b"]);
			expect(parsed.projects).toHaveLength(1);
			expect(parsed.projects[0].slug).toBe("app");
		}),
	);

	// ── loadConfig ─────────────────────────────────────────────────────────

	it.effect("loadConfig returns parsed state from disk", () =>
		Effect.gen(function* () {
			const testFs = makeTestFileSystem();

			// Pre-populate the file
			const diskState = {
				pid: 42,
				port: 8080,
				host: "0.0.0.0",
				pinHash: "loaded-hash",
				tls: true,
				debug: true,
				keepAwake: true,
				keepAwakeCommand: "systemd-inhibit",
				keepAwakeArgs: ["--what=idle"],
				dangerouslySkipPermissions: false,
				projects: [{ path: "/proj", slug: "proj", addedAt: 2000 }],
				instances: [{ id: "i1", name: "Dev", port: 4096, managed: true }],
				dismissedPaths: ["/old-path", "/another"],
			};
			testFs.files.set(CONFIG_PATH, JSON.stringify(diskState));

			const state = yield* loadConfig.pipe(
				Effect.provide(
					Layer.mergeAll(
						testFs.layer,
						Layer.succeed(PersistencePathTag, CONFIG_PATH),
					),
				),
			);

			expect(state.port).toBe(8080);
			expect(state.host).toBe("0.0.0.0");
			expect(state.pinHash).toBe("loaded-hash");
			expect(state.tls).toBe(true);
			expect(state.debug).toBe(true);
			expect(state.keepAwake).toBe(true);
			expect(state.keepAwakeCommand).toBe("systemd-inhibit");
			expect(state.keepAwakeArgs).toEqual(["--what=idle"]);
			expect(state.projects).toHaveLength(1);
			expect(state.instances).toHaveLength(1);
			// dismissedPaths deserialized as Set
			expect(state.dismissedPaths).toBeInstanceOf(Set);
			expect(state.dismissedPaths.size).toBe(2);
			expect(state.dismissedPaths.has("/old-path")).toBe(true);
			expect(state.dismissedPaths.has("/another")).toBe(true);
		}),
	);

	it.effect("loadConfig returns emptyDaemonState() on missing file", () =>
		Effect.gen(function* () {
			const testFs = makeTestFileSystem();
			// Do NOT populate any files

			const state = yield* loadConfig.pipe(
				Effect.provide(
					Layer.mergeAll(
						testFs.layer,
						Layer.succeed(PersistencePathTag, CONFIG_PATH),
					),
				),
			);

			const defaults = emptyDaemonState();
			expect(state.port).toBe(defaults.port);
			expect(state.pinHash).toBeNull();
			expect(state.projects).toEqual([]);
			expect(state.instances).toEqual([]);
			expect(state.dismissedPaths.size).toBe(0);
			expect(state.keepAwake).toBe(false);
			expect(state.debug).toBe(false);
		}),
	);

	it.effect("loadConfig returns emptyDaemonState() on corrupt JSON", () =>
		Effect.gen(function* () {
			const testFs = makeTestFileSystem();
			testFs.files.set(CONFIG_PATH, "{ not valid json !!!");

			const state = yield* loadConfig.pipe(
				Effect.provide(
					Layer.mergeAll(
						testFs.layer,
						Layer.succeed(PersistencePathTag, CONFIG_PATH),
					),
				),
			);

			const defaults = emptyDaemonState();
			expect(state.port).toBe(defaults.port);
			expect(state.pinHash).toBeNull();
			expect(state.dismissedPaths.size).toBe(0);
		}),
	);

	// ── Coalescing ─────────────────────────────────────────────────────────

	it.effect("coalesces rapid saves via atomic Ref.modify", () =>
		Effect.gen(function* () {
			// Use a slow-write FS so the first save is still in progress when
			// concurrent calls arrive — this lets the coalescing logic work.
			const files = new Map<string, string>();
			const renames: Array<{ from: string; to: string }> = [];
			const directories = new Set<string>();

			const slowFs: FileSystem.FileSystem = FileSystem.makeNoop({
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
					Effect.gen(function* () {
						// Yield to the scheduler so other fibers can run and
						// attempt to acquire the pendingSave lock.
						yield* Effect.yieldNow();
						files.set(path, data);
					}),
				rename: (oldPath: string, newPath: string) =>
					Effect.gen(function* () {
						yield* Effect.yieldNow();
						const content = files.get(oldPath);
						if (content !== undefined) {
							files.set(newPath, content);
							files.delete(oldPath);
						}
						renames.push({ from: oldPath, to: newPath });
					}),
				makeDirectory: (path: string) =>
					Effect.sync(() => {
						directories.add(path);
					}),
			});

			const layers = Layer.mergeAll(
				Layer.succeed(FileSystem.FileSystem, slowFs),
				Layer.succeed(PersistencePathTag, CONFIG_PATH),
				makeDaemonStateLive({ port: 7777 }),
			);

			// Fire 3 concurrent persists
			yield* Effect.all([persistConfig, persistConfig, persistConfig], {
				concurrency: "unbounded",
			}).pipe(Effect.provide(layers));

			// Should have at most 2 renames (not 3)
			// First call does the write; concurrent calls coalesce into at most 1 resave
			expect(renames.length).toBeLessThanOrEqual(2);
			expect(renames.length).toBeGreaterThanOrEqual(1);
		}),
	);

	it.effect("coalesces deterministically when save already in progress", () =>
		Effect.gen(function* () {
			const testFs = makeTestFileSystem();

			// Create a shared Ref pre-set with pendingSave=true
			const ref = yield* Ref.make<DaemonState>({
				...emptyDaemonState(),
				port: 5555,
				pendingSave: true,
			});

			const layers = Layer.mergeAll(
				testFs.layer,
				Layer.succeed(PersistencePathTag, CONFIG_PATH),
				Layer.succeed(DaemonStateTag, ref),
			);

			yield* persistConfig.pipe(Effect.provide(layers));

			// No rename should happen because pendingSave was already true;
			// instead needsResave should have been set
			expect(testFs.renames.length).toBe(0);

			// Verify needsResave was set on the state
			const state = yield* Ref.get(ref);
			expect(state.needsResave).toBe(true);
		}),
	);
});
