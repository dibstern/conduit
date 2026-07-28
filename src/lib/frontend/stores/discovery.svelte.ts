// ─── Discovery Store ─────────────────────────────────────────────────────────
// Agents, models, providers, and commands.

import type {
	GetAgentsResponse,
	GetCommandsResponse,
	GetModelsResponse,
} from "../transport/ws-rpc.js";
import type {
	AgentInfo,
	AgentProviderScope,
	CommandInfo,
	ContextWindowOption,
	InstanceStatus,
	ModelInfo,
	ProviderGroup,
	ProviderInfo,
	RelayMessage,
	SessionPermissionMode,
} from "../types.js";
import { instanceState } from "./instance.svelte.js";

const cloneContextWindowOptions = (
	options:
		| readonly {
				readonly value: string;
				readonly label: string;
				readonly isDefault?: boolean | undefined;
		  }[]
		| undefined,
): ContextWindowOption[] | undefined =>
	options?.map((option) =>
		option.isDefault == null
			? { value: option.value, label: option.label }
			: {
					value: option.value,
					label: option.label,
					isDefault: option.isDefault,
				},
	);

const providersFromGetModelsResponse = (
	providers: GetModelsResponse["providers"],
): ProviderInfo[] =>
	providers.map((provider) => ({
		id: provider.id,
		...(provider.instanceId != null ? { instanceId: provider.instanceId } : {}),
		name: provider.name,
		configured: provider.configured,
		models: provider.models.map((model) => ({
			id: model.id,
			name: model.name,
			provider: model.provider,
			...(model.cost
				? {
						cost: {
							...(model.cost.input != null ? { input: model.cost.input } : {}),
							...(model.cost.output != null
								? { output: model.cost.output }
								: {}),
						},
					}
				: {}),
			...(model.limit
				? {
						limit: {
							...(model.limit.context != null
								? { context: model.limit.context }
								: {}),
							...(model.limit.output != null
								? { output: model.limit.output }
								: {}),
						},
					}
				: {}),
			...(model.variants ? { variants: [...model.variants] } : {}),
			...(model.contextWindowOptions
				? {
						contextWindowOptions:
							cloneContextWindowOptions(model.contextWindowOptions) ?? [],
					}
				: {}),
		})),
	}));

// ─── Provider instances ─────────────────────────────────────────────────────
// The composer's harness picker selects a provider *instance*. Default
// instances are derived from the discovered providers: the "claude" provider
// belongs to the Claude driver's default instance; every other provider
// catalog comes from the OpenCode driver's default instance. Named instances
// (provider.instanceId) flow through unchanged so future config-defined
// instances need no rework here.

export interface InstanceOption {
	readonly id: string;
	readonly driver: "claude" | "opencode";
	readonly label: string;
	/** Non-default instance of a driver — disambiguated with an accent badge. */
	readonly isCustom: boolean;
	/** Newly-added instance — rendered with a sparkle in the rail. */
	readonly isNew?: boolean;
	/** Live status from the configured-instance source, when known. */
	readonly status?: InstanceStatus;
}

const DRIVER_LABELS = { claude: "Claude", opencode: "OpenCode" } as const;

const INSTANCE_DRAFT_KEY = "conduit-selected-instance";

function loadInstanceDraft(): string | null {
	try {
		return localStorage.getItem(INSTANCE_DRAFT_KEY);
	} catch {
		return null;
	}
}

/** Map a provider catalog id to the default instance id of its driver. */
export function instanceIdForProviderId(
	providerId: string,
): "claude" | "opencode" {
	return providerId === "claude" ? "claude" : "opencode";
}

// ─── State ──────────────────────────────────────────────────────────────────

