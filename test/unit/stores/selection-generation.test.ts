// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type {
	GetAgentsResponse,
	GetCommandsResponse,
	GetModelsResponse,
	ViewSessionResponse,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { rpc } from "../../../src/lib/frontend/transport/ws-rpc-client.js";

const { getAgentsRpc, getCommandsRpc, getModelsRpc } = vi.hoisted(() => ({
	getAgentsRpc:
		vi.fn<
			(
				input: Parameters<typeof rpc<"GetAgents">>[1],
			) => Promise<GetAgentsResponse>
		>(),
	getCommandsRpc:
		vi.fn<
			(
				input: Parameters<typeof rpc<"GetCommands">>[1],
			) => Promise<GetCommandsResponse>
		>(),
	getModelsRpc:
		vi.fn<
			(
				input: Parameters<typeof rpc<"GetModels">>[1],
			) => Promise<GetModelsResponse>
		>(),
}));

vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/transport/ws-rpc-client.js")
		>()),
		rpc: (tag: "GetAgents" | "GetCommands" | "GetModels", input: never) =>
			({
				GetAgents: getAgentsRpc,
				GetCommands: getCommandsRpc,
				GetModels: getModelsRpc,
			})[tag](input),
	}),
);

vi.hoisted(() => {
	const values = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
	});
});

import { inputSyncState } from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	applyGetModelsResponse,
	clearDiscoveryState,
	discoveryState,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	clearSessionState,
	sessionState,
	switchToSession,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	applySessionChange,
	resetSessionSubscription,
} from "../../../src/lib/frontend/transport/session-subscription.svelte.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function select(
	sessionId: string,
	view = () => Promise.resolve({ ok: true as const }),
) {
	switchToSession(sessionId, "project-a", view);
}

beforeEach(() => {
	vi.mocked(getAgentsRpc)
		.mockReset()
		.mockResolvedValue({
			projectSlug: "project-a",
			providerScope: { id: "opencode", name: "OpenCode" },
			agents: [],
		});
	vi.mocked(getCommandsRpc)
		.mockReset()
		.mockResolvedValue({ projectSlug: "project-a", commands: [] });
	vi.mocked(getModelsRpc).mockReset().mockResolvedValue({
		projectSlug: "project-a",
		instanceId: "opencode",
		providers: [],
	});
	clearSessionState();
	clearDiscoveryState();
	resetSessionSubscription();
	routerState.path = "/";
	attachedProjectState.slug = "project-a";
});

it("ignores a draft returned after the selection moves on", async () => {
	const oldView = deferred<ViewSessionResponse>();
	select("A", () => oldView.promise);
	select("B", () => Promise.resolve({ ok: true, draft: "B draft" }));
	await Promise.resolve();
	oldView.resolve({ ok: true, draft: "A draft" });
	await Promise.resolve();
	expect(sessionState.currentId).toBe("B");
	expect(routerState.path).toBe("/s/B");
	expect(inputSyncState.text).toBe("B draft");
});

it("keeps B's GetModels pick when A's row changes model last", async () => {
	applyGetModelsResponse(
		{
			projectSlug: "project-a",
			instanceId: "opencode",
			providers: [],
			active: { model: "model-b0", provider: "provider-b" },
		},
		"B",
	);
	select("B");
	await Promise.resolve();
	const refresh = deferred<GetModelsResponse>();
	vi.mocked(getModelsRpc).mockReturnValueOnce(refresh.promise);
	const row = (id: string, model: string, provider: string) => ({
		projectSlug: "project-a",
		accountId: null,
		id,
		title: id,
		status: "idle" as const,
		model: { model, provider },
	});
	applySessionChange({
		_tag: "snapshot",
		sequence: 1,
		rows: [
			row("A", "model-a0", "provider-a"),
			row("B", "model-b0", "provider-b"),
		],
	});
	applySessionChange({
		_tag: "upsert",
		sequence: 2,
		item: row("B", "model-b", "provider-b"),
	});
	applySessionChange({
		_tag: "upsert",
		sequence: 3,
		item: row("A", "model-a", "provider-a"),
	});
	expect(discoveryState.currentModelId).toBe("model-b0");
	expect(getModelsRpc).toHaveBeenCalledTimes(1);
	expect(getModelsRpc).toHaveBeenLastCalledWith({
		sessionId: "B",
	});
	refresh.resolve({
		projectSlug: "project-a",
		instanceId: "opencode",
		providers: [],
		active: { model: "model-b", provider: "provider-b" },
	});
	await Promise.resolve();
	expect(discoveryState.currentModelId).toBe("model-b");
	expect(discoveryState.currentProviderId).toBe("provider-b");
});
