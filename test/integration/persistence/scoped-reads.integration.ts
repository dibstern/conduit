// Shared-store failure modes: a list or its checksum leaks another project;
// unrelated advances cause a scoped refresh; tombstones lose their owner;
// a session-keyed read changes under Scope; replay loses provenance; opening
// legacy history leaves its projected rows outside every Scope.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import Database from "better-sqlite3";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/sql";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFailed,
} from "vitest";
import { advanceTouchesScope } from "../../../src/lib/contracts/read-model-advance.js";
import { markUnread } from "../../../src/lib/domain/relay/Services/session-attention.js";
import {
	makeSessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectRuntime,
} from "../../../src/lib/persistence/effect/live.js";
import {
	effectMigrationEntries,
	makeEffectSqlMigrator,
} from "../../../src/lib/persistence/effect/migrations.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	ReadQueryEffectTag,
	type SessionScope,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import { EffectSessionSeeder } from "../../../src/lib/persistence/effect/session-seeder-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";

const scopes = {
	A: { projectIds: ["alpha"] },
	B: { projectIds: ["beta"] },
	group: { projectIds: ["alpha", "beta"] },
} as const satisfies Record<string, SessionScope>;
type ScopeName = keyof typeof scopes;
const titles = new Map([
	["ses_alpha", "Alpha"],
	["ses_alpha_child", "Alpha child"],
	["ses_beta", "Beta"],
	["ses_beta_child", "Beta child"],
	["ses_legacy", "Legacy"],
	["ses_seed_alpha", "Seeded Alpha"],
	["ses_seed_beta", "Seeded Beta"],
]);
const evidence: {
	read: string;
	scope: string;
	titles: string[];
	pass: boolean;
}[] = [];
const directories: string[] = [];
let testFailed = false;

function writeEvidence() {
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/82tn3-scoped-reads.json",
		`${JSON.stringify(
			{
				checks: [...evidence].sort((a, b) =>
					`${a.read}:${a.scope}`.localeCompare(`${b.read}:${b.scope}`),
				),
				pass:
					!testFailed &&
					evidence.length > 0 &&
					evidence.every((check) => check.pass),
			},
			null,
			2,
		)}\n`,
	);
}

beforeEach(() => {
	onTestFailed(() => {
		testFailed = true;
		writeEvidence();
	});
});

