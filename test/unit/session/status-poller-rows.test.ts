import { Effect, HashMap, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { StatusPollerLive } from "../../../src/lib/domain/relay/Layers/status-poller-layer.js";
import { PendingInteractionServiceLive } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { RelayStatusSnapshotLive } from "../../../src/lib/domain/relay/Services/relay-status-snapshot.js";
import {
	ConfigTag,
	LoggerTag,
	StatusPollerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionGitServiceTag } from "../../../src/lib/domain/relay/Services/session-git-service.js";
import { makeSessionManagerStateLive } from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import {
	makePollerPubSubLive,
	makePollerStateLive,
} from "../../../src/lib/domain/relay/Services/session-status-poller.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

const pollerLayer = (api: ReturnType<typeof makeMockOpenCodeAPI>) =>
	StatusPollerLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				makePersistenceEffectLayer(":memory:", "test-project"),
				PendingInteractionServiceLive,
				Layer.succeed(ConfigTag, makeMockConfig()),
				Layer.succeed(LoggerTag, makeMockLogger()),
				Layer.succeed(OpenCodeAPITag, api),
				makePollerStateLive(),
				makePollerPubSubLive(),
				RelayStatusSnapshotLive,
				makeSessionManagerStateLive({
					cachedParentMap: HashMap.make(["child", "parent"]),
				}),
			),
		),
	);

const insertParentAndBusyChild = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at, project_id)
		VALUES ('parent', 'opencode', 'Parent', 'idle', 1, 1, 'test-project')`;
	yield* sql`INSERT INTO sessions (id, provider, title, status, parent_id, created_at, updated_at, project_id)
		VALUES ('child', 'opencode', 'Child', 'busy', 'parent', 2, 2, 'test-project')`;
});

it("returns readiness while initial git is blocked and completes it in the relay scope", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let refreshed = false;
	const readGit = vi.fn(() => held);
	const runtime = ManagedRuntime.make(
		pollerLayer(makeMockOpenCodeAPI()).pipe(
			Layer.provide(
				Layer.succeed(SessionGitServiceTag, {
					refresh: () =>
						Effect.tryPromise(readGit).pipe(
							Effect.tap(() => {
								refreshed = true;
							}),
						),
				}),
			),
		),
	);
	let ready = false;
	const starting = runtime
		.runPromise(Effect.flatMap(StatusPollerTag, (poller) => poller.start()))
		.then(() => {
			ready = true;
		});
	try {
		await vi.waitFor(() => expect(readGit).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(ready).toBe(true));
		expect(refreshed).toBe(false);
		release();
		await vi.waitFor(() => expect(refreshed).toBe(true));
	} finally {
		release();
		await starting;
		await runtime.dispose();
	}
});

it("interrupts the initial git refresh when the relay scope closes", async () => {
	let reading = false;
	let interrupted = false;
	const runtime = ManagedRuntime.make(
		pollerLayer(makeMockOpenCodeAPI()).pipe(
			Layer.provide(
				Layer.succeed(SessionGitServiceTag, {
					refresh: () =>
						Effect.sync(() => {
							reading = true;
						}).pipe(
							Effect.zipRight(Effect.never),
							Effect.onInterrupt(() =>
								Effect.sync(() => {
									interrupted = true;
								}),
							),
						),
				}),
			),
		),
	);
	try {
		await runtime.runPromise(
			Effect.flatMap(StatusPollerTag, (poller) => poller.start()),
		);
		await vi.waitFor(() => expect(reading).toBe(true));
	} finally {
		await runtime.dispose();
	}
	expect(interrupted).toBe(true);
});

// The poller only runs when OpenCode is reachable. After a restart without it,
// a Claude turn still running in its runner must not read as idle to browsers.
it("a poller that never started reads busy from the event store", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* insertParentAndBusyChild;
				const poller = yield* StatusPollerTag;
				expect(yield* poller.isProcessing("child")).toBe(true);
				expect(yield* poller.isProcessing("parent")).toBe(true);
			}),
		).pipe(Effect.provide(pollerLayer(makeMockOpenCodeAPI()))),
	);
});

it("keeps Claude status observation and exposes ownership separately", async () => {
	const api = makeMockOpenCodeAPI();
	vi.spyOn(api.session, "statuses").mockResolvedValue({
		"opencode-1": { type: "busy" },
	});
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at, project_id)
					VALUES ('opencode-1', 'opencode', 'OpenCode', 'busy', 1, 1, 'test-project'),
						('claude-1', 'claude', 'Claude', 'busy', 2, 2, 'test-project')`;
				const poller = yield* StatusPollerTag;
				yield* poller.start();
				expect(yield* poller.getCurrentStatuses()).toEqual({
					"opencode-1": { type: "busy" },
					"claude-1": { type: "busy" },
				});
				expect(yield* poller.getSessionProviders()).toEqual(
					new Map([
						["opencode-1", "opencode"],
						["claude-1", "claude"],
					]),
				);
			}),
		).pipe(Effect.provide(pollerLayer(api))),
	);
});

it("the poller returns source statuses without parent or message-activity augmentation", async () => {
	const api = makeMockOpenCodeAPI();
	vi.spyOn(api.session, "statuses").mockResolvedValue({
		parent: { type: "idle" },
		child: { type: "busy" },
	});
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* insertParentAndBusyChild;
				const poller = yield* StatusPollerTag;
				yield* poller.markMessageActivity("content-only");
				yield* poller.start();
				yield* Effect.promise(() =>
					vi.waitFor(async () =>
						expect(
							await Effect.runPromise(poller.getCurrentStatuses()),
						).toEqual({
							parent: { type: "idle" },
							child: { type: "busy" },
						}),
					),
				);
				const processing = yield* poller.isProcessing("parent");
				expect(processing).toBe(true);
				yield* poller.stop();
				vi.spyOn(api.session, "statuses").mockResolvedValue({
					parent: { type: "idle" },
					child: { type: "idle" },
				});
				yield* poller.start();
				const finished = yield* poller.isProcessing("parent");
				expect(finished).toBe(false);
			}),
		).pipe(Effect.provide(pollerLayer(api))),
	);
});
