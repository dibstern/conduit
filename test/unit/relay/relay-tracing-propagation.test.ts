import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import {
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Effect, Layer, Option, Ref } from "effect";
import { expect, vi } from "vitest";
import { PortScannerTag } from "../../../src/lib/domain/daemon/Layers/port-scanner-layer.js";
import {
	HttpServerRefTag,
	RelayFactoryLive,
	RelayFactoryTag,
} from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import { makeDaemonTracingLive } from "../../../src/lib/domain/daemon/Layers/tracing.js";
import { VersionCheckerTag } from "../../../src/lib/domain/daemon/Layers/version-checker-layer.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { InstanceHealthCheckLive } from "../../../src/lib/domain/daemon/Services/instance-health-service.js";
import { makeInstanceManagerStateLive } from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	makeSessionActivity,
	SessionActivityTag,
} from "../../../src/lib/domain/daemon/Services/session-activity.js";
import { PushManagerTag } from "../../../src/lib/domain/server/Services/push-service.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { sdkDefaultClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { createProjectRelay } from "../../../src/lib/relay/relay-stack.js";
import { makeDaemonStoreTestLayer } from "../../helpers/daemon-rpc.js";
import {
	makeMockAccountDirectory,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";

describe("relay tracing propagation", () => {
	it.effect(
		"propagates the daemon tracer into the relay ManagedRuntime",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-relay-tracing-"));
			const projectDir = join(dir, "project");
			mkdirSync(projectDir);
			const server = createServer();
			const exporter = new InMemorySpanExporter();
			const processor = new SimpleSpanProcessor(exporter);
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockRejectedValue(new DOMException("test timeout", "AbortError"));

			const dependencies = Layer.mergeAll(
				makeDaemonStoreTestLayer(),
				Layer.succeed(AccountDirectory, makeMockAccountDirectory()),
				makeDaemonTracingLive({
					enabled: false,
					filePath: join(dir, "unused.trace.ndjson"),
					maxBytes: 1024 * 1024,
					maxFiles: 2,
					batchWindowMs: 10,
					spanProcessors: [processor],
				}),
				InstanceHealthCheckLive,
				Layer.succeed(OpenCodeInstancesTag, makeOpenCodeInstancesStub()),
				DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
				ConfigPersistenceNoopLive,
				DaemonEventBusLive,
				Layer.effect(SessionActivityTag, makeSessionActivity),
				makeProjectRegistryLive(),
				makeInstanceManagerStateLive(undefined, [], {
					launchLogin: sdkDefaultClaudeConfigDir("/isolated-test-home/.claude"),
				}),
				Layer.succeed(PortScannerTag, {
					getKnownPorts: () => Effect.succeed(new Set<number>()),
					scanNow: () =>
						Effect.succeed({ discovered: [], lost: [], active: [] }),
				}),
				Layer.succeed(VersionCheckerTag, {
					getLatestKnown: () => Effect.succeed(null),
					getCurrentVersion: () => Effect.succeed("unknown"),
				}),
				Layer.succeed(PushManagerTag, {
					subscribe: () => Effect.void,
					unsubscribe: () => Effect.void,
					broadcast: () => Effect.void,
					getPublicKey: Effect.succeed(undefined),
					addSubscription: () => Effect.void,
					removeSubscription: () => Effect.void,
					sendToAll: () => Effect.void,
					getLegacyManager: Effect.succeed(Option.none()),
				}),
			);
			const layer = RelayFactoryLive(join(dir, "config")).pipe(
				Layer.provideMerge(dependencies),
			);

			return Effect.gen(function* () {
				const httpServerRef = yield* HttpServerRefTag;
				yield* Ref.set(httpServerRef, server);
				const factory = yield* RelayFactoryTag;

				yield* Effect.withSpan("test.daemon.tracer.control")(
					Effect.acquireUseRelease(
						factory.create({
							slug: "traced-project",
							title: "Traced Project",
							folders: [projectDir],
						}),
						(relay) =>
							Effect.promise(() =>
								relay.effectRuntime.runtime.runPromise(
									Effect.withSpan("test.relay.managed-runtime")(Effect.void),
								),
							),
						(relay) => Effect.promise(() => relay.stop()),
					),
				);
				yield* Effect.promise(() => processor.forceFlush());

				const finishedSpans = exporter.getFinishedSpans();
				expect(finishedSpans.map((span) => span.name)).toContain(
					"test.daemon.tracer.control",
				);
				const relaySpan = finishedSpans.find(
					(span) => span.name === "test.relay.managed-runtime",
				);
				expect(
					relaySpan,
					"expected relay ManagedRuntime span to reach daemon exporter",
				).toBeDefined();
				expect(relaySpan?.parentSpanContext).toBeUndefined();
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => {
						fetchSpy.mockRestore();
						server.close();
						rmSync(dir, { recursive: true, force: true });
					}),
				),
			);
		},
		20_000,
	);

	it.effect(
		"propagates the daemon tracer into fibers forked during relay layer construction",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-relay-fiber-tracing-"));
			const projectDir = join(dir, "project");
			mkdirSync(projectDir);
			const server = createServer();
			const exporter = new InMemorySpanExporter();
			const processor = new SimpleSpanProcessor(exporter);
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async (input) => {
					const request = input instanceof Request ? input : new Request(input);
					const path = new URL(request.url).pathname;
					const json = (value: unknown) =>
						new Response(JSON.stringify(value), {
							headers: { "Content-Type": "application/json" },
						});

					if (path === "/path") {
						return json({
							state: join(dir, "state"),
							config: join(dir, "config"),
							worktree: projectDir,
							directory: projectDir,
						});
					}
					if (path === "/config") return json({});
					if (path === "/session") {
						return json([
							{
								id: "sess-1",
								projectID: "project-1",
								directory: projectDir,
								title: "Session 1",
								version: "1",
								time: { created: 1, updated: 1 },
								modelID: "gpt-4",
								providerID: "openai",
							},
						]);
					}
					if (path === "/session/status") return json({});
					if (path === "/provider") {
						return json({ providers: [], defaults: {}, connected: [] });
					}
					if (path === "/permission" || path === "/question") return json([]);
					if (path === "/event") {
						return new Response(": heartbeat\n\n", {
							headers: { "Content-Type": "text/event-stream" },
						});
					}
					return new Response("Not found", { status: 404 });
				});
			const tracing = makeDaemonTracingLive({
				enabled: false,
				filePath: join(dir, "unused.trace.ndjson"),
				maxBytes: 1024 * 1024,
				maxFiles: 2,
				batchWindowMs: 10,
				spanProcessors: [processor],
			});

			return Effect.gen(function* () {
				const tracer = yield* Effect.tracer;
				yield* Effect.acquireUseRelease(
					Effect.promise(() =>
						createProjectRelay({
							httpServer: server,
							opencodeUrl: "http://opencode.test",
							projectDir,
							slug: "construction-fiber-tracing",
							log: createSilentLogger(),
							noServer: true,
							statusPollerInterval: 20,
							messagePollerInterval: 60_000,
							persistenceDbPath: join(dir, "events.db"),
							publishGlobalSetting: () => Effect.void,
							tracer,
						}),
					),
					() =>
						Effect.promise(async () => {
							await processor.forceFlush();
							const initialPollSpanCount = exporter
								.getFinishedSpans()
								.filter((span) => span.name === "statusPoller.poll").length;
							expect(initialPollSpanCount).toBeGreaterThan(0);

							await vi.waitFor(
								async () => {
									await processor.forceFlush();
									const currentPollSpanCount = exporter
										.getFinishedSpans()
										.filter((span) => span.name === "statusPoller.poll").length;
									expect(
										currentPollSpanCount,
										"expected recurring status poller span from construction-forked fiber to reach daemon exporter",
									).toBeGreaterThan(initialPollSpanCount);
								},
								{ timeout: 2_000, interval: 20 },
							);
						}),
					(relay) => Effect.promise(() => relay.stop()),
				);
			}).pipe(
				Effect.provide(Layer.fresh(tracing)),
				Effect.ensuring(
					Effect.sync(() => {
						fetchSpy.mockRestore();
						server.close();
						rmSync(dir, { recursive: true, force: true });
					}),
				),
			);
		},
		20_000,
	);
});
