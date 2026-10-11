import {
	cleanup,
	fireEvent,
	render,
	waitFor,
	within,
} from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
	loadMoreHistoryRpc:
		vi.fn<
			typeof import("../../../src/lib/frontend/transport/ws-rpc-client.js").loadMoreHistoryRpc
		>(),
	forkSessionRpc: vi.fn<
		typeof import("../../../src/lib/frontend/transport/ws-rpc-client.js").forkSessionRpc
	>(() => new Promise<never>(() => {})),
	respondPermissionRpc: vi.fn(async () => ({ ok: true })),
	answerQuestionRpc: vi.fn(async () => ({ ok: true })),
}));

vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/transport/ws-rpc-client.js")
		>()),
		...rpc,
	}),
);
vi.mock(
	"../../../src/lib/frontend/stores/router.svelte.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/stores/router.svelte.js")
		>()),
		// Feed delivery is seeded below; no live socket is needed for this seam.
		attachedProjectState: { slug: null },
		getCurrentSlug: () => "conduit",
	}),
);

import MessageList from "../../../src/lib/frontend/components/chat/MessageList.svelte";
import TaskDrawer from "../../../src/lib/frontend/components/session/TaskDrawer.svelte";
import {
	consumeScrollRequest,
	getOrCreateSessionSlot,
	requestScrollOnNextContent,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { permissionsState } from "../../../src/lib/frontend/stores/permissions.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	requestTranscriptFollow,
	sessionViewState,
} from "../../../src/lib/frontend/stores/session-view.svelte.js";
import {
	deriveTranscriptMessages,
	type TranscriptEntry,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import type { PermissionRequest } from "../../../src/lib/frontend/types.js";
import { seedSessionsWithFamily } from "../stores/session-fixtures.js";

const parentId = "drawer-parent";
const childId = "drawer-child";
const task = { id: "task-child", sessionId: childId, description: "Research" };

function textRow(
	id: string,
	text: string,
	created: number,
	role: "assistant" | "user" = "assistant",
) {
	return {
		id,
		role,
		parts: [{ id: `${id}-text`, type: "text" as const, text }],
		time: { created, completed: created + 1 },
	};
}

function seedTranscript(id: string, text: string) {
	const { messages } = getOrCreateSessionSlot(id);
	const entry: TranscriptEntry = {
		rows: [textRow(`${id}-reply`, text, 20)],
		hwm: 20,
		hasMore: false,
		status: { _tag: "live" },
		project: "conduit",
		pending: [],
	};
	messages.transcript = entry;
	messages.messages = deriveTranscriptMessages(entry, []);
	messages.loadLifecycle = "ready";
	return messages;
}

const observers: {
	callback: IntersectionObserverCallback;
	options: IntersectionObserverInit | undefined;
	target?: Element;
}[] = [];

async function settle() {
	flushSync();
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	flushSync();
}

function scrollTo(el: HTMLElement, top: number) {
	el.scrollTop = top;
	el.dispatchEvent(new Event("scroll"));
	flushSync();
}

function setScrollSize(el: HTMLElement) {
	Object.defineProperties(el, {
		scrollHeight: { value: 2000, configurable: true },
		clientHeight: { value: 500, configurable: true },
	});
}

function mountDrawer() {
	const view = render(TaskDrawer, { props: { task } });
	const pane = view.getByTestId("task-drawer-transcript");
	return { ...view, pane };
}

beforeEach(() => {
	vi.clearAllMocks();
	observers.length = 0;
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			entry: (typeof observers)[number];
			constructor(
				callback: IntersectionObserverCallback,
				options?: IntersectionObserverInit,
			) {
				this.entry = { callback, options };
				observers.push(this.entry);
			}
			observe(target: Element) {
				this.entry.target = target;
			}
			disconnect() {}
		},
	);
	sessionMessages.clear();
	sessionActivity.clear();
	seedSessionsWithFamily([
		{ id: parentId, title: "Parent", status: "idle" },
		{ id: childId, title: "Child", status: "idle", parentID: parentId },
		{ id: "drawer-sibling", title: "Sibling", parentID: parentId },
	]);
	sessionState.currentId = parentId;
	seedTranscript(parentId, "Parent reply");
	seedTranscript(childId, "Child reply");
	permissionsState.pendingPermissions = [];
	permissionsState.pendingQuestions = [];
	uiState.rewindActive = false;
	uiState.rewindSelectedUuid = null;
	consumeScrollRequest();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	permissionsState.pendingPermissions = [];
	permissionsState.pendingQuestions = [];
	uiState.rewindActive = false;
	seedSessionsWithFamily([]);
});

