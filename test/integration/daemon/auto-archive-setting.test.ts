// The Sessions settings tab loads auto-archive with an empty payload, like its siblings.
import { Effect } from "effect";
import { expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

it("reads and writes the auto-archive setting over browser RPC", async () => {
	const harness = await ProcessHarness.start({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
	});
	try {
		const browser = await harness.connect();
		await Effect.runPromise(
			browser.rpc.SetAutoArchiveSetting({ autoArchiveAfterDays: 14 }),
		);
		expect(
			await Effect.runPromise(browser.rpc.GetAutoArchiveSetting({})),
		).toEqual({ autoArchiveAfterDays: 14 });
	} finally {
		await harness.dispose();
	}
});
