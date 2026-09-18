import { RpcClient, type RpcMessage } from "@effect/rpc";
import { Effect, Exit } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { disposeRuntime } from "../../../../src/lib/frontend/transport/runtime.js";
import type {
	TrafficClass,
	WsRpcConnect,
} from "../../../../src/lib/frontend/transport/shared-client.js";
import { WsRpcGroup } from "../../../../src/lib/frontend/transport/ws-rpc.js";
import {
	setLogLevelRpc,
	syncInputDraftRpc,
} from "../../../../src/lib/frontend/transport/ws-rpc-client.js";

const harness = vi.hoisted(() => ({
	connect: undefined as WsRpcConnect | undefined,
}));

// Replace only the transport factory; use the real shared service and runtime.
vi.mock(
	"../../../../src/lib/frontend/transport/shared-client.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../../src/lib/frontend/transport/shared-client.js")
			>();
		return {
			...actual,
			WsRpcClientsLayer: actual.makeWsRpcClientsLayer((options) => {
				if (!harness.connect)
					throw new Error("transport fixture not installed");
				return harness.connect(options);
			}),
		};
	},
);

const transports: Array<{
	url: string;
	trafficClass: TrafficClass;
	tags: string[];
}> = [];
const legacySockets: string[] = [];

beforeEach(() => {
	transports.length = 0;
	legacySockets.length = 0;
	vi.stubGlobal("location", { protocol: "http:", host: "localhost:2633" });
	// Answer the pre-migration path too, so red measures sockets, not a timeout.
	vi.stubGlobal(
		"WebSocket",
		class extends EventTarget {
			readyState = 1;
			constructor(url: string) {
				super();
				legacySockets.push(url);
			}
			send(data: string) {
				const message = JSON.parse(data);
				if (message._tag === "Request")
					queueMicrotask(() =>
						this.dispatchEvent(
							new MessageEvent("message", {
								data: JSON.stringify({
									_tag: "Exit",
									requestId: message.id,
									exit: { _tag: "Success", value: { ok: true } },
								}),
							}),
						),
					);
			}
			close() {
				this.readyState = 3;
			}
		},
	);
	harness.connect = ({ url, trafficClass }) =>
		Effect.gen(function* () {
			const transport = { url, trafficClass, tags: [] as string[] };
			transports.push(transport);
			let respond:
				| ((requestId: RpcMessage.RequestId) => Effect.Effect<void>)
				| undefined;
			const built = yield* RpcClient.makeNoSerialization(WsRpcGroup, {
				onFromClient: ({ message }) =>
					message._tag === "Request"
						? Effect.suspend(() => {
								transport.tags.push(message.tag);
								return respond?.(message.id) ?? Effect.void;
							})
						: Effect.void,
			});
			respond = (requestId) =>
				built.write({
					_tag: "Exit",
					clientId: 0,
					requestId,
					exit: Exit.succeed({ ok: true }),
				});
			return built.client;
		});
});

afterEach(async () => {
	await disposeRuntime();
	vi.unstubAllGlobals();
});

it("shares one control transport across unary helpers and opens a new pair for a second project", async () => {
	await Promise.all([
		setLogLevelRpc({ projectSlug: "alpha", level: "debug" }),
		syncInputDraftRpc({ projectSlug: "alpha", sessionId: "s1", text: "draft" }),
	]);
	await setLogLevelRpc({ projectSlug: "alpha", level: "info" });
	// Include legacy attempts in the assertion diagnostic for the red run.
	expect({
		legacySockets,
		controls: transports.filter((t) => t.trafficClass === "control").length,
	}).toEqual({ legacySockets: [], controls: 1 });
	expect(transports).toEqual([
		{
			url: "ws://localhost:2633/p/alpha/rpc",
			trafficClass: "control",
			tags: ["SetLogLevel", "SyncInputDraft", "SetLogLevel"],
		},
		{
			url: "ws://localhost:2633/p/alpha/rpc",
			trafficClass: "stream",
			tags: [],
		},
	]);
	await syncInputDraftRpc({
		projectSlug: "beta",
		sessionId: "s2",
		text: "other",
	});
	await setLogLevelRpc({ projectSlug: "beta", level: "info" });
	expect(transports.slice(2)).toEqual([
		{
			url: "ws://localhost:2633/p/beta/rpc",
			trafficClass: "control",
			tags: ["SyncInputDraft", "SetLogLevel"],
		},
		{ url: "ws://localhost:2633/p/beta/rpc", trafficClass: "stream", tags: [] },
	]);
});
