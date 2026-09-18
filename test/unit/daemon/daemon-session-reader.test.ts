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
	}>,
): void => {
	const conduitDirectory = join(projectDirectory, ".conduit");
	mkdirSync(conduitDirectory, { recursive: true });
	const database = SqliteClient.open(join(conduitDirectory, "events.db"));
	try {
		runMigrations(database, schemaMigrations);
		for (const session of sessions) {
			database.execute(
				`INSERT INTO sessions (
					id, provider, title, status, parent_id, created_at, updated_at
				) VALUES (?, 'opencode', ?, 'idle', ?, ?, ?)`,
				[
					session.id,
					session.title,
					session.parentId ?? null,
					session.updatedAt,
					session.updatedAt,
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
