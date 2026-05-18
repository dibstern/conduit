// src/lib/provider/claude/claude-provider-runtime.ts
/**
 * ClaudeProviderRuntime -- Effect-owned Claude Agent SDK runtime state and
 * provider operations.
 *
 * Architectural notes:
 * - One SDK query() per conduit session, not per turn.
 * - First sendTurnEffect() creates an EffectPromptQueue (backed by Effect Queue)
 *   + calls query() + starts a background stream consumer. Subsequent
 *   turns enqueue into the existing queue.
 * - Discovery reads the live model list through ClaudeCapabilitiesService. The
 *   service owns the 5-minute TTL/in-flight cache; the probe spawns a throwaway
 *   SDK query, reads initializationResult(), and aborts before any API call.
 *   Nothing persists to disk. Commands and skills are enumerated from ~/.claude/
 *   and <workspace>/.claude/.
 * - Shutdown is graceful: close every session's prompt queue, call the
 *   runtime's close(), then clear the session map.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import {
	Context,
	Data,
	Deferred,
	Duration,
	Effect,
	type Fiber,
	FiberId,
	FiberMap,
	HashMap,
	HashSet,
	Layer,
	MutableHashMap,
	Option,
	Ref,
	type Scope,
} from "effect";
import {
	decodeClaudeSDKMessage,
	decodeClaudeSDKOptionsJsonShape,
	decodeClaudeSDKUserMessage,
} from "../../contracts/providers/claude-agent-sdk.js";
import { createLogger } from "../../logger.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectTag,
} from "../../persistence/effect/claude-event-persist-effect.js";
import { canonicalEvent } from "../../persistence/events.js";
import { ProviderInstanceFailure } from "../errors.js";
import type {
	CommandInfo,
	ModelInfo,
	PermissionDecision,
	ProviderCapabilities,
	SendTurnInput,
	TurnResult,
} from "../types.js";
import type { ProbeResult } from "./claude-capabilities-probe.js";
import {
	type ClaudeCapabilitiesService,
	makeClaudeCapabilitiesService,
	makeUnsafeClaudeCapabilitiesService,
} from "./claude-capabilities-service.js";
import { isInterruptedResult } from "./claude-event-translator.js";
import { ClaudePermissionBridge } from "./claude-permission-bridge.js";
import { makeClaudeSdkEnv } from "./claude-sdk-env.js";
import type {
	ClaudeSubagentSdk,
	MaterializeClaudeSubagentsInput,
	MaterializedClaudeSubagent,
} from "./claude-subagent-materializer.js";
import {
	type ClaudeSubagentTranscriptCursor,
	claudeSubagentSessionId,
	commitClaudeSubagentTranscriptCursor,
	defaultClaudeSubagentSdk,
	stageSessionMessagesToEvents,
} from "./claude-subagent-materializer.js";
import {
	type ClaudeTranslationService,
	makeClaudeTranslationService,
} from "./claude-translation-service.js";
import { makeEffectPromptQueue } from "./effect-prompt-queue.js";
import { serializePriorConversation } from "./history-transcript.js";
import type {
	ClaudeSessionContext,
	ClaudeSubagentLivePoller,
	PromptQueueController,
	Query,
	SDKMessage,
	Options as SDKOptions,
	SDKResultMessage,
	SDKSystemLike,
	SDKUserMessage,
	SessionMessage,
} from "./types.js";

const log = createLogger("claude-provider-runtime");
const SUBAGENT_POLL_TIMEOUT_MS = 2000;
const MAX_DECODE_ERROR_LENGTH = 800;
const MAX_DECODE_PAYLOAD_LOG_LENGTH = 1200;

function supportsMillionTokenContext(modelId: string): boolean {
	const normalized = modelId.toLowerCase();
	return normalized === "sonnet" || /^claude-.*sonnet(?:-|$)/.test(normalized);
}

function claudeApiModelId(
	modelId: string | undefined,
	contextWindow: string | undefined,
): string | undefined {
	if (!modelId) return undefined;
	if (contextWindow === "1m" && supportsMillionTokenContext(modelId)) {
		return `${modelId}[1m]`;
	}
	return modelId;
}

function asError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function isClaudeTaskStartedMessage(
	message: SDKMessage,
): message is SDKSystemLike & {
	readonly subtype: "task_started";
	readonly task_id: string;
	readonly tool_use_id: string;
	readonly session_id?: string;
} {
	if (message.type !== "system" || message.subtype !== "task_started") {
		return false;
	}
	const task = message as Record<string, unknown>;
	return (
		typeof task["task_id"] === "string" &&
		typeof task["tool_use_id"] === "string"
	);
}

function createClaudeSubagentTranscriptCursor(): ClaudeSubagentTranscriptCursor {
	return {
		messageRoles: new Map(),
		textOffsets: new Map(),
		thinkingOffsets: new Map(),
		toolStarts: new Set(),
		toolCompletions: new Set(),
	};
}

function claudeSubagentTitle(subagentType: string | undefined): string {
	if (!subagentType) return "Claude Subagent";
	const first = subagentType[0]?.toUpperCase() ?? "";
	return `${first}${subagentType.slice(1)} Agent`;
}

function truncateForProviderError(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function decodeFailureMessage(boundary: string, cause: unknown): string {
	const details = truncateForProviderError(
		cause instanceof Error ? cause.message : String(cause),
		MAX_DECODE_ERROR_LENGTH,
	);
	return `${boundary} decode failed: ${details}`;
}

class ClaudeSDKDecodeError extends Data.TaggedError("ClaudeSDKDecodeError")<{
	readonly boundary: string;
	readonly cause: unknown;
}> {
	override get message(): string {
		return decodeFailureMessage(this.boundary, this.cause);
	}
}

function logDecodeFailure(
	boundary: string,
	cause: unknown,
	payload: unknown,
): void {
	log.warn(
		`${decodeFailureMessage(boundary, cause)}; payload=${truncateForProviderError(
			safeStringify(payload),
			MAX_DECODE_PAYLOAD_LOG_LENGTH,
		)}`,
	);
}

function decodeProviderMessage(message: unknown): SDKMessage {
	try {
		return decodeClaudeSDKMessage(message);
	} catch (cause) {
		logDecodeFailure("Claude SDK message", cause, message);
		throw new ClaudeSDKDecodeError({ boundary: "Claude SDK message", cause });
	}
}

function validateUserMessage(message: SDKUserMessage): SDKUserMessage {
	try {
		decodeClaudeSDKUserMessage(message);
		return message;
	} catch (cause) {
		logDecodeFailure("Claude SDK user message", cause, message);
		throw new ClaudeSDKDecodeError({
			boundary: "Claude SDK user message",
			cause,
		});
	}
}

function validateOptionsJsonShape(options: SDKOptions): SDKOptions {
	try {
		decodeClaudeSDKOptionsJsonShape(options);
		return options;
	} catch (cause) {
		logDecodeFailure("Claude SDK options", cause, options);
		throw new ClaudeSDKDecodeError({ boundary: "Claude SDK options", cause });
	}
}

// ─── Built-in command catalog ──────────────────────────────────────────────

const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
	{ name: "init", description: "Initialize Claude in the current workspace" },
	{ name: "memory", description: "Manage Claude's memory / CLAUDE.md" },
	{ name: "compact", description: "Compact the conversation to free context" },
	{ name: "cost", description: "Show token usage and cost for the session" },
	{ name: "model", description: "Switch the active model" },
	{ name: "clear", description: "Clear the conversation" },
	{ name: "help", description: "Show help" },
];

// ─── Fallback model catalog ────────────────────────────────────────────────

// Used only when the SDK capability probe fails or returns no models.
const FALLBACK_MODELS: ReadonlyArray<ModelInfo> = [
	{
		id: "opus",
		name: "Claude Opus (latest)",
		providerId: "claude",
		limit: { context: 200_000, output: 32_000 },
	},
	{
		id: "sonnet",
		name: "Claude Sonnet (latest)",
		providerId: "claude",
		limit: { context: 200_000, output: 64_000 },
	},
	{
		id: "haiku",
		name: "Claude Haiku (latest)",
		providerId: "claude",
		limit: { context: 200_000, output: 8_192 },
	},
];

// ─── Frontmatter parser (minimal) ──────────────────────────────────────────

function parseFrontmatter(contents: string): Record<string, string> {
	if (!contents.startsWith("---\n")) return {};
	const end = contents.indexOf("\n---", 4);
	if (end === -1) return {};
	const block = contents.slice(4, end);
	const out: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (key) out[key] = value;
	}
	return out;
}

// ─── Directory scanners ────────────────────────────────────────────────────

function safeReaddir(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

function enumerateCommands(
	baseDir: string,
	source: "user-command" | "project-command",
): CommandInfo[] {
	const dir = join(baseDir, "commands");
	const out: CommandInfo[] = [];
	for (const entry of safeReaddir(dir)) {
		if (!entry.endsWith(".md")) continue;
		const name = entry.slice(0, -3);
		try {
			const contents = readFileSync(join(dir, entry), "utf8");
			const fm = parseFrontmatter(contents);
			const desc = fm["description"];
			out.push({
				name,
				source,
				...(desc ? { description: desc } : {}),
			});
		} catch {
			out.push({ name, source });
		}
	}
	return out;
}

function enumerateSkills(
	baseDir: string,
	source: "user-skill" | "project-skill",
): CommandInfo[] {
	const dir = join(baseDir, "skills");
	const out: CommandInfo[] = [];
	for (const entry of safeReaddir(dir)) {
		const skillPath = join(dir, entry);
		try {
			if (!statSync(skillPath).isDirectory()) continue;
		} catch {
			continue;
		}
		const skillFile = join(skillPath, "SKILL.md");
		try {
			const contents = readFileSync(skillFile, "utf8");
			const fm = parseFrontmatter(contents);
			const skillName = fm["name"] ?? entry;
			const skillDesc = fm["description"];
			out.push({
				name: skillName,
				source,
				...(skillDesc ? { description: skillDesc } : {}),
			});
		} catch {
			// Skip skills without a SKILL.md.
		}
	}
	return out;
}

// ─── Turn deferred ─────────────────────────────────────────────────────────
// Turn queues use Effect Deferred and are completed from SDK stream callbacks.

// ─── Provider Runtime Config ───────────────────────────────────────────────

export interface ClaudeProviderInstanceDeps {
	readonly workspaceRoot: string;
	/** Injectable factory for the SDK's query() function. Defaults to the real SDK. */
	readonly queryFactory?: (params: {
		prompt: AsyncIterable<SDKUserMessage>;
		options?: SDKOptions;
	}) => Query;
	readonly subagentSdk?: ClaudeSubagentSdk;
	readonly materializeSubagents?: (
		input: MaterializeClaudeSubagentsInput,
	) => Effect.Effect<readonly MaterializedClaudeSubagent[], unknown>;
	readonly ensureClaudeSubagentSession?: ClaudeEventPersistEffect["ensureClaudeSubagentSession"];
	readonly subagentPollTimeoutMs?: number;
	readonly capabilitiesService?: ClaudeCapabilitiesService;
}

