// @vitest-environment jsdom
import { seedSessions } from "../stores/session-fixtures.js";
// Full tool content and input drafts arrive through RPC replies.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks (run before imports)

const { showBannerMock, removeBannerMock, showToastMock } = vi.hoisted(() => ({
	showBannerMock: vi.fn(),
	removeBannerMock: vi.fn(),
	showToastMock: vi.fn(),
}));

// Mock DOMPurify (required by chat.svelte.ts → markdown.ts)
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

// Mock ui.svelte.js to capture showBanner/removeBanner calls
vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	uiState: { opencodeConnections: {} },
	showToast: showToastMock,
	showBanner: showBannerMock,
	removeBanner: removeBannerMock,
	setClientCount: vi.fn(),
}));

import {
	chatState,
	clearMessages,
	inputSyncState,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { getBrowserClientId } from "../../../src/lib/frontend/stores/client-identity.js";
import { applyInputDraft } from "../../../src/lib/frontend/stores/input-draft.js";
import { clearInstanceState } from "../../../src/lib/frontend/stores/instance.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import type { ToolMessage } from "../../../src/lib/frontend/types.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

let _ta: SessionActivity;
let tm: SessionMessages;

beforeEach(() => {
	clearMessages();
	// Set currentId and register session BEFORE creating test slots,
	// so testActivity()/testMessages() register under the correct key ("s1").
	seedSessions([
		...sessionState.sessions.values(),
		{ id: "s1", title: "", status: "idle" },
	]);
	openSessionForSetup("s1", "project-a");
	_ta = testActivity();
	tm = testMessages();
	clearInstanceState();
	inputSyncState.received = null;
	showBannerMock.mockClear();
	removeBannerMock.mockClear();
	showToastMock.mockClear();
	uiState.opencodeConnections = {};
});

afterEach(() => {
	clearMessages();
	_ta = testActivity();
	tm = testMessages();
	clearInstanceState();
	inputSyncState.received = null;
});

describe("input draft follower", () => {
	it("ignores draft echoes from this browser tab", () => {
		const before = {
			_tag: "ServerTextReceived" as const,
			key: { session: "s1" },
			text: "before",
		};
		inputSyncState.received = before;

		applyInputDraft(
			{
				_tag: "draft",
				text: "self echo",
				from: getBrowserClientId(),
			},
			{ session: "s1" },
		);

		expect(inputSyncState.received).toEqual(before);
	});

	it("applies drafts from another browser tab", () => {
		applyInputDraft(
			{
				_tag: "draft",
				text: "other tab draft",
				from: "browser-tab-b",
			},
			{ session: "s1" },
		);

		expect(inputSyncState.received).toEqual({
			_tag: "ServerTextReceived",
			key: { session: "s1" },
			text: "other tab draft",
		});
	});
});
