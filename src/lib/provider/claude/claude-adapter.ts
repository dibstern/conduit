// src/lib/provider/claude/claude-adapter.ts
/**
 * ClaudeAdapter -- ProviderAdapter implementation wrapping the Claude
 * Agent SDK (`@anthropic-ai/claude-agent-sdk`).
 *
 * Architectural notes:
 * - One SDK query() per conduit session, not per turn.
 * - First sendTurn() creates a PromptQueue + calls query() + starts a
 *   background stream consumer. Subsequent turns enqueue into the existing
 *   PromptQueue.
 * - Discovery is filesystem + hardcoded: the SDK does not expose a models
 *   or commands API, so we enumerate ~/.claude/ and <workspace>/.claude/
 *   directories for user/project commands and skills.
 * - Shutdown is graceful: close every session's prompt queue, call the
 *   runtime's close(), then clear the session map.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logger.js";
import { canonicalEvent } from "../../persistence/events.js";
import { createDeferred, type Deferred } from "../deferred.js";
import type {
	AdapterCapabilities,
	CommandInfo,
	EventSink,
	ModelInfo,
	PermissionDecision,
	ProviderAdapter,
	SendTurnInput,
	TurnResult,
} from "../types.js";
import {
	ClaudeEventTranslator,
	isInterruptedResult,
} from "./claude-event-translator.js";
import { ClaudePermissionBridge } from "./claude-permission-bridge.js";
import { PromptQueue } from "./prompt-queue.js";
import type {
	ClaudeSessionContext,
	Query,
	Options as SDKOptions,
	SDKResultMessage,
	SDKUserMessage,
} from "./types.js";

const log = createLogger("claude-adapter");

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

// ─── Model catalog ─────────────────────────────────────────────────────────

// Model IDs must match Claude Code backend-recognized identifiers. Outdated
// IDs (e.g. claude-haiku-3-5, claude-opus-4, claude-sonnet-4) return a 502
// "unknown provider for model" error from the backend. Short aliases
// (opus/sonnet/haiku) always resolve to the current generation.
const CLAUDE_MODELS: ReadonlyArray<ModelInfo> = [
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		providerId: "claude",
		limit: { context: 200_000, output: 32_000 },
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		providerId: "claude",
		limit: { context: 200_000, output: 64_000 },
	},
	{
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		providerId: "claude",
		limit: { context: 200_000, output: 8_192 },
	},
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
// Uses the shared Deferred<TurnResult> from the provider utility module.

// ─── Adapter Config ────────────────────────────────────────────────────────

export interface ClaudeAdapterDeps {
	readonly workspaceRoot: string;
	/** Injectable factory for the SDK's query() function. Defaults to the real SDK. */
	readonly queryFactory?: (params: {
		prompt: AsyncIterable<SDKUserMessage>;
		options?: SDKOptions;
	}) => Query;
}

// ─── ClaudeAdapter ─────────────────────────────────────────────────────────

export class ClaudeAdapter implements ProviderAdapter {
	readonly providerId = "claude";

	/** Active SDK sessions, keyed by conduit sessionId. */
	protected readonly sessions = new Map<string, ClaudeSessionContext>();

	/** Per-session mutex: prevents duplicate session creation on concurrent sendTurn(). */
	private readonly sessionLocks = new Map<string, Promise<TurnResult>>();

	/** Per-session queue of deferreds for in-flight turns. */
	private readonly turnDeferredQueues = new Map<
		string,
		Deferred<TurnResult>[]
	>();

	/** Permission bridge instance (shared across sessions). */
	private permissionBridge: ClaudePermissionBridge | undefined;

	/** Injectable query factory (defaults to real SDK). */
	private readonly queryFactory: NonNullable<ClaudeAdapterDeps["queryFactory"]>;

	constructor(private readonly deps: ClaudeAdapterDeps) {
		this.queryFactory =
			deps.queryFactory ??
			(sdkQuery as NonNullable<ClaudeAdapterDeps["queryFactory"]>);
	}

	// ─── discover ─────────────────────────────────────────────────────────

