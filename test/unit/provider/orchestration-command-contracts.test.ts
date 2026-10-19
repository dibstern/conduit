import { describe, expect, it } from "vitest";
import { DURABLE_COMMAND_RECEIPT_STATUSES } from "../../../src/lib/provider/orchestration-command-contracts.js";

describe("durable provider command contract", () => {
	it("pins receipt statuses", () => {
		expect(DURABLE_COMMAND_RECEIPT_STATUSES).toEqual([
			"accepted",
			"rejected",
			"side_effect_requested",
			"side_effect_completed",
			"side_effect_failed",
		]);
	});
});
