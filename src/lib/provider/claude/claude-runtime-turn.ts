import { Deferred, Effect, HashMap, Ref } from "effect";
import type { SendTurnInput, TurnResult } from "../types.js";
import { isInterruptedResult } from "./claude-event-translator.js";
import type { ClaudeProviderRuntimeState } from "./claude-provider-runtime.js";
import {
	getOrUndefined,
	getSession,
	getState,
} from "./claude-runtime-state.js";
import type {
	ClaudeSessionContext,
	SDKResultMessage,
	SDKUserMessage,
} from "./types.js";

export function pushTurnDeferred(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	deferred: Deferred.Deferred<TurnResult, Error>,
): Effect.Effect<void> {
	return Ref.update(stateRef, (state) => {
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

export function shiftTurnDeferred(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
): Effect.Effect<Deferred.Deferred<TurnResult, Error> | undefined> {
	return Ref.modify(stateRef, (state) => {
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

export function clearTurnDeferreds(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
): Effect.Effect<void> {
	return Ref.update(stateRef, (state) => ({
		...state,
		turnWaiters: HashMap.remove(state.turnWaiters, sessionId),
	}));
}

export function hasPendingTurn(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
): Effect.Effect<boolean> {
	return Effect.map(getState(stateRef), (state) => {
		const queue = getOrUndefined(HashMap.get(state.turnWaiters, sessionId));
		return (queue?.length ?? 0) > 0;
	});
}

export function rejectTurnIfPendingEffect(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	ctx: ClaudeSessionContext,
	err: Error,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		const current = yield* getSession(stateRef, ctx.sessionId);
		if (current !== ctx) return;

		const deferred = yield* shiftTurnDeferred(stateRef, ctx.sessionId);
		if (!deferred) return;
		Deferred.unsafeDone(deferred, Effect.fail(err));
	});
}

export function resolveTurnEffect(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	ctx: ClaudeSessionContext,
	result: SDKResultMessage,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		const deferred = yield* shiftTurnDeferred(stateRef, ctx.sessionId);
		if (!deferred) return;
		ctx.turnCount++;
		Deferred.unsafeDone(
			deferred,
			Effect.succeed(sdkResultToTurnResult(ctx, result)),
		);
	});
}

export function resolveErrorTurnEffect(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	ctx: ClaudeSessionContext,
	err: unknown,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		const deferred = yield* shiftTurnDeferred(stateRef, ctx.sessionId);
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

export function sdkResultToTurnResult(
	ctx: ClaudeSessionContext,
	result: SDKResultMessage,
): TurnResult {
	// is_error=true can appear on success-subtype results when the SDK
	// wraps an upstream API error (e.g. "unknown provider for model X",
	// 502s after all retries) as a synthetic successful completion.
	// Treat those as errors so the caller sees failure, not success.
	const isErrorFlag = result.is_error;
	const isSuccess = result.subtype === "success" && !isErrorFlag;
	const isInterrupted = !isSuccess && isInterruptedResult(result);
	// Error text source depends on result shape:
	//  - error_during_execution (and other non-success subtypes): `errors` array
	//  - success + is_error=true: `result` field contains the provider error text
	const errorsField = result.subtype === "success" ? undefined : result.errors;
	const resultField = result.subtype === "success" ? result.result : undefined;
	const errorMessage =
		Array.isArray(errorsField) && errorsField.length > 0
			? errorsField.join("; ")
			: typeof resultField === "string" && resultField.length > 0
				? resultField
				: "Unknown error";
	let status: TurnResult["status"] = "error";
	if (isSuccess) status = "completed";
	else if (isInterrupted) status = "interrupted";
	return {
		status,
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

export function buildUserMessage(input: SendTurnInput): SDKUserMessage {
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
	return {
		type: "user",
		message: { role: "user" as const, content },
		parent_tool_use_id: null,
	};
}

export function settleQueuedTurnDeferredsEffect(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	outcome: string | TurnResult,
): Effect.Effect<void, never> {
	return Effect.gen(function* () {
		const state = yield* getState(stateRef);
		const queue = getOrUndefined(HashMap.get(state.turnWaiters, sessionId));
		if (!queue) return;
		for (const d of queue) {
			yield* (
				typeof outcome === "string"
					? Deferred.fail(d, new Error(outcome))
					: Deferred.succeed(d, outcome)
			).pipe(Effect.ignore);
		}
		yield* clearTurnDeferreds(stateRef, sessionId);
	});
}
