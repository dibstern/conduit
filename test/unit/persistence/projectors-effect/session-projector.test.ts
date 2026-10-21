// test/unit/persistence/projectors-effect/session-projector.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTO_TITLE_SOURCE } from "../../../../src/lib/contracts/session-title.js";
import type { ClaudeWorktreeState } from "../../../../src/lib/contracts/session-workspace.js";
import {
	createAllEffectProjectors,
	type EffectProjector,
} from "../../../../src/lib/persistence/effect/projectors-effect.js";
import {
	createEventId,
	type EventPayloadMap,
	type MessageCreatedPayload,
	type SessionCreatedPayload,
	type SessionPermissionModeChangedPayload,
	type SessionProviderChangedPayload,
	type SessionRenamedPayload,
	type SessionStatusPayload,
	type StoredEvent,
	type TurnCompletedPayload,
	type TurnErrorPayload,
} from "../../../../src/lib/persistence/events.js";
import { SESSION_HANDLED_TYPES } from "../../../../src/lib/persistence/projectors/session-handlers.js";
import type { SidebarRow } from "../../../../src/lib/persistence/sidebar-row.js";
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../../helpers/effect-projection-harness.js";

function makeStored<T extends StoredEvent["type"]>(
	type: T,
	sessionId: string,
	data: EventPayloadMap[T],
	sequence: number = 1,
	createdAt: number = Date.now(),
	runId = type.startsWith("turn.") ? `${sessionId}-run` : undefined,
	provider = "opencode",
): StoredEvent {
	return {
		sequence,
		projectId: "test-project",
		streamVersion: sequence - 1,
		eventId: createEventId(),
		sessionId,
		type,
		data,
		metadata: runId ? { runId } : {},
		provider,
		createdAt,
	} as StoredEvent;
}

interface SessionRow {
	id: string;
	provider: string;
	provider_sid: string | null;
	title: string;
	status: string;
	parent_id: string | null;
	fork_point_event: string | null;
	last_message_at: number | null;
	last_turn_error_at: number | null;
	permission_mode: string | null;
	settled_at: number | null;
	pinned_at: number | null;
	snoozed_at: number | null;
	snoozed_until: number | null;
	woken_at: number | null;
	woken_reason: string | null;
	version: number;
	created_at: number;
	updated_at: number;
	claude_worktree_state: string | null;
}