afterEach(() => {
	writeEvidence();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function filename() {
	const directory = mkdtempSync(join(tmpdir(), "conduit-scoped-reads-"));
	directories.push(directory);
	return join(directory, "events.db");
}

function record(
	read: string,
	scope: string,
	ids: readonly string[],
	expected: string[],
) {
	const actual = ids.map((id) => titles.get(id) ?? "unknown session").sort();
	evidence.push({
		read,
		scope,
		titles: actual,
		pass: JSON.stringify(actual) === JSON.stringify([...expected].sort()),
	});
	expect.soft(actual, `${read} in ${scope}`).toEqual([...expected].sort());
}

function history(project: "alpha" | "beta") {
	const id = `ses_${project}`;
	const child = `${id}_child`;
	const messageId = `${id}_message`;
	const options = { provider: "claude", createdAt: 1000 };
	return [
		canonicalEvent(
			"session.created",
			id,
			{
				sessionId: id,
				title: project === "alpha" ? "Alpha" : "Beta",
				provider: "claude",
			},
			options,
		),
		canonicalEvent(
			"session.created",
			child,
			{
				sessionId: child,
				title: project === "alpha" ? "Alpha child" : "Beta child",
				provider: "claude",
				parentId: id,
			},
			options,
		),
		canonicalEvent(
			"message.created",
			id,
			{ sessionId: id, messageId, role: "assistant" },
			options,
		),
		canonicalEvent(
			"text.delta",
			id,
			{ messageId, partId: `${id}_text`, text: "Hello from history" },
			options,
		),
		canonicalEvent(
			"tool.started",
			id,
			{
				messageId,
				partId: `${id}_task`,
				callId: `${id}_task_call`,
				toolName: "Task",
				input: { tool: "Task", description: "Child work", prompt: "Continue" },
			},
			options,
		),
		canonicalEvent(
			"tool.running",
			id,
			{
				messageId,
				partId: `${id}_task`,
				metadata: {
					childSessionId: child,
					providerTaskId: `${id}_provider_task`,
				},
			},
			options,
		),
		canonicalEvent(
			"tool.started",
			id,
			{
				messageId,
				partId: `${id}_question`,
				callId: `${id}_question_call`,
				toolName: "AskUserQuestion",
				input: { tool: "AskUserQuestion", questions: [] },
			},
			options,
		),
		canonicalEvent(
			"permission.asked",
			id,
			{
				id: `${id}_permission`,
				sessionId: id,
				toolName: "Bash",
				input: { command: "pwd" },
			},
			options,
		),
		canonicalEvent(
			"session.status",
			child,
			{ sessionId: child, status: "busy" },
			options,
		),
	];
}

function commit(
	runtime: PersistenceEffectRuntime,
	events: readonly CanonicalEvent[],
) {
	return runtime.runPromise(
		Effect.gen(function* () {
			const write = yield* makeCommitAndSignal;
			yield* write(events);
		}),
	);
}

// Versions and projector sequence bookkeeping describe the store's position,
// not transcript content. All content, ordering and session facts must match.
function content(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(content);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(
					([key]) =>
						![
							"version",
							"last_applied_seq",
							"last_turn_end_version",
							"seen_version",
							"listing",
							"removedSince",
						].includes(key),
				)
				.map(([key, field]) => [key, content(field)]),
		);
	return value;
}

describe("Scope-filtered reads over one store-wide version space", () => {
	it("keeps sessions seeded before their creation event visible only in their project", async () => {
		const sharedFile = filename();
		const alpha = ManagedRuntime.make(
			makePersistenceEffectLayer(sharedFile, "alpha"),
		);
		const beta = ManagedRuntime.make(
			makePersistenceEffectLayer(sharedFile, "beta"),
		);
		try {
			// Open both layers first: a later open must not accidentally repair an
			// unstamped new row by treating it as legacy history.
			await alpha.runPromise(ReadQueryEffectTag);
			await beta.runPromise(ReadQueryEffectTag);
			for (const [project, runtime] of [
				["alpha", alpha],
				["beta", beta],
			] as const) {
				await runtime.runPromise(
					Effect.gen(function* () {
						const sessionId = `ses_seed_${project}`;
						yield* new EffectSessionSeeder().ensureSession(
							sessionId,
							"opencode",
						);
						const write = yield* makeCommitAndSignal;
						yield* write([
							canonicalEvent("session.renamed", sessionId, {
								sessionId,
								title: project === "alpha" ? "Seeded Alpha" : "Seeded Beta",
							}),
							canonicalEvent("message.created", sessionId, {
								sessionId,
								messageId: `${sessionId}_message`,
								role: "assistant",
							}),
						]);
					}),
				);
			}
			const read = await alpha.runPromise(ReadQueryEffectTag);
			for (const [name, scope] of Object.entries(scopes)) {
				record(
					"seeded sessions",
					name,
					(await alpha.runPromise(read.listSessions(scope))).map(
						(row) => row.id,
					),
					name === "A"
						? ["Seeded Alpha"]
						: name === "B"
							? ["Seeded Beta"]
							: ["Seeded Alpha", "Seeded Beta"],
				);
			}
		} finally {
			await Promise.all([alpha.dispose(), beta.dispose()]);
		}
	});

	it("isolates every list, checksum and tombstone while session history and replay stay global", async () => {
		const sharedFile = filename();
		const alpha = ManagedRuntime.make(
			makePersistenceEffectLayer(sharedFile, "alpha"),
		);
		const beta = ManagedRuntime.make(
			makePersistenceEffectLayer(sharedFile, "beta"),
		);
		const single = ManagedRuntime.make(
			makePersistenceEffectLayer(filename(), "alpha"),
		);
		const replayFile = filename();
		const replay = ManagedRuntime.make(
			makePersistenceEffectLayer(replayFile, "alpha"),
		);
		const replayBeta = ManagedRuntime.make(
			makePersistenceEffectLayer(replayFile, "beta"),
		);
		try {
			const alphaHistory = history("alpha");
			await commit(alpha, alphaHistory);
			await commit(beta, history("beta"));
			await commit(single, alphaHistory);
			const read = await alpha.runPromise(ReadQueryEffectTag);
			const listPendingClaudeQuestionTools =
				read.listPendingClaudeQuestionTools;
			if (listPendingClaudeQuestionTools === undefined)
				throw new Error(
					"The persistence read model must expose pending question tools",
				);
			for (const [name, scope] of Object.entries(scopes) as [
				ScopeName,
				SessionScope,
			][]) {
				const roots =
					name === "A"
						? ["Alpha"]
						: name === "B"
							? ["Beta"]
							: ["Alpha", "Beta"];
				const children = roots.map((title) => `${title} child`);
				const all = [...roots, ...children];
				const checks = [
					[
						"listSessions",
						read
							.listSessions(scope)
							.pipe(Effect.map((rows) => rows.map((row) => row.id))),
						all,
					],
					[
						"listSessionInfos",
						read
							.listSessionInfos(scope)
							.pipe(Effect.map((rows) => rows.map((row) => row.id))),
						all,
					],
					[
						"listSessionInfos title search",
						read
							.listSessionInfos(scope, { titleQuery: "child" })
							.pipe(Effect.map((rows) => rows.map((row) => row.id))),
						children,
					],
					[
						"getAllSessionStatuses",
						read.getAllSessionStatuses(scope).pipe(Effect.map(Object.keys)),
						all,
					],
					[
						"getAllSessionStatusesWithProviders",
						read
							.getAllSessionStatusesWithProviders(scope)
							.pipe(Effect.map((rows) => rows.map((row) => row.id))),
						all,
					],
					[
						"countPendingApprovalsBySession",
						read
							.countPendingApprovalsBySession(scope)
							.pipe(Effect.map((rows) => rows.map((row) => row.session_id))),
						roots,
					],
					[
						"readPendingApprovals",
						read
							.readPendingApprovals(scope)
							.pipe(
								Effect.map((result) =>
									result.rows.map((row) => row.session_id),
								),
							),
						roots,
					],
					[
						"readPendingApprovals range",
						read
							.readPendingApprovals(scope, { after: 0 })
							.pipe(
								Effect.map((result) =>
									result.rows.map((row) => row.session_id),
								),
							),
						roots,
					],
					[
						"listPendingClaudeQuestionTools",
						listPendingClaudeQuestionTools(scope).pipe(
							Effect.map((rows) => rows.map((row) => row.session_id)),
						),
						roots,
					],
					[
						"getStrandedChildren",
						read
							.getStrandedChildren(scope)
							.pipe(Effect.map((rows) => rows.map((row) => row.id))),
						children,
					],
					[
						"listSessionGitRefreshTargets",
						read
							.listSessionGitRefreshTargets(scope, {
								sessionIds: [...titles.keys()],
								all: true,
							})
							.pipe(Effect.map((rows) => rows.map((row) => row.id))),
						all,
					],
					[
						"readSessionList",
						read
							.readSessionList(scope)
							.pipe(
								Effect.map((result) => result.rows.map((row) => row.item.id)),
							),
						roots,
					],
					[
						"readSessionList range",
						read
							.readSessionList(scope, { after: 0 })
							.pipe(
								Effect.map((result) => result.rows.map((row) => row.item.id)),
							),
						roots,
					],
					[
						"readSessionList listing",
						read
							.readSessionList(scope, { listing: true })
							.pipe(
								Effect.map((result) =>
									(result.listing ?? []).map(([id]) => id),
								),
							),
						roots,
					],
				] as const;
				for (const [label, query, expected] of checks) {
					const result = await alpha.runPromise(Effect.either(query));
					record(
						label,
						name,
						result._tag === "Right" ? result.right : [],
						expected,
					);
				}
			}
			const aBefore = await alpha.runPromise(
				read.readSessionList(scopes.A, { listing: true }),
			);
			await commit(beta, [
				canonicalEvent("session.renamed", "ses_beta", {
					sessionId: "ses_beta",
					title: "Beta changed",
				}),
			]);
			const aAfter = await alpha.runPromise(
				read.readSessionList(scopes.A, { listing: true }),
			);
			expect(aAfter.listing).toEqual(aBefore.listing);
			expect(aAfter.version).toBeGreaterThan(aBefore.version);
			const untouchedRange = await alpha.runPromise(
				read.readSessionList(scopes.A, {
					after: aBefore.version,
					listing: true,
				}),
			);
			record(
				"unrelated sidebar range",
				"A",
				untouchedRange.rows.map((row) => row.item.id),
				[],
			);
			const standalone = await single.runPromise(ReadQueryEffectTag);
			for (const sessionId of ["ses_alpha", "ses_alpha_child"]) {
				const queries: readonly ((
					q: typeof read,
				) => Effect.Effect<unknown, unknown>)[] = [
					(q: typeof read) => q.getSession(sessionId),
					(q: typeof read) => q.getSessionMessagesWithParts(sessionId),
					(q: typeof read) =>
						q.readSessionTranscriptPage(sessionId, { limit: 100 }),
					(q: typeof read) => q.readSessionTranscript(sessionId),
					(q: typeof read) => q.readSessionTranscriptCatchUp(sessionId, 0, 100),
					(q: typeof read) => q.readSessionTodos(sessionId),
					(q: typeof read) =>
						q.readToolDetails(sessionId, [`${sessionId}_question`]),
				];
				for (const query of queries) {
					expect(content(await alpha.runPromise(query(read)))).toEqual(
						content(await single.runPromise(query(standalone))),
					);
				}
			}
			await replay.runPromise(
				Effect.gen(function* () {
					const store = yield* EventStoreEffectTag;
					yield* store.appendBatch(alphaHistory);
				}),
			);
			await replayBeta.runPromise(
				Effect.gen(function* () {
					const store = yield* EventStoreEffectTag;
					yield* store.appendBatch(history("beta"));
				}),
			);
			await replay.runPromise(
				Effect.gen(function* () {
					yield* (yield* ProjectionRunnerEffectTag).recover();
				}),
			);
			const replayRead = await replay.runPromise(ReadQueryEffectTag);
			expect(
				content(
					await replay.runPromise(
						replayRead.readSessionTranscript("ses_alpha"),
					),
				),
			).toEqual(
				content(
					await single.runPromise(
						standalone.readSessionTranscript("ses_alpha"),
					),
				),
			);
			for (const [name, scope] of Object.entries(scopes))
				record(
					"replayed sessions",
					name,
					(await replay.runPromise(replayRead.listSessions(scope))).map(
						(row) => row.id,
					),
					name === "A"
						? ["Alpha", "Alpha child"]
						: name === "B"
							? ["Beta", "Beta child"]
							: ["Alpha", "Alpha child", "Beta", "Beta child"],
				);
			const beforeDelete = (
				await alpha.runPromise(read.readSessionList(scopes.A))
			).version;
			await commit(beta, [
				canonicalEvent("session.deleted", "ses_beta", {
					sessionId: "ses_beta",
				}),
			]);
			for (const [name, scope] of Object.entries(scopes)) {
				const result = await alpha.runPromise(
					read.readSessionList(scope, { after: beforeDelete }),
				);
				record(
					"sidebar tombstones",
					name,
					(result.removed ?? [])
						.filter((row) => row.deleted)
						.map((row) => row.id),
					name === "A" ? [] : ["Beta", "Beta child"],
				);
			}
		} finally {
			await Promise.all([
				alpha.dispose(),
				beta.dispose(),
				single.dispose(),
				replay.dispose(),
				replayBeta.dispose(),
			]);
		}
	});

	it("publishes committed projects and routes project advances without splitting the global counter", async () => {
		const busRuntime = ManagedRuntime.make(makeSessionEventBusLive());
		const bus = await busRuntime.runPromise(SessionEventBusTag);
		const busLayer = Layer.succeed(SessionEventBusTag, bus);
		const sharedFile = filename();
		const alpha = ManagedRuntime.make(
			makePersistenceEffectLayer(sharedFile, "alpha", undefined, busLayer).pipe(
				Layer.provideMerge(busLayer),
			),
		);
		const beta = ManagedRuntime.make(
			makePersistenceEffectLayer(sharedFile, "beta", undefined, busLayer).pipe(
				Layer.provideMerge(busLayer),
			),
		);
		try {
			const advances = await busRuntime.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const changes = yield* bus.subscribeAdvances();
						yield* Effect.promise(async () => {
							await commit(alpha, history("alpha"));
							await commit(beta, history("beta"));
							await beta.runPromise(markUnread("ses_beta"));
						});
						return yield* Stream.runCollect(Stream.take(changes, 3));
					}),
				),
			);
			const changes = [...advances];
			expect(changes.map((advance) => advance.projectIds)).toEqual([
				["alpha"],
				["beta"],
				["beta"],
			]);
			expect(changes.map((advance) => advance.version)).toEqual([1, 2, 3]);
			for (const [name, scope] of Object.entries(scopes)) {
				const delivered = changes.filter((advance) =>
					advanceTouchesScope(advance, scope),
				);
				record(
					"scoped change feed",
					name,
					delivered
						.flatMap((advance) => advance.sessionIds)
						.filter((id, index, ids) => ids.indexOf(id) === index),
					name === "A"
						? ["Alpha", "Alpha child"]
						: name === "B"
							? ["Beta", "Beta child"]
							: ["Alpha", "Alpha child", "Beta", "Beta child"],
				);
				expect(
					advanceTouchesScope(
						{
							version: 4,
							projectIds: [],
							sessionIds: [],
							removedSessionIds: [],
							collections: ["sessions"],
						},
						scope,
					),
				).toBe(true);
			}
		} finally {
			await Promise.all([alpha.dispose(), beta.dispose()]);
			await busRuntime.dispose();
		}
	});

	it("stamps legacy projected rows on open and preserves their session history", async () => {
		const legacyFile = filename();
		await Effect.runPromise(
			Effect.scoped(
				makeEffectSqlMigrator(
					Object.fromEntries(
						Object.entries(effectMigrationEntries).filter(
							([key]) => Number(key.slice(0, 4)) <= 58,
						),
					),
				).pipe(Effect.provide(SqliteClient.layer({ filename: legacyFile }))),
			),
		);
		const db = new Database(legacyFile);
		try {
			db.exec(
				"INSERT INTO sessions (id, title, provider, status, created_at, updated_at, root_id) VALUES ('ses_legacy', 'Legacy', 'claude', 'idle', 1000, 1000, 'ses_legacy')",
			);
			db.prepare(
				"INSERT INTO session_sidebar (session_id, last_activity, version, row) VALUES ('ses_legacy', 1000, 1, ?)",
			).run(
				JSON.stringify({
					version: 1,
					lastActivity: 1000,
					members: ["ses_legacy"],
					snooze: {
						snoozed_at: null,
						snoozed_until: null,
						woken_at: null,
						woken_reason: null,
					},
					session: { id: "ses_legacy", title: "Legacy", status: "idle" },
				}),
			);
		} finally {
			db.close();
		}
		const runtime = ManagedRuntime.make(
			makePersistenceEffectLayer(legacyFile, "alpha"),
		);
		try {
			const read = await runtime.runPromise(ReadQueryEffectTag);
			record(
				"legacy sessions",
				"A",
				(await runtime.runPromise(read.listSessions(scopes.A))).map(
					(row) => row.id,
				),
				["Legacy"],
			);
			record(
				"legacy sidebar",
				"A",
				(await runtime.runPromise(read.readSessionList(scopes.A))).rows.map(
					(row) => row.item.id,
				),
				["Legacy"],
			);
			record(
				"legacy sessions",
				"B",
				(await runtime.runPromise(read.listSessions(scopes.B))).map(
					(row) => row.id,
				),
				[],
			);
			const sql = await runtime.runPromise(SqlClient.SqlClient);
			expect(
				await runtime.runPromise(
					sql`SELECT project_id FROM sessions WHERE id = 'ses_legacy'`,
				),
			).toEqual([{ project_id: "alpha" }]);
			expect(
				await runtime.runPromise(
					sql`SELECT project_id FROM session_sidebar WHERE session_id = 'ses_legacy'`,
				),
			).toEqual([{ project_id: "alpha" }]);
		} finally {
			await runtime.dispose();
		}
	});
});
