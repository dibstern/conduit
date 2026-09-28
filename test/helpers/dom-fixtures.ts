// ─── Shared DOM Fixtures for Frontend Tests ──────────────────────────────────
// Provides reusable DOM HTML and mock constructors for removing internal mocks.

import { vi } from "vitest";

/**
 * Fix Node v25 localStorage (missing .clear()).
 * Node v25+ exposes a global localStorage via a Proxy that lacks .clear().
 * Replace it with a simple Map-based polyfill for testing.
 * Call this at the top of any test file that uses localStorage in a jsdom env.
 */
export function fixLocalStorage(): void {
	if (
		typeof localStorage !== "undefined" &&
		typeof localStorage.clear !== "function"
	) {
		const store = new Map<string, string>();
		const polyfill = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, String(value)),
			removeItem: (key: string) => store.delete(key),
			clear: () => store.clear(),
			get length() {
				return store.size;
			},
			key: (index: number) => [...store.keys()][index] ?? null,
		};
		Object.defineProperty(globalThis, "localStorage", {
			value: polyfill,
			writable: true,
			configurable: true,
		});
	}
}

/**
 * Creates a mock WebSocket instance with spy methods.
 * Captures sent messages in the provided array (or an internal one).
 */
export function createMockWebSocket(sentMessages: unknown[] = []): WebSocket {
	return {
		readyState: 1, // WebSocket.OPEN
		send: vi.fn((data: string) => {
			sentMessages.push(JSON.parse(data));
		}),
		close: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(() => true),
		url: "ws://localhost:4097",
		protocol: "",
		extensions: "",
		bufferedAmount: 0,
		binaryType: "blob" as BinaryType,
		onopen: null,
		onclose: null,
		onerror: null,
		onmessage: null,
		CONNECTING: 0,
		OPEN: 1,
		CLOSING: 2,
		CLOSED: 3,
	} as unknown as WebSocket;
}

/**
 * Minimal HTML elements needed by shared.ts module-scope getElementById calls.
 * Include this in buildDOM() for tests that import shared.ts without mocking it.
 */
export const SHARED_DOM_HTML = `
  <div id="messages"><button id="scroll-btn" class="hidden"></button></div>
  <textarea id="input"></textarea>
  <button id="send" disabled></button>
  <span id="status" class="status-dot w-[7px] h-[7px] rounded-full shrink-0 bg-text-muted"></span>
`;

/**
 * Comprehensive HTML for tests that import main.ts (which side-effect-imports 20+ modules).
 * Covers all DOM elements expected by every frontend module.
 */
export const FULL_DOM_HTML = `
  <div id="layout">
    <div id="sidebar"></div>
    <button id="sidebar-toggle-btn"></button>
    <div id="app">
      <div id="session-bar" data-testid="session-bar" data-compact="false">
        <div id="session-bar-title-row"><h1 id="session-bar-title">Test Session</h1></div>
        <div id="session-bar-meta"><span data-testid="session-bar-identity">Conduit</span></div>
        <button data-testid="session-bar-settle">Settle</button>
        <div id="session-bar-connection"><span id="status" role="status" title="Connecting"></span></div>
        <button id="session-bar-more" data-testid="session-bar-overflow" title="More actions">⋯</button>
        <div data-testid="session-bar-overflow-menu" role="menu" class="hidden">
          <button data-testid="overflow-share" role="menuitem">Share</button>
          <button data-testid="overflow-settings" role="menuitem">Settings</button>
          <button data-testid="overflow-debug" role="menuitem">Debug panel</button>
        </div>
      </div>
      <div id="banner-container"></div>
      <div id="info-panels">
        <div id="usage-panel" class="info-panel hidden"></div>
        <div id="status-panel" class="info-panel hidden"></div>
        <div id="context-panel" class="info-panel hidden"></div>
      </div>
      <div id="connect-overlay" class="hidden">
        <div id="pixel-canvas"></div>
        <span class="connect-verb"></span>
        <span class="connect-status"></span>
      </div>
    </div>
    <div id="messages"><button id="scroll-btn" class="hidden"></button></div>
    <div id="input-area">
      <div id="input-wrapper">
        <div id="input-row">
          <div id="context-mini" class="hidden">
            <div class="context-mini-bar"><div class="context-mini-fill" id="context-mini-fill"></div></div>
            <span class="context-mini-label" id="context-mini-label">0%</span>
          </div>
          <textarea id="input"></textarea>
          <div id="input-bottom">
            <div id="attach-wrap">
              <button id="attach-btn" type="button"></button>
              <div id="attach-menu" class="hidden"></div>
            </div>
            <div id="input-bottom-right">
              <button id="send" class="send-btn" disabled></button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div id="command-menu" class="hidden"></div>
    <div id="rewind-banner" class="rewind-banner hidden"></div>
    <div id="rewind-modal" class="modal-backdrop hidden"></div>
    <div id="confirm-modal" class="modal-backdrop hidden">
      <div class="confirm-message"></div>
      <button class="confirm-cancel-btn"></button>
      <button class="confirm-action-btn"></button>
    </div>
    <div id="qr-modal" class="modal-backdrop hidden"></div>
  </div>
`;
