// src/lib/provider/claude/claude-adapter.ts
/**
 * ClaudeAdapter -- ProviderAdapter implementation wrapping the Claude
 * Agent SDK (`@anthropic-ai/claude-agent-sdk`).
 *
 * Architectural notes:
 * - One SDK query() per conduit session, not per turn.
 * - Discovery is filesystem + hardcoded: the SDK does not expose a models
 *   or commands API, so we enumerate ~/.claude/ and <workspace>/.claude/
 *   directories for user/project commands and skills.
 * - Shutdown is graceful: close every session's prompt queue, call the
 *   runtime's close(), then clear the session map.
 *
 * NOTE: The Claude Agent SDK is not yet available as a published npm
 * package. sendTurn() and related methods throw "not implemented" errors.
 * The types, structure, and interface contracts are correct for when the
 * SDK becomes available. All other methods (discover, shutdown, interrupt,
 * resolvePermission, resolveQuestion) have working implementations.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { ClaudePermissionBridge } from "./claude-permission-bridge.js";
import type { ClaudeSessionContext } from "./types.js";

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

// ─── Adapter Config ────────────────────────────────────────────────────────

export interface ClaudeAdapterDeps {
	readonly workspaceRoot: string;
}

// ─── ClaudeAdapter ─────────────────────────────────────────────────────────

export class ClaudeAdapter implements ProviderAdapter {
	readonly providerId = "claude" as const;

	/** Active SDK sessions, keyed by conduit sessionId. */
	protected readonly sessions = new Map<string, ClaudeSessionContext>();

	/** Permission bridge instance (shared across sessions). */
	private permissionBridge: ClaudePermissionBridge | undefined;

	constructor(private readonly deps: ClaudeAdapterDeps) {}

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

	async sendTurn(_input: SendTurnInput): Promise<TurnResult> {
		// The Claude Agent SDK (@anthropic-ai/claude-agent-sdk) is not yet
		// available as a published npm package. This method is a typed stub
		// that will be completed when the SDK is available.
		//
		// When implemented, this method will:
		// 1. Create a PromptQueue and SDK query() on first turn
		// 2. Enqueue into existing prompt queue on subsequent turns
		// 3. Run a background stream consumer feeding ClaudeEventTranslator
		// 4. Handle session resumption with fallback to history preamble
		throw new Error(
			"ClaudeAdapter.sendTurn not implemented -- Claude Agent SDK not available",
		);
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
