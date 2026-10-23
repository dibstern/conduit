// Failures: unbounded Wait, missing failed transcript placement, duplicate timeout
// logging, background teardown, missing draft, or duplicate resend intake.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect, Fiber, Stream } from "effect";
import { expect, it, vi } from "vitest";
import type { InputDraftEnvelope } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type ProcessMark,
	taskStopFixture,
} from "../../helpers/fake-claude-process-sdk.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

it.each([
	false,
	true,
])("bounds folder admission and restores a resendable draft without ending background work (newer draft: %s)", async (withNewerDraft) => {
	const harness = ProcessHarness.create({
		dist: "dist",
		restartProof: true,
		logLevel: "warn",
	});
	const observations: Record<string, unknown> = {
		reason: "foldersPending",
		withNewerDraft,
	};
	let db: Database.Database | undefined;
	let subscription: Fiber.Fiber<void, unknown> | undefined;
	const sdkMarks = (): ProcessMark[] => {
		const path = join(harness.root, "sdk-proof.ndjson");
		return existsSync(path)
			? readFileSync(path, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as ProcessMark)
			: [];
	};
	try {
		await harness.restart();
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Send admission proof");
		await browser.preWarmSession(sessionId);
		observations["sessionId"] = sessionId;
		db = new Database(harness.daemonStorePath(), { readonly: true });
		const foreground = browser.send(sessionId, "task-stop-foreground-idle");
		void foreground.catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(
					sdkMarks().some(
						(mark) =>
							mark.kind === "task-stop-turn" && mark.phase === "streaming",
					),
				).toBe(true),
			{ timeout: 10_000 },
		);
		writeFileSync(join(harness.root, "task-stop-release-result"), "release");
		await foreground;
		await vi.waitFor(() =>
			expect(
				sdkMarks().some(
					(mark) =>
						mark.kind === "task-stop-turn" && mark.phase === "after-result",
				),
			).toBe(true),
		);
		const extra = join(harness.root, "extra");
		mkdirSync(extra);
		await Effect.runPromise(
			browser.rpc.SaveProject({
				slug: "process-test",
				folders: [harness.projectDir, extra],
			}),
		);
		const viewer = await harness.connect(sessionId);
		const drafts: InputDraftEnvelope[] = [];
		subscription = Effect.runFork(
			Stream.runForEach(
				viewer.rpc.SubscribeInputDraft({ key: { session: sessionId } }),
				(draft) =>
					Effect.sync(() => {
						drafts.push(draft);
					}),
			),
		);
		await vi.waitFor(() => expect(drafts).toHaveLength(1));
		const before = await Effect.runPromise(
			viewer.rpc.ListDaemonSessions({ projectSlug: "process-test" }),
		);
		const tasksBefore = before.sessions.find(
			(session) => session.id === sessionId,
		)?.backgroundTasks;
		expect(tasksBefore).toHaveLength(taskStopFixture.length);
		observations["backgroundTasksBefore"] = tasksBefore;
		const inputId = randomUUID();
		const text = "m1it resend after folders settle";
		const restoredText = withNewerDraft ? `${text}\n\nnewer draft` : text;
		const sentAt = Date.now();
		expect(
			await Effect.runPromise(
				viewer.rpc["input.submit"]({
					sessionId,
					originId: viewer.originId,
					inputId,
					text,
					delivery: "queue",
				}),
			),
		).toMatchObject({ ok: true });
		if (withNewerDraft) {
			await Effect.runPromise(
				viewer.rpc.SyncInputDraft({
					key: { session: sessionId },
					text: "newer draft",
					originId: viewer.originId,
				}),
			);
		}
		await vi.waitFor(
			() =>
				expect(drafts).toContainEqual({ _tag: "draft", text: restoredText }),
			{ timeout: 2_000, interval: 10 },
		);
		observations["refusedAfterMs"] = Date.now() - sentAt;
		expect(observations["refusedAfterMs"]).toBeGreaterThanOrEqual(900);
		expect(observations["refusedAfterMs"]).toBeLessThan(2_000);
		expect(
			db
				.prepare<[string], { state: string }>(
					"SELECT state FROM pending_inputs WHERE input_id = ?",
				)
				.get(inputId)?.state,
		).toBe("removed");
		const refusal = db
			.prepare<[string], Record<string, unknown>>(
				"SELECT status, error_code FROM provider_command_outbox WHERE command_id = ?",
			)
			.get(inputId);
		expect(refusal).toMatchObject({
			status: "failed",
			error_code: "send_admission_timeout",
		});
		observations["refusal"] = refusal;
		const errors = db
			.prepare<[string], { data: string }>(
				"SELECT data FROM events WHERE session_id = ? AND type = 'turn.error' AND json_extract(data, '$.code') = 'send_admission_timeout'",
			)
			.all(sessionId)
			.map((row) => JSON.parse(row.data) as Record<string, unknown>);
		expect(errors).toEqual([
			expect.objectContaining({
				messageId: inputId,
				error: expect.stringContaining("foldersPending"),
				code: "send_admission_timeout",
			}),
		]);
		observations["failureEvents"] = errors;
		const failedMessages = (await viewer.history(sessionId)).filter(
			(message) => message.role === "user" && message.inputId === inputId,
		);
		expect(failedMessages).toHaveLength(1);
		expect(failedMessages[0]?.parts).toContainEqual(
			expect.objectContaining({ type: "text", text }),
		);
		observations["failedUserMessages"] = failedMessages;
		const logs = harness.logTail
			.split("\n")
			.filter(
				(line) =>
					line.includes("send_admission_timeout") &&
					line.includes(`inputId=${inputId}`),
			);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain(`sessionId=${sessionId}`);
		expect(logs[0]).toContain("reason=foldersPending");
		observations["admissionLogs"] = logs;
		observations["drafts"] = drafts;
		expect(
			sdkMarks().filter(
				(mark) => mark.kind === "enqueue" && mark.request === text,
			),
		).toEqual([]);
		expect(
			sdkMarks().filter((mark) =>
				["query-interrupted", "query-closed"].includes(mark.kind),
			),
		).toEqual([]);
		const after = await Effect.runPromise(
			viewer.rpc.ListDaemonSessions({ projectSlug: "process-test" }),
		);
		const tasksAfter = after.sessions.find(
			(session) => session.id === sessionId,
		)?.backgroundTasks;
		expect(tasksAfter).toEqual(tasksBefore);
		observations["backgroundTasksAfter"] = tasksAfter;
		observations["sdkBeforeResend"] = sdkMarks();
		await Effect.runPromise(
			viewer.rpc.SaveProject({
				slug: "process-test",
				folders: [harness.projectDir],
			}),
		);
		writeFileSync(join(harness.root, "task-stop-confirm-all"), "release");
		writeFileSync(join(harness.root, "task-stop-release-input"), "release");
		const resendBrowser = await harness.connect(sessionId);
		const resent = await resendBrowser.send(sessionId, restoredText);
		expect(resent.chunks.join("")).toBe(responseChunks(restoredText).join(""));
		observations["resendReply"] = resent.chunks.join("");
		expect(
			sdkMarks().filter(
				(mark) => mark.kind === "enqueue" && mark.request === restoredText,
			),
		).toHaveLength(1);
		observations["sdkAfterResend"] = sdkMarks();
	} finally {
		if (subscription) await Effect.runPromise(Fiber.interrupt(subscription));
		db?.close();
		observations["logTail"] = harness.logTail.slice(-6000);
		await harness.dispose();
		harness.assertNoRunners();
		observations["cleanup"] = harness.proof();
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			`test-results/m1it-send-admission${withNewerDraft ? "-newer-draft" : ""}.json`,
			JSON.stringify(observations, null, 2),
		);
	}
}, 60_000);
