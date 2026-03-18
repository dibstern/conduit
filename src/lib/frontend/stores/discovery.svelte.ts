// ─── Discovery Store ─────────────────────────────────────────────────────────
// Agents, models, providers, and commands.

import type {
	AgentInfo,
	CommandInfo,
	ModelInfo,
	ProviderGroup,
	ProviderInfo,
	RelayMessage,
} from "../types.js";

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

/** Extract slash command query from input text at cursor position. */
export function extractSlashQuery(
	text: string,
	cursorPos: number,
): string | null {
	// Look backwards from cursor for a '/' at the start of the line or after whitespace
	const before = text.slice(0, cursorPos);
	const match = before.match(/(?:^|\s)\/(\S*)$/);
	if (match) {
		return match[1] ?? null;
	}
	return null;
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

export function handleModelList(
	msg: Extract<RelayMessage, { type: "model_list" }>,
): void {
	const { providers } = msg;
	if (Array.isArray(providers)) {
		discoveryState.providers = providers;
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

// ─── Variant handler ────────────────────────────────────────────────────────

export function handleVariantInfo(
	msg: Extract<RelayMessage, { type: "variant_info" }>,
): void {
	discoveryState.currentVariant = msg.variant ?? "";
	discoveryState.availableVariants = msg.variants ?? [];
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
}
