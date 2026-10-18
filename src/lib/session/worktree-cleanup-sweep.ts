import { existsSync } from "node:fs";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../contracts/provider-instance.js";
import type {
	WorktreeCleanup,
	WorktreeCleanupEntry,
	WorktreeCleanupReport,
} from "../contracts/worktree.js";
import { OpenCodeInstancesTag } from "../domain/daemon/Services/opencode-instances-service.js";
import { WorktreeServiceTag } from "../domain/daemon/Services/worktree-service.js";
import { PersistenceProjectTag } from "../domain/persistence/Services/persistence-service.js";
import {
	BackgroundLivenessTag,
	ConfigTag,
	SessionRetriesTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { SessionGitServiceTag } from "../domain/relay/Services/session-git-service.js";
import { SessionInboxTag } from "../domain/relay/Services/session-inbox.js";
import { SessionWorkspaceTag } from "../domain/relay/Services/session-workspace.js";
import {
	containsPath,
	readSessionWorktreeOwnership,
	worktreeUsers,
} from "../domain/relay/Services/session-worktree-deletion.js";
import { LocalPtyServiceTag } from "../domain/relay/Services/terminal-service.js";
import * as Failure from "../effect/failure-classification.js";
import {
	daemonSessionGitCache,
	hasNoCommitsBeyondDefault,
} from "../git/session-git.js";
import { realWorkspacePath } from "../git/worktrees.js";
import { readPersistedAutoSettleFacts } from "./auto-settle-reader.js";

const DAY_MS = 86_400_000;

/** Discovery only: no Git calls and no relay startup for an absent checkout. */
export const readWorktreeCleanupPaths = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const { projectId } = yield* PersistenceProjectTag;
	return yield* sql<{ session_id: string; path: string }>`
		SELECT DISTINCT events.session_id, mapping.value AS path
		FROM events, json_each(events.data, '$.worktrees') AS mapping
		WHERE events.project_id = ${projectId}
			AND events.type = 'session.workspace_changed'
			AND json_extract(events.data, '$.cause') = 'launch'
			AND json_extract(events.data, '$.origin') = 'conduit'`;
});

