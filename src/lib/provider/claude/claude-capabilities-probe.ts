import type {
	SDKControlInitializeResponse,
	SDKMessage,
	Options as SDKOptions,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Result, Schema } from "effect";
import {
	ClaudeSDKInitializationResultSubsetSchema,
	decodeClaudeSDKOptionsJsonShape,
} from "../../contracts/providers/claude-agent-sdk.js";
import { createLogger, type Logger } from "../../logger.js";
import { ClaudeBoundaryError } from "../event-sink-errors.js";
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
import { makeClaudeQueryProcesses } from "./claude-query-processes.js";
import { type ClaudeConfigDir, makeClaudeSdkEnv } from "./claude-sdk-env.js";

const defaultLog = createLogger("claude-capabilities-probe");

// Best-effort observability decode: the probe survives an empty catalog, so we
// never fail-close here — but a renamed/absent commands/agents/models/account
// field would silently yield empty catalogs, so log the drift instead.
const decodeInitializationResult = Schema.decodeUnknownResult(
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
	readonly builtin?: boolean;
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

interface SDKMessageSubset {
	readonly type: string;
	readonly subtype?: string;
	readonly skills?: readonly string[];
}

// Iterated only until the system init message, whose skills list is the one
// place the SDK says which commands are skills.
export interface CapabilityQuery extends AsyncIterable<SDKMessageSubset> {
	initializationResult(): Promise<InitializationResultSubset>;
}

type AssertExtends<_A extends B, B> = true;
type _ClaudeSdkInitializationResultFitsConsumedShape = AssertExtends<
	SDKControlInitializeResponse,
	InitializationResultSubset
>;
type _ClaudeSdkMessageFitsConsumedShape = AssertExtends<
	SDKMessage,
	SDKMessageSubset
>;

export interface ProbeResult {
	readonly models: ReadonlyArray<ModelInfo>;
	readonly subscriptionType?: string;
	readonly commands: ReadonlyArray<CommandInfo>;
	readonly agents: ReadonlyArray<ProviderAgentInfo>;
}

export interface ProbeDeps {
	readonly signal?: AbortSignal;
	readonly workspaceRoot: string;
	readonly extraFolders?: readonly string[];
	readonly configDir: ClaudeConfigDir;
	readonly baseEnv?: Readonly<Record<string, string | undefined>>;
	readonly accountEnv?: Readonly<Record<string, string>>;
	readonly queryFactory?: (params: {
		configDir: ClaudeConfigDir;
		prompt: AsyncIterable<SDKUserMessage>;
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

/** Interruption must await children even when the SDK's promise is abandoned. */
export const probeClaudeCapabilitiesEffect = (
	deps: ProbeDeps,
): Effect.Effect<ProbeResult, ClaudeBoundaryError> =>
	Effect.suspend(() => {
		const abortController = new AbortController();
		const processes = makeClaudeQueryProcesses({ killProcessGroup: true });
		const abort = () => abortController.abort();
		deps.signal?.addEventListener("abort", abort, { once: true });
		if (deps.signal?.aborted) abort();
		const failure = (cause: unknown) =>
			new ClaudeBoundaryError({ operation: "probeCapabilities", cause });
		return Effect.tryPromise({
			try: () =>
				probeOverride
					? probeOverride(deps.workspaceRoot)
					: collectClaudeCapabilities(
							deps,
							abortController,
							processes.spawnClaudeCodeProcess,
						),
			catch: failure,
		}).pipe(
			Effect.ensuring(
				Effect.gen(function* () {
					deps.signal?.removeEventListener("abort", abort);
					abort();
					yield* Effect.tryPromise({
						try: processes.stop,
						catch: failure,
					}).pipe(Effect.orDie);
				}),
			),
		);
	});

async function collectClaudeCapabilities(
	deps: ProbeDeps,
	abortController: AbortController,
	spawnClaudeCodeProcess: NonNullable<SDKOptions["spawnClaudeCodeProcess"]>,
): Promise<ProbeResult> {
	const queryFactory = deps.queryFactory ?? sdkQuery;
	const options = {
		persistSession: false,
		maxTurns: 0,
		cwd: deps.workspaceRoot,
		...(deps.extraFolders && deps.extraFolders.length > 0
			? { additionalDirectories: [...deps.extraFolders] }
			: {}),
		env: makeClaudeSdkEnv(deps),
		settingSources: ["user", "project", "local"],
		abortController,
		spawnClaudeCodeProcess,
		allowedTools: [],
		stderr: () => {},
	} satisfies SDKOptions;
	const query = queryFactory({
		configDir: deps.configDir,
		prompt: singleMessage(),
		options: decodeClaudeSDKOptionsJsonShape(options),
	});
	const init = await query.initializationResult();
	// Not query.reloadSkills(): this zero-turn query closes before answering it.
	let skillNames: ReadonlySet<string> = new Set();
	try {
		for await (const message of query) {
			if (message.type === "system" && message.subtype === "init") {
				skillNames = new Set(message.skills ?? []);
				break;
			}
		}
	} catch (error) {
		(deps.logger ?? defaultLog).warn(
			`Claude system init unreadable; keeping SDK command sources: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const decoded = decodeInitializationResult(init);
	if (Result.isFailure(decoded)) {
		(deps.logger ?? defaultLog).warn(
			`Claude initializationResult failed subset decode (using raw with fallbacks): ${decoded.failure.message.slice(
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
		// The SDK flags Claude Code's own commands and bundled skills alike, but
		// not Anthropic's first-party skills plugin, which ships as a plugin.
		source:
			command.builtin || command.name.startsWith("anthropic-skills:")
				? "builtin"
				: skillNames.has(command.name)
					? "plugin-skill"
					: "sdk",
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
}

let probeOverride:
	| ((workspaceRoot: string) => Promise<ProbeResult>)
	| undefined;

export function __setProbeOverrideForTesting(
	fn: ((workspaceRoot: string) => Promise<ProbeResult>) | undefined,
): void {
	probeOverride = fn;
}
