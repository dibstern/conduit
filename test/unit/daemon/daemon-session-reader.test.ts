import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { SqlClient } from "@effect/sql";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { listDaemonSessions } from "../../../src/lib/domain/daemon/Services/daemon-session-reader.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { createSessionGitCache } from "../../../src/lib/git/session-git.js";
import { projectStorageDir } from "../../../src/lib/persistence/project-storage.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";
import { writeEventStore } from "../../helpers/persistence-factories.js";

const temporaryRoots: string[] = [];

const makeTemporaryRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "conduit-daemon-sessions-"));
	temporaryRoots.push(root);
	return root;
};

const makeProjectStore = (
	projectDirectory: string,
	sessions: ReadonlyArray<{
		readonly id: string;
		readonly title: string;
		readonly updatedAt: number;
		readonly parentId?: string;
		readonly status?: "idle" | "busy";
		readonly lastMessageAt?: number | null;
		readonly lastTurnEndVersion?: number | null;
		readonly seenVersion?: number | null;
		readonly settledAt?: number | null;
		readonly pinnedAt?: number | null;
		readonly snoozedAt?: number | null;
		readonly snoozedUntil?: number | null;
		readonly wokenAt?: number | null;
		readonly wokenReason?: "approval" | "question" | "error" | "turn" | null;
	}>,
	pendingApprovals: ReadonlyArray<{
		readonly id: string;
		readonly sessionId: string;
		readonly type: "permission" | "question";
		readonly status: "pending" | "resolved";
	}> = [],
): void => {
	const storageDirectory = projectStorageDir(
		dirname(projectDirectory),
		basename(projectDirectory),
	);
	mkdirSync(projectDirectory, { recursive: true });
	mkdirSync(storageDirectory, { recursive: true });
	writeEventStore(
		join(storageDirectory, "events.db"),
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			for (const session of sessions) {
				yield* sql`INSERT INTO sessions (
					id, provider, title, status, parent_id, last_message_at,
					last_turn_end_version, seen_version, settled_at,
					pinned_at, snoozed_at, snoozed_until, woken_at, woken_reason,
					created_at, updated_at
				) VALUES (
					${session.id}, 'opencode', ${session.title}, ${session.status ?? "idle"},
					${session.parentId ?? null}, ${session.lastMessageAt ?? null},
					${session.lastTurnEndVersion ?? null},
					${session.seenVersion ?? null}, ${session.settledAt ?? null},
					${session.pinnedAt ?? null}, ${session.snoozedAt ?? null},
					${session.snoozedUntil ?? null}, ${session.wokenAt ?? null},
					${session.wokenReason ?? null}, ${session.updatedAt}, ${session.updatedAt}
				)`;
			}
			for (const approval of pendingApprovals) {
				yield* sql`INSERT INTO pending_approvals (
					id, session_id, type, status, created_at
				) VALUES (
					${approval.id}, ${approval.sessionId}, ${approval.type},
					${approval.status}, ${Date.now()}
				)`;
			}
		}),
	);
};

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("listDaemonSessions", () => {
	it.effect("stamps cached git context only on git project sessions", () => {
		const root = makeTemporaryRoot();
		const gitProject = join(root, "git-project");
		const plainProject = join(root, "plain-project");
		mkdirSync(gitProject);
		mkdirSync(plainProject);
		execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], {
			cwd: gitProject,
		});
		makeProjectStore(gitProject, [
			{ id: "git-session", title: "Git", updatedAt: 2 },
		]);
		makeProjectStore(plainProject, [
			{ id: "plain-session", title: "Plain", updatedAt: 1 },
		]);
		writeFileSync(join(gitProject, "untracked.txt"), "fixture");
		const cache = createSessionGitCache();
		return Effect.gen(function* () {
			yield* Effect.promise(() => cache.refresh(gitProject));
			yield* Effect.promise(() => cache.refresh(plainProject));
			const result = yield* listDaemonSessions(root, {}, cache);
			expect(
				result.sessions.find((session) => session.id === "git-session")?.git,
			).toEqual({ branch: "main", dirty: true });
			expect(
				result.sessions.find((session) => session.id === "plain-session"),
			).not.toHaveProperty("git");
		}).pipe(
			Effect.provide(
				makeProjectRegistryLive([
					{
						slug: "git-project",
						title: "Git",
						folders: [gitProject],
					},
					{
						slug: "plain-project",
						title: "Plain",
						folders: [plainProject],
					},
				]),
			),
		);
	});
	it.effect("reads settled and pinned state from a cold project store", () => {
		const root = makeTemporaryRoot();
		const project = join(root, "project");
		mkdirSync(project);
		makeProjectStore(project, [
			{
				id: "finished-away",
				title: "Finished away",
				updatedAt: 300,
				lastMessageAt: 300,
				settledAt: 0,
				pinnedAt: 456,
			},
			{
				id: "already-read",
				title: "Already read",
				updatedAt: 200,
				lastMessageAt: 200,
			},
			{
				id: "empty",
				title: "Empty",
				updatedAt: 100,
				lastMessageAt: null,
			},
		]);

		return Effect.gen(function* () {
			const result = yield* listDaemonSessions(root);
			const sessions = new Map(
				result.sessions.map((session) => [session.id, session]),
			);

			expect(sessions.get("finished-away")).toMatchObject({
				settledAt: 0,
				pinnedAt: 456,
			});
			expect(sessions.get("empty")).not.toHaveProperty("settledAt");
			expect(sessions.get("empty")).not.toHaveProperty("pinnedAt");
			expect(result.hasMore).toBe(false);
			expect(result.nextCursor).toBeNull();
		}).pipe(
			Effect.provide(
				makeProjectRegistryLive([
					{
						slug: "project",
						title: "Project",
						folders: [project],
					},
				]),
			),
		);
	});

	it.effect("derives snooze and wake state from a cold project store", () => {
		const root = makeTemporaryRoot();
		const project = join(root, "project");
		mkdirSync(project);
		makeProjectStore(project, [
			{
				id: "sleeping",
				title: "Sleeping",
				updatedAt: 300,
				snoozedAt: 100,
				snoozedUntil: Date.now() + 60_000,
			},
			{
				id: "woken",
				title: "Woken",
				updatedAt: 200,
				snoozedAt: 100,
				wokenAt: 150,
				wokenReason: "approval",
				lastTurnEndVersion: 5,
				seenVersion: 4,
			},
			{
				id: "read",
				title: "Read",
				updatedAt: 100,
				snoozedAt: 10,
				wokenAt: 50,
				wokenReason: "turn",
				lastTurnEndVersion: 5,
				seenVersion: 5,
			},
		]);
		return Effect.gen(function* () {
			const result = yield* listDaemonSessions(root);
			const sessions = new Map(
				result.sessions.map((session) => [session.id, session]),
			);
			expect(sessions.get("sleeping")).toMatchObject({
				snoozedAt: 100,
				snoozedUntil: expect.any(Number),
			});
			expect(sessions.get("woken")).toMatchObject({
				wokenAt: 150,
				wokeBecause: "approval",
			});
			// Seen or not, a wake shows until opening the session unsnoozes it
			// (conduit-test-hk9m.9).
			expect(sessions.get("read")).toMatchObject({
				wokenAt: 50,
				wokeBecause: "turn",
			});
		}).pipe(
			Effect.provide(
				makeProjectRegistryLive([
					{
						slug: "project",
						title: "Project",
						folders: [project],
					},
				]),
			),
		);
	});

	// Unread is a turn end past the seen marker (ADR-0004, Scope;
	// conduit-test-hk9m.3), not a message newer than read_at.
	it.effect("reads unread state from a cold project store", () => {
		const root = makeTemporaryRoot();
		const project = join(root, "project");
		mkdirSync(project);
		makeProjectStore(project, [
			{
				id: "finished-away",
				title: "Finished away",
				updatedAt: 300,
				lastTurnEndVersion: 5,
				seenVersion: 2,
			},
			{
				id: "already-read",
				title: "Already read",
				updatedAt: 200,
				lastTurnEndVersion: 5,
				seenVersion: 5,
			},
			{
				id: "empty",
				title: "Empty",
				updatedAt: 100,
				lastTurnEndVersion: null,
				seenVersion: null,
			},
		]);

		return Effect.gen(function* () {
			const result = yield* listDaemonSessions(root);
			const sessions = new Map(
				result.sessions.map((session) => [session.id, session]),
			);

			expect(sessions.get("finished-away")?.unread).toBe(true);
			expect(sessions.get("already-read")).not.toHaveProperty("unread");
			expect(sessions.get("empty")).not.toHaveProperty("unread");
			expect(result.hasMore).toBe(false);
			expect(result.nextCursor).toBeNull();
		}).pipe(
			Effect.provide(
				makeProjectRegistryLive([
					{
						slug: "project",
						title: "Project",
						folders: [project],
					},
				]),
			),
		);
	});

	// A page reads only its own rows' families, so a root must still roll up
	// work and questions from descendants that are not on the page.
	it.effect("rolls each paged root's descendants up into it", () => {
		const root = makeTemporaryRoot();
		const project = join(root, "project");
		mkdirSync(project);
		makeProjectStore(
			project,
			[
				{ id: "root-a", title: "A", updatedAt: 300 },
				{ id: "child-a", title: "A1", updatedAt: 50, parentId: "root-a" },
				{
					id: "grandchild-a",
					title: "A2",
					updatedAt: 40,
					parentId: "child-a",
					status: "busy",
				},
				{ id: "root-b", title: "B", updatedAt: 200 },
				{ id: "root-c", title: "C", updatedAt: 100 },
				{
					id: "child-c",
					title: "C1",
					updatedAt: 30,
					parentId: "root-c",
					status: "busy",
				},
			],
			[{ id: "q1", sessionId: "child-a", type: "question", status: "pending" }],
		);
		const registry = makeProjectRegistryLive([
			{ slug: "project", title: "Project", folders: [project] },
		]);

		return Effect.gen(function* () {
			const first = yield* listDaemonSessions(root, { roots: true, limit: 1 });
			expect(first.sessions).toEqual([
				expect.objectContaining({
					id: "root-a",
					processing: true,
					pendingQuestionCount: 1,
				}),
			]);
			const rest = yield* listDaemonSessions(root, {
				roots: true,
				...(first.nextCursor ? { cursor: first.nextCursor } : {}),
			});
			const [rootB, rootC] = rest.sessions;
			expect(rootB?.id).toBe("root-b");
			expect(rootB).not.toHaveProperty("processing");
			expect(rootC).toMatchObject({ id: "root-c", processing: true });
		}).pipe(Effect.provide(registry));
	});

	it.effect("reads pending attention counts from a cold project store", () => {
		const root = makeTemporaryRoot();
		const project = join(root, "project");
		mkdirSync(project);
		makeProjectStore(
			project,
			[
				{ id: "question", title: "Question", updatedAt: 400 },
				{ id: "permission", title: "Permission", updatedAt: 300 },
				{ id: "resolved", title: "Resolved", updatedAt: 200 },
				{ id: "none", title: "None", updatedAt: 100 },
			],
			[
				{
					id: "q1",
					sessionId: "question",
					type: "question",
					status: "pending",
				},
				{
					id: "q2",
					sessionId: "question",
					type: "question",
					status: "pending",
				},
				{
					id: "p1",
					sessionId: "permission",
					type: "permission",
					status: "pending",
				},
				{
					id: "resolved-1",
					sessionId: "resolved",
					type: "question",
					status: "resolved",
				},
			],
		);

		return Effect.gen(function* () {
			const result = yield* listDaemonSessions(root);
			const sessions = new Map(
				result.sessions.map((session) => [session.id, session]),
			);

			expect(sessions.get("question")).toMatchObject({
				pendingQuestionCount: 2,
			});
			expect(sessions.get("permission")).toMatchObject({
				pendingPermissionCount: 1,
			});
			// The two counts come out of one query and are fanned into two maps, so
			// the failure to watch for is a permission landing on the question count.
			expect(sessions.get("question")).not.toHaveProperty(
				"pendingPermissionCount",
			);
			expect(sessions.get("permission")).not.toHaveProperty(
				"pendingQuestionCount",
			);
			expect(sessions.get("resolved")).not.toHaveProperty(
				"pendingQuestionCount",
			);
			expect(sessions.get("resolved")).not.toHaveProperty(
				"pendingPermissionCount",
			);
			expect(sessions.get("none")).not.toHaveProperty("pendingQuestionCount");
			expect(sessions.get("none")).not.toHaveProperty("pendingPermissionCount");
			expect(result.hasMore).toBe(false);
			expect(result.nextCursor).toBeNull();
		}).pipe(
			Effect.provide(
				makeProjectRegistryLive([
					{
						slug: "project",
						title: "Project",
						folders: [project],
					},
				]),
			),
		);
	});

	it.effect(
		"merges real project stores without failing on unavailable or empty projects",
		() => {
			const root = makeTemporaryRoot();
			const projectA = join(root, "project-a");
			const projectB = join(root, "project-b");
			const noStore = join(root, "no-store");
			const unreadableStore = join(root, "unreadable-store");
			const missing = join(root, "missing");
			mkdirSync(projectA);
			mkdirSync(projectB);
			mkdirSync(noStore);
			mkdirSync(unreadableStore, { recursive: true });
			mkdirSync(projectStorageDir(root, "unreadable-store"), {
				recursive: true,
			});
			writeFileSync(
				join(projectStorageDir(root, "unreadable-store"), "events.db"),
				"not a sqlite database",
			);

			makeProjectStore(projectA, [
				{ id: "a-new", title: "A new", updatedAt: 300 },
				{
					id: "a-child",
					title: "A child",
					updatedAt: 400,
					parentId: "a-new",
				},
				{ id: "a-old", title: "A old", updatedAt: 100 },
			]);
			makeProjectStore(projectB, [
				{ id: "b-mid", title: "B mid", updatedAt: 200 },
			]);

			return Effect.gen(function* () {
				const result = yield* listDaemonSessions(root, {
					limit: 2,
					roots: true,
				});

				expect(result.sessions).toEqual([
					{
						id: "a-new",
						title: "A new",
						status: "idle",
						createdAt: 300,
						updatedAt: 300,
						messageCount: 0,
						projectSlug: "project-a",
						attention: "idle",
						limitRecovery: null,
						resumes: [],
					},
					{
						id: "b-mid",
						title: "B mid",
						status: "idle",
						createdAt: 200,
						updatedAt: 200,
						messageCount: 0,
						projectSlug: "project-b",
						attention: "idle",
						limitRecovery: null,
						resumes: [],
					},
				]);
				expect(result.availability).toEqual(
					expect.arrayContaining([
						{ projectSlug: "project-a", available: true },
						{ projectSlug: "project-b", available: true },
						{ projectSlug: "no-store", available: true },
						expect.objectContaining({
							projectSlug: "unreadable-store",
							available: false,
							error: expect.any(String),
						}),
						expect.objectContaining({
							projectSlug: "missing",
							available: false,
							error: expect.any(String),
						}),
					]),
				);
				expect(result.hasMore).toBe(true);
				expect(result.nextCursor).toEqual({ updatedAt: 200, id: "b-mid" });
			}).pipe(
				Effect.provide(
					makeProjectRegistryLive([
						{
							slug: "project-a",
							title: "Project A",
							folders: [projectA],
						},
						{
							slug: "project-b",
							title: "Project B",
							folders: [projectB],
						},
						{
							slug: "no-store",
							title: "No store",
							folders: [noStore],
						},
						{
							slug: "unreadable-store",
							title: "Unreadable store",
							folders: [unreadableStore],
						},
						{
							slug: "missing",
							title: "Missing",
							folders: [missing],
						},
					]),
				),
			);
		},
	);

	it.effect("pages the globally ordered set without duplicates or gaps", () => {
		const root = makeTemporaryRoot();
		const projectA = join(root, "project-a");
		const projectB = join(root, "project-b");
		const projectC = join(root, "project-c");
		mkdirSync(projectA);
		mkdirSync(projectB);
		mkdirSync(projectC);
		makeProjectStore(projectA, [
			{ id: "shared-z", title: "Shared Z", updatedAt: 600 },
			{ id: "a-500", title: "A 500", updatedAt: 500 },
			{ id: "a-200", title: "A 200", updatedAt: 200 },
		]);
		makeProjectStore(projectB, [
			{ id: "shared-y", title: "Shared Y", updatedAt: 600 },
			{ id: "b-400", title: "B 400", updatedAt: 400 },
		]);
		makeProjectStore(projectC, [
			{ id: "shared-x", title: "Shared X", updatedAt: 600 },
			{ id: "c-300", title: "C 300", updatedAt: 300 },
		]);
		const registry = makeProjectRegistryLive([
			{
				slug: "project-a",
				title: "project-a",
				folders: [projectA],
			},
			{
				slug: "project-b",
				title: "project-b",
				folders: [projectB],
			},
			{
				slug: "project-c",
				title: "project-c",
				folders: [projectC],
			},
		]);
		const expected = [
			"shared-z",
			"shared-y",
			"shared-x",
			"a-500",
			"b-400",
			"c-300",
			"a-200",
		];

		return Effect.gen(function* () {
			const unbounded = yield* listDaemonSessions(root);
			expect(unbounded.sessions.map((session) => session.id)).toEqual(expected);
			expect(unbounded.hasMore).toBe(false);
			expect(unbounded.nextCursor).toBeNull();

			const first = yield* listDaemonSessions(root, { limit: 2 });
			expect(first.sessions.map((session) => session.id)).toEqual(
				expected.slice(0, 2),
			);
			expect(first.hasMore).toBe(true);
			expect(first.nextCursor).toEqual({
				updatedAt: 600,
				id: "shared-y",
			});

			const collected: string[] = [];
			let cursor: { updatedAt: number; id: string } | undefined;
			let finalCursor: { updatedAt: number; id: string } | undefined;
			for (;;) {
				const page = yield* listDaemonSessions(root, {
					limit: 2,
					...(cursor === undefined ? {} : { cursor }),
				});
				collected.push(...page.sessions.map((session) => session.id));
				if (!page.hasMore) {
					expect(page.nextCursor).toBeNull();
					const last = page.sessions.at(-1);
					if (last !== undefined) {
						finalCursor = {
							updatedAt: Number(last.updatedAt),
							id: last.id,
						};
					}
					break;
				}
				expect(page.nextCursor).not.toBeNull();
				cursor = page.nextCursor ?? undefined;
			}

			expect(collected).toEqual(expected);
			expect(new Set(collected).size).toBe(expected.length);
			expect(finalCursor).toBeDefined();
			if (finalCursor === undefined) return;
			const pastEnd = yield* listDaemonSessions(root, {
				limit: 2,
				cursor: finalCursor,
			});
			expect(pastEnd.sessions).toEqual([]);
			expect(pastEnd.hasMore).toBe(false);
			expect(pastEnd.nextCursor).toBeNull();
		}).pipe(Effect.provide(registry));
	});

	it.effect("detects more rows at a single-project page boundary", () => {
		const root = makeTemporaryRoot();
		const project = join(root, "project");
		mkdirSync(project);
		makeProjectStore(project, [
			{ id: "five", title: "Five", updatedAt: 500 },
			{ id: "four", title: "Four", updatedAt: 400 },
			{ id: "three", title: "Three", updatedAt: 300 },
			{ id: "two", title: "Two", updatedAt: 200 },
			{ id: "one", title: "One", updatedAt: 100 },
		]);
		const registry = makeProjectRegistryLive([
			{
				slug: "project",
				title: "Project",
				folders: [project],
			},
		]);

		return Effect.gen(function* () {
			const first = yield* listDaemonSessions(root, { limit: 2 });
			expect(first.sessions.map((session) => session.id)).toEqual([
				"five",
				"four",
			]);
			expect(first.hasMore).toBe(true);
			expect(first.nextCursor).toEqual({ updatedAt: 400, id: "four" });
			if (first.nextCursor === null) return;

			const second = yield* listDaemonSessions(root, {
				limit: 2,
				cursor: first.nextCursor,
			});
			expect(second.sessions.map((session) => session.id)).toEqual([
				"three",
				"two",
			]);
			expect(second.hasMore).toBe(true);
			expect(second.nextCursor).toEqual({ updatedAt: 200, id: "two" });
			if (second.nextCursor === null) return;

			const final = yield* listDaemonSessions(root, {
				limit: 2,
				cursor: second.nextCursor,
			});
			expect(final.sessions.map((session) => session.id)).toEqual(["one"]);
			expect(final.hasMore).toBe(false);
			expect(final.nextCursor).toBeNull();
		}).pipe(Effect.provide(registry));
	});

	it.effect("searches every project and pages only the filtered set", () => {
		const root = makeTemporaryRoot();
		const projectA = join(root, "project-a");
		const projectB = join(root, "project-b");
		const projectC = join(root, "project-c");
		mkdirSync(projectA);
		mkdirSync(projectB);
		mkdirSync(projectC);
		makeProjectStore(projectA, [
			{ id: "a-needle-new", title: "Needle alpha", updatedAt: 600 },
			{ id: "a-needle-old", title: "needle delta", updatedAt: 300 },
			{ id: "a-other", title: "Other", updatedAt: 700 },
		]);
		makeProjectStore(projectB, [
			{ id: "b-needle-new", title: "NEEDLE beta", updatedAt: 500 },
			{ id: "b-needle-old", title: "needle epsilon", updatedAt: 200 },
		]);
		makeProjectStore(projectC, [
			{ id: "c-needle-new", title: "needle gamma", updatedAt: 400 },
			{ id: "c-needle-old", title: "Needle zeta", updatedAt: 100 },
			{ id: "c-other", title: "Not relevant", updatedAt: 800 },
		]);
		const registry = makeProjectRegistryLive([
			{
				slug: "project-a",
				title: "project-a",
				folders: [projectA],
			},
			{
				slug: "project-b",
				title: "project-b",
				folders: [projectB],
			},
			{
				slug: "project-c",
				title: "project-c",
				folders: [projectC],
			},
		]);
		const expected = [
			"a-needle-new",
			"b-needle-new",
			"c-needle-new",
			"a-needle-old",
			"b-needle-old",
			"c-needle-old",
		];

		return Effect.gen(function* () {
			const allMatches = yield* listDaemonSessions(root, { search: "nEeDlE" });
			expect(allMatches.sessions.map((session) => session.id)).toEqual(
				expected,
			);
			expect(allMatches.hasMore).toBe(false);
			expect(allMatches.nextCursor).toBeNull();

			const paged: string[] = [];
			let cursor: { updatedAt: number; id: string } | undefined;
			for (;;) {
				const page = yield* listDaemonSessions(root, {
					search: "needle",
					limit: 2,
					...(cursor === undefined ? {} : { cursor }),
				});
				paged.push(...page.sessions.map((session) => session.id));
				if (!page.hasMore) break;
				cursor = page.nextCursor ?? undefined;
			}
			expect(paged).toEqual(expected);
		}).pipe(Effect.provide(registry));
	});

	it.effect("scopes the read to one project, with search and paging", () => {
		const root = makeTemporaryRoot();
		const projectA = join(root, "project-a");
		const projectB = join(root, "project-b");
		mkdirSync(projectA);
		mkdirSync(projectB);
		makeProjectStore(projectA, [
			{ id: "a-needle", title: "Needle", updatedAt: 300 },
			{ id: "a-other", title: "Other", updatedAt: 100 },
		]);
		makeProjectStore(projectB, [
			{ id: "b-needle-new", title: "Needle new", updatedAt: 400 },
			{ id: "b-other", title: "Other", updatedAt: 250 },
			{ id: "b-needle-old", title: "needle old", updatedAt: 200 },
		]);
		const registry = makeProjectRegistryLive([
			{
				slug: "project-a",
				title: "project-a",
				folders: [projectA],
			},
			{
				slug: "project-b",
				title: "project-b",
				folders: [projectB],
			},
		]);

		return Effect.gen(function* () {
			const firstPage = yield* listDaemonSessions(root, {
				scope: "project-b",
				limit: 2,
			});
			expect(firstPage.sessions.map((session) => session.id)).toEqual([
				"b-needle-new",
				"b-other",
			]);
			expect(firstPage.hasMore).toBe(true);
			expect(firstPage.availability.map((entry) => entry.projectSlug)).toEqual([
				"project-b",
			]);

			const secondPage = yield* listDaemonSessions(root, {
				scope: "project-b",
				limit: 2,
				...(firstPage.nextCursor === null
					? {}
					: { cursor: firstPage.nextCursor }),
			});
			expect(secondPage.sessions.map((session) => session.id)).toEqual([
				"b-needle-old",
			]);
			expect(secondPage.hasMore).toBe(false);

			const scopedSearch = yield* listDaemonSessions(root, {
				scope: "project-a",
				search: "needle",
			});
			expect(scopedSearch.sessions.map((session) => session.id)).toEqual([
				"a-needle",
			]);
		}).pipe(Effect.provide(registry));
	});

	it.effect("treats percent and underscore in search as literals", () => {
		const root = makeTemporaryRoot();
		const projectA = join(root, "project-a");
		const projectB = join(root, "project-b");
		const projectC = join(root, "project-c");
		mkdirSync(projectA);
		mkdirSync(projectB);
		mkdirSync(projectC);
		makeProjectStore(projectA, [
			{ id: "literal-a", title: "Costs 100%_done", updatedAt: 300 },
		]);
		makeProjectStore(projectB, [
			{ id: "literal-b", title: "Keep %_ literal", updatedAt: 200 },
		]);
		makeProjectStore(projectC, [
			{ id: "decoy", title: "Costs 100XYdone", updatedAt: 100 },
		]);

		return Effect.gen(function* () {
			const result = yield* listDaemonSessions(root, { search: "%_" });
			expect(result.sessions.map((session) => session.id)).toEqual([
				"literal-a",
				"literal-b",
			]);
		}).pipe(
			Effect.provide(
				makeProjectRegistryLive([
					{
						slug: "project-a",
						title: "A",
						folders: [projectA],
					},
					{
						slug: "project-b",
						title: "B",
						folders: [projectB],
					},
					{
						slug: "project-c",
						title: "C",
						folders: [projectC],
					},
				]),
			),
		);
	});

	it.effect(
		"keeps unavailable projects visible while paging available ones",
		() => {
			const root = makeTemporaryRoot();
			const projectA = join(root, "project-a");
			const projectB = join(root, "project-b");
			const unavailable = join(root, "unavailable");
			mkdirSync(projectA);
			mkdirSync(projectB);
			mkdirSync(unavailable, { recursive: true });
			mkdirSync(projectStorageDir(root, "unavailable"), { recursive: true });
			writeFileSync(
				join(projectStorageDir(root, "unavailable"), "events.db"),
				"not sqlite",
			);
			makeProjectStore(projectA, [
				{ id: "a-new", title: "A new", updatedAt: 300 },
				{ id: "a-old", title: "A old", updatedAt: 100 },
			]);
			makeProjectStore(projectB, [
				{ id: "b-mid", title: "B mid", updatedAt: 200 },
			]);

			return Effect.gen(function* () {
				const result = yield* listDaemonSessions(root, { limit: 1 });
				expect(result.sessions.map((session) => session.id)).toEqual(["a-new"]);
				expect(result.hasMore).toBe(true);
				expect(result.availability).toEqual(
					expect.arrayContaining([
						{ projectSlug: "project-a", available: true },
						{ projectSlug: "project-b", available: true },
						expect.objectContaining({
							projectSlug: "unavailable",
							available: false,
						}),
					]),
				);
			}).pipe(
				Effect.provide(
					makeProjectRegistryLive([
						{
							slug: "project-a",
							title: "A",
							folders: [projectA],
						},
						{
							slug: "project-b",
							title: "B",
							folders: [projectB],
						},
						{
							slug: "unavailable",
							title: "Unavailable",
							folders: [unavailable],
						},
					]),
				),
			);
		},
	);
});

