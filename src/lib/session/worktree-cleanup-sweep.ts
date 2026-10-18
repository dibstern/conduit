import { existsSync } from "node:fs";
import { SqlClient } from "@effect/sql";
import { Cause, Effect } from "effect";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../contracts/provider-instance.js";
import type {
	WorktreeCleanup,
	WorktreeCleanupEntry,
	WorktreeCleanupReport,
} from "../contracts/worktree.js";
import { OpenCodeInstancesTag } from "../domain/daemon/Services/opencode-instances-service.js";
import { WorktreeServiceTag } from "../domain/daemon/Services/worktree-service.js";
import {
	AgentLivenessTag,
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
import { hasNoCommitsBeyondDefault } from "../git/session-git.js";
import { realWorkspacePath } from "../git/worktrees.js";
import { readPersistedAutoSettleFacts } from "./auto-settle-reader.js";
import {
	decideWorktreeCleanup,
	sessionQuiescenceBlockReason,
	type WorktreeCleanupGitCheck,
} from "./worktree-cleanup-rules.js";

/** Discovery only: no Git calls and no relay startup for an absent checkout. */
export const readWorktreeCleanupPaths = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return yield* sql<{ session_id: string; path: string }>`
		SELECT DISTINCT events.session_id, mapping.value AS path
		FROM events, json_each(events.data, '$.worktrees') AS mapping
		WHERE events.type = 'session.workspace_changed'
			AND json_extract(events.data, '$.cause') = 'launch'
			AND json_extract(events.data, '$.origin') = 'conduit'`;
});

/** Everything quiescence reads for one session, apart from its viewers and agent. */
export const readSessionQuiescence = (now: number, sessionId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const backgroundOf = yield* BackgroundLivenessTag;
		const retries = yield* Effect.serviceOption(SessionRetriesTag);
		return {
			facts: (yield* readPersistedAutoSettleFacts(now, sessionId)).get(
				sessionId,
			),
			hasPendingTurn:
				(yield* sql<{ found: number }>`SELECT EXISTS (
					SELECT 1 FROM provider_command_outbox
					WHERE session_id = ${sessionId} AND effect_type = 'send_turn'
					AND status IN ('pending', 'running', 'retryable_failed')
				) AS found`)[0]?.found === 1,
			hasLiveBackgroundWork: backgroundOf(sessionId) !== undefined,
			isRetrying:
				retries._tag === "Some" && retries.value(sessionId) !== undefined,
		};
	});

