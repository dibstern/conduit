// Shared-store failure modes: a list or its checksum leaks another project;
// unrelated advances cause a scoped refresh; tombstones lose their owner;
// a session-keyed read changes under Scope; replay loses provenance; opening
// legacy history leaves its projected rows outside every Scope.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTest } from "effect/rpc";
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
import { ToolCallId } from "../../../src/lib/contracts/tool-wire.js";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { markUnread } from "../../../src/lib/domain/relay/Services/session-attention.js";
import {
	makeSessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { ToolContentServiceLive } from "../../../src/lib/domain/relay/Services/tool-content-service.js";
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
import { readForkSource } from "../../../src/lib/persistence/fork-history.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import {
	NEVER_CUT_TOOL_NAMES,
	PREVIEW_CODE_POINTS,
} from "../../../src/lib/persistence/tool-wire-projection.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeTestHandlerLayer } from "../../helpers/mock-factories.js";

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
					const result = await alpha.runPromise(Effect.result(query));
					record(
						label,
						name,
						result._tag === "Success" ? result.success : [],
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
		const busLayer = Layer.succeed(SessionEventBusTag)(bus);
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

// Output must survive previewing, full-history reads, RPC, replay and a fork
// whose source events are removed. Full replacements must clear old pointers;
// question and subagent outputs must stay inline.
describe("Event-owned tool results", () => {
	it("stores one full result while preserving browser previews, details, replay and forks", async () => {
		const sharedFile = filename();
		const runtime = ManagedRuntime.make(
			makePersistenceEffectLayer(sharedFile, "alpha"),
		);
		const replay = ManagedRuntime.make(
			makePersistenceEffectLayer(filename(), "alpha"),
		);
		const sessionId = "ses_tool_output";
		const messageId = "msg_tool_output";
		const longText = '🙂e\u0301 "quoted" \\ path\n'.repeat(PREVIEW_CODE_POINTS);
		const examples = [
			{ id: "part_string", name: "Bash", result: longText, cut: true },
			{
				id: "part_object",
				name: "Read",
				result: { nested: longText },
				cut: true,
			},
			{ id: "part_short", name: "Bash", result: "short", cut: false },
			{
				id: "part_todos",
				name: "TodoWrite",
				result: JSON.stringify([
					{ id: "todo-long", content: longText, status: "pending" },
				]),
				cut: true,
			},
			...NEVER_CUT_TOOL_NAMES.map((name) => ({
				id: `part_${name}`,
				name,
				result: longText,
				cut: false,
			})),
		].map((example) => ({
			...example,
			output:
				typeof example.result === "string"
					? example.result
					: JSON.stringify(example.result),
		}));
		const events = [
			canonicalEvent("session.created", sessionId, {
				sessionId,
				title: "Tool output",
				provider: "claude",
			}),
			canonicalEvent("message.created", sessionId, {
				sessionId,
				messageId,
				role: "assistant",
			}),
			...examples.flatMap(({ id, name, result }) => [
				canonicalEvent("tool.started", sessionId, {
					messageId,
					partId: id,
					callId: `call_${id}`,
					toolName: name,
					input: { tool: "Bash", command: "printf output" },
				}),
				canonicalEvent("tool.completed", sessionId, {
					messageId,
					partId: id,
					result,
					duration: 1,
				}),
			]),
		];
		try {
			await commit(runtime, events);
			const read = await runtime.runPromise(ReadQueryEffectTag);
			const sql = await runtime.runPromise(SqlClient.SqlClient);
			const stored = await runtime.runPromise(
				sql<{
					id: string;
					result: string;
					result_event_seq: number | null;
					result_bytes: number | null;
					event_sequence: number;
				}>`SELECT mp.id, mp.result, mp.result_event_seq, mp.result_bytes,
					e.sequence AS event_sequence
					FROM message_parts mp JOIN events e
					ON e.session_id = ${sessionId} AND e.type = 'tool.completed'
					AND json_extract(e.data, '$.partId') = mp.id
					WHERE mp.message_id = ${messageId} ORDER BY mp.id`,
			);
			const preview = await runtime.runPromise(
				read.readSessionTranscriptPage(sessionId, {
					limit: 10,
					previewTools: true,
				}),
			);
			const browser = messageRowsToHistory(preview.messages, { pageSize: 10 });
			for (const example of examples) {
				const row = stored.find(({ id }) => id === example.id);
				const head = Array.from(example.output)
					.slice(0, PREVIEW_CODE_POINTS)
					.join("");
				expect(row?.result).toBe(
					example.cut ? JSON.stringify(head) : JSON.stringify(example.result),
				);
				expect(row?.result_event_seq).toBe(
					example.cut ? row?.event_sequence : null,
				);
				expect(row?.result_bytes).toBe(
					example.cut ? Buffer.byteLength(example.output, "utf8") : null,
				);
				expect(
					browser.messages[0]?.parts?.find(({ id }) => id === example.id)?.state
						?.output,
				).toEqual(
					example.cut
						? {
								_tag: "preview",
								text: head,
								fullBytes: Buffer.byteLength(example.output, "utf8"),
							}
						: { _tag: "whole", text: example.output },
				);
			}
			for (const full of [
				(
					await runtime.runPromise(
						read.readSessionTranscriptPage(sessionId, { limit: 10 }),
					)
				).messages,
				await runtime.runPromise(read.getSessionMessagesWithParts(sessionId)),
			]) {
				for (const example of examples) {
					const part = full[0]?.parts.find(({ id }) => id === example.id);
					expect(part?.result).toBe(JSON.stringify(example.result));
					expect(part?.result_bytes ?? null).toBeNull();
				}
			}
			expect(
				(await runtime.runPromise(read.readSessionTodos(sessionId))).rows[0]
					?.item.items,
			).toEqual([{ id: "todo-long", subject: longText, status: "pending" }]);
			const rpcLayer = WsRpcServerLayer.pipe(
				Layer.provideMerge(
					Layer.merge(
						makeTestHandlerLayer(),
						ToolContentServiceLive.pipe(
							Layer.provide(Layer.succeed(ReadQueryEffectTag, read)),
						),
					),
				),
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* RpcTest.makeClient(WsRpcGroup);
					const details = yield* client.GetToolDetails({
						sessionId,
						toolIds: [
							ToolCallId.make("call_part_string"),
							...examples
								.slice(1)
								.map(({ id }) => ToolCallId.make(`call_${id}`)),
						],
					});
					for (const example of examples)
						expect(
							details.tools.find(
								({ toolId }) => toolId === `call_${example.id}`,
							)?.output,
						).toEqual({ _tag: "whole", text: example.output });
				}).pipe(Effect.scoped, Effect.provide(rpcLayer)),
			);

			await replay.runPromise(
				Effect.gen(function* () {
					yield* (yield* EventStoreEffectTag).appendBatch(events);
					const recovery = yield* (yield* ProjectionRunnerEffectTag).recover();
					expect(recovery.startCursor).toBe(0);
					expect(recovery.totalReplayed).toBeGreaterThan(0);
					const replaySql = yield* SqlClient.SqlClient;
					expect(
						yield* replaySql`SELECT id, result, result_event_seq, result_bytes
						FROM message_parts WHERE message_id = ${messageId} ORDER BY id`,
					).toEqual(stored.map(({ event_sequence: _, ...part }) => part));
				}),
			);

			const forkId = "ses_tool_fork";
			await runtime.runPromise(
				Effect.gen(function* () {
					const source = yield* readForkSource(sessionId, {
						sideThread: false,
					});
					const copied = yield* source.copy(forkId);
					const write = yield* makeCommitAndSignal;
					yield* write([
						canonicalEvent("session.created", forkId, {
							sessionId: forkId,
							title: "Tool fork",
							provider: "claude",
							forkedFrom: sessionId,
						}),
						...copied,
					]);
					expect(
						yield* sql`SELECT DISTINCT e.session_id FROM message_parts mp
						JOIN events e ON e.sequence = mp.result_event_seq
						JOIN messages m ON m.id = mp.message_id
						WHERE m.session_id = ${forkId}`,
					).toEqual([{ session_id: forkId }]);
					yield* write([
						canonicalEvent("session.deleted", sessionId, { sessionId }),
					]);
					yield* sql`DELETE FROM events WHERE session_id = ${sessionId}`;
				}),
			);
			await Effect.runPromise(
				Effect.gen(function* () {
					const client = yield* RpcTest.makeClient(WsRpcGroup);
					const details = yield* client.GetToolDetails({
						sessionId: forkId,
						toolIds: [
							ToolCallId.make(`call_part_string_${forkId}`),
							...examples
								.slice(1)
								.map(({ id }) => ToolCallId.make(`call_${id}_${forkId}`)),
						],
					});
					for (const example of examples)
						expect(
							details.tools.find(
								({ toolId }) => toolId === `call_${example.id}_${forkId}`,
							)?.output,
						).toEqual({ _tag: "whole", text: example.output });
				}).pipe(Effect.scoped, Effect.provide(rpcLayer)),
			);

			await commit(runtime, [
				canonicalEvent("tool.completed", forkId, {
					messageId: `${messageId}_${forkId}`,
					partId: `part_string_${forkId}`,
					result: "replacement",
					duration: 1,
				}),
			]);
			expect(
				await runtime.runPromise(
					sql`SELECT result, result_event_seq, result_bytes FROM message_parts
					WHERE id = ${`part_string_${forkId}`}`,
				),
			).toEqual([
				{ result: '"replacement"', result_event_seq: null, result_bytes: null },
			]);
			await commit(runtime, [
				canonicalEvent("message.snapshot", forkId, {
					messageId: `${messageId}_${forkId}`,
					digest: "replacement-snapshot",
					message: {
						id: `${messageId}_${forkId}`,
						sessionID: forkId,
						role: "assistant",
						parts: [
							{
								id: `part_object_${forkId}`,
								type: "tool",
								tool: "Read",
								state: { status: "completed", output: longText },
							},
						],
					},
				}),
			]);
			expect(
				await runtime.runPromise(
					sql`SELECT result, result_event_seq, result_bytes FROM message_parts
					WHERE id = ${`part_object_${forkId}`}`,
				),
			).toEqual([
				{
					result: JSON.stringify(longText),
					result_event_seq: null,
					result_bytes: null,
				},
			]);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/iujk6-tool-result-refs.json",
				`${JSON.stringify(
					{
						pass: true,
						previewCodePoints: PREVIEW_CODE_POINTS,
						results: examples
							.filter(({ cut }) => cut)
							.map((example) => ({
								partId: example.id,
								storedBytes: Buffer.byteLength(
									stored.find(({ id }) => id === example.id)?.result ?? "",
									"utf8",
								),
								fullOutputBytes: Buffer.byteLength(example.output, "utf8"),
							})),
						fullDetailsViaRpc: true,
						forkDetailsAfterParentDeletion: true,
						replayedFromSequenceZero: true,
					},
					null,
					2,
				)}\n`,
			);
		} finally {
			await Promise.all([runtime.dispose(), replay.dispose()]);
		}
	});

	it("backfills only byte-identical latest completions in the same session", async () => {
		const legacyFile = filename();
		await Effect.runPromise(
			Effect.scoped(
				makeEffectSqlMigrator(
					Object.fromEntries(
						Object.entries(effectMigrationEntries).filter(
							([key]) => !key.endsWith("_tool_result_event_refs"),
						),
					),
				).pipe(Effect.provide(SqliteClient.layer({ filename: legacyFile }))),
			),
		);
		const longText = '🙂 "quoted" \\ /\n'.repeat(PREVIEW_CODE_POINTS);
		const examples = [
			{
				id: "match",
				name: "Bash",
				result: longText,
				events: [longText],
				cut: true,
			},
			{
				id: "object",
				name: "Read",
				result: { nested: longText },
				events: [{ nested: longText }],
				cut: true,
			},
			{
				id: "newer_mismatch",
				name: "Bash",
				result: longText,
				events: [longText, "newer different result"],
				cut: false,
			},
			{ id: "missing", name: "Bash", result: longText, events: [], cut: false },
			{
				id: "wrong_session",
				name: "Bash",
				result: longText,
				events: [longText],
				cut: false,
			},
			{
				id: "escaped_json",
				name: "Bash",
				result: longText,
				events: [longText],
				cut: false,
			},
			{
				id: "short",
				name: "Bash",
				result: "short",
				events: ["short"],
				cut: false,
			},
			...NEVER_CUT_TOOL_NAMES.map((name) => ({
				id: `never_${name}`,
				name,
				result: longText,
				events: [longText],
				cut: false,
			})),
		].map((example) => ({
			...example,
			stored:
				example.id === "escaped_json"
					? JSON.stringify(example.result).replaceAll("/", "\\/")
					: JSON.stringify(example.result),
			output:
				typeof example.result === "string"
					? example.result
					: JSON.stringify(example.result),
		}));
		const sequences = new Map<string, number>();
		const db = new Database(legacyFile);
		try {
			db.exec(`
				INSERT INTO sessions (id, provider, created_at, updated_at, root_id, project_id)
				VALUES ('ses_backfill', 'claude', 1, 1, 'ses_backfill', 'alpha');
				INSERT INTO messages (id, session_id, role, created_at, updated_at)
				VALUES ('msg_backfill', 'ses_backfill', 'assistant', 1, 1);
			`);
			const insertPart = db.prepare(`INSERT INTO message_parts
				(id, message_id, type, tool_name, result, sort_order, created_at, updated_at)
				VALUES (?, 'msg_backfill', 'tool', ?, ?, 0, 1, 1)`);
			const insertEvent = db.prepare(`INSERT INTO events
				(event_id, session_id, stream_version, type, data, provider, created_at, project_id)
				VALUES (?, ?, ?, 'tool.completed', ?, 'claude', 1, 'alpha')`);
			let version = 0;
			for (const example of examples) {
				insertPart.run(example.id, example.name, example.stored);
				for (const result of example.events) {
					version++;
					const inserted = insertEvent.run(
						`evt_backfill_${version}`,
						example.id === "wrong_session" ? "ses_other" : "ses_backfill",
						version,
						JSON.stringify({
							messageId: "msg_backfill",
							partId: example.id,
							result,
						}),
					);
					sequences.set(example.id, Number(inserted.lastInsertRowid));
				}
			}
		} finally {
			db.close();
		}
		await Effect.runPromise(
			Effect.scoped(
				makeEffectSqlMigrator().pipe(
					Effect.provide(SqliteClient.layer({ filename: legacyFile })),
				),
			),
		);
		const migrated = new Database(legacyFile, { readonly: true });
		try {
			const rows = migrated
				.prepare<
					[],
					{
						id: string;
						result: string;
						result_event_seq: number | null;
						result_bytes: number | null;
					}
				>(
					"SELECT id, result, result_event_seq, result_bytes FROM message_parts",
				)
				.all();
			for (const example of examples) {
				const row = rows.find(({ id }) => id === example.id);
				expect(row).toEqual({
					id: example.id,
					result: example.cut
						? JSON.stringify(
								Array.from(example.output)
									.slice(0, PREVIEW_CODE_POINTS)
									.join(""),
							)
						: example.stored,
					result_event_seq: example.cut ? sequences.get(example.id) : null,
					result_bytes: example.cut
						? Buffer.byteLength(example.output, "utf8")
						: null,
				});
			}
		} finally {
			migrated.close();
		}
	});
});
