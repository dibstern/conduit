import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	makeOpenCodeInstancesLive,
	type OpenCodeEndpoint,
} from "../../../src/lib/domain/daemon/Layers/opencode-instances-layer.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import {
	SSEStreamLive,
	SSEStreamTag,
} from "../../../src/lib/domain/relay/Services/sse-stream-service.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { wireSSEConsumerEffect } from "../../../src/lib/relay/sse-wiring.js";
import {
	createMockSSEWiringDeps,
	makeMockConfig,
} from "../../helpers/mock-factories.js";
import { makeSSETestServices } from "../../helpers/sse-effect-harness.js";

// Failure modes: idle reconnects disappear behind lifecycle-state deduplication,
// first connections or late subscriptions backfill, one project's reconnect is
// lost, and secondary-instance reconnects invalidate the selected instance.
describe("Shared OpenCode stream reconnect", () => {
	let runtime: ManagedRuntime.ManagedRuntime<OpenCodeInstancesTag, never>;
	let streams: {
		instanceId: string;
		send: (frame: unknown) => void;
		close: () => void;
	}[];
	let disposers: (() => Promise<void>)[];

	beforeEach(() => {
		streams = [];
		disposers = [];
		const endpoints = new Map<string, OpenCodeEndpoint>(
			["opencode", "secondary"].map((instanceId) => [
				instanceId,
				{
					url: `http://${instanceId}.test`,
					status: "healthy",
					managed: true,
				},
			]),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>(async (input, init) => {
				const request = new Request(input, init);
				const url = new URL(request.url);
				if (url.pathname === "/global/event") {
					let ended = false;
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							const send = (frame: unknown) =>
								controller.enqueue(
									new TextEncoder().encode(
										`data: ${JSON.stringify(frame)}\n\n`,
									),
								);
							const close = () => {
								if (ended) return;
								ended = true;
								controller.close();
							};
							streams.push({
								instanceId: url.hostname.split(".")[0] ?? "",
								send,
								close,
							});
							request.signal.addEventListener("abort", close, { once: true });
							send({
								payload: { id: "connected", type: "server.connected" },
							});
						},
						cancel() {
							ended = true;
						},
					});
					return new Response(body, {
						headers: { "content-type": "text/event-stream" },
					});
				}
				if (url.pathname === "/global/health")
					return Response.json({ healthy: true });
				if (url.pathname === "/path")
					return Response.json({
						state: "/",
						config: "/",
						worktree: "/",
						directory: "/project-a",
					});
				if (url.pathname === "/session/status") return Response.json({});
				if (url.pathname === "/permission" || url.pathname === "/question")
					return Response.json([]);
				throw new Error(`Unexpected OpenCode request: ${request.url}`);
			}),
		);
		runtime = ManagedRuntime.make(
			makeOpenCodeInstancesLive(
				(instanceId) => Effect.sync(() => endpoints.get(instanceId)),
				{ log: createSilentLogger(), idleTimeoutMs: 120_000 },
			),
		);
	});

	afterEach(async () => {
		await Promise.all(disposers.map((dispose) => dispose()));
		await runtime.dispose();
		vi.unstubAllGlobals();
	});

	async function attachProject(projectDir: string) {
		const instances = await runtime.runPromise(OpenCodeInstancesTag);
		const project = ManagedRuntime.make(
			Layer.mergeAll(
				makeSSETestServices().layer,
				SSEStreamLive.pipe(
					Layer.provide(
						Layer.mergeAll(
							Layer.succeed(OpenCodeInstancesTag, instances),
							Layer.succeed(ConfigTag, makeMockConfig({ projectDir })),
						),
					),
				),
			),
		);
		disposers.push(() => project.dispose());
		const stream = await project.runPromise(SSEStreamTag);
		const onReconnect = vi.fn((_instanceId?: string) => Effect.void);
		const onSSEEventEffect = vi.fn(() =>
			Effect.succeed({
				ok: false as const,
				reason: "not-translatable" as const,
			}),
		);
		const deps = createMockSSEWiringDeps({
			opencodeRuntimeIngress: { onReconnect, onSSEEventEffect },
		});
		await project.runPromise(wireSSEConsumerEffect(deps, stream));
		const connected = vi.fn();
		stream.on("connected", connected);
		await project.runPromise(
			stream.wireInstanceStreams((channel, instanceId) =>
				wireSSEConsumerEffect(
					{ ...deps, providerInstanceId: instanceId },
					channel,
				),
			),
		);
		await project.runPromise(stream.connectEffect());
		return { stream, connected, onReconnect, onSSEEventEffect };
	}

	const start = (instanceId = "opencode") =>
		runtime.runPromise(
			Effect.flatMap(OpenCodeInstancesTag, (instances) =>
				Effect.scoped(instances.use(instanceId)),
			),
		);

	it("reconnects every project after an idle managed stream closes without a lifecycle transition", async () => {
		const projects = await Promise.all([
			attachProject("/project-a"),
			attachProject("/project-b"),
		]);
		await start();
		await vi.waitFor(() => {
			for (const project of projects)
				expect(project.connected).toHaveBeenCalledOnce();
		});
		for (const project of projects) {
			project.connected.mockClear();
			project.onReconnect.mockClear();
		}
		expect(streams).toHaveLength(1);
		streams[0]?.close();
		await vi.waitFor(() => expect(streams).toHaveLength(2), { timeout: 5_000 });
		await vi.waitFor(() => {
			for (const project of projects) {
				expect(project.connected).toHaveBeenCalledOnce();
				expect(project.onReconnect).toHaveBeenCalledExactlyOnceWith("opencode");
			}
		});

		// A new SSEStream after explicit stop is also a reconnect for these relays.
		await runtime.runPromise(
			Effect.flatMap(OpenCodeInstancesTag, (instances) =>
				instances.stop("opencode"),
			),
		);
		await start();
		await vi.waitFor(() => {
			for (const project of projects)
				expect(project.onReconnect).toHaveBeenCalledTimes(2);
		});
	});

	it("does not backfill on first connect or when a project attaches to a connected stream", async () => {
		const first = await attachProject("/project-a");
		await start();
		await vi.waitFor(() => expect(first.connected).toHaveBeenCalledOnce());
		expect(first.onReconnect).not.toHaveBeenCalled();
		const late = await attachProject("/project-b");
		await vi.waitFor(() => expect(late.connected).toHaveBeenCalledOnce());
		expect(late.onReconnect).not.toHaveBeenCalled();
		streams[0]?.close();
		await vi.waitFor(
			() => {
				expect(first.onReconnect).toHaveBeenCalledExactlyOnceWith("opencode");
				expect(late.onReconnect).toHaveBeenCalledExactlyOnceWith("opencode");
			},
			{ timeout: 5_000 },
		);
	});

	it("backfills only the reconnected secondary instance after its first project event", async () => {
		const project = await attachProject("/project-a");
		await start("secondary");
		streams[0]?.send({
			directory: "/project-a",
			payload: {
				id: "idle",
				type: "session.status",
				properties: { sessionID: "session-a", status: { type: "idle" } },
			},
		});
		await vi.waitFor(() =>
			expect(project.onSSEEventEffect).toHaveBeenCalledOnce(),
		);
		expect(project.onReconnect).not.toHaveBeenCalled();
		streams[0]?.close();
		await vi.waitFor(
			() => {
				expect(streams).toHaveLength(2);
				expect(project.onReconnect).toHaveBeenCalledExactlyOnceWith(
					"secondary",
				);
			},
			{ timeout: 5_000 },
		);
		expect(project.connected).not.toHaveBeenCalled();
	});
});
