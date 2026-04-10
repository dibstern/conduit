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

const CLAUDE_MODELS: ReadonlyArray<ModelInfo> = [
	{
		id: "claude-opus-4",
		name: "Claude Opus 4",
		providerId: "claude",
		limit: { context: 200_000, output: 32_000 },
	},
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		providerId: "claude",
		limit: { context: 200_000, output: 64_000 },
	},
	{
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		providerId: "claude",
		limit: { context: 200_000, output: 32_000 },
	},
	{
		id: "claude-haiku-3-5",
		name: "Claude Haiku 3.5",
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

interface TurnDeferred {
	readonly resolve: (result: TurnResult) => void;
	readonly reject: (error: unknown) => void;
	readonly promise: Promise<TurnResult>;
}

function createTurnDeferred(): TurnDeferred {
	let resolve!: (result: TurnResult) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<TurnResult>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { resolve, reject, promise };
}

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
	readonly providerId = "claude" as const;

	/** Active SDK sessions, keyed by conduit sessionId. */
	protected readonly sessions = new Map<string, ClaudeSessionContext>();

	/** Per-session mutex: prevents duplicate session creation on concurrent sendTurn(). */
	private readonly sessionLocks = new Map<string, Promise<TurnResult>>();

	/** Per-session queue of deferreds for in-flight turns. */
	private readonly turnDeferredQueues = new Map<string, TurnDeferred[]>();

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
		if (existingCtx) {
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
		const deferred = createTurnDeferred();
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

			// Ensure the permission bridge is initialized for this sink.
			// The bridge is stored on the adapter and used by resolvePermission().
			this.getOrCreatePermissionBridge(input.eventSink);

			const resumeSessionId =
				typeof input.providerState["resumeSessionId"] === "string"
					? input.providerState["resumeSessionId"]
					: undefined;

			const options: SDKOptions = {
				cwd: input.workspaceRoot,
				abortController,
				includePartialMessages: true,
				...(input.model ? { model: input.model.modelId } : {}),
				...(resumeSessionId ? { resume: resumeSessionId } : {}),
				...(input.agent ? { agent: input.agent } : {}),
			};

			// 4. Call query factory
			const query = this.queryFactory({
				prompt: promptQueue,
				options,
			});

			// 5. Create session context
			const ctx: ClaudeSessionContext = {
				sessionId,
				workspaceRoot: input.workspaceRoot,
				startedAt: new Date().toISOString(),
				promptQueue,
				query,
				pendingApprovals: new Map(),
				pendingQuestions: new Map(),
				inFlightTools: new Map(),
				streamConsumer: undefined,
				currentTurnId: input.turnId,
				currentModel: input.model?.modelId,
				resumeSessionId,
				lastAssistantUuid: undefined,
				turnCount: 0,
				stopped: false,
			};

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
		const deferred = createTurnDeferred();
		this.pushTurnDeferred(ctx.sessionId, deferred);

		// Update turn id on context
		ctx.currentTurnId = input.turnId;

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
			await translator.translateError(ctx, err);
			this.resolveErrorTurn(ctx, err);
		} finally {
			this.rejectTurnIfPending(
				ctx,
				new Error("SDK stream ended without result"),
			);
		}
	}

	// ─── Turn resolution ──────────────────────────────────────────────────

	private pushTurnDeferred(sessionId: string, deferred: TurnDeferred): void {
		let queue = this.turnDeferredQueues.get(sessionId);
		if (!queue) {
			queue = [];
			this.turnDeferredQueues.set(sessionId, queue);
		}
		queue.push(deferred);
	}

	private shiftTurnDeferred(sessionId: string): TurnDeferred | undefined {
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
		const isSuccess = result.subtype === "success";
		const isInterrupted = !isSuccess && isInterruptedResult(result);
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
			...(!isSuccess && !isInterrupted && "errors" in result
				? {
						error: {
							code: result.subtype,
							message:
								(
									result as unknown as {
										errors?: string[];
									}
								).errors?.join("; ") ?? "Unknown error",
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
		const content: Array<{
			type: string;
			text?: string;
			source?: unknown;
		}> = [];
		if (input.images) {
			for (const img of input.images) {
				content.push({
					type: "image",
					source: {
						type: "base64",
						media_type: "image/png",
						data: img,
					},
				});
			}
		}
		content.push({ type: "text", text: input.prompt });
		return {
			type: "user",
			message: { role: "user", content },
			parent_tool_use_id: null,
		} as unknown as SDKUserMessage;
	}

	// ─── interruptTurn ────────────────────────────────────────────────────

	async interruptTurn(sessionId: string): Promise<void> {
		const ctx = this.sessions.get(sessionId);
		if (!ctx) return;

		log.info(`Interrupting turn for session ${sessionId}`);

		// Resolve all pending approvals with deny
		for (const pending of ctx.pendingApprovals.values()) {
			try {
				pending.resolve("reject");
			} catch {
				// Already resolved
			}
		}
		ctx.pendingApprovals.clear();

		// Reject all pending questions
		for (const pending of ctx.pendingQuestions.values()) {
			try {
				pending.reject(new Error("Turn interrupted"));
			} catch {
				// Already resolved
			}
		}
		ctx.pendingQuestions.clear();

		// Complete in-flight tools as failed
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
				// Note: In a full implementation, this would push to the EventSink.
				// The EventSink is not stored on the session context in the current
				// design -- it's passed per-turn via SendTurnInput. This is a
				// limitation of the stub implementation.
				void event;
			} catch {
				// Best-effort
			}
		}
		ctx.inFlightTools.clear();

		// Close the prompt queue and interrupt
		try {
			ctx.promptQueue.close();
		} catch {
			// Queue already closed
		}

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

	// ─── shutdown ────────────────────────────────────────────────────────

	async shutdown(): Promise<void> {
		log.info("ClaudeAdapter shutting down");

		const sessionsToStop = [...this.sessions.values()];
		for (const ctx of sessionsToStop) {
			if (ctx.stopped) continue;

			// Resolve pending approvals with deny
			for (const pending of ctx.pendingApprovals.values()) {
				try {
					pending.resolve("reject");
				} catch {
					// Already resolved
				}
			}
			ctx.pendingApprovals.clear();

			// Reject pending questions
			for (const pending of ctx.pendingQuestions.values()) {
				try {
					pending.reject(new Error("Adapter shutting down"));
				} catch {
					// Already resolved
				}
			}
			ctx.pendingQuestions.clear();

			try {
				ctx.promptQueue.close();
			} catch {
				// Queue already closed
			}

			try {
				await ctx.query.interrupt();
			} catch {
				// Session may already be finished
			}

			try {
				ctx.query.close();
			} catch {
				// Ignore
			}

			(ctx as { stopped: boolean }).stopped = true;
		}
		this.sessions.clear();
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
