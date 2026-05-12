import { Clock, Context, Effect, Layer, Option, Ref } from "effect";
import type { PermissionId } from "../shared-types.js";
import type {
	FrontendDecision,
	OpenCodeDecision,
	PendingPermission,
} from "../types.js";

const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;

const DECISION_MAP: Record<FrontendDecision, OpenCodeDecision> = {
	allow: "once",
	deny: "reject",
	allow_always: "always",
};

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

export interface ResolvedPermissionDecision {
	readonly mapped: OpenCodeDecision;
	readonly toolName: string;
}

export interface PendingInteractionService {
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
			const permissions = yield* Ref.make(new Map<string, PendingPermission>());
			const timeoutMs =
				options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;

			const recordPermissionRequest = (input: PendingPermissionRequestInput) =>
				Effect.gen(function* () {
					const timestamp = yield* Clock.currentTimeMillis;
					const entry: PendingPermission = {
						requestId: input.requestId,
						sessionId: input.sessionId,
						toolName: input.toolName,
						toolInput: input.toolInput,
						always: [...(input.always ?? [])],
						timestamp,
					};
					yield* Ref.update(permissions, (current) => {
						const next = new Map(current);
						next.set(entry.requestId, entry);
						return next;
					});
					return entry;
				});

			return {
				recordPermissionRequest,
				listPendingPermissions: (sessionId?: string) =>
					Ref.get(permissions).pipe(
						Effect.map((current) =>
							Array.from(current.values()).filter(
								(entry) =>
									sessionId == null ||
									entry.sessionId === "" ||
									entry.sessionId === sessionId,
							),
						),
					),
				resolvePermissionFromBrowser: (requestId: string, decision: string) =>
					Ref.modify(permissions, (current) => {
						const entry = current.get(requestId);
						const mapped = DECISION_MAP[decision as FrontendDecision];
						if (!entry || !mapped) {
							return [Option.none(), current] as const;
						}
						const next = new Map(current);
						next.delete(requestId);
						return [
							Option.some({ mapped, toolName: entry.toolName }),
							next,
						] as const;
					}),
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
						return yield* Ref.modify(permissions, (current) => {
							const next = new Map(current);
							const timedOut: Array<{ id: string; sessionId: string }> = [];
							for (const [id, entry] of current) {
								if (now - entry.timestamp >= timeoutMs) {
									timedOut.push({ id, sessionId: entry.sessionId });
									next.delete(id);
								}
							}
							return [timedOut, next] as const;
						});
					}),
			};
		}),
	);

export const PendingInteractionServiceLive =
	makePendingInteractionServiceLive();
