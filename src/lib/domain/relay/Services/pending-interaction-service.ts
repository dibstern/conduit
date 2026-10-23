import {
	Clock,
	Context,
	Data,
	Deferred,
	Effect,
	Layer,
	Option,
	Ref,
} from "effect";
import { SqlClient } from "effect/sql";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../persistence/events.js";
import { enqueueCommittedControlAnswers } from "../../../provider/legacy-control-outbox.js";
import type { PermissionId } from "../../../shared-types.js";
import type {
	FrontendDecision,
	OpenCodeDecision,
	PendingPermission,
	ProviderPermissionUpdate,
	ProviderPermissionUpdateDestination,
} from "../../../types.js";

const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;

const DECISION_MAP: Record<FrontendDecision, OpenCodeDecision> = {
	allow: "once",
	deny: "reject",
	allow_always: "always",
};

export class PendingInteractionCancelled extends Data.TaggedError(
	"PendingInteractionCancelled",
)<{
	readonly requestId: string;
	readonly sessionId: string;
	readonly reason: string;
	/** The question outlives its waiter as a recovered question, still pending. */
	readonly recovered?: true;
}> {}

export interface PendingPermissionRequestInput {
	readonly requestId: PermissionId;
	readonly sessionId: string;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
	readonly always?: readonly string[];
	readonly permissionSuggestions?: readonly ProviderPermissionUpdate[];
	readonly permissionTitle?: string;
	readonly permissionDisplayName?: string;
	readonly permissionDescription?: string;
	readonly permissionReason?: string;
}

export interface PendingQuestionInput {
	readonly requestId: string;
	readonly delivery?: "async";
	readonly providerProcessId?: string;
	readonly providerRequestId?: string;
	readonly sessionId: string;
	readonly questions: readonly PendingQuestionItemInput[];
	readonly toolCallId?: string;
	readonly providerId?: string;
	readonly messageId?: string;
	readonly partId?: string;
	readonly recovered?: true;
	readonly timestamp?: number;
}

export interface PendingQuestionItemInput {
	readonly question: string;
	readonly header?: string;
	readonly options?: readonly unknown[];
	readonly multiSelect?: boolean;
	readonly custom?: boolean | undefined;
	readonly isOther?: boolean | undefined;
	readonly isSecret?: boolean | undefined;
}

export interface PendingQuestion {
	readonly requestId: string;
	readonly delivery?: "async";
	readonly providerProcessId?: string;
	readonly providerRequestId?: string;
	readonly sessionId: string;
	readonly questions: readonly PendingQuestionItem[];
	readonly toolCallId?: string;
	readonly providerId?: string;
	readonly messageId?: string;
	readonly partId?: string;
	readonly recovered?: true;
	readonly timestamp: number;
}

export interface PendingQuestionItem {
	readonly question: string;
	readonly header?: string;
	readonly options?: readonly unknown[];
	readonly multiSelect?: boolean;
	readonly custom?: boolean;
	readonly isOther?: boolean;
	readonly isSecret?: boolean;
}

export interface ResolvedPermissionDecision {
	readonly mapped: OpenCodeDecision;
	readonly sessionId: string;
	readonly toolName: string;
}

export interface ResolvedQuestionResponse {
	readonly sessionId: string;
	readonly question: PendingQuestion;
}

export interface PendingPermissionResponse {
	readonly decision: OpenCodeDecision;
	readonly permissionUpdates?: readonly ProviderPermissionUpdate[];
}

export interface StartedPermissionRequest {
	readonly entry: PendingPermission;
	readonly awaitResponse: Effect.Effect<
		PendingPermissionResponse,
		PendingInteractionCancelled
	>;
}

export interface StartedQuestionRequest {
	readonly entry: PendingQuestion;
	readonly awaitAnswers: Effect.Effect<
		Record<string, unknown>,
		PendingInteractionCancelled
	>;
}