export const cleanUpProjectWorktrees = (
	getSetting: Effect.Effect<WorktreeCleanup>,
	getProjectFolders: Effect.Effect<readonly string[]>,
	now: number,
) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const worktrees = yield* WorktreeServiceTag;
		const workspace = yield* SessionWorkspaceTag;
		const inbox = yield* SessionInboxTag;
		const localPty = yield* Effect.serviceOption(LocalPtyServiceTag);
		const instances = yield* OpenCodeInstancesTag;
		const sessionGit = yield* Effect.serviceOption(SessionGitServiceTag);
		const viewers = yield* WebSocketHandlerTag;
		const agentIsLive = yield* AgentLivenessTag;
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
				return {
					...(yield* readSessionQuiescence(now, sessionId)),
					hasViewer: viewers.getClientsForSession(sessionId).length > 0,
					hasLiveAgent: yield* agentIsLive(sessionId),
				};
			});
		const blockedReason = (
			state: Effect.Effect.Success<ReturnType<typeof stateOf>>,
		) => {
			return (
				sessionQuiescenceBlockReason(state) ??
				(state.hasLiveAgent ? "Agent process is running" : undefined) ??
				(state.hasViewer ? "Session has a viewer" : undefined)
			);
		};
		for (const sessionId of sessionIds) {
			const base = { projectSlug: config.slug, sessionId };
			yield* Effect.gen(function* () {
				const setting = yield* getSetting;
				const initial = yield* stateOf(sessionId);
				const deleted = initial.facts === undefined;
				const initialDecision = decideWorktreeCleanup(
					setting,
					initial.facts,
					now,
				);
				const earlyReason = blockedReason(initial);
				// Modern ownership is a pure event read. Legacy proof may inspect Git,
				// so leave it until the cheap session guards have passed.
				let owned = yield* readSessionWorktreeOwnership(sessionId, false);
				if (owned.length === 0) {
					if (earlyReason || (deleted && initialDecision._tag === "Keep"))
						return;
					owned = yield* readSessionWorktreeOwnership(sessionId);
				}
				for (const checkout of owned.filter(({ path }) => existsSync(path))) {
					const entry = { ...base, path: checkout.path };
					yield* Effect.gen(function* () {
						const keep = (reason: string) => {
							report.kept.push({ ...entry, reason });
						};
						if (earlyReason) return keep(earlyReason);
						if (
							initialDecision._tag === "Keep" &&
							!initialDecision.inspectCheckout
						)
							return keep(initialDecision.reason);
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
						let decision = initialDecision;
						const gitChecks: Partial<Record<WorktreeCleanupGitCheck, boolean>> =
							{};
						let inspection:
							| { readonly head?: string; readonly keepReason?: string }
							| undefined;
						let inspectedKeepWhen: WorktreeCleanup["keepWhen"] | undefined;
						while (true) {
							if (!inspection || inspectedKeepWhen !== decision.keepWhen) {
								inspection = yield* worktrees.inspectCheckoutCleanup(
									{
										path: checkout.folder,
										projectSlug: config.slug,
										sessionId,
									},
									checkout,
									decision.keepWhen,
								);
								inspectedKeepWhen = decision.keepWhen;
							}
							if (inspection.keepReason) return keep(inspection.keepReason);
							if (!inspection.head) return keep("Could not read checkout HEAD");
							if (decision._tag === "Keep") return keep(decision.reason);
							for (const check of decision.gitChecks) {
								if (gitChecks[check] !== undefined) continue;
								switch (check) {
									case "nothing-missing": {
										const inspectedHead = inspection.head;
										gitChecks[check] = yield* Effect.tryPromise(() =>
											hasNoCommitsBeyondDefault(checkout.path, inspectedHead),
										);
										break;
									}
								}
							}
							if (decision.gitChecks.every((check) => gitChecks[check])) break;
							decision = decideWorktreeCleanup(
								setting,
								initial.facts,
								now,
								gitChecks,
							);
							if (decision._tag === "Keep") return keep(decision.reason);
						}
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
										decision.keepWhen,
										inspection.head,
										changed,
									),
								),
							),
						);
						if (keptReason) return keep(keptReason);
						report.removed.push({ ...entry, reason: decision.reason });
						if (sessionGit._tag === "Some")
							yield* sessionGit.value.refresh({ sessionId }).pipe(
								Effect.catchAllCause((cause) => {
									if (Cause.isInterruptedOnly(cause))
										return Effect.failCause(cause);
									report.failed.push({
										...entry,
										reason:
											"Checkout removed, but session status could not be refreshed",
									});
									return Effect.logWarning(
										"worktree cleanup git refresh failed",
										{ ...entry, cause: Cause.pretty(cause) },
									);
								}),
							);
					}).pipe(
						Effect.catchAllCause((cause) => {
							if (Cause.isInterruptedOnly(cause))
								return Effect.failCause(cause);
							report.failed.push({
								...entry,
								reason: `Cleanup failed: ${Cause.pretty(cause).split("\n")[0]?.slice(0, 300) ?? "Unknown error"}`,
							});
							return Effect.logWarning("worktree cleanup failed for session", {
								...entry,
								cause: Cause.pretty(cause),
							});
						}),
					);
				}
			}).pipe(
				Effect.catchAllCause((cause) => {
					if (Cause.isInterruptedOnly(cause)) return Effect.failCause(cause);
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
						{ ...base, cause: Cause.pretty(cause) },
					);
				}),
			);
		}
		return report satisfies WorktreeCleanupReport;
	});
