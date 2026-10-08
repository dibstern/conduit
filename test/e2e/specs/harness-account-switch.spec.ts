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
import { handoffMessagesLine } from "../../../src/lib/frontend/utils/continuation.js";
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

// Failures: an acknowledged account is absent from disk, session creation falls
// back to OpenCode, or the Claude runner uses a different account directory.
test("a just-added Claude account can run a session immediately", async ({
	harness,
}, testInfo) => {
	const browser = await harness.connect();
	const configDir = mkdtempSync(join(harness.root, "immediate-account-"));
	const { addedInstanceId } = await Effect.runPromise(
		browser.rpc.AddInstance({
			name: "Immediate account",
			driver: "claude",
			configDir,
		}),
	);
	if (!addedInstanceId) throw new Error("No immediate account ID");
	const { sessionId } = await Effect.runPromise(
		browser.rpc.CreateSession({
			projectSlug: "process-test",
			instanceId: Schema.decodeUnknownSync(
				Schema.String.pipe(Schema.brand("ProviderInstanceId")),
			)(addedInstanceId),
			model: { modelId: "harness", providerId: "claude" },
			originId: browser.originId,
		}),
	);
	const prompt = "immediate-account-session";
	await Effect.runPromise(
		browser.rpc.SendMessage({
			projectSlug: "process-test",
			sessionId,
			text: prompt,
			commandId: "immediate-account-send",
			originId: browser.originId,
		}),
	);
	await expect
		.poll(() => harness.claudeOptions().find((call) => call.prompt === prompt))
		.toMatchObject({ configDir });
	await expect
		.poll(() => JSON.stringify(readProofMarks(harness.root)))
		.toContain(`done(${prompt})`);
	const history = await Effect.runPromise(
		browser.rpc.LoadMoreHistory({ projectSlug: "process-test", sessionId }),
	);
	expect(history.messages.some((message) => message.role === "assistant")).toBe(
		true,
	);
	await testInfo.attach("immediate-account-session", {
		body: JSON.stringify({
			addedInstanceId,
			sessionId,
			configDir,
			calls: harness.claudeOptions(),
			history,
		}),
		contentType: "application/json",
	});
});

// Failures: a later instance snapshot erases a setting, a getter returns stale
// memory, or a successful settings RPC replies before daemon.json is written.
test("usage limits and auto-settle survive another config save", async ({
	harness,
}, testInfo) => {
	const browser = await harness.connect();
	const usageLimits = {
		autoResume: true,
		autoSwitch: true,
		order: ["config-save-account", "claude"],
	};
	const autoSettleAfterDays = null;
	await Effect.runPromise(browser.rpc.SetUsageLimitsSetting({ usageLimits }));
	await Effect.runPromise(
		browser.rpc.SetAutoSettleSetting({ autoSettleAfterDays }),
	);
	const beforeSave = JSON.parse(
		readFileSync(join(harness.configDir, "daemon.json"), "utf8"),
	) as Record<string, unknown>;
	expect(beforeSave).toMatchObject({ usageLimits, autoSettleAfterDays });
	const { addedInstanceId } = await Effect.runPromise(
		browser.rpc.AddInstance({
			name: "Config save account",
			driver: "claude",
			configDir: mkdtempSync(join(harness.root, "config-save-account-")),
		}),
	);
	expect(addedInstanceId).toBe("config-save-account");
	expect(
		await Effect.runPromise(browser.rpc.GetUsageLimitsSetting({})),
	).toEqual({ usageLimits });
	expect(await Effect.runPromise(browser.rpc.GetAutoSettleSetting({}))).toEqual(
		{ autoSettleAfterDays },
	);
	const afterSave = JSON.parse(
		readFileSync(join(harness.configDir, "daemon.json"), "utf8"),
	) as Record<string, unknown>;
	expect(afterSave).toMatchObject({
		usageLimits,
		autoSettleAfterDays,
		instances: expect.arrayContaining([
			expect.objectContaining({ id: addedInstanceId }),
		]),
	});
	await testInfo.attach("settings-config-save", {
		body: JSON.stringify({ beforeSave, afterSave }),
		contentType: "application/json",
	});
});

