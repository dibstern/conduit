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
	call: vi.fn<(tag: string, payload: unknown) => Promise<unknown>>((tag) =>
		tag === "ForkSession"
			? new Promise<never>(() => {})
			: Promise.resolve({ ok: true }),
	),
}));

vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/transport/ws-rpc-client.js")
		>()),
		...rpc,
		rpc: rpc.call,
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

import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../src/lib/contracts/message-surfacing.js";
import MessageList from "../../../src/lib/frontend/components/chat/MessageList.svelte";
import TaskDrawer from "../../../src/lib/frontend/components/session/TaskDrawer.svelte";
import {
	consumeScrollRequest,
	getOrCreateSessionSlot,
	requestScrollOnNextContent,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	messageSurfacing,
	sessionSurfaceLevel,
	setSessionSurfaceLevel,
} from "../../../src/lib/frontend/stores/message-surfacing.svelte.js";
import { permissionsState } from "../../../src/lib/frontend/stores/permissions.svelte.js";
import { reveal } from "../../../src/lib/frontend/stores/reveal.svelte.js";
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
		waiting: new Map(),
		partOrder: new Map(),
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
		child.transcript = { ...child.transcript, hasMore: true };
		child.historyHasMore = true;
		rpc.call.mockResolvedValueOnce({
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
		expect(rpc.call).toHaveBeenCalledExactlyOnceWith("LoadMoreHistory", {
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
		expect(rpc.call).toHaveBeenCalledWith(
			"RespondPermission",
			expect.objectContaining({
				requestId: "child-permission",
				decision: "allow",
			}),
		);
		await fireEvent.click(within(pane).getByRole("radio"));
		await fireEvent.click(within(pane).getByRole("button", { name: "Submit" }));
		expect(rpc.call).toHaveBeenCalledWith(
			"AnswerQuestion",
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
		expect(rpc.call).toHaveBeenCalledWith(
			"ForkSession",
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
		messages.transcript = {
			...messages.transcript,
			rows: [],
			hwm: null,
			status: { _tag: "cold" },
		};
		messages.messages = [];
		messages.loadLifecycle = "loading";
		const { pane } = mountDrawer();
		await settle();
		expect(within(pane).getByTestId("transcript-skeleton")).toBeTruthy();
		expect([...pane.querySelectorAll("div")].some((el) => el.inert)).toBe(true);
		expect(within(pane).queryByText("Beginning of session")).toBeNull();
		messages.transcript = {
			...messages.transcript,
			status: { _tag: "failing", since: 1, lastError: "offline" },
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

describe("Surfacing in primary and child transcripts", () => {
	const activeStatus = {
		...DEFAULT_MESSAGE_SURFACING_SETTINGS,
		enabled: true,
		active: true,
		key: { state: "valid" as const },
	};
	const scrollIntoView = vi.fn();

	function seedSurfacing(id: string) {
		getOrCreateSessionSlot(id).messages.messages = [
			{ type: "user", uuid: `${id}-prompt`, text: "Inspect the routes" },
			...["ask", "finding", "unjudged"].flatMap((category, index) => [
				{
					type: "assistant" as const,
					uuid: `shared/${category}`,
					messageId: "shared",
					partId: category,
					rawText: `${id} ${category}`,
					html: `<p>${id} ${category}</p>`,
					finalized: true,
					...(category === "unjudged"
						? {}
						: {
								surfacingOrdinal: index + 1,
								surfacingProbabilities: { [category]: 1 },
							}),
				},
				{
					type: "thinking" as const,
					uuid: `${id}-thinking-${index}`,
					text: "Inspecting",
					done: true,
				},
			]),
		];
	}

	beforeEach(() => {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
		});
		messageSurfacing.status = activeStatus;
		setSessionSurfaceLevel(parentId, null);
		setSessionSurfaceLevel(childId, null);
		seedSurfacing(parentId);
		seedSurfacing(childId);
		vi.stubGlobal("CSS", { escape: (value: string) => value });
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callback(0);
			return 0;
		});
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoView,
		});
	});

	afterEach(() => {
		messageSurfacing.status = { ...activeStatus, active: false };
		setSessionSurfaceLevel(parentId, null);
		setSessionSurfaceLevel(childId, null);
		Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
	});

	it("changes, persists, defaults and resets the primary session's level", async () => {
		const view = render(MessageList);
		const level = within(view.getByTestId("surfacing-level"));
		await fireEvent.click(level.getByRole("radio", { name: "Key" }));
		expect(sessionSurfaceLevel(parentId)).toBe("key");
		expect(
			JSON.parse(localStorage.getItem("surfacing-level-by-session") ?? "{}"),
		).toMatchObject({ [parentId]: "key" });
		await fireEvent.keyDown(
			view.getByRole("button", { name: "Level options" }),
			{ key: "Enter" },
		);
		rpc.call.mockResolvedValueOnce({ ...activeStatus, defaultLevel: "key" });
		await fireEvent.click(
			await view.findByRole("menuitem", { name: "Make default" }),
		);
		await waitFor(() => expect(sessionSurfaceLevel(parentId)).toBeUndefined());
		expect(rpc.call).toHaveBeenCalledWith("UpdateMessageSurfacing", {
			defaultLevel: "key",
		});
		await fireEvent.click(level.getByRole("radio", { name: "Balanced" }));
		await fireEvent.keyDown(
			view.getByRole("button", { name: "Level options" }),
			{ key: "Enter" },
		);
		await fireEvent.click(
			await view.findByRole("menuitem", { name: "Back to default" }),
		);
		expect(sessionSurfaceLevel(parentId)).toBeUndefined();
		expect(
			level.getByRole("radio", { name: "Key" }).getAttribute("aria-checked"),
		).toBe("true");
		getOrCreateSessionSlot(parentId).messages.messages = getOrCreateSessionSlot(
			parentId,
		).messages.messages.filter(
			(part) => part.type !== "assistant" || part.partId !== "ask",
		);
		await settle();
		await fireEvent.click(view.getByRole("button", { name: "Show All" }));
		expect(sessionSurfaceLevel(parentId)).toBe("all");
	});

	it("opens a settled message without a verdict in the step log", async () => {
		const view = render(MessageList);
		expect(
			view.container.querySelector('.step-log [data-part="shared/unjudged"]'),
		).toBeNull();
		expect(await reveal({ messageId: "shared", partId: "unjudged" })).toBe(
			"landed",
		);
		expect(
			view.container.querySelector('.step-log [data-part="shared/unjudged"]')
				?.textContent,
		).toContain(`${parentId} unjudged`);
	});

	it("reveals the child's Ask and numbered messages without changing the parent card", async () => {
		const parent = within(render(MessageList).container);
		const { pane } = mountDrawer();
		const child = within(pane);
		await fireEvent.click(child.getByTestId("surfacing-ask-chip"));
		await waitFor(() =>
			expect(
				child.getByTestId("surfacing-msg-card").getAttribute("data-part"),
			).toBe("shared/ask"),
		);
		expect(
			parent.getByTestId("surfacing-msg-card").getAttribute("data-part"),
		).toBe("shared/finding");
		const turn = child.getByTestId("surfacing-card");
		await fireEvent.keyDown(turn, { key: "2" });
		await fireEvent.keyDown(turn, { key: "Enter" });
		await waitFor(() =>
			expect(
				child.getByTestId("surfacing-msg-card").getAttribute("data-part"),
			).toBe("shared/finding"),
		);
		await fireEvent.keyDown(turn, { key: "a" });
		await waitFor(() =>
			expect(
				child.getByTestId("surfacing-msg-card").getAttribute("data-part"),
			).toBe("shared/ask"),
		);
		expect(
			parent.getByTestId("surfacing-msg-card").getAttribute("data-part"),
		).toBe("shared/finding");
		expect(sessionState.currentId).toBe(parentId);
	});

	it("pages the explicitly viewed child's history", async () => {
		seedTranscript(childId, "Child reply");
		const messages = getOrCreateSessionSlot(childId).messages;
		messages.historyHasMore = true;
		if (!messages.transcript) throw new Error("Missing child transcript");
		messages.transcript.hasMore = true;
		const { pane } = mountDrawer();
		rpc.call.mockResolvedValueOnce({
			projectSlug: "conduit",
			sessionId: childId,
			messages: [textRow("older-child", "Earlier child prompt", 1, "user")],
			hasMore: false,
		});
		expect(await reveal({ sessionId: childId, messageId: "older-child" })).toBe(
			"landed",
		);
		expect(rpc.call).toHaveBeenCalledWith("LoadMoreHistory", {
			sessionId: childId,
			before: `${childId}-reply`,
		});
		expect(within(pane).getByText("Earlier child prompt")).toBeTruthy();
		expect(sessionState.currentId).toBe(parentId);
	});
});
