import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Fiber, Schema, Stream } from "effect";
import type { SessionInfo } from "../../../src/lib/contracts/ws-rpc.js";
import { formatSnoozeTime } from "../../../src/lib/frontend/utils/format.js";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";
import { PermissionPage } from "../page-objects/permission.page.js";

// Failures: the agent reuses the old native session, receives unbounded history
// or general tool results, loses the first request, or exposes hidden context.
const firstPrompt = "approval-account-switch-history";
const recentPrompt = "Keep the established plan in mind.";
const currentPrompt =
	"Continue with the next step.\nKeep this request verbatim.";
const omittedAssistantMarker = "OMIT-THIS-ASSISTANT-CONTEXT";
const generalToolResult = "ACCOUNT-SWITCH-GENERAL-TOOL-RESULT";
const handoffMarker = "[Conduit context handoff]";

test.use({
	harnessOptions: {
		// The fake SDK writes limit transcripts and gates beside the proof file.
		restartProof: true,
		continuationSweepIntervalMs: 1000,
		capabilityAgents: [
			{ id: "default", name: "Default" },
			{ id: "reviewer", name: "Reviewer" },
		],
	},
});

/** A runner that outlived a restart reports to the old server, so read its marks from the proof file. */
const readProofMarks = (root: string): ProcessMark[] =>
	existsSync(join(root, "sdk-proof.ndjson"))
		? readFileSync(join(root, "sdk-proof.ndjson"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as ProcessMark)
		: [];

for (const dismiss of [false, true]) {
	test(
		dismiss
			? "scenario 7: DismissCutOff removes the hidden note from the next send"
			: "scenarios 1 and 6: a mid-turn limit is projected once and typing continues on account 1 with a hidden note",
		async ({ page, harness }, testInfo) => {
			test.setTimeout(120_000);
			const artifacts = resolve(
				"test-results/account-switch",
				`${testInfo.project.name}-${dismiss ? "dismiss" : "limited"}-${testInfo.retry}`,
			);
			mkdirSync(artifacts, { recursive: true });
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			const browser = await harness.connect();
			const accounts: { id: string; configDir: string }[] = [];
			for (const name of ["Account 1", "Account 2"]) {
				const configDir = mkdtempSync(join(harness.root, "limited-account-"));
				const added = await Effect.runPromise(
					browser.rpc.AddInstance({ name, driver: "claude", configDir }),
				);
				if (!added.addedInstanceId)
					throw new Error(`No instance ID for ${name}`);
				accounts.push({ id: added.addedInstanceId, configDir });
			}
			const account = accounts[0];
			if (!account) throw new Error("Account 1 was not registered");
			const directory = mkdtempSync(join(harness.root, "limited-project-"));
			const { savedSlug: slug } = await Effect.runPromise(
				browser.rpc.SaveProject({
					folders: [directory],
					instanceId: account.id,
				}),
			);
			if (!slug) throw new Error("No project slug");
			const observed: { sequence: number; session: SessionInfo }[] = [];
			const subscription = Effect.runFork(
				Stream.runForEach(
					browser.rpc.SubscribeShell({ projectSlug: slug }),
					(envelope) =>
						Effect.sync(() => {
							if (envelope._tag === "snapshot")
								for (const session of envelope.rows)
									observed.push({ sequence: envelope.sequence, session });
							if (envelope._tag === "upsert")
								observed.push({
									sequence: envelope.sequence,
									session: envelope.item,
								});
						}),
				),
			);
			const snapshot = () =>
				Effect.runPromise(
					browser.rpc.SubscribeShell({ projectSlug: slug }).pipe(
						Stream.take(1),
						Stream.runCollect,
						Effect.map((envelopes) => Array.from(envelopes)[0]),
					),
				);
			try {
				await app.goto(`${harness.baseUrl}/?p=${encodeURIComponent(slug)}`);
				await page.locator("#new-session-btn:visible").click();
				const picker = page.locator(
					'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
				);
				await picker.click();
				await page.getByTestId("picker-row-harness").click();
				await page.getByTestId(`picker-instance-${account.id}`).click();
				await page.keyboard.press("Escape");
				const cutOffText =
					"usage-limit-account-1: keep working on the original request";
				await app.sendMessage(cutOffText);
				await expect(page).toHaveURL(/\/s\/[^/?]+/);
				const sessionId = new URL(page.url()).pathname.split("/").at(-1);
				if (!sessionId) throw new Error("No session ID in browser URL");
				await expect
					.poll(
						() =>
							observed.filter((row) => row.session.id === sessionId).at(-1)
								?.session.limitRecovery,
					)
					.toEqual({
						instanceId: account.id,
						rateLimitType: "seven_day",
						resetsAt: 1791370800,
						cutOffMessageId: expect.any(String),
						rearms: 0,
						continued: false,
					});
				await chat.waitForStreamingComplete();
				await expect
					.poll(() =>
						harness.marks.some(
							(mark) => mark.kind === "usage-limit" && mark.phase === "limited",
						),
					)
					.toBe(true);
				await chat.expandTurnActivity();
				await expect(chat.toolBlocks.last()).toHaveAttribute(
					"data-tool-status",
					"completed",
				);
				await expect(chat.messagesContainer).not.toContainText(
					"You've hit your limit",
				);
				await expect(
					chat.userMessages.last().locator(".whitespace-pre-wrap"),
				).toHaveText(cutOffText);
				const strip = page.getByTestId("usage-limit-strip");
				const cutOffTag = page.getByTestId("cut-off-tag");
				await test.step("limited-session strip and cut-off tag", async () => {
					const phone = testInfo.project.name === "mobile";
					const resets = `resets ${formatSnoozeTime(1791370800 * 1000)}`;
					await expect(strip.getByTestId("usage-limit-title")).toHaveText(
						phone ? "Usage limit reached" : "Usage limit reached · Account 1",
					);
					await expect(strip.getByTestId("usage-limit-detail")).toHaveText(
						phone ? `Account 1 · ${resets}` : `Weekly limit · ${resets}`,
					);
					await expect(cutOffTag).toHaveCount(1);
					await expect(
						chat.userMessages.last().getByTestId("cut-off-tag"),
					).toHaveText(
						phone
							? "⏸ Cut off · Dismiss"
							: "⏸ Cut off by usage limit · Dismiss",
					);
					await page.screenshot({ path: join(artifacts, "01-limited.png") });
				});
				const before = await snapshot();
				writeFileSync(join(harness.root, "release-limit-repeats"), "release");
				await expect
					.poll(() =>
						harness.marks.some(
							(mark) =>
								mark.kind === "usage-limit" && mark.phase === "repeated",
						),
					)
					.toBe(true);
				const after = await snapshot();
				// These isolated rejected background notices must not advance the
				// client read-model cursor at all, proving they appended no new limit.
				expect(before?._tag).toBe("snapshot");
				expect(after).toEqual(before);
				writeFileSync(
					join(artifacts, "duplicate-limit-client-snapshots.json"),
					JSON.stringify({ before, after }, null, 2),
				);
				if (dismiss) {
					await page.getByTestId("cut-off-dismiss").click();
					await expect(cutOffTag).toHaveCount(0);
					await expect(strip).toBeVisible();
					const dismissed = await snapshot();
					if (dismissed?._tag !== "snapshot")
						throw new Error("No session snapshot after Dismiss");
					expect(
						dismissed.rows.find((row) => row.id === sessionId)?.limitRecovery,
					).toEqual({
						instanceId: account.id,
						rateLimitType: "seven_day",
						resetsAt: 1791370800,
						rearms: 0,
						continued: false,
					});
					// Repeated Dismiss is an error-free no-op through the same RPC.
					await Effect.runPromise(
						browser.rpc.DismissCutOff({ projectSlug: slug, sessionId }),
					);
				}
				const typedText = dismiss
					? "Continue after Dismiss."
					: "Continue while limited.";
				await app.sendMessage(typedText);
				await expect
					.poll(
						() =>
							harness
								.claudeOptions()
								.find((call) => call.prompt?.endsWith(typedText)),
						{ timeout: 5000 },
					)
					.toBeDefined();
				const sent = harness
					.claudeOptions()
					.find((call) => call.prompt?.endsWith(typedText));
				expect(sent?.configDir).toBe(account.configDir);
				expect(sent?.prompt?.startsWith("[Conduit still-open note]")).toBe(
					!dismiss,
				);
				if (dismiss) expect(sent?.prompt).toBe(typedText);
				await expect(
					chat.userMessages.last().locator(".whitespace-pre-wrap"),
				).toHaveText(typedText);
				await expect(chat.messagesContainer).not.toContainText(
					"[Conduit still-open note]",
				);
				await expect(chat.assistantMessages.last()).toContainText(
					`done(${typedText})`,
				);
				await chat.waitForStreamingComplete();
				await expect
					.poll(
						() =>
							observed.filter((row) => row.session.id === sessionId).at(-1)
								?.session.limitRecovery,
					)
					.toBeNull();
				await expect(strip).toHaveCount(0);
				await expect(cutOffTag).toHaveCount(0);
				await page.screenshot({ path: join(artifacts, "02-replied.png") });
				const mark = harness.marks.find(
					(mark) => mark.kind === "usage-limit" && mark.phase === "limited",
				);
				if (mark?.kind !== "usage-limit")
					throw new Error("No native limit transcript mark");
				const native: unknown = JSON.parse(
					readFileSync(
						join(
							harness.root,
							`provisional-limit-native-${mark.sessionId}.json`,
						),
						"utf8",
					),
				);
				expect(native).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							type: "user",
							message: {
								role: "user",
								content: [{ type: "text", text: cutOffText }],
							},
						}),
					]),
				);
				writeFileSync(
					join(artifacts, "provisional-native-transcript.json"),
					JSON.stringify(native, null, 2),
				);
				await page.reload();
				await app.connectOverlay.waitFor({ state: "detached" });
				await expect(chat.messagesContainer).not.toContainText(
					"You've hit your limit",
				);
				await expect(
					chat.userMessages.locator(".whitespace-pre-wrap"),
				).toHaveText([cutOffText, typedText]);
			} finally {
				writeFileSync(
					join(artifacts, "sdk-calls.json"),
					JSON.stringify(harness.claudeOptions(), null, 2),
				);
				writeFileSync(
					join(artifacts, "client-session-rows.json"),
					JSON.stringify(observed, null, 2),
				);
				await Effect.runPromise(Fiber.interrupt(subscription));
			}
		},
	);
}