describe("SessionProjector", () => {
	let harness: EffectProjectionHarness;
	let projector: EffectProjector;
	const now = 1_000_000_000_000;

	beforeEach(() => {
		const effectProjector = createAllEffectProjectors().find(
			(candidate) => candidate.name === "session",
		);
		if (!effectProjector) throw new Error("Session projector not found");
		projector = effectProjector;
		harness = makeEffectProjectionHarness(
			createAllEffectProjectors().filter(
				(candidate) =>
					candidate.name === "session" || candidate.name === "turn",
			),
		);
	});

	afterEach(async () => {
		await harness?.dispose();
	});

	async function project(event: StoredEvent): Promise<void> {
		await harness.reproject([event]);
	}

	async function acceptRun(
		sessionId: string,
		at = now,
		runId = `${sessionId}-run`,
	) {
		const inputId = `${runId}-input`;
		await project(
			makeStored(
				"message.created",
				sessionId,
				{ sessionId, messageId: inputId, role: "user" },
				1,
				at,
				runId,
			),
		);
		await project(
			makeStored("run.requested", sessionId, { inputId, runId }, 1, at),
		);
		await project(
			makeStored(
				"run.started",
				sessionId,
				{ inputId, requestedRunId: runId },
				1,
				at,
				runId,
			),
		);
	}

	async function queryOne<T extends object>(
		statement: string,
		params: readonly (string | number | null)[] = [],
	): Promise<T | undefined> {
		return (await harness.query<T>(statement, params))[0];
	}

	it("has the correct name and handles list", async () => {
		expect(projector.name).toBe("session");
		expect(projector.handles).toBe(SESSION_HANDLED_TYPES);
	});

	describe("session.deleted", () => {
		it("deletes the session row", async () => {
			await project(
				makeStored("session.created", "s1", {
					sessionId: "s1",
					title: "Doomed",
					provider: "opencode",
				}),
			);
			expect(
				await queryOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", [
					"s1",
				]),
			).toBeDefined();
			await project(
				makeStored("session.deleted", "s1", { sessionId: "s1" }, 2),
			);
			expect(
				await queryOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", [
					"s1",
				]),
			).toBeUndefined();
		});

		it("is a no-op for an already-absent row", async () => {
			await expect(
				project(
					makeStored("session.deleted", "missing", { sessionId: "missing" }),
				),
			).resolves.toBeUndefined();
			expect(await harness.query<SessionRow>("SELECT * FROM sessions")).toEqual(
				[],
			);
		});
	});

	describe("snooze projection", () => {
		async function seedSnooze(until: number | null = null, at = now + 10) {
			await project(
				makeStored(
					"session.created",
					"s1",
					{ sessionId: "s1", title: "Session", provider: "claude" },
					1,
					now,
				),
			);
			await project(
				makeStored("session.snoozed", "s1", { sessionId: "s1", until }, 2, at),
			);
			await acceptRun("s1");
		}

		it.each([
			[
				"approval",
				makeStored(
					"permission.asked",
					"s1",
					{ id: "p1", sessionId: "s1", toolName: "bash", input: {} },
					3,
					now + 20,
				),
			],
			[
				"question",
				makeStored(
					"question.asked",
					"s1",
					{ id: "q1", sessionId: "s1", questions: [] },
					3,
					now + 20,
				),
			],
			[
				"error",
				makeStored(
					"turn.error",
					"s1",
					{ messageId: "m1", error: "failed" },
					3,
					now + 20,
				),
			],
			[
				"turn",
				makeStored(
					"turn.completed",
					"s1",
					{ messageId: "m1" },
					3,
					now + 20,
					"s1-run",
					"claude",
				),
			],
		] as const)("wakes on %s alone", async (reason, trigger) => {
			await seedSnooze(now + 100);
			await project(trigger);
			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = 's1'",
			);
			expect(row?.woken_at).toBe(now + 20);
			expect(row?.woken_reason).toBe(reason);
		});

		it("does not wake for a trigger before snoozed_at", async () => {
			await seedSnooze(null, now + 30);
			await project(
				makeStored(
					"question.asked",
					"s1",
					{ id: "q1", sessionId: "s1", questions: [] },
					3,
					now + 20,
				),
			);
			expect(
				(await queryOne<SessionRow>("SELECT * FROM sessions WHERE id = 's1'"))
					?.woken_at,
			).toBeNull();
		});

		it("does not record a trigger after snoozed_until", async () => {
			await seedSnooze(now + 15);
			await project(
				makeStored(
					"permission.asked",
					"s1",
					{ id: "p1", sessionId: "s1", toolName: "bash", input: {} },
					3,
					now + 20,
				),
			);
			expect(
				(await queryOne<SessionRow>("SELECT * FROM sessions WHERE id = 's1'"))
					?.woken_at,
			).toBeNull();
		});

		it("keeps the first wake when a later trigger arrives", async () => {
			await seedSnooze();
			await project(
				makeStored(
					"question.asked",
					"s1",
					{ id: "q1", sessionId: "s1", questions: [] },
					3,
					now + 20,
				),
			);
			await project(
				makeStored(
					"turn.error",
					"s1",
					{ messageId: "m1", error: "failed" },
					4,
					now + 30,
				),
			);
			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = 's1'",
			);
			expect([row?.woken_at, row?.woken_reason]).toEqual([
				now + 20,
				"question",
			]);
		});

		it("wakes a snoozed ancestor when a child blocks on the user, not when it finishes", async () => {
			await seedSnooze();
			await project(
				makeStored(
					"session.created",
					"child",
					{ sessionId: "child", title: "Child", provider: "opencode" },
					3,
					now + 11,
				),
			);
			await project(
				makeStored(
					"session.created",
					"child",
					{
						sessionId: "child",
						title: "Child",
						provider: "opencode",
						parentId: "s1",
					},
					4,
					now + 12,
				),
			);
			await acceptRun("child", now + 12);
			await project(
				makeStored(
					"session.status",
					"child",
					{ sessionId: "child", status: "idle" },
					5,
					now + 15,
					"child-run",
				),
			);
			const beforeVersion = (
				await queryOne<SessionRow>("SELECT * FROM sessions WHERE id = 's1'")
			)?.version;
			expect(
				(await queryOne<SessionRow>("SELECT * FROM sessions WHERE id = 's1'"))
					?.woken_at,
			).toBeNull();
			await project(
				makeStored(
					"permission.asked",
					"child",
					{ id: "p1", sessionId: "child", toolName: "bash", input: {} },
					6,
					now + 20,
				),
			);
			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = 's1'",
			);
			expect([row?.woken_at, row?.woken_reason]).toEqual([
				now + 20,
				"approval",
			]);
			expect(row?.version).toBeGreaterThan(beforeVersion ?? 0);
		});

		it("wakes an indefinite snooze", async () => {
			await seedSnooze();
			await project(
				makeStored(
					"turn.completed",
					"s1",
					{ messageId: "m1" },
					3,
					now + 20,
					"s1-run",
					"claude",
				),
			);
			expect(
				(await queryOne<SessionRow>("SELECT * FROM sessions WHERE id = 's1'"))
					?.woken_reason,
			).toBe("turn");
		});

		it("leaves updated_at unchanged on snooze and unsnooze", async () => {
			await seedSnooze(now + 100);
			let row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = 's1'",
			);
			expect(row?.updated_at).toBe(now);
			await project(
				makeStored("session.unsnoozed", "s1", { sessionId: "s1" }, 3, now + 20),
			);
			row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = 's1'",
			);
			expect(row).toMatchObject({
				updated_at: now,
				snoozed_at: null,
				snoozed_until: null,
				woken_at: null,
				woken_reason: null,
			});
		});
	});

	// Failures to cover: failed/legacy tools inventing state, premature mismatch,
	// superseded sends consuming intent, moves back to an observed folder getting
	// stuck, and a second NULL-workspace update failing to reach the sidebar.
	describe("Claude worktree state", () => {
		let sequence = 0;
		const fact = <T extends StoredEvent["type"]>(
			type: T,
			data: EventPayloadMap[T],
		) => ({
			...makeStored<T>(type, "claude", data, ++sequence, now + sequence),
			provider: "claude" as const,
		});
		const state = async (): Promise<ClaudeWorktreeState | null> => {
			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = 'claude'",
			);
			return row?.claude_worktree_state
				? (JSON.parse(row.claude_worktree_state) as ClaudeWorktreeState)
				: null;
		};
		const move = (path: string, cause: "user" | "agent" | "missing" = "user") =>
			fact("session.workspace_changed", {
				sessionId: "claude",
				path,
				cause,
				origin: "existing",
				worktrees: path === "/main" ? {} : { "/main": path },
			});
		const tool = (path: string, entered: boolean) =>
			fact("tool.completed", {
				messageId: "assistant",
				partId: `tool-${sequence}`,
				result: "confirmed",
				duration: 0,
				metadata: { workspace: { path, entered } },
			});
		beforeEach(async () => {
			sequence = 0;
			await project(
				fact("session.created", {
					sessionId: "claude",
					title: "Worktree state",
					provider: "claude",
				}),
			);
			await acceptRun("claude");
		});

		// A fallback must retain its cause on the row, require a directive only
		// after EnterWorktree, and settle through the same observations as a user move.
		it.each([
			true,
			false,
		])("projects a missing move with entered=%s", async (entered) => {
			await project(tool("/removed", entered));
			const requested = move("/main", "missing");
			await project(requested);
			expect(await state()).toEqual({
				entered,
				observed: "/removed",
				pending: {
					sequence: requested.sequence,
					path: "/main",
					needsDirective: entered,
					directiveSent: false,
					turnEnded: false,
				},
			});
			const row = await queryOne<{ workspace: string | null }>(
				"SELECT workspace FROM sessions WHERE id = 'claude'",
			);
			expect(JSON.parse(row?.workspace ?? "null")).toEqual({
				cause: "missing",
				origin: "existing",
				worktrees: {},
			});
			await project(
				fact("input.sent", {
					sessionId: "claude",
					inputId: "input",
					workspaceMoveSequence: requested.sequence,
				}),
			);
			await project(fact("turn.completed", { messageId: "assistant" }));
			expect((await state())?.pending).toMatchObject({
				directiveSent: true,
				turnEnded: true,
			});
			await project(tool("/main", false));
			expect(await state()).toEqual({ entered: false, observed: "/main" });
			await project(move("/main", "agent"));
			expect(
				(
					await queryOne<{ workspace: string | null }>(
						"SELECT workspace FROM sessions WHERE id = 'claude'",
					)
				)?.workspace,
			).toBeNull();
		});

		it("records confirmed tools only and waits for the directive turn to end", async () => {
			await project(
				fact("tool.completed", {
					messageId: "assistant",
					partId: "legacy",
					result: "EnterWorktree",
					duration: 0,
				}),
			);
			expect(await state()).toBeNull();
			await project(tool("/entered", true));
			const requested = move("/target");
			await project(requested);
			expect(await state()).toEqual({
				entered: true,
				observed: "/entered",
				pending: {
					sequence: requested.sequence,
					path: "/target",
					needsDirective: true,
					directiveSent: false,
					turnEnded: false,
				},
			});
			await project(
				fact("input.sent", {
					sessionId: "claude",
					inputId: "input",
					workspaceMoveSequence: requested.sequence,
				}),
			);
			expect((await state())?.pending).toMatchObject({
				directiveSent: true,
				turnEnded: false,
			});
			await project(fact("turn.completed", { messageId: "assistant" }));
			expect((await state())?.pending).toMatchObject({
				directiveSent: true,
				turnEnded: true,
			});
			await project(tool("/target", true));
			expect(await state()).toEqual({ entered: true, observed: "/target" });
		});

		it.each([
			"turn.error",
			"turn.interrupted",
		] as const)("marks an unconfirmed directive ended on %s", async (type) => {
			await project(tool("/entered", true));
			const requested = move("/target");
			await project(requested);
			await project(
				fact("input.sent", {
					sessionId: "claude",
					inputId: "input",
					workspaceMoveSequence: requested.sequence,
				}),
			);
			await project(
				type === "turn.error"
					? fact(type, { messageId: "assistant", error: "failed" })
					: fact(type, { messageId: "assistant" }),
			);
			expect((await state())?.pending?.turnEnded).toBe(true);
		});

		it("replaces pending intent and ignores a stamp for the superseded move", async () => {
			await project(tool("/entered", true));
			const older = move("/older");
			await project(older);
			await project(tool("/main", false));
			const newer = move("/newer");
			await project(newer);
			await project(
				fact("input.sent", {
					sessionId: "claude",
					inputId: "input",
					workspaceMoveSequence: older.sequence,
				}),
			);
			await project(fact("turn.completed", { messageId: "assistant" }));
			expect(await state()).toEqual({
				entered: false,
				observed: "/main",
				pending: {
					sequence: newer.sequence,
					path: "/newer",
					needsDirective: false,
					directiveSent: false,
					turnEnded: false,
				},
			});
			await project(
				fact("session.workspace_started", {
					sessionId: "claude",
					path: "/newer",
				}),
			);
			expect(await state()).toEqual({ entered: false, observed: "/newer" });
		});

		it("clears pending when the user selects Claude's observed folder", async () => {
			await project(tool("/entered", true));
			await project(move("/elsewhere"));
			await project(move("/entered"));
			expect(await state()).toEqual({ entered: true, observed: "/entered" });
			await project(tool("/main", false));
			await project(move("/main"));
			expect(await state()).toEqual({ entered: false, observed: "/main" });
		});

		it("keeps intent through a wrong agent observation and clears on a matching one", async () => {
			await project(tool("/entered", true));
			const requested = move("/target");
			await project(requested);
			await project(move("/elsewhere", "agent"));
			expect(await state()).toMatchObject({
				observed: "/elsewhere",
				pending: { path: "/target", sequence: requested.sequence },
			});
			await project(move("/target", "agent"));
			expect(await state()).toEqual({ entered: true, observed: "/target" });
		});

		it("advances the root's session and sidebar when a NULL workspace mismatch clears", async () => {
			await project(tool("/entered", true));
			const requested = move("/main");
			await project(requested);
			await project(
				fact("input.sent", {
					sessionId: "claude",
					inputId: "input",
					workspaceMoveSequence: requested.sequence,
				}),
			);
			await project(fact("turn.completed", { messageId: "assistant" }));
			const before = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = 'claude'",
			);
			const sidebarBefore = await queryOne<{ version: number; row: string }>(
				"SELECT version, row FROM session_sidebar WHERE session_id = 'claude'",
			);
			expect(
				(JSON.parse(sidebarBefore?.row ?? "{}") as SidebarRow).session
					.workspaceMismatch,
			).toEqual({ actualPath: "/entered" });
			await project(tool("/main", false));
			await project(move("/main", "agent"));
			const after = await queryOne<SessionRow & { workspace: string | null }>(
				"SELECT * FROM sessions WHERE id = 'claude'",
			);
			const sidebarAfter = await queryOne<{ version: number; row: string }>(
				"SELECT version, row FROM session_sidebar WHERE session_id = 'claude'",
			);
			expect(after?.workspace).toBeNull();
			expect(after?.version).toBeGreaterThan(before?.version ?? 0);
			expect(sidebarAfter?.version).toBeGreaterThan(
				sidebarBefore?.version ?? 0,
			);
			expect(
				(JSON.parse(sidebarAfter?.row ?? "{}") as SidebarRow).session
					.workspaceMismatch,
			).toBeUndefined();
		});
	});

	describe("session.created", () => {
		// Missing lineage must skip every write, including inherited history and
		// provider bindings, both live and when replay dispatches all projectors.
		it.each([
			"parentId",
			"forkedFrom",
		] as const)("writes nothing when %s is missing", async (reference) => {
			await harness.dispose();
			harness = makeEffectProjectionHarness();
			await harness.reproject([
				makeStored("session.created", "missing-lineage", {
					sessionId: "missing-lineage",
					title: "Late child",
					provider: "claude",
					[reference]: "missing-source",
					inheritsHistory: true,
					forkPointMessageId: "missing-cut",
					forkPointTimestamp: now,
				}),
			]);
			expect(await harness.query("SELECT id FROM sessions")).toEqual([]);
			expect(await harness.query("SELECT id FROM session_providers")).toEqual(
				[],
			);
		});

		it("inserts a new session row", async () => {
			const event = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "Hello World",
				provider: "opencode",
			} satisfies SessionCreatedPayload);

			await project(event);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row).toBeDefined();
			expect(row?.id).toBe("s1");
			expect(row?.provider).toBe("opencode");
			expect(row?.title).toBe("Hello World");
			expect(row?.status).toBe("idle");
			expect(row?.created_at).toBe(event.createdAt);
			expect(row?.updated_at).toBe(event.createdAt);
		});

		it("is idempotent (INSERT ON CONFLICT DO UPDATE)", async () => {
			const event = makeStored("session.created", "s1", {
				sessionId: "s1",
				title: "First",
				provider: "opencode",
			} satisfies SessionCreatedPayload);

			await project(event);
			await project(event);

			const rows = await harness.query<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(rows).toHaveLength(1);
		});
	});

	describe("session.renamed", () => {
		it("updates the title and updated_at", async () => {
			const created = makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Original",
					provider: "opencode",
				} satisfies SessionCreatedPayload,
				1,
				now,
			);
			await project(created);

			const renamed = makeStored(
				"session.renamed",
				"s1",
				{
					sessionId: "s1",
					title: "Renamed Session",
				} satisfies SessionRenamedPayload,
				2,
				now + 1000,
			);
			await project(renamed);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.title).toBe("Renamed Session");
			expect(row?.updated_at).toBe(now + 1000);
		});

		// Title rules (ticket o4yo.2): each event is appended to the store as
		// applySessionCommand would, so the auto-title guard can see prior renames.
		const rename = (
			sequence: number,
			title: string,
			source?: typeof AUTO_TITLE_SOURCE,
		): StoredEvent => ({
			...makeStored(
				"session.renamed",
				"s1",
				{ sessionId: "s1", title } satisfies SessionRenamedPayload,
				sequence,
				now + sequence,
			),
			metadata: source ? { source } : {},
		});

		async function append(event: StoredEvent): Promise<void> {
			await harness.query(
				`INSERT INTO events (project_id, sequence, event_id, session_id, stream_version, type, data, metadata, provider, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					event.projectId,
					event.sequence,
					event.eventId,
					event.sessionId,
					event.streamVersion,
					event.type,
					JSON.stringify(event.data),
					JSON.stringify(event.metadata),
					event.provider,
					event.createdAt,
				],
			);
		}

		async function appendAndProject(event: StoredEvent): Promise<void> {
			await append(event);
			await project(event);
		}

		async function titleAfter(...events: StoredEvent[]): Promise<string> {
			await appendAndProject(
				makeStored(
					"session.created",
					"s1",
					{
						sessionId: "s1",
						title: "Untitled",
						provider: "opencode",
					} satisfies SessionCreatedPayload,
					1,
					now,
				),
			);
			for (const event of events) await appendAndProject(event);
			const row = await queryOne<SessionRow>(
				"SELECT title FROM sessions WHERE id = ?",
				["s1"],
			);
			return row?.title ?? "";
		}

		it("applies an auto-title after placeholder renames", async () => {
			expect(
				await titleAfter(
					rename(2, "Untitled"),
					rename(3, "New session - 2026-10-12T00:00:00.000Z"),
					rename(4, "Fix Header Selector", AUTO_TITLE_SOURCE),
				),
			).toBe("Fix Header Selector");
		});

		it("skips an auto-title after a real manual rename", async () => {
			expect(
				await titleAfter(
					rename(2, "Manual Title"),
					rename(3, "Fix Header Selector", AUTO_TITLE_SOURCE),
				),
			).toBe("Manual Title");
		});

		it("keeps an auto-title when the provider echoes it back", async () => {
			expect(
				await titleAfter(
					rename(2, "Fix Header Selector", AUTO_TITLE_SOURCE),
					rename(3, "Fix Header Selector"),
				),
			).toBe("Fix Header Selector");
		});

		it("never lets a placeholder rename replace a real title", async () => {
			expect(
				await titleAfter(
					rename(2, "Fix Header Selector", AUTO_TITLE_SOURCE),
					rename(3, "Untitled"),
					rename(4, "New session - 2026-10-12T00:00:00.000Z"),
				),
			).toBe("Fix Header Selector");
		});

		it("lets a manual rename appended before the auto-title win once projected", async () => {
			const manual = rename(2, "Manual Title");
			expect(await titleAfter()).toBe("Untitled");
			await append(manual);
			await appendAndProject(
				rename(3, "Fix Header Selector", AUTO_TITLE_SOURCE),
			);
			const raced = await queryOne<SessionRow>(
				"SELECT title FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(raced?.title).toBe("Untitled");

			await project(manual);
			const row = await queryOne<SessionRow>(
				"SELECT title FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.title).toBe("Manual Title");
		});
	});

	describe("session.status", () => {
		it.each([
			"busy",
			"retry",
		] as const)("updates status to %s and clears the last turn error", async (statusValue) => {
			const created = makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				} satisfies SessionCreatedPayload,
				1,
				now,
			);
			await project(created);
			await acceptRun("s1");
			await project(
				makeStored(
					"turn.error",
					"s1",
					{ messageId: "m1", error: "failed" },
					2,
					now + 250,
				),
			);

			const status = makeStored(
				"session.status",
				"s1",
				{
					sessionId: "s1",
					status: statusValue,
				} satisfies SessionStatusPayload,
				3,
				now + 500,
			);
			await project(status);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.status).toBe(statusValue);
			expect(row?.updated_at).toBe(now + 500);
			expect(row?.last_turn_error_at).toBeNull();
		});

		it("preserves the last turn error for an idle status", async () => {
			await project(
				makeStored("session.created", "s1", {
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				}),
			);
			await acceptRun("s1");
			await project(
				makeStored(
					"turn.error",
					"s1",
					{ messageId: "m1", error: "failed" },
					2,
					now + 250,
				),
			);
			await project(
				makeStored(
					"session.status",
					"s1",
					{ sessionId: "s1", status: "idle" },
					3,
					now + 500,
				),
			);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.last_turn_error_at).toBe(now + 250);
		});
	});

	describe("session.provider_changed", () => {
		it("updates the provider and updated_at", async () => {
			const created = makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				} satisfies SessionCreatedPayload,
				1,
				now,
			);
			await project(created);

			const changed = makeStored(
				"session.provider_changed",
				"s1",
				{
					sessionId: "s1",
					oldProvider: "opencode",
					newProvider: "claude",
				} satisfies SessionProviderChangedPayload,
				2,
				now + 2000,
			);
			await project(changed);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.provider).toBe("claude");
			expect(row?.updated_at).toBe(now + 2000);
		});
	});

	describe("session.permission_mode_changed", () => {
		it("updates permission mode and updated_at for the target session only", async () => {
			for (const sessionId of ["s1", "s2"]) {
				await project(
					makeStored(
						"session.created",
						sessionId,
						{
							sessionId,
							title: `Session ${sessionId}`,
							provider: "opencode",
						} satisfies SessionCreatedPayload,
						1,
						now,
					),
				);
			}

			await project(
				makeStored(
					"session.permission_mode_changed",
					"s1",
					{
						sessionId: "s1",
						mode: "auto",
					} satisfies SessionPermissionModeChangedPayload,
					2,
					now + 2500,
				),
			);

			const target = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			const other = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s2"],
			);
			expect(target?.permission_mode).toBe("auto");
			expect(target?.updated_at).toBe(now + 2500);
			expect(other?.permission_mode).toBeNull();
			expect(other?.updated_at).toBe(now);
		});
	});

	it.each([
		["session.settled", "session.unsettled", "settled_at"],
		["session.pinned", "session.unpinned", "pinned_at"],
	] as const)("%s and its undo preserve the session sort key", async (setType, clearType, column) => {
		await project(
			makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				},
				1,
				now,
			),
		);
		await project(
			makeStored(
				"session.created",
				"s2",
				{
					sessionId: "s2",
					title: "Other",
					provider: "opencode",
				},
				2,
				now + 50,
			),
		);
		await project(makeStored(setType, "s1", { sessionId: "s1" }, 3, now + 100));
		const afterSet = await queryOne<SessionRow>(
			"SELECT * FROM sessions WHERE id = ?",
			["s1"],
		);
		expect(afterSet?.[column]).toBe(now + 100);
		expect(afterSet?.updated_at).toBe(now);
		const other = await queryOne<SessionRow>(
			"SELECT * FROM sessions WHERE id = ?",
			["s2"],
		);
		expect(other?.[column]).toBeNull();
		expect(other?.updated_at).toBe(now + 50);
		await project(
			makeStored(clearType, "s1", { sessionId: "s1" }, 4, now + 200),
		);
		const afterClear = await queryOne<SessionRow>(
			"SELECT * FROM sessions WHERE id = ?",
			["s1"],
		);
		expect(afterClear?.[column]).toBeNull();
		expect(afterClear?.updated_at).toBe(now);
	});

	describe("turn.completed", () => {
		it("updates updated_at and clears the last turn error", async () => {
			const created = makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Test",
					provider: "claude",
				} satisfies SessionCreatedPayload,
				1,
				now,
			);
			await project(created);
			await acceptRun("s1");

			const originalRow = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			const originalTitle = originalRow?.title;
			await project(
				makeStored(
					"turn.error",
					"s1",
					{ messageId: "m0", error: "failed" },
					2,
					now + 3000,
				),
			);

			const turnDone = makeStored(
				"turn.completed",
				"s1",
				{
					messageId: "m1",
					cost: 0.01,
					tokens: { input: 100, output: 50 },
				} satisfies TurnCompletedPayload,
				3,
				now + 5000,
				"s1-next-run",
				"claude",
			);
			await acceptRun("s1", now + 3000, "s1-next-run");
			await project(turnDone);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.title).toBe(originalTitle);
			// A terminal leaves the session idle when no other run is open.
			expect(row?.status).toBe("idle");
			expect(row?.updated_at).toBe(now + 5000);
			expect(row?.last_turn_error_at).toBeNull();
		});
	});

	describe("turn.error", () => {
		it("updates updated_at and records the failure timestamp", async () => {
			const created = makeStored(
				"session.created",
				"s1",
				{
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				} satisfies SessionCreatedPayload,
				1,
				now,
			);
			await project(created);
			await acceptRun("s1");

			const turnErr = makeStored(
				"turn.error",
				"s1",
				{
					messageId: "m1",
					error: "something failed",
				} satisfies TurnErrorPayload,
				2,
				now + 3000,
			);
			await project(turnErr);

			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.updated_at).toBe(now + 3000);
			expect(row?.last_turn_error_at).toBe(now + 3000);
		});
	});

	describe("message.created", () => {
		it("clears the last turn error only for user messages", async () => {
			await project(
				makeStored("session.created", "s1", {
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
				}),
			);
			await acceptRun("s1");
			await project(
				makeStored(
					"turn.error",
					"s1",
					{ messageId: "m1", error: "failed" },
					2,
					now + 100,
				),
			);
			await project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "a1",
						role: "assistant",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					3,
					now + 200,
				),
			);
			expect(
				(
					await queryOne<SessionRow>("SELECT * FROM sessions WHERE id = ?", [
						"s1",
					])
				)?.last_turn_error_at,
			).toBe(now + 100);

			await project(
				makeStored(
					"message.created",
					"s1",
					{
						messageId: "u1",
						role: "user",
						sessionId: "s1",
					} satisfies MessageCreatedPayload,
					4,
					now + 300,
				),
			);
			const row = await queryOne<SessionRow>(
				"SELECT * FROM sessions WHERE id = ?",
				["s1"],
			);
			expect(row?.last_message_at).toBe(now + 300);
			expect(row?.last_turn_error_at).toBeNull();
		});
	});

	// Runners built before the translator stamped `outcome` still report a
	// terminal task status; without settling on it the child stays busy forever.
	it.each([
		"completed",
		"failed",
		"stopped",
		"killed",
	])("tool.running settles a busy child on a terminal task status %s without an outcome", async (taskStatus) => {
		await project(
			makeStored(
				"session.created",
				"child",
				{ sessionId: "child", title: "Child", provider: "claude" },
				1,
			),
		);
		await project(
			makeStored(
				"session.status",
				"child",
				{ sessionId: "child", status: "busy" },
				2,
			),
		);
		await project(
			makeStored(
				"tool.running",
				"s1",
				{
					messageId: "m1",
					partId: "tool1",
					metadata: { childSessionId: "child", status: taskStatus },
				},
				3,
			),
		);

		const row = await queryOne<SessionRow>(
			"SELECT * FROM sessions WHERE id = ?",
			["child"],
		);
		expect(row?.status).toBe("idle");
	});

	it("ignores event types it does not handle", async () => {
		// Pre-insert a session so we can verify it's untouched
		const created = makeStored(
			"session.created",
			"s1",
			{
				sessionId: "s1",
				title: "Test",
				provider: "opencode",
			} satisfies SessionCreatedPayload,
			1,
		);
		await project(created);

		const before = await queryOne<SessionRow>(
			"SELECT * FROM sessions WHERE id = ?",
			["s1"],
		);

		const unrelated = makeStored(
			"text.delta",
			"s1",
			{
				messageId: "m1",
				partId: "p1",
				text: "hello",
				// biome-ignore lint/suspicious/noExplicitAny: intentionally unrelated event type for "ignores" test
			} as any,
			2,
		);
		await project(unrelated);

		const after = await queryOne<SessionRow>(
			"SELECT * FROM sessions WHERE id = ?",
			["s1"],
		);
		expect(after?.updated_at).toBe(before?.updated_at);
	});
});
