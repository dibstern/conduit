// Auto-settle runs from the daemon's sweep fiber, which does not carry the
// project's SessionEventBus. A settle committed there must still reach the
// sidebar's shell subscription; otherwise the row stays live in the browser,
// and a later manual settle is a server-side no-op that still shows its toast.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { expect } from "vitest";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { PendingSendOwnershipLive } from "../../../src/lib/domain/relay/Services/pending-send-ownership.js";
import { RelayStatusSnapshotLive } from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import {
	BackgroundLivenessTag,
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
			const configLayer = Layer.succeed(
				ConfigTag,
				makeMockConfig({ configDir: dir, projectDir: dir }),
			);
			const loggerLayer = Layer.succeed(LoggerTag, makeMockLogger());
			const openCodeApi = makeMockOpenCodeAPI();
			// Same wiring as project-relay-layers: one shared bus for the
			// persistence stack and the relay services.
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					makeSessionManagerStateLive(),
					PendingSendOwnershipLive,
					Layer.succeed(OpenCodeAPITag, openCodeApi),
					loggerLayer,
					configLayer,
					Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
					Layer.succeed(BackgroundLivenessTag, () => undefined),
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

				const seen: SessionInfo[] = [];
				let synchronized = false;
				const shell = yield* Effect.fork(
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
							}),
						),
					),
				).toBe(true);

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
