// SubscribeServerStatus carries the daemon's protocol version. Older daemons
// need a restart; older pages need a reload. A daemon too old to know the RPC
// answers with an unknown-tag defect, which also marks it stale
// (conduit-test-l12, conduit-test-ni8.16.2).

import { Effect, Fiber, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILD_ID } from "../../../src/lib/build-id.js";
import type { ServerStatus } from "../../../src/lib/contracts/ws-rpc.js";
import { WS_PROTOCOL_VERSION } from "../../../src/lib/shared-types.js";

const mocks = vi.hoisted(() => ({
	showBanner: vi.fn(),
	removeBanner: vi.fn(),
	refreshListedSessions: vi.fn(),
}));

vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	showToast: vi.fn(),
	showBanner: mocks.showBanner,
	removeBanner: mocks.removeBanner,
}));
vi.mock("../../../src/lib/frontend/stores/session-list.svelte.js", () => ({
	refreshListedSessions: mocks.refreshListedSessions,
}));
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

type Module =
	typeof import("../../../src/lib/frontend/stores/server-status.js");

const status = (overrides: Partial<ServerStatus> = {}): ServerStatus => ({
	protocolVersion: WS_PROTOCOL_VERSION,
	buildId: BUILD_ID,
	restartAvailable: false,
	sessionsRevision: 0,
	...overrides,
});

describe("server status: protocol version", () => {
	let server: Module;

	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		server = await import("../../../src/lib/frontend/stores/server-status.js");
	});

	it("shows the stale-daemon banner for an older daemon and clears the reload banner", () => {
		server.applyServerStatus(
			status({ protocolVersion: WS_PROTOCOL_VERSION + 1 }),
		);
		vi.clearAllMocks();
		server.applyServerStatus(
			status({ protocolVersion: WS_PROTOCOL_VERSION - 1 }),
		);
		expect(mocks.showBanner).toHaveBeenCalledWith(
			expect.objectContaining({ id: "stale-daemon", variant: "warning" }),
		);
		expect(mocks.removeBanner).toHaveBeenCalledWith("stale-page");
	});

	it("shows the reload banner for a newer daemon and clears the stale-daemon banner", () => {
		server.applyServerStatus(
			status({ protocolVersion: WS_PROTOCOL_VERSION - 1 }),
		);
		vi.clearAllMocks();
		server.applyServerStatus(
			status({ protocolVersion: WS_PROTOCOL_VERSION + 1 }),
		);
		expect(mocks.removeBanner).toHaveBeenCalledWith("stale-daemon");
		expect(mocks.showBanner).toHaveBeenCalledWith({
			id: "stale-page",
			variant: "update",
			icon: "refresh-cw",
			text: "Conduit was updated. Reload this tab to keep things working.",
			summary: "Reload this tab",
			dismissible: true,
			action: { label: "Reload", run: expect.any(Function) },
		});
	});

	it("clears both version banners on matching version", () => {
		server.applyServerStatus(status());
		expect(mocks.showBanner).not.toHaveBeenCalled();
		expect(mocks.removeBanner).toHaveBeenCalledWith("stale-daemon");
		expect(mocks.removeBanner).toHaveBeenCalledWith("stale-page");
	});

	it("does not re-show a dismissed reload banner when only the session revision moves", () => {
		server.applyServerStatus(
			status({ protocolVersion: WS_PROTOCOL_VERSION + 1 }),
		);
		vi.clearAllMocks();
		server.applyServerStatus(
			status({ protocolVersion: WS_PROTOCOL_VERSION + 1, sessionsRevision: 1 }),
		);
		expect(mocks.showBanner).not.toHaveBeenCalled();
		expect(mocks.refreshListedSessions).toHaveBeenCalledOnce();
	});

	it("does not refresh the session lists on the first status", () => {
		server.applyServerStatus(status({ sessionsRevision: 7 }));
		expect(mocks.refreshListedSessions).not.toHaveBeenCalled();
	});

	it("shows the stale-daemon banner and stops retrying when the daemon does not know the RPC", async () => {
		const fiber = Effect.runFork(
			Stream.runDrain(
				server.serverStatusFeed({
					serverStatus: () =>
						Stream.die("Unknown request tag: SubscribeServerStatus"),
				}),
			),
		);
		await Effect.runPromise(Effect.sleep(10));
		expect(mocks.showBanner).toHaveBeenCalledWith(
			expect.objectContaining({ id: "stale-daemon" }),
		);
		expect(fiber.unsafePoll()).toBeNull();
		await Effect.runPromise(Fiber.interrupt(fiber));
	});

	it("passes other failures through to the supervisor", async () => {
		const exit = await Effect.runPromiseExit(
			Stream.runDrain(
				server.serverStatusFeed({ serverStatus: () => Stream.die("boom") }),
			),
		);
		expect(exit._tag).toBe("Failure");
		expect(mocks.showBanner).not.toHaveBeenCalled();
	});
});