	async discover(): Promise<AdapterCapabilities> {
		const userBase = join(homedir(), ".claude");
		const projectBase = join(this.deps.workspaceRoot, ".claude");

		const commands: CommandInfo[] = [
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

		return {
			models: CLAUDE_MODELS,
			supportsTools: true,
			supportsThinking: true,
			supportsPermissions: true,
			supportsQuestions: true,
			supportsAttachments: true,
			supportsFork: false,
			supportsRevert: false,
			commands,
		};
	}

	// ─── sendTurn ─────────────────────────────────────────────────────────

	async sendTurn(input: SendTurnInput): Promise<TurnResult> {
		const { sessionId } = input;

		// Per-session mutex: prevent duplicate session creation
		const pending = this.sessionLocks.get(sessionId);
		if (pending) {
			await pending;
			return this.sendTurn(input);
		}

		const existingCtx = this.sessions.get(sessionId);
		if (existingCtx?.stopped) {
			// Safety net: any path that stopped this context (interruptTurn,
			// endSession, shutdown) leaves it in sessions with a closed prompt
			// queue; enqueueing would throw. Evict silently and create fresh.
			log.info(`Evicting stopped session on sendTurn: ${sessionId}`);
			this.sessions.delete(sessionId);
		} else if (existingCtx) {
			return this.enqueueTurn(existingCtx, input);
		}

		return this.createSessionAndSendTurn(input);
	}

	// ─── createSessionAndSendTurn ─────────────────────────────────────────

	private async createSessionAndSendTurn(
		input: SendTurnInput,
	): Promise<TurnResult> {
		const { sessionId } = input;

		// Create a deferred for this turn
		const deferred = createDeferred<TurnResult>();
		this.pushTurnDeferred(sessionId, deferred);

		// Set session lock synchronously before any await
		this.sessionLocks.set(sessionId, deferred.promise);

		try {
			// 1. Create prompt queue
			const promptQueue = new PromptQueue();

			// 2. Build initial user message and enqueue
			const userMessage = this.buildUserMessage(input);
			promptQueue.enqueue(userMessage);

			// 3. Build query options
			const abortController = new AbortController();
			// Wire the input's abort signal to our abort controller
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

			// Initialize the permission bridge for this sink.
			const bridge = this.getOrCreatePermissionBridge(input.eventSink);

			const resumeSessionId =
				typeof input.providerState["resumeSessionId"] === "string"
					? input.providerState["resumeSessionId"]
					: undefined;

			// 4. Create session context (query assigned after creation below)
			const ctx: ClaudeSessionContext = {
				sessionId,
				workspaceRoot: input.workspaceRoot,
				startedAt: new Date().toISOString(),
				promptQueue,
				// Placeholder — immediately overwritten after query factory call
				query: undefined as unknown as ClaudeSessionContext["query"],
				pendingApprovals: new Map(),
				pendingQuestions: new Map(),
				inFlightTools: new Map(),
				eventSink: input.eventSink,
				streamConsumer: undefined,
				currentTurnId: input.turnId,
				currentModel: input.model?.modelId,
				resumeSessionId,
				lastAssistantUuid: undefined,
				turnCount: 0,
				stopped: false,
			};

			// 5. Build SDK options — canUseTool captures ctx by reference
			const options: SDKOptions = {
				cwd: input.workspaceRoot,
				abortController,
				includePartialMessages: true,
				settingSources: ["user", "project", "local"],
				canUseTool: bridge.createCanUseTool(ctx),
				...(input.model ? { model: input.model.modelId } : {}),
				...(resumeSessionId ? { resume: resumeSessionId } : {}),
				...(input.agent ? { agent: input.agent } : {}),
			};

			// 6. Call query factory and assign to context
			const query = this.queryFactory({
				prompt: promptQueue,
				options,
			});
			(ctx as { query: ClaudeSessionContext["query"] }).query = query;

			// 6. Store session
			this.sessions.set(sessionId, ctx);

			// 7. Start background stream consumer
			const translator = new ClaudeEventTranslator({
				sink: input.eventSink,
			});
			ctx.streamConsumer = this.runStreamConsumer(ctx, translator);
		} catch (err) {
			// Clean up on failure
			this.turnDeferredQueues.delete(sessionId);
			throw err;
		} finally {
			// Clear the lock (but keep the deferred -- it resolves via the stream)
			this.sessionLocks.delete(sessionId);
		}

		return deferred.promise;
	}

	// ─── enqueueTurn ──────────────────────────────────────────────────────

	private enqueueTurn(
		ctx: ClaudeSessionContext,
		input: SendTurnInput,
	): Promise<TurnResult> {
		const deferred = createDeferred<TurnResult>();
		this.pushTurnDeferred(ctx.sessionId, deferred);

		// Update turn id and event sink on context (latest sink wins)
		ctx.currentTurnId = input.turnId;
		ctx.eventSink = input.eventSink;

		// Build and enqueue the user message
		const userMessage = this.buildUserMessage(input);
		ctx.promptQueue.enqueue(userMessage);

		return deferred.promise;
	}

	// ─── runStreamConsumer ────────────────────────────────────────────────

	private async runStreamConsumer(
		ctx: ClaudeSessionContext,
		translator: ClaudeEventTranslator,
	): Promise<void> {
		try {
			for await (const message of ctx.query) {
				await translator.translate(ctx, message);
				if (message.type === "result") {
					this.resolveTurn(ctx, message as unknown as SDKResultMessage);
				}
			}
		} catch (err) {
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

			try {
				await translator.translateError(ctx, err);
			} catch (translateErr) {
				log.warn(
					`translateError failed for session ${ctx.sessionId}: ${translateErr instanceof Error ? translateErr.message : translateErr}`,
				);
			}
			this.resolveErrorTurn(ctx, err);
		} finally {
			this.rejectTurnIfPending(
				ctx,
				new Error("SDK stream ended without result"),
			);
		}
	}

	// ─── Turn resolution ──────────────────────────────────────────────────

	private pushTurnDeferred(
		sessionId: string,
		deferred: Deferred<TurnResult>,
	): void {
		let queue = this.turnDeferredQueues.get(sessionId);
		if (!queue) {
			queue = [];
			this.turnDeferredQueues.set(sessionId, queue);
		}
		queue.push(deferred);
	}

	private shiftTurnDeferred(
		sessionId: string,
	): Deferred<TurnResult> | undefined {
		const queue = this.turnDeferredQueues.get(sessionId);
		if (!queue || queue.length === 0) return undefined;
		const deferred = queue.shift();
		if (queue.length === 0) {
			this.turnDeferredQueues.delete(sessionId);
		}
		return deferred;
	}

	private resolveTurn(
		ctx: ClaudeSessionContext,
		result: SDKResultMessage,
	): void {
		const deferred = this.shiftTurnDeferred(ctx.sessionId);
		if (!deferred) return;
		ctx.turnCount++;
		deferred.resolve(this.sdkResultToTurnResult(ctx, result));
	}

	private resolveErrorTurn(ctx: ClaudeSessionContext, err: unknown): void {
		const deferred = this.shiftTurnDeferred(ctx.sessionId);
		if (!deferred) return;

		// Build an error TurnResult rather than rejecting the promise,
		// so the caller gets a structured response.
		const errorMsg = err instanceof Error ? err.message : String(err);
		deferred.resolve({
			status: "error",
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			error: { code: "provider_error", message: errorMsg },
			providerStateUpdates: [],
		});
	}

	private rejectTurnIfPending(ctx: ClaudeSessionContext, err: Error): void {
		const deferred = this.shiftTurnDeferred(ctx.sessionId);
		if (!deferred) return;
		deferred.reject(err);
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

	async interruptTurn(sessionId: string): Promise<void> {
		const ctx = this.sessions.get(sessionId);
		if (!ctx) return;

		log.info(`Interrupting turn for session ${sessionId}`);
		await this.cleanupSession(ctx, "Turn interrupted");
	}

	// ─── cleanupSession ──────────────────────────────────────────────────

	/**
	 * Shared cleanup for a single session — used by both interruptTurn()
	 * and shutdown(). Emits tool.completed for in-flight tools, resolves
	 * pending approvals with deny, rejects pending questions, closes the
	 * prompt queue, and interrupts the SDK query.
	 */
	private async cleanupSession(
		ctx: ClaudeSessionContext,
		reason: string,
	): Promise<void> {
		if (ctx.stopped) return;

		// 1. Complete in-flight tools as failed via EventSink
		for (const [, tool] of ctx.inFlightTools) {
			try {
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
				await ctx.eventSink?.push(event);
			} catch {
				// Best-effort — sink may be closed or aborted
			}
		}
		ctx.inFlightTools.clear();

		// 2. Resolve pending approvals with deny
		for (const pending of ctx.pendingApprovals.values()) {
			try {
				pending.resolve("reject");
			} catch {
				// Already resolved
			}
		}
		ctx.pendingApprovals.clear();

		// 3. Reject pending questions
		for (const pending of ctx.pendingQuestions.values()) {
			try {
				pending.reject(new Error(reason));
			} catch {
				// Already resolved
			}
		}
		ctx.pendingQuestions.clear();

		// 4. Close prompt queue
		try {
			ctx.promptQueue.close();
		} catch {
			// Queue already closed
		}

		// 5. Interrupt SDK query
		try {
			await ctx.query.interrupt();
		} catch {
			// Session may already be finished
		}

		(ctx as { stopped: boolean }).stopped = true;
	}

	// ─── resolvePermission ────────────────────────────────────────────────

	async resolvePermission(
		sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Promise<void> {
		const ctx = this.sessions.get(sessionId);
		if (!ctx) return;

		if (this.permissionBridge) {
			await this.permissionBridge.resolvePermission(ctx, requestId, decision);
		} else {
			// Direct resolution via the PendingApproval deferred
			const pending = ctx.pendingApprovals.get(requestId);
			if (pending) {
				pending.resolve(decision);
			}
		}
	}

	// ─── resolveQuestion ──────────────────────────────────────────────────

	async resolveQuestion(
		sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Promise<void> {
		const ctx = this.sessions.get(sessionId);
		if (!ctx) return;

		const pending = ctx.pendingQuestions.get(requestId);
		if (pending) {
			pending.resolve(answers);
			ctx.pendingQuestions.delete(requestId);
		}
	}

	// ─── disposeSession / endSession / shutdown ──────────────────────────

	/**
	 * Terminal disposal of a single session: cleanup + reject pending turn
	 * deferreds + close the SDK query + remove from the session map. Shared
	 * by endSession() and shutdown(); interruptTurn() still uses cleanupSession
	 * alone because interrupt is resumable.
	 */
	private async disposeSession(
		ctx: ClaudeSessionContext,
		reason: string,
	): Promise<void> {
		await this.cleanupSession(ctx, reason);

		// Reject any pending turn deferreds. cleanupSession only rejects one
		// via the stream consumer's finally; additional queued-up deferreds
		// would orphan otherwise.
		const queue = this.turnDeferredQueues.get(ctx.sessionId);
		if (queue) {
			for (const d of queue) {
				try {
					d.reject(new Error(reason));
				} catch {
					// Already settled
				}
			}
			this.turnDeferredQueues.delete(ctx.sessionId);
		}

		// Terminal close of the SDK query (vs interrupt(), which is resumable).
		try {
			ctx.query.close();
		} catch {
			// Already closed
		}

		this.sessions.delete(ctx.sessionId);
	}

	async endSession(sessionId: string): Promise<void> {
		const ctx = this.sessions.get(sessionId);
		if (!ctx) return; // idempotent
		log.info(`Ending Claude session: ${sessionId}`);
		await this.disposeSession(ctx, "Session ended (reload)");
	}

	async shutdown(): Promise<void> {
		log.info("ClaudeAdapter shutting down");
		for (const ctx of [...this.sessions.values()]) {
			await this.disposeSession(ctx, "Adapter shutting down");
		}
		this.sessions.clear(); // safety net
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
	protected getOrCreatePermissionBridge(
		sink: EventSink,
	): ClaudePermissionBridge {
		if (!this.permissionBridge) {
			this.permissionBridge = new ClaudePermissionBridge({ sink });
		}
		return this.permissionBridge;
	}
}