describe("Task drawer transcript", () => {
	it("owns Escape before it reaches document-level parent handlers", async () => {
		const parentEscape = vi.fn();
		document.addEventListener("keydown", parentEscape);
		try {
			const view = mountDrawer();
			await settle();
			await fireEvent.keyDown(view.getByTestId("task-drawer"), {
				key: "Escape",
			});
			expect(parentEscape).not.toHaveBeenCalled();
		} finally {
			document.removeEventListener("keydown", parentEscape);
		}
	});

	it("returns focus to the parent transcript when both task triggers have disappeared", async () => {
		const parent =
			render(MessageList).container.querySelector<HTMLElement>("#messages");
		const opener = document.createElement("button");
		document.body.append(opener);
		opener.focus();
		const view = mountDrawer();
		await settle();
		opener.remove();
		await fireEvent.click(
			view.getByRole("button", { name: "Close task drawer" }),
		);
		expect(document.activeElement).toBe(parent);
	});
	it("pages earlier child rows in its own scroll root while the parent stays mounted", async () => {
		const child = getOrCreateSessionSlot(childId).messages;
		if (!child.transcript) throw new Error("Missing seeded child transcript");
		child.transcript.hasMore = true;
		child.historyHasMore = true;
		rpc.loadMoreHistoryRpc.mockResolvedValueOnce({
			projectSlug: "conduit",
			sessionId: childId,
			messages: [textRow("child-earlier", "Earlier child work", 1, "user")],
			hasMore: false,
		});
		const parent = render(MessageList).container.querySelector("#messages");
		const { pane } = mountDrawer();
		await settle();
		const observer = observers.find(
			(entry) => entry.target && pane.contains(entry.target),
		);
		observer?.callback(
			[{ isIntersecting: true } as IntersectionObserverEntry],
			{} as IntersectionObserver,
		);

		expect(await within(pane).findByText("Earlier child work")).toBeTruthy();
		expect(rpc.loadMoreHistoryRpc).toHaveBeenCalledExactlyOnceWith({
			projectSlug: "conduit",
			sessionId: childId,
			before: `${childId}-reply`,
		});
		expect(observer?.options?.root).toBe(within(pane).getByRole("region"));
		expect(within(pane).getByText("Beginning of session")).toBeTruthy();
		expect(document.querySelectorAll("#messages")).toHaveLength(1);
		expect(document.querySelector("#messages")).toBe(parent);
		expect(parent?.textContent).toContain("Parent reply");
		expect(parent?.textContent).not.toContain("Earlier child work");
		expect(sessionState.currentId).toBe(parentId);
	});

	it("renders and answers the child's pending requests without parent or sibling orphan questions", async () => {
		permissionsState.pendingPermissions = [
			{
				id: "child-permission",
				requestId: "child-permission" as PermissionRequest["requestId"],
				sessionId: childId,
				toolName: "Bash",
				toolInput: { command: "child-command" },
			},
		];
		permissionsState.pendingQuestions = [
			parentId,
			childId,
			"drawer-sibling",
		].map((sessionId) => ({
			toolId: `question-${sessionId}`,
			sessionId,
			questions: [
				{
					question: `Choice for ${sessionId}?`,
					header: "Choice",
					options: [{ label: "SQLite", description: "Use SQLite" }],
					multiSelect: false,
				},
			],
		}));
		const { pane } = mountDrawer();
		await settle();
		expect(within(pane).getByText("child-command")).toBeTruthy();
		expect(within(pane).getByText(`Choice for ${childId}?`)).toBeTruthy();
		expect(within(pane).queryByText(`Choice for ${parentId}?`)).toBeNull();
		expect(within(pane).queryByText("Choice for drawer-sibling?")).toBeNull();
		await fireEvent.click(within(pane).getByRole("button", { name: "Allow" }));
		expect(rpc.respondPermissionRpc).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: "child-permission",
				decision: "allow",
			}),
		);
		await fireEvent.click(within(pane).getByRole("radio"));
		await fireEvent.click(within(pane).getByRole("button", { name: "Submit" }));
		expect(rpc.answerQuestionRpc).toHaveBeenCalledWith(
			expect.objectContaining({
				toolId: `question-${childId}`,
				answers: { "0": "SQLite" },
			}),
		);
		expect(sessionState.currentId).toBe(parentId);
	});

	it("preserves the parent's scroll and chrome and leaves primary follow requests to the parent", async () => {
		const parentView = render(MessageList);
		const parent = parentView.getByRole("region");
		await settle();
		setScrollSize(parent);
		scrollTo(parent, 200);
		sessionViewState.barOpen = true;
		const drawer = mountDrawer();
		await settle();
		expect(sessionViewState.atBottom).toBe(false);
		expect(sessionViewState.barOpen).toBe(true);
		const child = within(drawer.pane).getByRole("region");
		setScrollSize(child);
		scrollTo(child, 200);
		expect(sessionViewState.barOpen).toBe(true);
		expect(parent.scrollTop).toBe(200);
		requestTranscriptFollow();
		await settle();
		expect(parent.scrollTop).toBe(2000);
		expect(child.scrollTop).toBe(200);
		expect(
			within(drawer.pane)
				.getByTitle("Scroll to bottom")
				.classList.contains("hidden"),
		).toBe(false);

		scrollTo(parent, 200);
		sessionViewState.barOpen = true;
		seedTranscript("drawer-next", "Next child reply");
		await drawer.rerender({ task: { ...task, sessionId: "drawer-next" } });
		expect(within(drawer.pane).getByText("Next child reply")).toBeTruthy();
		expect(within(drawer.pane).queryByText("Child reply")).toBeNull();
		drawer.unmount();
		flushSync();
		expect(parentView.getByRole("region")).toBe(parent);
		expect(parent.scrollTop).toBe(200);
		expect(sessionViewState.atBottom).toBe(false);
		expect(sessionViewState.barOpen).toBe(true);
		expect(sessionState.currentId).toBe(parentId);
	});

	it("follows live child content without consuming global scroll requests or primary rewind", async () => {
		const { pane } = mountDrawer();
		await settle();
		const child = within(pane).getByRole("region");
		setScrollSize(child);
		getOrCreateSessionSlot(childId).activity.phase = "processing";
		requestScrollOnNextContent();
		const messages = getOrCreateSessionSlot(childId).messages;
		messages.messages = [
			...messages.messages,
			{
				type: "assistant",
				uuid: "live-child",
				rawText: "Child keeps working",
				html: "<p>Child keeps working</p>",
				finalized: false,
			},
		];
		await settle();
		expect(within(pane).getByText("Child keeps working")).toBeTruthy();
		expect(child.scrollTop).toBe(2000);
		expect(consumeScrollRequest()).toBe(true);
		uiState.rewindActive = true;
		await fireEvent.click(within(pane).getByText("Child keeps working"));
		expect(uiState.rewindSelectedUuid).toBeNull();
		expect(pane.querySelector(".rewind-point")).toBeNull();
		expect(sessionState.currentId).toBe(parentId);
	});

	it("forks the child reply instead of the parent's current session", async () => {
		const { pane } = mountDrawer();
		await fireEvent.click(
			within(pane).getByRole("button", { name: "Fork from here" }),
		);
		expect(rpc.forkSessionRpc).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: childId,
				messageId: `${childId}-reply`,
			}),
		);
		expect(sessionState.currentId).toBe(parentId);
	});

	it("uses the normal cold, failing and live transcript feed presentation", async () => {
		const messages = getOrCreateSessionSlot(childId).messages;
		if (!messages.transcript)
			throw new Error("Missing seeded child transcript");
		messages.transcript.rows = [];
		messages.transcript.hwm = null;
		messages.transcript.status = { _tag: "cold" };
		messages.messages = [];
		messages.loadLifecycle = "loading";
		const { pane } = mountDrawer();
		await settle();
		expect(within(pane).getByTestId("transcript-skeleton")).toBeTruthy();
		expect([...pane.querySelectorAll("div")].some((el) => el.inert)).toBe(true);
		expect(within(pane).queryByText("Beginning of session")).toBeNull();
		messages.transcript.status = {
			_tag: "failing",
			since: 1,
			lastError: "offline",
		};
		flushSync();
		expect(within(pane).getByText("Couldn't refresh")).toBeTruthy();
		expect(within(pane).getByRole("button", { name: "Retry" })).toBeTruthy();
		seedTranscript(childId, "Child synchronized");
		await waitFor(() =>
			expect(within(pane).getByText("Child synchronized")).toBeTruthy(),
		);
		expect([...pane.querySelectorAll("div")].some((el) => el.inert)).toBe(
			false,
		);
		expect(within(pane).queryByTestId("transcript-skeleton")).toBeNull();
	});
});