export interface PendingInteractionService {
	beginPermissionRequest(
		input: PendingPermissionRequestInput,
	): Effect.Effect<StartedPermissionRequest>;
	recordPermissionRequest(
		input: PendingPermissionRequestInput,
	): Effect.Effect<PendingPermission>;
	listPendingPermissions(
		sessionId?: string,
	): Effect.Effect<PendingPermission[]>;
	resolvePermissionFromBrowser(
		requestId: string,
		decision: string,
		options?: {
			readonly permissionDestination?: ProviderPermissionUpdateDestination;
		},
	): Effect.Effect<Option.Option<ResolvedPermissionDecision>>;
	markPermissionReplied(requestId: string): Effect.Effect<boolean>;
	/**
	 * Drop permissions pending past the timeout. `awaited` says a provider turn
	 * was waiting on it: that turn now fails and records the resolution itself.
	 */
	takeTimedOutPermissions(): Effect.Effect<
		Array<{ id: string; sessionId: string; awaited: boolean }>
	>;
	recordQuestionRequest(
		input: PendingQuestionInput,
	): Effect.Effect<PendingQuestion>;
	beginQuestionRequest(
		input: PendingQuestionInput,
	): Effect.Effect<StartedQuestionRequest>;
	recoverPendingQuestions(
		questions: readonly PendingQuestionInput[],
	): Effect.Effect<PendingQuestion[]>;
	listPendingQuestions(sessionId?: string): Effect.Effect<PendingQuestion[]>;
	resolvePermissionRequest(
		requestId: string,
		response: PendingPermissionResponse,
	): Effect.Effect<boolean>;
	resolveQuestionFromBrowser(
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<Option.Option<ResolvedQuestionResponse>>;
	resolveQuestionRequest(
		requestId: string,
		answers: Record<string, unknown>,
	): Effect.Effect<boolean>;
	markQuestionResolved(requestId: string): Effect.Effect<boolean>;
	cancelSessionInteractions(
		sessionId: string,
		reason: string,
		options?: {
			readonly recoverQuestions?: boolean;
			readonly requestIds?: ReadonlySet<string>;
		},
	): Effect.Effect<void>;
}

export class PendingInteractionServiceTag extends Context.Service<
	PendingInteractionServiceTag,
	PendingInteractionService
>()("PendingInteractionService") {}

export interface PendingInteractionServiceOptions {
	readonly permissionTimeoutMs?: number;
}

export const makePendingInteractionServiceLive = (
	options: PendingInteractionServiceOptions = {},
): Layer.Layer<PendingInteractionServiceTag> =>
	Layer.effect(
		PendingInteractionServiceTag,
		Effect.gen(function* () {
			type PermissionState = PendingPermission & {
				readonly waiter?: Deferred.Deferred<
					PendingPermissionResponse,
					PendingInteractionCancelled
				>;
			};
			type ResolvedPermissionState = PermissionState & {
				readonly mapped: OpenCodeDecision;
			};
			type QuestionState = PendingQuestion & {
				readonly waiter?: Deferred.Deferred<
					Record<string, unknown>,
					PendingInteractionCancelled
				>;
			};
			const permissions = yield* Ref.make(new Map<string, PermissionState>());
			const questions = yield* Ref.make(new Map<string, QuestionState>());
			const timeoutMs =
				options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;

			const toPendingPermission = (
				state: PermissionState,
			): PendingPermission => ({
				requestId: state.requestId,
				sessionId: state.sessionId,
				toolName: state.toolName,
				toolInput: state.toolInput,
				always: state.always,
				...(state.permissionSuggestions != null
					? { permissionSuggestions: [...state.permissionSuggestions] }
					: {}),
				...(state.permissionTitle != null
					? { permissionTitle: state.permissionTitle }
					: {}),
				...(state.permissionDisplayName != null
					? { permissionDisplayName: state.permissionDisplayName }
					: {}),
				...(state.permissionDescription != null
					? { permissionDescription: state.permissionDescription }
					: {}),
				...(state.permissionReason != null
					? { permissionReason: state.permissionReason }
					: {}),
				timestamp: state.timestamp,
			});

			const toPendingQuestion = (state: QuestionState): PendingQuestion => ({
				requestId: state.requestId,
				...(state.delivery ? { delivery: state.delivery } : {}),
				...(state.providerProcessId
					? { providerProcessId: state.providerProcessId }
					: {}),
				...(state.providerRequestId
					? { providerRequestId: state.providerRequestId }
					: {}),
				sessionId: state.sessionId,
				questions: state.questions,
				...(state.toolCallId != null ? { toolCallId: state.toolCallId } : {}),
				...(state.providerId != null ? { providerId: state.providerId } : {}),
				...(state.messageId != null ? { messageId: state.messageId } : {}),
				...(state.partId != null ? { partId: state.partId } : {}),
				...(state.recovered ? { recovered: true as const } : {}),
				timestamp: state.timestamp,
			});

			const storePermissionRequest = (
				input: PendingPermissionRequestInput,
				waiter?: Deferred.Deferred<
					PendingPermissionResponse,
					PendingInteractionCancelled
				>,
			) =>
				Effect.gen(function* () {
					const timestamp = yield* Clock.currentTimeMillis;
					const entry: PermissionState = {
						requestId: input.requestId,
						sessionId: input.sessionId,
						toolName: input.toolName,
						toolInput: input.toolInput,
						always: [...(input.always ?? [])],
						...(input.permissionSuggestions != null
							? { permissionSuggestions: [...input.permissionSuggestions] }
							: {}),
						...(input.permissionTitle != null
							? { permissionTitle: input.permissionTitle }
							: {}),
						...(input.permissionDisplayName != null
							? { permissionDisplayName: input.permissionDisplayName }
							: {}),
						...(input.permissionDescription != null
							? { permissionDescription: input.permissionDescription }
							: {}),
						...(input.permissionReason != null
							? { permissionReason: input.permissionReason }
							: {}),
						timestamp,
						...(waiter != null ? { waiter } : {}),
					};
					yield* Ref.update(permissions, (current) => {
						const next = new Map(current);
						next.set(entry.requestId, entry);
						return next;
					});
					return toPendingPermission(entry);
				});

			const recordPermissionRequest = (input: PendingPermissionRequestInput) =>
				storePermissionRequest(input);

			const beginPermissionRequest = (input: PendingPermissionRequestInput) =>
				Effect.gen(function* () {
					const waiter = yield* Deferred.make<
						PendingPermissionResponse,
						PendingInteractionCancelled
					>();
					const entry = yield* storePermissionRequest(input, waiter);
					return { entry, awaitResponse: Deferred.await(waiter) };
				});

			const storeQuestionRequest = (
				input: PendingQuestionInput,
				waiter?: Deferred.Deferred<
					Record<string, unknown>,
					PendingInteractionCancelled
				>,
			) =>
				Effect.gen(function* () {
					const timestamp = input.timestamp ?? (yield* Clock.currentTimeMillis);
					const entry: QuestionState = {
						requestId: input.requestId,
						...(input.delivery ? { delivery: input.delivery } : {}),
						...(input.providerProcessId
							? { providerProcessId: input.providerProcessId }
							: {}),
						...(input.providerRequestId
							? { providerRequestId: input.providerRequestId }
							: {}),
						sessionId: input.sessionId,
						questions: input.questions.map((question) => ({
							question: question.question,
							...(question.header != null ? { header: question.header } : {}),
							...(question.options != null
								? { options: [...question.options] }
								: {}),
							...(question.multiSelect != null
								? { multiSelect: question.multiSelect }
								: {}),
							...(question.custom != null ? { custom: question.custom } : {}),
							...(question.isOther != null
								? { isOther: question.isOther }
								: {}),
							...(question.isSecret != null
								? { isSecret: question.isSecret }
								: {}),
						})),
						...(input.toolCallId != null
							? { toolCallId: input.toolCallId }
							: {}),
						...(input.providerId != null
							? { providerId: input.providerId }
							: {}),
						...(input.messageId != null ? { messageId: input.messageId } : {}),
						...(input.partId != null ? { partId: input.partId } : {}),
						...(input.recovered ? { recovered: true as const } : {}),
						timestamp,
						...(waiter != null ? { waiter } : {}),
					};
					yield* Ref.update(questions, (current) => {
						const next = new Map(current);
						next.set(entry.requestId, entry);
						return next;
					});
					return toPendingQuestion(entry);
				});

			const recordQuestionRequest = (input: PendingQuestionInput) =>
				storeQuestionRequest(input);

			const beginQuestionRequest = (input: PendingQuestionInput) =>
				Effect.gen(function* () {
					const waiter = yield* Deferred.make<
						Record<string, unknown>,
						PendingInteractionCancelled
					>();
					const entry = yield* storeQuestionRequest(input, waiter);
					return { entry, awaitAnswers: Deferred.await(waiter) };
				});

			const resolvePermissionRequest = (
				requestId: string,
				response: PendingPermissionResponse,
			) =>
				Effect.gen(function* () {
					const state = yield* Ref.modify(permissions, (current) => {
						const entry = current.get(requestId);
						if (!entry) return [undefined, current] as const;
						const next = new Map(current);
						next.delete(requestId);
						return [entry, next] as const;
					});
					if (!state) return false;
					if (state.waiter) {
						yield* Deferred.succeed(state.waiter, response).pipe(Effect.ignore);
					}
					return true;
				});

			const takeQuestionRequest = (
				requestId: string,
				answers: Record<string, unknown>,
			) =>
				Effect.gen(function* () {
					const state = yield* Ref.modify(questions, (current) => {
						const entry = current.get(requestId);
						if (!entry) {
							return [undefined, current] as const;
						}
						const next = new Map(current);
						next.delete(requestId);
						return [entry, next] as const;
					});
					if (!state) return Option.none<ResolvedQuestionResponse>();
					if (state.waiter) {
						yield* Deferred.succeed(state.waiter, answers).pipe(Effect.ignore);
					}
					return Option.some({
						sessionId: state.sessionId,
						question: toPendingQuestion(state),
					});
				});

			const resolveQuestionRequest = (
				requestId: string,
				answers: Record<string, unknown>,
			) =>
				takeQuestionRequest(requestId, answers).pipe(Effect.map(Option.isSome));

			const cancelSessionInteractions = (
				sessionId: string,
				reason: string,
				options?: {
					readonly recoverQuestions?: boolean;
					readonly requestIds?: ReadonlySet<string>;
				},
			) =>
				Effect.gen(function* () {
					const cancelledPermissions = yield* Ref.modify(
						permissions,
						(current) => {
							const next = new Map(current);
							const cancelled: PermissionState[] = [];
							for (const [id, entry] of current) {
								if (
									entry.sessionId === sessionId &&
									(!options?.requestIds || options.requestIds.has(id))
								) {
									cancelled.push(entry);
									next.delete(id);
								}
							}
							return [cancelled, next] as const;
						},
					);
					const cancelledQuestions = yield* Ref.modify(questions, (current) => {
						const next = new Map(current);
						const cancelled: QuestionState[] = [];
						for (const [id, entry] of current) {
							if (
								entry.sessionId === sessionId &&
								entry.delivery !== "async" &&
								(!options?.requestIds || options.requestIds.has(id))
							) {
								cancelled.push(entry);
								if (options?.recoverQuestions) {
									const { waiter: _waiter, ...recoverable } = entry;
									next.set(id, {
										...recoverable,
										recovered: true,
									});
								} else {
									next.delete(id);
								}
							}
						}
						return [cancelled, next] as const;
					});
					yield* Effect.forEach(
						cancelledPermissions,
						(entry) =>
							entry.waiter
								? Deferred.fail(
										entry.waiter,
										new PendingInteractionCancelled({
											requestId: entry.requestId,
											sessionId: entry.sessionId,
											reason,
										}),
									).pipe(Effect.ignore)
								: Effect.void,
						{ discard: true },
					);
					yield* Effect.forEach(
						cancelledQuestions,
						(entry) =>
							entry.waiter
								? Deferred.fail(
										entry.waiter,
										new PendingInteractionCancelled({
											requestId: entry.requestId,
											sessionId: entry.sessionId,
											reason,
											...(options?.recoverQuestions
												? { recovered: true as const }
												: {}),
										}),
									).pipe(Effect.ignore)
								: Effect.void,
						{ discard: true },
					);
				});

			return {
				beginPermissionRequest,
				recordPermissionRequest,
				listPendingPermissions: (sessionId?: string) =>
					Ref.get(permissions).pipe(
						Effect.map((current) =>
							Array.from(current.values())
								.filter(
									(entry) =>
										sessionId == null ||
										entry.sessionId === "" ||
										entry.sessionId === sessionId,
								)
								.map(toPendingPermission),
						),
					),
				resolvePermissionFromBrowser: (
					requestId: string,
					decision: string,
					options?: {
						readonly permissionDestination?: ProviderPermissionUpdateDestination;
					},
				) =>
					Effect.gen(function* () {
						const result = yield* Ref.modify(permissions, (current) => {
							const entry = current.get(requestId);
							const mapped = DECISION_MAP[decision as FrontendDecision];
							if (!entry || !mapped) {
								return [
									Option.none<ResolvedPermissionState>(),
									current,
								] as const;
							}
							const next = new Map(current);
							next.delete(requestId);
							return [Option.some({ ...entry, mapped }), next] as const;
						});
						const resolved = Option.getOrUndefined(result);
						if (!resolved) return Option.none();
						const selectedPermissionUpdates =
							resolved.mapped === "always" &&
							options?.permissionDestination != null
								? (resolved.permissionSuggestions ?? []).filter(
										(suggestion) =>
											suggestion.destination === options.permissionDestination,
									)
								: undefined;
						if (resolved.waiter) {
							yield* Deferred.succeed(resolved.waiter, {
								decision: resolved.mapped,
								...(selectedPermissionUpdates != null
									? { permissionUpdates: selectedPermissionUpdates }
									: {}),
							}).pipe(Effect.ignore);
						}
						return Option.some({
							mapped: resolved.mapped,
							sessionId: resolved.sessionId,
							toolName: resolved.toolName,
						});
					}),
				resolvePermissionRequest,
				markPermissionReplied: (requestId: string) =>
					Ref.modify(permissions, (current) => {
						const existed = current.has(requestId);
						if (!existed) return [false, current] as const;
						const next = new Map(current);
						next.delete(requestId);
						return [true, next] as const;
					}),
				takeTimedOutPermissions: () =>
					Effect.gen(function* () {
						const now = yield* Clock.currentTimeMillis;
						const snapshot = yield* Ref.get(permissions);
						const candidates = [...snapshot.values()].filter(
							(entry) => now - entry.timestamp >= timeoutMs,
						);
						if (candidates.length === 0) return [];
						const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
						const expire = Effect.gen(function* () {
							let expired = candidates;
							if (Option.isSome(sql)) {
								const eventStore =
									yield* Effect.serviceOption(EventStoreEffectTag);
								const projector = yield* Effect.serviceOption(
									ProjectionRunnerEffectTag,
								);
								if (Option.isNone(eventStore) || Option.isNone(projector))
									return [];
								expired = yield* Effect.gen(function* () {
									const commit = yield* makeCommitAndSignal;
									return yield* commit.write((project) =>
										Effect.gen(function* () {
											// Claim expiry durably before failing the waiter, so a late
											// answer cannot be accepted between those two actions.
											yield* sql.value`UPDATE sessions SET project_id = project_id WHERE 0`;
											const rows = yield* sql.value<{
												id: string;
												session_id: string;
												provider_process_id: string | null;
												provider_request_id: string | null;
											}>`SELECT pa.id, pa.session_id, pa.provider_process_id, pa.provider_request_id FROM pending_approvals pa JOIN sessions s ON s.id = pa.session_id
											WHERE pa.type = 'permission' AND pa.status = 'pending' AND s.project_id = ${eventStore.value.projectId}
											AND ${sql.value.in(
												"pa.id",
												candidates.map((entry) => entry.requestId),
											)}`;
											const current = yield* Ref.get(permissions);
											const selected = candidates.filter(
												(entry) =>
													current.get(entry.requestId) === entry &&
													rows.some(
														(row) =>
															row.id === entry.requestId &&
															row.session_id === entry.sessionId,
													),
											);
											if (selected.length > 0)
												yield* project(
													yield* eventStore.value.appendBatch(
														selected.map((entry) => {
															const prompt = rows.find(
																(row) =>
																	row.id === entry.requestId &&
																	row.session_id === entry.sessionId,
															);
															return canonicalEvent(
																"permission.resolved",
																entry.sessionId,
																{
																	id: entry.requestId,
																	decision: "reject",
																	...(prompt?.provider_process_id != null
																		? {
																				providerProcessId:
																					prompt.provider_process_id,
																			}
																		: {}),
																	...(prompt?.provider_request_id != null
																		? {
																				providerRequestId:
																					prompt.provider_request_id,
																			}
																		: {}),
																},
																{ metadata: { source: "permission-timeout" } },
															);
														}),
													),
												);
											yield* enqueueCommittedControlAnswers({
												sql: sql.value,
												projectId: eventStore.value.projectId,
												project,
												requestIds: selected.map((entry) => entry.requestId),
											});
											return selected;
										}),
									);
								}).pipe(
									Effect.provideService(SqlClient.SqlClient, sql.value),
									Effect.provideService(EventStoreEffectTag, eventStore.value),
									Effect.provideService(
										ProjectionRunnerEffectTag,
										projector.value,
									),
								);
							}
							const timedOut = yield* Ref.modify(permissions, (current) => {
								const next = new Map(current);
								const timedOutEntries: PermissionState[] = [];
								for (const entry of expired) {
									const id = entry.requestId;
									if (current.get(id) === entry) {
										timedOutEntries.push(entry);
										next.delete(id);
									}
								}
								return [timedOutEntries, next] as const;
							});
							yield* Effect.forEach(
								timedOut,
								(entry) =>
									entry.waiter
										? Deferred.fail(
												entry.waiter,
												new PendingInteractionCancelled({
													requestId: entry.requestId,
													sessionId: entry.sessionId,
													reason: "Permission request timed out",
												}),
											).pipe(Effect.ignore)
										: Effect.void,
								{ discard: true },
							);
							return timedOut.map((entry) => ({
								id: entry.requestId,
								sessionId: entry.sessionId,
								awaited: entry.waiter !== undefined,
							}));
						});
						return yield* expire.pipe(
							Effect.catch((cause) =>
								Effect.logWarning(
									"Could not verify permission expiry",
									cause,
								).pipe(Effect.as([])),
							),
						);
					}),
				recordQuestionRequest,
				beginQuestionRequest,
				recoverPendingQuestions: (pending) =>
					Effect.forEach(pending, (question) =>
						storeQuestionRequest({ ...question, recovered: true }),
					),
				listPendingQuestions: (sessionId?: string) =>
					Ref.get(questions).pipe(
						Effect.map((current) =>
							Array.from(current.values())
								.filter(
									(entry) =>
										sessionId == null ||
										entry.sessionId === "" ||
										entry.sessionId === sessionId,
								)
								.map(toPendingQuestion),
						),
					),
				resolveQuestionFromBrowser: takeQuestionRequest,
				resolveQuestionRequest,
				markQuestionResolved: (requestId: string) =>
					Ref.modify(questions, (current) => {
						const existed = current.has(requestId);
						if (!existed) return [false, current] as const;
						const next = new Map(current);
						next.delete(requestId);
						return [true, next] as const;
					}),
				cancelSessionInteractions,
			};
		}),
	);

export const PendingInteractionServiceLive =
	makePendingInteractionServiceLive();
