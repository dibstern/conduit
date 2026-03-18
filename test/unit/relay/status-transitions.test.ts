import { describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../../../src/lib/instance/opencode-client.js";
import {
	computePollerDecisions,
	computeStatusTransitions,
} from "../../../src/lib/relay/status-transitions.js";

// ─── computeStatusTransitions ────────────────────────────────────────────────

describe("computeStatusTransitions", () => {
	it("detects newly busy sessions", () => {
		const previousBusy = new Set<string>();
		const statuses: Record<string, SessionStatus | undefined> = {
			"session-1": { type: "busy" },
			"session-2": { type: "idle" },
		};

		const result = computeStatusTransitions(previousBusy, statuses);

		expect(result.becameBusy).toEqual(["session-1"]);
		expect(result.becameIdle).toEqual([]);
		expect(result.currentBusy).toEqual(new Set(["session-1"]));
	});

	it("detects sessions that became idle", () => {
		const previousBusy = new Set(["session-1", "session-2"]);
		const statuses: Record<string, SessionStatus | undefined> = {
			"session-1": { type: "idle" },
			"session-2": { type: "busy" },
		};

		const result = computeStatusTransitions(previousBusy, statuses);

		expect(result.becameBusy).toEqual([]);
		expect(result.becameIdle).toEqual(["session-1"]);
		expect(result.currentBusy).toEqual(new Set(["session-2"]));
	});

	it("treats retry as busy", () => {
		const previousBusy = new Set<string>();
		const statuses: Record<string, SessionStatus | undefined> = {
			"session-1": {
				type: "retry",
				attempt: 1,
				message: "retrying",
				next: 500,
			},
		};

		const result = computeStatusTransitions(previousBusy, statuses);

		expect(result.becameBusy).toEqual(["session-1"]);
		expect(result.becameIdle).toEqual([]);
		expect(result.currentBusy).toEqual(new Set(["session-1"]));
	});

	it("no transitions when nothing changed", () => {
		const previousBusy = new Set(["session-1"]);
		const statuses: Record<string, SessionStatus | undefined> = {
			"session-1": { type: "busy" },
			"session-2": { type: "idle" },
		};

		const result = computeStatusTransitions(previousBusy, statuses);

		expect(result.becameBusy).toEqual([]);
		expect(result.becameIdle).toEqual([]);
		expect(result.currentBusy).toEqual(new Set(["session-1"]));
	});

	it("handles empty statuses (all previous become idle)", () => {
		const previousBusy = new Set(["session-1", "session-2"]);
		const statuses: Record<string, SessionStatus | undefined> = {};

		const result = computeStatusTransitions(previousBusy, statuses);

		expect(result.becameBusy).toEqual([]);
		expect(result.becameIdle).toEqual(
			expect.arrayContaining(["session-1", "session-2"]),
		);
		expect(result.becameIdle).toHaveLength(2);
		expect(result.currentBusy).toEqual(new Set());
	});

	it("handles undefined status values", () => {
		const previousBusy = new Set<string>();
		const statuses: Record<string, SessionStatus | undefined> = {
			"session-1": undefined,
			"session-2": { type: "busy" },
		};

		const result = computeStatusTransitions(previousBusy, statuses);

		expect(result.becameBusy).toEqual(["session-2"]);
		expect(result.becameIdle).toEqual([]);
		expect(result.currentBusy).toEqual(new Set(["session-2"]));
	});
});

// ─── computePollerDecisions ──────────────────────────────────────────────────

describe("computePollerDecisions", () => {
	it("stops pollers for idle sessions without viewers", () => {
		const statuses: Record<string, SessionStatus | undefined> = {
			"session-1": { type: "idle" },
		};
		const pollingSessionIds = ["session-1"];
		const hasViewers = vi.fn().mockReturnValue(false);
		const isPolling = vi.fn().mockReturnValue(true);

		const result = computePollerDecisions(
			statuses,
			pollingSessionIds,
			hasViewers,
			isPolling,
		);

		expect(result.toStop).toEqual(["session-1"]);
		expect(result.toClearActivity).toEqual([]);
		expect(result.toStart).toEqual([]);
	});

	it("clears activity for idle sessions WITH viewers", () => {
		const statuses: Record<string, SessionStatus | undefined> = {
			"session-1": { type: "idle" },
		};
		const pollingSessionIds = ["session-1"];
		const hasViewers = vi.fn().mockReturnValue(true);
		const isPolling = vi.fn().mockReturnValue(true);

		const result = computePollerDecisions(
			statuses,
			pollingSessionIds,
			hasViewers,
			isPolling,
		);

		expect(result.toStop).toEqual([]);
		expect(result.toClearActivity).toEqual(["session-1"]);
		expect(result.toStart).toEqual([]);
	});

	it("starts pollers for busy sessions not yet polling", () => {
		const statuses: Record<string, SessionStatus | undefined> = {
			"session-1": { type: "busy" },
		};
		const pollingSessionIds: string[] = [];
		const hasViewers = vi.fn();
		const isPolling = vi.fn().mockReturnValue(false);

		const result = computePollerDecisions(
			statuses,
			pollingSessionIds,
			hasViewers,
			isPolling,
		);

		expect(result.toStop).toEqual([]);
		expect(result.toClearActivity).toEqual([]);
		expect(result.toStart).toEqual(["session-1"]);
	});

	it("does not start poller for session already polling", () => {
		const statuses: Record<string, SessionStatus | undefined> = {
			"session-1": { type: "busy" },
		};
		const pollingSessionIds = ["session-1"];
		const hasViewers = vi.fn();
		const isPolling = vi.fn().mockReturnValue(true);

		const result = computePollerDecisions(
			statuses,
			pollingSessionIds,
			hasViewers,
			isPolling,
		);

		expect(result.toStop).toEqual([]);
		expect(result.toClearActivity).toEqual([]);
		expect(result.toStart).toEqual([]);
	});
});