// Failures: retry adds a user bubble, loses the native resume ID, caches a
// refusal, blocks on an inconclusive probe, appends events before a gate, or
// ignores a fresh limit before the resumed turn produces a reply.
for (const decision of [
	"available",
	"relapsed",
	"fail",
	"hang",
	"limited",
	"unavailable",
	"busy",
	"stale",
] as const) {
	test(`Try again through RPC: ${decision}`, async ({
		page,
		harness,
	}, testInfo) => {
		test.setTimeout(120_000);
		const app = new AppPage(page);
		const strip = page.getByTestId("usage-limit-strip");
		const tryAgain = page.getByTestId("usage-limit-try-again");
		const artifacts = resolve(
			"test-results/account-switch",
			`${testInfo.project.name}-continue-${decision}-${testInfo.retry}`,
		);
		mkdirSync(artifacts, { recursive: true });
		const browser = await harness.connect();
		const configDir = mkdtempSync(join(harness.root, "retry-account-"));
		const { addedInstanceId } = await Effect.runPromise(
			browser.rpc.AddInstance({
				name: "Retry account",
				driver: "claude",
				configDir,
			}),
		);
		if (!addedInstanceId) throw new Error("No retry account ID");
		const instanceId = Schema.decodeUnknownSync(
			Schema.String.pipe(Schema.brand("ProviderInstanceId")),
		)(addedInstanceId);
		const directory = mkdtempSync(join(harness.root, "retry-project-"));
		const { savedSlug: projectSlug } = await Effect.runPromise(
			browser.rpc.SaveProject({ folders: [directory], instanceId }),
		);
		if (!projectSlug) throw new Error("No retry project slug");
		// Session creation resolves the account from daemon.json, which reaches
		// disk only after 500 ms without project RPCs (each one bumps lastUsed
		// and restarts that debounce), so wait without sending any.
		await expect
			.poll(
				() =>
					existsSync(join(harness.configDir, "daemon.json")) &&
					JSON.parse(
						readFileSync(join(harness.configDir, "daemon.json"), "utf8"),
					).instances?.some(
						(instance: { id: string }) => instance.id === instanceId,
					),
			)
			.toBe(true);
		const { sessionId } = await Effect.runPromise(
			browser.rpc.CreateSession({
				projectSlug,
				originId: browser.originId,
				instanceId,
				model: { modelId: "harness", providerId: "claude" },
			}),
		);
		const observed: { sequence: number; session: SessionInfo }[] = [];
		const subscription = Effect.runFork(
			Stream.runForEach(
				browser.rpc.SubscribeShell({ projectSlug }),
				(envelope) =>
					Effect.sync(() => {
						if (envelope._tag === "snapshot")
							for (const session of envelope.rows)
								observed.push({ sequence: envelope.sequence, session });
						if (envelope._tag === "upsert")
							observed.push({
								sequence: envelope.sequence,
								session: envelope.item,
							});
					}),
			),
		);
		const snapshot = () =>
			Effect.runPromise(
				browser.rpc.SubscribeShell({ projectSlug }).pipe(
					Stream.take(1),
					Stream.runCollect,
					Effect.map((envelopes) => Array.from(envelopes)[0]),
				),
			);
		const latest = () =>
			observed.filter((row) => row.session.id === sessionId).at(-1)?.session;
		const cutOffText =
			"usage-limit-account-1-no-reset: finish the original request";
		const evidence: Record<string, unknown> = {};
		try {
			// Release background duplicates before taking stable gate snapshots.
			writeFileSync(join(harness.root, "release-limit-repeats"), "release");
			await Effect.runPromise(
				browser.rpc.SendMessage({
					projectSlug,
					sessionId,
					text: cutOffText,
					commandId: `cut-off-${decision}`,
					originId: browser.originId,
				}),
			);
			await expect
				.poll(() => latest()?.limitRecovery)
				.toEqual({
					instanceId,
					rateLimitType: "seven_day",
					cutOffMessageId: expect.any(String),
					rearms: 0,
					continued: false,
				});
			await expect.poll(() => latest()?.status).toBe("idle");
			const cutOffMessageId = latest()?.limitRecovery?.cutOffMessageId;
			if (!cutOffMessageId) throw new Error("No open cut-off");
			// The success and the probe refusal are also driven from the strip.
			if (decision === "available" || decision === "limited") {
				await app.goto(
					`${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(projectSlug)}`,
				);
				await expect(page.getByTestId("usage-limit-detail")).toHaveText(
					testInfo.project.name === "mobile"
						? "Retry account · reset time unavailable"
						: "Reset time unavailable",
				);
				await expect(tryAgain).toHaveText("Try again");
				await page.screenshot({
					path: join(artifacts, "01-no-reset-strip.png"),
				});
			}
			await expect
				.poll(() =>
					harness.marks.some(
						(mark) => mark.kind === "usage-limit" && mark.phase === "repeated",
					),
				)
				.toBe(true);
			const native = harness.marks.find(
				(mark) => mark.kind === "usage-limit" && mark.phase === "limited",
			);
			if (native?.kind !== "usage-limit")
				throw new Error("No native cut-off session");
			if (decision === "busy") {
				await Effect.runPromise(
					browser.rpc.SendMessage({
						projectSlug,
						sessionId,
						text: "upgrade-long-turn",
						commandId: "held-turn",
						originId: browser.originId,
					}),
				);
				await expect.poll(() => latest()?.status).toBe("busy");
				await expect
					.poll(() =>
						harness.marks.some(
							(mark) =>
								mark.kind === "emit" &&
								mark.prompt.endsWith("upgrade-long-turn"),
						),
					)
					.toBe(true);
				const heldDelta = harness.marks.find(
					(mark) =>
						mark.kind === "emit" && mark.prompt.endsWith("upgrade-long-turn"),
				);
				if (heldDelta?.kind !== "emit") throw new Error("No held turn delta");
				// Its first delta must be committed before comparing gate snapshots.
				await expect
					.poll(async () =>
						JSON.stringify(
							(
								await Effect.runPromise(
									browser.rpc.LoadMoreHistory({ projectSlug, sessionId }),
								)
							).messages,
						),
					)
					.toContain(heldDelta.text);
			}
			writeFileSync(
				join(configDir, "conduit-test-quota"),
				["fail", "hang", "limited", "unavailable"].includes(decision)
					? decision
					: "available",
			);
			writeFileSync(join(harness.root, "hold-continuation"), "hold");
			if (decision === "relapsed")
				writeFileSync(join(harness.root, "limit-continuation"), "limit");
			const before = await snapshot();
			const started = Date.now();
			if (decision === "available") await tryAgain.click();
			const result =
				decision === "available"
					? undefined
					: await Effect.runPromise(
							browser.rpc
								.ContinueSession({
									projectSlug,
									sessionId,
									instanceId,
									expectedInstanceId:
										decision === "stale" ? "stale-account" : instanceId,
									originId: browser.originId,
								})
								.pipe(Effect.either),
						);
			evidence["before"] = before;
			evidence["result"] = result;
			evidence["elapsedMs"] = Date.now() - started;
			if (!["busy", "stale"].includes(decision))
				await expect
					.poll(() =>
						harness.marks.find(
							(mark) =>
								mark.kind === "usage-probe" && mark.configDir === configDir,
						),
					)
					.toMatchObject({
						behavior: ["fail", "hang", "limited", "unavailable"].includes(
							decision,
						)
							? decision
							: "available",
					});
			const refusal = {
				limited: "AccountUnavailable",
				unavailable: "AccountUnavailable",
				busy: "SessionBusy",
				stale: "StaleSwitch",
			};
			if (decision in refusal) {
				expect(result?._tag).toBe("Left");
				if (result?._tag !== "Left") throw new Error("Expected refusal");
				expect(result.left._tag).toBe(
					refusal[decision as keyof typeof refusal],
				);
				const after = await snapshot();
				expect(after).toEqual(before);
				evidence["after"] = after;
				if (decision === "limited") {
					await tryAgain.click();
					await expect(
						page.locator('.toast-card[data-variant="error"]'),
					).toContainText(result.left.message);
					await expect(strip).toBeVisible();
					await expect(tryAgain).toBeEnabled();
					await page.screenshot({ path: join(artifacts, "02-refused.png") });
				}
				expect(
					harness
						.claudeOptions()
						.some((call) => call.prompt === "Continue where you left off."),
				).toBe(false);
			} else {
				if (result) expect(result._tag).toBe("Right");
				if (decision === "hang")
					expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
				await expect.poll(() => latest()?.limitRecovery?.continued).toBe(true);
				expect(latest()?.limitRecovery?.cutOffMessageId).toBe(cutOffMessageId);
				if (decision === "available") {
					// The continuation runs: the strip stays, its button goes.
					await expect(tryAgain).toHaveCount(0);
					await expect(strip).toBeVisible();
				}
				await expect
					.poll(() =>
						harness
							.claudeOptions()
							.find((call) => call.prompt === "Continue where you left off."),
					)
					.toMatchObject({ configDir });
				await expect
					.poll(() =>
						harness.marks.find(
							(mark) =>
								mark.kind === "enqueue" &&
								mark.prompt === "Continue where you left off.",
						),
					)
					.toBeDefined();
				const resumed = harness.marks.find(
					(mark) =>
						mark.kind === "enqueue" &&
						mark.prompt === "Continue where you left off.",
				);
				if (resumed?.kind !== "enqueue")
					throw new Error("No continuation query enqueue");
				const query = harness.marks.find(
					(mark) => mark.kind === "query" && mark.queryId === resumed.queryId,
				);
				expect(query).toMatchObject({ sessionId: native.sessionId });
				const resumeId = harness
					.claudeOptions()
					.find(
						(call) => call.prompt === "Continue where you left off.",
					)?.resumeId;
				// A live query keeps its native ID without another SDK resume launch.
				if (resumeId != null) expect(resumeId).toBe(native.sessionId);
				evidence["nativeQuery"] = query;
				const history = await Effect.runPromise(
					browser.rpc.LoadMoreHistory({ projectSlug, sessionId }),
				);
				evidence["historyBeforeReply"] = history;
				expect(
					JSON.stringify(
						history.messages.filter((message) => message.role === "user"),
					),
				).not.toContain("Continue where you left off.");
				evidence["continued"] = await snapshot();
				writeFileSync(join(harness.root, "release-continuation"), "release");
				if (decision === "relapsed")
					await expect
						.poll(() => latest()?.limitRecovery)
						.toEqual({
							instanceId,
							rateLimitType: "seven_day",
							cutOffMessageId,
							rearms: 0,
							continued: false,
						});
				else await expect.poll(() => latest()?.limitRecovery).toBeNull();
				await expect.poll(() => latest()?.status).toBe("idle");
				evidence["afterReply"] = await snapshot();
				if (decision === "available") {
					const divider = page.getByTestId("transcript-divider");
					const reply = page
						.locator(".msg-assistant")
						.filter({ hasText: "done(Continue where you left off.)" });
					const dividerAboveReply = async (): Promise<void> => {
						await expect(strip).toHaveCount(0);
						await expect(divider).toHaveText(
							"↻ Resumed on Retry account · retried by you",
						);
						await expect(reply).toBeVisible();
						const [dividerBox, replyBox] = await Promise.all([
							divider.boundingBox(),
							reply.boundingBox(),
						]);
						if (!dividerBox || !replyBox)
							throw new Error("No divider or reply box");
						expect(replyBox.y).toBeGreaterThanOrEqual(
							dividerBox.y + dividerBox.height,
						);
					};
					await dividerAboveReply();
					await page.screenshot({ path: join(artifacts, "02-resumed.png") });
					await page.reload();
					await app.connectOverlay.waitFor({ state: "detached" });
					await dividerAboveReply();
					await page.screenshot({
						path: join(artifacts, "03-resumed-after-reload.png"),
					});
				}
			}
		} finally {
			writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			writeFileSync(join(harness.root, "release-continuation"), "release");
			writeFileSync(
				join(artifacts, "continuation-rpc.json"),
				JSON.stringify(evidence, null, 2),
			);
			writeFileSync(
				join(artifacts, "sdk-calls.json"),
				JSON.stringify(harness.claudeOptions(), null, 2),
			);
			writeFileSync(
				join(artifacts, "sdk-marks.json"),
				JSON.stringify(harness.marks, null, 2),
			);
			writeFileSync(
				join(artifacts, "client-session-rows.json"),
				JSON.stringify(observed, null, 2),
			);
			await Effect.runPromise(Fiber.interrupt(subscription));
		}
	});
}

