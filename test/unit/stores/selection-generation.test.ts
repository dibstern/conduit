// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type {
	GetAgentsResponse,
	GetCommandsResponse,
	GetModelsResponse,
	ViewSessionResponse,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	getAgentsRpc,
	getCommandsRpc,
	getModelsRpc,
} from "../../../src/lib/frontend/transport/ws-rpc-client.js";

vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/transport/ws-rpc-client.js")
		>()),
		getAgentsRpc: vi.fn(),
		getCommandsRpc: vi.fn(),
		getModelsRpc: vi.fn(),
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
	clearDiscoveryState,
	discoveryState,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	clearSessionState,
	sendNewSession,
	sessionCreation,
	sessionState,
	switchToSession,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";

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
	vi.mocked(getModelsRpc)
		.mockReset()
		.mockResolvedValue({ projectSlug: "project-a", providers: [] });
	clearSessionState();
	clearDiscoveryState();
	routerState.path = "/";
	attachedProjectState.slug = "project-a";
});

it("applies discovery RPCs only for the selection that requested them, including A-B-A", async () => {
	const agents = deferred<GetAgentsResponse>();
	const commands = deferred<GetCommandsResponse>();
	const models = deferred<GetModelsResponse>();
	vi.mocked(getAgentsRpc).mockReturnValueOnce(agents.promise);
	vi.mocked(getCommandsRpc).mockReturnValueOnce(commands.promise);
	vi.mocked(getModelsRpc).mockReturnValueOnce(models.promise);
	select("A");
	select("B");
	vi.mocked(getAgentsRpc).mockResolvedValueOnce({
		projectSlug: "project-a",
		providerScope: { id: "opencode", name: "OpenCode" },
		agents: [{ id: "new-agent", name: "New agent" }],
	});
	vi.mocked(getCommandsRpc).mockResolvedValueOnce({
		projectSlug: "project-a",
		commands: [{ name: "new-command" }],
	});
	vi.mocked(getModelsRpc).mockResolvedValueOnce({
		projectSlug: "project-a",
		providers: [],
		active: { model: "new-model", provider: "new-provider" },
	});
	select("A");
	await Promise.resolve();
	expect(discoveryState.agents.map((agent) => agent.id)).toEqual(["new-agent"]);
	expect(discoveryState.commands.map((command) => command.name)).toEqual([
		"new-command",
	]);
	expect(discoveryState.currentModelId).toBe("new-model");
	agents.resolve({
		projectSlug: "project-a",
		providerScope: { id: "opencode", name: "OpenCode" },
		agents: [{ id: "old-agent", name: "Old agent" }],
	});
	commands.resolve({
		projectSlug: "project-a",
		commands: [{ name: "old-command" }],
	});
	models.resolve({
		projectSlug: "project-a",
		providers: [],
		active: { model: "old-model", provider: "old-provider" },
	});
	await Promise.resolve();
	expect(discoveryState.agents.map((agent) => agent.id)).toEqual(["new-agent"]);
	expect(discoveryState.commands.map((command) => command.name)).toEqual([
		"new-command",
	]);
	expect(discoveryState.currentModelId).toBe("new-model");
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

it("completes creation without moving a newer selection", async () => {
	const creation = deferred<{
		readonly sessionId: string;
		readonly projectSlug: string;
	}>();
	const requestId = sendNewSession(() => creation.promise);
	expect(requestId).not.toBeNull();
	select("B");
	creation.resolve({ sessionId: "late-create", projectSlug: "project-a" });
	await Promise.resolve();
	expect(sessionState.currentId).toBe("B");
	expect(routerState.path).toBe("/s/B");
	expect(sessionCreation.value.phase).toBe("idle");
});

it("keeps B's model when A's model metadata arrives last", () => {
	select("B");
	handleMessage({
		type: "model_info",
		sessionId: "B",
		model: "model-b",
		provider: "provider-b",
	});
	handleMessage({
		type: "model_info",
		sessionId: "A",
		model: "model-a",
		provider: "provider-a",
	});
	expect(discoveryState.currentModelId).toBe("model-b");
	expect(discoveryState.currentProviderId).toBe("provider-b");
});
