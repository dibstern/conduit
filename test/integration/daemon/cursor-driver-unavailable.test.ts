// Failure modes: an unavailable runner reaches another driver, an approval is
// invented, or one driver's default replaces another driver's selection.
import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { Effect, Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AddInstance,
	CreateSession,
	SetDefault,
} from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

function persisted(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.projectStorePath(), { readonly: true });
	try {
		return {
			events: db
				.prepare<[string], { type: string; provider: string; data: string }>(
					"SELECT type, provider, data FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId)
				.map(({ data, ...event }) => ({
					...event,
					data: JSON.parse(data) as Record<string, unknown>,
				})),
			turnStatuses: db
				.prepare<[string], { state: string }>(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId)
				.map(({ state }) => state),
			approvals: db
				.prepare<[string], { decision: string | null }>(
					"SELECT decision FROM pending_approvals WHERE session_id = ?",
				)
				.all(sessionId),
			model: db
				.prepare<[string], { model_provider: string | null }>(
					"SELECT model_provider FROM sessions WHERE id = ?",
				)
				.get(sessionId),
		};
	} finally {
		db.close();
	}
}

describe("Cursor without an installed runtime through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	const scenarios: Record<string, unknown>[] = [];

	async function start(scenario: string) {
		evidence = { scenario };
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			opencodeRecording: "chat-simple",
		});
		// Startup budgets allow slow process imports on a loaded host.
		await harness.restart({
			startupTimeoutMs: 60_000,
			runnerStartupTimeoutMs: 60_000,
		});
		return harness;
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["result"] = task.result?.state;
			evidence["failures"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
			await fixture.dispose();
		} finally {
			const proof = fixture.proof();
			scenarios.push({
				...evidence,
				process: {
					buildIdentity: proof.buildIdentity,
					disposed: proof.disposed,
					generations: proof.generations.map(({ pid, exitCode, signal }) => ({
						pid,
						exitCode,
						signal,
					})),
					remainingRunnerPids: fixture.remainingRunnerPids(),
					remainingOpenCodePids: proof.remainingObservedOpenCodePids,
					rpcDecodeFailures: proof.rpcDecodeFailures,
					configReadErrors: proof.configReadErrors,
					...(task.result?.errors?.length ? { logTail: proof.logTail } : {}),
				},
			});
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/conduit-test-xqsg.17.json",
				`${JSON.stringify({ ticket: "conduit-test-xqsg.17", scenarios }, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	it("reports Cursor unavailable and stores a failed turn without dispatching to another driver", async () => {
		const fixture = await start("cursor-unavailable-and-existing-drivers");
		const added = await fixture.requestRpc(
			new AddInstance({ name: "Cursor", driver: "cursor" }),
		);
		const accountId = added.addedInstanceId;
		if (!accountId) throw new Error("Missing registered Cursor account");
		let browser = await fixture.connect();
		const discovery = await browser.instances();
		const cursor = discovery.instances.find(({ id }) => id === accountId);
		expect(cursor).toMatchObject({
			driver: "cursor",
			available: false,
			unavailableReason: "Cursor runtime not installed",
			usageEligible: false,
		});
		evidence["discovery"] = cursor;
		await expect(
			browser.createSession(
				"Unavailable Cursor selection",
				accountId,
				"cursor",
				{ modelId: "cursor-test-model", contextWindow: "" },
			),
		).rejects.toThrow(
			"ModelNotInCatalog: model cursor/cursor-test-model is not in the cursor catalog",
		);
		evidence["newSelection"] = "Rejected: Cursor has no runtime model catalog";
		await fixture.terminate();
		const sessionId = "cursor-existing-session";
		// Existing history can outlive its runtime. Seed it through the same
		// canonical event store and projectors used when a session is created.
		evidence["seededHistory"] =
			"Canonical Cursor session and settings projected while daemon stopped; send uses restarted daemon RPC";
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const projector = yield* ProjectionRunnerEffectTag;
				yield* projector.recover();
				const events = yield* store.appendBatch([
					canonicalEvent(
						"session.created",
						sessionId,
						{
							sessionId,
							title: "Unavailable Cursor turn",
							provider: accountId,
							permissionMode: "ask",
						},
						{ provider: "cursor" },
					),
					canonicalEvent(
						"session.model_changed",
						sessionId,
						{ sessionId, modelId: "cursor-test-model", providerId: "cursor" },
						{ provider: "cursor" },
					),
					canonicalEvent(
						"session.variant_changed",
						sessionId,
						{ sessionId, variant: "" },
						{ provider: "cursor" },
					),
					canonicalEvent(
						"session.context_window_changed",
						sessionId,
						{ sessionId, contextWindow: "" },
						{ provider: "cursor" },
					),
				]);
				yield* projector.projectBatch(events);
			}).pipe(
				Effect.provide(
					makePersistenceEffectLayer(
						fixture.projectStorePath(),
						"process-test",
					),
				),
			),
		);
		await fixture.restart({
			startupTimeoutMs: 60_000,
			runnerStartupTimeoutMs: 60_000,
		});
		browser = await fixture.connect(sessionId);
		expect(persisted(fixture, sessionId).model?.model_provider).toBe("cursor");
		const queriesBefore = fixture.marks.filter(({ kind }) => kind === "query");
		const prompts = () =>
			fixture
				.opencodeRequestBodies()
				.filter(({ path }) => /\/prompt/.test(path));
		const requestsBefore = prompts().length;
		const frameCursor = browser.frames.length;
		const failed = await browser.send(
			sessionId,
			"approval-cursor-must-not-run",
		);
		evidence["cursorCompletion"] = {
			status: failed.done["status"],
			lastTurnEndVersion: failed.done["lastTurnEndVersion"],
		};
		const cursorState = persisted(fixture, sessionId);
		evidence["cursorDiagnostic"] = cursorState;
		expect(cursorState.turnStatuses).toEqual(["error"]);
		expect(
			cursorState.events.filter(({ type }) => type === "turn.error"),
		).toHaveLength(1);
		expect(
			cursorState.events.find(({ type }) => type === "turn.error")?.data[
				"error"
			],
		).toContain("Cursor runtime not installed");
		expect(
			cursorState.events.filter(
				({ provider }) => provider === "opencode" || provider === "claude",
			),
		).toEqual([]);
		expect(
			cursorState.events.filter(({ type }) => /permission|approval/.test(type)),
		).toEqual([]);
		expect(cursorState.approvals).toEqual([]);
		expect(
			browser.frames
				.slice(frameCursor)
				.filter(({ message }) => message["type"] === "permission_pending"),
		).toEqual([]);
		expect(fixture.marks.filter(({ kind }) => kind === "query")).toEqual(
			queriesBefore,
		);
		expect(prompts()).toHaveLength(requestsBefore);
		evidence["cursor"] = {
			storedEventTypes: cursorState.events.map(({ type }) => type),
			eventProviders: [
				...new Set(cursorState.events.map(({ provider }) => provider)),
			],
			turnStatuses: cursorState.turnStatuses,
			errors: cursorState.events.filter(({ type }) => type === "turn.error"),
			approvals: cursorState.approvals,
			claudeQueriesDuringSend:
				fixture.marks.filter(({ kind }) => kind === "query").length -
				queriesBefore.length,
			opencodePromptsDuringSend: prompts().length - requestsBefore,
		};
		delete evidence["cursorDiagnostic"];

		const claudeId = await browser.createSession("Claude still runs");
		const claude = await browser.send(
			claudeId,
			"cursor-driver-claude-proof",
			90_000,
		);
		evidence["claudeDiagnostic"] = persisted(fixture, claudeId);
		expect(claude.done["status"]).toBe("idle");
		expect(claude.chunks.join("")).toBe(
			responseChunks("cursor-driver-claude-proof").join(""),
		);
		await vi.waitFor(() =>
			expect(persisted(fixture, claudeId).turnStatuses).toEqual(["completed"]),
		);
		const claudeState = persisted(fixture, claudeId);
		expect(
			claudeState.events.some(({ provider }) => provider === "claude"),
		).toBe(true);
		expect(
			claudeState.events.filter(
				({ provider, type }) =>
					provider === "opencode" &&
					/^(message|text|thinking|tool|turn)\./.test(type),
			),
		).toEqual([]);
		evidence["claude"] = {
			storedEventTypes: claudeState.events.map(({ type }) => type),
			eventProviders: [
				...new Set(claudeState.events.map(({ provider }) => provider)),
			],
			turnStatuses: claudeState.turnStatuses,
		};
		delete evidence["claudeDiagnostic"];

		const releaseModels = await browser.borrowDraftModels("opencode");
		const opencodeModels = await browser
			.getModels("opencode")
			.finally(releaseModels);
		evidence["opencodeCatalog"] = opencodeModels.providers
			.filter(({ configured }) => configured)
			.map(({ id, configured, models }) => ({
				id,
				configured,
				modelCount: models.length,
			}));
		const opencodeModel = opencodeModels.providers
			.filter(({ configured }) => configured)
			.flatMap(({ models }) => models)[0];
		if (!opencodeModel) throw new Error("Missing replay OpenCode model");
		const { sessionId: opencodeId } = await fixture.requestRpc(
			new CreateSession({
				projectSlug: "process-test",
				title: "OpenCode still runs",
				originId: browser.originId,
				providerId: "opencode",
				permissionMode: "ask",
				model: {
					providerId: opencodeModel.provider,
					modelId: opencodeModel.id,
				},
			}),
		);
		const opencode = await browser.send(
			opencodeId,
			"Say hello in one sentence.",
			90_000,
		);
		expect(opencode.done["status"]).toBe("idle");
		expect(opencode.chunks.join("")).not.toBe("");
		await vi.waitFor(() =>
			expect(persisted(fixture, opencodeId).turnStatuses).toEqual([
				"completed",
			]),
		);
		const opencodeState = persisted(fixture, opencodeId);
		expect(
			opencodeState.events.some(({ provider }) => provider === "opencode"),
		).toBe(true);
		expect(
			opencodeState.events.filter(
				({ provider, type }) =>
					provider === "claude" &&
					/^(message|text|thinking|tool|turn)\./.test(type),
			),
		).toEqual([]);
		evidence["opencode"] = {
			storedEventTypes: opencodeState.events.map(({ type }) => type),
			eventProviders: [
				...new Set(opencodeState.events.map(({ provider }) => provider)),
			],
			turnStatuses: opencodeState.turnStatuses,
		};
	}, 240_000);

	it("keeps Cursor defaults separate from Claude across selection, removal and restart", async () => {
		const fixture = await start("per-driver-default-persistence");
		const browser = await fixture.connect();
		const claudeDefault = (await browser.instances()).instances.find(
			({ driver, isDefault }) => driver === "claude" && isDefault,
		)?.id;
		expect(claudeDefault).toBeDefined();
		const first = (
			await fixture.requestRpc(
				new AddInstance({ name: "Cursor A", driver: "cursor" }),
			)
		).addedInstanceId;
		const second = (
			await fixture.requestRpc(
				new AddInstance({ name: "Cursor B", driver: "cursor" }),
			)
		).addedInstanceId;
		if (!first || !second)
			throw new Error("Missing registered Cursor accounts");
		const defaults = async () =>
			(await browser.instances()).instances
				.filter(
					({ driver, isDefault }) =>
						isDefault && (driver === "claude" || driver === "cursor"),
				)
				.map(({ id, driver }) => ({ id, driver }))
				.sort((left, right) =>
					(left.driver ?? "").localeCompare(right.driver ?? ""),
				);
		expect(await defaults()).toEqual([
			{ id: claudeDefault, driver: "claude" },
			{ id: first, driver: "cursor" },
		]);
		await fixture.requestRpc(new SetDefault({ instanceId: second }));
		expect(await defaults()).toEqual([
			{ id: claudeDefault, driver: "claude" },
			{ id: second, driver: "cursor" },
		]);
		await browser.removeInstance(second);
		expect(await defaults()).toEqual([
			{ id: claudeDefault, driver: "claude" },
			{ id: first, driver: "cursor" },
		]);
		const beforeRestart = await defaults();
		await fixture.terminate();
		await fixture.restart({ startupTimeoutMs: 60_000 });
		const restarted = await fixture.connect();
		const afterRestart = (await restarted.instances()).instances
			.filter(
				({ driver, isDefault }) =>
					isDefault && (driver === "claude" || driver === "cursor"),
			)
			.map(({ id, driver }) => ({ id, driver }))
			.sort((left, right) =>
				(left.driver ?? "").localeCompare(right.driver ?? ""),
			);
		expect(afterRestart).toEqual(beforeRestart);
		const config = Either.getOrThrowWith(
			loadDaemonConfigResult(fixture.configDir),
			(error) => error,
		);
		expect(config?.accountDefaults).toMatchObject({
			claude: claudeDefault,
			cursor: first,
		});
		evidence["defaults"] = {
			beforeRestart,
			afterRestart,
			persisted: config?.accountDefaults,
		};
		await restarted.removeInstance(first);
		expect(
			(await restarted.instances()).instances
				.filter(({ driver, isDefault }) => driver === "claude" && isDefault)
				.map(({ id }) => id),
		).toEqual([claudeDefault]);
	}, 180_000);
});