// Failures: scheduling probes quota early; a restart loses the durable schedule;
// cancel or Dismiss loses to the sweep; a resume changes the native account/thread
// or adds a user bubble; still-Limited loops forever or uses the stale reset time.
for (const scenario of [
	"reset",
	"restart",
	"dismiss",
	"limited",
	"cancel",
] as const) {
	const title = {
		reset:
			"scenario 3: resume at reset keeps the config dir and native resume ID",
		restart:
			"scenario 4: a reset passing while the daemon is down resumes on startup",
		dismiss: "scenario 7: Dismiss cancels a scheduled resume",
		limited: "a due resume re-arms from fresh quota at most three times",
		cancel:
			"CancelContinuation restores the plain limited state and is idempotent",
	};
	test(title[scenario], async ({ page, harness }, testInfo) => {
		test.setTimeout(120_000);
		// These drive Resume at reset and Cancel auto-resume from the strip.
		const ui =
			scenario === "reset" || scenario === "restart" || scenario === "cancel";
		const app = new AppPage(page);
		const strip = page.getByTestId("usage-limit-strip");
		const resumeAtReset = page.getByTestId("usage-limit-resume-at-reset");
		const cancelResume = page.getByTestId("usage-limit-cancel-resume");
		const mobile = testInfo.project.name === "mobile";
		const artifacts = resolve(
			"test-results/account-switch",
			`${testInfo.project.name}-scheduled-${scenario}-${testInfo.retry}`,
		);
		mkdirSync(artifacts, { recursive: true });
		let browser = await harness.connect();
		const configDir = mkdtempSync(join(harness.root, "reset-account-"));
		const { addedInstanceId } = await Effect.runPromise(
			browser.rpc.AddInstance({
				name: "Reset account",
				driver: "claude",
				configDir,
			}),
		);
		if (!addedInstanceId) throw new Error("No reset account ID");
		const instanceId = Schema.decodeUnknownSync(
			Schema.String.pipe(Schema.brand("ProviderInstanceId")),
		)(addedInstanceId);
		const directory = mkdtempSync(join(harness.root, "reset-project-"));
		const { savedSlug: projectSlug } = await Effect.runPromise(
			browser.rpc.SaveProject({ folders: [directory], instanceId }),
		);
		if (!projectSlug) throw new Error("No reset project slug");
		// See the Try again setup: wait for daemon.json without sending RPCs.
		await expect
			.poll(
				() =>
					existsSync(join(harness.configDir, "daemon.json")) &&
					JSON.parse(
						readFileSync(join(harness.configDir, "daemon.json"), "utf8"),
					).instances?.some(
						(instance: { id: string }) => instance.id === instanceId,
					),
			)
			.toBe(true);
		const { sessionId } = await Effect.runPromise(
			browser.rpc.CreateSession({
				projectSlug,
				originId: browser.originId,
				instanceId,
				model: { modelId: "harness", providerId: "claude" },
			}),
		);
		const observed: { sequence: number; session: SessionInfo }[] = [];
		const subscribe = () =>
			Effect.runFork(
				Stream.runForEach(
					browser.rpc.SubscribeShell({ projectSlug }),
					(envelope) =>
						Effect.sync(() => {
							if (envelope._tag === "snapshot")
								for (const session of envelope.rows)
									observed.push({ sequence: envelope.sequence, session });
							if (envelope._tag === "upsert")
								observed.push({
									sequence: envelope.sequence,
									session: envelope.item,
								});
						}),
				),
			);
		let subscription = subscribe();
		const latest = () =>
			observed.filter((row) => row.session.id === sessionId).at(-1)?.session;
		const snapshot = () =>
			Effect.runPromise(
				browser.rpc.SubscribeShell({ projectSlug }).pipe(
					Stream.take(1),
					Stream.runCollect,
					Effect.map((envelopes) => Array.from(envelopes)[0]),
				),
			);
		const continuations = () =>
			harness
				.claudeOptions()
				.filter((call) => call.prompt === "Continue where you left off.");
		const probes = () =>
			harness.marks.filter(
				(mark) => mark.kind === "usage-probe" && mark.configDir === configDir,
			);
		const evidence: Record<string, unknown> = {};
		try {
			writeFileSync(join(harness.root, "release-limit-repeats"), "release");
			writeFileSync(join(harness.root, "hold-continuation"), "hold");
			// Loading the page and clicking needs a longer lead before the reset.
			const at = Math.floor(Date.now() / 1000) + (ui ? 20 : 10);
			writeFileSync(join(configDir, "conduit-test-resets-at"), String(at));
			await Effect.runPromise(
				browser.rpc.SendMessage({
					projectSlug,
					sessionId,
					text: "usage-limit-account-1: finish the original request after reset",
					commandId: `cut-off-${scenario}`,
					originId: browser.originId,
				}),
			);
			await expect
				.poll(() => latest()?.limitRecovery)
				.toEqual({
					instanceId,
					rateLimitType: "seven_day",
					resetsAt: at,
					cutOffMessageId: expect.any(String),
					rearms: 0,
					continued: false,
				});
			await expect.poll(() => latest()?.status).toBe("idle");
			await expect
				.poll(() =>
					harness.marks.some(
						(mark) => mark.kind === "usage-limit" && mark.phase === "repeated",
					),
				)
				.toBe(true);
			const native = harness.marks.find(
				(mark) => mark.kind === "usage-limit" && mark.phase === "limited",
			);
			if (native?.kind !== "usage-limit")
				throw new Error("No native cut-off session");
			const limited = latest()?.limitRecovery;
			const historyBefore = await Effect.runPromise(
				browser.rpc.LoadMoreHistory({ projectSlug, sessionId }),
			);
			// Even a known Limited account must be schedulable without a quota probe.
			writeFileSync(join(configDir, "conduit-test-quota"), "limited");
			if (ui) {
				await app.goto(
					`${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(projectSlug)}`,
				);
				await expect(strip).toHaveAttribute("data-state", "limited");
				await resumeAtReset.click();
			} else
				await Effect.runPromise(
					browser.rpc.ContinueSession({
						projectSlug,
						sessionId,
						instanceId,
						expectedInstanceId: instanceId,
						at,
						originId: browser.originId,
					}),
				);
			await expect
				.poll(() => latest()?.limitRecovery)
				.toEqual({ ...limited, scheduledAt: at });
			if (ui) {
				const resetLabel = formatSnoozeTime(at * 1000);
				await expect(strip).toHaveAttribute("data-state", "waiting");
				await expect(page.getByTestId("usage-limit-title")).toHaveText(
					mobile
						? `Resumes ${resetLabel}`
						: `Resumes on Reset account at ${resetLabel}`,
				);
				const countdown = page.getByTestId("usage-limit-detail");
				await expect(countdown).toHaveText(
					mobile ? /^Reset account · in \d+s$/ : /^in \d+s$/,
				);
				// The countdown is derived from the local clock: it ticks with no
				// projection change from the server.
				const shown = await countdown.textContent();
				await expect(countdown).not.toHaveText(shown ?? "");
				expect(latest()?.limitRecovery).toEqual({
					...limited,
					scheduledAt: at,
				});
				await expect(resumeAtReset).toHaveCount(0);
				await expect(cancelResume).toHaveText("Cancel auto-resume");
				await page.screenshot({ path: join(artifacts, "01-waiting.png") });
			}
			expect(probes()).toHaveLength(0);
			expect(continuations()).toHaveLength(0);
			evidence["waiting"] = await snapshot();
			if (scenario !== "limited")
				writeFileSync(join(configDir, "conduit-test-quota"), "available");
			if (scenario === "dismiss" || scenario === "cancel") {
				const request = { projectSlug, sessionId, originId: browser.originId };
				if (scenario === "cancel") await cancelResume.click();
				else await Effect.runPromise(browser.rpc.DismissCutOff(request));
				const { cutOffMessageId: _cutOff, ...dismissed } = limited ?? {};
				await expect
					.poll(() => latest()?.limitRecovery)
					.toEqual(scenario === "dismiss" ? dismissed : limited);
				if (scenario === "cancel") {
					// Back to frame A: the plain limited strip offers Resume at reset again.
					await expect(strip).toHaveAttribute("data-state", "limited");
					await expect(resumeAtReset).toBeEnabled();
					await expect(cancelResume).toHaveCount(0);
					await page.screenshot({ path: join(artifacts, "02-cancelled.png") });
				}
				const cancelled = await snapshot();
				await Effect.runPromise(browser.rpc.CancelContinuation(request));
				expect(await snapshot()).toEqual(cancelled);
				await expect
					.poll(() => Date.now() / 1000, { timeout: 30_000 })
					.toBeGreaterThan(at + 2);
				expect(continuations()).toHaveLength(0);
				expect(probes()).toHaveLength(0);
			} else if (scenario === "limited") {
				// The probe's fresh reset is already due, so each later sweep is quick.
				const freshAt = at - 1;
				writeFileSync(
					join(configDir, "conduit-test-resets-at"),
					String(freshAt),
				);
				await expect
					.poll(() => latest()?.limitRecovery, { timeout: 30_000 })
					.toEqual({ ...limited, rearms: 3 });
				const rearmed = observed
					.filter((row) => row.session.id === sessionId)
					.flatMap((row) =>
						row.session.limitRecovery?.scheduledAt === freshAt
							? [row.session.limitRecovery.rearms]
							: [],
					);
				expect([...new Set(rearmed)]).toEqual([1, 2, 3]);
				expect(probes()).toHaveLength(4);
				expect(continuations()).toHaveLength(0);
			} else {
				if (scenario === "restart") {
					await Effect.runPromise(Fiber.interrupt(subscription));
					await harness.terminate();
					expect(continuations()).toHaveLength(0);
					await expect
						.poll(() => Date.now() / 1000, { timeout: 30_000 })
						.toBeGreaterThan(at);
					// A 60-second recurring sweep cannot satisfy the 30-second
					// assertion below: this must be the pass at relay startup.
					await harness.restart({ continuationSweepIntervalMs: 60_000 });
					browser = await harness.connect(sessionId, undefined, projectSlug);
					subscription = subscribe();
					await app.goto(
						`${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(projectSlug)}`,
					);
				}
				await expect
					.poll(() => latest()?.limitRecovery, { timeout: 30_000 })
					.toEqual({ ...limited, continued: true });
				await expect.poll(continuations).toHaveLength(1);
				expect(continuations()[0]).toMatchObject({ configDir });
				// A runner that outlived a restart reports to the old server, so read
				// every mark from the restart-proof file rather than live IPC.
				const proofMarks = () => readProofMarks(harness.root);
				const continuationEnqueue = () =>
					proofMarks().find(
						(mark) =>
							mark.kind === "enqueue" &&
							mark.prompt === "Continue where you left off.",
					);
				await expect.poll(continuationEnqueue).toBeDefined();
				const resumed = continuationEnqueue();
				if (resumed?.kind !== "enqueue")
					throw new Error("No continuation query enqueue");
				expect(
					proofMarks().find(
						(mark) => mark.kind === "query" && mark.queryId === resumed.queryId,
					),
				).toMatchObject({ sessionId: native.sessionId });
				const resumeId = continuations()[0]?.resumeId;
				if (resumeId != null) expect(resumeId).toBe(native.sessionId);
				const history = await Effect.runPromise(
					browser.rpc.LoadMoreHistory({ projectSlug, sessionId }),
				);
				expect(
					history.messages.filter((message) => message.role === "user"),
				).toEqual(
					historyBefore.messages.filter((message) => message.role === "user"),
				);
				evidence["continued"] = await snapshot();
				evidence["historyBeforeReply"] = history;
				writeFileSync(join(harness.root, "release-continuation"), "release");
				await expect.poll(() => latest()?.limitRecovery).toBeNull();
				await expect.poll(() => latest()?.status).toBe("idle");
				// Frame F: the strip is gone and a divider names the reset, above the reply.
				const resume = latest()?.resumes?.at(-1);
				expect(resume).toMatchObject({ instanceId, reason: "reset" });
				if (!resume) throw new Error("No reset resume");
				const divider = page.getByTestId("transcript-divider");
				const reply = page
					.locator(".msg-assistant")
					.filter({ hasText: "done(Continue where you left off.)" });
				const dividerAboveReply = async (): Promise<void> => {
					await expect(strip).toHaveCount(0);
					await expect(divider).toHaveText(
						`↻ Resumed on Reset account after reset · ${formatSnoozeTime(resume.at)}`,
					);
					await expect(reply).toBeVisible();
					const [dividerBox, replyBox] = await Promise.all([
						divider.boundingBox(),
						reply.boundingBox(),
					]);
					if (!dividerBox || !replyBox)
						throw new Error("No divider or reply box");
					expect(replyBox.y).toBeGreaterThanOrEqual(
						dividerBox.y + dividerBox.height,
					);
				};
				await dividerAboveReply();
				await page.screenshot({
					path: join(artifacts, "02-reset-divider.png"),
				});
				await page.reload();
				await app.connectOverlay.waitFor({ state: "detached" });
				await dividerAboveReply();
				await page.screenshot({
					path: join(artifacts, "03-reset-divider-after-reload.png"),
				});
			}
			evidence["after"] = await snapshot();
		} finally {
			writeFileSync(join(harness.root, "release-continuation"), "release");
			writeFileSync(
				join(artifacts, "scheduled-continuation-rpc.json"),
				JSON.stringify(evidence, null, 2),
			);
			writeFileSync(
				join(artifacts, "sdk-calls.json"),
				JSON.stringify(harness.claudeOptions(), null, 2),
			);
			writeFileSync(
				join(artifacts, "sdk-marks.json"),
				JSON.stringify(harness.marks, null, 2),
			);
			writeFileSync(
				join(artifacts, "client-session-rows.json"),
				JSON.stringify(observed, null, 2),
			);
			await Effect.runPromise(Fiber.interrupt(subscription));
		}
	});
}

