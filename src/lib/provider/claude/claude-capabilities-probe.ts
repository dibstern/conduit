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
import {
	contextWindowOptionsForModel,
	hasContextWindowRow,
} from "./claude-api-model-id.js";
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
		[/^(?:claude-)?fable/i, 128_000],
		[/^(?:claude-)?opus/i, 32_000],
		[/^(?:claude-)?sonnet/i, 64_000],
		[/^(?:claude-)?haiku/i, 8_192],
	];

interface SDKModelInfoSubset {
	readonly value: string;
	readonly displayName: string;
	readonly resolvedModel?: string;
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
	resolvedModel: string | undefined,
): { context: number; output: number } | undefined {
	for (const [pattern, output] of OUTPUT_LIMIT_BY_FAMILY) {
		if (!pattern.test(modelId)) continue;
		// A trailing [1m] on what the SDK RESOLVED is the SDK's own report that
		// the 1M window is in effect: the CLI drops the suffix for models that
		// do not take it (claude-fable-5[1m] resolves to claude-fable-5) and
		// keeps it for those that do (opus[1m] -> claude-opus-5[1m]). Prefer
		// that over the requested id, which is only what we asked for. Falling
		// back to a flat 200_000 for every family is how this read wrong before.
		const effectiveId = resolvedModel ?? modelId;
		return {
			context: /\[1m\]$/i.test(effectiveId) ? 1_000_000 : 200_000,
			output,
		};
	}
	return undefined;
}

// The SDK bakes the context window into the model's NAME ("Opus (1M context)")
// while conduit exposes that window as its own control. Two owners for one
// fact, and the label wins visually — so the rail reads "Opus (1M context)"
// while the selector beside it says 200k. Strip the qualifier only where we
// actually render the control: without a selector the parenthetical is the
// user's only signal, and dropping it would delete information rather than
// de-duplicate it.
const CONTEXT_WINDOW_QUALIFIER =
	/\s*\(\s*\d+(?:\.\d+)?\s*[km]\s+context(?:\s+window)?\s*\)\s*$/i;

function modelDisplayName(
	displayName: string,
	contextWindowOptions: ReadonlyArray<ContextWindowOption> | undefined,
): string {
	if (contextWindowOptions === undefined) return displayName;
	const stripped = displayName.replace(CONTEXT_WINDOW_QUALIFIER, "").trim();
	return stripped === "" ? displayName : stripped;
}

function effortLevelsToVariants(
	levels: readonly string[] | undefined,
): Record<string, Record<string, unknown>> | undefined {
	if (!levels || levels.length === 0) return undefined;
	return Object.fromEntries(levels.map((level) => [level, {}]));
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
	const normalized = subscriptionType
		.toLowerCase()
		.replace(/[\s_-]+/g, "")
		.replace(/^claude/, "");
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
	log: Logger,
): ModelInfo {
	const limit = inferLimits(model.value, model.resolvedModel);
	const variants = effortLevelsToVariants(model.supportedEffortLevels);
	const contextWindowOptions = adjustForSubscription(
		contextWindowOptionsForModel(model.value),
		subscriptionType,
	);
	if (!hasContextWindowRow(model.value)) {
		log.warn(
			contextWindowOptions
				? `Claude catalog advertises "${model.value}" with no context-window row; falling back to a 1M-default selector because the advertised value carries the [1m] suffix. Add a row to CONTEXT_WINDOW_OPTIONS_BY_MODEL to record the intended default.`
				: `Claude catalog advertises "${model.value}" with no context-window row and no [1m] suffix to infer from; its 200k/1M selector will not render and a requested 1M window will be dropped silently. Add a row to CONTEXT_WINDOW_OPTIONS_BY_MODEL.`,
		);
	}
	return {
		id: model.value,
		name: modelDisplayName(model.displayName, contextWindowOptions),
		providerId: "claude",
		...(model.resolvedModel !== undefined
			? { resolvedModel: model.resolvedModel }
			: {}),
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
				sdkModelToConduit(model, subscriptionType, deps.logger ?? defaultLog),
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
