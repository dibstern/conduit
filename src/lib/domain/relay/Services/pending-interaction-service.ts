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
import type { PermissionId } from "../../../shared-types.js";
import type {
	FrontendDecision,
	OpenCodeDecision,
	PendingPermission,
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
}> {}

export interface PendingPermissionRequestInput {
	readonly requestId: PermissionId;
	readonly sessionId: string;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
	readonly always?: readonly string[];
}

export interface PendingPermissionRecoveryInput {
	readonly id: string;
	readonly permission: string;
	readonly sessionId?: string;
	readonly patterns?: readonly string[];
	readonly metadata?: Record<string, unknown>;
	readonly always?: readonly string[];
}

export interface PendingQuestionInput {
	readonly requestId: string;
	readonly sessionId: string;
	readonly questions: readonly PendingQuestionItemInput[];
	readonly toolCallId?: string;
}

export interface PendingQuestionItemInput {
	readonly question: string;
	readonly header?: string;
	readonly options?: readonly unknown[];
	readonly multiSelect?: boolean;
}

export interface PendingQuestion {
	readonly requestId: string;
	readonly sessionId: string;
	readonly questions: readonly PendingQuestionItem[];
	readonly toolCallId?: string;
	readonly timestamp: number;
}

export interface PendingQuestionItem {
	readonly question: string;
	readonly header?: string;
	readonly options?: readonly unknown[];
	readonly multiSelect?: boolean;
}

export interface ResolvedPermissionDecision {
	readonly mapped: OpenCodeDecision;
	readonly sessionId: string;
	readonly toolName: string;
}

export interface ResolvedQuestionResponse {
	readonly sessionId: string;
}

export interface PendingPermissionResponse {
	readonly decision: OpenCodeDecision;
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
	): Effect.Effect<Option.Option<ResolvedPermissionDecision>>;
	markPermissionReplied(requestId: string): Effect.Effect<boolean>;
	recoverPendingPermissions(
		permissions: readonly PendingPermissionRecoveryInput[],
	): Effect.Effect<PendingPermission[]>;
	takeTimedOutPermissions(): Effect.Effect<
		Array<{ id: string; sessionId: string }>
	>;
	recordQuestionRequest(
		input: PendingQuestionInput,
	): Effect.Effect<PendingQuestion>;
	beginQuestionRequest(
		input: PendingQuestionInput,
	): Effect.Effect<StartedQuestionRequest>;
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
	): Effect.Effect<void>;
}

export class PendingInteractionServiceTag extends Context.Tag(
	"PendingInteractionService",
)<PendingInteractionServiceTag, PendingInteractionService>() {}

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
				timestamp: state.timestamp,
			});

			const toPendingQuestion = (state: QuestionState): PendingQuestion => ({
				requestId: state.requestId,
				sessionId: state.sessionId,
				questions: state.questions,
				...(state.toolCallId != null ? { toolCallId: state.toolCallId } : {}),
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
					const timestamp = yield* Clock.currentTimeMillis;
					const entry: QuestionState = {
						requestId: input.requestId,
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
						})),
						...(input.toolCallId != null
							? { toolCallId: input.toolCallId }
							: {}),
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
					return Option.some({ sessionId: state.sessionId });
				});

			const resolveQuestionRequest = (
				requestId: string,
				answers: Record<string, unknown>,
			) =>
				takeQuestionRequest(requestId, answers).pipe(Effect.map(Option.isSome));

			const cancelSessionInteractions = (sessionId: string, reason: string) =>
				Effect.gen(function* () {
					const cancelledPermissions = yield* Ref.modify(
						permissions,
						(current) => {
							const next = new Map(current);
							const cancelled: PermissionState[] = [];
							for (const [id, entry] of current) {
								if (entry.sessionId === sessionId) {
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
							if (entry.sessionId === sessionId) {
								cancelled.push(entry);
								next.delete(id);
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
				resolvePermissionFromBrowser: (requestId: string, decision: string) =>
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
						if (resolved.waiter) {
							yield* Deferred.succeed(resolved.waiter, {
								decision: resolved.mapped,
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
				recoverPendingPermissions: (
					pending: readonly PendingPermissionRecoveryInput[],
				) =>
					Effect.forEach(pending, (permission) =>
						recordPermissionRequest({
							requestId: permission.id as PermissionId,
							sessionId: permission.sessionId ?? "",
							toolName: permission.permission,
							toolInput: {
								patterns: [...(permission.patterns ?? [])],
								metadata: permission.metadata ?? {},
							},
							always: permission.always ?? [],
						}),
					),
				takeTimedOutPermissions: () =>
					Effect.gen(function* () {
						const now = yield* Clock.currentTimeMillis;
						const timedOut = yield* Ref.modify(permissions, (current) => {
							const next = new Map(current);
							const timedOutEntries: PermissionState[] = [];
							for (const [id, entry] of current) {
								if (now - entry.timestamp >= timeoutMs) {
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
						}));
					}),
				recordQuestionRequest,
				beginQuestionRequest,
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
