import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({
	rpc: vi.fn<() => Promise<void>>(),
}));
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rpc,
}));

let requestSessionPreWarm: typeof import("../../../src/lib/frontend/utils/session-prewarm.js").requestSessionPreWarm;

beforeEach(async () => {
	vi.useFakeTimers();
	vi.resetModules();
	rpc.mockReset().mockResolvedValue(undefined);
	({ requestSessionPreWarm } = await import(
		"../../../src/lib/frontend/utils/session-prewarm.js"
	));
});
afterEach(() => vi.useRealTimers());

describe("session pre-warm requests", () => {
	it("coalesces session open and repeated composer focus", async () => {
		requestSessionPreWarm("project", "session");
		requestSessionPreWarm("project", "session");
		await vi.advanceTimersByTimeAsync(99);
		expect(rpc).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(rpc).toHaveBeenCalledExactlyOnceWith("PreWarmSession", {
			projectSlug: "project",
			sessionId: "session",
		});
		requestSessionPreWarm("project", "session");
		await vi.advanceTimersByTimeAsync(100);
		expect(rpc).toHaveBeenCalledTimes(1);
	});

	it("warms the latest session after rapid navigation", async () => {
		requestSessionPreWarm("project", "old");
		await vi.advanceTimersByTimeAsync(50);
		requestSessionPreWarm("other-project", "new");
		await vi.advanceTimersByTimeAsync(100);
		expect(rpc).toHaveBeenCalledExactlyOnceWith("PreWarmSession", {
			projectSlug: "other-project",
			sessionId: "new",
		});
	});

	it("cancels pending requests when the composer leaves a session", async () => {
		requestSessionPreWarm("project", "session");
		requestSessionPreWarm(null, null);
		requestSessionPreWarm("project", null);
		requestSessionPreWarm(null, "session");
		await vi.advanceTimersByTimeAsync(100);
		expect(rpc).not.toHaveBeenCalled();
	});

	it("can ask again after the cooldown so an idle runner can be recreated", async () => {
		requestSessionPreWarm("project", "session");
		await vi.advanceTimersByTimeAsync(1100);
		requestSessionPreWarm("project", "session");
		await vi.advanceTimersByTimeAsync(100);
		expect(rpc).toHaveBeenCalledTimes(2);
	});

	it("returns immediately while initialization remains pending", async () => {
		rpc.mockImplementation(() => new Promise(() => {}));
		expect(requestSessionPreWarm("project", "session")).toBeUndefined();
		await vi.advanceTimersByTimeAsync(100);
		expect(rpc).toHaveBeenCalledTimes(1);
	});

	it("ignores failures and allows later focus to retry", async () => {
		rpc.mockRejectedValue(new Error("Runner unavailable"));
		requestSessionPreWarm("project", "session");
		await vi.advanceTimersByTimeAsync(1100);
		requestSessionPreWarm("project", "session");
		await vi.advanceTimersByTimeAsync(100);
		expect(rpc).toHaveBeenCalledTimes(2);
	});
});
