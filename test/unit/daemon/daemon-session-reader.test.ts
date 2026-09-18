import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, describe, expect } from "vitest";
import { listDaemonSessions } from "../../../src/lib/domain/daemon/Services/daemon-session-reader.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

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
		readonly lastMessageAt?: number | null;
		readonly readAt?: number | null;
	}>,
	pendingApprovals: ReadonlyArray<{
		readonly id: string;
		readonly sessionId: string;
		readonly type: "permission" | "question";
		readonly status: "pending" | "resolved";
	}> = [],
): void => {
	const conduitDirectory = join(projectDirectory, ".conduit");
	mkdirSync(conduitDirectory, { recursive: true });
	const database = SqliteClient.open(join(conduitDirectory, "events.db"));
	try {
		runMigrations(database, schemaMigrations);
		for (const session of sessions) {
			database.execute(
				`INSERT INTO sessions (
					id, provider, title, status, parent_id, last_message_at,
					read_at, created_at, updated_at
				) VALUES (?, 'opencode', ?, 'idle', ?, ?, ?, ?, ?)`,
				[
					session.id,
					session.title,
					session.parentId ?? null,
					session.lastMessageAt ?? null,
					session.readAt ?? null,
					session.updatedAt,
					session.updatedAt,
				],
			);
		}
		for (const approval of pendingApprovals) {
			database.execute(
				`INSERT INTO pending_approvals (
					id, session_id, type, status, created_at
				) VALUES (?, ?, ?, ?, ?)`,
				[
					approval.id,
					approval.sessionId,
					approval.type,
					approval.status,
					Date.now(),
				],
			);
		}
	} finally {
		database.close();
	}
};

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("listDaemonSessions", () => {
	it.effect("reads unread state from a cold project store", () => {
		const root = makeTemporaryRoot();
		const project = join(root, "project");
		mkdirSync(project);
		makeProjectStore(project, [
			{
				id: "finished-away",
				title: "Finished away",
				updatedAt: 300,
				lastMessageAt: 300,
				readAt: 200,
			},
			{
				id: "already-read",
				title: "Already read",
				updatedAt: 200,
				lastMessageAt: 200,
				readAt: 200,
			},
			{
				id: "empty",
				title: "Empty",
				updatedAt: 100,
				lastMessageAt: null,
				readAt: null,
			},
		]);

		return Effect.gen(function* () {
			const result = yield* listDaemonSessions();
			const sessions = new Map(
				result.sessions.map((session) => [session.id, session]),
			);

			expect(sessions.get("finished-away")?.unread).toBe(true);
			expect(sessions.get("already-read")).not.toHaveProperty("unread");
			expect(sessions.get("empty")).not.toHaveProperty("unread");
		}).pipe(
			Effect.provide(
				makeProjectRegistryLive([
					{
						slug: "project",
						title: "Project",
						directory: project,
					},
				]),
			),
		);
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
			const result = yield* listDaemonSessions();
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
		}).pipe(
			Effect.provide(
				makeProjectRegistryLive([
					{
						slug: "project",
						title: "Project",
						directory: project,
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
			mkdirSync(join(unreadableStore, ".conduit"), { recursive: true });
			writeFileSync(
				join(unreadableStore, ".conduit", "events.db"),
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
				const result = yield* listDaemonSessions({ limit: 2, roots: true });

				expect(result.sessions).toEqual([
					{
						id: "a-new",
						title: "A new",
						updatedAt: 300,
						messageCount: 0,
						projectSlug: "project-a",
					},
					{
						id: "b-mid",
						title: "B mid",
						updatedAt: 200,
						messageCount: 0,
						projectSlug: "project-b",
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
			}).pipe(
				Effect.provide(
					makeProjectRegistryLive([
						{ slug: "project-a", title: "Project A", directory: projectA },
						{ slug: "project-b", title: "Project B", directory: projectB },
						{ slug: "no-store", title: "No store", directory: noStore },
						{
							slug: "unreadable-store",
							title: "Unreadable store",
							directory: unreadableStore,
						},
						{ slug: "missing", title: "Missing", directory: missing },
					]),
				),
			);
		},
	);
});