export const cleanUpProjectWorktrees = (
	getSetting: Effect.Effect<WorktreeCleanup>,
	getProjectFolders: Effect.Effect<readonly string[]>,
	now: number,
) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const { projectId } = yield* PersistenceProjectTag;
		const worktrees = yield* WorktreeServiceTag;
		const workspace = yield* SessionWorkspaceTag;
		const inbox = yield* SessionInboxTag;
		const sql = yield* SqlClient.SqlClient;
		const localPty = yield* Effect.serviceOption(LocalPtyServiceTag);
		const instances = yield* OpenCodeInstancesTag;
		const sessionGit = yield* Effect.serviceOption(SessionGitServiceTag);
		const viewers = yield* WebSocketHandlerTag;
		const backgroundOf = yield* BackgroundLivenessTag;
		const retries = yield* Effect.serviceOption(SessionRetriesTag);
		const report: {
			removed: WorktreeCleanupEntry[];
			kept: WorktreeCleanupEntry[];
			failed: WorktreeCleanupEntry[];
		} = { removed: [], kept: [], failed: [] };
		const paths = (yield* readWorktreeCleanupPaths).filter(({ path }) =>
			existsSync(path),
		);
		const sessionIds = new Set(paths.map(({ session_id }) => session_id));
		const stateOf = (sessionId: string) =>
			Effect.gen(function* () {
				const facts = (yield* readPersistedAutoSettleFacts(
					projectId,
					now,
					sessionId,
				)).get(sessionId);
				return {
					facts,
					hasPendingTurn:
						(yield* sql<{ found: number }>`SELECT EXISTS (
							SELECT 1 FROM provider_command_outbox
							WHERE project_key = ${projectId} AND session_id = ${sessionId} AND effect_type = 'send_turn'
							AND status IN ('pending', 'running', 'retryable_failed')
						) AS found`)[0]?.found === 1,
					hasViewer: viewers.getClientsForSession(sessionId).length > 0,
					hasLiveBackgroundWork: backgroundOf(sessionId) !== undefined,
					isRetrying:
						retries._tag === "Some" && retries.value(sessionId) !== undefined,
				};
			});
		const blockedReason = (
			state: Effect.Effect.Success<ReturnType<typeof stateOf>>,
		) => {
			const facts = state.facts;
			if (
				facts?.status === "busy" ||
				facts?.status === "pending" ||
				facts?.status === "retry" ||
				facts?.latestTurn?.state === "pending" ||
				facts?.latestTurn?.state === "running" ||
				state.isRetrying ||
				state.hasPendingTurn
			)
				return "Session is running";
			if (facts?.hasPendingApproval)
				return "Has a pending approval or question";
			if (state.hasLiveBackgroundWork) return "Has live background work";
			if (state.hasViewer) return "Session has a viewer";
			return undefined;
		};
		for (const sessionId of sessionIds) {
			const base = { projectSlug: config.slug, sessionId };
			yield* Effect.gen(function* () {
				const setting = yield* getSetting;
				const initial = yield* stateOf(sessionId);
				const deleted = initial.facts === undefined;
				const earlyReason = blockedReason(initial);
				// Modern ownership is a pure event read. Legacy proof may inspect Git,
				// so leave it until the cheap session guards have passed.
				let owned = yield* readSessionWorktreeOwnership(sessionId, false);
				if (owned.length === 0) {
					if (earlyReason || (deleted && !setting.onDelete)) return;
					owned = yield* readSessionWorktreeOwnership(sessionId);
				}
				for (const checkout of owned.filter(({ path }) => existsSync(path))) {
					const entry = { ...base, path: checkout.path };
					yield* Effect.gen(function* () {
						const keep = (reason: string) => {
							report.kept.push({ ...entry, reason });
						};
						if (earlyReason) return keep(earlyReason);
						if (deleted && !setting.onDelete)
							return keep("No rule matched for deleted session");
						if (
							!deleted &&
							!(
								initial.facts?.settledAt != null && setting.onSettle !== "off"
							) &&
							setting.afterInactiveDays === null &&
							!setting.whenMerged &&
							!setting.noCommitsBeyondDefault
						)
							return keep("No rule matched");
						const sharedReason = Effect.gen(function* () {
							if (
								(yield* getProjectFolders).some((folder) =>
									containsPath(checkout.path, folder),
								)
							)
								return "Contains a registered project folder";
							const users = yield* worktreeUsers(sessionId);
							if (users.unknown)
								return "Could not check worktree use in every project";
							const others = new Set(
								users.users
									.filter(({ path }) => containsPath(checkout.path, path))
									.map(({ key }) => key),
							).size;
							return others > 0
								? `Shared by ${others + (deleted ? 0 : 1)} sessions`
								: undefined;
						});
						const shared = yield* sharedReason;
						if (shared) return keep(shared);
						const hasOpenTerminal = Effect.gen(function* () {
							if (localPty._tag === "None")
								return yield* Effect.fail(
									new Error("Hosted terminal state is unavailable"),
								);
							const hosted = yield* localPty.value.list(
								config.projectDir,
								true,
							);
							for (const pty of hosted)
								if (
									pty.status !== "exited" &&
									containsPath(checkout.path, yield* realWorkspacePath(pty.cwd))
								)
									return true;
							const client = yield* instances.useIfRunning(
								MANAGED_OPENCODE_ACCOUNT_ID,
							);
							if (client._tag === "None") return false;
							// Cleanup cannot trust the UI's cached list after a discovery error.
							const providerPtys = yield* Effect.tryPromise(() =>
								client.value.pty.list(),
							);
							for (const pty of providerPtys)
								if (
									pty["status"] !== "exited" &&
									containsPath(
										checkout.path,
										yield* realWorkspacePath(
											String(pty["cwd"] ?? config.projectDir),
										),
									)
								)
									return true;
							return false;
						}).pipe(Effect.scoped);
						if (yield* hasOpenTerminal) return keep("Has an open terminal");
						const inspection = yield* worktrees.inspectCheckoutCleanup(
							{ path: checkout.folder, projectSlug: config.slug, sessionId },
							checkout,
							setting.keepWhen,
						);
						if (inspection.keepReason) return keep(inspection.keepReason);
						if (!inspection.head) return keep("Could not read checkout HEAD");
						let reason: string | undefined;
						if (deleted) reason = "Session was deleted";
						else {
							const facts = initial.facts;
							if (facts?.settledAt != null && setting.onSettle === "any")
								reason = "Session is settled";
							if (!reason && setting.afterInactiveDays !== null && facts) {
								const turn = facts.latestTurn;
								const lastActivity = Math.max(
									facts.lastMessageAt ?? -Infinity,
									facts.latestUserMessageAt ?? -Infinity,
									turn?.requestedAt ?? -Infinity,
									turn?.startedAt ?? -Infinity,
									turn?.completedAt ?? -Infinity,
								);
								if (
									Number.isFinite(lastActivity) &&
									lastActivity < now - setting.afterInactiveDays * DAY_MS
								)
									reason = `Inactive for ${Math.floor((now - lastActivity) / DAY_MS)} days`;
							}
							if (
								!reason &&
								(setting.whenMerged ||
									(facts?.settledAt != null && setting.onSettle === "merged"))
							) {
								const git = yield* Effect.tryPromise(() =>
									daemonSessionGitCache.refresh(checkout.path),
								);
								if (git?.merged && git.mergedHead === inspection.head)
									reason =
										facts?.settledAt != null && setting.onSettle === "merged"
											? "Settled and merged"
											: "Branch is merged";
							}
							if (
								!reason &&
								setting.noCommitsBeyondDefault &&
								(yield* Effect.tryPromise(() =>
									hasNoCommitsBeyondDefault(checkout.path),
								))
							)
								reason = "No commits beyond the default branch";
						}
						if (!reason) return keep("No rule matched");
						const changed = Effect.gen(function* () {
							const current = yield* getSetting;
							const latest = yield* stateOf(sessionId);
							return (
								JSON.stringify(current) !== JSON.stringify(setting) ||
								JSON.stringify(latest) !== JSON.stringify(initial) ||
								(yield* hasOpenTerminal) ||
								(yield* sharedReason) !== undefined
							);
						});
						// Admission holds the inbox before resolving launch folders. Keep
						// that order and retain its durable handoff until the turn settles.
						const keptReason = yield* inbox.withSession(
							sessionId,
							workspace.withLaunch(
								worktrees.withCheckoutUse(
									worktrees.removeCheckout(
										{
											path: checkout.folder,
											projectSlug: config.slug,
											sessionId,
										},
										checkout,
										setting.keepWhen,
										inspection.head,
										changed,
									),
								),
							),
						);
						if (keptReason) return keep(keptReason);
						report.removed.push({ ...entry, reason });
						if (sessionGit._tag === "Some")
							yield* sessionGit.value.refresh({ sessionId }).pipe(
								Effect.catchAllCause((cause) => {
									if (Failure.isInterruptedOnly(cause))
										return Effect.failCause(cause);
									report.failed.push({
										...entry,
										reason:
											"Checkout removed, but session status could not be refreshed",
									});
									return Effect.logWarning(
										"worktree cleanup git refresh failed",
										{ ...entry, cause: Failure.renderCause(cause) },
									);
								}),
							);
					}).pipe(
						Effect.catchAllCause((cause) => {
							if (Failure.isInterruptedOnly(cause))
								return Effect.failCause(cause);
							report.failed.push({
								...entry,
								reason: `Cleanup failed: ${Failure.renderCause(cause).split("\n")[0]?.slice(0, 300) ?? "Unknown error"}`,
							});
							return Effect.logWarning("worktree cleanup failed for session", {
								...entry,
								cause: Failure.renderCause(cause),
							});
						}),
					);
				}
			}).pipe(
				Effect.catchAllCause((cause) => {
					if (Failure.isInterruptedOnly(cause)) return Effect.failCause(cause);
					for (const item of paths.filter(
						({ session_id }) => session_id === sessionId,
					))
						report.failed.push({
							...base,
							path: item.path,
							reason: "Could not inspect session worktree ownership",
						});
					return Effect.logWarning(
						"worktree cleanup ownership inspection failed",
						{ ...base, cause: Failure.renderCause(cause) },
					);
				}),
			);
		}
		return report satisfies WorktreeCleanupReport;
	});
