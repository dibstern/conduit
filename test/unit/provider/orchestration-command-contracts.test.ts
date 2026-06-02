import { describe, expect, it } from "vitest";
import {
	DURABLE_COMMAND_FINGERPRINT_FIELDS,
	DURABLE_COMMAND_RECEIPT_STATUSES,
	DURABLE_COMMAND_TRANSACTION_ROWS,
} from "../../../src/lib/provider/orchestration-command-contracts.js";

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

	it("names rows owned by the durable command transaction", () => {
		expect(DURABLE_COMMAND_TRANSACTION_ROWS).toEqual([
			"events",
			"command_receipts",
			"provider_command_sessions",
			"provider_command_turns",
			"provider_command_interactions",
			"provider_command_tombstones",
			"provider_command_outbox",
			"provider_command_meta",
		]);
	});

	it("pins effective dispatch fingerprint fields", () => {
		expect(DURABLE_COMMAND_FINGERPRINT_FIELDS).toEqual([
			"commandType",
			"sessionId",
			"providerId",
			"providerInstanceId",
			"runtimeMode",
			"interactionMode",
			"workspaceRoot",
			"promptText",
			"imageDigests",
			"effectiveModel",
			"providerOptions",
			"materialDefaults",
		]);
	});
});
