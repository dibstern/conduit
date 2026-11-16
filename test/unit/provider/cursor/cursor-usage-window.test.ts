import { Deferred, Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageReading } from "../../../../src/lib/contracts/limit-recovery.js";
import {
	emptyAccountUsage,
	settle,
} from "../../../../src/lib/domain/daemon/Services/account-usage.js";
import {
	cursorUsageWindowKind,
	makeCursorUsage,
} from "../../../../src/lib/provider/cursor/cursor-usage.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const END = 1_800_000_000_000;

describe("Cursor plan window", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses the weekly pool unless the billed cycle is longer than eight days", () => {
		expect(cursorUsageWindowKind(END - WEEK_MS, END)).toBe("seven_day");
		expect(cursorUsageWindowKind(END - 30 * 24 * 60 * 60 * 1000, END)).toBe(
			"month",
		);
		expect(cursorUsageWindowKind(Number.NaN, END)).toBe("seven_day");
	});

	it("reads a seven-day dashboard cycle as weekly usage", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					planUsage: { totalPercentUsed: 37 },
					billingCycleStart: String(END - WEEK_MS),
					billingCycleEnd: String(END),
				}),
			),
		);
		const usage = makeCursorUsage({
			getBinding: () => undefined,
			saveBinding: () => Effect.void,
			env: {
				NODE_ENV: "test",
				CONDUIT_TEST_CURSOR_DASHBOARD_URL:
					"http://127.0.0.1/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
			},
		});
		const reading = await Effect.runPromise(
			usage.reader.read({
				id: "cursor",
				harness: "cursor",
				env: { CURSOR_AUTH_TOKEN: "test-token" },
			}),
		);
		expect(reading).toMatchObject({
			status: "available",
			windows: [
				{
					kind: "seven_day",
					utilization: 37,
					resetsAt: new Date(END).toISOString(),
				},
			],
		});
	});

	it("keeps a weekly Cursor meter out of Claude's pace history", async () => {
		const result = await Effect.runPromise(Deferred.make<UsageReading>());
		const startedAt = 1_000;
		const readAt = 2_000;
		const settled = settle(
			{
				...emptyAccountUsage,
				lastAttemptAt: startedAt,
				inFlight: { result, overtaken: false },
			},
			result,
			{
				status: "available",
				windows: [
					{
						kind: "seven_day",
						utilization: 12,
						resetsAt: new Date(readAt + WEEK_MS).toISOString(),
					},
				],
			},
			{ accountId: "cursor", harness: "cursor", readAt, startedAt },
		);
		expect(settled.reading.windows[0]).not.toHaveProperty("history");
		expect(settled.reading.windows[0]).not.toHaveProperty("forecast");
		expect(settled.record.seven_day).toBeUndefined();
	});
});
