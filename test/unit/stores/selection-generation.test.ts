// @vitest-environment jsdom

import { Schema } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import type {
	GetAgentsResponse,
	GetCommandsResponse,
	GetModelsResponse,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	getAgentsRpc,
	getCommandsRpc,
	getModelsRpc,
} from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import { RequestId } from "../../../src/lib/shared-types.js";

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
	routerState,
	syncSlugState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	clearSessionState,
	sendNewSession,
	sessionCreation,
	sessionState,
	switchToSession,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";

function select(sessionId: string): RequestId {
	let requestId: RequestId | undefined;
	switchToSession(sessionId, (input) => {
		requestId = Schema.decodeUnknownSync(RequestId)(input.requestId);
	});
	if (!requestId) throw new Error("ViewSession must send a requestId");
	return requestId;
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
	routerState.path = "/p/project-a";
	syncSlugState(routerState.path);
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

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
	const newest = select("A");
	handleMessage({
		type: "session_switched",
		id: "A",
		sessionId: "A",
		requestId: newest,
	});
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
	expect
		.soft(discoveryState.agents.map((agent) => agent.id))
		.toEqual(["new-agent"]);
	expect
		.soft(discoveryState.commands.map((command) => command.name))
		.toEqual(["new-command"]);
	expect.soft(discoveryState.currentModelId).toBe("new-model");
	expect.soft(discoveryState.currentProviderId).toBe("new-provider");
});

it("keeps B selected and in the URL when A's switch confirmation arrives last", () => {
	const a = select("A");
	const b = select("B");
	handleMessage({
		type: "session_switched",
		id: "B",
		sessionId: "B",
		requestId: b,
		inputText: "B draft",
	});
	handleMessage({
		type: "session_switched",
		id: "A",
		sessionId: "A",
		requestId: a,
		inputText: "A draft",
	});
	expect.soft(sessionState.currentId).toBe("B");
	expect.soft(routerState.path).toBe("/p/project-a/s/B");
	expect(inputSyncState.text).toBe("B draft");
});

it("accepts the current CreateSession confirmation and rejects it after a newer selection", () => {
	const created = sendNewSession(() => {});
	if (!created) throw new Error("Expected a creation request");
	handleMessage({
		type: "session_switched",
		id: "created",
		sessionId: "created",
		requestId: created,
	});
	expect(sessionState.currentId).toBe("created");
	expect(sessionCreation.value.phase).toBe("idle");
	const superseded = sendNewSession(() => {});
	if (!superseded) throw new Error("Expected another creation request");
	select("B");
	handleMessage({
		type: "session_switched",
		id: "late-create",
		sessionId: "late-create",
		requestId: superseded,
	});
	expect(sessionState.currentId).toBe("B");
	expect(routerState.path).toBe("/p/project-a/s/B");
});

it.each([
	"server switch",
	"project reset",
	"empty-id switch",
])("invalidates outstanding metadata on %s", async (reason) => {
	const models = deferred<GetModelsResponse>();
	vi.mocked(getModelsRpc).mockReturnValueOnce(models.promise);
	select("A");
	if (reason === "project reset") clearSessionState();
	else if (reason === "empty-id switch")
		handleMessage({ type: "session_switched", id: "", sessionId: "" });
	else handleMessage({ type: "session_switched", id: "B", sessionId: "B" });
	models.resolve({
		projectSlug: "project-a",
		providers: [],
		active: { model: "old-model", provider: "old-provider" },
	});
	await Promise.resolve();
	expect(discoveryState.currentModelId).toBe("");
	expect(discoveryState.currentProviderId).toBe("");
});

it("selects a server-initiated session without a preceding click", () => {
	handleMessage({ type: "session_switched", id: "A", sessionId: "A" });
	expect(sessionState.currentId).toBe("A");
	expect(routerState.path).toBe("/p/project-a/s/A");
});

it("rejects an abandoned selection confirmation after an empty-id switch", () => {
	const abandoned = select("B");
	handleMessage({ type: "session_switched", id: "", sessionId: "" });
	const draft = inputSyncState.text;
	handleMessage({
		type: "session_switched",
		id: "B",
		sessionId: "B",
		requestId: abandoned,
		inputText: "abandoned draft",
	});
	expect(inputSyncState.text).toBe(draft);
});

// A delete-survivor switch can arrive while A's ViewSession is still pending.
// It carries no requestId, unlike the superseded client confirmation above.
it("accepts a server delete-survivor switch to A while A's earlier view is pending", () => {
	switchToSession("A", () => {});
	switchToSession("B", () => {});
	handleMessage({ type: "session_switched", id: "B", sessionId: "B" });
	handleMessage({ type: "session_switched", id: "A", sessionId: "A" });
	expect(sessionState.currentId).toBe("A");
	expect(routerState.path).toBe("/p/project-a/s/A");
});

it("accepts an uncorrelated server switch while a client selection is outstanding", () => {
	const b = select("B");
	handleMessage({
		type: "session_switched",
		id: "survivor",
		sessionId: "survivor",
	});
	expect(sessionState.currentId).toBe("survivor");
	expect(routerState.path).toBe("/p/project-a/s/survivor");
	handleMessage({
		type: "session_switched",
		id: "B",
		sessionId: "B",
		requestId: b,
	});
	expect(sessionState.currentId).toBe("survivor");
	expect(routerState.path).toBe("/p/project-a/s/survivor");
});

it("keeps B's active model and provider when A's model metadata arrives last", () => {
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

	handleMessage({
		type: "model_info",
		model: "unscoped",
		provider: "unscoped",
	});
	expect(discoveryState.currentModelId).toBe("model-b");
	expect(discoveryState.currentProviderId).toBe("provider-b");
});
