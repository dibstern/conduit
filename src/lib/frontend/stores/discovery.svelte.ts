// ─── Discovery Store ─────────────────────────────────────────────────────────
// Agents, models, providers, and commands.

import type {
	GetAgentsResponse,
	GetCommandsResponse,
	GetModelsResponse,
	SetDefaultModelResponse,
	SetHiddenEntriesResponse,
	SwitchContextWindowResponse,
	SwitchModelResponse,
	SwitchVariantResponse,
} from "../transport/ws-rpc.js";
import type {
	AgentInfo,
	AgentProviderScope,
	CommandInfo,
	ContextWindowOption,
	Immutable,
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

// ─── Server-owned state ─────────────────────────────────────────────────────
// What the server has told us: the catalogue of providers, models, agents and
// commands, the project's defaults, and the configuration the current session
// is actually running with. Only the `handle*` and `apply*` functions in this
// module write it; `discoveryState` hands it out with no setters, so nothing
// outside can.

const serverDiscovery = $state({
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
	defaultVariant: "" as string,
	currentVariant: "" as string,
	availableVariants: [] as string[],
	currentContextWindow: "" as string,
	availableContextWindowOptions: [] as ReadonlyArray<ContextWindowOption>,
	modelExecution: null as GetModelsResponse["modelExecution"] | null,
	permissionMode: "ask" as SessionPermissionMode,
	defaultPermissionMode: "ask" as SessionPermissionMode,
	/** Global hide-list keys: model `<providerId>/<modelId>`. */
	hiddenModels: [] as string[],
	/** Global hide-list keys: agent `<scopeId>/<agentId>`. */
	hiddenAgents: [] as string[],
});

// ─── Client-owned state ─────────────────────────────────────────────────────
// This tab's own state. No server message writes it.
//
// `choice` is what the user has clicked but the server has not confirmed yet.
// Reads fall through to the server's value while a field is null, so a picker
// answers the click at once and the server's reply takes over the moment it
// lands. Holding the click apart from the server's value is what makes
// reverting safe: dropping our own choice cannot undo somebody else's change
// that arrived in between — the trap the old per-component
// `if (state.x === mine) state.x = previous` dance was written to dodge.

const choice = $state({
	agentId: null as string | null,
	modelId: null as string | null,
	providerId: null as string | null,
	variant: null as string | null,
	contextWindow: null as string | null,
	permissionMode: null as SessionPermissionMode | null,
	hiddenModels: null as string[] | null,
	hiddenAgents: null as string[] | null,
	defaultModelId: null as string | null,
	defaultProviderId: null as string | null,
	defaultPermissionMode: null as SessionPermissionMode | null,
});

const clientDiscovery = $state({
	/** Mode selected while no session was bound — flushed on session bind. */
	pendingPermissionMode: null as SessionPermissionMode | null,
	/** Pre-creation harness choice (client-persisted draft). Survives reload;
	 *  never authoritative once a session is bound (harness is fixed then). */
	selectedInstanceId: loadInstanceDraft() as string | null,
});

/** Read view over both halves. Server-owned fields have no setter: write them
 *  by applying a wire message or an RPC response. Fields the user can pick
 *  ahead of the server read through `choice` first — see the `choose*`
 *  actions. */
export const discoveryState = {
	// Server-owned.
	get agents(): readonly Immutable<AgentInfo>[] {
		return serverDiscovery.agents;
	},
	get agentProviderScope(): Immutable<AgentProviderScope> | null {
		return serverDiscovery.agentProviderScope;
	},
	get activeAgentId(): string | null {
		return choice.agentId ?? serverDiscovery.activeAgentId;
	},
	get providers(): readonly Immutable<ProviderInfo>[] {
		return serverDiscovery.providers;
	},
	get commands(): readonly Immutable<CommandInfo>[] {
		return serverDiscovery.commands;
	},
	get commandsFetched(): boolean {
		return serverDiscovery.commandsFetched;
	},
	get defaultVariant(): string {
		return serverDiscovery.defaultVariant;
	},
	get availableVariants(): readonly string[] {
		return serverDiscovery.availableVariants;
	},
	get availableContextWindowOptions(): readonly Immutable<ContextWindowOption>[] {
		return serverDiscovery.availableContextWindowOptions;
	},
	get modelExecution(): Immutable<GetModelsResponse["modelExecution"]> | null {
		return serverDiscovery.modelExecution;
	},

	// Server-owned, with this tab's unconfirmed click read first.
	get currentModelId(): string {
		return choice.modelId ?? serverDiscovery.currentModelId;
	},
	get currentProviderId(): string {
		return choice.providerId ?? serverDiscovery.currentProviderId;
	},
	get currentVariant(): string {
		return choice.variant ?? serverDiscovery.currentVariant;
	},
	get currentContextWindow(): string {
		return choice.contextWindow ?? serverDiscovery.currentContextWindow;
	},
	get permissionMode(): SessionPermissionMode {
		return choice.permissionMode ?? serverDiscovery.permissionMode;
	},
	get defaultModelId(): string {
		return choice.defaultModelId ?? serverDiscovery.defaultModelId;
	},
	get defaultProviderId(): string {
		return choice.defaultProviderId ?? serverDiscovery.defaultProviderId;
	},
	get defaultPermissionMode(): SessionPermissionMode {
		return (
			choice.defaultPermissionMode ?? serverDiscovery.defaultPermissionMode
		);
	},
	get hiddenModels(): readonly string[] {
		return choice.hiddenModels ?? serverDiscovery.hiddenModels;
	},
	get hiddenAgents(): readonly string[] {
		return choice.hiddenAgents ?? serverDiscovery.hiddenAgents;
	},

	// Client-owned.
	get pendingPermissionMode(): SessionPermissionMode | null {
		return clientDiscovery.pendingPermissionMode;
	},
	set pendingPermissionMode(mode: SessionPermissionMode | null) {
		clientDiscovery.pendingPermissionMode = mode;
	},
	get selectedInstanceId(): string | null {
		return clientDiscovery.selectedInstanceId;
	},
	set selectedInstanceId(id: string | null) {
		clientDiscovery.selectedInstanceId = id;
	},
};

// ─── Derived getters ────────────────────────────────────────────────────────
// Components should wrap in $derived() for reactive caching.

/** Get the currently active agent. */
export function getActiveAgent(): Immutable<AgentInfo> | undefined {
	return discoveryState.agents.find(
		(a) => a.id === discoveryState.activeAgentId,
	);
}

/** Get all models from all providers, flattened. */
export function getAllModels(): readonly Immutable<ModelInfo>[] {
	return discoveryState.providers.flatMap((p) => p.models);
}

/** Get the currently active model. Grouped models (Bedrock geo routing)
 *  match when the active id is any of their routing option values. */
export function getActiveModel(): Immutable<ModelInfo> | undefined {
	const currentId = discoveryState.currentModelId;
	return getAllModels().find(
		(m) =>
			m.id === currentId ||
			m.routingOptions?.some((option) => option.value === currentId),
	);
}

/** Get models grouped by provider for dropdown rendering. */
export function getProviderGroups(): readonly Immutable<ProviderGroup>[] {
	return discoveryState.providers
		.filter((p) => p.models.length > 0)
		.map((p) => ({ provider: p, models: p.models }));
}

/** Agents visible in the dropdown after applying the global hide-list.
 *  Never-brick: if filtering would leave zero agents, show all. */
export function getVisibleAgents(): readonly Immutable<AgentInfo>[] {
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
export function getVisibleProviderGroups(): readonly Immutable<ProviderGroup>[] {
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
): readonly Immutable<ProviderGroup>[] {
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
	clientDiscovery.selectedInstanceId = instanceId;
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
		// A local re-aim, not a server fact: the harness switch has not been
		// sent anywhere yet.
		chooseModel({ modelId: preferred.id, providerId: preferred.provider });
	}
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Format agent label for display. */
export function formatAgentLabel(agent: Immutable<AgentInfo>): string {
	return agent.name || agent.id;
}

/** Build tooltip text for an agent. */
export function buildAgentTooltip(agent: Immutable<AgentInfo>): string {
	return agent.description || agent.name || agent.id;
}

/** Format model name for display. */
export function formatModelName(model: Immutable<ModelInfo>): string {
	return model.name || model.id;
}

export function getModelDisplayName(modelId: string): string {
	const model = getAllModels().find(
		(candidate) =>
			candidate.id === modelId ||
			candidate.routingOptions?.some((option) => option.value === modelId),
	);
	return model ? formatModelName(model) : modelId;
}

/** Check if a provider is configured. */
export function isProviderConfigured(
	provider: Immutable<ProviderInfo>,
): boolean {
	return provider.configured;
}

/** Filter commands by query (case-insensitive prefix match on name). */
export function filterCommands(
	commands: readonly Immutable<CommandInfo>[],
	query: string,
): readonly Immutable<CommandInfo>[] {
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
		serverDiscovery.agents = agents;
	}
	if (providerScope) {
		serverDiscovery.agentProviderScope = providerScope;
	}
	if (activeAgentId) {
		serverDiscovery.activeAgentId = activeAgentId;
	} else {
		serverDiscovery.activeAgentId = null;
	}
	choice.agentId = null;
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
		serverDiscovery.hiddenAgents = [...response.hiddenAgents];
	}
}