export interface ClaudeProviderRuntimeState {
	readonly sessions: HashMap.HashMap<string, ClaudeSessionContext>;
	readonly setupLocks: HashMap.HashMap<string, Deferred.Deferred<void, Error>>;
	readonly turnWaiters: HashMap.HashMap<
		string,
		ReadonlyArray<Deferred.Deferred<TurnResult, Error>>
	>;
	readonly endedStreams: HashSet.HashSet<string>;
}

const emptyClaudeProviderRuntimeState = (): ClaudeProviderRuntimeState => ({
	sessions: HashMap.empty(),
	setupLocks: HashMap.empty(),
	turnWaiters: HashMap.empty(),
	endedStreams: HashSet.empty(),
});

const getOrUndefined = <A>(option: Option.Option<A>): A | undefined =>
	Option.isSome(option) ? option.value : undefined;

// Compatibility constructor support for old synchronous unit seams. The scoped
// factory below is the production path; this preserves direct test construction
// without introducing Effect.runSync/runPromise boundaries.
const makeUnsafeFiberMap = <K, A = unknown, E = unknown>(): FiberMap.FiberMap<
	K,
	A,
	E
> =>
	({
		[FiberMap.TypeId]: FiberMap.TypeId,
		deferred: Deferred.unsafeMake<void, E>(FiberId.none),
		state: {
			_tag: "Open",
			backing: MutableHashMap.empty<K, Fiber.RuntimeFiber<A, E>>(),
		},
		[Symbol.iterator](this: {
			state:
				| { readonly _tag: "Closed" }
				| {
						readonly _tag: "Open";
						readonly backing: MutableHashMap.MutableHashMap<
							K,
							Fiber.RuntimeFiber<A, E>
						>;
				  };
		}) {
			if (this.state._tag === "Closed") {
				return [][Symbol.iterator]();
			}
			return this.state.backing[Symbol.iterator]();
		},
	}) as unknown as FiberMap.FiberMap<K, A, E>;

export class ClaudeProviderRuntimeTag extends Context.Tag(
	"ClaudeProviderRuntime",
)<ClaudeProviderRuntimeTag, ClaudeProviderRuntime>() {}

export const makeClaudeProviderRuntime = (
	deps: ClaudeProviderInstanceDeps,
): Effect.Effect<ClaudeProviderRuntime, never, Scope.Scope> =>
	Effect.gen(function* () {
		const stateRef = yield* Ref.make<ClaudeProviderRuntimeState>(
			emptyClaudeProviderRuntimeState(),
		);
		const streamFibers = yield* FiberMap.make<string, void, unknown>();
		const capabilitiesService =
			deps.capabilitiesService ?? (yield* makeClaudeCapabilitiesService());
		const runtime = new ClaudeProviderRuntime(
			{ ...deps, capabilitiesService },
			stateRef,
			streamFibers,
		);
		yield* Effect.addFinalizer(() =>
			runtime.shutdownLocalEffect().pipe(Effect.ignore),
		);
		return runtime;
	});

export const makeUnsafeClaudeProviderRuntime = (
	deps: ClaudeProviderInstanceDeps,
): ClaudeProviderRuntime =>
	new ClaudeProviderRuntime(
		{
			...deps,
			capabilitiesService:
				deps.capabilitiesService ?? makeUnsafeClaudeCapabilitiesService(),
		},
		Ref.unsafeMake<ClaudeProviderRuntimeState>(
			emptyClaudeProviderRuntimeState(),
		),
		makeUnsafeFiberMap<string, void, unknown>(),
	);

export const ClaudeProviderRuntimeLive = (
	deps: ClaudeProviderInstanceDeps,
): Layer.Layer<ClaudeProviderRuntimeTag, never, Scope.Scope> =>
	Layer.scoped(ClaudeProviderRuntimeTag, makeClaudeProviderRuntime(deps));

// ─── ClaudeProviderRuntime ─────────────────────────────────────────────────

export class ClaudeProviderRuntime {
	readonly providerId = "claude";

	/** Permission bridge is stateless; the live sink comes from the session context. */
	private permissionBridge: ClaudePermissionBridge =
		new ClaudePermissionBridge();

	/** Injectable query factory (defaults to real SDK). */
	private readonly queryFactory: NonNullable<
		ClaudeProviderInstanceDeps["queryFactory"]
	>;