describe("ResolveSession", () => {
	it.scoped(
		"finds sessions in cold project stores and returns null for unknown IDs",
		() => {
			const root = makeTemporaryRoot();
			const projects = ["project-a", "project-b"].map((slug) => ({
				slug,
				title: slug,
				folders: [join(root, slug)] as const,
			}));
			for (const project of projects) {
				makeProjectStore(project.folders[0], [
					{ id: `${project.slug}-session`, title: "Session", updatedAt: 1 },
				]);
			}
			return Effect.gen(function* () {
				const handlers = yield* DaemonWsRpcHandlersTag;
				const client = yield* RpcTest.makeClient(WsRpcGroup).pipe(
					Effect.provide(
						makeRoutedWsRpcServerLayer(
							() => Effect.die("Must not resolve a relay"),
							handlers,
						),
					),
				);
				for (const project of projects) {
					expect(
						yield* client.ResolveSession({
							sessionId: `${project.slug}-session`,
						}),
					).toEqual({ projectSlug: project.slug });
				}
				expect(
					yield* client.ResolveSession({
						projectSlug: "nonexistent",
						sessionId: "project-b-session",
					}),
				).toEqual({ projectSlug: "project-b" });
				expect(yield* client.ResolveSession({ sessionId: "unknown" })).toEqual({
					projectSlug: null,
				});
			}).pipe(
				Effect.provide(
					makeDaemonRpcTestLayer(projects, undefined, { configDir: root }),
				),
			);
		},
	);
});
