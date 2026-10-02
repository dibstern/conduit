import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { OpenCodeInstanceClientsLive } from "../../../src/lib/domain/relay/Services/opencode-instance-clients.js";
import { PendingSendOwnershipLive } from "../../../src/lib/domain/relay/Services/pending-send-ownership.js";
import { RelayStatusSnapshotLive } from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import {
	BackgroundLivenessTag,
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	SessionManagerServiceLive,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import { settleIdleSessions } from "../../../src/lib/session/auto-settle-sweep.js";
import { makeSessionBackgroundLiveness } from "../../../src/lib/session/background-liveness.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

const DAY = 86_400_000;

describe("relay automatic settlement sweep", () => {
	it.effect(
		"settles only eligible rows once and clears the automatic marker on un-settle",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-auto-settle-"));
			const configLayer = Layer.succeed(
				ConfigTag,
				makeMockConfig({ configDir: dir, projectDir: dir }),
			);
			const loggerLayer = Layer.succeed(LoggerTag, makeMockLogger());
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					makeSessionManagerStateLive(),
					PendingSendOwnershipLive,
					Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
					loggerLayer,
					configLayer,
					Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
					Layer.succeed(BackgroundLivenessTag, () => undefined),
					RelayStatusSnapshotLive,
					makeOverridesStateLive(),
					OpenCodeInstanceClientsLive.pipe(
						Layer.provide(Layer.merge(configLayer, loggerLayer)),
					),
					DaemonEventBusLive,
					makePersistenceEffectLayer(join(dir, "events.db")),
					Layer.succeed(
						OrchestrationEngineTag,
						new OrchestrationEngine({ registry: new ProviderRegistry() }),
					),
				),
			);
			return Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const read = yield* ReadQueryEffectTag;
				const service = yield* SessionManagerServiceTag;
				const sql = yield* SqlClient.SqlClient;
				yield* runner.markRecovered();
				const now = Date.now();
				const old = now - 4 * DAY;
				const seed = (id: string) =>
					Effect.gen(function* () {
						for (const event of [
							canonicalEvent(
								"session.created",
								id,
								{ sessionId: id, title: id, provider: "opencode" },
								{ createdAt: old - 1 },
							),
							canonicalEvent(
								"message.created",
								id,
								{ sessionId: id, messageId: `${id}-m1`, role: "assistant" },
								{ createdAt: old },
							),
							canonicalEvent(
								"session.read",
								id,
								{ sessionId: id },
								{ createdAt: old + 1 },
							),
						])
							yield* runner.projectEvent(yield* store.append(event));
					});
				for (const id of ["eligible", "viewed", "background", "woken"])
					yield* seed(id);
				yield* runner.projectEvent(
					yield* store.append(
						canonicalEvent(
							"session.snoozed",
							"woken",
							{ sessionId: "woken", until: old + 3 },
							{ createdAt: old + 2 },
						),
					),
				);
				const viewers = new Set(["viewed"]);
				const background = makeSessionBackgroundLiveness();
				background.record({
					sessionId: "background",
					kind: "snapshot",
					taskTypes: ["task1"],
				});
				const broadcast = vi.fn(() => service.pushViewerFamilies());
				const ports = {
					hasViewer: (id: string) => viewers.has(id),
					hasLiveBackgroundWork: background.hasLiveWork,
					setSettled: (id: string) =>
						service.setSessionSettled(id, { settled: true, automatic: true }),
					broadcastSessionList: broadcast,
				};
				expect(yield* settleIdleSessions(ports, 3 * DAY, now)).toBe(2);
				expect(
					(yield* read.getSession("eligible"))?.settled_automatically,
				).toBe(1);
				expect((yield* read.getSession("viewed"))?.settled_at).toBeNull();
				expect((yield* read.getSession("background"))?.settled_at).toBeNull();
				const events = yield* store.readAllBySession("eligible");
				expect(
					events
						.filter((event) => event.type === "session.settled")
						.map((event) => event.data),
				).toEqual([{ sessionId: "eligible", automatic: true }]);
				expect(
					(yield* store.readAllBySession("woken"))
						.filter((event) => event.type.startsWith("session."))
						.map((event) => event.type),
				).toEqual([
					"session.created",
					"session.read",
					"session.snoozed",
					"session.settled",
				]);
				expect(yield* settleIdleSessions(ports, 3 * DAY, now)).toBe(0);
				expect(broadcast).toHaveBeenCalled();
				yield* service.setSessionSettled("eligible", { settled: false });
				expect(
					(yield* read.getSession("eligible"))?.settled_automatically,
				).toBe(0);
				background.record({
					sessionId: "background",
					kind: "snapshot",
					taskTypes: [],
				});
				viewers.clear();
				expect(yield* settleIdleSessions(ports, 3 * DAY, now)).toBe(2);
				const settledRows = yield* sql<{
					id: string;
				}>`SELECT id FROM sessions WHERE settled_at IS NOT NULL`;
				expect(settledRows.map((row) => row.id).sort()).toEqual([
					"background",
					"viewed",
					"woken",
				]);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);
});
