import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import { serializeRecent } from "../../../src/lib/daemon/recent-projects.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { subscribeShell } from "../../../src/lib/domain/relay/Services/shell-subscription.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { migrateForkLineage } from "../../../src/lib/persistence/migrations/0017_fork_lineage.js";

it("imports all known projects before deleting the sidecar, without appending history", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fork-migration-"));
	const projects = [join(dir, "a"), join(dir, "b")];
	const sidecar = join(dir, "fork-metadata.json");
	try {
		writeFileSync(
			join(dir, "recent.json"),
			serializeRecent(
				projects.map((directory, i) => ({
					directory,
					slug: String(i),
					lastUsed: 1,
				})),
			),
		);
		writeFileSync(
			sidecar,
			JSON.stringify({
				"child-0": {
					parentID: "parent-0",
					forkMessageId: "message-0",
					forkPointTimestamp: 100,
				},
				"child-1": { parentID: "parent-1", forkMessageId: "message-1" },
			}),
		);
		for (const [i, project] of projects.entries()) {
			mkdirSync(join(project, ".conduit"), { recursive: true });
			await Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					for (const id of [`parent-${i}`, `child-${i}`]) {
						yield* sql`INSERT INTO sessions (id, provider, title, created_at, updated_at) VALUES (${id}, 'claude', 'Kept', 100, 100)`;
					}
					yield* sql`INSERT INTO messages (id, session_id, role, text, created_at, updated_at)
						VALUES (${`message-${i}`}, ${`parent-${i}`}, 'assistant', 'answer', 100, 100)`;
				}).pipe(
					Effect.provide(
						makePersistenceEffectLayer(join(project, ".conduit/events.db")),
					),
				),
			);
		}
		await Effect.runPromise(migrateForkLineage(dir));
		for (const [i, project] of projects.entries()) {
			await Effect.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const envelope = yield* Stream.runHead(subscribeShell({}));
					expect(envelope._tag).toBe("Some");
					if (envelope._tag !== "Some" || envelope.value._tag !== "snapshot")
						throw new Error("expected snapshot");
					expect(envelope.value.rows).toContainEqual(
						expect.objectContaining({
							id: `child-${i}`,
							parentID: `parent-${i}`,
							forkMessageId: `message-${i}`,
							forkPointTimestamp: 100,
							forkPointMessageId: `message-${i}`,
						}),
					);
					expect(yield* sql`SELECT count(*) AS count FROM events`).toEqual([
						{ count: 0 },
					]);
				}).pipe(
					Effect.provide(
						Layer.merge(
							makePersistenceEffectLayer(join(project, ".conduit/events.db")),
							SessionEventBusLive,
						),
					),
				),
			);
		}
		expect(existsSync(sidecar)).toBe(false);
		await Effect.runPromise(migrateForkLineage(dir));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const kind of [
	"missing",
	"unreadable",
	"malformed",
	"invalid entry",
] as const) {
	it(`startup survives a ${kind} sidecar without discarding its contents`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "fork-migration-invalid-"));
		const path = join(dir, "fork-metadata.json");
		const contents =
			kind === "malformed"
				? "{"
				: kind === "invalid entry"
					? JSON.stringify({ child: { parentID: 1, forkMessageId: "point" } })
					: JSON.stringify({
							child: { parentID: "parent", forkMessageId: "point" },
						});
		try {
			if (kind === "unreadable") mkdirSync(path);
			else if (kind !== "missing") writeFileSync(path, contents);
			await Effect.runPromise(migrateForkLineage(dir));
			expect(existsSync(path)).toBe(kind !== "missing");
			if (kind !== "missing" && kind !== "unreadable")
				expect(readFileSync(path, "utf8")).toBe(contents);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

it("retrying an incomplete import does not advance an already imported session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fork-migration-retry-"));
	const project = join(dir, "project");
	const filename = join(project, ".conduit", "events.db");
	try {
		mkdirSync(join(project, ".conduit"), { recursive: true });
		writeFileSync(
			join(dir, "recent.json"),
			serializeRecent([
				{ directory: project, slug: "project", lastUsed: 1 },
				{ directory: join(dir, "broken"), slug: "broken", lastUsed: 1 },
			]),
		);
		mkdirSync(join(dir, "broken", ".conduit"), { recursive: true });
		writeFileSync(
			join(dir, "broken", ".conduit", "events.db"),
			"not a database",
		);
		writeFileSync(
			join(dir, "fork-metadata.json"),
			JSON.stringify({
				child: { parentID: "parent", forkMessageId: "message" },
				unavailable: { parentID: "other", forkMessageId: "other-message" },
			}),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, provider, created_at, updated_at) VALUES ('parent', 'claude', 1, 1), ('child', 'claude', 1, 1)`;
			}).pipe(Effect.provide(makePersistenceEffectLayer(filename))),
		);
		await Effect.runPromise(migrateForkLineage(dir));
		const snapshot = () =>
			Effect.runPromise(
				Stream.runHead(subscribeShell({})).pipe(
					Effect.provide(
						Layer.merge(
							makePersistenceEffectLayer(filename),
							SessionEventBusLive,
						),
					),
				),
			);
		const first = await snapshot();
		await Effect.runPromise(migrateForkLineage(dir));
		expect(await snapshot()).toEqual(first);
		expect(existsSync(join(dir, "fork-metadata.json"))).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("retires unmatched lineage to an unread archive instead of keeping the active sidecar", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fork-migration-unmatched-"));
	const path = join(dir, "fork-metadata.json");
	const contents = { gone: { parentID: "parent", forkMessageId: "message" } };
	try {
		writeFileSync(path, JSON.stringify(contents));
		await Effect.runPromise(migrateForkLineage(dir));
		expect(existsSync(path)).toBe(false);
		expect(
			JSON.parse(
				readFileSync(join(dir, "fork-metadata-0016-unresolved.json"), "utf8"),
			),
		).toEqual(contents);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