// Failures: the setting is on by default or lost on restart; the policy waits for
// a click, schedules a limit with no reset time, schedules on another account,
// loses the mark that tells the strip it was automatic, or never fires at reset.
for (const scenario of ["auto", "restart", "no-reset", "off"] as const) {
	const title = {
		auto: "auto-resume schedules a limit at its reset with no click, and resumes then",
		restart: "auto-resume persists across a daemon restart",
		"no-reset": "auto-resume schedules nothing for a limit with no reset time",
		off: "auto-resume is off by default",
	};
	test(title[scenario], async ({ page, harness }, testInfo) => {
		test.setTimeout(120_000);
		const app = new AppPage(page);
		const strip = page.getByTestId("usage-limit-strip");
		const detail = page.getByTestId("usage-limit-detail");
		const mobile = testInfo.project.name === "mobile";
		const artifacts = resolve(
			"test-results/account-switch",
			`${testInfo.project.name}-auto-resume-${scenario}-${testInfo.retry}`,
		);
		mkdirSync(artifacts, { recursive: true });
		let browser = await harness.connect();
		const daemonJson = () =>
			existsSync(join(harness.configDir, "daemon.json"))
				? JSON.parse(
						readFileSync(join(harness.configDir, "daemon.json"), "utf8"),
					)
				: undefined;
		const defaults = { autoResume: false, autoSwitch: false, order: [] };
		expect(
			(await Effect.runPromise(browser.rpc.GetUsageLimitsSetting({})))
				.usageLimits,
		).toEqual(defaults);
		const configDir = mkdtempSync(join(harness.root, "auto-resume-account-"));
		const { addedInstanceId } = await Effect.runPromise(
			browser.rpc.AddInstance({
				name: "Reset account",
				driver: "claude",
				configDir,
			}),
		);
		if (!addedInstanceId) throw new Error("No auto-resume account ID");
		const instanceId = Schema.decodeUnknownSync(
			Schema.String.pipe(Schema.brand("ProviderInstanceId")),
		)(addedInstanceId);
		const directory = mkdtempSync(join(harness.root, "auto-resume-project-"));
		const { savedSlug: projectSlug } = await Effect.runPromise(
			browser.rpc.SaveProject({ folders: [directory], instanceId }),
		);
		if (!projectSlug) throw new Error("No auto-resume project slug");
		const usageLimits = { ...defaults, autoResume: scenario !== "off" };
		if (scenario !== "off")
			expect(
				await Effect.runPromise(
					browser.rpc.SetUsageLimitsSetting({ usageLimits }),
				),
			).toEqual({ usageLimits });
		// The relay reads the setting and the account from daemon.json, which
		// reaches disk 500 ms after the last settings or project RPC.
		await expect
			.poll(() => {
				const persisted = daemonJson();
				return {
					listed: persisted?.instances?.some(
						(instance: { id: string }) => instance.id === instanceId,
					),
					usageLimits: persisted?.usageLimits ?? defaults,
				};
			})
			.toEqual({ listed: true, usageLimits });
		if (scenario === "restart") {
			await harness.terminate();
			await harness.restart({ continuationSweepIntervalMs: 1000 });
			browser = await harness.connect(undefined, undefined, projectSlug);
			expect(
				(await Effect.runPromise(browser.rpc.GetUsageLimitsSetting({})))
					.usageLimits,
			).toEqual(usageLimits);
		}
		const { sessionId } = await Effect.runPromise(
			browser.rpc.CreateSession({
				projectSlug,
				originId: browser.originId,
				instanceId,
				model: { modelId: "harness", providerId: "claude" },
			}),
		);
		const observed: { sequence: number; session: SessionInfo }[] = [];
		const subscription = Effect.runFork(
			Stream.runForEach(
				browser.rpc.SubscribeShell({ projectSlug }),
				(envelope) =>
					Effect.sync(() => {
						if (envelope._tag === "snapshot")
							for (const session of envelope.rows)
								observed.push({ sequence: envelope.sequence, session });
						if (envelope._tag === "upsert")
							observed.push({
								sequence: envelope.sequence,
								session: envelope.item,
							});
					}),
			),
		);
		const latest = () =>
			observed.filter((row) => row.session.id === sessionId).at(-1)?.session;
		const continuations = () =>
			harness
				.claudeOptions()
				.filter((call) => call.prompt === "Continue where you left off.");
		const evidence: Record<string, unknown> = {};
		try {
			writeFileSync(join(harness.root, "release-limit-repeats"), "release");
			writeFileSync(join(harness.root, "hold-continuation"), "hold");
			// Off schedules nothing, so its reset can be far away.
			const at =
				Math.floor(Date.now() / 1000) + (scenario === "off" ? 3600 : 20);
			writeFileSync(join(configDir, "conduit-test-resets-at"), String(at));
			writeFileSync(join(configDir, "conduit-test-quota"), "available");
			const noReset = scenario === "no-reset";
			await Effect.runPromise(
				browser.rpc.SendMessage({
					projectSlug,
					sessionId,
					text: noReset
						? "usage-limit-account-1-no-reset: finish the original request"
						: "usage-limit-account-1: finish the original request after reset",
					commandId: `cut-off-auto-${scenario}`,
					originId: browser.originId,
				}),
			);
			const limited = {
				instanceId,
				rateLimitType: "seven_day",
				...(noReset ? {} : { resetsAt: at }),
				cutOffMessageId: expect.any(String),
				rearms: 0,
				continued: false,
			};
			await expect
				.poll(() =>
					observed.some(
						(row) =>
							row.session.id === sessionId &&
							row.session.limitRecovery?.cutOffMessageId !== undefined,
					),
				)
				.toBe(true);
			await expect.poll(() => latest()?.status).toBe("idle");
			await app.goto(
				`${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(projectSlug)}`,
			);
			if (scenario === "off" || noReset) {
				// The policy runs right after the limit commits; give it two sweeps.
				const settled = Date.now() / 1000 + 2;
				await expect.poll(() => Date.now() / 1000).toBeGreaterThan(settled);
				expect(latest()?.limitRecovery).toEqual(limited);
				await expect(strip).toHaveAttribute("data-state", "limited");
				await expect(
					page.getByTestId(
						noReset ? "usage-limit-try-again" : "usage-limit-resume-at-reset",
					),
				).toBeEnabled();
				await page.screenshot({ path: join(artifacts, "01-limited.png") });
				expect(continuations()).toHaveLength(0);
				return;
			}
			// Nobody clicks Resume at reset: the policy scheduled it, and says so.
			await expect
				.poll(() => latest()?.limitRecovery)
				.toEqual({ ...limited, scheduledAt: at, auto: true });
			const resetLabel = formatSnoozeTime(at * 1000);
			await expect(strip).toHaveAttribute("data-state", "waiting");
			await expect(page.getByTestId("usage-limit-title")).toHaveText(
				mobile
					? `Resumes ${resetLabel}`
					: `Resumes on Reset account at ${resetLabel}`,
			);
			await expect(detail).toHaveText(
				mobile
					? /^Reset account · in \d+s · auto-resume is on$/
					: /^in \d+s · auto-resume is on$/,
			);
			await expect(page.getByTestId("usage-limit-resume-at-reset")).toHaveCount(
				0,
			);
			await expect(page.getByTestId("usage-limit-cancel-resume")).toBeVisible();
			await page.screenshot({ path: join(artifacts, "01-auto-waiting.png") });
			expect(continuations()).toHaveLength(0);
			await expect
				.poll(() => latest()?.limitRecovery, { timeout: 30_000 })
				.toEqual({ ...limited, continued: true });
			await expect.poll(continuations).toHaveLength(1);
			expect(continuations()[0]).toMatchObject({ configDir });
			await expect
				.poll(() =>
					readProofMarks(harness.root).some(
						(mark) =>
							mark.kind === "enqueue" &&
							mark.prompt === "Continue where you left off.",
					),
				)
				.toBe(true);
			writeFileSync(join(harness.root, "release-continuation"), "release");
			await expect.poll(() => latest()?.limitRecovery).toBeNull();
			const resume = latest()?.resumes?.at(-1);
			expect(resume).toMatchObject({ instanceId, reason: "reset" });
			if (!resume) throw new Error("No reset resume");
			await expect(strip).toHaveCount(0);
			await expect(page.getByTestId("transcript-divider")).toHaveText(
				`↻ Resumed on Reset account after reset · ${formatSnoozeTime(resume.at)}`,
			);
			await expect(
				page
					.locator(".msg-assistant")
					.filter({ hasText: "done(Continue where you left off.)" }),
			).toBeVisible();
			await page.screenshot({ path: join(artifacts, "02-reset-divider.png") });
		} finally {
			writeFileSync(join(harness.root, "release-continuation"), "release");
			evidence["rows"] = observed.filter((row) => row.session.id === sessionId);
			evidence["daemonJson"] = daemonJson();
			writeFileSync(
				join(artifacts, "auto-resume.json"),
				JSON.stringify(evidence, null, 2),
			);
			writeFileSync(
				join(artifacts, "sdk-marks.json"),
				JSON.stringify(readProofMarks(harness.root), null, 2),
			);
			await Effect.runPromise(Fiber.interrupt(subscription));
		}
	});
}