// Failures: returning to an account drops its native cursor, repeats delivered
// history, loses the cut-off, previews full history, or loops on a stale cursor.
for (const stale of [false, true]) {
	test(
		stale
			? "scenario 8: switching 1→2→1 with a stale resume ID falls back to a full handoff exactly once"
			: "returning 1→2→1 resumes account 1 with only its undelivered catch-up",
		async ({ page, harness }, testInfo) => {
			test.setTimeout(120_000);
			const artifacts = resolve(
				"test-results/account-switch",
				`${testInfo.project.name}-return-${stale ? "stale" : "valid"}-${testInfo.retry}`,
			);
			mkdirSync(artifacts, { recursive: true });
			const browser = await harness.connect();
			const accounts: { id: string; configDir: string }[] = [];
			for (const name of ["Account 1", "Account 2"]) {
				const configDir = mkdtempSync(join(harness.root, "return-account-"));
				const { addedInstanceId } = await Effect.runPromise(
					browser.rpc.AddInstance({ name, driver: "claude", configDir }),
				);
				if (!addedInstanceId) throw new Error(`No instance ID for ${name}`);
				accounts.push({ id: addedInstanceId, configDir });
			}
			const [account1, account2] = accounts;
			if (!account1 || !account2) throw new Error("Two accounts are required");
			const { savedSlug: projectSlug } = await Effect.runPromise(
				browser.rpc.SaveProject({
					folders: [mkdtempSync(join(harness.root, "return-project-"))],
					instanceId: account1.id,
				}),
			);
			if (!projectSlug) throw new Error("No return project slug");
			await expect
				.poll(() => {
					const file = join(harness.configDir, "daemon.json");
					if (!existsSync(file)) return false;
					const config: { instances?: { id: string }[] } = JSON.parse(
						readFileSync(file, "utf8"),
					);
					return accounts.every((account) =>
						config.instances?.some((instance) => instance.id === account.id),
					);
				})
				.toBe(true);
			const { sessionId } = await Effect.runPromise(
				browser.rpc.CreateSession({
					projectSlug,
					instanceId: Schema.decodeUnknownSync(
						Schema.String.pipe(Schema.brand("ProviderInstanceId")),
					)(account1.id),
					model: { modelId: "harness", providerId: "claude" },
					originId: browser.originId,
				}),
			);
			const observed: SessionInfo[] = [];
			const subscription = Effect.runFork(
				Stream.runForEach(
					browser.rpc.SubscribeShell({ projectSlug }),
					(envelope) =>
						Effect.sync(() => {
							if (envelope._tag === "snapshot") observed.push(...envelope.rows);
							if (envelope._tag === "upsert") observed.push(envelope.item);
						}),
				),
			);
			const latest = () =>
				observed.filter((row) => row.id === sessionId).at(-1);
			const proofMarks = () => readProofMarks(harness.root);
			const send = (text: string, commandId: string) =>
				Effect.runPromise(
					browser.rpc.SendMessage({
						projectSlug,
						sessionId,
						text,
						commandId,
						originId: browser.originId,
					}),
				);
			const switchTo = (instanceId: string, expectedInstanceId: string) =>
				Effect.runPromise(
					browser.rpc.ContinueSession({
						projectSlug,
						sessionId,
						instanceId,
						expectedInstanceId,
						originId: browser.originId,
					}),
				);
			const previewForAccount = (instanceId: string) =>
				Effect.runPromise(
					browser.rpc.PreviewContinuation({
						projectSlug,
						sessionId,
						instanceId,
						originId: browser.originId,
					}),
				);
			const first = "return-account-1-already-delivered";
			const elsewhere = "return-account-2-undelivered-history";
			const cutOff =
				"usage-limit-account-1-no-reset: return to finish this request";
			const evidence: Record<string, unknown> = {};
			try {
				writeFileSync(join(harness.root, "release-limit-repeats"), "release");
				await send(first, "return-first");
				await expect
					.poll(() => JSON.stringify(proofMarks()))
					.toContain(`done(${first})`);
				await expect.poll(() => latest()?.status).toBe("idle");
				// Idle output precedes the completion receipt. Wait through the
				// public planner before switching away or sending another turn.
				await expect
					.poll(() => previewForAccount(account1.id))
					.toMatchObject({ included: 0, omitted: 0 });
				const initialEnqueue = proofMarks().find(
					(mark) => mark.kind === "enqueue" && mark.prompt === first,
				);
				if (initialEnqueue?.kind !== "enqueue")
					throw new Error("No initial enqueue");
				const native = proofMarks().find(
					(mark) =>
						mark.kind === "query" && mark.queryId === initialEnqueue.queryId,
				);
				if (native?.kind !== "query")
					throw new Error("No account 1 native session");
				const delivered = await Effect.runPromise(
					browser.rpc.LoadMoreHistory({ projectSlug, sessionId }),
				);
				await switchTo(account2.id, account1.id);
				await send(elsewhere, "return-elsewhere");
				await expect
					.poll(() => JSON.stringify(proofMarks()))
					.toContain(`done(${elsewhere})`);
				await expect.poll(() => latest()?.status).toBe("idle");
				await send(cutOff, "return-cut-off");
				await expect
					.poll(() => latest()?.limitRecovery?.cutOffMessageId)
					.toBeTruthy();
				await expect.poll(() => latest()?.status).toBe("idle");
				const history = await Effect.runPromise(
					browser.rpc.LoadMoreHistory({ projectSlug, sessionId }),
				);
				const preview = await previewForAccount(account1.id);
				expect(preview.included + preview.omitted).toBe(
					history.messages.length - delivered.messages.length - 1,
				);
				expect(preview.included).toBeGreaterThanOrEqual(2);
				expect(preview.firstMessageIncluded).toBe(false);
				evidence["preview"] = preview;
				writeFileSync(
					join(account1.configDir, "conduit-test-switch-turn"),
					"hold",
				);
				writeFileSync(join(harness.root, "release-switch-turn"), "release");
				if (stale)
					writeFileSync(
						join(harness.root, "rejected-resume-session-id"),
						native.sessionId,
					);
				const beforeReturn = harness.claudeOptions().length;
				await switchTo(account1.id, account2.id);
				const returnedCalls = () => harness.claudeOptions().slice(beforeReturn);
				await expect.poll(returnedCalls).toHaveLength(stale ? 2 : 1);
				const [resumed, fresh] = returnedCalls();
				expect(resumed).toMatchObject({
					configDir: account1.configDir,
					resumeId: native.sessionId,
				});
				expect(resumed?.prompt).toContain(handoffMarker);
				expect(resumed?.prompt).toContain(elsewhere);
				expect(resumed?.prompt).not.toContain(first);
				expect(resumed?.prompt?.endsWith(cutOff)).toBe(true);
				expect(resumed?.prompt?.split(cutOff)).toHaveLength(2);
				if (stale) {
					expect(fresh).toMatchObject({
						configDir: account1.configDir,
						resumeId: null,
					});
					expect(fresh?.prompt).toContain(first);
					expect(fresh?.prompt).toContain(elsewhere);
					expect(fresh?.prompt?.endsWith(cutOff)).toBe(true);
				}
				await expect.poll(() => latest()?.limitRecovery).toBeNull();
				await expect.poll(() => latest()?.status).toBe("idle");
				expect(
					proofMarks().filter((mark) => mark.kind === "resume-rejected"),
				).toHaveLength(stale ? 1 : 0);
				expect(returnedCalls()).toHaveLength(stale ? 2 : 1);
				// A later send proves the successful receipt consumed the catch-up.
				await expect
					.poll(() => previewForAccount(account1.id))
					.toMatchObject({ included: 0, omitted: 0 });
				const next = "return-account-1-after-catch-up";
				await send(next, "return-next");
				await expect
					.poll(() => JSON.stringify(proofMarks()))
					.toContain(`done(${next})`);
				expect(harness.claudeOptions().at(-1)?.prompt).toBe(next);
				const app = new AppPage(page);
				await app.goto(
					`${harness.baseUrl}/s/${sessionId}?p=${encodeURIComponent(projectSlug)}`,
				);
				await expect(page.locator(".msg-user .whitespace-pre-wrap")).toHaveText(
					[first, elsewhere, cutOff, next],
				);
				await expect(new ChatPage(page).messagesContainer).not.toContainText(
					handoffMarker,
				);
				await page.screenshot({ path: join(artifacts, "returned.png") });
			} finally {
				evidence["sdkCalls"] = harness.claudeOptions();
				evidence["sdkMarks"] = proofMarks();
				evidence["sessionRows"] = observed;
				writeFileSync(
					join(artifacts, "return.json"),
					JSON.stringify(evidence, null, 2),
				);
				await Effect.runPromise(Fiber.interrupt(subscription));
				await browser.close();
			}
		},
	);
}

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

