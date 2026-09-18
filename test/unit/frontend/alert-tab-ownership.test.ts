import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleSSEEvent } from "../../../src/lib/relay/sse-wiring.js";
import { createMockSSEWiringDeps } from "../../helpers/mock-factories.js";

const { emit, settings } = vi.hoisted(() => ({
	emit: vi.fn(),
	settings: { sound: true, browser: true, push: true },
}));
vi.mock("../../../src/lib/frontend/utils/sound.js", () => ({
	readyDoneSound: async () => {},
	emitDoneSound: emit,
}));
vi.mock("../../../src/lib/frontend/utils/notif-settings.js", () => ({
	getNotifSettings: () => settings,
}));
vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: () => "project",
	navigate: vi.fn(),
}));
const question = {
	type: "ask_user" as const,
	sessionId: "s1",
	toolId: "q1",
	questions: [],
};
let subscribed: boolean;
let releaseLookup: (() => void) | undefined;
let lookup: Promise<void>;
beforeEach(() => {
	vi.resetModules();
	emit.mockClear();
	subscribed = false;
	lookup = Promise.resolve();
	const receipts = new Map<string, string>();
	let queue = Promise.resolve();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => receipts.get(key) ?? null,
		setItem: (key: string, value: string) => receipts.set(key, value),
	});
	vi.stubGlobal("navigator", {
		locks: {
			request: (
				_key: string,
				optionsOrCallback: unknown,
				callback?: (lock: object) => Promise<void>,
			) => {
				const work =
					typeof optionsOrCallback === "function"
						? optionsOrCallback
						: callback;
				const next = queue.then(() => work?.({}));
				queue = next.catch(() => {});
				return next;
			},
		},
		serviceWorker: {
			getRegistration: async () => {
				await lookup;
				return {
					pushManager: {
						getSubscription: async () => (subscribed ? {} : null),
					},
				};
			},
		},
	});
});
afterEach(() => vi.unstubAllGlobals());

it("waits for persisted push subscription on a freshly loaded tab", async () => {
	subscribed = true;
	lookup = new Promise<void>((resolve) => {
		releaseLookup = resolve;
	});
	const page = await import(
		"../../../src/lib/frontend/stores/ws-notifications.js"
	);
	const pending = page.triggerNotifications(question);
	await Promise.resolve();
	expect(emit).not.toHaveBeenCalled();
	releaseLookup?.();
	await pending;
	expect(emit).not.toHaveBeenCalled();
});

it("suppresses the same no-push alert in a second tab and after reload", async () => {
	const first = await import(
		"../../../src/lib/frontend/stores/ws-notifications.js"
	);
	vi.resetModules();
	const second = await import(
		"../../../src/lib/frontend/stores/ws-notifications.js"
	);
	await Promise.all([
		first.triggerNotifications(question),
		second.triggerNotifications(question),
	]);
	expect(emit).toHaveBeenCalledOnce();
	vi.resetModules();
	const reloaded = await import(
		"../../../src/lib/frontend/stores/ws-notifications.js"
	);
	await reloaded.triggerNotifications(question);
	expect(emit).toHaveBeenCalledOnce();
	await reloaded.triggerNotifications({ ...question, toolId: "q2" });
	expect(emit).toHaveBeenCalledTimes(2);
});

it("rechecks subscription changes made in another tab", async () => {
	const page = await import(
		"../../../src/lib/frontend/stores/ws-notifications.js"
	);
	await page.triggerNotifications(question);
	expect(emit).toHaveBeenCalledOnce();
	subscribed = true;
	await page.triggerNotifications({ ...question, toolId: "q2" });
	expect(emit).toHaveBeenCalledOnce();
	subscribed = false;
	await page.triggerNotifications({ ...question, toolId: "q3" });
	expect(emit).toHaveBeenCalledTimes(2);
});

