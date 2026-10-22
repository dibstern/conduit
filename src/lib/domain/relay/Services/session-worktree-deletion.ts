import { isAbsolute, relative, resolve, sep } from "node:path";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
	SessionWorkspaceSchema,
	type SessionWorktreeInspection,
	type SessionWorktreeOwnership,
} from "../../../contracts/session-workspace.js";
import { realWorkspacePath } from "../../../git/worktrees.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { readSessionWorktreeOwnershipSnapshot } from "../../../persistence/effect/session-worktree-ownership.js";
import { WorktreeServiceTag } from "../../daemon/Services/worktree-service.js";
import { DaemonSessionQueryServiceTag } from "./daemon-session-query-service.js";
import { AgentLivenessTag, ConfigTag } from "./services.js";
import { SessionCommandError } from "./session-command.js";

export interface SessionWorktreeDeletionPlan {
	readonly ownership: readonly SessionWorktreeOwnership[];
	readonly worktrees: readonly SessionWorktreeInspection[];
	readonly removeWorktrees: boolean;
}

export const containsPath = (root: string, path: string) => {
	const child = relative(root, path);
	return (
		child === "" ||
		(!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
	);
};

/** Read every live row before the canonical delete can cascade away its forks. */
export const worktreeUsers = (sessionId: string) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const sql = yield* SqlClient.SqlClient;
		const local = yield* sql<{
			id: string;
			project_id: string;
			workspace: string;
		}>`SELECT id, project_id, workspace FROM sessions WHERE id != ${sessionId} AND workspace IS NOT NULL`;
		const uses = (yield* Effect.forEach(
			local,
			({ id, project_id, workspace }) =>
				Schema.decodeUnknownEffect(
					Schema.fromJsonString(SessionWorkspaceSchema),
				)(workspace).pipe(
					Effect.map((value) =>
						Object.values(value.worktrees).map((path) => ({
							key: `${project_id}:${id}`,
							path,
						})),
					),
				),
		)).flat();
		let unknown = false;
		const daemon = yield* Effect.serviceOption(DaemonSessionQueryServiceTag);
		if (daemon._tag === "Some") {
			const result = yield* Effect.result(daemon.value.list({ roots: false }));
			if (Result.isSuccess(result)) {
				unknown =
					result.success.hasMore ||
					result.success.availability.some((project) => !project.available);
				for (const session of result.success.sessions)
					if (
						session.id !== sessionId ||
						(session.projectSlug != null && session.projectSlug !== config.slug)
					)
						uses.push(
							...Object.values(session.workspace?.worktrees ?? {}).map(
								(path) => ({
									key: `${session.projectSlug ?? config.slug}:${session.id}`,
									path,
								}),
							),
						);
			} else if (result.failure._tag !== "DaemonSessionQueryNotSupported")
				unknown = true;
		}
		const users = yield* Effect.forEach(uses, (use) =>
			realWorkspacePath(use.path).pipe(
				Effect.orElseSucceed(() => resolve(use.path)),
				Effect.map((path) => ({ ...use, path })),
			),
		);
		return { unknown, users, paths: users.map(({ path }) => path) };
	});

