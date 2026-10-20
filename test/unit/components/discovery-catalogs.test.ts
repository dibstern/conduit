import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { Effect, ManagedRuntime, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VisibilitySettingsTab from "../../../src/lib/frontend/components/overlays/VisibilitySettingsTab.svelte";
import * as discovery from "../../../src/lib/frontend/stores/discovery.svelte.js";
import {
	applyInstanceListResponse,
	clearInstanceState,
} from "../../../src/lib/frontend/stores/instance.svelte.js";
import {
	applyProjectSetting,
	viewProjectSettings,
} from "../../../src/lib/frontend/stores/project-settings.js";
import { projectState } from "../../../src/lib/frontend/stores/project-state.svelte.js";
import {
	attachedProjectState,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import { selection } from "../../../src/lib/frontend/stores/selection.svelte.js";
import {
	clearSessionState,
	reloadProviderSession,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import { connectionState } from "../../../src/lib/frontend/transport/connection-status.svelte.js";
import {
	makeWsRpcClientsLayer,
	type WsRpcClients,
} from "../../../src/lib/frontend/transport/shared-client.js";
import type {
	GetAgentsResponse,
	GetCommandsResponse,
	GetModelsResponse,
	ProjectSettingsEnvelope,
} from "../../../src/lib/frontend/transport/ws-rpc.js";
import { makeRpcWire } from "../../helpers/rpc-wire.js";
import {
	applySessionUpsert,
	seedSessions,
} from "../stores/session-fixtures.js";

const runtimeMock = vi.hoisted(() => ({
	getRuntime: vi.fn(),
	runTransportEffect: vi.fn(),
}));
vi.mock("../../../src/lib/frontend/transport/runtime.js", () => runtimeMock);

function pending<A>() {
	let resolve!: (value: A) => void;
	const promise = new Promise<A>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const models = (name: string, instanceId = "one"): GetModelsResponse => ({
	projectSlug: "project-a",
	instanceId,
	providers: [
		{
			id: "opencode",
			name: "OpenCode",
			configured: true,
			models: [{ id: name, name, provider: "opencode" }],
		},
	],
	active: { model: name, provider: "opencode" },
});
const agents = (name: string): GetAgentsResponse => ({
	projectSlug: "project-a",
	providerScope: { id: "opencode", name: "OpenCode" },
	agents: [{ id: name, name }],
});

let runtime: ManagedRuntime.ManagedRuntime<WsRpcClients, never>;
let stop: (() => void) | undefined;
let modelReads: ReturnType<typeof pending<GetModelsResponse>>[];
let agentReads: ReturnType<typeof pending<GetAgentsResponse>>[];
let commandReads: ReturnType<typeof pending<GetCommandsResponse>>[];
let settingsRead: ReturnType<typeof pending<ProjectSettingsEnvelope>>;
let settingsProjects: string[];
let inventoryReads: ReturnType<typeof pending<GetModelsResponse>>[];

beforeEach(() => {
	clearSessionState();
	discovery.clearDiscoveryState();
	clearInstanceState();
	attachedProjectState.slug = "project-a";
	projectState.projects = [
		{ slug: "project-a", title: "Project A", folders: ["/project-a"] },
	];
	routerState.path = "/new";
	routerState.search = "?project=project-a";
	connectionState.status = "connected";
	applyInstanceListResponse({
		instances: ["one", "two"].map((id, index) => ({
			id,
			name: id,
			driver: "opencode",
			isDefault: index === 0,
			port: 0,
			managed: true,
			status: "healthy",
			restartCount: 0,
			createdAt: 0,
		})),
	});
	discovery.selectInstance("one");
	modelReads = [];
	agentReads = [];
	commandReads = [];
	settingsRead = pending<ProjectSettingsEnvelope>();
	settingsProjects = [];
	inventoryReads = [pending<GetModelsResponse>(), pending<GetModelsResponse>()];
	uiState.clientCount = 0;
	const wire = makeRpcWire({
		SubscribeDraftModels: () =>
			Stream.fromIterable(inventoryReads).pipe(
				Stream.mapEffect((read) => Effect.promise(() => read.promise)),
				Stream.concat(Stream.never),
			),
		ReloadProviderSession: ({ sessionId }) => ({
			projectSlug: "project-a",
			sessionId,
		}),
		SubscribeProjectSettings: ({ projectSlug }) => {
			settingsProjects.push(projectSlug);
			return Stream.fromEffect(Effect.promise(() => settingsRead.promise)).pipe(
				Stream.concat(
					Stream.succeed<ProjectSettingsEnvelope>({
						_tag: "upsert",
						sequence: 2,
						item: { _tag: "clientCount", count: 7 },
					}),
				),
				Stream.concat(Stream.never),
			);
		},
		GetModels: () => {
			const read = pending<GetModelsResponse>();
			modelReads.push(read);
			return read.promise;
		},
		GetAgents: () => {
			const read = pending<GetAgentsResponse>();
			agentReads.push(read);
			return read.promise;
		},
		GetCommands: () => {
			const read = pending<GetCommandsResponse>();
			commandReads.push(read);
			return read.promise;
		},
		ViewSession: () => ({ ok: true }),
	});
	runtime = ManagedRuntime.make(makeWsRpcClientsLayer(wire.connect));
	runtimeMock.getRuntime.mockResolvedValue(runtime);
	runtimeMock.runTransportEffect.mockImplementation((effect) =>
		runtime.runPromise(effect),
	);
});

afterEach(async () => {
	cleanup();
	stop?.();
	stop = undefined;
	viewProjectSettings(null);
	discovery.viewDraftModels(null);
	await runtime.dispose();
	clearSessionState();
	discovery.clearDiscoveryState();
	attachedProjectState.slug = null;
	runtimeMock.getRuntime.mockReset();
	runtimeMock.runTransportEffect.mockReset();
});

describe("discovery catalogs over the RPC wire", () => {
	it.each([
		"one",
		"claude-work",
	])("shows the default Claude account's model name and effort in settings while viewing %s", async (accountId) => {
		applyInstanceListResponse({
			instances: [
				{ id: "one", driver: "opencode", isDefault: true },
				{ id: "claude", driver: "claude", isDefault: true },
				{ id: "claude-work", driver: "claude", isDefault: false },
			].map((account) => ({
				...account,
				name: account.id,
				port: 0,
				managed: false,
				status: "healthy" as const,
				restartCount: 0,
				createdAt: 0,
			})),
		});
		seedSessions([{ id: "A", title: "A", accountId }]);
		selection.open("A");
		for (const [account, name] of [
			["claude", "Claude Sonnet 4"],
			["claude-work", "Work account model"],
		] as const) {
			applyProjectSetting({
				_tag: "providerModels",
				accountId: account,
				providers: [
					{
						id: "claude",
						name: "Claude",
						configured: true,
						models: [
							{ id: "sonnet", name, provider: "claude", variants: ["high"] },
						],
					},
				],
			});
		}
		applyProjectSetting({
			_tag: "harnessDefaults",
			claude: {
				status: "ok",
				pick: {
					providerId: "claude",
					modelId: "sonnet",
					effort: "high",
					contextWindow: "",
				},
			},
		});
		const view = render(VisibilitySettingsTab);
		const model = view.getByTestId("settings-harness-default-claude-model");
		expect(model.textContent).toContain("Claude Sonnet 4");
		expect(
			view
				.getByTestId("settings-harness-default-claude-effort")
				.getAttribute("data-value"),
		).toBe("high");
		// Default controls must not borrow a custom account's same-id model.
		await fireEvent.click(model);
		expect(
			view
				.getAllByRole("menuitemradio")
				.map((option) => option.textContent?.trim()),
		).toEqual(["Claude Sonnet 4"]);
		await vi.waitFor(() => expect(modelReads).toHaveLength(1));
	});

	it.each([
		false,
		true,
	])("uses a named account's fresh native default and keeps it after another account replies, shared model %s", async (sharedModel) => {
		applyProjectSetting({
			_tag: "harnessDefaults",
			opencode: {
				status: "ok",
				pick: {
					modelId: "A",
					providerId: "opencode",
					effort: "",
					contextWindow: "",
				},
			},
		});
		applyProjectSetting({
			_tag: "defaultModel",
			model: "A",
			provider: "opencode",
			variant: "",
		});
		discovery.applyGetModelsResponse({
			...models("A"),
			defaultOpenCodeInstanceId: "one",
		});
		const oldRead = discovery.refreshCatalogs();
		await vi.waitFor(() => {
			expect(modelReads).toHaveLength(1);
			expect(agentReads).toHaveLength(1);
			expect(commandReads).toHaveLength(1);
		});
		discovery.selectInstance("two");
		const newRead = discovery.refreshCatalogs();
		await vi.waitFor(() => {
			expect(modelReads).toHaveLength(2);
			expect(agentReads).toHaveLength(2);
			expect(commandReads).toHaveLength(2);
		});
		const reply = models("Y", "two");
		modelReads[1]?.resolve({
			...reply,
			providers: [
				{
					id: "opencode",
					name: "OpenCode",
					configured: true,
					models: (sharedModel ? ["A", "Y"] : ["Y"]).map((id) => ({
						id,
						name: id,
						provider: "opencode",
					})),
				},
			],
		});
		agentReads[1]?.resolve(agents("Account two agent"));
		commandReads[1]?.resolve({ projectSlug: "project-a", commands: [] });
		await newRead;
		expect.soft(discovery.getDraftPick()?.model.modelId).toBe("Y");
		modelReads[0]?.resolve(models("A"));
		agentReads[0]?.resolve(agents("Account one agent"));
		commandReads[0]?.resolve({ projectSlug: "project-a", commands: [] });
		await oldRead;
		expect(discovery.getDraftPick()?.instanceId).toBe("two");
		expect(discovery.getDraftPick()?.model.modelId).toBe("Y");
	});

	it("keeps displaying live draft inventory updates after a catalog refresh", async () => {
		discovery.viewDraftModels("project-a", "one");
		inventoryReads[0]?.resolve(models("Initial inventory"));
		await vi.waitFor(() =>
			expect(
				discovery.discoveryState.providers.flatMap((provider) =>
					provider.models.map((model) => model.name),
				),
			).toEqual(["Initial inventory"]),
		);
		const refreshed = discovery.refreshCatalogs();
		await vi.waitFor(() => expect(commandReads).toHaveLength(1));
		modelReads[0]?.resolve(models("Refreshed inventory"));
		agentReads[0]?.resolve(agents("Refreshed agent"));
		commandReads[0]?.resolve({ projectSlug: "project-a", commands: [] });
		await refreshed;
		inventoryReads[1]?.resolve(models("Live inventory"));
		await vi.waitFor(() =>
			expect(
				discovery.discoveryState.providers.flatMap((provider) =>
					provider.models.map((model) => model.name),
				),
			).toEqual(["Live inventory"]),
		);
	});

	it("reloads by session id and refreshes the displayed model, agent and command lists", async () => {
		seedSessions([{ id: "session", title: "Session", accountId: "one" }]);
		selection.open("session");
		const result = reloadProviderSession("session").catch(
			(error: unknown) => error,
		);
		await vi.waitFor(() => expect(commandReads).toHaveLength(1));
		modelReads[0]?.resolve(models("Reloaded model"));
		agentReads[0]?.resolve(agents("Reloaded agent"));
		commandReads[0]?.resolve({
			projectSlug: "project-a",
			commands: [{ name: "reloaded-command" }],
		});
		await expect(result).resolves.toBeUndefined();
		expect(
			discovery.discoveryState.providers.flatMap((provider) =>
				provider.models.map((model) => model.name),
			),
		).toEqual(["Reloaded model"]);
		expect(discovery.discoveryState.agents.map((agent) => agent.name)).toEqual([
			"Reloaded agent",
		]);
		expect(
			discovery.discoveryState.commands.map((command) => command.name),
		).toEqual(["reloaded-command"]);
	});

	it("an untouched draft follows the new harness default before the refreshed model reply", () => {
		discovery.clearDraftSelection();
		const providers: GetModelsResponse["providers"] = [
			{
				id: "opencode",
				name: "OpenCode",
				configured: true,
				models: ["A", "B"].map((id) => ({
					id,
					name: `Model ${id}`,
					provider: "opencode",
				})),
			},
		];
		applyProjectSetting({
			_tag: "harnessDefaults",
			opencode: {
				status: "ok",
				pick: {
					modelId: "A",
					providerId: "opencode",
					effort: "",
					contextWindow: "",
				},
			},
		});
		applyProjectSetting({
			_tag: "defaultModel",
			model: "A",
			provider: "opencode",
			variant: "",
		});
		discovery.applyGetModelsResponse({
			projectSlug: "project-a",
			instanceId: "one",
			defaultOpenCodeInstanceId: "one",
			providers,
			active: { model: "A", provider: "opencode" },
		});
		expect(discovery.getDraftPick()?.model.modelId).toBe("A");
		applyProjectSetting({
			_tag: "harnessDefaults",
			opencode: {
				status: "ok",
				pick: {
					modelId: "B",
					providerId: "opencode",
					effort: "",
					contextWindow: "",
				},
			},
		});
		applyProjectSetting({
			_tag: "defaultModel",
			model: "B",
			provider: "opencode",
			variant: "",
		});
		expect.soft(discovery.getDraftPick()?.model.modelId).toBe("B");
		discovery.applyGetModelsResponse({
			projectSlug: "project-a",
			instanceId: "one",
			defaultOpenCodeInstanceId: "one",
			providers,
			active: { model: "B", provider: "opencode" },
		});
		expect(discovery.getDraftPick()?.model.modelId).toBe("B");
	});

	it("keeps pushed Claude account models across session pruning and replaces them on each push", async () => {
		applyInstanceListResponse({
			instances: ["one", "two"].map((id, index) => ({
				id,
				name: id,
				driver: "claude",
				isDefault: index === 0,
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 0,
			})),
		});
		seedSessions([
			{ id: "A", title: "A", accountId: "one" },
			{ id: "B", title: "B", accountId: "one" },
		]);
		selection.open("A");
		stop = discovery.watchCatalogs();
		await vi.waitFor(() => expect(modelReads).toHaveLength(1));
		applyProjectSetting({
			_tag: "providerModels",
			accountId: "one",
			providers: [
				{
					id: "claude",
					name: "Claude",
					configured: true,
					models: [{ id: "alpha", name: "Alpha model", provider: "claude" }],
				},
			],
		});
		modelReads[0]?.resolve({
			projectSlug: "project-a",
			instanceId: "one",
			providers: [],
		});
		await vi.waitFor(() =>
			expect(
				discovery
					.getProviderGroupsForInstance("one")
					.flatMap((group) => group.models.map((model) => model.name)),
			).toEqual(["Alpha model"]),
		);
		selection.open("B");
		await vi.waitFor(() => expect(modelReads).toHaveLength(2));
		modelReads[1]?.resolve(models("Server model"));
		await vi.waitFor(() =>
			expect(
				discovery.discoveryState.providers.some((provider) =>
					provider.models.some((model) => model.name === "Server model"),
				),
			).toBe(true),
		);
		expect(
			discovery
				.getProviderGroupsForInstance("one")
				.flatMap((group) => group.models.map((model) => model.name)),
		).toEqual(["Alpha model"]);
		applyProjectSetting({
			_tag: "providerModels",
			accountId: "one",
			providers: [
				{
					id: "claude",
					name: "Claude",
					configured: true,
					models: [
						{ id: "beta", name: "Replacement model", provider: "claude" },
					],
				},
			],
		});
		applyProjectSetting({
			_tag: "providerModels",
			accountId: "two",
			providers: [
				{
					id: "claude",
					name: "Claude",
					configured: true,
					models: [
						{ id: "other", name: "Other account model", provider: "claude" },
					],
				},
			],
		});
		expect(
			discovery
				.getProviderGroupsForInstance("one")
				.flatMap((group) => group.models.map((model) => model.name)),
		).toEqual(["Replacement model"]);
		clearSessionState();
		openSessionForSetup(null);
		discovery.selectInstance("two");
		expect(
			discovery
				.getProviderGroupsForInstance("two")
				.flatMap((group) => group.models.map((model) => model.name)),
		).toEqual(["Other account model"]);
		attachedProjectState.slug = "project-b";
		routerState.search = "?project=project-b";
		expect(discovery.discoveryState.providers).toEqual([]);
	});

	it.each([
		"session",
		"draft",
	] as const)("keeps newer %s catalogs after A-B-A and late first replies", async (kind) => {
		seedSessions([
			{ id: "A", title: "A", accountId: "one" },
			{ id: "B", title: "B", accountId: "one" },
		]);
		if (kind === "session") selection.open("A");
		const firstRead = discovery.refreshCatalogs();
		await vi.waitFor(() => expect(commandReads).toHaveLength(1));
		if (kind === "session") selection.open("B");
		else discovery.selectInstance("two");
		stop = discovery.watchCatalogs();
		await vi.waitFor(() => expect(commandReads).toHaveLength(2));
		if (kind === "session") selection.open("A");
		else discovery.selectInstance("one");
		await vi.waitFor(() => expect(commandReads).toHaveLength(3));
		modelReads[2]?.resolve(models("New model"));
		agentReads[2]?.resolve(agents("New agent"));
		commandReads[2]?.resolve({
			projectSlug: "project-a",
			commands: [{ name: "new-command" }],
		});
		await vi.waitFor(() => {
			expect(
				discovery.discoveryState.providers.flatMap((provider) =>
					provider.models.map((model) => model.name),
				),
			).toEqual(["New model"]);
			expect(
				discovery.discoveryState.agents.map((agent) => agent.name),
			).toEqual(["New agent"]);
			expect(
				discovery.discoveryState.commands.map((command) => command.name),
			).toEqual(["new-command"]);
		});
		modelReads[0]?.resolve(models("Old model"));
		agentReads[0]?.resolve(agents("Old agent"));
		commandReads[0]?.resolve({
			projectSlug: "project-a",
			commands: [{ name: "old-command" }],
		});
		await firstRead;
		expect
			.soft(
				discovery.discoveryState.providers.flatMap((provider) =>
					provider.models.map((model) => model.name),
				),
			)
			.toEqual(["New model"]);
		expect
			.soft(discovery.discoveryState.agents.map((agent) => agent.name))
			.toEqual(["New agent"]);
		expect
			.soft(discovery.discoveryState.commands.map((command) => command.name))
			.toEqual(["new-command"]);
	});

	it("keeps a settings-stream model list under the project that opened the subscription", async () => {
		openSessionForSetup(null);
		applyInstanceListResponse({
			instances: [
				{
					id: "one",
					name: "Claude",
					driver: "claude",
					isDefault: true,
					port: 0,
					managed: false,
					status: "healthy",
					restartCount: 0,
					createdAt: 0,
				},
			],
		});
		viewProjectSettings("project-a");
		await vi.waitFor(() => expect(settingsProjects).toEqual(["project-a"]));
		attachedProjectState.slug = "project-b";
		routerState.search = "?project=project-b";
		settingsRead.resolve({
			_tag: "snapshot",
			sequence: 1,
			rows: [
				{
					_tag: "providerModels",
					accountId: "one",
					providers: [
						{
							id: "claude",
							name: "Claude",
							configured: true,
							models: [
								{ id: "alpha", name: "Alpha model", provider: "claude" },
							],
						},
					],
				},
			],
		});
		// The next stream item proves the providerModels item was consumed.
		await vi.waitFor(() => expect(uiState.clientCount).toBe(7));
		expect(
			discovery.discoveryState.providers.flatMap((provider) =>
				provider.models.map((model) => model.name),
			),
		).toEqual([]);
		attachedProjectState.slug = "project-a";
		routerState.search = "?project=project-a";
		expect(
			discovery.discoveryState.providers.flatMap((provider) =>
				provider.models.map((model) => model.name),
			),
		).toEqual(["Alpha model"]);
		expect(discovery.discoveryState.modelsLoaded).toBe(true);
	});

	it("a draft account pick hides the old lists while both account reads are in flight", async () => {
		stop = discovery.watchCatalogs();
		await vi.waitFor(() => expect(modelReads).toHaveLength(1));
		discovery.selectInstance("two");
		await vi.waitFor(() => expect(modelReads).toHaveLength(2));
		modelReads[0]?.resolve(models("Old account model"));
		agentReads[0]?.resolve(agents("Old account agent"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(discovery.discoveryState.providers).toEqual([]);
		expect(discovery.discoveryState.agents).toEqual([]);
		modelReads[1]?.resolve(models("New account model", "two"));
		agentReads[1]?.resolve(agents("New account agent"));
		await vi.waitFor(() =>
			expect(
				discovery.discoveryState.providers.flatMap((provider) =>
					provider.models.map((model) => model.name),
				),
			).toEqual(["New account model"]),
		);
		expect(discovery.discoveryState.agents.map((agent) => agent.name)).toEqual([
			"New account agent",
		]);
	});

	it("a workspace move hides the old commands and re-reads for the moved session", async () => {
		seedSessions([
			{
				id: "session",
				title: "Session",
				accountId: "one",
				workspace: {
					cause: "launch",
					origin: "existing",
					worktrees: { "/project-a": "/project-a" },
				},
			},
		]);
		selection.open("session");
		const oldRead = discovery.refreshCatalogs();
		await vi.waitFor(() => expect(commandReads).toHaveLength(1));
		stop = discovery.watchCatalogs();
		await vi.waitFor(() => expect(commandReads).toHaveLength(2));
		applySessionUpsert({
			id: "session",
			title: "Session",
			accountId: "one",
			workspace: {
				cause: "user",
				origin: "existing",
				worktrees: { "/project-a": "/worktree" },
			},
		});
		expect(discovery.discoveryState.commands).toEqual([]);
		await vi.waitFor(() => expect(commandReads).toHaveLength(3));
		modelReads[0]?.resolve(models("Original model"));
		agentReads[0]?.resolve(agents("Original agent"));
		commandReads[0]?.resolve({
			projectSlug: "project-a",
			commands: [{ name: "original-skill" }],
		});
		await oldRead;
		expect(discovery.discoveryState.commands).toEqual([]);
		commandReads[2]?.resolve({
			projectSlug: "project-a",
			commands: [{ name: "worktree-skill" }],
		});
		await vi.waitFor(() =>
			expect(
				discovery.discoveryState.commands.map((command) => command.name),
			).toEqual(["worktree-skill"]),
		);
	});
});
