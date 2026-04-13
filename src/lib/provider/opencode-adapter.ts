// src/lib/provider/opencode-adapter.ts
// ─── OpenCode Provider Adapter ──────────────────────────────────────────────
// Wraps the existing OpenCodeClient REST API behind the ProviderAdapter
// interface. Translates OpenCode SSE events into canonical events via EventSink.

import type { OpenCodeAPI } from "../instance/opencode-api.js";
import type { PromptOptions } from "../instance/sdk-types.js";
import { createLogger } from "../logger.js";
import type {
	AdapterCapabilities,
	CommandInfo,
	ModelInfo,
	PermissionDecision,
	ProviderAdapter,
	SendTurnInput,
	TurnResult,
} from "./types.js";

const log = createLogger("opencode-adapter");

// ─── Deferred ───────────────────────────────────────────────────────────────

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface OpenCodeAdapterOptions {
	readonly client: OpenCodeAPI;
	readonly workspaceRoot?: string;
}

// ─── OpenCodeAdapter ────────────────────────────────────────────────────────

export class OpenCodeAdapter implements ProviderAdapter {
	readonly providerId = "opencode";

	private readonly client: OpenCodeAPI;
	private readonly workspaceRoot: string | undefined;
	private readonly pendingTurns = new Map<string, Deferred<TurnResult>>();

	constructor(options: OpenCodeAdapterOptions) {
		this.client = options.client;
		this.workspaceRoot = options.workspaceRoot;
	}

	// ─── discover ─────────────────────────────────────────────────────────

	async discover(): Promise<AdapterCapabilities> {
		const [providerResult, commandsRaw, skillsRaw] = await Promise.all([
			this.client.provider.list(),
			this.client.app.commands(),
			this.client.app.skills(this.workspaceRoot),
		]);

		// Map providers -> models
		const models: ModelInfo[] = providerResult.providers.flatMap((provider) =>
			(provider.models ?? []).map((model) => ({
				id: model.id,
				name: model.name,
				providerId: provider.id,
				...(model.limit != null ? { limit: model.limit } : {}),
				...(model.variants ? { variants: model.variants } : {}),
			})),
		);

		// Map commands (builtin)
		const commands: CommandInfo[] = commandsRaw.map((cmd) => ({
			name: cmd.name,
			...(cmd.description != null ? { description: cmd.description } : {}),
			source: "builtin" as const,
		}));

		// Map skills (project-skill)
		const skills: CommandInfo[] = skillsRaw.map((skill) => ({
			name: skill.name,
			...(skill.description != null ? { description: skill.description } : {}),
			source: "project-skill" as const,
		}));

		return {
			models,
			supportsTools: true,
			supportsThinking: true,
			supportsPermissions: true,
			supportsQuestions: true,
			supportsAttachments: true,
			supportsFork: true,
			supportsRevert: true,
			commands: [...commands, ...skills],
		};
	}

	// ─── sendTurn ─────────────────────────────────────────────────────────

	async sendTurn(input: SendTurnInput): Promise<TurnResult> {
		const { sessionId, prompt, model, images, agent, variant, abortSignal } =
			input;

		// Build the prompt options for OpenCode REST
		const promptOptions: PromptOptions = {
			text: prompt,
			// Only include model if explicitly selected (both ids must be non-empty)
			...(model?.providerId && model?.modelId
				? { model: { providerID: model.providerId, modelID: model.modelId } }
				: {}),
			...(images && images.length > 0 ? { images: [...images] } : {}),
			...(agent ? { agent } : {}),
			...(variant ? { variant } : {}),
		};

		// Create a deferred that will be resolved when the turn completes
		// (via notifyTurnCompleted, called by the SSE event pipeline)
		const deferred = createDeferred<TurnResult>();
		this.pendingTurns.set(sessionId, deferred);

		// Handle abort signal
		const onAbort = () => {
			log.info(`Turn aborted for session ${sessionId}`);
			this.client.session.abort(sessionId).catch((err) => {
				log.warn(`Failed to abort session ${sessionId}: ${err}`);
			});
		};

		if (abortSignal.aborted) {
			this.pendingTurns.delete(sessionId);
			return {
				status: "interrupted",
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [],
			};
		}

		abortSignal.addEventListener("abort", onAbort, { once: true });

		try {
			// Send the message -- response comes via SSE, not this call
			await this.client.session.prompt(sessionId, promptOptions);
		} catch (err) {
			// Clean up on send failure
			this.pendingTurns.delete(sessionId);
			abortSignal.removeEventListener("abort", onAbort);

			const message = err instanceof Error ? err.message : String(err);
			log.error(`sendTurn failed for session ${sessionId}: ${message}`);
			return {
				status: "error",
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				error: { code: "SEND_FAILED", message },
				providerStateUpdates: [],
			};
		}

		try {
			// Wait for the turn to complete (resolved by notifyTurnCompleted)
			return await deferred.promise;
		} finally {
			abortSignal.removeEventListener("abort", onAbort);
			this.pendingTurns.delete(sessionId);
		}
	}

	/**
	 * Called by the SSE event pipeline when a turn completes, errors, or
	 * is interrupted. Resolves the pending sendTurn() promise.
	 *
	 * This is the bridge between the existing SSE-based event flow and the
	 * new adapter interface. The SSE pipeline continues to own the connection;
	 * the adapter just waits for notification.
	 */
	notifyTurnCompleted(sessionId: string, result: TurnResult): void {
		const deferred = this.pendingTurns.get(sessionId);
		if (deferred) {
			this.pendingTurns.delete(sessionId);
			deferred.resolve(result);
		}
	}

	// ─── interruptTurn ────────────────────────────────────────────────────

	async interruptTurn(sessionId: string): Promise<void> {
		await this.client.session.abort(sessionId);
	}

	// ─── resolvePermission ────────────────────────────────────────────────

	async resolvePermission(
		_sessionId: string,
		requestId: string,
		decision: PermissionDecision,
	): Promise<void> {
		await this.client.permission.reply(
			_sessionId,
			requestId,
			decision as "once" | "always" | "reject",
		);
	}

	// ─── resolveQuestion ──────────────────────────────────────────────────

	async resolveQuestion(
		_sessionId: string,
		requestId: string,
		answers: Record<string, unknown>,
	): Promise<void> {
		// Convert answers to the format OpenCode expects: string[][]
		const answerArrays = Object.values(answers).map((v) =>
			Array.isArray(v) ? v.map(String) : [String(v)],
		);
		await this.client.question.reply(requestId, answerArrays);
	}

	// ─── shutdown ────────────────────────────────────────────────────────

	async shutdown(): Promise<void> {
		log.info("OpenCodeAdapter shutting down");

		// Reject all pending turns
		for (const [sessionId, deferred] of this.pendingTurns) {
			deferred.reject(
				new Error(
					`Adapter shutdown -- turn for session ${sessionId} cancelled`,
				),
			);
		}
		this.pendingTurns.clear();
	}
}