/** Launch checkout identity is immutable; canonical renames update only its owned branch. */
export const readSessionWorktreeOwnership = (
	sessionId: string,
	includeLegacy = true,
	projectSlug?: string,
) =>
	Effect.gen(function* () {
		const store = yield* Effect.serviceOption(EventStoreEffectTag);
		const config = yield* Effect.serviceOption(ConfigTag);
		const projectId =
			projectSlug ??
			(store._tag === "Some"
				? store.value.projectId
				: config._tag === "Some"
					? config.value.slug
					: undefined);
		if (projectId === undefined)
			return yield* new SessionCommandError({
				operation: "worktree.inspect",
				cause: "Worktree inspection requires a project.",
			});
		const snapshot = yield* readSessionWorktreeOwnershipSnapshot(
			projectId,
			sessionId,
		);
		if (!snapshot) return [];
		if (snapshot._tag === "Conflict")
			return yield* new SessionCommandError({
				operation: "worktree.inspect",
				cause:
					snapshot.reason === "launch"
						? "Conflicting launch ownership records. Worktrees will be kept."
						: snapshot.reason === "branch-rename"
							? "Branch rename does not match launch ownership. Worktrees will be kept."
							: "Malformed worktree ownership records. Worktrees will be kept.",
			});
		const service = yield* Effect.serviceOption(WorktreeServiceTag);
		if (service._tag === "None")
			return yield* new SessionCommandError({
				operation: "worktree.inspect",
				cause: "Worktree inspection is unavailable.",
			});
		if (snapshot._tag === "Owned") return [...snapshot.ownership];
		const ownership = new Map<string, SessionWorktreeOwnership>();
		for (const [folder, path] of includeLegacy
			? Object.entries(snapshot.worktrees)
			: []) {
			if (config._tag === "None")
				return yield* new SessionCommandError({
					operation: "worktree.inspect",
					cause: "Legacy worktree inspection requires project configuration.",
				});
			const owned = yield* service.value
				.legacyOwnership(
					{ path: folder, projectSlug: config.value.slug, sessionId },
					path,
				)
				.pipe(
					Effect.catchIf(
						(error) => error.reason === "not-owned",
						() => Effect.succeed(undefined),
					),
				);
			if (owned && !ownership.has(owned.path)) ownership.set(owned.path, owned);
		}
		return [...ownership.values()];
	}).pipe(
		Effect.mapError((cause) =>
			cause instanceof SessionCommandError
				? cause
				: new SessionCommandError({ operation: "worktree.inspect", cause }),
		),
	);

export const prepareSessionWorktreeDeletion = (sessionId: string) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const owned = yield* readSessionWorktreeOwnership(sessionId);
		if (owned.length === 0)
			return {
				ownership: [],
				worktrees: [],
				removeWorktrees: true,
			} satisfies SessionWorktreeDeletionPlan;
		const service = yield* Effect.serviceOption(WorktreeServiceTag);
		if (service._tag === "None")
			return yield* new SessionCommandError({
				operation: "worktree.inspect",
				cause: "Worktree inspection is unavailable.",
			});
		const users = yield* worktreeUsers(sessionId);
		const worktrees = yield* Effect.forEach(owned, (checkout) =>
			Effect.gen(function* () {
				const reasons = yield* service.value.inspectRemoval(
					{ path: checkout.folder, projectSlug: config.slug, sessionId },
					checkout,
				);
				return {
					folder: checkout.folder,
					path: checkout.path,
					reasons: users.unknown
						? [...reasons, "Could not check worktree use in every project"]
						: reasons,
					inUse:
						users.unknown ||
						users.paths.some((path) => containsPath(checkout.path, path)),
				} satisfies SessionWorktreeInspection;
			}),
		);
		return {
			ownership: owned,
			worktrees,
			removeWorktrees: worktrees.every(
				(checkout) => !checkout.inUse && checkout.reasons.length === 0,
			),
		} satisfies SessionWorktreeDeletionPlan;
	}).pipe(
		Effect.mapError((cause) =>
			cause instanceof SessionCommandError
				? cause
				: new SessionCommandError({ operation: "worktree.inspect", cause }),
		),
	);

/** Best effort after session.deleted commits. A failure in one checkout leaves the others eligible. */
export const cleanupSessionWorktrees = (
	sessionId: string,
	plan: SessionWorktreeDeletionPlan,
) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const agentIsLive = yield* AgentLivenessTag;
		const service = yield* Effect.serviceOption(WorktreeServiceTag);
		if (service._tag === "None")
			return ["Worktrees kept because cleanup is unavailable."];
		const warnings: string[] = [];
		for (const owned of plan.ownership) {
			// The FK cascade can remove a fork's row, so its pre-delete use remains authoritative.
			if (
				plan.worktrees.some(
					(checkout) => checkout.path === owned.path && checkout.inUse,
				)
			)
				continue;
			const inUse = worktreeUsers(sessionId).pipe(
				Effect.flatMap((users) =>
					users.unknown ||
					users.paths.some((path) => containsPath(owned.path, path))
						? Effect.succeed(true)
						: agentIsLive(sessionId),
				),
				Effect.catchCause(() => Effect.succeed(true)),
			);
			const outcome = yield* Effect.result(
				service.value.remove(
					{ path: owned.folder, projectSlug: config.slug, sessionId },
					owned,
					inUse,
				),
			);
			if (Result.isFailure(outcome))
				warnings.push(`${owned.folder}: ${outcome.failure.message}`);
		}
		return warnings;
	});