export const discoveryState = $state({
	agents: [] as AgentInfo[],
	agentProviderScope: null as AgentProviderScope | null,
	activeAgentId: null as string | null,
	providers: [] as ProviderInfo[],
	currentModelId: "" as string,
	currentProviderId: "" as string,
	commands: [] as CommandInfo[],
	commandsFetched: false,
	defaultModelId: "" as string,
	defaultProviderId: "" as string,
	currentVariant: "" as string,
	availableVariants: [] as string[],
	currentContextWindow: "" as string,
	availableContextWindowOptions: [] as ReadonlyArray<ContextWindowOption>,
	permissionMode: "ask" as SessionPermissionMode,
	/** Mode selected while no session was bound — flushed on session bind. */
	pendingPermissionMode: null as SessionPermissionMode | null,
	/** Global hide-list keys: model `<providerId>/<modelId>`. */
	hiddenModels: [] as string[],
	/** Global hide-list keys: agent `<scopeId>/<agentId>`. */
	hiddenAgents: [] as string[],
	/** Pre-creation harness choice (client-persisted draft). Survives reload;
	 *  never authoritative once a session is bound (harness is fixed then). */
	selectedInstanceId: loadInstanceDraft() as string | null,
});

// ─── Derived getters ────────────────────────────────────────────────────────
// Components should wrap in $derived() for reactive caching.

/** Get the currently active agent. */
export function getActiveAgent(): AgentInfo | undefined {
	return discoveryState.agents.find(
		(a) => a.id === discoveryState.activeAgentId,
	);
}

/** Get all models from all providers, flattened. */
export function getAllModels(): ModelInfo[] {
	return discoveryState.providers.flatMap((p) => p.models);
}

/** Get the currently active model. Grouped models (Bedrock geo routing)
 *  match when the active id is any of their routing option values. */
export function getActiveModel(): ModelInfo | undefined {
	const currentId = discoveryState.currentModelId;
	return getAllModels().find(
		(m) =>
			m.id === currentId ||
			m.routingOptions?.some((option) => option.value === currentId),
	);
}

/** Get models grouped by provider for dropdown rendering. */
export function getProviderGroups(): ProviderGroup[] {
	return discoveryState.providers
		.filter((p) => p.models.length > 0)
		.map((p) => ({ provider: p, models: p.models }));
}

/** Agents visible in the dropdown after applying the global hide-list.
 *  Never-brick: if filtering would leave zero agents, show all. */
export function getVisibleAgents(): AgentInfo[] {
	const scopeId = discoveryState.agentProviderScope?.id;
	if (!scopeId || discoveryState.hiddenAgents.length === 0) {
		return discoveryState.agents;
	}
	const hidden = new Set(discoveryState.hiddenAgents);
	const visible = discoveryState.agents.filter(
		(a) => !hidden.has(`${scopeId}/${a.id}`),
	);
	return visible.length > 0 ? visible : discoveryState.agents;
}

/** Provider groups visible in the dropdown after applying the global hide-list.
 *  Groups with zero visible models are dropped.
 *  Never-brick: if filtering would leave zero models overall, show all. */
export function getVisibleProviderGroups(): ProviderGroup[] {
	const all = getProviderGroups();
	if (discoveryState.hiddenModels.length === 0) return all;
	const hidden = new Set(discoveryState.hiddenModels);
	const filtered = all
		.map((g) => ({
			provider: g.provider,
			models: g.models.filter((m) => !hidden.has(`${g.provider.id}/${m.id}`)),
		}))
		.filter((g) => g.models.length > 0);
	return filtered.length > 0 ? filtered : all;
}

/** Instances available in the harness rail. Configured provider instances are
 *  the source of truth (so an instance with no discovered models is still
 *  selectable); discovered providers supply the always-present default drivers
 *  and the model catalog. Default driver instances sort first (Claude, then
 *  OpenCode), named instances after. */