	constructor(
		private readonly deps: ClaudeProviderInstanceDeps,
		private readonly stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
		private readonly streamFibers: FiberMap.FiberMap<string, void, unknown>,
	) {
		this.queryFactory =
			deps.queryFactory ??
			(sdkQuery as NonNullable<ClaudeProviderInstanceDeps["queryFactory"]>);
	}

	private mapProviderFailure<A>(
		operation: string,
		effect: Effect.Effect<A, unknown>,
	): Effect.Effect<A, ProviderInstanceFailure> {
		return effect.pipe(
			Effect.mapError(
				(cause) =>
					new ProviderInstanceFailure({
						providerId: this.providerId,
						operation,
						cause,
					}),
			),
		);
	}

	private getState(): Effect.Effect<ClaudeProviderRuntimeState> {
		return Ref.get(this.stateRef);
	}

	private getSession(
		sessionId: string,
	): Effect.Effect<ClaudeSessionContext | undefined> {
		return Effect.map(this.getState(), (state) =>
			getOrUndefined(HashMap.get(state.sessions, sessionId)),
		);
	}

	private isCurrentSession(ctx: ClaudeSessionContext): Effect.Effect<boolean> {
		return Effect.map(
			this.getSession(ctx.sessionId),
			(current) => current === ctx,
		);
	}

	private setSession(
		sessionId: string,
		ctx: ClaudeSessionContext,
	): Effect.Effect<void> {
		return Ref.update(this.stateRef, (state) => ({
			...state,
			sessions: HashMap.set(state.sessions, sessionId, ctx),
		}));
	}

	private removeSession(sessionId: string): Effect.Effect<void> {
		return Ref.update(this.stateRef, (state) => ({
			...state,
			sessions: HashMap.remove(state.sessions, sessionId),
			endedStreams: HashSet.remove(state.endedStreams, sessionId),
		}));
	}

	private getSetupLock(
		sessionId: string,
	): Effect.Effect<Deferred.Deferred<void, Error> | undefined> {
		return Effect.map(this.getState(), (state) =>
			getOrUndefined(HashMap.get(state.setupLocks, sessionId)),
		);
	}

	private setSetupLock(
		sessionId: string,
		deferred: Deferred.Deferred<void, Error>,
	): Effect.Effect<void> {
		return Ref.update(this.stateRef, (state) => ({
			...state,
			setupLocks: HashMap.set(state.setupLocks, sessionId, deferred),
		}));
	}

	private removeSetupLock(sessionId: string): Effect.Effect<void> {
		return Ref.update(this.stateRef, (state) => ({
			...state,
			setupLocks: HashMap.remove(state.setupLocks, sessionId),
		}));
	}

	private isStreamEnded(sessionId: string): Effect.Effect<boolean> {
		return Effect.map(this.getState(), (state) =>
			HashSet.has(state.endedStreams, sessionId),
		);
	}

	private markStreamLive(sessionId: string): Effect.Effect<void> {
		return Ref.update(this.stateRef, (state) => ({
			...state,
			endedStreams: HashSet.remove(state.endedStreams, sessionId),
		}));
	}

	private markStreamEnded(sessionId: string): Effect.Effect<void> {
		return Ref.update(this.stateRef, (state) => ({
			...state,
			endedStreams: HashSet.add(state.endedStreams, sessionId),
		}));
	}

	// ─── discover ─────────────────────────────────────────────────────────

	discoverEffect(): Effect.Effect<
		ProviderCapabilities,
		ProviderInstanceFailure
	> {
		return this.mapProviderFailure(
			"discover",
			this.discoverCapabilitiesEffect(),
		);
	}

	private discoverCapabilitiesEffect(): Effect.Effect<ProviderCapabilities> {
		return Effect.gen(this, function* () {
			const userBase = join(homedir(), ".claude");
			const projectBase = join(this.deps.workspaceRoot, ".claude");

			const fsCommands: CommandInfo[] = [
				...BUILTIN_COMMANDS.map((c) => ({
					name: c.name,
					description: c.description,
					source: "builtin" as const,
				})),
				...enumerateCommands(userBase, "user-command"),
				...enumerateCommands(projectBase, "project-command"),
				...enumerateSkills(userBase, "user-skill"),
				...enumerateSkills(projectBase, "project-skill"),
			];

			const probe = yield* this.getCapabilitiesProbeEffect().pipe(
				Effect.catchAll((err) =>
					Effect.sync(() => {
						log.warn(
							`Capability probe failed; using fallback model list: ${err instanceof Error ? err.message : err}`,
						);
						return {
							models: FALLBACK_MODELS,
							commands: [],
							agents: [],
						} satisfies ProbeResult;
					}),
				),
			);
			const seen = new Set(fsCommands.map((command) => command.name));
			const commands = [
				...fsCommands,
				...probe.commands.filter((command) => !seen.has(command.name)),
			];

			return {
				models: probe.models.length > 0 ? probe.models : FALLBACK_MODELS,
				supportsTools: true,
				supportsThinking: true,
				supportsPermissions: true,
				supportsQuestions: true,
				supportsAttachments: true,
				supportsFork: false,
				supportsRevert: false,
				commands,
				agents: probe.agents,
			};
		});
	}

	private getCapabilitiesProbeEffect(): Effect.Effect<ProbeResult, unknown> {
		const service = this.deps.capabilitiesService;
		return service
			? service.get(this.deps.workspaceRoot)
			: Effect.fail(new Error("Claude capabilities service unavailable"));
	}

	// ─── sendTurn ─────────────────────────────────────────────────────────

	sendTurnEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, ProviderInstanceFailure> {
		return this.mapProviderFailure("sendTurn", this.sendTurnLocalEffect(input));
	}

	private sendTurnLocalEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, unknown> {
		return Effect.gen(this, function* () {
			const { sessionId } = input;

			// Per-session mutex: prevent duplicate session creation.
			const pending = yield* this.getSetupLock(sessionId);
			if (pending) {
				const existingCtx = yield* this.getSession(sessionId);
				if (existingCtx && this.hasAgentChanged(existingCtx, input)) {
					return this.agentSwitchDuringActiveTurnResult(existingCtx, input);
				}
				yield* Deferred.await(pending);
				return yield* this.sendTurnLocalEffect(input);
			}

			const existingCtx = yield* this.getSession(sessionId);
			if (existingCtx?.stopped) {
				// Safety net: any path that stopped this context (interruptTurn,
				// endSession, shutdown) leaves it in sessions with a closed prompt
				// queue; enqueueing would throw. Evict silently and create fresh.
				log.info(`Evicting stopped session on sendTurn: ${sessionId}`);
				const providerState =
					existingCtx.resumeSessionId != null
						? {
								...input.providerState,
								resumeSessionId: existingCtx.resumeSessionId,
							}
						: input.providerState;
				yield* this.removeSession(sessionId);
				return yield* this.createSessionAndSendTurnEffect({
					...input,
					providerState,
				});
			} else if (existingCtx && this.hasAgentChanged(existingCtx, input)) {
				if (yield* this.hasPendingTurn(sessionId)) {
					return this.agentSwitchDuringActiveTurnResult(existingCtx, input);
				}
				return yield* this.restartSessionForAgentChangeEffect(
					existingCtx,
					input,
				);
			} else if (existingCtx && (yield* this.isStreamEnded(sessionId))) {
				log.info(`Evicting ended session stream on sendTurn: ${sessionId}`);
				yield* this.removeSession(sessionId);
			} else if (existingCtx) {
				return yield* this.enqueueTurnEffect(existingCtx, input);
			}

			return yield* this.createSessionAndSendTurnEffect(input);
		});
	}

	// ─── createSessionAndSendTurn ─────────────────────────────────────────