test("scenario 12: changing agents sends a budgeted hidden handoff to a fresh native session", async ({
	page,
	harness,
}, testInfo) => {
	test.setTimeout(120_000);
	const app = new AppPage(page);
	const chat = new ChatPage(page);
	const permissions = new PermissionPage(page);
	const browser = await harness.connect();
	const accounts: { id: string; configDir: string }[] = [];
	const capture = async (step: string): Promise<void> => {
		writeFileSync(
			testInfo.outputPath("sdk-calls.json"),
			JSON.stringify(harness.claudeOptions(), null, 2),
		);
		await page.screenshot({ path: testInfo.outputPath(`${step}.png`) });
	};

	try {
		for (const name of ["Account A", "Account B"]) {
			const configDir = mkdtempSync(join(harness.root, "claude-account-"));
			const added = await Effect.runPromise(
				browser.rpc.AddInstance({ name, driver: "claude", configDir }),
			);
			if (!added.addedInstanceId)
				throw new Error(`AddInstance did not return an ID for ${name}`);
			accounts.push({ id: added.addedInstanceId, configDir });
		}
		const account = accounts[0];
		if (!account) throw new Error("Account A was not registered");
		const directory = mkdtempSync(join(harness.root, "handoff-project-"));
		const { savedSlug: slug } = await Effect.runPromise(
			browser.rpc.SaveProject({
				folders: [directory],
				instanceId: account.id,
			}),
		);
		if (!slug) throw new Error("SaveProject did not return the project's slug");
		await app.goto(`${harness.baseUrl}/?p=${encodeURIComponent(slug)}`);
		await page.locator("#new-session-btn:visible").click();
		await expect(page).toHaveURL(/\/new\?/);
		const picker = page.locator(
			'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
		);
		await picker.click();
		await page.getByTestId("picker-row-harness").click();
		for (const { id } of accounts)
			await expect(page.getByTestId(`picker-instance-${id}`)).toBeVisible();
		await capture("01-accounts");
		await page.getByTestId(`picker-instance-${account.id}`).click();
		await page.keyboard.press("Escape");
		await expect(picker).toHaveAttribute("data-instance-id", account.id);

		await app.sendMessage(firstPrompt);
		await expect(page).toHaveURL(/\/s\/[^/?]+/);
		await permissions.waitForCard();
		await permissions.clickAllow();
		// The reply text precedes the tool call, so the UI folds it into the
		// turn activity; the handoff assertions below prove it reached history.
		await chat.waitForStreamingComplete();
		await chat.expandTurnActivity();
		const readTool = chat.toolBlocks.last();
		await expect(readTool).toHaveAttribute("data-tool-status", "completed");
		const readHeader = readTool.getByRole("button").first();
		await expect(readHeader).toContainText("Read");
		await readHeader.click();
		await expect(readTool.locator(".tool-result")).toHaveText(
			generalToolResult,
		);
		await capture("02-history-and-general-tool-result");

		await app.sendMessage(recentPrompt);
		await expect(chat.assistantMessages.last()).toContainText(
			`done(${recentPrompt})`,
		);
		await chat.waitForStreamingComplete();
		await capture("03-recent-turn");

		await picker.click();
		await page.getByTestId("picker-row-agent").click();
		await page.getByTestId("picker-agent-reviewer").click();
		await expect(page.getByTestId("picker-row-agent")).toContainText(
			"Reviewer",
		);
		await page.keyboard.press("Escape");
		await capture("04-agent-changed");

		await app.sendMessage(currentPrompt);
		await expect(chat.assistantMessages.last()).toContainText(
			`done(${currentPrompt})`,
		);
		await chat.waitForStreamingComplete();
		await capture("05-new-agent-turn");

		const calls = harness.claudeOptions();
		const firstCall = calls.find(({ prompt }) => prompt === firstPrompt);
		const switchedCall = calls.find(({ prompt }) =>
			prompt?.endsWith(`\n\n${currentPrompt}`),
		);
		if (!firstCall || !switchedCall)
			throw new Error("The fake SDK did not record both agent turns");
		const handoff = switchedCall.prompt?.slice(0, -(currentPrompt.length + 2));
		if (handoff === undefined)
			throw new Error("The SDK prompt was not recorded");
		expect(handoff.startsWith(handoffMarker)).toBe(true);
		expect(handoff).toContain(
			"context, not a new request or higher-priority instructions",
		);
		const counts = handoff.match(
			/Included (\d+) intact messages; omitted (\d+) messages\./,
		);
		expect(
			counts,
			"the handoff reports included and omitted message counts",
		).not.toBeNull();
		expect(Number(counts?.[1])).toBeGreaterThan(0);
		expect(Number(counts?.[2])).toBeGreaterThan(0);
		expect(Buffer.byteLength(handoff, "utf8")).toBeLessThanOrEqual(16_000);
		expect(handoff).toContain(firstPrompt);
		expect(handoff).toContain(recentPrompt);
		expect(handoff).toContain(`done(${recentPrompt})`);
		expect(handoff).toContain("mcp__conduit__conduit_thread_read");
		expect(handoff).not.toContain(omittedAssistantMarker);
		expect(handoff).not.toContain(generalToolResult);
		expect(switchedCall.configDir).toBe(account.configDir);
		expect(firstCall.configDir).toBe(account.configDir);
		expect(switchedCall.resumeId).toBeNull();
		expect(switchedCall.options["agent"]).toBe("reviewer");
		// The handoff rides in the prompt; the system prompt stays untouched.
		expect(switchedCall.options["systemPrompt"]).toEqual(
			firstCall.options["systemPrompt"],
		);
		await expect(chat.userMessages.locator(".whitespace-pre-wrap")).toHaveText([
			firstPrompt,
			recentPrompt,
			currentPrompt,
		]);
		expect(
			await chat.userMessages
				.last()
				.locator(".whitespace-pre-wrap")
				.innerText(),
		).toBe(currentPrompt);
		await expect(chat.messagesContainer).not.toContainText(handoffMarker);
		await page.reload();
		// The phone layout has no status dot; the overlay leaves once connected.
		await app.connectOverlay.waitFor({ state: "detached" });
		await expect(chat.userMessages.locator(".whitespace-pre-wrap")).toHaveText([
			firstPrompt,
			recentPrompt,
			currentPrompt,
		]);
		expect(
			await chat.userMessages
				.last()
				.locator(".whitespace-pre-wrap")
				.innerText(),
		).toBe(currentPrompt);
		await expect(chat.messagesContainer).not.toContainText(handoffMarker);
		await capture("06-reloaded-visible-history");
	} finally {
		writeFileSync(
			testInfo.outputPath("sdk-calls.json"),
			JSON.stringify(harness.claudeOptions(), null, 2),
		);
	}
});

