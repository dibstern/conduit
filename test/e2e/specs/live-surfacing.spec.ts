// Failure modes: real OpenCode events never reach the transcript, supplied
// verdicts never reach TurnActivity, ordinals drift, final replies become pins,
// or a fresh history subscription loses the pins seen on the open connection.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { Effect } from "effect";
import { DEFAULT_CATEGORY_SET } from "../../../src/lib/contracts/category-set.js";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../src/lib/contracts/message-surfacing.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { createE2EHarness, createSession } from "../helpers/e2e-harness.js";
import { spawnOpenCode } from "../helpers/opencode-spawner.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

test("OpenCode supplied verdicts render pins live and after reload", async ({
	page,
}, testInfo) => {
	test.setTimeout(180_000);
	const projectDir = mkdtempSync(join(tmpdir(), "ahu8-7-live-"));
	const release = join(projectDir, "surfacing-release");
	writeFileSync(
		join(projectDir, "surfacing-gate.mjs"),
		`
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
writeFileSync("surfacing-ready", "ready");
while (!existsSync("surfacing-release")) await setTimeout(50);
console.log("verified");
`,
	);
	// The isolated instance has no configured model, so conduit has no default
	// pick to create a session with. Name one of OpenCode's free models.
	const spawned = await spawnOpenCode({
		timeoutMs: 60_000,
		env: { OPENCODE_CONFIG_CONTENT: '{"model":"opencode/big-pickle"}' },
	});
	try {
		const harness = await createE2EHarness({
			opencodeUrl: spawned.url,
			projectDir,
		});
		try {
			const sessionId = await createSession(
				harness.relayPort,
				"opencode",
				undefined,
				"e2e-test",
			);
			harness.trackSession(sessionId);
			await harness.stack.client.session.update(sessionId, {
				permission: [{ permission: "bash", pattern: "*", action: "allow" }],
			});
			// The standalone relay has no daemon settings RPCs. Supply only the
			// opt-in/category settings; all session traffic uses the real relay.
			await page.routeWebSocket(/\/rpc(?:\?|$)/, (ws) => {
				const server = ws.connectToServer();
				ws.onMessage((message) => {
					if (typeof message === "string") {
						const frame = JSON.parse(message) as {
							_tag?: string;
							id?: string;
							tag?: string;
						};
						if (
							frame._tag === "Request" &&
							(frame.tag === "GetMessageSurfacing" ||
								frame.tag === "GetCategorySet")
						) {
							ws.send(
								JSON.stringify({
									_tag: "Exit",
									requestId: frame.id,
									exit: {
										_tag: "Success",
										value:
											frame.tag === "GetCategorySet"
												? DEFAULT_CATEGORY_SET
												: {
														...DEFAULT_MESSAGE_SURFACING_SETTINGS,
														enabled: true,
														active: true,
														key: { source: "stored", rejected: false },
													},
									},
								}),
							);
							return;
						}
					}
					server.send(message);
				});
			});
			const app = new AppPage(page);
			await app.goto(`${harness.relayBaseUrl}/s/${sessionId}`);
			await app.sendMessage(
				"Follow these steps exactly. First say 'Should I widen the change?' in a plain text message, then run the Bash command pwd. Next say 'Changing scope could break callers.' in a plain text message, then run the Bash command node surfacing-gate.mjs. The gate is part of the rendering test and will be released by the test. Finally say 'Finished the review.' Do not combine the tool calls. Do not edit files.",
			);
			const chat = new ChatPage(page);
			await expect
				.poll(() => existsSync(join(projectDir, "surfacing-ready")), {
					timeout: 90_000,
				})
				.toBe(true);
			await expect(page.getByTestId("turn-live-head")).toBeVisible();
			await expect(chat.stopBtn).toBeVisible();
			const messages = await harness.stack.client.session.messages(sessionId);
			const assistantParts = messages
				.filter(({ role }) => role === "assistant")
				.flatMap((message) =>
					(message.parts ?? []).map((part) => ({
						messageId: message.id,
						part,
					})),
				);
			const text = assistantParts.flatMap((entry, index) => {
				const value = entry.part["text"];
				return entry.part.type === "text" &&
					typeof value === "string" &&
					value.trim()
					? [{ ...entry, text: value, index }]
					: [];
			});
			expect(
				text.length,
				"the real provider must emit two messages before the held tool",
			).toBeGreaterThanOrEqual(2);
			const intermediate = text.slice(0, 2);
			for (const entry of intermediate) {
				expect(
					assistantParts
						.slice(entry.index + 1)
						.some(({ part }) => part.type === "tool"),
				).toBe(true);
			}
			await expect(page.getByTestId("surfacing-pin-1")).toHaveCount(0);
			await expect(page.getByTestId("surfacing-pin-2")).toHaveCount(0);
			// ahu8.4 is NO-GO. Only verdicts are supplied explicitly, using real
			// provider message/part ids and the production commit/project/publish seam.
			const verdicts = intermediate.map(({ messageId, part }, index) => ({
				messageId,
				partId: part.id,
				ordinal: index + 1,
				categorySetVersion: 1,
				model: "jev-test",
				probabilities: index === 0 ? { ask: 1 } : { risk: 1 },
			}));
			await harness.stack.effectRuntime.runtime.runPromise(
				Effect.gen(function* () {
					const commit = yield* makeCommitAndSignal;
					yield* commit(
						verdicts.map((verdict) =>
							canonicalEvent("text.surfaced", sessionId, verdict, {
								provider: "conduit",
							}),
						),
					);
				}),
			);
			const capture = async (phase: string) => {
				const lane = page.getByTestId("surfacing-pins");
				await expect(lane.locator("button[data-surface-part]")).toHaveCount(2);
				for (const verdict of verdicts) {
					const pin = page.getByTestId(`surfacing-pin-${verdict.ordinal}`);
					await expect(pin).toBeVisible();
					await expect(pin).toHaveAttribute(
						"data-surface-part",
						`${verdict.messageId}/${verdict.partId}`,
					);
					await pin.click();
					const card = page.getByTestId("surfacing-msg-card");
					await expect(card).toHaveAttribute(
						"data-ordinal",
						String(verdict.ordinal),
					);
					await expect(card).toContainText(
						intermediate[verdict.ordinal - 1]?.text ?? "missing text",
					);
				}
				const shot = testInfo.outputPath(`ahu8-7-${phase}.png`);
				await page.screenshot({ path: shot, fullPage: true });
				await testInfo.attach(`ahu8-7-${phase}`, {
					path: shot,
					contentType: "image/png",
				});
				return lane.locator("button[data-surface-part]").evaluateAll((pins) =>
					pins.map((pin) => ({
						id: pin.getAttribute("data-testid"),
						part: pin.getAttribute("data-surface-part"),
						x: pin.getAttribute("data-x"),
					})),
				);
			};
			const live = await capture("live");
			writeFileSync(release, "release");
			await chat.waitForStreamingComplete(90_000);
			await expect(page.locator("#messages")).toContainText(
				"Finished the review.",
			);
			await page.reload();
			await app.layout.waitFor({ state: "attached" });
			await app.connectOverlay.waitFor({ state: "detached" });
			await expect(page.locator("#messages")).toContainText(
				"Finished the review.",
			);
			const reloaded = await capture("reloaded");
			expect(reloaded.map(({ id, part }) => ({ id, part }))).toEqual(
				live.map(({ id, part }) => ({ id, part })),
			);
			const report = testInfo.outputPath("ahu8-7-rendered-pins.json");
			writeFileSync(
				report,
				JSON.stringify(
					{
						sessionId,
						opencodeUrl: spawned.url,
						verdicts,
						live,
						reloaded,
						messages: await harness.stack.client.session.messages(sessionId),
					},
					null,
					2,
				),
			);
			await testInfo.attach("ahu8-7-rendered-pins.json", {
				path: report,
				contentType: "application/json",
			});
		} finally {
			writeFileSync(release, "release");
			await harness.stop();
		}
	} finally {
		spawned.stop();
		rmSync(projectDir, { recursive: true, force: true });
	}
});
