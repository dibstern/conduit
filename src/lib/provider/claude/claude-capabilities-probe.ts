import type {
	Options as SDKOptions,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo } from "../types.js";
import { TTLCache } from "./ttl-cache.js";

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

interface InitializationResultSubset {
	readonly models?: readonly SDKModelInfoSubset[];
}

interface CapabilityQuery {
	initializationResult(): Promise<InitializationResultSubset>;
}

export interface ProbeResult {
	readonly models: ReadonlyArray<ModelInfo>;
}

export interface ProbeDeps {
	readonly queryFactory?: (params: {
		prompt: string | AsyncIterable<SDKUserMessage>;
		options?: SDKOptions;
	}) => CapabilityQuery;
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

function sdkModelToConduit(model: SDKModelInfoSubset): ModelInfo {
	const limit = inferLimits(model.value);
	const variants = effortLevelsToVariants(model.supportedEffortLevels);
	return {
		id: model.value,
		name: model.displayName,
		providerId: "claude",
		...(limit ? { limit } : {}),
		...(variants ? { variants } : {}),
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
	deps: ProbeDeps = {},
): Promise<ProbeResult> {
	const queryFactory = deps.queryFactory ?? sdkQuery;
	const abortController = new AbortController();

	try {
		const query = queryFactory({
			prompt: singleMessage(),
			options: {
				persistSession: false,
				maxTurns: 0,
				settingSources: [],
				abortController,
				allowedTools: [],
				stderr: () => {},
			},
		});
		const init = await query.initializationResult();
		return {
			models: (init.models ?? []).map(sdkModelToConduit),
		};
	} finally {
		if (!abortController.signal.aborted) {
			abortController.abort();
		}
	}
}

const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;

let probeOverride: (() => Promise<ProbeResult>) | undefined;
let cache: TTLCache<ProbeResult> | undefined;

function makeCache(): TTLCache<ProbeResult> {
	return new TTLCache<ProbeResult>(CAPABILITY_CACHE_TTL_MS, () =>
		probeOverride ? probeOverride() : probeClaudeCapabilities(),
	);
}

export async function getCachedClaudeCapabilities(): Promise<ProbeResult> {
	if (!cache) cache = makeCache();
	return cache.get();
}

export function resetCapabilityCacheForTesting(): void {
	cache = undefined;
}

export function __setProbeOverrideForTesting(
	fn: (() => Promise<ProbeResult>) | undefined,
): void {
	probeOverride = fn;
	cache = undefined;
}
