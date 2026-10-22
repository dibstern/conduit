// Failure modes: a history page omits the prompt and sends a display-only turn
// id; a missing turn retries forever; a temporary refusal stops a valid feed.
import { isRecord } from "../../../src/lib/utils.js";
import { surfacingSettingsFixture } from "../fixtures/surfacing-settings.js";
import { seedPagedRecapTurn } from "../helpers/recap-history.js";
import {
	answerSubscribeInstances,
	expect,
	test,
} from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test("a history page without its prompt subscribes to the stored turn", async ({
	page,
	relayUrl,
	harness,
	relayInstances,
}, testInfo) => {
	const { sessionId, turnId } = await seedPagedRecapTurn(harness);
	const surfacing = surfacingSettingsFixture();
	surfacing.stubs.UpdateMessageSurfacing({
		_tag: "UpdateMessageSurfacing",
		summariesEnabled: true,
		recap: { model: "sonnet", when: "on-request" },
	});
	const attempts: unknown[] = [];
	const warnings: string[] = [];
	page.on("console", (message) => {
		const text = message.text();
		if (
			text.includes("feed failed; restarting") &&
			/Unknown turn|RecapFailure|SubscribeRecaps/.test(text)
		)
			warnings.push(text);
	});
	// The replay relay has no daemon settings RPCs. Supply those settings and
	// the fixture's accounts, but send every recap request to the real relay.
	await page.routeWebSocket(/\/rpc(?:\?|$)/, (ws) => {
		const server = ws.connectToServer();
		const answerInstances = answerSubscribeInstances(ws, relayInstances);
		ws.onMessage((data) => {
			if (typeof data !== "string") {
				server.send(data);
				return;
			}
			const decoded: unknown = JSON.parse(data);
			for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
				const encoded = JSON.stringify(frame);
				if (answerInstances(encoded)) continue;
				if (isRecord(frame) && frame["_tag"] === "Request") {
					if (
						frame["tag"] === "GetMessageSurfacing" ||
						frame["tag"] === "GetCategorySet"
					) {
						ws.send(
							JSON.stringify({
								_tag: "Exit",
								requestId: frame["id"],
								exit: {
									_tag: "Success",
									value:
										frame["tag"] === "GetMessageSurfacing"
											? surfacing.settings
											: surfacing.categories,
								},
							}),
						);
						continue;
					}
					if (frame["tag"] === "SubscribeRecaps")
						attempts.push(frame["payload"]);
				}
				server.send(encoded);
			}
		});
		server.onMessage((data) => ws.send(data));
	});
	await new AppPage(page).goto(relayUrl);
	await expect(page.getByText("Next question", { exact: true })).toHaveCount(1);
	await expect(
		page.getByText("Follow-up detail 40.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Review the long turn", { exact: true }),
	).toHaveCount(0);
	await expect(page.locator(".turn-activity")).toHaveCount(1);
	await expect.poll(() => attempts.length).toBeGreaterThan(0);
	// Observe more than the first two retry delays, rather than passing before
	// the first restart. Request counts catch a silent immediate restart too.
	await page.waitForTimeout(3_500);
	await testInfo.attach("recap-feed.json", {
		body: JSON.stringify({ sessionId, turnId, attempts, warnings }, null, 2),
		contentType: "application/json",
	});
	expect(attempts).toEqual([{ sessionId, turnId }]);
	expect(warnings).toEqual([]);
});