export function getAvailableInstances(): InstanceOption[] {
	const byId = new Map<string, InstanceOption>();
	// 1. Discovered providers — default drivers, plus named instances that
	//    already surface models.
	for (const provider of discoveryState.providers) {
		const driver = instanceIdForProviderId(provider.id);
		const id = provider.instanceId ?? driver;
		if (!byId.has(id)) {
			byId.set(id, {
				id,
				driver,
				label: id === driver ? DRIVER_LABELS[driver] : id,
				isCustom: id !== driver,
			});
		}
	}
	// 2. Configured instances (from instance_list) — selectable even without
	//    discovered models. Merge live status onto matching entries; add any
	//    that discovery did not surface, using the configured display name.
	for (const inst of instanceState.instances) {
		const driver: "claude" | "opencode" =
			inst.driver === "claude" ? "claude" : "opencode";
		const existing = byId.get(inst.id);
		if (existing) {
			byId.set(inst.id, { ...existing, status: inst.status });
			continue;
		}
		byId.set(inst.id, {
			id: inst.id,
			driver,
			label: inst.name || inst.id,
			isCustom: inst.id !== "claude" && inst.id !== "opencode",
			status: inst.status,
		});
	}
	const rank = (i: InstanceOption) =>
		i.id === "claude" ? 0 : i.id === "opencode" ? 1 : 2;
	return [...byId.values()].sort(
		(a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label),
	);
}

/** Visible provider groups scoped to one instance (the picker's right pane). */
export function getProviderGroupsForInstance(
	instanceId: string,
): ProviderGroup[] {
	return getVisibleProviderGroups().filter(
		(g) =>
			(g.provider.instanceId ?? instanceIdForProviderId(g.provider.id)) ===
			instanceId,
	);
}

/** The instance the composer is currently aimed at (pre-creation): the
 *  explicit draft when still available, else the instance derived from the
 *  current/default model's provider. Bound-session locking is layered on top
 *  by the picker (it needs session state). */
export function getEffectiveInstanceId(): string {
	const available = getAvailableInstances();
	const isAvailable = (id: string) =>
		available.length === 0 || available.some((i) => i.id === id);
	const selected = discoveryState.selectedInstanceId;
	if (selected != null && isAvailable(selected)) return selected;
	const derived = instanceIdForProviderId(
		discoveryState.currentProviderId || discoveryState.defaultProviderId,
	);
	if (isAvailable(derived)) return derived;
	return available[0]?.id ?? derived;
}

/** Select a harness instance (pre-creation only). Persists the draft and, if
 *  the active model falls outside the instance, re-aims the local model
 *  selection at the instance's default-or-first visible model. */
