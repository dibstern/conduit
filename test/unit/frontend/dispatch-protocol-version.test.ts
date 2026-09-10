// ─── protocol_version → stale-daemon banner wiring ───────────────────────────
// The daemon sends protocol_version on connect. A mismatched version — or no
// message at all within the grace window, which marks a daemon predating the
// handshake — must surface the stale-daemon banner; a matching version must
// clear it. Guards against the fail-open where a stale daemon silently
// reinterprets wire literals (conduit-test-l12).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayMessage } from "../../../src/lib/shared-types.js";
import { WS_PROTOCOL_VERSION } from "../../../src/lib/shared-types.js";

// ─── Hoisted mocks (WebSocket/window needed by the ws.svelte.ts import chain) ─

const { showBannerMock, removeBannerMock } = vi.hoisted(() => {
	const showBannerMock = vi.fn();
	const removeBannerMock = vi.fn();

	class MockWebSocket {
		static readonly OPEN = 1;
		static readonly CLOSED = 3;
		readyState = MockWebSocket.OPEN;
		send(_data: string): void {}
		addEventListener(_event: string, _fn: (ev?: unknown) => void): void {}
		close(): void {
			this.readyState = MockWebSocket.CLOSED;
		}
	}
	Object.defineProperty(globalThis, "WebSocket", {
		value: MockWebSocket,
		writable: true,
		configurable: true,
	});
	if (typeof globalThis.window === "undefined") {
		Object.defineProperty(globalThis, "window", {
			value: {
				location: { protocol: "http:", host: "localhost:3000", pathname: "/" },
				history: { pushState: () => {}, replaceState: () => {} },
				addEventListener: () => {},
			},
			writable: true,
			configurable: true,
		});
	}

	return { showBannerMock, removeBannerMock };
});

vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	showToast: vi.fn(),
	showBanner: showBannerMock,
	removeBanner: removeBannerMock,
	setClientCount: vi.fn(),
	updateContextPercent: vi.fn(),
}));

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	armProtocolVersionCheck,
	disarmProtocolVersionCheck,
	handleMessage,
} from "../../../src/lib/frontend/stores/ws-dispatch.js";

// ─── Tests ──────────────────────────────────────────────────────────────────

const protocolVersionMsg = (version: number): RelayMessage => ({
	type: "protocol_version",
	version,
});

describe("protocol_version dispatch", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		showBannerMock.mockClear();
		removeBannerMock.mockClear();
	});

	afterEach(() => {
		disarmProtocolVersionCheck();
		vi.useRealTimers();
	});

	it("shows the stale-daemon banner on version mismatch", () => {
		handleMessage(protocolVersionMsg(WS_PROTOCOL_VERSION - 1));
		expect(showBannerMock).toHaveBeenCalledWith(
			expect.objectContaining({ id: "stale-daemon", variant: "warning" }),
		);
	});

	it("clears the stale-daemon banner on matching version", () => {
		handleMessage(protocolVersionMsg(WS_PROTOCOL_VERSION));
		expect(showBannerMock).not.toHaveBeenCalled();
		expect(removeBannerMock).toHaveBeenCalledWith("stale-daemon");
	});

	it("shows the banner when no protocol_version arrives in the grace window", () => {
		armProtocolVersionCheck();
		vi.advanceTimersByTime(10_000);
		expect(showBannerMock).toHaveBeenCalledWith(
			expect.objectContaining({ id: "stale-daemon" }),
		);
	});

	it("does not fire the absence banner when the version arrives in time", () => {
		armProtocolVersionCheck();
		handleMessage(protocolVersionMsg(WS_PROTOCOL_VERSION));
		vi.advanceTimersByTime(60_000);
		expect(showBannerMock).not.toHaveBeenCalled();
	});

	it("does not fire the absence banner after disarm (socket closed)", () => {
		armProtocolVersionCheck();
		disarmProtocolVersionCheck();
		vi.advanceTimersByTime(60_000);
		expect(showBannerMock).not.toHaveBeenCalled();
	});
});
