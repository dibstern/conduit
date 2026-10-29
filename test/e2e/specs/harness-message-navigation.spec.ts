// Full-session navigation must fetch one target window, not every intervening page.
import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import type { CanonicalEvent } from "../../../src/lib/contracts/stored-event.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

const sessionId = "full-navigation";
const promptCount = 120;
const start = Date.UTC(2026, 9, 27);
const promptId = (index: number) => `prompt-${String(index).padStart(3, "0")}`;

async function seed(filename: string): Promise<void> {
	await Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const events: CanonicalEvent[] = [
				canonicalEvent(
					"session.created",
					sessionId,
					{
						sessionId,
						title: "Full message navigation",
						provider: "claude",
						providerSessionId: sessionId,
					},
					{ provider: "claude", createdAt: start },
				),
			];
			for (let index = 1; index <= promptCount; index++) {
				for (const role of ["user", "assistant"] as const) {
					const id = role === "user" ? promptId(index) : `answer-${index}`;
					const created =
						start + index * 60_000 + (role === "assistant" ? 1000 : 0);
					events.push(
						canonicalEvent(
							"message.snapshot",
							sessionId,
							{
								messageId: id,
								digest: id,
								message: {
									id,
									sessionID: sessionId,
									role,
									...(role === "assistant"
										? { parentID: promptId(index) }
										: {}),
									time: {
										created,
										...(role === "assistant"
											? { completed: created + 1000 }
											: {}),
									},
									parts: [
										{
											id: `${id}-text`,
											type: "text",
											text:
												role === "user"
													? `Prompt ${index}: review this step.`
													: `Answer ${index}.\n\n${"A separate paragraph keeps the transcript scrollable.\n\n".repeat(3)}`,
										},
									],
								},
							},
							{ provider: "claude", createdAt: created },
						),
					);
				}
			}
			yield* commit(events, { publish: false });
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(filename, "process-test")),
		),
	);
}

test("complete prompt rail navigates bounded persisted windows", async ({
	harness,
	page,
}, testInfo) => {
	test.setTimeout(120_000);
	await harness.terminate();
	await seed(harness.daemonStorePath());
	await harness.restart({ keepPort: true });
	const requests: { tag: string; payload: unknown }[] = [];
	page.on("websocket", (socket) =>
		socket.on("framesent", ({ payload }) => {
			const frame: unknown = JSON.parse(payload.toString());
			if (
				typeof frame === "object" &&
				frame !== null &&
				"tag" in frame &&
				typeof frame.tag === "string"
			)
				requests.push({
					tag: frame.tag,
					payload: "payload" in frame ? frame.payload : undefined,
				});
		}),
	);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await new AppPage(page).goto(
		`${harness.baseUrl}/s/${sessionId}?p=process-test`,
	);
	const rail = page.getByRole("slider", { name: "User messages" });
	const messages = page.locator("#messages .msg-user");
	await expect(messages.last()).toContainText("Prompt 120:");
	await expect(rail).toHaveAttribute("aria-valuemax", String(promptCount));
	expect(await messages.count()).toBeLessThanOrEqual(50);
	const initialDetails = requests.filter(
		(request) => request.tag === "SubscribeSessionDetail",
	).length;
	await rail.focus();
	await page.keyboard.press("Home");
	await expect(messages.filter({ hasText: "Prompt 1:" })).toBeInViewport();
	await expect(rail).toHaveAttribute("aria-valuemax", String(promptCount));
	expect(await messages.count()).toBeLessThanOrEqual(50);
	expect(
		requests.filter((request) => request.tag === "SubscribeSessionDetail")
			.length,
	).toBe(initialDetails + 1);
	expect(
		requests.filter((request) => request.tag === "LoadMoreHistory"),
	).toHaveLength(0);
	expect(
		requests
			.filter((request) => request.tag === "SubscribeSessionDetail")
			.at(-1)?.payload,
	).toMatchObject({
		window: { anchorMessageId: promptId(1), direction: "from" },
	});
	await page.screenshot({ path: testInfo.outputPath("historical-window.png") });
	await page.getByTestId("jump-to-latest").click();
	await expect(messages.filter({ hasText: "Prompt 120:" })).toBeInViewport();
	await expect(rail).toHaveAttribute("aria-valuemax", String(promptCount));
	expect(await messages.count()).toBeLessThanOrEqual(50);
	expect(errors).toEqual([]);
	const proof = testInfo.outputPath("navigation-proof.json");
	writeFileSync(
		proof,
		JSON.stringify(
			{
				promptCount,
				finalRenderedPrompts: await messages.count(),
				requests,
				errors,
			},
			null,
			2,
		),
	);
	await testInfo.attach("navigation-proof", {
		path: proof,
		contentType: "application/json",
	});
	await page.screenshot({ path: testInfo.outputPath("latest-window.png") });
});
