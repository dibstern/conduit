import { Deferred, Effect, HashMap, Layer, ManagedRuntime, Ref } from "effect";
import { expect, it, vi } from "vitest";
import { ConfigPersistenceNoopLive } from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import { OpenCodeInstancesLive } from "../../../src/lib/domain/daemon/Layers/opencode-instances-layer.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { InstanceHealthCheckTag } from "../../../src/lib/domain/daemon/Services/instance-health-service.js";
import {
	getInstances,
	InstanceManagerStateTag,
	makeInstanceManagerStateLive,
	removeInstance,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { stopManagedOpenCode } from "../../../src/lib/instance/managed-opencode-process.js";
import { sdkDefaultClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";

vi.mock(
	"../../../src/lib/instance/managed-opencode-process.js",
	async (original) => ({
		...(await original<
			typeof import("../../../src/lib/instance/managed-opencode-process.js")
		>()),
		stopManagedOpenCode: vi.fn(),
	}),
);

// Removal must interrupt the immediate probe owned by OpenCode Instances, not
// only the manager's periodic health poller, even when the default resolver
// falls back to another instance. Scope cleanup must not prove interruption.
it.each([
	false,
	true,
])("interrupts a pending stream-loss health probe when the real manager removes its instance (surviving instance=%s)", async (survivingInstance) => {
	const entered = await Effect.runPromise(Deferred.make<void>());
	const interrupted = vi.fn();
	let disconnect: (() => void) | undefined;
	vi.mocked(stopManagedOpenCode).mockResolvedValue(true);
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			if (path === "/global/event") {
				let ended = false;
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						disconnect = () => {
							if (ended) return;
							ended = true;
							controller.close();
						};
						request.signal.addEventListener("abort", disconnect, {
							once: true,
						});
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({ payload: { id: "connected", type: "server.connected" } })}\n\n`,
							),
						);
					},
					cancel() {
						ended = true;
					},
				});
				return new Response(body, {
					headers: { "content-type": "text/event-stream" },
				});
			}
			if (path === "/global/health") return Response.json({ healthy: true });
			if (path === "/path")
				return Response.json({
					state: "/",
					config: "/",
					worktree: "/",
					directory: "/project-a",
				});
			if (path === "/session/status") return Response.json({});
			if (path === "/permission" || path === "/question")
				return Response.json([]);
			throw new Error(`Unexpected OpenCode request: ${request.url}`);
		}),
	);
	const dependencies = Layer.mergeAll(
		makeInstanceManagerStateLive(
			undefined,
			[
				{
					id: "opencode",
					name: "Removal probe",
					port: 4310,
					managed: true,
					pid: 1234,
				},
				...(survivingInstance
					? [
							{
								id: "secondary",
								name: "Surviving managed instance",
								port: 4320,
								managed: true,
								pid: 1235,
							},
						]
					: []),
			],
			{ launchLogin: sdkDefaultClaudeConfigDir("/isolated-test-home/.claude") },
		),
		DaemonEventBusLive,
		ConfigPersistenceNoopLive,
		Layer.succeed(InstanceHealthCheckTag)({
			check: () =>
				Deferred.succeed(entered, undefined).pipe(
					Effect.andThen(Effect.never),
					Effect.onInterrupt(() => Effect.sync(() => interrupted())),
				),
		}),
	);
	const runtime = ManagedRuntime.make(
		OpenCodeInstancesLive.pipe(Layer.provideMerge(dependencies)),
	);
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				// Seed a running managed endpoint without starting a real process.
				yield* Ref.update(yield* InstanceManagerStateTag, (state) => ({
					...state,
					instances: HashMap.map(state.instances, (instance) => ({
						...instance,
						status: "healthy" as const,
					})),
				}));
				const instances = yield* OpenCodeInstancesTag;
				yield* instances.use("opencode").pipe(Effect.scoped);
			}),
		);
		expect(disconnect).toBeDefined();
		disconnect?.();
		await runtime.runPromise(
			Deferred.await(entered).pipe(Effect.timeout("1 second")),
		);
		await runtime.runPromise(removeInstance("opencode"));
		expect(Array.from(await runtime.runPromise(getInstances))).toEqual(
			survivingInstance
				? [expect.objectContaining({ id: "secondary", status: "healthy" })]
				: [],
		);
		expect(stopManagedOpenCode).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(interrupted).toHaveBeenCalledTimes(1));
	} finally {
		await runtime.dispose();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	}
});
