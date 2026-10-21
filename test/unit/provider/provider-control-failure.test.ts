import { describe, expect, it } from "vitest";
import {
	OpenCodeApiError,
	OpenCodeConnectionError,
} from "../../../src/lib/errors.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { runnerFailure } from "../../../src/lib/provider/runner/runner-protocol.js";

// Fail closed for errors the adapters do not positively identify as transient.
describe("provider control retry classification", () => {
	it.each([
		[400, false],
		[401, false],
		[404, false],
		[408, true],
		[422, false],
		[429, true],
		[500, true],
		[503, true],
	])("classifies OpenCode HTTP %s as retryable=%s", (responseStatus, retryable) => {
		const failure = new ProviderInstanceFailure({
			providerId: "opencode",
			operation: "resolvePermission",
			cause: new OpenCodeApiError({
				message: "Rejected answer",
				endpoint: "/permission/request",
				responseStatus,
			}),
		});
		expect(failure.retryable).toBe(retryable);
	});

	it("recognizes the OpenCode connection wrapper", () => {
		expect(
			new ProviderInstanceFailure({
				providerId: "opencode",
				operation: "resolveQuestion",
				cause: new OpenCodeConnectionError({ message: "fetch failed" }),
			}).retryable,
		).toBe(true);
	});

	it.each([
		"claude",
		"cursor",
	])("classifies %s runner failures after their production wire conversion", (providerId) => {
		for (const [cause, retryable] of [
			[
				Object.assign(new Error("connect failed"), { code: "ECONNRESET" }),
				true,
			],
			[Object.assign(new Error("connect failed"), { code: "ETIMEDOUT" }), true],
			[
				Object.assign(new Error("deadline exceeded"), { name: "TimeoutError" }),
				true,
			],
			[
				{
					code: "runner_idle_exit",
					message: "Runner is exiting",
					retryable: true,
				},
				true,
			],
			[
				{ code: "runner_recovery_abandoned", message: "Recovery restarted" },
				true,
			],
			[
				{
					code: "runner_quarantined",
					message: "PID still alive",
					retryable: false,
				},
				false,
			],
			[
				{
					code: "provider_process_gone",
					message: "Process replaced",
					retryable: true,
				},
				false,
			],
			[{ message: "Unknown request" }, false],
			[new Error("unclassified"), false],
		] as const) {
			const wire = runnerFailure("resolve-permission", cause);
			const failure = new ProviderInstanceFailure({
				providerId,
				operation: wire.operation,
				cause: Object.assign(new Error(wire.message), wire),
			});
			expect(failure.retryable, wire.message).toBe(retryable);
		}
	});
});