export function selectInstance(instanceId: string): void {
	discoveryState.selectedInstanceId = instanceId;
	try {
		localStorage.setItem(INSTANCE_DRAFT_KEY, instanceId);
	} catch {
		// localStorage unavailable (private browsing) — draft is best-effort.
	}
	const groups = getProviderGroupsForInstance(instanceId);
	const models = groups.flatMap((g) => g.models);
	const currentInScope = models.some(
		(m) =>
			m.id === discoveryState.currentModelId ||
			m.routingOptions?.some(
				(option) => option.value === discoveryState.currentModelId,
			),
	);
	if (currentInScope) return;
	const preferred =
		models.find(
			(m) =>
				m.id === discoveryState.defaultModelId &&
				m.provider === discoveryState.defaultProviderId,
		) ?? models[0];
	if (preferred) {
		discoveryState.currentModelId = preferred.id;
		discoveryState.currentProviderId = preferred.provider;
	}
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Format agent label for display. */
export function formatAgentLabel(agent: AgentInfo): string {
	return agent.name || agent.id;
}

/** Build tooltip text for an agent. */
export function buildAgentTooltip(agent: AgentInfo): string {
	return agent.description || agent.name || agent.id;
}

/** Format model name for display. */
export function formatModelName(model: ModelInfo): string {
	return model.name || model.id;
}

/** Check if a provider is configured. */
export function isProviderConfigured(provider: ProviderInfo): boolean {
	return provider.configured;
}

/** Filter commands by query (case-insensitive prefix match on name). */
export function filterCommands(
	commands: CommandInfo[],
	query: string,
): CommandInfo[] {
	if (!query) return commands;
	const lower = query.toLowerCase();
	return commands.filter((c) => c.name.toLowerCase().startsWith(lower));
}

export interface SlashQuery {
	query: string;
	start: number;
	end: number;
}

/** Extract slash command query from input text at cursor position. */
export function extractSlashQuery(
	text: string,
	cursorPos: number,
): SlashQuery | null {
	// Look backwards from cursor for a '/' at the start of the line or after whitespace
	const before = text.slice(0, cursorPos);
	const match = before.match(/(?:^|[\s\n])\/(\S*)$/);
	if (!match) return null;

	const query = match[1] ?? "";
	const matchStart = before.length - match[0].length;
	const slashStart = match[0].startsWith("/") ? matchStart : matchStart + 1;

	return { query, start: slashStart, end: cursorPos };
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleAgentList(
	msg: Extract<RelayMessage, { type: "agent_list" }>,
): void {
	const { agents, activeAgentId, providerScope } = msg;
	if (Array.isArray(agents)) {
		discoveryState.agents = agents;
	}
	if (providerScope) {
		discoveryState.agentProviderScope = providerScope;
	}
	if (activeAgentId) {
		discoveryState.activeAgentId = activeAgentId;
	} else {
		discoveryState.activeAgentId = null;
	}
}

export function applyGetAgentsResponse(response: GetAgentsResponse): void {
	handleAgentList({
		type: "agent_list",
		providerScope: response.providerScope,
		agents: response.agents.map((agent) => ({
			id: agent.id,
			name: agent.name,
			...(agent.description != null ? { description: agent.description } : {}),
			...(agent.model != null ? { model: agent.model } : {}),
		})),
		...(response.activeAgentId != null
			? { activeAgentId: response.activeAgentId }
			: {}),
	});
	if (response.hiddenAgents) {
		discoveryState.hiddenAgents = [...response.hiddenAgents];
	}
}

export function handleModelList(
	msg: Extract<RelayMessage, { type: "model_list" }>,
): void {
	const { providers } = msg;
	if (Array.isArray(providers)) {
		discoveryState.providers = providers;
	}
}

export function applyGetModelsResponse(response: GetModelsResponse): void {
	handleModelList({
		type: "model_list",
		providers: providersFromGetModelsResponse(response.providers),
	});
	if (response.active) {
		handleModelInfo({
			type: "model_info",
			model: response.active.model,
			provider: response.active.provider,
		});
	}
	if (response.variant) {
		handleVariantInfo({
			type: "variant_info",
			...(response.variant.variant != null
				? { variant: response.variant.variant }
				: {}),
			...(response.variant.variants
				? { variants: [...response.variant.variants] }
				: {}),
		});
	}
	if (response.contextWindow) {
		handleContextWindowInfo({
			type: "context_window_info",
			contextWindow: response.contextWindow.contextWindow,
			options: cloneContextWindowOptions(response.contextWindow.options) ?? [],
		});
	}
	if (response.permissionMode) {
		handlePermissionModeInfo({
			type: "permission_mode_info",
			mode: response.permissionMode,
		});
	}
	if (response.hiddenModels) {
		discoveryState.hiddenModels = [...response.hiddenModels];
	}
}

export function handleModelInfo(
	msg: Extract<RelayMessage, { type: "model_info" }>,
): void {
	const { model, provider } = msg;
	if (model) discoveryState.currentModelId = model;
	if (provider) discoveryState.currentProviderId = provider;
}

export function handleCommandList(
	msg: Extract<RelayMessage, { type: "command_list" }>,
): void {
	const { commands } = msg;
	if (Array.isArray(commands)) {
		discoveryState.commands = commands;
		discoveryState.commandsFetched = true;
	}
}

export function applyGetCommandsResponse(response: GetCommandsResponse): void {
	handleCommandList({
		type: "command_list",
		commands: response.commands.map((command) => ({
			name: command.name,
			...(command.description != null
				? { description: command.description }
				: {}),
			...(command.args != null ? { args: command.args } : {}),
		})),
	});
}

export function handleDefaultModelInfo(
	msg: Extract<RelayMessage, { type: "default_model_info" }>,
): void {
	discoveryState.defaultModelId = msg.model ?? "";
	discoveryState.defaultProviderId = msg.provider ?? "";
}

// ─── Actions ────────────────────────────────────────────────────────────────

export function setActiveAgent(agentId: string): void {
	discoveryState.activeAgentId = agentId;
}

export function setActiveModel(modelId: string, providerId: string): void {
	discoveryState.currentModelId = modelId;
	discoveryState.currentProviderId = providerId;
}

/** Get the available variants for the currently active model. */
export function getActiveModelVariants(): string[] {
	return discoveryState.availableVariants;
}

/** Get the available context-window options for the currently active model.
 *  Prefer the selected model's own options so the dropdown appears the moment a
 *  supporting model is picked, without waiting for a server context_window_info
 *  round-trip; fall back to the last server-provided list otherwise. */
export function getActiveContextWindowOptions(): ReadonlyArray<ContextWindowOption> {
	const modelOptions = getActiveModel()?.contextWindowOptions;
	if (modelOptions && modelOptions.length > 0) return modelOptions;
	return discoveryState.availableContextWindowOptions;
}

// ─── Variant handler ────────────────────────────────────────────────────────

export function handleVariantInfo(
	msg: Extract<RelayMessage, { type: "variant_info" }>,
): void {
	discoveryState.currentVariant = msg.variant ?? "";
	discoveryState.availableVariants = msg.variants ?? [];
}

// ─── Context-window handler ─────────────────────────────────────────────────

export function handleContextWindowInfo(
	msg: Extract<RelayMessage, { type: "context_window_info" }>,
): void {
	discoveryState.currentContextWindow = msg.contextWindow ?? "";
	discoveryState.availableContextWindowOptions = msg.options ?? [];
}

// ─── Permission-mode handler ────────────────────────────────────────────────

export function handlePermissionModeInfo(
	msg: Extract<RelayMessage, { type: "permission_mode_info" }>,
): void {
	discoveryState.permissionMode = msg.mode;
}

// ─── Visibility handler ─────────────────────────────────────────────────────

export function handleVisibilityInfo(
	msg: Extract<RelayMessage, { type: "visibility_info" }>,
): void {
	discoveryState.hiddenModels = [...msg.hiddenModels];
	discoveryState.hiddenAgents = [...msg.hiddenAgents];
}

/**
 * Flush a permission mode that was selected while no session was bound
 * (e.g. cold start before session_switched). Called when a session binds so
 * the user's pre-bind selection actually reaches the server instead of being
 * silently dropped (the first turn would still ask, and any re-sync would
 * flip the pill back to "Ask").
 */
export function flushPendingPermissionMode(
	projectSlug: string,
	sessionId: string,
	send: (input: {
		projectSlug: string;
		sessionId: string;
		mode: SessionPermissionMode;
	}) => Promise<unknown>,
): void {
	const mode = discoveryState.pendingPermissionMode;
	if (mode == null) return;
	discoveryState.pendingPermissionMode = null;
	discoveryState.permissionMode = mode;
	if (mode === "ask") return; // server default — nothing to persist
	void send({ projectSlug, sessionId, mode }).catch(() => {
		// Server never got it: reflect the truthful default.
		if (discoveryState.permissionMode === mode) {
			discoveryState.permissionMode = "ask";
		}
	});
}

/** Clear all discovery state (for project switch). */
export function clearDiscoveryState(): void {
	discoveryState.agents = [];
	discoveryState.agentProviderScope = null;
	discoveryState.activeAgentId = null;
	discoveryState.providers = [];
	discoveryState.currentModelId = "";
	discoveryState.currentProviderId = "";
	discoveryState.commands = [];
	discoveryState.commandsFetched = false;
	discoveryState.defaultModelId = "";
	discoveryState.defaultProviderId = "";
	discoveryState.currentVariant = "";
	discoveryState.availableVariants = [];
	discoveryState.currentContextWindow = "";
	discoveryState.availableContextWindowOptions = [];
	discoveryState.permissionMode = "ask";
	discoveryState.pendingPermissionMode = null;
	discoveryState.hiddenModels = [];
	discoveryState.hiddenAgents = [];
	// selectedInstanceId is intentionally kept: it is a client-side draft
	// preference (instances are daemon-global), not server discovery state.
}
