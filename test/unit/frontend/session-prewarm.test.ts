import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { preWarmSessionRpc } = vi.hoisted(() => ({
	preWarmSessionRpc: vi.fn<() => Promise<void>>(),
}));
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	preWarmSessionRpc,
}));

let requestSessionPreWarm: typeof import("../../../src/lib/frontend/utils/session-prewarm.js").requestSessionPreWarm;

beforeEach(async () => {
	vi.useFakeTimers();
	vi.resetModules();
	preWarmSessionRpc.mockReset().mockResolvedValue(undefined);
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
		expect(preWarmSessionRpc).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(preWarmSessionRpc).toHaveBeenCalledExactlyOnceWith({
			projectSlug: "project",
			sessionId: "session",
		});
		requestSessionPreWarm("project", "session");
		await vi.advanceTimersByTimeAsync(100);
		expect(preWarmSessionRpc).toHaveBeenCalledTimes(1);
	});

	it("warms the latest session after rapid navigation", async () => {
		requestSessionPreWarm("project", "old");
		await vi.advanceTimersByTimeAsync(50);
		requestSessionPreWarm("other-project", "new");
		await vi.advanceTimersByTimeAsync(100);
		expect(preWarmSessionRpc).toHaveBeenCalledExactlyOnceWith({
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
		expect(preWarmSessionRpc).not.toHaveBeenCalled();
	});

	it("can ask again after the cooldown so an idle runner can be recreated", async () => {
		requestSessionPreWarm("project", "session");
		await vi.advanceTimersByTimeAsync(1100);
		requestSessionPreWarm("project", "session");
		await vi.advanceTimersByTimeAsync(100);
		expect(preWarmSessionRpc).toHaveBeenCalledTimes(2);
	});

	it("returns immediately while initialization remains pending", async () => {
		preWarmSessionRpc.mockImplementation(() => new Promise(() => {}));
		expect(requestSessionPreWarm("project", "session")).toBeUndefined();
		await vi.advanceTimersByTimeAsync(100);
		expect(preWarmSessionRpc).toHaveBeenCalledTimes(1);
	});

	it("ignores failures and allows later focus to retry", async () => {
		preWarmSessionRpc.mockRejectedValue(new Error("Runner unavailable"));
		requestSessionPreWarm("project", "session");
		await vi.advanceTimersByTimeAsync(1100);
		requestSessionPreWarm("project", "session");
		await vi.advanceTimersByTimeAsync(100);
		expect(preWarmSessionRpc).toHaveBeenCalledTimes(2);
	});
});
