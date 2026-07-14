import type {
	SDKControlInitializeResponse,
	Options as SDKOptions,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { Either, Schema } from "effect";
import {
	ClaudeSDKInitializationResultSubsetSchema,
	decodeClaudeSDKOptionsJsonShape,
} from "../../contracts/providers/claude-agent-sdk.js";
import { createLogger, type Logger } from "../../logger.js";
import type {
	CommandInfo,
	ContextWindowOption,
	ModelInfo,
	ProviderAgentInfo,
} from "../types.js";
import { makeClaudeSdkEnv } from "./claude-sdk-env.js";

const defaultLog = createLogger("claude-capabilities-probe");

// Best-effort observability decode: the probe survives an empty catalog, so we
// never fail-close here — but a renamed/absent commands/agents/models/account
// field would silently yield empty catalogs, so log the drift instead.
const decodeInitializationResult = Schema.decodeUnknownEither(
	ClaudeSDKInitializationResultSubsetSchema,
);

const OUTPUT_LIMIT_BY_FAMILY: ReadonlyArray<[pattern: RegExp, output: number]> =
	[
		[/^(?:claude-)?opus/i, 32_000],
		[/^(?:claude-)?sonnet/i, 64_000],
		[/^(?:claude-)?haiku/i, 8_192],
	];

interface SDKModelInfoSubset {
	readonly value: string;
	readonly displayName: string;
	readonly supportedEffortLevels?: readonly string[];
}

interface SDKSlashCommandSubset {
	readonly name: string;
	readonly description?: string;
	readonly argumentHint?: string;
}

interface SDKAgentInfoSubset {
	readonly name: string;
	readonly description?: string;
	readonly model?: string;
}

interface InitializationResultSubset {
	readonly models?: readonly SDKModelInfoSubset[];
	readonly account?: {
		readonly subscriptionType?: string;
	};
	readonly commands?: readonly SDKSlashCommandSubset[];
	readonly agents?: readonly SDKAgentInfoSubset[];
}

interface CapabilityQuery {
	initializationResult(): Promise<InitializationResultSubset>;
}

type AssertExtends<_A extends B, B> = true;
type _ClaudeSdkInitializationResultFitsConsumedShape = AssertExtends<
	SDKControlInitializeResponse,
	InitializationResultSubset
>;

export interface ProbeResult {
	readonly models: ReadonlyArray<ModelInfo>;
	readonly subscriptionType?: string;
	readonly commands: ReadonlyArray<CommandInfo>;
	readonly agents: ReadonlyArray<ProviderAgentInfo>;
}

export interface ProbeDeps {
	readonly workspaceRoot: string;
	readonly queryFactory?: (params: {
		prompt: string | AsyncIterable<SDKUserMessage>;
		options?: SDKOptions;
	}) => CapabilityQuery;
	readonly logger?: Logger;
}

function inferLimits(
	modelId: string,
): { context: number; output: number } | undefined {
	for (const [pattern, output] of OUTPUT_LIMIT_BY_FAMILY) {
		if (pattern.test(modelId)) return { context: 200_000, output };
	}
	return undefined;
}

function effortLevelsToVariants(
	levels: readonly string[] | undefined,
): Record<string, Record<string, unknown>> | undefined {
	if (!levels || levels.length === 0) return undefined;
	return Object.fromEntries(levels.map((level) => [level, {}]));
}

const CONTEXT_WINDOW_OPTIONS_BY_FAMILY: Record<
	string,
	ReadonlyArray<ContextWindowOption>
> = {
	sonnet: [
		{ value: "200k", label: "200K", isDefault: true },
		{ value: "1m", label: "1M (beta)" },
	],
};

function familyFor(modelId: string): "opus" | "sonnet" | "haiku" | undefined {
	if (/^(?:claude-)?opus/i.test(modelId)) return "opus";
	if (/^(?:claude-)?sonnet/i.test(modelId)) return "sonnet";
	if (/^(?:claude-)?haiku/i.test(modelId)) return "haiku";
	return undefined;
}

function contextWindowOptionsFor(
	modelId: string,
): ReadonlyArray<ContextWindowOption> | undefined {
	const family = familyFor(modelId);
	if (!family) return undefined;
	return CONTEXT_WINDOW_OPTIONS_BY_FAMILY[family];
}

const PREMIUM_SUBSCRIPTION_TYPES = new Set([
	"max",
	"maxplan",
	"max5",
	"max20",
	"enterprise",
	"team",
]);

function isPremium(subscriptionType: string | undefined): boolean {
	if (!subscriptionType) return false;
	const normalized = subscriptionType.toLowerCase().replace(/[\s_-]+/g, "");
	return PREMIUM_SUBSCRIPTION_TYPES.has(normalized);
}

function adjustForSubscription(
	options: ReadonlyArray<ContextWindowOption> | undefined,
	subscriptionType: string | undefined,
): ReadonlyArray<ContextWindowOption> | undefined {
	if (!options) return undefined;
	if (!isPremium(subscriptionType)) return options;
	return options.map((option) =>
		option.value === "1m"
			? { value: option.value, label: option.label, isDefault: true }
			: { value: option.value, label: option.label },
	);
}

function sdkModelToConduit(
	model: SDKModelInfoSubset,
	subscriptionType: string | undefined,
): ModelInfo {
	const limit = inferLimits(model.value);
	const variants = effortLevelsToVariants(model.supportedEffortLevels);
	const contextWindowOptions = adjustForSubscription(
		contextWindowOptionsFor(model.value),
		subscriptionType,
	);
	return {
		id: model.value,
		name: model.displayName,
		providerId: "claude",
		...(limit ? { limit } : {}),
		...(variants ? { variants } : {}),
		...(contextWindowOptions ? { contextWindowOptions } : {}),
	};
}

async function* singleMessage(): AsyncIterable<SDKUserMessage> {
	yield {
		type: "user",
		message: {
			role: "user",
			content: [{ type: "text", text: "." }],
		},
		parent_tool_use_id: null,
	};
}

export async function probeClaudeCapabilities(
	deps: ProbeDeps,
): Promise<ProbeResult> {
	if (probeOverride) return probeOverride(deps.workspaceRoot);

	const queryFactory = deps.queryFactory ?? sdkQuery;
	const abortController = new AbortController();

	try {
		const options = {
			persistSession: false,
			maxTurns: 0,
			cwd: deps.workspaceRoot,
			env: makeClaudeSdkEnv(),
			settingSources: ["user", "project", "local"],
			abortController,
			allowedTools: [],
			stderr: () => {},
		} satisfies SDKOptions;
		const query = queryFactory({
			prompt: singleMessage(),
			options: decodeClaudeSDKOptionsJsonShape(options),
		});
		const init = await query.initializationResult();
		const decoded = decodeInitializationResult(init);
		if (Either.isLeft(decoded)) {
			(deps.logger ?? defaultLog).warn(
				`Claude initializationResult failed subset decode (using raw with fallbacks): ${decoded.left.message.slice(
					0,
					400,
				)}`,
			);
		}
		const subscriptionType = init.account?.subscriptionType;
		const commands: CommandInfo[] = (init.commands ?? []).map((command) => ({
			name: command.name,
			...(command.description ? { description: command.description } : {}),
			...(command.argumentHint ? { args: command.argumentHint } : {}),
			source: "claude-sdk",
		}));
		const agents: ProviderAgentInfo[] = (init.agents ?? []).map((agent) => ({
			id: agent.name,
			name: agent.name,
			...(agent.description ? { description: agent.description } : {}),
			...(agent.model ? { model: agent.model } : {}),
		}));
		return {
			models: (init.models ?? []).map((model) =>
				sdkModelToConduit(model, subscriptionType),
			),
			...(subscriptionType ? { subscriptionType } : {}),
			commands,
			agents,
		};
	} finally {
		if (!abortController.signal.aborted) {
			abortController.abort();
		}
	}
}

let probeOverride:
	| ((workspaceRoot: string) => Promise<ProbeResult>)
	| undefined;

export function resetCapabilityCacheForTesting(): void {
	// Capability caching now lives in ClaudeCapabilitiesService. This helper
	// remains for tests that reset probe overrides between cases.
}

export function __setProbeOverrideForTesting(
	fn: ((workspaceRoot: string) => Promise<ProbeResult>) | undefined,
): void {
	probeOverride = fn;
}
