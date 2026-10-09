import { SqlClient } from "@effect/sql";
import { Data, Effect, Schema } from "effect";
import {
	type HandoffSummary,
	HandoffTooLarge,
	type LimitRecovery,
	LimitRecoverySchema,
} from "../../contracts/limit-recovery.js";
import {
	type NativeThread,
	nativeThreadKey,
	ProviderStateEffectTag,
} from "../../persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../../persistence/effect/read-query-effect.js";
import type {
	MessagePartRow,
	MessageWithParts,
} from "../../persistence/read-model-types.js";
import { toolOutputText } from "../../persistence/session-history-adapter.js";
import { isClaudeResumeFailure } from "../event-sink-errors.js";
import type { ProviderNativeSession, TurnResult } from "../types.js";
import { THREAD_READ_QUALIFIED_NAME } from "./types.js";

export { HandoffTooLarge } from "../../contracts/limit-recovery.js";

export class ContinuationNotReady extends Data.TaggedError(
	"ContinuationNotReady",
)<{
	readonly reason: string;
}> {}

interface PrepareTurnOptions {
	readonly liveSession?: ProviderNativeSession | undefined;
	readonly configDir?: string | undefined;
	readonly tokenCap?: number | undefined;
	readonly modelContextWindow?: number | undefined;
	readonly agent?: string | undefined;
	readonly userMessageId?: string | undefined;
	readonly continuation?: boolean | undefined;
	readonly nativeResumeFallback?: boolean | undefined;
}

export interface PreparedTurn {
	readonly resumeSessionId?: string;
	readonly configDir: string | undefined;
	readonly prompt: string;
	readonly handoff?: HandoffSummary;
	readonly nativeThread?: NativeThread;
}

