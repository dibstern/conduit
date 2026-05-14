// ─── Tests: daemon-layers composition ─────────────────────────────────────────
// Smoke tests verifying that the new DaemonState and RelayCache layers
// compose correctly and provide their Tags.

import { FileSystem } from "@effect/platform";
import { SystemError } from "@effect/platform/Error";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { makeDaemonStateFromDisk } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import {
	DaemonStateTag,
	makeDaemonStateLive,
} from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import {
	makeRelayCacheLive,
	type Relay,
	RelayCacheTag,
} from "../../../src/lib/domain/daemon/Services/relay-cache.js";

// ─── In-memory test FileSystem ────────────────────────────────────────────────

const makeTestFileSystem = (files: Map<string, string> = new Map()) => {
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
	});

	return Layer.succeed(FileSystem.FileSystem, fs);
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("daemon-layers", () => {
	it.effect("DaemonStateTag is available in composed layer", () =>
		Effect.gen(function* () {
			const ref = yield* DaemonStateTag;
			const state = yield* Ref.get(ref);
			expect(state.clientCount).toBe(0);
		}).pipe(Effect.provide(makeDaemonStateLive())),
	);

	it.effect(
		"makeDaemonStateFromDisk loads config and provides DaemonStateTag",
		() =>
			Effect.gen(function* () {
				const ref = yield* DaemonStateTag;
				const state = yield* Ref.get(ref);
				expect(state.port).toBe(9876);
				expect(state.pinHash).toBe("disk-hash");
			}).pipe(
				Effect.provide(
					makeDaemonStateFromDisk("/test/daemon.json").pipe(
						Layer.provide(
							makeTestFileSystem(
								new Map([
									[
										"/test/daemon.json",
										JSON.stringify({ port: 9876, pinHash: "disk-hash" }),
									],
								]),
							),
						),
					),
				),
			),
	);

	it.effect(
		"makeDaemonStateFromDisk falls back to defaults on missing file",
		() =>
			Effect.gen(function* () {
				const ref = yield* DaemonStateTag;
				const state = yield* Ref.get(ref);
				// Should have defaults since the file doesn't exist
				expect(state.clientCount).toBe(0);
				expect(state.pinHash).toBeNull();
				expect(state.projects).toEqual([]);
			}).pipe(
				Effect.provide(
					makeDaemonStateFromDisk("/nonexistent/daemon.json").pipe(
						Layer.provide(makeTestFileSystem()),
					),
				),
			),
	);

	it.effect("RelayCacheTag is available via makeRelayCacheLayer", () =>
		Effect.gen(function* () {
			const cache = yield* RelayCacheTag;
			expect(cache.get).toBeTypeOf("function");
			expect(cache.invalidate).toBeTypeOf("function");
		}).pipe(
			Effect.provide(
				makeRelayCacheLive((slug) =>
					Effect.succeed({
						slug,
						wsHandler: { handleUpgrade: () => {} },
						rpcWsHandler: { handleUpgrade: () => {} },
						stop: () => {},
					} satisfies Relay),
				),
			),
		),
	);
});
