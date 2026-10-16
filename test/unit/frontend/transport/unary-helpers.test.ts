import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectSaveRejected } from "../../../../src/lib/contracts/ws-rpc.js";
import { disposeRuntime } from "../../../../src/lib/frontend/transport/runtime.js";
import type {
	TrafficClass,
	WsRpcConnect,
} from "../../../../src/lib/frontend/transport/shared-client.js";
import {
	saveProjectRpc,
	setLogLevelRpc,
	syncInputDraftRpc,
} from "../../../../src/lib/frontend/transport/ws-rpc-client.js";
import { makeRpcWire } from "../../../helpers/rpc-wire.js";

const harness = vi.hoisted(() => ({
	connect: undefined as WsRpcConnect | undefined,
	saveFailure: undefined as ProjectSaveRejected | undefined,
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
	harness.saveFailure = undefined;
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
			send() {}
			close() {
				this.readyState = 3;
			}
		},
	);
	harness.connect = ({ url, trafficClass }) =>
		Effect.gen(function* () {
			const transport = { url, trafficClass, tags: [] as string[] };
			transports.push(transport);
			return yield* makeRpcWire(
				{
					SetLogLevel: () => ({ ok: true }),
					SyncInputDraft: () => ({ ok: true }),
					SaveProject: () => {
						if (harness.saveFailure) throw harness.saveFailure;
						throw new Error("SaveProject fixture not installed");
					},
				},
				{
					beforeSend: (frame) =>
						Effect.sync(() => {
							if (frame._tag === "Request") transport.tags.push(frame.tag);
						}),
				},
			).connect({ url, trafficClass });
		});
});

it("preserves typed folder issues at the SaveProject Promise boundary", async () => {
	const failure = new ProjectSaveRejected({
		issues: [
			{
				kind: "mkdir-failed",
				path: "/missing/parent/notes",
				message: "ENOENT",
			},
		],
	});
	harness.saveFailure = failure;

	await expect(
		saveProjectRpc({
			projectSlug: "alpha",
			title: "Notes",
			folders: [{ path: "/missing/parent/notes", create: { gitInit: true } }],
		}),
	).rejects.toEqual(failure);
});

afterEach(async () => {
	await disposeRuntime();
	vi.unstubAllGlobals();
});

it("shares one control transport across unary helpers and projects", async () => {
	await Promise.all([
		setLogLevelRpc({ projectSlug: "alpha", level: "debug" }),
		syncInputDraftRpc({ sessionId: "s1", text: "draft" }),
	]);
	await setLogLevelRpc({ projectSlug: "alpha", level: "info" });
	await syncInputDraftRpc({
		sessionId: "s2",
		text: "other",
	});
	await setLogLevelRpc({ projectSlug: "beta", level: "info" });
	// Include legacy attempts in the assertion diagnostic for the red run.
	expect({ legacySockets }).toEqual({ legacySockets: [] });
	expect(transports).toEqual([
		{
			url: "ws://localhost:2633/rpc",
			trafficClass: "control",
			tags: [
				"SetLogLevel",
				"SyncInputDraft",
				"SetLogLevel",
				"SyncInputDraft",
				"SetLogLevel",
			],
		},
		{
			url: "ws://localhost:2633/rpc",
			trafficClass: "stream",
			tags: [],
		},
	]);
});
