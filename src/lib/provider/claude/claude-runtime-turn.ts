import type { UUID } from "node:crypto";
import { Deferred, Effect, HashMap, Ref } from "effect";
import { parseAttachmentDataUrl } from "../../attachment-data-url.js";
import {
	isClaudeResumeFailure,
	isClaudeResumeRefused,
} from "../event-sink-errors.js";
import type { SendTurnInput, TurnResult } from "../types.js";
import { isInterruptedResult } from "./claude-event-translator.js";
import type { ClaudeProviderRuntimeState } from "./claude-provider-runtime.js";
import {
	claudeProviderStateUpdates,
	getOrUndefined,
	getSession,
	getState,
} from "./claude-runtime-state.js";
import type {
	ClaudeSessionContext,
	SDKResultMessage,
	SDKUserMessage,
} from "./types.js";

/** A sent input awaiting durable provider intake or a pre-intake failure. */
export interface PendingIntake {
	readonly deferred: Deferred.Deferred<TurnResult, Error>;
	/** A held send's message, placed when the SDK starts the input. */
	readonly unplaced?: SendTurnInput;
	/** Keeps delayed native intake output routable after an indeterminate reply. */
	readonly releaseSink?: Effect.Effect<void>;
}

export type PendingIntakes = ReadonlyMap<string, PendingIntake>;

const zeroTurnResult = (status: TurnResult["status"]): TurnResult => ({
	status,
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
});

function updatePendingIntakes<A>(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	f: (waiters: PendingIntakes) => readonly [A, PendingIntakes],
): Effect.Effect<A> {
	return Ref.modify(stateRef, (state) => {
		const [value, waiters] = f(
			getOrUndefined(HashMap.get(state.pendingIntakes, sessionId)) ?? new Map(),
		);
		return [
			value,
			{
				...state,
				pendingIntakes:
					waiters.size === 0
						? HashMap.remove(state.pendingIntakes, sessionId)
						: HashMap.set(state.pendingIntakes, sessionId, waiters),
			},
		];
	});
}

export function addPendingIntake(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	inputId: string,
	waiter: PendingIntake,
): Effect.Effect<void> {
	return updatePendingIntakes(stateRef, sessionId, (waiters) => [
		undefined,
		new Map(waiters).set(inputId, waiter),
	]);
}

function takePendingIntakes(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	pick: (waiters: PendingIntakes) => readonly string[],
): Effect.Effect<ReadonlyArray<readonly [string, PendingIntake]>> {
	return updatePendingIntakes(stateRef, sessionId, (waiters) => {
		const rest = new Map(waiters);
		const taken = pick(waiters).flatMap((id) => {
			const waiter = waiters.get(id);
			rest.delete(id);
			return waiter ? [[id, waiter] as const] : [];
		});
		return [taken, rest];
	}).pipe(
		Effect.tap((taken) =>
			Effect.forEach(
				taken,
				([, pending]) => pending.releaseSink ?? Effect.void,
			),
		),
	);
}

export function removePendingIntake(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	inputId: string,
): Effect.Effect<void> {
	return Effect.asVoid(
		takePendingIntakes(stateRef, sessionId, () => [inputId]),
	);
}

export function pendingIntakes(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
): Effect.Effect<PendingIntakes> {
	return Effect.map(
		getState(stateRef),
		(state) =>
			getOrUndefined(HashMap.get(state.pendingIntakes, sessionId)) ?? new Map(),
	);
}

export function hasPendingTurn(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
): Effect.Effect<boolean> {
	return Effect.gen(function* () {
		const ctx = yield* getSession(stateRef, sessionId);
		return (
			ctx?.turnInFlight === true ||
			(yield* pendingIntakes(stateRef, sessionId)).size > 0
		);
	});
}

/** The input a result without uuids (older SDKs) answers. */
function currentInputId(
	ctx: ClaudeSessionContext,
	waiters: PendingIntakes,
): string[] {
	if (ctx.currentTurnId && waiters.has(ctx.currentTurnId))
		return [ctx.currentTurnId];
	return [];
}

/** Called only after placement and run.started have been persisted. */
export function acceptIntakeEffect(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	inputId: string,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		const taken = yield* takePendingIntakes(stateRef, sessionId, () => [
			inputId,
		]);
		for (const [, pending] of taken)
			yield* Deferred.succeed(pending.deferred, zeroTurnResult("accepted"));
	});
}

/** `command_lifecycle: cancelled` before `started` resolves the input cancelled. */
export function cancelIntakeEffect(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	inputId: string,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		const taken = yield* takePendingIntakes(stateRef, sessionId, () => [
			inputId,
		]);
		for (const [, waiter] of taken)
			yield* Deferred.succeed(waiter.deferred, zeroTurnResult("cancelled"));
	});
}