	private createSessionAndSendTurnEffect(
		input: SendTurnInput,
	): Effect.Effect<TurnResult, unknown> {
		return Effect.gen(this, function* () {
			const { sessionId } = input;
			yield* this.markStreamLive(sessionId);

			const deferred = yield* Deferred.make<TurnResult, Error>();
			yield* this.pushTurnDeferred(sessionId, deferred);

			// Set session lock synchronously before any effectful boundary.
			const setupLock = yield* Deferred.make<void, Error>();
			yield* this.setSetupLock(sessionId, setupLock);

			let promptQueue: PromptQueueController | undefined;
			const setup = Effect.gen(this, function* () {
				// 1. Create prompt queue.
				const queue = yield* makeEffectPromptQueue();
				promptQueue = queue;

				// 2. Build initial user message and enqueue.
				const userMessage = yield* Effect.try({
					try: () => validateUserMessage(this.buildUserMessage(input)),
					catch: (cause) => cause,
				});
				yield* queue.enqueue(userMessage);

				// 3. Build query options.
				const abortController = new AbortController();
				// Wire the input's abort signal to our abort controller.
				if (input.abortSignal) {
					if (input.abortSignal.aborted) {
						abortController.abort();
					} else {
						input.abortSignal.addEventListener(
							"abort",
							() => abortController.abort(),
							{ once: true },
						);
					}
				}

				const bridge = this.getPermissionBridge();

				const resumeSessionId =
					typeof input.providerState["resumeSessionId"] === "string"
						? input.providerState["resumeSessionId"]
						: undefined;
				const apiModelId = claudeApiModelId(
					input.model?.modelId,
					input.contextWindow,
				);

				// 4. Create session context (query assigned after creation below).
				const ctx: ClaudeSessionContext = {
					sessionId,
					workspaceRoot: input.workspaceRoot,
					startedAt: new Date().toISOString(),
					promptQueue: queue,
					// Placeholder — immediately overwritten after query factory call.
					query: undefined as unknown as ClaudeSessionContext["query"],
					pendingApprovals: new Map(),
					pendingQuestions: new Map(),
					inFlightTools: new Map(),
					subagentTasks: new Map(),
					subagentPollers: new Map(),
					pendingSubagentMessages: new Map(),
					eventSink: input.eventSink,
					currentTurnId: input.turnId,
					currentModel: input.model?.modelId,
					...(apiModelId ? { currentApiModelId: apiModelId } : {}),
					...(input.agent ? { currentAgent: input.agent } : {}),
					resumeSessionId,
					lastAssistantUuid: undefined,
					turnCount: 0,
					stopped: false,
				};

				// 5. Build SDK options — canUseTool captures ctx by reference.
				const options = yield* Effect.try({
					try: () =>
						validateOptionsJsonShape({
							cwd: input.workspaceRoot,
							abortController,
							env: makeClaudeSdkEnv(),
							includePartialMessages: true,
							forwardSubagentText: true,
							settingSources: ["user", "project", "local"],
							canUseTool: bridge.createCanUseTool(ctx),
							...(apiModelId ? { model: apiModelId } : {}),
							...(resumeSessionId ? { resume: resumeSessionId } : {}),
							...(input.agent ? { agent: input.agent } : {}),
							...(input.variant
								? { effort: input.variant as NonNullable<SDKOptions["effort"]> }
								: {}),
						}),
					catch: (cause) => cause,
				});

				// 6. Call query factory and assign to context.
				const query = yield* Effect.try({
					try: () =>
						this.queryFactory({
							prompt: queue,
							options,
						}),
					catch: (cause) => cause,
				});
				(ctx as { query: ClaudeSessionContext["query"] }).query = query;

				// 7. Store session.
				yield* this.setSession(sessionId, ctx);

				// 8. Start background stream consumer.
				const translator = makeClaudeTranslationService({
					getSink: (ctx) => ctx.eventSink,
				});
				yield* FiberMap.run(
					this.streamFibers,
					sessionId,
					this.runStreamConsumerEffect(ctx, translator),
				);
			});

			yield* setup.pipe(
				Effect.tap(() =>
					Deferred.succeed(setupLock, undefined).pipe(Effect.ignore),
				),
				Effect.catchAll((err) =>
					Effect.gen(this, function* () {
						yield* this.clearTurnDeferreds(sessionId);
						yield* Deferred.fail(setupLock, asError(err)).pipe(Effect.ignore);
						if (promptQueue) {
							yield* promptQueue.close().pipe(Effect.ignore);
						}
						return yield* Effect.fail(err);
					}),
				),
				Effect.ensuring(
					Effect.gen(this, function* () {
						// Clear the lock (but keep the deferred -- it resolves via the stream).
						yield* this.removeSetupLock(sessionId);
					}),
				),
			);

			return yield* Deferred.await(deferred);
		});
	}

	// ─── enqueueTurn ──────────────────────────────────────────────────────

	private enqueueTurnEffect(
		ctx: ClaudeSessionContext,
		input: SendTurnInput,
	): Effect.Effect<TurnResult, unknown> {
		return Effect.gen(this, function* () {
			if (this.hasAgentChanged(ctx, input)) {
				if (yield* this.hasPendingTurn(ctx.sessionId)) {
					return this.agentSwitchDuringActiveTurnResult(ctx, input);
				}
				return yield* this.restartSessionForAgentChangeEffect(ctx, input);
			}

			const baseModelId = input.model?.modelId ?? ctx.currentModel;
			const apiModelId = claudeApiModelId(baseModelId, input.contextWindow);
			if (apiModelId && apiModelId !== ctx.currentApiModelId) {
				yield* Effect.tryPromise({
					try: () => ctx.query.setModel(apiModelId),
					catch: (cause) => cause,
				});
				ctx.currentApiModelId = apiModelId;
			}
			if (input.model?.modelId) {
				ctx.currentModel = input.model.modelId;
			}

			const deferred = yield* Deferred.make<TurnResult, Error>();
			yield* this.pushTurnDeferred(ctx.sessionId, deferred);

			// Update turn id and event sink on context (latest sink wins).
			ctx.currentTurnId = input.turnId;
			ctx.eventSink = input.eventSink;

			// Build and enqueue the user message.
			const userMessage = yield* Effect.try({
				try: () => validateUserMessage(this.buildUserMessage(input)),
				catch: (cause) => cause,
			});
			yield* ctx.promptQueue.enqueue(userMessage);

			return yield* Deferred.await(deferred);
		});
	}

	private hasPendingTurn(sessionId: string): Effect.Effect<boolean> {
		return Effect.map(this.getState(), (state) => {
			const queue = getOrUndefined(HashMap.get(state.turnWaiters, sessionId));
			return (queue?.length ?? 0) > 0;
		});
	}

	private hasAgentChanged(
		ctx: ClaudeSessionContext,
		input: SendTurnInput,
	): boolean {
		return input.agent !== ctx.currentAgent;
	}

	private agentSwitchDuringActiveTurnResult(
		ctx: ClaudeSessionContext,
		input: SendTurnInput,
	): TurnResult {
		return {
			status: "error",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			error: {
				code: "provider_error",
				message: `Cannot switch Claude agent while a turn is active (current=${ctx.currentAgent ?? "default"}, requested=${input.agent ?? "default"}).`,
			},
			providerStateUpdates: [],
		};
	}

	private restartSessionForAgentChangeEffect(
		ctx: ClaudeSessionContext,
		input: SendTurnInput,
	): Effect.Effect<TurnResult, unknown> {
		return Effect.gen(this, function* () {
			yield* this.disposeSessionEffect(ctx, "Claude agent changed");

			const providerState = { ...input.providerState };
			delete providerState["resumeSessionId"];
			const transcript = serializePriorConversation(input.history);
			const prompt =
				transcript.length > 0
					? `${transcript}\n\n${input.prompt}`
					: input.prompt;
			return yield* this.createSessionAndSendTurnEffect({
				...input,
				providerState,
				prompt,
			});
		});
	}

