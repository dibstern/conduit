import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	ConfigTag,
	LoggerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	SessionManagerServiceLive,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { settleIdleSessions } from "../../../src/lib/session/auto-settle-sweep.js";
import { makeSessionBackgroundLiveness } from "../../../src/lib/session/background-liveness.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

const DAY = 86_400_000;

describe("relay automatic settlement sweep", () => {
	it.effect(
		"settles only eligible rows once and clears the automatic marker on un-settle",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-auto-settle-"));
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					makeSessionManagerStateLive(),
					Layer.succeed(OpenCodeAPITag, makeMockOpenCodeAPI()),
					Layer.succeed(LoggerTag, makeMockLogger()),
					Layer.succeed(
						ConfigTag,
						makeMockConfig({ configDir: dir, projectDir: dir }),
					),
					DaemonEventBusLive,
					makePersistenceEffectLayer(join(dir, "events.db")),
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
					taskId: "task1",
					kind: "started",
					status: "running",
				});
				const broadcast = vi.fn();
				const ports = {
					hasViewer: (id: string) => viewers.has(id),
					hasLiveBackgroundWork: background.hasLiveWork,
					setSettled: (id: string) => service.setSessionSettled(id, true, true),
					broadcastSessionList: () => service.sendSessionLists(broadcast),
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
				yield* service.setSessionSettled("eligible", false);
				expect(
					(yield* read.getSession("eligible"))?.settled_automatically,
				).toBe(0);
				background.record({
					sessionId: "background",
					taskId: "task1",
					kind: "completed",
					status: "completed",
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
