import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

// A daemon allows a tab 5 sends per 10 seconds. A daemon started by a process
// test with the test SDK module lifts that, so the send-path bench can send in
// bursts (daemon-layers.ts). Failure: the lift is lost and the sixth send of a
// burst is refused as rate limited.
describe("send limit in a process test daemon", () => {
	let harness: ProcessHarness | undefined;
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("accepts more than five sends from one tab inside the window", async () => {
		harness = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Send burst");
		const refused: string[] = [];
		for (let index = 0; index < 6; index++) {
			const result = await Effect.runPromise(
				Effect.result(
					browser.rpc["input.submit"]({
						sessionId,
						originId: browser.originId,
						inputId: randomUUID(),
						delivery: "queue",
						text: `burst ${index}`,
					}),
				),
			);
			if (result._tag === "Failure") refused.push(result.failure.message);
		}
		expect(refused).toEqual([]);
	});
});