/** A result settles only inputs that never reached provider intake. */
export function unacceptedResultInputIds(
	ctx: ClaudeSessionContext,
	result: SDKResultMessage,
	waiters: PendingIntakes,
): string[] {
	const covered =
		result.user_message_uuids ??
		(result.user_message_uuid ? [result.user_message_uuid] : undefined);
	return covered
		? [...waiters.keys()].filter((id) => covered.includes(id))
		: currentInputId(ctx, waiters);
}

export function settleUnacceptedResultEffect(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	ctx: ClaudeSessionContext,
	result: SDKResultMessage,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		const taken = yield* takePendingIntakes(
			stateRef,
			ctx.sessionId,
			(waiters) => unacceptedResultInputIds(ctx, result, waiters),
		);
		const turnResult = sdkResultToTurnResult(ctx, result);
		for (const [, waiter] of taken)
			yield* Deferred.succeed(waiter.deferred, turnResult);
	});
}

export function resolveIntakeErrorEffect(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	ctx: ClaudeSessionContext,
	err: unknown,
): Effect.Effect<void> {
	return Effect.gen(function* () {
		const taken = yield* takePendingIntakes(
			stateRef,
			ctx.sessionId,
			(waiters) => currentInputId(ctx, waiters),
		);
		// Build an error TurnResult rather than rejecting the promise,
		// so the caller gets a structured response.
		const errorMsg = err instanceof Error ? err.message : String(err);
		for (const [, waiter] of taken)
			yield* Deferred.succeed(waiter.deferred, {
				...zeroTurnResult("error"),
				error: { code: "provider_error", message: errorMsg },
				...((ctx.resumeFallbackAllowed || isClaudeResumeRefused(err)) &&
				(!ctx.queryInitialized || isClaudeResumeRefused(err)) &&
				isClaudeResumeFailure(err)
					? { nativeResumeRejected: true }
					: {}),
				providerStateUpdates: [],
			});
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
	const isInterrupted =
		!isSuccess && isInterruptedResult(result, ctx.interruptRequested);
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
		// Session running total; canonical event cost is computed during persistence.
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
		...(!isSuccess &&
		!isInterrupted &&
		ctx.resumeFallbackAllowed &&
		!ctx.queryInitialized &&
		isClaudeResumeFailure(errorMessage)
			? { nativeResumeRejected: true }
			: {}),
		providerStateUpdates: claudeProviderStateUpdates(ctx, isSuccess),
	};
}

export function buildUserMessage(input: SendTurnInput): SDKUserMessage {
	const content: Exclude<SDKUserMessage["message"]["content"], string> = [];
	for (const value of input.images ?? []) {
		const { mime, data, name } = parseAttachmentDataUrl(value);
		if (mime === "text/plain" || mime === "application/pdf") {
			content.push({
				type: "document",
				...(name ? { title: name } : {}),
				source:
					mime === "text/plain"
						? {
								type: "text",
								media_type: mime,
								data: new TextDecoder("utf-8", { fatal: true }).decode(
									Buffer.from(data, "base64"),
								),
							}
						: { type: "base64", media_type: mime, data },
			});
		} else {
			content.push({
				type: "image",
				source: { type: "base64", media_type: mime, data },
			});
		}
	}
	const text =
		input.workspaceMoveDirective === undefined
			? input.prompt
			: `${input.workspaceMoveDirective}\n${input.prompt}`;
	if (text) content.push({ type: "text", text });
	// The input id is the SDK message uuid, so lifecycle frames and results
	// name the input they belong to.
	return {
		type: "user",
		message: { role: "user" as const, content },
		parent_tool_use_id: null,
		// Input ids are browser-minted UUIDs; the SDK types the field as one.
		uuid: input.inputId as UUID,
		priority: "next",
	};
}

export function settlePendingIntakesEffect(
	stateRef: Ref.Ref<ClaudeProviderRuntimeState>,
	sessionId: string,
	outcome: string | TurnResult,
): Effect.Effect<void, never> {
	return Effect.gen(function* () {
		const taken = yield* takePendingIntakes(stateRef, sessionId, (waiters) => [
			...waiters.keys(),
		]);
		for (const [, waiter] of taken) {
			yield* (
				typeof outcome === "string"
					? Deferred.fail(waiter.deferred, new Error(outcome))
					: Deferred.succeed(waiter.deferred, outcome)
			).pipe(Effect.ignore);
		}
	});
}
