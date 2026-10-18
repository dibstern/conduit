import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { makeMockAccountDirectory } from "../../helpers/mock-factories.js";
// Auto-settle runs from the daemon's sweep fiber, which does not carry the
// project's SessionEventBus. A settle committed there must still reach the
// sidebar's shell subscription; otherwise the row stays live in the browser,
// and a later manual settle is a server-side no-op that still shows its toast.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { RelayStatusSnapshotLive } from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	SessionManagerServiceLive,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { subscribeShell } from "../../../src/lib/domain/relay/Services/shell-subscription.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type { SessionInfo } from "../../../src/lib/shared-types.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockWebSocketHandler,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";

describe("SessionManagerService settle signal", () => {
	it.live(
		"a settle run outside the relay context still updates the shell",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-settle-signal-"));
			const projectDir = join(dir, "project");
			const worktree = join(dir, "worktree");
			const git = (cwd: string, ...args: string[]) =>
				execFileSync("git", args, {
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				}).trim();
			git(dir, "init", "-b", "main", projectDir);
			git(projectDir, "config", "user.name", "Settle test");
			git(projectDir, "config", "user.email", "settle@example.test");
			git(
				projectDir,
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"--allow-empty",
				"-qm",
				"initial",
			);
			git(projectDir, "worktree", "add", "-b", "feature", worktree);
			writeFileSync(join(worktree, "feature.txt"), "work");
			git(worktree, "add", "feature.txt");
			git(
				worktree,
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"-qm",
				"feature",
			);
			git(
				projectDir,
				"-c",
				"core.hooksPath=/dev/null",
				"merge",
				"--no-ff",
				"-qm",
				"merge",
				"feature",
			);
			const mergedHead = git(worktree, "rev-parse", "HEAD");
			const configLayer = Layer.succeed(
				ConfigTag,
				makeMockConfig({ configDir: dir, projectDir }),
			);
			const loggerLayer = Layer.succeed(LoggerTag, makeMockLogger());
			const openCodeApi = makeMockOpenCodeAPI();
			// Same wiring as project-relay-layers: one shared bus for the
			// persistence stack and the relay services.
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(AccountDirectory, makeMockAccountDirectory()),
					makeSessionManagerStateLive(),
					Layer.succeed(OpenCodeAPITag, openCodeApi),
					loggerLayer,
					configLayer,
					Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
					Layer.effect(SessionActivityTag, makeSessionActivity),
					RelayStatusSnapshotLive,
					makeOverridesStateLive(),
					Layer.succeed(
						OpenCodeInstancesTag,
						makeOpenCodeInstancesStub({ opencode: openCodeApi }),
					),
					DaemonEventBusLive,
					SessionEventBusLive,
					makePersistenceEffectLayer(
						join(dir, "events.db"),
						"test-project",
						undefined,
						SessionEventBusLive,
					),
					Layer.succeed(
						OrchestrationEngineTag,
						new OrchestrationEngine({ registry: new ProviderRegistry() }),
					),
				),
			);

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const service = yield* SessionManagerServiceTag;
				yield* runner.markRecovered();
				yield* runner
					.projectEvent(
						yield* store.append(
							canonicalEvent(
								"session.created",
								"ses-idle",
								{ sessionId: "ses-idle", title: "Idle", provider: "opencode" },
								{ provider: "opencode", createdAt: 1_000 },
							),
						),
					)
					.pipe(Effect.provideService(SqlClient.SqlClient, sql));
				yield* runner.projectEvent(
					yield* store.append(
						canonicalEvent("session.workspace_changed", "ses-idle", {
							sessionId: "ses-idle",
							cause: "user",
							origin: "existing",
							worktrees: { [projectDir]: worktree },
						}),
					),
				);

				const seen: SessionInfo[] = [];
				let synchronized = false;
				const shell = yield* Effect.forkChild(
					Stream.runForEach(subscribeShell(), (envelope) =>
						Effect.sync(() => {
							if (envelope._tag === "synchronized") synchronized = true;
							if (envelope._tag === "upsert") seen.push(envelope.item);
						}),
					),
				);
				while (!synchronized) yield* Effect.sleep("5 millis");

				// The auto-settle sweep's context: the service and nothing else.
				expect(
					yield* Effect.promise(() =>
						Effect.runPromise(
							service.setSessionSettled("ses-idle", {
								settled: true,
								automatic: true,
								mergedHead,
							}),
						),
					),
				).toBe(true);
				expect(
					(yield* store.readAllBySession("ses-idle"))
						.filter((event) => event.type === "session.settled")
						.map((event) => event.data),
				).toEqual([{ sessionId: "ses-idle", automatic: true, mergedHead }]);
				// Manual settlement must consume the same merge before a wake-up, too.
				yield* service.setSessionSettled("ses-idle", { settled: false });
				yield* service.setSessionSettled("ses-idle", { settled: true });
				expect(
					(yield* store.readAllBySession("ses-idle"))
						.filter((event) => event.type === "session.settled")
						.at(-1)?.data,
				).toEqual({ sessionId: "ses-idle", automatic: false, mergedHead });

				const deadline = Date.now() + 1_000;
				const settledUpsert = () =>
					seen.some((row) => row.id === "ses-idle" && row.settledAt != null);
				while (!settledUpsert() && Date.now() < deadline)
					yield* Effect.sleep("10 millis");
				yield* Fiber.interrupt(shell);
				expect(settledUpsert()).toBe(true);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);
});