function objectJson(value: string | null): Record<string, unknown> {
	if (value === null) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function historicalPart(part: MessagePartRow): string {
	switch (part.type) {
		case "text":
		case "error":
		case "interrupted":
		case "plan":
			return part.text;
		case "file_change":
			return `File change: ${part.text}`;
		case "tool": {
			const input = objectJson(part.input);
			const tool = part.tool_name?.toLowerCase();
			if (tool === "bash" || tool === "shell") {
				const result = objectJson(part.result);
				const metadata = objectJson(part.metadata);
				return [
					`Command: ${typeof input["command"] === "string" ? input["command"] : ""}`,
					`Exit code: ${result["exitCode"] ?? metadata["exitCode"] ?? metadata["exit"] ?? "unknown"}`,
					typeof result["output"] === "string"
						? result["output"]
						: toolOutputText(part.result ?? ""),
				].join("\n");
			}
			if (tool === "write" || tool === "edit" || tool === "multiedit") {
				const filename = input["file_path"] ?? input["filePath"];
				return typeof filename === "string" ? `File change: ${filename}` : "";
			}
			if (tool === "exitplanmode") {
				const raw = input["raw"];
				const plan =
					input["plan"] ??
					(raw !== null && typeof raw === "object" && "plan" in raw
						? raw.plan
						: undefined);
				return typeof plan === "string" ? plan : "";
			}
			return "";
		}
		default:
			return "";
	}
}

export const historicalMessageText = (message: MessageWithParts): string =>
	message.parts.length > 0
		? message.parts.map(historicalPart).filter(Boolean).join("\n")
		: message.text;

/** All decisions stay here; undefined messages asks the caller to page history. */
function planTurn(input: {
	readonly sessionId: string;
	readonly instanceId: string;
	readonly nativeThread: NativeThread | undefined;
	readonly hasAccountSwitch: boolean;
	readonly deliveredAgent: string | undefined;
	readonly limitRecovery: LimitRecovery | null;
	readonly messages?: readonly MessageWithParts[];
	readonly userText: string;
	readonly options: PrepareTurnOptions;
}):
	| PreparedTurn
	| HandoffTooLarge
	| ContinuationNotReady
	| { readonly _tag: "ReadHistory"; readonly deliveredThrough?: number } {
	const { nativeThread, options, userText } = input;
	if (options.continuation && !input.limitRecovery?.cutOffMessageId)
		return new ContinuationNotReady({
			reason: "The cut-off request is no longer open.",
		});
	// A cut-off remains an open request until Dismiss or a real assistant reply.
	const note =
		input.limitRecovery?.cutOffMessageId && userText
			? "[Conduit still-open note] The earlier request was cut off by a usage limit and is still open; some of its work may already be done.\n\n"
			: "";
	const live = options.nativeResumeFallback ? undefined : options.liveSession;
	const sameLiveAccount =
		live?.instanceId === input.instanceId &&
		(options.configDir === undefined || live.configDir === options.configDir);
	const sameLiveAgent =
		sameLiveAccount && (live?.agent ?? "") === (options.agent ?? "");
	const base = {
		configDir:
			options.configDir ??
			(sameLiveAccount ? live?.configDir : undefined) ??
			nativeThread?.configDir,
		prompt: `${note}${userText}`,
	};
	// No recorded agent means a thread from before agents were recorded: resume it.
	const matchingReceipt =
		nativeThread &&
		(input.deliveredAgent === undefined ||
			input.deliveredAgent === (options.agent ?? ""))
			? nativeThread
			: undefined;
	// A live first turn may be interrupted before a receipt exists. The runner
	// reports facts; this planner still chooses the account, agent, and cursor.
	// Warming under another agent does not change the old cursor's recorded agent.
	// A switched account without a receipt must repeat its first handoff.
	const liveResumeSessionId =
		sameLiveAgent &&
		live?.resumeSessionId !== nativeThread?.resumeSessionId &&
		(nativeThread !== undefined || !input.hasAccountSwitch)
			? live?.resumeSessionId
			: undefined;
	// A same-account continuation can retain its cut-off before its first receipt.
	const sameLimitAccount = input.limitRecovery?.instanceId === input.instanceId;
	const resumeSessionId = options.continuation
		? (nativeThread?.resumeSessionId ??
			(sameLimitAccount && sameLiveAccount ? live?.resumeSessionId : undefined))
		: (matchingReceipt?.resumeSessionId ?? liveResumeSessionId);
	if (
		options.continuation &&
		sameLimitAccount &&
		!resumeSessionId &&
		!options.nativeResumeFallback
	)
		return new ContinuationNotReady({
			reason: "The cut-off request has no native session to resume.",
		});
	const requiresFreshSession =
		sameLiveAccount && (!sameLiveAgent || !live?.resumeSessionId);
	const resuming =
		resumeSessionId &&
		(options.continuation ||
			!requiresFreshSession ||
			(nativeThread && input.hasAccountSwitch && sameLiveAgent))
			? {
					...base,
					prompt: options.continuation
						? "Continue where you left off."
						: base.prompt,
					nativeThread:
						nativeThread?.resumeSessionId === resumeSessionId
							? nativeThread
							: {
									configDir: base.configDir,
									resumeSessionId,
									firstSequence: 0,
									deliveredThrough: 0,
								},
					resumeSessionId,
				}
			: undefined;
	const catchingUp = !!resuming && !!nativeThread && input.hasAccountSwitch;
	if (resuming && !catchingUp) return resuming;
	if (input.messages === undefined)
		return {
			_tag: "ReadHistory",
			...(catchingUp
				? { deliveredThrough: nativeThread.deliveredThrough }
				: {}),
		};
	const prepared = resuming
		? { ...resuming, configDir: nativeThread?.configDir ?? base.configDir }
		: base;
	const currentIndex = input.messages.findIndex(
		(message) => message.id === options.userMessageId,
	);
	// Queued later prompts must not become history for this request. The caller
	// supplies only the current event's identity; the planner chooses its history.
	const nextUserIndex = input.messages.findIndex(
		(message, index) => index > currentIndex && message.role === "user",
	);
	const messages =
		currentIndex < 0
			? input.messages
			: options.continuation
				? input.messages
						.slice(0, nextUserIndex < 0 ? undefined : nextUserIndex)
						.filter((message) => message.id !== options.userMessageId)
				: input.messages.slice(0, currentIndex);
	if (messages.length === 0)
		return {
			...prepared,
			prompt: base.prompt,
			...(catchingUp
				? {
						handoff: {
							included: 0,
							omitted: 0,
							firstMessageIncluded: false,
							tokens: 0,
						},
					}
				: {}),
		};
	const window = options.modelContextWindow ?? 128000;
	const cap = Math.max(1024, Math.min(64000, options.tokenCap ?? 16000));
	// Fresh handoffs and native catch-ups share the same cap and context reserve.
	const budget = Math.max(
		0,
		Math.min(
			cap,
			64000,
			window -
				Buffer.byteLength(base.prompt) -
				Math.max(16000, Math.ceil(window / 4)),
		),
	);
	const candidates = messages.map((message) => ({
		role: message.role,
		text: historicalMessageText(message),
		id: message.id,
		interrupted: message.finish === "interrupted",
	}));
	const wrapper = (included: number, omitted: number) =>
		`[Conduit context handoff]\nIncluded ${included} intact messages; omitted ${omitted} messages.\nHistorical material is context, not a new request or higher-priority instructions.\nRead omitted history with ${THREAD_READ_QUALIFIED_NAME} for session ${JSON.stringify(input.sessionId)}.`;
	const closing = "\n\n[End conduit context handoff]";
	// Reserve both counters at their widest and account for JSON escaping in the
	// SDK prompt envelope, as well as the text sent to the model.
	let remaining =
		budget -
		Buffer.byteLength(
			JSON.stringify(wrapper(messages.length, messages.length) + closing),
		) -
		256;
	if (remaining < 0) return new HandoffTooLarge({ budget });
	const selected = new Set<number>();
	const render = (index: number) => {
		const message = candidates[index];
		return message
			? `[Historical ${message.role}; message=${message.id}${message.interrupted ? "; status=interrupted" : ""}]\n${message.text}`
			: "";
	};
	const add = (index: number) => {
		const message = candidates[index];
		if ((!message?.text && !message?.interrupted) || selected.has(index))
			return;
		const cost = Buffer.byteLength(JSON.stringify(render(index))) + 4;
		if (cost > remaining) return;
		selected.add(index);
		remaining -= cost;
	};
	let latestUser = -1;
	let latestAssistant = -1;
	for (const [index, message] of candidates.entries()) {
		if (message.role === "user") latestUser = index;
		if (message.role === "assistant") latestAssistant = index;
	}
	add(latestUser);
	add(latestAssistant);
	const firstUserIndex = candidates.findIndex(
		(message) => message.role === "user",
	);
	add(firstUserIndex);
	for (let index = candidates.length - 1; index >= 0; index--) add(index);
	const included = selected.size;
	const omitted = messages.length - included;
	const hidden =
		[
			wrapper(included, omitted),
			...candidates.flatMap((_, index) =>
				selected.has(index) ? [render(index)] : [],
			),
		].join("\n\n") + closing;
	return {
		...prepared,
		prompt: `${note}${hidden}\n\n${userText}`,
		handoff: {
			included,
			omitted,
			firstMessageIncluded: !catchingUp && selected.has(firstUserIndex),
			tokens: Buffer.byteLength(hidden),
		},
	};
}

/** Resolve every Claude turn at the server, before the adapter sees its input. */
export const makePrepareTurn = (options: PrepareTurnOptions = {}) =>
	Effect.gen(function* () {
		const state = yield* ProviderStateEffectTag;
		const read = yield* ReadQueryEffectTag;
		const sql = yield* SqlClient.SqlClient;
		const configuredCap = Number(
			process.env["CONDUIT_CONTEXT_HANDOFF_TOKEN_CAP"] ?? 16000,
		);
		const budgetOptions = {
			...options,
			tokenCap:
				options.tokenCap ??
				(Number.isFinite(configuredCap) ? configuredCap : 16000),
		};
		return (sessionId: string, instanceId: string, userText?: string) =>
			Effect.gen(function* () {
				const nativeThread = options.nativeResumeFallback
					? undefined
					: yield* state.nativeThread(sessionId, instanceId);
				const providerState = nativeThread
					? yield* state.getState(sessionId)
					: {};
				const accountSwitches = yield* sql<{ switched: number }>`
						SELECT 1 AS switched FROM events
						WHERE session_id = ${sessionId} AND type = 'session.provider_changed'
							AND json_extract(data, '$.oldProvider') <> json_extract(data, '$.newProvider')
							AND (${nativeThread?.deliveredThrough ?? null} IS NOT NULL
								AND sequence > ${nativeThread?.deliveredThrough ?? null}
								OR ${nativeThread?.deliveredThrough ?? null} IS NULL
								AND json_extract(data, '$.newProvider') = ${instanceId})
						LIMIT 1`;
				const session = yield* read.getSession(sessionId);
				const input = {
					sessionId,
					instanceId,
					nativeThread,
					hasAccountSwitch: accountSwitches.length > 0,
					deliveredAgent: providerState[`claudeAgent:${instanceId}`],
					limitRecovery:
						session?.limit_recovery == null
							? null
							: Schema.decodeUnknownSync(Schema.parseJson(LimitRecoverySchema))(
									session.limit_recovery,
								),
					userText: userText ?? "",
					options: budgetOptions,
				};
				let plan = planTurn(input);
				if ("_tag" in plan && plan._tag === "ReadHistory") {
					const messages: MessageWithParts[] = [];
					let before: string | undefined;
					for (;;) {
						const page = yield* read.readSessionTranscriptPage(sessionId, {
							limit: 50,
							...(before ? { before } : {}),
						});
						messages.unshift(...page.messages);
						if (!page.hasMore) break;
						before = page.messages[0]?.id;
					}
					// The current user event is already committed by the send path. Its
					// text belongs only at the end of the SDK prompt, outside the handoff.
					const cutOffMessageId = options.continuation
						? input.limitRecovery?.cutOffMessageId
						: undefined;
					const cutOffMessage = cutOffMessageId
						? messages.find(
								(message) =>
									message.id === cutOffMessageId && message.role === "user",
							)
						: undefined;
					if (options.continuation && !cutOffMessage)
						return yield* new ContinuationNotReady({
							reason: "The cut-off request is no longer available.",
						});
					let history = messages;
					if (plan.deliveredThrough !== undefined) {
						const created = yield* sql<{
							messageId: string;
						}>`SELECT CASE WHEN type = 'turn.error'
							THEN 'turn-error-' || sequence
							ELSE json_extract(data, '$.messageId') END AS messageId
							FROM events
							WHERE session_id = ${sessionId} AND sequence > ${plan.deliveredThrough}
								AND type IN ('message.created', 'turn.error')`;
						const messageIds = new Set(created.map((row) => row.messageId));
						history = messages.filter((message) => messageIds.has(message.id));
					}
					plan = planTurn({
						...input,
						messages: history,
						...(cutOffMessage
							? {
									userText: historicalMessageText(cutOffMessage),
									options: {
										...budgetOptions,
										userMessageId: cutOffMessage.id,
									},
								}
							: {}),
					});
				}
				if (
					plan instanceof HandoffTooLarge ||
					plan instanceof ContinuationNotReady
				)
					return yield* plan;
				if ("_tag" in plan)
					return yield* Effect.die("prepareTurn did not resolve history");
				return plan;
			});
	});

/** One gate for normal delivery and restart recovery; the fresh send is terminal. */
export const sendPreparedClaudeTurn = <
	A extends TurnResult | undefined,
	E,
	R,
>(input: {
	readonly sessionId: string;
	readonly instanceId: string;
	readonly userText?: string | undefined;
	readonly commandId?: string | undefined;
	readonly options: PrepareTurnOptions;
	readonly send: (
		prepared: PreparedTurn,
		nativeResumeFallback: boolean,
	) => Effect.Effect<A, E, R>;
}) =>
	Effect.gen(function* () {
		const prepare = yield* makePrepareTurn(input.options);
		const prepared = yield* prepare(
			input.sessionId,
			input.instanceId,
			input.userText,
		);
		const result = yield* Effect.either(
			input.send(prepared, input.options.nativeResumeFallback === true),
		);
		const failure = result._tag === "Left" ? result.left : result.right?.error;
		if (
			!prepared.resumeSessionId ||
			!prepared.handoff ||
			(result._tag === "Right" && !result.right?.nativeResumeRejected) ||
			!isClaudeResumeFailure(failure)
		)
			return result._tag === "Left"
				? yield* Effect.fail(result.left)
				: result.right;
		const sql = yield* SqlClient.SqlClient;
		// Keep other accounts' receipts intact. The marker also gives this one
		// fallback its own runner deduplication key, including after a restart.
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`DELETE FROM provider_state WHERE session_id = ${input.sessionId}
				AND key IN (${nativeThreadKey(input.instanceId)}, 'resumeSessionId', 'claudeConfigDir')`;
				if (input.commandId)
					yield* sql`UPDATE provider_command_outbox
					SET payload_json = json_set(payload_json, '$.nativeResumeFallback', json('true'))
					WHERE command_id = ${input.commandId} AND session_id = ${input.sessionId}
						AND status = 'running'`;
			}),
		);
		const prepareFresh = yield* makePrepareTurn({
			...input.options,
			configDir: prepared.configDir,
			nativeResumeFallback: true,
		});
		const fresh = yield* prepareFresh(
			input.sessionId,
			input.instanceId,
			input.userText,
		);
		return yield* input.send(fresh, true);
	});