export function handleModelList(
	msg: Extract<RelayMessage, { type: "model_list" }>,
): void {
	const { providers } = msg;
	if (Array.isArray(providers)) {
		serverDiscovery.providers = providers;
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
	serverDiscovery.modelExecution = response.modelExecution
		? { ...response.modelExecution }
		: null;
	if (response.permissionMode) {
		handlePermissionModeInfo({
			type: "permission_mode_info",
			mode: response.permissionMode,
		});
	}
	if (response.hiddenModels) {
		serverDiscovery.hiddenModels = [...response.hiddenModels];
	}
}

export function handleModelInfo(
	msg: Extract<RelayMessage, { type: "model_info" }>,
): void {
	const { model, provider } = msg;
	if (model) serverDiscovery.currentModelId = model;
	if (provider) serverDiscovery.currentProviderId = provider;
	choice.modelId = null;
	choice.providerId = null;
}

export function handleCommandList(
	msg: Extract<RelayMessage, { type: "command_list" }>,
): void {
	const { commands } = msg;
	if (Array.isArray(commands)) {
		serverDiscovery.commands = commands;
		serverDiscovery.commandsFetched = true;
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
	serverDiscovery.defaultModelId = msg.model ?? "";
	serverDiscovery.defaultProviderId = msg.provider ?? "";
	serverDiscovery.defaultVariant = msg.variant ?? "";
	choice.defaultModelId = null;
	choice.defaultProviderId = null;
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Get the available variants for the currently active model. */
export function getActiveModelVariants(): readonly string[] {
	return discoveryState.availableVariants;
}

/** Get the available context-window options for the currently active model.
 *  Prefer the selected model's own options so the dropdown appears the moment a
 *  supporting model is picked, without waiting for a server context_window_info
 *  round-trip; fall back to the last server-provided list otherwise. */
export function getActiveContextWindowOptions(): readonly Immutable<ContextWindowOption>[] {
	const modelOptions = getActiveModel()?.contextWindowOptions;
	if (modelOptions && modelOptions.length > 0) return modelOptions;
	return discoveryState.availableContextWindowOptions;
}

// ─── Variant handler ────────────────────────────────────────────────────────

export function handleVariantInfo(
	msg: Extract<RelayMessage, { type: "variant_info" }>,
): void {
	serverDiscovery.currentVariant = msg.variant ?? "";
	serverDiscovery.availableVariants = msg.variants ?? [];
	choice.variant = null;
}

// ─── Context-window handler ─────────────────────────────────────────────────

export function handleContextWindowInfo(
	msg: Extract<RelayMessage, { type: "context_window_info" }>,
): void {
	serverDiscovery.currentContextWindow = msg.contextWindow ?? "";
	serverDiscovery.availableContextWindowOptions = msg.options ?? [];
	choice.contextWindow = null;
}

// ─── Permission-mode handler ────────────────────────────────────────────────

export function handlePermissionModeInfo(
	msg: Extract<RelayMessage, { type: "permission_mode_info" }>,
): void {
	serverDiscovery.permissionMode = msg.mode;
	choice.permissionMode = null;
}

// ─── Visibility handler ─────────────────────────────────────────────────────

export function handleVisibilityInfo(
	msg: Extract<RelayMessage, { type: "visibility_info" }>,
): void {
	serverDiscovery.hiddenModels = [...msg.hiddenModels];
	serverDiscovery.hiddenAgents = [...msg.hiddenAgents];
	choice.hiddenModels = null;
	choice.hiddenAgents = null;
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
	clientDiscovery.pendingPermissionMode = null;
	const undo = choosePermissionMode(mode);
	// Send even for "ask". It is only the server's default for a *brand-new*
	// session, and this runs on binding to any session -- skipping it left a
	// session already on "full" running with full access while the pill read
	// "Ask". Restricting a session must never be the silent case.
	// On failure, stop claiming a mode the server is not in.
	void send({ projectSlug, sessionId, mode }).catch(undo);
}

// ─── Choosing ahead of the server ───────────────────────────────────────────
// A picker writes the user's click here, sends the RPC, and applies the
// response. Each `choose*` hands back the undo for *that* click; call it when
// the server refuses. No component keeps a `previous…` variable any more: the
// server's value was never overwritten, so there is nothing to restore.

/** Drops the click it came from, unless a later one has taken the field over. */
type UndoChoice = () => void;

type ChoiceField = keyof typeof choice;

/** Which click each pending field belongs to. Identity, not value: clicking
 *  "acceptEdits", then "ask", then "acceptEdits" again makes three distinct
 *  claims on the field, and only the last one's undo may clear it. Plain, not
 *  `$state`: nothing renders it. A field the server has since confirmed leaves
 *  a stale entry here, which is harmless — its undo can only write the null
 *  that applying the response already wrote. */
const owner: Partial<Record<ChoiceField, symbol>> = {};

/** Show one field's click ahead of the server, and return that click's undo. */
function propose<K extends ChoiceField>(
	field: K,
	value: NonNullable<(typeof choice)[K]>,
): UndoChoice {
	const click = Symbol(field);
	owner[field] = click;
	choice[field] = value;
	return () => {
		if (owner[field] !== click) return;
		delete owner[field];
		choice[field] = null;
	};
}

/** Undo several fields as one click — each still owning its own field, so a
 *  refused model switch cannot revert a provider someone else's click set. */
const undoAll =
	(undos: readonly UndoChoice[]): UndoChoice =>
	() => {
		for (const undo of undos) undo();
	};

export function chooseAgent(agentId: string): UndoChoice {
	return propose("agentId", agentId);
}

export function chooseModel(model: {
	modelId: string;
	providerId: string;
}): UndoChoice {
	return undoAll([
		propose("modelId", model.modelId),
		propose("providerId", model.providerId),
	]);
}

export function chooseVariant(variant: string): UndoChoice {
	return propose("variant", variant);
}

export function chooseContextWindow(contextWindow: string): UndoChoice {
	return propose("contextWindow", contextWindow);
}

export function choosePermissionMode(mode: SessionPermissionMode): UndoChoice {
	return propose("permissionMode", mode);
}

export function chooseDefaultModel(model: {
	modelId: string;
	providerId: string;
}): UndoChoice {
	return undoAll([
		propose("defaultModelId", model.modelId),
		propose("defaultProviderId", model.providerId),
	]);
}

export function chooseDefaultPermissionMode(
	mode: SessionPermissionMode,
): UndoChoice {
	return propose("defaultPermissionMode", mode);
}

export function chooseHiddenEntries(entries: {
	hiddenModels?: string[];
	hiddenAgents?: string[];
}): UndoChoice {
	const undos: UndoChoice[] = [];
	if (entries.hiddenModels) {
		undos.push(propose("hiddenModels", [...entries.hiddenModels]));
	}
	if (entries.hiddenAgents) {
		undos.push(propose("hiddenAgents", [...entries.hiddenAgents]));
	}
	return undoAll(undos);
}

// ─── Applying RPC responses ─────────────────────────────────────────────────
// The other half of a `choose*`: the server's answer, which lands in the
// server half and clears the click it confirms.

export function applyModelSwitched(response: SwitchModelResponse): void {
	handleModelInfo({
		type: "model_info",
		model: response.model,
		provider: response.provider,
	});
	handleVariantInfo({
		type: "variant_info",
		variant: response.variant,
		variants: [...response.variants],
	});
}

export function applyDefaultModelSet(response: SetDefaultModelResponse): void {
	handleDefaultModelInfo({
		type: "default_model_info",
		model: response.model,
		provider: response.provider,
		variant: response.variant,
	});
	handleVariantInfo({
		type: "variant_info",
		variant: response.variant,
		variants: [...response.variants],
	});
}

export function applyVariantSwitched(response: SwitchVariantResponse): void {
	handleVariantInfo({
		type: "variant_info",
		variant: response.variant,
		variants: [...response.variants],
	});
}

export function applyContextWindowSwitched(
	response: SwitchContextWindowResponse,
): void {
	handleContextWindowInfo({
		type: "context_window_info",
		contextWindow: response.contextWindow,
		options: cloneContextWindowOptions(response.options) ?? [],
	});
}

export function applyHiddenEntriesSet(
	response: SetHiddenEntriesResponse,
): void {
	handleVisibilityInfo({
		type: "visibility_info",
		hiddenModels: [...response.hiddenModels],
		hiddenAgents: [...response.hiddenAgents],
	});
}

export function applyDefaultPermissionMode(mode: SessionPermissionMode): void {
	serverDiscovery.defaultPermissionMode = mode;
	choice.defaultPermissionMode = null;
}

/** Clear all discovery state (for project switch). */
export function clearDiscoveryState(): void {
	serverDiscovery.agents = [];
	serverDiscovery.agentProviderScope = null;
	serverDiscovery.activeAgentId = null;
	serverDiscovery.providers = [];
	serverDiscovery.currentModelId = "";
	serverDiscovery.currentProviderId = "";
	serverDiscovery.commands = [];
	serverDiscovery.commandsFetched = false;
	serverDiscovery.defaultModelId = "";
	serverDiscovery.defaultProviderId = "";
	serverDiscovery.defaultVariant = "";
	serverDiscovery.currentVariant = "";
	serverDiscovery.availableVariants = [];
	serverDiscovery.currentContextWindow = "";
	serverDiscovery.availableContextWindowOptions = [];
	serverDiscovery.modelExecution = null;
	serverDiscovery.permissionMode = "ask";
	serverDiscovery.defaultPermissionMode = "ask";
	serverDiscovery.hiddenModels = [];
	serverDiscovery.hiddenAgents = [];
	clientDiscovery.pendingPermissionMode = null;
	for (const field of Object.keys(choice) as ChoiceField[]) {
		choice[field] = null;
		delete owner[field];
	}
	// selectedInstanceId is intentionally kept: it is a client-side draft
	// preference (instances are daemon-global), not server discovery state.
}
