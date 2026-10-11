import { isAbsolute, relative, resolve, sep } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Either, Schema } from "effect";
import {
	SessionWorkspaceSchema,
	type SessionWorktreeInspection,
	type SessionWorktreeOwnership,
} from "../../../contracts/session-workspace.js";
import { SessionWorkspaceChangedPayloadSchema } from "../../../contracts/stored-event.js";
import { realWorkspacePath } from "../../../git/worktrees.js";
import { WorktreeServiceTag } from "../../daemon/Services/worktree-service.js";
import { DaemonSessionQueryServiceTag } from "./daemon-session-query-service.js";
import { ConfigTag } from "./services.js";
import { SessionCommandError } from "./session-command.js";

export interface SessionWorktreeDeletionPlan {
	readonly ownership: readonly SessionWorktreeOwnership[];
	readonly worktrees: readonly SessionWorktreeInspection[];
	readonly removeWorktrees: boolean;
}

const containsPath = (root: string, path: string) => {
	const child = relative(root, path);
	return (
		child === "" ||
		(!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
	);
};

/** Read every live row before the canonical delete can cascade away its forks. */
const worktreeUsers = (sessionId: string) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const sql = yield* SqlClient.SqlClient;
		const local = yield* sql<{
			workspace: string;
		}>`SELECT workspace FROM sessions WHERE id != ${sessionId} AND workspace IS NOT NULL`;
		const paths = (yield* Effect.forEach(local, ({ workspace }) =>
			Schema.decodeUnknown(Schema.parseJson(SessionWorkspaceSchema))(workspace),
		)).flatMap((workspace) => Object.values(workspace.worktrees));
		let unknown = false;
		const daemon = yield* Effect.serviceOption(DaemonSessionQueryServiceTag);
		if (daemon._tag === "Some") {
			const result = yield* Effect.either(daemon.value.list({ roots: false }));
			if (Either.isRight(result)) {
				unknown =
					result.right.hasMore ||
					result.right.availability.some((project) => !project.available);
				for (const session of result.right.sessions)
					if (
						session.id !== sessionId ||
						(session.projectSlug != null && session.projectSlug !== config.slug)
					)
						paths.push(...Object.values(session.workspace?.worktrees ?? {}));
			} else if (result.left._tag !== "DaemonSessionQueryNotSupported")
				unknown = true;
		}
		return {
			unknown,
			paths: yield* Effect.forEach(paths, (path) =>
				realWorkspacePath(path).pipe(Effect.orElseSucceed(() => resolve(path))),
			),
		};
	});

export const prepareSessionWorktreeDeletion = (sessionId: string) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const sql = yield* SqlClient.SqlClient;
		const events = yield* sql<{
			data: string;
		}>`SELECT data FROM events WHERE session_id = ${sessionId} AND type = 'session.workspace_changed' AND json_extract(data, '$.cause') = 'launch' AND json_extract(data, '$.origin') = 'conduit' ORDER BY sequence`;
		if (events.length === 0)
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
		const launches = yield* Effect.forEach(events, ({ data }) =>
			Schema.decodeUnknown(
				Schema.parseJson(SessionWorkspaceChangedPayloadSchema),
			)(data),
		);
		const ownership = new Map<string, SessionWorktreeOwnership>();
		const legacy = new Map<string, string>();
		for (const launch of launches) {
			for (const owned of launch.ownership ?? []) {
				const previous = ownership.get(owned.path);
				if (
					previous &&
					(previous.folder !== owned.folder ||
						previous.branchName !== owned.branchName ||
						previous.head !== owned.head)
				)
					return yield* new SessionCommandError({
						operation: "worktree.inspect",
						cause:
							"Conflicting launch ownership records. Worktrees will be kept.",
					});
				ownership.set(owned.path, owned);
			}
			if (launch.ownership === undefined)
				for (const [folder, path] of Object.entries(launch.worktrees))
					legacy.set(folder, path);
		}
		for (const [folder, path] of launches.every(
			(launch) => launch.ownership === undefined,
		)
			? legacy
			: []) {
			const owned = yield* service.value
				.legacyOwnership(
					{ path: folder, projectSlug: config.slug, sessionId },
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
		const owned = [...ownership.values()];
		if (owned.length === 0)
			return {
				ownership: [],
				worktrees: [],
				removeWorktrees: true,
			} satisfies SessionWorktreeDeletionPlan;
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
				Effect.map(
					(users) =>
						users.unknown ||
						users.paths.some((path) => containsPath(owned.path, path)),
				),
				Effect.catchAllCause(() => Effect.succeed(true)),
			);
			const outcome = yield* Effect.either(
				service.value.remove(
					{ path: owned.folder, projectSlug: config.slug, sessionId },
					owned,
					inUse,
				),
			);
			if (Either.isLeft(outcome))
				warnings.push(`${owned.folder}: ${outcome.left.message}`);
		}
		return warnings;
	});
