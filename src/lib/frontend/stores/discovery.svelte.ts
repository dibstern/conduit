// ─── Discovery Store ─────────────────────────────────────────────────────────
// Agents, models, providers, and commands.

import type {
	GetAgentsResponse,
	GetCommandsResponse,
	GetModelsResponse,
} from "../transport/ws-rpc.js";
import type {
	AgentInfo,
	CommandInfo,
	ContextWindowOption,
	ModelInfo,
	ProviderGroup,
	ProviderInfo,
	RelayMessage,
} from "../types.js";

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

// ─── State ──────────────────────────────────────────────────────────────────

export const discoveryState = $state({
	agents: [] as AgentInfo[],
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

/** Get the currently active model. */
export function getActiveModel(): ModelInfo | undefined {
	return getAllModels().find((m) => m.id === discoveryState.currentModelId);
}

/** Get models grouped by provider for dropdown rendering. */
export function getProviderGroups(): ProviderGroup[] {
	return discoveryState.providers
		.filter((p) => p.models.length > 0)
		.map((p) => ({ provider: p, models: p.models }));
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Format agent label for display. */
export function formatAgentLabel(agent: AgentInfo): string {
	const label = agent.name || agent.id;
	return agent.model ? `${label} (${agent.model})` : label;
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
	const { agents, activeAgentId } = msg;
	if (Array.isArray(agents)) {
		discoveryState.agents = agents;
	}
	if (activeAgentId) {
		discoveryState.activeAgentId = activeAgentId;
	}
}

export function applyGetAgentsResponse(response: GetAgentsResponse): void {
	handleAgentList({
		type: "agent_list",
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

/** Get the available context-window options for the currently active model. */
export function getActiveContextWindowOptions(): ReadonlyArray<ContextWindowOption> {
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

/** Clear all discovery state (for project switch). */
export function clearDiscoveryState(): void {
	discoveryState.agents = [];
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
}
