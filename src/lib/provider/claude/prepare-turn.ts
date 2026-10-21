import { Data, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
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
import { readForkSource } from "../../persistence/fork-history.js";
import type { MessageWithParts } from "../../persistence/read-model-types.js";
import { assertNever } from "../../utils.js";
import {
	isClaudeResumeFailure,
	isClaudeResumeRefused,
} from "../event-sink-errors.js";
import { historicalMessageText } from "../historical-message-text.js";
import type {
	ProviderNativeSession,
	SendTurnInput,
	TurnResult,
} from "../types.js";
import {
	type ClaudeConfigDir,
	ClaudeConfigDirSchema,
	type ClaudeLaunchConfig,
	sameClaudeLogin,
} from "./claude-sdk-env.js";
import { loadClaudeSdkTestModule } from "./claude-sdk-module.js";
import {
	CLAUDE_FORK_SOURCE_KEY,
	type ClaudeSessionForkSdk,
	defaultClaudeSessionForkSdk,
	resolveForkUpToUuid,
	resolveRewindUpToUuid,
} from "./claude-session-fork.js";
import { THREAD_READ_QUALIFIED_NAME } from "./types.js";

export { HandoffTooLarge } from "../../contracts/limit-recovery.js";

export class ContinuationNotReady extends Data.TaggedError(
	"ContinuationNotReady",
)<{
	readonly message: string;
}> {}

interface PrepareTurnOptions extends ClaudeLaunchConfig {
	readonly liveSession?: ProviderNativeSession | undefined;
	readonly tokenCap?: number | undefined;
	readonly modelContextWindow?: number | undefined;
	readonly agent?: string | undefined;
	readonly userMessageId?: string | undefined;
	/** The cut-off this turn continues, from the continuation command itself. */
	readonly continuation?: { readonly cutOffMessageId: string } | undefined;
	readonly nativeResumeFallback?: boolean | undefined;
	readonly rewind?: SendTurnInput["rewind"];
	readonly sessionForkSdk?: ClaudeSessionForkSdk | undefined;
	readonly workspaceRoot?: string | undefined;
}

export interface PreparedTurn {
	readonly resumeSessionId?: string;
	readonly resumeSessionAt?: string;
	readonly forkSession?: boolean;
	readonly clearInheritedGoal?: boolean;
	readonly configDir: ClaudeConfigDir;
	readonly prompt: string;
	readonly handoff?: HandoffSummary;
	readonly nativeThread?: NativeThread;
}

/** All decisions stay here; undefined messages asks the caller to page history. */
function planTurn(input: {
	readonly projectId: string;
	readonly sessionId: string;
	readonly instanceId: string;
	readonly nativeThread: NativeThread | undefined;
	readonly hasAccountSwitch: boolean;
	readonly hasWorkspaceMove: boolean;
	readonly deliveredAgent: string | undefined;
	readonly limitRecovery: LimitRecovery | null;
	readonly cutOffDismissed: boolean;
	readonly messages?: readonly MessageWithParts[];
	readonly userText: string;
	readonly options: PrepareTurnOptions;
}):
	| PreparedTurn
	| HandoffTooLarge
	| ContinuationNotReady
	| { readonly _tag: "ReadHistory"; readonly deliveredThrough?: number } {
	const { nativeThread, options, userText } = input;
	// Only Dismiss closes a continuation. The continuation's own reply clears
	// limit_recovery, and a restart or retry must still be able to re-plan it.
	if (options.continuation && input.cutOffDismissed)
		return new ContinuationNotReady({
			message: "The cut-off request was dismissed.",
		});
	// A cut-off remains an open request until Dismiss or a real assistant reply.
	const note =
		input.limitRecovery?.cutOffMessageId && userText
			? "[Conduit still-open note] The earlier request was cut off by a usage limit and is still open; some of its work may already be done.\n\n"
			: "";
	const live = options.nativeResumeFallback ? undefined : options.liveSession;
	let sameLiveAccount: boolean;
	let configDir: ClaudeConfigDir;
	switch (options.folderSource) {
		case "implicitDefault":
			sameLiveAccount = live?.instanceId === input.instanceId;
			configDir =
				(live?.instanceId === input.instanceId ? live.configDir : undefined) ??
				nativeThread?.configDir ??
				options.configDir;
			break;
		case "account":
		case "legacyDefault":
			sameLiveAccount =
				live?.instanceId === input.instanceId &&
				(live.configDir === undefined ||
					(live.configDir._tag === options.configDir._tag &&
						live.configDir.path === options.configDir.path));
			configDir = options.configDir;
			break;
		default:
			return assertNever(options.folderSource);
	}
	const sameLiveAgent =
		sameLiveAccount && (live?.agent ?? "") === (options.agent ?? "");
	const base = {
		configDir,
		prompt: `${note}${userText}`,
	};
	if (options.rewind?.resumeSessionAt === null)
		return { ...base, prompt: userText };
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
			message: "The cut-off request has no native session to resume.",
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
									projectId: input.projectId,
									configDir: base.configDir,
									resumeSessionId,
									firstSequence: 0,
									deliveredThrough: 0,
								},
					resumeSessionId,
				}
			: undefined;
	// A receipt from another or unknown login folder may be unresumable. So may
	// one from before a workspace move: Claude finds transcripts only from their
	// own cwd or a live sibling worktree, and the old worktree may be gone.
	// Catch up so a rejected native resume can fall back to a fresh handoff.
	const root = options.workspaceRoot ?? process.cwd();
	const catchingUp =
		!!resuming &&
		!!nativeThread &&
		(input.hasAccountSwitch ||
			input.hasWorkspaceMove ||
			nativeThread.configDir === undefined ||
			!sameClaudeLogin(
				{ configDir: nativeThread.configDir, root },
				{ configDir: base.configDir, root },
			));
	if (resuming && !catchingUp) return resuming;
	if (input.messages === undefined)
		return {
			_tag: "ReadHistory",
			...(catchingUp
				? { deliveredThrough: nativeThread.deliveredThrough }
				: {}),
		};
	const prepared = resuming ?? base;
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
export const makePrepareTurn = (options: PrepareTurnOptions) =>
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
				const session = yield* read.getSession(sessionId);
				const forkState = session?.forked_from
					? yield* state.getState(sessionId)
					: undefined;
				const recordedThread = options.nativeResumeFallback
					? undefined
					: yield* state.nativeThread(sessionId, instanceId);
				const liveSession =
					options.liveSession?.instanceId === instanceId
						? options.liveSession
						: undefined;
				let resumeConfigDir: ClaudeConfigDir;
				switch (options.folderSource) {
					case "implicitDefault":
						resumeConfigDir =
							recordedThread?.configDir ??
							liveSession?.configDir ??
							options.configDir;
						break;
					case "account":
					case "legacyDefault":
						resumeConfigDir = options.configDir;
						break;
					default:
						return assertNever(options.folderSource);
				}
				// Only untouched copied history can bypass canonical catch-up and
				// rewind planning. A missing receipt does not prove a first launch.
				const [forkHistory] =
					session?.forked_from && !recordedThread
						? yield* sql<{ unchanged: number }>`SELECT
							NOT EXISTS (SELECT 1 FROM messages
								WHERE session_id = ${sessionId} AND is_inherited = 0)
							AND NOT EXISTS (SELECT 1 FROM events
								WHERE session_id = ${sessionId} AND type = 'session.rewind_committed')
							AS unchanged`
						: [];
				if (
					session?.forked_from &&
					forkHistory?.unchanged === 1 &&
					!recordedThread &&
					!options.nativeResumeFallback &&
					forkState?.[`claude.forkRefused:${instanceId}`] !== "true" &&
					options.rewind === undefined &&
					session.provider === instanceId
				) {
					const testModule = yield* loadClaudeSdkTestModule.pipe(
						Effect.catch(() => Effect.succeed(undefined)),
					);
					const sdk =
						testModule?.claudeSdk.fork ??
						options.sessionForkSdk ??
						defaultClaudeSessionForkSdk;
					const sdkOptions = { configDir: resumeConfigDir };
					const ownTranscript = yield* Effect.tryPromise(() =>
						sdk.transcriptExists
							? sdk.transcriptExists(sessionId, sdkOptions)
							: sdk.readTranscript(sessionId, sdkOptions).then(() => true),
					).pipe(Effect.catch(() => Effect.succeed(false)));
					const nativeBase: PreparedTurn = {
						configDir: resumeConfigDir,
						prompt: options.continuation
							? "Continue where you left off."
							: (userText ?? ""),
						clearInheritedGoal: true,
					};
					// Init can persist the fork before a delivery receipt exists. Never
					// repeat 7A once this id owns a transcript, including an empty one.
					if (ownTranscript)
						return { ...nativeBase, resumeSessionId: sessionId };
					let owner = session;
					let cut = session.fork_point_message_id ?? session.fork_point_event;
					const visited = new Set<string>([sessionId]);
					while (owner.forked_from && cut && !visited.has(owner.forked_from)) {
						const sourceId = owner.forked_from;
						visited.add(sourceId);
						const source = yield* read.getSession(sourceId);
						if (!source) break;
						if (source.pending_rewind_message_id != null) break;
						const ownerState = yield* state.getState(owner.id);
						const frozen = ownerState[CLAUDE_FORK_SOURCE_KEY];
						const frozenSource =
							frozen === undefined
								? undefined
								: yield* Schema.decodeUnknownEffect(
										Schema.fromJsonString(
											Schema.Struct({
												instanceId: Schema.String,
												resumeSessionId: Schema.String,
												configDir: ClaudeConfigDirSchema,
												messageId: Schema.String,
											}),
										),
									)(frozen).pipe(Effect.catch(() => Effect.succeed(undefined)));
						const thread = yield* state.nativeThread(sourceId, instanceId);
						// A frozen source proves only the cut it was saved for.
						if (frozenSource?.messageId !== cut && (frozenSource || thread)) {
							if (
								!thread ||
								(frozenSource &&
									frozenSource.resumeSessionId !== thread.resumeSessionId)
							)
								break;
							const sourceCut = yield* readForkSource(sourceId, {
								messageId: cut,
								sideThread: false,
							}).pipe(
								Effect.catchTag("ForkRefusal", () => Effect.succeed(undefined)),
							);
							if (
								!sourceCut ||
								thread.firstSequence > sourceCut.boundary.sequence ||
								thread.deliveredThrough < sourceCut.boundary.sequence ||
								thread.deliveredThrough < sourceCut.lastRewindCommitSequence
							)
								break;
						}
						const sourceConfig =
							frozenSource?.configDir ?? thread?.configDir ?? resumeConfigDir;
						if (
							(frozenSource && frozenSource.instanceId !== instanceId) ||
							!sameClaudeLogin(
								{
									configDir: sourceConfig,
									root: options.workspaceRoot ?? process.cwd(),
								},
								{
									configDir: resumeConfigDir,
									root: options.workspaceRoot ?? process.cwd(),
								},
							)
						)
							break;
						const nativeId =
							frozenSource?.resumeSessionId ??
							thread?.resumeSessionId ??
							(source.provider === instanceId ? sourceId : undefined);
						const transcript =
							nativeId === undefined
								? undefined
								: yield* Effect.tryPromise(() =>
										sdk.readTranscript(nativeId, sdkOptions),
									).pipe(Effect.catch(() => Effect.succeed(undefined)));
						if (transcript?.length) {
							let mappedCut = cut;
							let ancestor = source;
							const mapped = new Set<string>();
							let uuid = resolveForkUpToUuid(transcript, mappedCut);
							while (
								!uuid &&
								ancestor.forked_from &&
								!mapped.has(ancestor.id)
							) {
								mapped.add(ancestor.id);
								const suffix = `_${ancestor.id}`;
								if (!mappedCut.endsWith(suffix)) break;
								mappedCut = mappedCut.slice(0, -suffix.length);
								uuid = resolveForkUpToUuid(transcript, mappedCut);
								const parent = yield* read.getSession(ancestor.forked_from);
								if (!parent) break;
								ancestor = parent;
							}
							if (uuid && nativeId !== undefined)
								return {
									...nativeBase,
									resumeSessionId: nativeId,
									forkSession: true,
									resumeSessionAt: uuid,
								};
							break;
						}
						// A never-launched fork has only inherited ids. Remove exactly
						// this generation's copy suffix before looking at its parent.
						const suffix = `_${sourceId}`;
						if (!cut.endsWith(suffix)) break;
						cut = cut.slice(0, -suffix.length);
						owner = source;
					}
					// Missing transcripts and cuts use the same canonical history
					// planner as account switches and continuation recovery below.
				}
				const newerRewinds =
					options.rewind !== undefined || options.nativeResumeFallback
						? []
						: yield* sql<{ sequence: number }>`SELECT sequence FROM events
							WHERE session_id = ${sessionId} AND type = 'session.rewind_committed'
								AND sequence > ${recordedThread?.deliveredThrough ?? 0}
							LIMIT 1`;
				let needsCanonicalHandoff = false;
				const rewindPoint = options.rewind?.resumeSessionAt;
				if (rewindPoint !== undefined && rewindPoint !== null) {
					const nativeId =
						recordedThread?.resumeSessionId ?? liveSession?.resumeSessionId;
					const workspaceRoot = options.workspaceRoot;
					if (nativeId === undefined || workspaceRoot === undefined) {
						needsCanonicalHandoff = true;
					} else {
						const testModule = yield* loadClaudeSdkTestModule.pipe(
							Effect.catch(() => Effect.succeed(undefined)),
						);
						const sdk =
							testModule?.claudeSdk.fork ??
							options.sessionForkSdk ??
							defaultClaudeSessionForkSdk;
						const transcript = yield* Effect.tryPromise(() =>
							sdk.readTranscript(nativeId, {
								dir: workspaceRoot,
								configDir: resumeConfigDir,
							}),
						).pipe(Effect.catch(() => Effect.succeed([])));
						needsCanonicalHandoff =
							resolveRewindUpToUuid(
								transcript,
								rewindPoint,
								options.rewind?.targetMessageId,
							) === undefined;
					}
				}
				// A failed cut delivery, or another account's older receipt, cannot
				// resume the discarded chain. Rebuild from Conduit's kept transcript.
				// Forks also remap user ids: when the native cut cannot be identified,
				// SQLite's kept messages are the authoritative fresh-session handoff.
				const invalidated = newerRewinds.length > 0 || needsCanonicalHandoff;
				const nativeThread = invalidated ? undefined : recordedThread;
				const turnOptions = invalidated
					? {
							...budgetOptions,
							configDir: resumeConfigDir,
							liveSession: undefined,
						}
					: budgetOptions;
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
				const workspaceMoves = nativeThread
					? yield* sql<{ moved: number }>`
						SELECT 1 AS moved FROM events
						WHERE session_id = ${sessionId} AND type = 'session.workspace_changed'
							AND sequence > ${nativeThread.deliveredThrough}
						LIMIT 1`
					: [];
				const cutOff = options.continuation?.cutOffMessageId ?? null;
				// A message can be cut off again after an earlier Dismiss; only a
				// dismissal after its latest cut-off closes it.
				const dismissals =
					cutOff === null
						? []
						: yield* sql<{ dismissed: number }>`
						SELECT 1 AS dismissed FROM events
						WHERE session_id = ${sessionId} AND type = 'session.cut_off_dismissed'
							AND json_extract(data, '$.cutOffMessageId') = ${cutOff}
							AND sequence > COALESCE((SELECT MAX(sequence) FROM events
								WHERE session_id = ${sessionId} AND type = 'session.usage_limited'
									AND json_extract(data, '$.cutOffMessageId') = ${cutOff}), 0)
						LIMIT 1`;
				const input = {
					projectId: state.projectId,
					sessionId,
					instanceId,
					nativeThread,
					hasAccountSwitch: accountSwitches.length > 0,
					hasWorkspaceMove: workspaceMoves.length > 0,
					deliveredAgent: providerState[`claudeAgent:${instanceId}`],
					limitRecovery:
						session?.limit_recovery == null
							? null
							: Schema.decodeUnknownSync(
									Schema.fromJsonString(LimitRecoverySchema),
								)(session.limit_recovery),
					cutOffDismissed: dismissals.length > 0,
					userText: userText ?? "",
					options: turnOptions,
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
					const cutOffMessageId = options.continuation?.cutOffMessageId;
					const cutOffMessage = cutOffMessageId
						? messages.find(
								(message) =>
									message.id === cutOffMessageId && message.role === "user",
							)
						: undefined;
					if (options.continuation && !cutOffMessage)
						return yield* new ContinuationNotReady({
							message: "The cut-off request is no longer available.",
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
										...turnOptions,
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
		const send = (prepared: PreparedTurn, fallback: boolean) =>
			Effect.gen(function* () {
				// Intake returns before completion; retain the receipt facts for the owned run's end.
				if (input.commandId && prepared.handoff) {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`UPDATE provider_command_outbox
					SET payload_json = json_set(payload_json, '$.handoff', json(${JSON.stringify({ ...prepared.handoff, instanceId: input.instanceId })}))
					WHERE command_id = ${input.commandId} AND session_id = ${input.sessionId} AND status = 'running'`;
				}
				return yield* input.send(prepared, fallback);
			});
		const result = yield* Effect.result(
			send(prepared, input.options.nativeResumeFallback === true),
		);
		const failure =
			result._tag === "Failure" ? result.failure : result.success?.error;
		const refused = isClaudeResumeRefused(failure);
		if (
			(input.options.rewind !== undefined && !refused) ||
			!prepared.resumeSessionId ||
			(!prepared.handoff &&
				!prepared.clearInheritedGoal &&
				!prepared.forkSession &&
				!refused) ||
			(result._tag === "Success" &&
				!result.success?.nativeResumeRejected &&
				!refused) ||
			!isClaudeResumeFailure(failure)
		)
			return result._tag === "Failure"
				? yield* Effect.fail(result.failure)
				: result.success;
		const sql = yield* SqlClient.SqlClient;
		// Keep other accounts' receipts intact. The marker also gives this one
		// fallback its own runner deduplication key, including after a restart.
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`DELETE FROM provider_state WHERE session_id = ${input.sessionId}
				AND key IN (${nativeThreadKey(input.instanceId)}, 'resumeSessionId', 'claudeConfigDir')`;
				if (prepared.clearInheritedGoal || prepared.forkSession) {
					const state = yield* ProviderStateEffectTag;
					yield* state.saveUpdates(input.sessionId, [
						{ key: `claude.forkRefused:${input.instanceId}`, value: "true" },
					]);
				}
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
		return yield* send(fresh, true);
	});
