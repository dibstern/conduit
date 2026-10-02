import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildDaemonConfigSnapshot,
	ConfigPersistenceNoopLive,
} from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import {
	makeProjectShellEnvLive,
	ProjectShellEnvTag,
	ProjectShellEnvWiringLive,
} from "../../../src/lib/domain/daemon/Layers/project-shell-env-layer.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { makeDaemonStateLive } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import { makeInstanceManagerStateLive } from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import {
	addWithoutRelay,
	makeProjectRegistryFromDaemonStateLive,
	remove,
} from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { RelayCacheTag } from "../../../src/lib/domain/daemon/Services/relay-cache.js";

let home: string | undefined;
afterEach(() => {
	if (home) rmSync(home, { recursive: true, force: true });
});

describe("daemon project shell env lifecycle", () => {
	it("prewarms registered projects without relays, resolves additions, preserves config and removes caches", async () => {
		home = mkdtempSync(join(tmpdir(), "conduit-env-lifecycle-"));
		const project = join(home, "project");
		const added = join(home, "added");
		mkdirSync(project);
		mkdirSync(added);
		writeFileSync(
			join(home, ".zprofile"),
			'export PATH="/usr/bin:/bin"\nexport FROM_LOGIN="yes"\n',
		);
		const shellEnv = {
			interactive: false,
			overrides: { PROJECT_CONFIG: "persisted" },
		};
		const registry = makeProjectRegistryFromDaemonStateLive.pipe(
			Layer.provideMerge(
				makeDaemonStateLive({
					projects: [{ path: project, slug: "initial", addedAt: 1, shellEnv }],
				}),
			),
		);
		const deps = Layer.mergeAll(
			registry,
			makeProjectShellEnvLive({
				env: {
					HOME: home,
					ZDOTDIR: home,
					SHELL: "/bin/zsh",
					PATH: "/usr/bin:/bin",
				},
			}),
			DaemonEventBusLive,
			ConfigPersistenceNoopLive,
			DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
			makeInstanceManagerStateLive(),
			Layer.succeed(RelayCacheTag, {
				get: () => Effect.die("A relay must not start during env resolution"),
				peek: () => Effect.succeed(Option.none()),
				invalidate: () => Effect.void,
			}),
		);
		const layer = ProjectShellEnvWiringLive.pipe(Layer.provideMerge(deps));
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const env = yield* ProjectShellEnvTag;
					// Registration must have started resolution before any query/get call.
					expect(env.snapshot(project).resolving).toBe(true);
					yield* Effect.tryPromise(() => env.refresh(project));
					expect(env.get(project)).toMatchObject({
						FROM_LOGIN: "yes",
						PROJECT_CONFIG: "persisted",
					});
					const config = yield* buildDaemonConfigSnapshot;
					expect(config.projects[0]?.shellEnv).toEqual(shellEnv);
					yield* addWithoutRelay({
						slug: "added",
						title: "Added",
						directory: added,
						shellEnv: { overrides: { PROJECT_CONFIG: "added" } },
					});
					yield* Effect.tryPromise(() =>
						vi.waitFor(() =>
							expect(env.snapshot(added).sources).toEqual([
								"login",
								"overrides",
							]),
						),
					);
					expect(env.get(added)["PROJECT_CONFIG"]).toBe("added");
					yield* remove("added");
					yield* Effect.tryPromise(() =>
						vi.waitFor(() => expect(env.directories()).not.toContain(added)),
					);
				}),
			).pipe(Effect.provide(layer)),
		);
	});
});