test("scenario 13: the new agent reads omitted history through the registered MCP tool", async ({
	page,
	harness,
}, testInfo) => {
	test.setTimeout(120_000);
	const app = new AppPage(page);
	const chat = new ChatPage(page);
	const permissions = new PermissionPage(page);
	const browser = await harness.connect();
	const historyPrompts = [
		"approval-thread-read-history-1",
		"approval-thread-read-history-2",
	];
	const readPrompt = "thread-read-omitted-history";
	const toolName = "mcp__conduit__conduit_thread_read";
	const artifacts = join(
		"test-results",
		"account-switch",
		`thread-read-${testInfo.project.name}-retry-${testInfo.retry}`,
	);
	mkdirSync(artifacts, { recursive: true });
	const sdkMarks = () =>
		(harness.proof() as { marks: ProcessMark[] }).marks.filter(
			(mark) => mark.kind === "mcp-tools" || mark.kind === "mcp-tool-call",
		);
	const capture = async (step: string): Promise<void> => {
		writeFileSync(
			join(artifacts, "sdk-calls.json"),
			JSON.stringify(harness.claudeOptions(), null, 2),
		);
		writeFileSync(
			join(artifacts, "mcp-calls.json"),
			JSON.stringify(sdkMarks(), null, 2),
		);
		await page.screenshot({ path: join(artifacts, `${step}.png`) });
	};

	try {
		const configDir = mkdtempSync(join(harness.root, "thread-read-account-"));
		const { addedInstanceId } = await Effect.runPromise(
			browser.rpc.AddInstance({ name: "Reader", driver: "claude", configDir }),
		);
		if (!addedInstanceId) throw new Error("The Claude account was not added");
		const directory = mkdtempSync(join(harness.root, "thread-read-project-"));
		const { savedSlug: slug } = await Effect.runPromise(
			browser.rpc.SaveProject({
				folders: [directory],
				instanceId: addedInstanceId,
			}),
		);
		if (!slug) throw new Error("SaveProject did not return the project's slug");
		await app.goto(`${harness.baseUrl}/?p=${encodeURIComponent(slug)}`);
		await page.locator("#new-session-btn:visible").click();
		await expect(page).toHaveURL(/\/new\?/);
		const picker = page.locator(
			'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
		);
		await picker.click();
		await page.getByTestId("picker-row-harness").click();
		await page.getByTestId(`picker-instance-${addedInstanceId}`).click();
		await page.keyboard.press("Escape");

		for (const [index, prompt] of historyPrompts.entries()) {
			await app.sendMessage(prompt);
			await permissions.waitForCard();
			await permissions.clickAllow();
			await chat.waitForStreamingComplete();
			await capture(`01-history-${index + 1}`);
		}
		await app.sendMessage(recentPrompt);
		await expect(chat.assistantMessages.last()).toContainText(
			`done(${recentPrompt})`,
		);
		await chat.waitForStreamingComplete();
		await picker.click();
		await page.getByTestId("picker-row-agent").click();
		await page.getByTestId("picker-agent-reviewer").click();
		await expect(page.getByTestId("picker-row-agent")).toContainText(
			"Reviewer",
		);
		await page.keyboard.press("Escape");
		await app.sendMessage(readPrompt);
		await expect(chat.assistantMessages.last()).toContainText(
			`done(${readPrompt})`,
		);
		await chat.waitForStreamingComplete();
		await capture("02-history-read-and-turn-completed");

		const calls = harness.claudeOptions();
		const readerCall = calls.find(({ prompt }) =>
			prompt?.endsWith(`\n\n${readPrompt}`),
		);
		if (!readerCall?.prompt)
			throw new Error("The reader SDK call was not recorded");
		const handoff = readerCall.prompt.slice(0, -(readPrompt.length + 2));
		expect(
			Number(handoff.match(/omitted (\d+) messages\./)?.[1]),
		).toBeGreaterThanOrEqual(2);
		expect(handoff).toContain(toolName);
		for (const prompt of historyPrompts)
			expect(handoff).not.toContain(`OMIT-${prompt}`);
		expect(readerCall.options["agent"]).toBe("reviewer");
		expect(readerCall.resumeId).toBeNull();
		for (const call of calls.filter(({ prompt }) => prompt !== undefined)) {
			expect(call.options["mcpServers"]).toMatchObject({
				conduit: { type: "sdk", name: "conduit" },
			});
			expect(call.options["allowedTools"]).toContain(toolName);
		}

		const marks = sdkMarks();
		const registration = marks.find((mark) => mark.kind === "mcp-tools");
		expect(registration).toMatchObject({
			serverKey: "conduit",
			serverName: "conduit",
			toolNames: [toolName],
		});
		const toolCalls = marks.filter((mark) => mark.kind === "mcp-tool-call");
		expect(toolCalls.length).toBeGreaterThan(7);
		const badCursor = toolCalls.at(-1);
		if (!badCursor) throw new Error("The bad-cursor call was not recorded");
		expect(badCursor.toolName).toBe(toolName);
		expect(badCursor.arguments).toEqual({
			cursor: "invalid-thread-cursor",
			limit: 1,
		});
		expect(badCursor.result.content).toHaveLength(1);
		expect(badCursor.result.content[0]).toMatchObject({ type: "text" });
		const errorText = badCursor.result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		expect(JSON.parse(errorText)).toEqual({
			code: "BadCursor",
			message: expect.any(String),
		});

		const reads = toolCalls.slice(0, -1).map((call) => ({
			call,
			page: JSON.parse(
				call.result.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join(""),
			) as {
				items: { id: string; role: string; text: string; textOffset: number }[];
				nextCursor?: string;
				nextTextOffset?: number;
			},
		}));
		const messages: { id: string; role: string; text: string }[] = [];
		for (const [index, read] of reads.entries()) {
			expect(read.call.toolName).toBe(toolName);
			expect(read.page.items).toHaveLength(1);
			const previous = reads[index - 1];
			expect(read.call.arguments).toEqual(
				previous
					? {
							cursor: previous.page.nextCursor,
							...(previous.page.nextTextOffset === undefined
								? {}
								: { textOffset: previous.page.nextTextOffset }),
							limit: 1,
						}
					: { limit: 1 },
			);
			for (const item of read.page.items) {
				expect(item.text.length).toBeLessThanOrEqual(20_000);
				const message = messages.at(-1);
				if (item.textOffset > 0) {
					if (!message)
						throw new Error("An offset page arrived without its first chunk");
					expect(item.id).toBe(message.id);
					expect(item.textOffset).toBe(message.text.length);
					message.text += item.text;
				} else {
					expect(messages.map(({ id }) => id)).not.toContain(item.id);
					messages.push({ id: item.id, role: item.role, text: item.text });
				}
			}
		}
		expect(reads.at(-1)?.page.nextCursor).toBeUndefined();
		const textMessages = messages.filter(({ text }) => text.length > 0);
		expect(textMessages.map(({ role }) => role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
		]);
		expect(textMessages[0]?.text).toContain(historyPrompts[0]);
		expect(textMessages[1]?.text).toContain(
			`OMIT-${historyPrompts[0]} `.repeat(900),
		);
		expect(textMessages[2]?.text).toContain(historyPrompts[1]);
		expect(textMessages[3]?.text).toContain(
			`OMIT-${historyPrompts[1]} `.repeat(900),
		);
		expect(textMessages[4]?.text).toBe(recentPrompt);
		expect(textMessages[5]?.text).toContain(`done(${recentPrompt})`);
		expect(textMessages[6]?.text).toBe(readPrompt);
		expect(messages.map(({ text }) => text).join("\n")).not.toContain(
			generalToolResult,
		);
		await expect(chat.userMessages.locator(".whitespace-pre-wrap")).toHaveText([
			...historyPrompts,
			recentPrompt,
			readPrompt,
		]);
		await expect(chat.messagesContainer).not.toContainText(handoffMarker);
	} finally {
		writeFileSync(
			join(artifacts, "sdk-calls.json"),
			JSON.stringify(harness.claudeOptions(), null, 2),
		);
		writeFileSync(
			join(artifacts, "mcp-calls.json"),
			JSON.stringify(sdkMarks(), null, 2),
		);
	}
});