it("distinguishes completed turns while suppressing repeated delivery of one turn", async () => {
	const page = await import(
		"../../../src/lib/frontend/stores/ws-notifications.js"
	);
	const done = {
		type: "done" as const,
		sessionId: "s1",
		code: 0,
		alertId: "turn-1:done",
	};
	await page.triggerNotifications(done);
	await page.triggerNotifications(done);
	expect(emit).toHaveBeenCalledOnce();
	await page.triggerNotifications({ ...done, alertId: "turn-2:done" });
	expect(emit).toHaveBeenCalledTimes(2);
});

it("does not guess in-app ownership when subscription lookup fails", async () => {
	vi.stubGlobal("navigator", {
		serviceWorker: {
			getRegistration: async () => {
				throw new Error("lookup failed");
			},
		},
	});
	const page = await import(
		"../../../src/lib/frontend/stores/ws-notifications.js"
	);
	await page.triggerNotifications(question);
	expect(emit).not.toHaveBeenCalled();
});

it("does not deliver uncoordinated duplicate sounds without Web Locks", async () => {
	vi.stubGlobal("navigator", {});
	const page = await import(
		"../../../src/lib/frontend/stores/ws-notifications.js"
	);
	await page.triggerNotifications(question);
	await page.triggerNotifications(question);
	expect(emit).not.toHaveBeenCalled();
});

it("retains a page receipt when storage cannot persist delivery", async () => {
	vi.stubGlobal("localStorage", {
		getItem: () => null,
		setItem: () => {
			throw new Error("quota exceeded");
		},
		removeItem: vi.fn(),
	});
	const page = await import(
		"../../../src/lib/frontend/stores/ws-notifications.js"
	);
	await page.triggerNotifications(question);
	await page.triggerNotifications(question);
	expect(emit).toHaveBeenCalledOnce();
});

it("deduplicates full and lightweight questions without suppressing later questions", async () => {
	const { handleMessage } = await import(
		"../../../src/lib/frontend/stores/ws-dispatch.js"
	);
	const { applySessionUpsert, sessionState } = await import(
		"../../../src/lib/frontend/stores/session.svelte.js"
	);
	applySessionUpsert({ id: "s1", title: "", status: "idle" });
	sessionState.currentId = "s1";
	const deps = createMockSSEWiringDeps();
	const page = await import(
		"../../../src/lib/frontend/stores/ws-notifications.js"
	);
	for (const [index, toolId] of ["q1", "q2", "q3"].entries()) {
		const fullQuestion = { ...question, toolId };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [fullQuestion],
		});
		handleSSEEvent(deps, {
			type: "question.asked",
			properties: { id: toolId, sessionID: "s1", questions: [] },
		});
		const lightweight = vi
			.mocked(deps.wsHandler.broadcast)
			.mock.calls.at(-1)?.[0];
		expect(lightweight?.type).toBe("notification_event");
		if (!lightweight) throw new Error("Missing question broadcast");
		if (toolId === "q1") await page.triggerNotifications(fullQuestion);
		else sessionState.currentId = "other-session";
		handleMessage(lightweight);
		await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(index + 1));
		// Drain the asynchronous subscription check and tab ownership lock.
		await page.triggerNotifications(fullQuestion);
		expect(emit).toHaveBeenCalledTimes(index + 1);
	}
});

it("ignores anonymous idle hints without claiming completion receipts", async () => {
	const page = await import(
		"../../../src/lib/frontend/stores/ws-notifications.js"
	);
	const idle = { type: "done" as const, sessionId: "s1", code: 0 };
	await page.triggerNotifications(idle);
	expect(localStorage.getItem("conduit-alert:project:s1:done")).toBeNull();
	expect(emit).not.toHaveBeenCalled();
	await page.triggerNotifications({ ...idle, alertId: "turn-1:done" });
	await page.triggerNotifications(idle);
	await page.triggerNotifications({ ...idle, alertId: "turn-1:done" });
	await page.triggerNotifications({ ...idle, alertId: "turn-2:done" });
	expect(emit).toHaveBeenCalledTimes(2);
	expect(localStorage.getItem("conduit-alert:project:s1:done")).toBeNull();
});