// Failures: automatic recovery ignores the saved order or a fresh quota limit;
// a failed probe blocks a usable target; the target's real limit bounces back
// to the source; the continuation loses its automatic reason or cut-off request.
for (const scenario of ["limited", "probe-failed", "ordered"] as const) {
	const title = {
		limited:
			"scenario 5: auto-switch attempts once when the target's real turn is limited",
		"probe-failed":
			"scenario 13: auto-switch passes Unknown quota, then stops on the target's real limit",
		ordered:
			"auto-switch follows the saved account order, skips Limited quota, and records its reason",
	};
	test(title[scenario], async ({ page, harness }, testInfo) => {
		test.setTimeout(120_000);
		const artifacts = resolve(
			"test-results/account-switch",
			`${testInfo.project.name}-auto-switch-${scenario}-${testInfo.retry}`,
		);
		mkdirSync(artifacts, { recursive: true });
		const browser = await harness.connect();
		const accounts: { id: string; configDir: string }[] = [];
		for (const name of scenario === "ordered"
			? ["Account 1", "Account 2", "Account 3"]
			: ["Account 1", "Account 2"]) {
			const configDir = mkdtempSync(join(harness.root, "auto-switch-account-"));
			const { addedInstanceId } = await Effect.runPromise(
				browser.rpc.AddInstance({ name, driver: "claude", configDir }),
			);
			if (!addedInstanceId) throw new Error(`No instance ID for ${name}`);
			accounts.push({ id: addedInstanceId, configDir });
		}
		const [source, target, preferred] = accounts;
		if (!source || !target) throw new Error("Two accounts are required");
		const { savedSlug: projectSlug } = await Effect.runPromise(
			browser.rpc.SaveProject({
				folders: [mkdtempSync(join(harness.root, "auto-switch-project-"))],
				instanceId: source.id,
			}),
		);
		if (!projectSlug) throw new Error("No auto-switch project slug");
		// The ordered scenario turns auto-switch on and saves its order through Settings below.
		const usageLimits = preferred
			? {
					autoResume: false,
					autoSwitch: false,
					order: [target.id, preferred.id],
				}
			: { autoResume: false, autoSwitch: true, order: [target.id, source.id] };
		expect(
			await Effect.runPromise(
				browser.rpc.SetUsageLimitsSetting({ usageLimits }),
			),
		).toEqual({ usageLimits });
		// Wait for persistence without resetting its debounce or retrying creation.
		await expect
			.poll(() => {
				const file = join(harness.configDir, "daemon.json");
				if (!existsSync(file)) return undefined;
				const persisted: {
					instances?: { id: string }[];
					usageLimits?: typeof usageLimits;
				} = JSON.parse(readFileSync(file, "utf8"));
				return {
					listed: accounts.every((account) =>
						persisted.instances?.some((instance) => instance.id === account.id),
					),
					usageLimits: persisted.usageLimits,
				};
			})
			.toEqual({ listed: true, usageLimits });
		const { sessionId } = await Effect.runPromise(
			browser.rpc.CreateSession({
				projectSlug,
				instanceId: Schema.decodeUnknownSync(
					Schema.String.pipe(Schema.brand("ProviderInstanceId")),
				)(source.id),
				model: { modelId: "harness", providerId: "claude" },
				originId: browser.originId,
			}),
		);
		const observed: SessionInfo[] = [];
		const subscription = Effect.runFork(
			Stream.runForEach(
				browser.rpc.SubscribeShell({ projectSlug }),
				(envelope) =>
					Effect.sync(() => {
						if (envelope._tag === "snapshot") observed.push(...envelope.rows);
						if (envelope._tag === "upsert") observed.push(envelope.item);
					}),
			),
		);
		const latest = () => observed.filter((row) => row.id === sessionId).at(-1);
		const proofMarks = () => readProofMarks(harness.root);
		const sessionUrl = `${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(projectSlug)}`;
		const openUsageLimitSettings = async () => {
			await page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", { detail: { tab: "instances" } }),
				),
			);
			const section = page.locator("#usage-limit-settings");
			await expect(section.getByTestId("sortable-row").first()).toBeVisible();
			return section;
		};
		const first = `auto-switch-first-request-${scenario}`;
		const cutOff =
			"usage-limit-account-1-no-reset: finish the original request";
		const send = (text: string, commandId: string) =>
			Effect.runPromise(
				browser.rpc.SendMessage({
					projectSlug,
					sessionId,
					text,
					commandId,
					originId: browser.originId,
				}),
			);
		try {
			writeFileSync(join(harness.root, "release-limit-repeats"), "release");
			writeFileSync(
				join(target.configDir, "conduit-test-quota"),
				scenario === "probe-failed" ? "fail" : "available",
			);
			writeFileSync(
				join(target.configDir, "conduit-test-switch-turn"),
				scenario === "ordered" ? "hold" : "limited",
			);
			if (preferred)
				writeFileSync(
					join(preferred.configDir, "conduit-test-quota"),
					"limited",
				);
			await send(first, `first-auto-${scenario}`);
			await expect
				.poll(() => JSON.stringify(proofMarks()))
				.toContain(`done(${first})`);
			await expect.poll(() => latest()?.status).toBe("idle");
			if (preferred) {
				await new AppPage(page).goto(sessionUrl);
				const settings = await openUsageLimitSettings();
				const autoSwitch = settings.getByRole("switch", {
					name: "Toggle auto-switch account when limited",
				});
				await expect(autoSwitch).toHaveAttribute("aria-checked", "false");
				await autoSwitch.click();
				await expect(autoSwitch).toHaveAttribute("aria-checked", "true");
				const names = settings.getByTestId("usage-limit-account-name");
				await expect(names.nth(0)).toHaveText("Account 2");
				await expect(names.nth(1)).toHaveText("Account 3");
				// Drag Account 3 above Account 2 with the mouse. The rows slide into the
				// saved order as it loads, and hover's stability check can pass mid-slide,
				// so wait for the slide to finish before measuring the handles. The quota
				// probes settle first: they run on, and count, past the reload below.
				await expect(
					settings.locator(
						'[data-testid="quota-meter"][data-state="checking"]',
					),
				).toHaveCount(0);
				await expect
					.poll(() =>
						settings.evaluate(
							(element) => element.getAnimations({ subtree: true }).length,
						),
					)
					.toBe(0);
				const handleBox = async (name: string) => {
					const handle = settings.getByRole("button", {
						name: `Reorder ${name}`,
					});
					await handle.hover();
					const box = await handle.boundingBox();
					if (!box) throw new Error(`No drag handle for ${name}`);
					return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
				};
				const top = await handleBox("Account 2");
				const dragged = await handleBox("Account 3");
				await page.mouse.down();
				await page.mouse.move(dragged.x, top.y - 10, { steps: 12 });
				await page.mouse.up();
				await expect(names.nth(0)).toHaveText("Account 3");
				await expect(names.nth(1)).toHaveText("Account 2");
				const shown = await names.allTextContents();
				await expect
					.poll(() => {
						const persisted: { usageLimits?: typeof usageLimits } = JSON.parse(
							readFileSync(join(harness.configDir, "daemon.json"), "utf8"),
						);
						const saved = persisted.usageLimits;
						return {
							autoSwitch: saved?.autoSwitch,
							first: saved?.order.slice(0, 2),
							length: saved?.order.length,
						};
					})
					.toEqual({
						autoSwitch: true,
						first: [preferred.id, target.id],
						length: shown.length,
					});
				await page.screenshot({
					path: join(artifacts, "settings-reordered.png"),
				});
				await page.reload();
				const reloaded = await openUsageLimitSettings();
				await expect(
					reloaded.getByTestId("usage-limit-account-name"),
				).toHaveText(shown);
				await expect(
					reloaded.getByRole("switch", {
						name: "Toggle auto-switch account when limited",
					}),
				).toHaveAttribute("aria-checked", "true");
				// Opening settings probes every account. Let those probes land before
				// `before` is taken, or they count as auto-switch probes below.
				await expect(
					reloaded.locator(
						'[data-testid="quota-meter"][data-state="checking"]',
					),
				).toHaveCount(0);
				await page.getByTestId("settings-close-btn").click();
				await expect(page.locator("#settings-panel")).toBeHidden();
			}
			const before = proofMarks().length;
			await send(cutOff, `cut-off-auto-switch-${scenario}`);
			await expect.poll(() => latest()?.resumes?.length).toBe(1);
			expect(latest()?.resumes?.[0]).toMatchObject({
				instanceId: target.id,
				reason: "auto-switch",
				at: expect.any(Number),
			});
			if (preferred) {
				// The toast lives seven seconds, so it is checked before anything slower.
				const toast = page
					.locator(".toast-card")
					.filter({ hasText: "Switched to Account 2" });
				await expect(toast).toBeVisible();
				await expect(toast).toContainText(
					/Account 1 reached its (weekly|5-hour|usage) limit\./,
				);
				await toast
					.getByTestId("toast-action")
					.filter({ hasText: "What carried over?" })
					.click();
				const review = page.getByTestId("handoff-dialog");
				await expect(review).toHaveAttribute("data-mode", "review");
				await page.screenshot({
					path: join(artifacts, "auto-switch-toast-review.png"),
				});
				await review.getByTestId("handoff-close").click();
				await expect(review).toHaveCount(0);
			}
			await expect
				.poll(() =>
					harness
						.claudeOptions()
						.filter((call) => call.configDir === target.configDir),
				)
				.toHaveLength(1);
			const switched = harness
				.claudeOptions()
				.find((call) => call.configDir === target.configDir);
			expect(switched?.prompt).toContain(handoffMarker);
			expect(switched?.prompt).toContain(first);
			expect(switched?.prompt).toContain("[Conduit still-open note]");
			expect(switched?.prompt?.endsWith(cutOff)).toBe(true);
			expect(switched?.resumeId).toBeNull();
			expect(
				await Effect.runPromise(
					browser.rpc.GetAgents({ projectSlug, sessionId }),
				),
			).toMatchObject({ instanceId: target.id });
			const probes = () =>
				proofMarks()
					.slice(before)
					.filter((mark) => mark.kind === "usage-probe");
			expect(
				probes().filter((mark) => mark.configDir === target.configDir),
			).toHaveLength(2);
			if (scenario === "probe-failed")
				expect(
					probes().filter((mark) => mark.configDir === target.configDir),
				).toEqual([
					expect.objectContaining({ behavior: "fail" }),
					expect.objectContaining({ behavior: "fail" }),
				]);
			if (preferred) {
				expect(probes().map((mark) => mark.configDir)).toEqual([
					preferred.configDir,
					target.configDir,
					target.configDir,
				]);
				expect(
					harness
						.claudeOptions()
						.some((call) => call.configDir === preferred.configDir),
				).toBe(false);
				writeFileSync(join(harness.root, "release-switch-turn"), "release");
				await expect.poll(() => latest()?.limitRecovery).toBeNull();
				await expect(page.getByTestId("transcript-divider")).toContainText(
					"Continued on Account 2 · auto-switch",
				);
				await page.screenshot({
					path: join(artifacts, "auto-switch-divider.png"),
				});
			} else {
				await expect
					.poll(() => latest()?.limitRecovery)
					.toMatchObject({
						instanceId: target.id,
						cutOffMessageId: expect.any(String),
						continued: false,
					});
				await expect.poll(() => latest()?.status).toBe("idle");
				await new AppPage(page).goto(sessionUrl);
				const strip = page.getByTestId("usage-limit-strip");
				await expect(strip).toBeVisible();
				await expect(strip).toHaveAttribute("data-state", "limited");
				const settled = Date.now() + 2000;
				await expect.poll(() => Date.now()).toBeGreaterThan(settled);
				await expect(strip).toHaveAttribute("data-state", "limited");
				expect(latest()?.limitRecovery?.scheduledAt).toBeUndefined();
				expect(
					probes().some((mark) => mark.configDir === source.configDir),
				).toBe(false);
				await page.screenshot({ path: join(artifacts, "target-limited.png") });
			}
			await expect.poll(() => latest()?.status).toBe("idle");
			expect(latest()?.resumes).toHaveLength(1);
			expect(
				harness
					.claudeOptions()
					.filter((call) => call.configDir === target.configDir),
			).toHaveLength(1);
		} finally {
			writeFileSync(join(harness.root, "release-switch-turn"), "release");
			writeFileSync(
				join(artifacts, "auto-switch.json"),
				JSON.stringify(
					{
						usageLimits,
						observed,
						sdkCalls: harness.claudeOptions(),
						sdkMarks: proofMarks(),
					},
					null,
					2,
				),
			);
			await Effect.runPromise(Fiber.interrupt(subscription));
			await browser.close();
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

// Failures: preview writes or delivers; a refusal changes the session; a switch
// keeps the old runner/config; the cut-off is replayed without its still-open
// note; an interrupted first handoff becomes a receipt; an unknown quota blocks;
// deferred handoff is sent before the next user message; a receipt links to the
// wrong continuation; a concurrent send crosses runner teardown; identity,
// title, settings, or transcript are lost.
for (const behavior of [
	"available",
	"unavailable",
	"die-once",
	"fail",
	"hang",
	"plan-unavailable",
	"no-cut-off",
	"send-during-switch",
	"limited",
	"too-large",
	"fork-before",
	"fork-after",
	"fork-uncovered",
] as const) {
	const scenario = behavior.startsWith("fork-")
		? 11
		: behavior === "unavailable"
			? 9
			: behavior === "die-once"
				? 10
				: behavior === "fail" || behavior === "hang"
					? 13
					: behavior === "plan-unavailable"
						? 14
						: 2;
	// These switch from the strip's picker and confirm; the rest through RPC.
	const viaStrip =
		behavior === "available" ||
		behavior === "unavailable" ||
		behavior === "plan-unavailable";
	test(`scenario ${scenario}: manual account switch through ${viaStrip ? "the strip" : "RPC"} (${behavior})`, async ({
		page,
		harness,
	}, testInfo) => {
		test.setTimeout(120_000);
		const hasCutOff =
			behavior !== "no-cut-off" &&
			behavior !== "send-during-switch" &&
			behavior !== "fork-before" &&
			behavior !== "fork-after";
		const mobile = testInfo.project.name === "mobile";
		const strip = page.getByTestId("usage-limit-strip");
		const artifacts = resolve(
			"test-results/account-switch",
			`${testInfo.project.name}-switch-${behavior}-${testInfo.retry}`,
		);
		mkdirSync(artifacts, { recursive: true });
		const browser = await harness.connect();
		const accounts: { id: string; configDir: string }[] = [];
		for (const name of ["Account 1", "Account 2"]) {
			const configDir = mkdtempSync(join(harness.root, "switch-account-"));
			if (behavior.startsWith("fork-"))
				writeFileSync(join(configDir, "conduit-test-record-forks"), "record");
			const { addedInstanceId } = await Effect.runPromise(
				browser.rpc.AddInstance({ name, driver: "claude", configDir }),
			);
			if (!addedInstanceId) throw new Error(`No instance ID for ${name}`);
			accounts.push({ id: addedInstanceId, configDir });
		}
		const [source, target] = accounts;
		if (!source || !target) throw new Error("Two accounts are required");
		const { savedSlug: projectSlug } = await Effect.runPromise(
			browser.rpc.SaveProject({
				folders: [mkdtempSync(join(harness.root, "switch-project-"))],
				instanceId: source.id,
			}),
		);
		if (!projectSlug) throw new Error("No switch project slug");
		// Project RPCs reset config persistence's debounce. Wait on disk once,
		// without retrying CreateSession or issuing another project RPC.
		await expect
			.poll(() => {
				const file = join(harness.configDir, "daemon.json");
				if (!existsSync(file)) return false;
				const config: { instances?: { id: string }[] } = JSON.parse(
					readFileSync(file, "utf8"),
				);
				return accounts.every((account) =>
					config.instances?.some((instance) => instance.id === account.id),
				);
			})
			.toBe(true);
		const { sessionId } = await Effect.runPromise(
			browser.rpc.CreateSession({
				projectSlug,
				instanceId: Schema.decodeUnknownSync(
					Schema.String.pipe(Schema.brand("ProviderInstanceId")),
				)(source.id),
				model: { modelId: "harness", providerId: "claude" },
				originId: browser.originId,
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
		const snapshot = () =>
			Effect.runPromise(
				browser.rpc.SubscribeShell({ projectSlug }).pipe(
					Stream.take(1),
					Stream.runCollect,
					Effect.map((envelopes) => Array.from(envelopes)[0]),
				),
			);
		const send = (text: string, commandId: string) =>
			Effect.runPromise(
				browser.rpc.SendMessage({
					projectSlug,
					sessionId,
					text,
					commandId,
					originId: browser.originId,
				}),
			);
		const first = `manual-switch-first-request-${behavior}`;
		const cutOff = `usage-limit-account-1-no-reset: finish the original request${behavior === "too-large" ? "x".repeat(150_000) : ""}`;
		const evidence: Record<string, unknown> = {};
		const proofMarks = () => readProofMarks(harness.root);
		try {
			writeFileSync(join(harness.root, "release-limit-repeats"), "release");
			await send(first, `first-${behavior}`);
			await expect
				.poll(() => JSON.stringify(harness.marks))
				.toContain(`done(${first})`);
			await expect.poll(() => latest()?.status).toBe("idle");
			await Effect.runPromise(
				browser.rpc.RenameSession({
					projectSlug,
					sessionId,
					title: "Keep my session title",
				}),
			);
			if (hasCutOff) {
				if (behavior === "fork-uncovered") {
					const oversized = `OVERSIZED-FORK-HISTORY-${"x".repeat(20_000)}`;
					await send(oversized, "oversized-fork-history");
					await expect
						.poll(() => JSON.stringify(proofMarks()))
						.toContain(`done(${oversized})`);
					await expect.poll(() => latest()?.status).toBe("idle");
				}
				await send(cutOff, `cut-off-${behavior}`);
				await expect.poll(() => latest()?.limitRecovery?.continued).toBe(false);
				await expect.poll(() => latest()?.status).toBe("idle");
				await expect
					.poll(() =>
						harness.marks.some(
							(mark) =>
								mark.kind === "usage-limit" && mark.phase === "repeated",
						),
					)
					.toBe(true);
			}
			if (viaStrip) {
				await new AppPage(page).goto(
					`${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(projectSlug)}`,
				);
				await expect(strip).toBeVisible();
				// Clicking in the session view marks it read (ADR-0004), so start
				// read: the refused switch must leave nothing else changed.
				await Effect.runPromise(
					browser.rpc.MarkSessionRead({ projectSlug, sessionId }),
				);
				await expect.poll(() => latest()?.attention).toBe("idle");
			}
			const before = await snapshot();
			const historyBefore = await Effect.runPromise(
				browser.rpc.LoadMoreHistory({ projectSlug, sessionId }),
			);
			expect(
				await Effect.runPromise(
					browser.rpc.GetAgents({ projectSlug, sessionId }),
				),
			).toMatchObject({ instanceId: source.id });
			const callsBefore = harness.claudeOptions().length;
			const preview = await Effect.runPromise(
				browser.rpc
					.PreviewContinuation({
						projectSlug,
						sessionId,
						instanceId: target.id,
						originId: browser.originId,
					})
					.pipe(Effect.either),
			);
			evidence["preview"] = preview;
			expect(await snapshot()).toEqual(before);
			expect(harness.claudeOptions()).toHaveLength(callsBefore);
			if (behavior === "too-large") {
				expect(preview).toMatchObject({
					_tag: "Left",
					left: { _tag: "HandoffTooLarge", message: expect.any(String) },
				});
			} else {
				expect(preview._tag).toBe("Right");
				if (preview._tag !== "Right") throw new Error("Preview failed");
				expect(preview.right).toMatchObject({
					included: expect.any(Number),
					omitted: expect.any(Number),
					firstMessageIncluded: true,
					tokens: expect.any(Number),
				});
				expect(preview.right.included).toBeGreaterThanOrEqual(2);
				expect(preview.right.included + preview.right.omitted).toBe(
					historyBefore.messages.length - (hasCutOff ? 1 : 0),
				);
				expect(preview.right.tokens).toBeGreaterThan(0);
			}
			writeFileSync(
				join(target.configDir, "conduit-test-quota"),
				["fail", "hang", "unavailable", "limited", "plan-unavailable"].includes(
					behavior,
				)
					? behavior
					: "available",
			);
			writeFileSync(
				join(target.configDir, "conduit-test-switch-turn"),
				behavior === "die-once" || behavior === "fork-uncovered"
					? "die-once"
					: behavior === "fail" || behavior === "hang"
						? "limited"
						: "hold",
			);
			const quotas = await Effect.runPromise(
				browser.rpc.QuotaForAccounts({
					projectSlug,
					originId: browser.originId,
				}),
			);
			evidence["quotas"] = quotas;
			const quota = quotas.accounts.find(
				(account) => account.instanceId === target.id,
			)?.quota;
			expect(quota?._tag).toBe(
				["fail", "hang", "plan-unavailable"].includes(behavior)
					? "Unknown"
					: behavior === "unavailable"
						? "Unavailable"
						: behavior === "limited"
							? "Limited"
							: "Available",
			);
			if (quota?._tag === "Available") expect(quota.utilization).toBe(37);
			if (behavior === "send-during-switch")
				writeFileSync(join(source.configDir, "conduit-test-hold-stop"), "hold");
			const continueSession = () =>
				Effect.runPromise(
					browser.rpc
						.ContinueSession({
							projectSlug,
							sessionId,
							instanceId: target.id,
							expectedInstanceId: source.id,
							originId: browser.originId,
						})
						.pipe(Effect.either),
				);
			const switchFromStrip = async () => {
				if (preview._tag !== "Right") throw new Error("Preview failed");
				await page.getByTestId("usage-limit-switch-account").click();
				const row = page.locator(
					`[data-testid="account-switch-option"][data-account="${target.id}"]`,
				);
				await expect(row.getByTestId("quota-meter-caption")).toHaveText(
					behavior === "available"
						? "63% left"
						: behavior === "unavailable"
							? "unavailable"
							: "quota unknown",
				);
				await expect(row).not.toHaveAttribute("data-disabled");
				await page.screenshot({ path: join(artifacts, "01-picker.png") });
				await row.click();
				const dialog = page.getByTestId("handoff-dialog");
				await expect(dialog).toHaveAttribute("data-mode", "confirm");
				await expect(dialog.getByRole("heading", { level: 2 })).toHaveText(
					"Continue on Account 2?",
				);
				// The count the dialog shows is the preview's, the handoff's own budget.
				await expect(page.getByTestId("handoff-message-count")).toHaveText(
					handoffMessagesLine(preview.right, mobile),
				);
				await page.screenshot({ path: join(artifacts, "02-confirm.png") });
				await page.getByTestId("handoff-confirm").click();
				await expect(dialog).toHaveCount(0);
				if (behavior !== "unavailable") {
					await expect(strip).toHaveCount(0);
					return { _tag: "Right" } as const;
				}
				const toast = page.locator('.toast-card[data-variant="error"]');
				await expect(toast).toContainText("Couldn't switch to Account 2");
				await expect(strip).toBeVisible();
				await page.screenshot({ path: join(artifacts, "03-refused.png") });
				// The typed refusal behind the toast; asking again changes nothing either.
				const refused = await continueSession();
				if (refused._tag === "Left")
					await expect(toast).toContainText(refused.left.message);
				return refused;
			};
			const switching = viaStrip ? switchFromStrip() : continueSession();
			let queuedSend: Promise<unknown> | undefined;
			if (behavior === "send-during-switch") {
				await expect
					.poll(() => harness.marks.some((mark) => mark.kind === "stop-held"))
					.toBe(true);
				queuedSend = send(
					"Next user message after switching.",
					"send-during-stop",
				);
				queuedSend.catch((error) => {
					evidence["queuedSendError"] = String(error);
				});
				expect(
					await Promise.race([
						queuedSend.then(() => true),
						new Promise<boolean>((done) => setTimeout(() => done(false), 200)),
					]),
				).toBe(false);
				expect(harness.claudeOptions()).toHaveLength(callsBefore);
				expect(latest()?.resumes ?? []).toHaveLength(0);
				evidence["heldStop"] = await snapshot();
				writeFileSync(join(harness.root, "release-switch-stop"), "release");
			}
			const result = await switching;
			evidence["result"] = result;
			if (["unavailable", "limited", "too-large"].includes(behavior)) {
				expect(result).toMatchObject({
					_tag: "Left",
					left: {
						_tag:
							behavior === "too-large"
								? "HandoffTooLarge"
								: "AccountUnavailable",
						message: expect.any(String),
					},
				});
				expect(await snapshot()).toEqual(before);
				expect(
					await Effect.runPromise(
						browser.rpc.LoadMoreHistory({ projectSlug, sessionId }),
					),
				).toEqual(historyBefore);
				expect(harness.claudeOptions()).toHaveLength(callsBefore);
				return;
			}
			expect(result._tag).toBe("Right");
			expect(
				await Effect.runPromise(
					browser.rpc.GetAgents({ projectSlug, sessionId }),
				),
			).toMatchObject({ instanceId: target.id });
			await expect.poll(() => latest()?.resumes?.length).toBe(1);
			const resume = latest()?.resumes?.[0];
			if (!resume) throw new Error("No durable continuation entry");
			expect(resume).toMatchObject({
				reason: "user",
				instanceId: target.id,
				from: source.id,
				at: expect.any(Number),
			});
			expect(latest()).toMatchObject({
				id: sessionId,
				title: "Keep my session title",
			});
			const receipt = () =>
				Effect.runPromise(
					browser.rpc.GetContinuationHandoff({
						projectSlug,
						sessionId,
						instanceId: target.id,
						at: resume.at,
						originId: browser.originId,
					}),
				);
			// A limited target's turn ends at once, and the limit interceptor keeps
			// it a completed turn, so only the held targets are still undelivered.
			if (behavior !== "fail" && behavior !== "hang")
				expect(await receipt()).toEqual({ handoff: null });
			if (!hasCutOff) {
				if (queuedSend) await queuedSend;
				else {
					expect(harness.claudeOptions()).toHaveLength(callsBefore);
					await send("Next user message after switching.", "deferred-handoff");
				}
			} else if (
				behavior !== "die-once" &&
				behavior !== "fork-uncovered" &&
				behavior !== "fail" &&
				behavior !== "hang"
			) {
				await expect.poll(() => latest()?.limitRecovery?.continued).toBe(true);
			}
			await expect
				.poll(() =>
					harness
						.claudeOptions()
						.filter((call) => call.configDir === target.configDir),
				)
				.toHaveLength(1);
			const switched = harness
				.claudeOptions()
				.find((call) => call.configDir === target.configDir);
			const original = harness
				.claudeOptions()
				.find((call) => call.prompt === first);
			expect(switched?.pid).not.toBe(original?.pid);
			const verifyFork = async (historyAfter: typeof historyBefore) => {
				// Coverage must include both receipt bounds. While account 2's
				// repeated handoff is held, its user message follows account 1's
				// receipt and has no account 2 receipt yet.
				const point =
					behavior === "fork-before"
						? historyBefore.messages.find(
								(message) => message.role === "assistant",
							)
						: behavior === "fork-after"
							? historyAfter.messages
									.filter((message) => message.role === "assistant")
									.at(-1)
							: historyAfter.messages
									.filter((message) => message.role === "user")
									.at(-1);
				if (!point) throw new Error("No fork point");
				const parentEnqueue = proofMarks().find(
					(mark) =>
						mark.kind === "enqueue" &&
						mark.prompt ===
							(behavior === "fork-before" ? first : switched?.prompt),
				);
				const nativeParent = proofMarks().find(
					(mark) =>
						mark.kind === "query" &&
						parentEnqueue?.kind === "enqueue" &&
						mark.queryId === parentEnqueue.queryId,
				);
				if (behavior !== "fork-uncovered" && nativeParent?.kind !== "query")
					throw new Error("No native parent query");
				const fork = await Effect.runPromise(
					browser.rpc.ForkSession({
						projectSlug,
						sessionId,
						messageId: point.id,
						originId: browser.originId,
					}),
				);
				expect(fork.parentId).toBe(sessionId);
				expect(fork.forkMessageId).toBe(point.id);
				const expectedAccount = behavior === "fork-before" ? source : target;
				expect(
					await Effect.runPromise(
						browser.rpc.GetAgents({ projectSlug, sessionId: fork.sessionId }),
					),
				).toMatchObject({ instanceId: expectedAccount.id });
				const forkHistory = await Effect.runPromise(
					browser.rpc.LoadMoreHistory({
						projectSlug,
						sessionId: fork.sessionId,
					}),
				);
				const expectedHistory = historyAfter.messages.slice(
					0,
					historyAfter.messages.findIndex(
						(message) => message.id === point.id,
					) + 1,
				);
				expect(
					forkHistory.messages.map((message) => [message.role, message.text]),
				).toEqual(
					expectedHistory.map((message) => [message.role, message.text]),
				);
				const nativeForks = proofMarks().filter(
					(mark) => mark.kind === "native-fork",
				);
				if (behavior === "fork-uncovered") expect(nativeForks).toHaveLength(0);
				else
					expect(nativeForks).toEqual([
						expect.objectContaining({
							parentSessionId:
								nativeParent?.kind === "query"
									? nativeParent.sessionId
									: undefined,
							sessionId: fork.sessionId,
							configDir: expectedAccount.configDir,
							upToMessageId: point.id,
						}),
					]);
				const forkPrompt = `Continue the ${behavior} fork.`;
				await Effect.runPromise(
					browser.rpc.SendMessage({
						projectSlug,
						sessionId: fork.sessionId,
						text: forkPrompt,
						commandId: `continue-${behavior}`,
						originId: browser.originId,
					}),
				);
				await expect
					.poll(() =>
						harness
							.claudeOptions()
							.find((call) => call.prompt?.endsWith(forkPrompt)),
					)
					.toBeDefined();
				const call = harness
					.claudeOptions()
					.find((call) => call.prompt?.endsWith(forkPrompt));
				expect(call?.configDir).toBe(expectedAccount.configDir);
				if (behavior === "fork-uncovered") {
					expect(call?.resumeId).toBeNull();
					expect(call?.prompt).toContain(handoffMarker);
					expect(call?.prompt).toContain(first);
					expect(call?.prompt).toContain(cutOff);
					expect(call?.prompt).not.toContain("OVERSIZED-FORK-HISTORY");
					expect(call?.prompt).toContain(point.text);
					const hidden = call?.prompt?.split(
						"[End conduit context handoff]",
					)[0];
					expect(
						Buffer.byteLength(`${hidden}[End conduit context handoff]`),
					).toBeLessThanOrEqual(16_000);
					expect(call?.prompt).toMatch(/omitted [1-9]\d* messages/);
				} else {
					expect(call?.resumeId).toBe(fork.sessionId);
					expect(call?.prompt).toBe(forkPrompt);
				}
				evidence["fork"] = {
					fork,
					point,
					history: forkHistory,
					call,
					nativeForks,
				};
			};
			expect(switched?.resumeId).toBeNull();
			expect(switched?.prompt).toContain(handoffMarker);
			expect(switched?.prompt).toContain(first);
			if (hasCutOff) {
				expect(switched?.prompt).toContain("[Conduit still-open note]");
				expect(switched?.prompt).toContain(
					"some of its work may already be done",
				);
				expect(switched?.prompt?.endsWith(cutOff)).toBe(true);
			}
			if (behavior === "fail" || behavior === "hang") {
				await expect
					.poll(() => latest()?.limitRecovery)
					.toMatchObject({
						instanceId: target.id,
						continued: false,
						cutOffMessageId: historyBefore.messages
							.filter((message) => message.role === "user")
							.at(-1)?.id,
					});
				await expect.poll(() => latest()?.status).toBe("idle");
				expect(latest()?.resumes).toHaveLength(1);
				// The limited turn still wrote the handoff into account 2's native
				// session, so a later continuation there resumes it natively.
				expect(await receipt()).toMatchObject({
					handoff: { instanceId: target.id, firstMessageIncluded: true },
				});
			} else {
				if (behavior === "die-once" || behavior === "fork-uncovered") {
					await expect
						.poll(() =>
							harness.marks.some(
								(mark) => mark.kind === "handoff-first-turn-died",
							),
						)
						.toBe(true);
					await expect.poll(() => latest()?.status).toBe("idle");
					expect(await receipt()).toEqual({ handoff: null });
					await send("Recover the interrupted handoff.", "repeat-full-handoff");
					await expect
						.poll(() =>
							harness
								.claudeOptions()
								.filter((call) => call.configDir === target.configDir),
						)
						.toHaveLength(2);
					const repeated = harness
						.claudeOptions()
						.filter((call) => call.configDir === target.configDir)[1];
					expect(repeated?.resumeId).toBeNull();
					expect(repeated?.pid).not.toBe(switched?.pid);
					expect(repeated?.prompt).toContain(first);
					expect(repeated?.prompt).toContain(cutOff);
					expect(repeated?.prompt).toContain(handoffMarker);
				}
				if (behavior === "fork-uncovered")
					await verifyFork(
						await Effect.runPromise(
							browser.rpc.LoadMoreHistory({ projectSlug, sessionId }),
						),
					);
				writeFileSync(join(harness.root, "release-switch-turn"), "release");
				await expect
					.poll(async () => (await receipt()).handoff)
					.toMatchObject({
						instanceId: target.id,
						included: expect.any(Number),
						omitted: expect.any(Number),
						firstMessageIncluded: true,
						tokens: expect.any(Number),
						eventId: expect.any(String),
						at: expect.any(Number),
					});
				if (
					behavior !== "die-once" &&
					behavior !== "fork-uncovered" &&
					preview._tag === "Right"
				) {
					const delivered = (await receipt()).handoff;
					expect(delivered).toMatchObject(preview.right);
				}
				await expect.poll(() => latest()?.limitRecovery).toBeNull();
				await expect.poll(() => latest()?.status).toBe("idle");
				const delivered = await receipt();
				if (viaStrip && delivered.handoff) {
					const divider = page.getByTestId("transcript-divider");
					await expect(divider).toContainText(
						"↪ Continued on Account 2 · switched by you",
					);
					await expect(page.getByTestId("cut-off-tag")).toHaveCount(0);
					await page.screenshot({ path: join(artifacts, "04-switched.png") });
					await page.getByTestId("transcript-divider-handoff").click();
					const summary = page.getByTestId("handoff-dialog");
					await expect(summary).toHaveAttribute("data-mode", "review");
					await expect(summary.getByTestId("handoff-message-count")).toHaveText(
						handoffMessagesLine(delivered.handoff, mobile),
					);
					await expect(summary.getByTestId("handoff-confirm")).toHaveCount(0);
					await page.screenshot({
						path: join(artifacts, "05-carried-over.png"),
					});
					await summary.getByTestId("handoff-close").click();
					await expect(summary).toHaveCount(0);
				}
				const reconnected = await harness.connect();
				try {
					expect(
						await Effect.runPromise(
							reconnected.rpc.GetContinuationHandoff({
								projectSlug,
								sessionId,
								instanceId: target.id,
								at: resume.at,
							}),
						),
					).toEqual(delivered);
				} finally {
					await reconnected.close();
				}
			}
			expect(latest()).toMatchObject({
				id: sessionId,
				title: "Keep my session title",
			});
			const historyAfter = await Effect.runPromise(
				browser.rpc.LoadMoreHistory({ projectSlug, sessionId }),
			);
			// A continuation updates turn timing while preserving the user message.
			for (const message of historyBefore.messages.filter(
				(message) => message.role === "user",
			)) {
				const { turnTiming: _turnTiming, ...originalMessage } = message;
				expect(historyAfter.messages).toContainEqual(
					expect.objectContaining(originalMessage),
				);
			}
			evidence["receipt"] = await receipt();
			if (behavior === "fork-before" || behavior === "fork-after")
				await verifyFork(historyAfter);
		} finally {
			writeFileSync(join(harness.root, "release-switch-stop"), "release");
			writeFileSync(join(harness.root, "release-switch-turn"), "release");
			evidence["observed"] = observed;
			evidence["sdkCalls"] = harness.claudeOptions();
			evidence["sdkMarks"] = harness.marks;
			writeFileSync(
				join(artifacts, "switch-rpc.json"),
				JSON.stringify(evidence, null, 2),
			);
			await Effect.runPromise(Fiber.interrupt(subscription));
			await browser.close();
		}
	});
}

// Story 16. Failures: the pill shows the project's account instead of the
// session's, a pick rebinds the project, or the session stays on account 1.
test("story 16: the session-bar account pill switches the session, not the project", async ({
	page,
	harness,
}, testInfo) => {
	test.setTimeout(120_000);
	const artifacts = resolve(
		"test-results/account-switch",
		`${testInfo.project.name}-session-pill-${testInfo.retry}`,
	);
	mkdirSync(artifacts, { recursive: true });
	const browser = await harness.connect();
	const accounts: { id: string; configDir: string }[] = [];
	for (const name of ["Account 1", "Account 2"]) {
		const configDir = mkdtempSync(join(harness.root, "pill-account-"));
		const { addedInstanceId } = await Effect.runPromise(
			browser.rpc.AddInstance({ name, driver: "claude", configDir }),
		);
		if (!addedInstanceId) throw new Error(`No instance ID for ${name}`);
		accounts.push({ id: addedInstanceId, configDir });
	}
	const [source, target] = accounts;
	if (!source || !target) throw new Error("Two accounts are required");
	const { savedSlug: projectSlug } = await Effect.runPromise(
		browser.rpc.SaveProject({
			folders: [mkdtempSync(join(harness.root, "pill-project-"))],
			instanceId: source.id,
		}),
	);
	if (!projectSlug) throw new Error("No pill project slug");
	const boundInstance = async () =>
		(await Effect.runPromise(browser.rpc.GetProjects({}))).projects.find(
			(project) => project.slug === projectSlug,
		)?.instanceId;
	// Project RPCs reset config persistence's debounce. Wait on disk once,
	// without retrying CreateSession or issuing another project RPC.
	await expect
		.poll(() => {
			const file = join(harness.configDir, "daemon.json");
			if (!existsSync(file)) return false;
			const config: { instances?: { id: string }[] } = JSON.parse(
				readFileSync(file, "utf8"),
			);
			return accounts.every((account) =>
				config.instances?.some((instance) => instance.id === account.id),
			);
		})
		.toBe(true);
	const { sessionId } = await Effect.runPromise(
		browser.rpc.CreateSession({
			projectSlug,
			instanceId: Schema.decodeUnknownSync(
				Schema.String.pipe(Schema.brand("ProviderInstanceId")),
			)(source.id),
			model: { modelId: "harness", providerId: "claude" },
			originId: browser.originId,
		}),
	);
	const observed: SessionInfo[] = [];
	const subscription = Effect.runFork(
		Stream.runForEach(browser.rpc.SubscribeShell({ projectSlug }), (envelope) =>
			Effect.sync(() => {
				if (envelope._tag === "snapshot") observed.push(...envelope.rows);
				if (envelope._tag === "upsert") observed.push(envelope.item);
			}),
		),
	);
	const latest = () => observed.filter((row) => row.id === sessionId).at(-1);
	const send = (text: string, commandId: string) =>
		Effect.runPromise(
			browser.rpc.SendMessage({
				projectSlug,
				sessionId,
				text,
				commandId,
				originId: browser.originId,
			}),
		);
	const first = "session-pill-first-request";
	const evidence: Record<string, unknown> = {};
	try {
		await send(first, "pill-first");
		await expect
			.poll(() => JSON.stringify(harness.marks))
			.toContain(`done(${first})`);
		await expect.poll(() => latest()?.status).toBe("idle");
		writeFileSync(join(target.configDir, "conduit-test-quota"), "available");
		await new AppPage(page).goto(
			`${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(projectSlug)}`,
		);
		const bar = page.getByTestId("session-bar");
		const pill = bar.getByTestId("session-account-pill");
		await expect(pill).toHaveText("Account 1");
		await expect(pill).toHaveAttribute("data-account", source.id);
		// The project's rebind control is not offered on a Claude session.
		await expect(bar.getByTestId("instance-badge")).toHaveCount(0);
		await page.screenshot({ path: join(artifacts, "01-pill.png") });

		await pill.click();
		const row = page.locator(
			`[data-testid="account-switch-option"][data-account="${target.id}"]`,
		);
		await expect(row.getByTestId("quota-meter-caption")).toHaveText("63% left");
		await expect(
			page.locator(
				`[data-testid="account-switch-option"][data-account="${source.id}"]`,
			),
		).toHaveAttribute("data-disabled");
		await page.screenshot({ path: join(artifacts, "02-picker.png") });
		await row.click();
		const dialog = page.getByTestId("handoff-dialog");
		await expect(dialog.getByRole("heading", { level: 2 })).toHaveText(
			"Continue on Account 2?",
		);
		await expect(dialog.getByTestId("handoff-swap")).toContainText("Account 1");
		await page.screenshot({ path: join(artifacts, "03-confirm.png") });
		await dialog.getByTestId("handoff-confirm").click();
		await expect(dialog).toHaveCount(0);

		expect(
			await Effect.runPromise(
				browser.rpc.GetAgents({ projectSlug, sessionId }),
			),
		).toMatchObject({ instanceId: target.id });
		await expect.poll(() => latest()?.resumes?.length).toBe(1);
		expect(latest()?.resumes?.[0]).toMatchObject({
			reason: "user",
			instanceId: target.id,
			from: source.id,
		});
		expect(await boundInstance()).toBe(source.id);
		await expect(pill).toHaveText("Account 2");
		await expect(pill).toHaveAttribute("data-account", target.id);
		await page.screenshot({ path: join(artifacts, "04-switched.png") });

		// The next turn runs on account 2 with the handoff; the project stays on 1.
		await send("Next message on the new account.", "pill-next");
		await expect
			.poll(
				() =>
					harness
						.claudeOptions()
						.filter((call) => call.configDir === target.configDir).length,
			)
			.toBe(1);
		expect(
			harness
				.claudeOptions()
				.find((call) => call.configDir === target.configDir)?.prompt,
		).toContain(handoffMarker);
		expect(await boundInstance()).toBe(source.id);
		evidence["resumes"] = latest()?.resumes;
		evidence["boundInstance"] = await boundInstance();
	} finally {
		evidence["observed"] = observed;
		evidence["sdkCalls"] = harness.claudeOptions();
		evidence["sdkMarks"] = harness.marks;
		writeFileSync(
			join(artifacts, "session-pill-rpc.json"),
			JSON.stringify(evidence, null, 2),
		);
		await Effect.runPromise(Fiber.interrupt(subscription));
		await browser.close();
	}
});