	// ─── runStreamConsumer ────────────────────────────────────────────────

	private runStreamConsumerEffect(
		ctx: ClaudeSessionContext,
		translator: ClaudeTranslationService,
	): Effect.Effect<void, unknown> {
		return this.consumeStreamEffect(ctx, translator);
	}

	private consumeStreamEffect(
		ctx: ClaudeSessionContext,
		translator: ClaudeTranslationService,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			let resultFinalizationStarted = false;
			const iterator = (ctx.query as AsyncIterable<unknown>)[
				Symbol.asyncIterator
			]();
			try {
				while (true) {
					if (ctx.stopped || !(yield* this.isCurrentSession(ctx))) break;
					const nextResult = yield* Effect.either(
						Effect.tryPromise({
							try: () => iterator.next(),
							catch: (cause) => cause,
						}),
					);
					if (nextResult._tag === "Left") throw nextResult.left;
					const next = nextResult.right;
					if (next.done) break;

					const decodedMessage = decodeProviderMessage(next.value);
					if (
						yield* this.pushForwardedSubagentMessageEffect(ctx, decodedMessage)
					) {
						continue;
					}
					yield* translator.translate(ctx, decodedMessage);
					yield* this.handleSubagentTaskStartedEffect(ctx, decodedMessage);
					if (decodedMessage.type === "result") {
						const finalizationCtx = this.detachSubagentFinalizationContext(ctx);
						resultFinalizationStarted = true;
						yield* Effect.forkDaemon(
							this.finalizeSubagentsAfterResultEffect(
								finalizationCtx,
								decodedMessage,
							).pipe(Effect.ignore),
						);
						yield* this.resolveTurnEffect(ctx, decodedMessage);
					}
				}
			} catch (err) {
				this.stopSubagentPollers(ctx);
				if (ctx.stopped || !(yield* this.isCurrentSession(ctx))) return;
				// Clear stale resume cursor so next turn starts a fresh SDK session
				const errMsg = err instanceof Error ? err.message : String(err);
				if (
					ctx.resumeSessionId &&
					/invalid.session|session.*not.*found|session.*expired/i.test(errMsg)
				) {
					ctx.resumeSessionId = undefined;
					log.warn(
						`Session ${ctx.sessionId}: stale resume cursor cleared after: ${errMsg}`,
					);
				}

				yield* translator.translateError(ctx, err).pipe(
					Effect.catchAll((translateErr) =>
						Effect.sync(() => {
							log.warn(
								`translateError failed for session ${ctx.sessionId}: ${translateErr instanceof Error ? translateErr.message : translateErr}`,
							);
						}),
					),
				);
				yield* this.resolveErrorTurnEffect(ctx, err);
			} finally {
				if (!resultFinalizationStarted) {
					this.stopSubagentPollers(ctx);
				}
				if (!ctx.stopped && (yield* this.isCurrentSession(ctx))) {
					const current = yield* this.getSession(ctx.sessionId);
					if (current === ctx) {
						yield* this.markStreamEnded(ctx.sessionId);
						yield* this.rejectTurnIfPendingEffect(
							ctx,
							new Error("SDK stream ended without result"),
						);
					}
				}
			}
		});
	}

	private detachSubagentFinalizationContext(
		ctx: ClaudeSessionContext,
	): ClaudeSessionContext {
		const subagentPollers = new Map(ctx.subagentPollers ?? []);
		const finalizationCtx = {
			...ctx,
			eventSink: ctx.eventSink,
			resumeSessionId: ctx.resumeSessionId,
			lastAssistantUuid: ctx.lastAssistantUuid,
			subagentTasks: new Map(ctx.subagentTasks ?? []),
			subagentPollers,
			get stopped() {
				return ctx.stopped;
			},
		} as ClaudeSessionContext;
		(
			ctx as { subagentPollers: Map<string, ClaudeSubagentLivePoller> }
		).subagentPollers = new Map();
		(
			ctx as { pendingSubagentMessages: Map<string, SessionMessage[]> }
		).pendingSubagentMessages = new Map();
		return finalizationCtx;
	}

	private materializeSubagentsAfterResultEffect(
		ctx: ClaudeSessionContext,
		result: SDKResultMessage,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			if (!this.deps.materializeSubagents) return;
			const parentClaudeSessionId = ctx.resumeSessionId ?? result.session_id;
			if (!parentClaudeSessionId) return;

			const materialized = yield* this.deps.materializeSubagents({
				parentConduitSessionId: ctx.sessionId,
				parentClaudeSessionId,
				workspaceRoot: ctx.workspaceRoot,
				knownTasks: ctx.subagentTasks ?? new Map(),
			});

			for (const child of materialized) {
				if (!child.parentToolUseId || !ctx.eventSink) continue;
				const task = ctx.subagentTasks?.get(child.sdkSubagentId);
				yield* ctx.eventSink.push(
					canonicalEvent(
						"tool.running",
						ctx.sessionId,
						{
							messageId: result.uuid ?? ctx.lastAssistantUuid ?? "",
							partId: child.parentToolUseId,
							metadata: {
								...(task?.description ? { description: task.description } : {}),
								...(task?.subagentType
									? { subagentType: task.subagentType }
									: {}),
								childSessionId: child.childSessionId,
								sdkSubagentId: child.sdkSubagentId,
								providerTaskId: child.sdkSubagentId,
							},
						},
						{ provider: "claude" },
					),
				);
			}
		});
	}

	private finalizeSubagentsAfterResultEffect(
		ctx: ClaudeSessionContext,
		result: SDKResultMessage,
	): Effect.Effect<void, never> {
		return Effect.gen(this, function* () {
			yield* this.finalPollAndStopSubagentsEffect(ctx);
			yield* this.materializeSubagentsAfterResultEffect(ctx, result);
		}).pipe(
			Effect.catchAll((err) =>
				Effect.sync(() => {
					log.warn(
						`Final Claude subagent catch-up failed for ${ctx.sessionId}: ${err instanceof Error ? err.message : err}`,
					);
				}),
			),
		);
	}

	private handleSubagentTaskStartedEffect(
		ctx: ClaudeSessionContext,
		message: SDKMessage,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			if (!isClaudeTaskStartedMessage(message)) return;

			const parentClaudeSessionId = ctx.resumeSessionId ?? message.session_id;
			if (!parentClaudeSessionId) return;

			const pollers = this.getSubagentPollers(ctx);
			const existingPoller = pollers.get(message.task_id);
			const childSessionId =
				existingPoller?.childSessionId ??
				claudeSubagentSessionId({
					parentConduitSessionId: ctx.sessionId,
					parentClaudeSessionId,
					sdkSubagentId: message.task_id,
				});
			const task = ctx.subagentTasks?.get(message.task_id);
			let sessionReady = false;
			if (ctx.subagentTasks) {
				ctx.subagentTasks.set(message.task_id, {
					toolUseId: message.tool_use_id,
					childSessionId,
					...(task?.parentMessageId
						? { parentMessageId: task.parentMessageId }
						: {}),
					...(task?.description ? { description: task.description } : {}),
					...(task?.subagentType ? { subagentType: task.subagentType } : {}),
				});
			}

			const ensureClaudeSubagentSession =
				yield* this.resolveEnsureClaudeSubagentSessionEffect();
			sessionReady = ensureClaudeSubagentSession == null;
			if (ensureClaudeSubagentSession) {
				// UX alternative: delay creating the child session until the first forwarded subagent message or final catch-up returns content.
				const ensured = yield* ensureClaudeSubagentSession({
					childSessionId,
					parentSessionId: ctx.sessionId,
					providerSessionId: message.task_id,
					title: claudeSubagentTitle(task?.subagentType),
				}).pipe(
					Effect.as(true),
					Effect.catchAll((err) =>
						Effect.sync(() => {
							log.warn(
								`Failed to ensure Claude subagent session for ${ctx.sessionId}/${message.task_id}: ${err instanceof Error ? err.message : err}`,
							);
							return false;
						}),
					),
				);
				sessionReady = ensured;
			}

			if (ctx.eventSink) {
				yield* ctx.eventSink
					.push(
						canonicalEvent(
							"tool.running",
							ctx.sessionId,
							{
								messageId: task?.parentMessageId ?? ctx.lastAssistantUuid ?? "",
								partId: message.tool_use_id,
								metadata: {
									...(task?.description
										? { description: task.description }
										: {}),
									...(task?.subagentType
										? { subagentType: task.subagentType }
										: {}),
									childSessionId,
									sdkSubagentId: message.task_id,
									providerTaskId: message.task_id,
								},
							},
							{ provider: "claude" },
						),
					)
					.pipe(
						Effect.catchAll((err) =>
							Effect.sync(() => {
								log.warn(
									`Failed to push Claude subagent metadata for ${ctx.sessionId}/${message.task_id}: ${err instanceof Error ? err.message : err}`,
								);
							}),
						),
					);
			}

			if (existingPoller) {
				if (sessionReady) {
					existingPoller.sessionReady = true;
					yield* this.flushPendingSubagentMessagesEffect(ctx, existingPoller);
				}
				return;
			}

			const poller: ClaudeSubagentLivePoller = {
				sdkSubagentId: message.task_id,
				childSessionId,
				parentClaudeSessionId,
				parentToolUseId: message.tool_use_id,
				cursor: createClaudeSubagentTranscriptCursor(),
				sessionReady,
				active: true,
			};
			pollers.set(message.task_id, poller);
			if (sessionReady) {
				yield* this.flushPendingSubagentMessagesEffect(ctx, poller);
			}
		});
	}

	private pushForwardedSubagentMessageEffect(
		ctx: ClaudeSessionContext,
		message: SDKMessage,
	): Effect.Effect<boolean, unknown> {
		return Effect.gen(this, function* () {
			if (message.type !== "assistant" && message.type !== "user") return false;
			const parentToolUseId =
				"parent_tool_use_id" in message &&
				typeof message.parent_tool_use_id === "string"
					? message.parent_tool_use_id
					: undefined;
			if (!parentToolUseId) return false;

			const poller = this.findSubagentPollerByParentToolUseId(
				ctx,
				parentToolUseId,
			);
			if (!poller?.sessionReady) {
				this.queuePendingSubagentMessage(
					ctx,
					parentToolUseId,
					message as unknown as SessionMessage,
				);
				return true;
			}

			yield* this.pushForwardedSubagentMessagesEffect(ctx, poller, [
				message as unknown as SessionMessage,
			]);
			return true;
		});
	}

	private queuePendingSubagentMessage(
		ctx: ClaudeSessionContext,
		parentToolUseId: string,
		message: SessionMessage,
	): void {
		const pending = this.getPendingSubagentMessages(ctx);
		const messages = pending.get(parentToolUseId);
		if (messages) {
			messages.push(message);
		} else {
			pending.set(parentToolUseId, [message]);
		}
	}

	private flushPendingSubagentMessagesEffect(
		ctx: ClaudeSessionContext,
		poller: ClaudeSubagentLivePoller,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			const pending = this.getPendingSubagentMessages(ctx);
			const messages = pending.get(poller.parentToolUseId);
			if (!messages || messages.length === 0) return;
			pending.delete(poller.parentToolUseId);
			yield* this.pushForwardedSubagentMessagesEffect(ctx, poller, messages);
		});
	}

	private pushForwardedSubagentMessagesEffect(
		ctx: ClaudeSessionContext,
		poller: ClaudeSubagentLivePoller,
		messages: readonly SessionMessage[],
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			const stage = stageSessionMessagesToEvents({
				childSessionId: poller.childSessionId,
				messages,
				cursor: poller.cursor,
			});
			const sink = ctx.eventSink;
			if (!sink) return;
			for (const event of stage.events) {
				yield* sink.push(event);
			}
			commitClaudeSubagentTranscriptCursor(poller.cursor, stage.cursor);
		});
	}

	private findSubagentPollerByParentToolUseId(
		ctx: ClaudeSessionContext,
		parentToolUseId: string,
	): ClaudeSubagentLivePoller | undefined {
		const pollers = ctx.subagentPollers;
		if (!pollers) return undefined;
		for (const poller of pollers.values()) {
			if (poller.parentToolUseId === parentToolUseId) return poller;
		}
		return undefined;
	}

	private getPendingSubagentMessages(
		ctx: ClaudeSessionContext,
	): Map<string, SessionMessage[]> {
		if (ctx.pendingSubagentMessages) return ctx.pendingSubagentMessages;
		const pending = new Map<string, SessionMessage[]>();
		(
			ctx as { pendingSubagentMessages: Map<string, SessionMessage[]> }
		).pendingSubagentMessages = pending;
		return pending;
	}

	private getSubagentPollers(
		ctx: ClaudeSessionContext,
	): Map<string, ClaudeSubagentLivePoller> {
		if (ctx.subagentPollers) return ctx.subagentPollers;
		const pollers = new Map<string, ClaudeSubagentLivePoller>();
		(
			ctx as { subagentPollers: Map<string, ClaudeSubagentLivePoller> }
		).subagentPollers = pollers;
		return pollers;
	}

	private resolveSubagentSdk(): ClaudeSubagentSdk | undefined {
		return (
			this.deps.subagentSdk ??
			(this.deps.materializeSubagents ? defaultClaudeSubagentSdk : undefined)
		);
	}

	private resolveEnsureClaudeSubagentSessionEffect(): Effect.Effect<
		ClaudeEventPersistEffect["ensureClaudeSubagentSession"] | undefined
	> {
		return Effect.gen(this, function* () {
			if (this.deps.ensureClaudeSubagentSession) {
				return this.deps.ensureClaudeSubagentSession;
			}
			const persistOption = yield* Effect.serviceOption(
				ClaudeEventPersistEffectTag,
			);
			return persistOption._tag === "Some"
				? persistOption.value.ensureClaudeSubagentSession
				: undefined;
		});
	}

	private pollClaudeSubagentOnceEffect(
		ctx: ClaudeSessionContext,
		poller: ClaudeSubagentLivePoller,
		subagentSdk: ClaudeSubagentSdk,
		options: { readonly allowInactive?: boolean } = {},
	): Effect.Effect<void, unknown> {
		if (!this.canPollSubagent(ctx, poller, options)) return Effect.void;
		return this.pollClaudeSubagentSnapshotEffect(
			ctx,
			poller,
			subagentSdk,
			options,
		);
	}

	private pollClaudeSubagentSnapshotEffect(
		ctx: ClaudeSessionContext,
		poller: ClaudeSubagentLivePoller,
		subagentSdk: ClaudeSubagentSdk,
		options: { readonly allowInactive?: boolean },
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			if (!this.canPollSubagent(ctx, poller, options)) return;
			const messages = yield* Effect.tryPromise({
				try: () =>
					subagentSdk.getSubagentMessages(
						poller.parentClaudeSessionId,
						poller.sdkSubagentId,
						{ dir: ctx.workspaceRoot },
					),
				catch: (cause) => cause,
			}).pipe(
				Effect.timeoutFail({
					duration: Duration.millis(this.subagentPollTimeoutMs()),
					onTimeout: () =>
						new Error(
							`Claude subagent poll ${ctx.sessionId}/${poller.sdkSubagentId} timed out after ${this.subagentPollTimeoutMs()}ms`,
						),
				}),
			);
			if (!this.canPollSubagent(ctx, poller, options)) return;
			const stage = stageSessionMessagesToEvents({
				childSessionId: poller.childSessionId,
				messages,
				cursor: poller.cursor,
			});
			const sink = ctx.eventSink;
			if (!sink || !this.canPollSubagent(ctx, poller, options)) return;
			for (const event of stage.events) {
				if (!this.canPollSubagent(ctx, poller, options)) return;
				yield* sink.push(event);
			}
			if (!this.canPollSubagent(ctx, poller, options)) return;
			commitClaudeSubagentTranscriptCursor(poller.cursor, stage.cursor);
		});
	}

	private canPollSubagent(
		ctx: ClaudeSessionContext,
		poller: ClaudeSubagentLivePoller,
		options: { readonly allowInactive?: boolean },
	): boolean {
		return (
			poller.sessionReady &&
			!ctx.stopped &&
			(poller.active || options.allowInactive === true)
		);
	}

	private subagentPollTimeoutMs(): number {
		return this.deps.subagentPollTimeoutMs ?? SUBAGENT_POLL_TIMEOUT_MS;
	}

	private finalPollAndStopSubagentsEffect(
		ctx: ClaudeSessionContext,
	): Effect.Effect<void, never> {
		return Effect.gen(this, function* () {
			const pollers = ctx.subagentPollers;
			if (!pollers || pollers.size === 0) return;
			const subagentSdk = this.resolveSubagentSdk();
			if (!subagentSdk) {
				this.stopSubagentPollers(ctx);
				return;
			}

			for (const poller of pollers.values()) {
				yield* this.pollClaudeSubagentOnceEffect(ctx, poller, subagentSdk, {
					allowInactive: true,
				}).pipe(
					Effect.catchAll((err) =>
						Effect.sync(() => {
							log.warn(
								`Final Claude subagent poll failed for ${ctx.sessionId}/${poller.sdkSubagentId}: ${err instanceof Error ? err.message : err}`,
							);
						}),
					),
				);
			}
			this.stopSubagentPollers(ctx);
		});
	}

	private stopSubagentPollers(ctx: ClaudeSessionContext): void {
		const pollers = ctx.subagentPollers;
		if (!pollers) return;
		for (const poller of pollers.values()) {
			poller.active = false;
		}
		pollers.clear();
	}

	// ─── Turn resolution ──────────────────────────────────────────────────

	private pushTurnDeferred(
		sessionId: string,
		deferred: Deferred.Deferred<TurnResult, Error>,
	): Effect.Effect<void> {
		return Ref.update(this.stateRef, (state) => {
			const queue =
				getOrUndefined(HashMap.get(state.turnWaiters, sessionId)) ?? [];
			return {
				...state,
				turnWaiters: HashMap.set(state.turnWaiters, sessionId, [
					...queue,
					deferred,
				]),
			};
		});
	}

	private shiftTurnDeferred(
		sessionId: string,
	): Effect.Effect<Deferred.Deferred<TurnResult, Error> | undefined> {
		return Ref.modify(this.stateRef, (state) => {
			const queue = getOrUndefined(HashMap.get(state.turnWaiters, sessionId));
			if (!queue || queue.length === 0) return [undefined, state];
			const [deferred, ...rest] = queue;
			return [
				deferred,
				{
					...state,
					turnWaiters:
						rest.length === 0
							? HashMap.remove(state.turnWaiters, sessionId)
							: HashMap.set(state.turnWaiters, sessionId, rest),
				},
			];
		});
	}

	private clearTurnDeferreds(sessionId: string): Effect.Effect<void> {
		return Ref.update(this.stateRef, (state) => ({
			...state,
			turnWaiters: HashMap.remove(state.turnWaiters, sessionId),
		}));
	}

	private resolveTurnEffect(
		ctx: ClaudeSessionContext,
		result: SDKResultMessage,
	): Effect.Effect<void> {
		return Effect.gen(this, function* () {
			const deferred = yield* this.shiftTurnDeferred(ctx.sessionId);
			if (!deferred) return;
			ctx.turnCount++;
			Deferred.unsafeDone(
				deferred,
				Effect.succeed(this.sdkResultToTurnResult(ctx, result)),
			);
		});
	}

	private resolveErrorTurnEffect(
		ctx: ClaudeSessionContext,
		err: unknown,
	): Effect.Effect<void> {
		return Effect.gen(this, function* () {
			const deferred = yield* this.shiftTurnDeferred(ctx.sessionId);
			if (!deferred) return;

			// Build an error TurnResult rather than rejecting the promise,
			// so the caller gets a structured response.
			const errorMsg = err instanceof Error ? err.message : String(err);
			Deferred.unsafeDone(
				deferred,
				Effect.succeed({
					status: "error",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					error: { code: "provider_error", message: errorMsg },
					providerStateUpdates: [],
				}),
			);
		});
	}

	private rejectTurnIfPendingEffect(
		ctx: ClaudeSessionContext,
		err: Error,
	): Effect.Effect<void> {
		return Effect.gen(this, function* () {
			const current = yield* this.getSession(ctx.sessionId);
			if (current !== ctx) return;

			const deferred = yield* this.shiftTurnDeferred(ctx.sessionId);
			if (!deferred) return;
			Deferred.unsafeDone(deferred, Effect.fail(err));
		});
	}

	// ─── sdkResultToTurnResult ────────────────────────────────────────────

	private sdkResultToTurnResult(
		ctx: ClaudeSessionContext,
		result: SDKResultMessage,
	): TurnResult {
		// is_error=true can appear on success-subtype results when the SDK
		// wraps an upstream API error (e.g. "unknown provider for model X",
		// 502s after all retries) as a synthetic successful completion.
		// Treat those as errors so the caller sees failure, not success.
		const isErrorFlag = (result as { is_error?: boolean }).is_error === true;
		const isSuccess = result.subtype === "success" && !isErrorFlag;
		const isInterrupted = !isSuccess && isInterruptedResult(result);
		// Error text source depends on result shape:
		//  - error_during_execution (and other non-success subtypes): `errors` array
		//  - success + is_error=true: `result` field contains the provider error text
		const errorsField = (result as unknown as { errors?: string[] }).errors;
		const resultField = (result as unknown as { result?: string }).result;
		const errorMessage =
			Array.isArray(errorsField) && errorsField.length > 0
				? errorsField.join("; ")
				: typeof resultField === "string" && resultField.length > 0
					? resultField
					: "Unknown error";
		return {
			status: isSuccess ? "completed" : isInterrupted ? "interrupted" : "error",
			cost: result.total_cost_usd ?? 0,
			tokens: {
				input: result.usage?.input_tokens ?? 0,
				output: result.usage?.output_tokens ?? 0,
				...(result.usage?.cache_read_input_tokens != null
					? { cacheRead: result.usage.cache_read_input_tokens }
					: {}),
			},
			durationMs: result.duration_ms ?? 0,
			...(!isSuccess && !isInterrupted
				? {
						error: {
							code: "provider_error" as const,
							message: errorMessage,
						},
					}
				: {}),
			providerStateUpdates: [
				...(ctx.resumeSessionId
					? [
							{
								key: "resumeSessionId",
								value: ctx.resumeSessionId,
							},
						]
					: []),
				...(ctx.lastAssistantUuid
					? [
							{
								key: "lastAssistantUuid",
								value: ctx.lastAssistantUuid,
							},
						]
					: []),
				{ key: "turnCount", value: ctx.turnCount },
			],
		};
	}

	// ─── buildUserMessage ─────────────────────────────────────────────────

	private buildUserMessage(input: SendTurnInput): SDKUserMessage {
		// Build content blocks matching the Anthropic SDK's MessageParam.content
		// structure. Uses 'as const' for literal type narrowing.
		const content: Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/png";
						data: string;
					};
			  }
		> = [];
		if (input.images) {
			for (const img of input.images) {
				content.push({
					type: "image" as const,
					source: {
						type: "base64" as const,
						media_type: "image/png" as const,
						data: img,
					},
				});
			}
		}
		content.push({ type: "text" as const, text: input.prompt });
		// SDKUserMessage.message is MessageParam (a complex union from the
		// Anthropic SDK). The cast is confined to this single construction site.
		return {
			type: "user",
			message: { role: "user" as const, content },
			parent_tool_use_id: null,
		} as unknown as SDKUserMessage;
	}

	// ─── interruptTurn ────────────────────────────────────────────────────

	interruptTurnEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.mapProviderFailure(
			"interruptTurn",
			this.interruptSessionEffect(sessionId),
		);
	}

	private interruptSessionEffect(
		sessionId: string,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			const ctx = yield* this.getSession(sessionId);
			if (!ctx) return;

			log.info(`Interrupting turn for session ${sessionId}`);
			yield* this.cleanupSessionEffect(ctx, "Turn interrupted");
			yield* this.rejectQueuedTurnDeferredsEffect(
				ctx.sessionId,
				"Turn interrupted",
			);
		});
	}

	// ─── cleanupSession ──────────────────────────────────────────────────

	/**
	 * Shared cleanup for a single session — used by both interruptTurn()
	 * and shutdown(). Emits tool.completed for in-flight tools, resolves
	 * pending approvals with deny, rejects pending questions, closes the
	 * prompt queue, and interrupts the SDK query.
	 */
	private cleanupSessionEffect(
		ctx: ClaudeSessionContext,
		reason: string,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			if (ctx.stopped) return;

			this.stopSubagentPollers(ctx);

			// 1. Complete in-flight tools as failed via EventSink.
			for (const [, tool] of ctx.inFlightTools) {
				const event = canonicalEvent(
					"tool.completed",
					ctx.sessionId,
					{
						messageId: ctx.lastAssistantUuid ?? "",
						partId: tool.itemId,
						result: null,
						duration: 0,
					},
					{ provider: "claude" },
				);
				if (ctx.eventSink) {
					yield* ctx.eventSink.push(event).pipe(Effect.ignore);
				}
			}
			ctx.inFlightTools.clear();

			// 2. Resolve pending approvals with deny.
			for (const pending of ctx.pendingApprovals.values()) {
				yield* pending.resolve("reject").pipe(Effect.ignore);
			}
			ctx.pendingApprovals.clear();

			// 3. Reject pending questions.
			for (const pending of ctx.pendingQuestions.values()) {
				yield* pending.reject(new Error(reason)).pipe(Effect.ignore);
			}
			ctx.pendingQuestions.clear();

			if (ctx.eventSink?.cancelSessionInteractions) {
				yield* Effect.try({
					try: () => ctx.eventSink?.cancelSessionInteractions?.(reason),
					catch: (cause) => cause,
				}).pipe(
					Effect.flatMap((cancelEffect) => cancelEffect ?? Effect.void),
					Effect.ignore,
				);
			}

			// 4. Close prompt queue.
			yield* ctx.promptQueue.close().pipe(Effect.ignore);

			// 5. Interrupt SDK query.
			yield* Effect.tryPromise({
				try: () => ctx.query.interrupt(),
				catch: (cause) => cause,
			}).pipe(Effect.ignore);

			(ctx as { stopped: boolean }).stopped = true;
		});
	}

	// ─── resolvePermission ────────────────────────────────────────────────

	resolvePermissionEffect(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.mapProviderFailure(
			"resolvePermission",
			Effect.gen(this, function* () {
				const ctx = yield* this.getSession(sessionId);
				if (!ctx) return;

				yield* this.permissionBridge.resolvePermission(
					ctx,
					requestId,
					decision,
				);
			}),
		);
	}

	// ─── resolveQuestion ──────────────────────────────────────────────────

	resolveQuestionEffect(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.mapProviderFailure(
			"resolveQuestion",
			Effect.gen(this, function* () {
				const ctx = yield* this.getSession(sessionId);
				if (!ctx) return;

				const pending = ctx.pendingQuestions.get(requestId);
				if (pending) {
					yield* pending.resolve(answers);
					ctx.pendingQuestions.delete(requestId);
				}
			}),
		);
	}

	// ─── disposeSession / endSession / shutdown ──────────────────────────

	/**
	 * Terminal disposal of a single session: cleanup + reject pending turn
	 * deferreds + close the SDK query + remove from the session map. Shared
	 * by endSessionEffect() and shutdown(); interruptTurnEffect() still uses cleanupSession
	 * alone because interrupt is resumable.
	 */
	private disposeSessionEffect(
		ctx: ClaudeSessionContext,
		reason: string,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			yield* this.cleanupSessionEffect(ctx, reason);

			yield* this.rejectQueuedTurnDeferredsEffect(ctx.sessionId, reason);

			// Terminal close of the SDK query (vs interrupt(), which is resumable).
			yield* Effect.try({
				try: () => ctx.query.close(),
				catch: (cause) => cause,
			}).pipe(Effect.ignore);

			yield* FiberMap.remove(this.streamFibers, ctx.sessionId);
			yield* this.removeSession(ctx.sessionId);
		});
	}

	private rejectQueuedTurnDeferredsEffect(
		sessionId: string,
		reason: string,
	): Effect.Effect<void, never> {
		return Effect.gen(this, function* () {
			const state = yield* this.getState();
			const queue = getOrUndefined(HashMap.get(state.turnWaiters, sessionId));
			if (!queue) return;
			for (const d of queue) {
				yield* Deferred.fail(d, new Error(reason)).pipe(Effect.ignore);
			}
			yield* this.clearTurnDeferreds(sessionId);
		});
	}

	endSessionEffect(
		sessionId: string,
	): Effect.Effect<void, ProviderInstanceFailure> {
		return this.mapProviderFailure(
			"endSession",
			this.endSessionLocalEffect(sessionId),
		);
	}

	private endSessionLocalEffect(
		sessionId: string,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			const ctx = yield* this.getSession(sessionId);
			if (!ctx) return; // idempotent
			log.info(`Ending Claude session: ${sessionId}`);
			yield* this.disposeSessionEffect(ctx, "Session ended (reload)");
		});
	}

	shutdownEffect(): Effect.Effect<void, ProviderInstanceFailure> {
		return this.mapProviderFailure("shutdown", this.shutdownLocalEffect());
	}

	shutdownLocalEffect(): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			log.info("ClaudeProviderRuntime shutting down");
			const state = yield* this.getState();
			for (const ctx of HashMap.values(state.sessions)) {
				yield* this.disposeSessionEffect(
					ctx,
					"Provider instance shutting down",
				);
			}
			yield* Ref.set(this.stateRef, emptyClaudeProviderRuntimeState());
			yield* FiberMap.clear(this.streamFibers);
		});
	}

	// ─── Internal: permission bridge access ──────────────────────────────

	/**
	 * Set the permission bridge. Called during session setup (sendTurn).
	 * Exposed for testing.
	 */
	protected setPermissionBridge(bridge: ClaudePermissionBridge): void {
		this.permissionBridge = bridge;
	}

	/**
	 * Get the permission bridge, creating one if needed.
	 */
	protected getPermissionBridge(): ClaudePermissionBridge {
		return this.permissionBridge;
	}
}
