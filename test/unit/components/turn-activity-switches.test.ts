// Failure modes: enabling Jev hides a keyless summary's citations, log rows
// disagree with those citations, or fallback numbering replaces saved ordinals.
// Both switches off must retain the base strip's durations, captions and jump.
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CATEGORY_SET } from "../../../src/lib/contracts/category-set.js";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../src/lib/contracts/message-surfacing.js";
import type { TurnRecap } from "../../../src/lib/contracts/turn-recap.js";
import ActivityStrip from "../../../src/lib/frontend/components/chat/ActivityStrip.svelte";
import TurnActivity from "../../../src/lib/frontend/components/chat/TurnActivity.svelte";
import type { Segment, Turn } from "../../../src/lib/frontend/utils/turns.js";

const rpc = vi.hoisted(() =>
	vi.fn<(tag: string, payload: unknown) => Promise<unknown>>(),
);
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rpc,
}));
vi.mock("../../../src/lib/frontend/transport/runtime.js", () => ({
	getRuntime: () =>
		Promise.reject(new Error("No transport in component tests")),
}));

const START = 1_800_000_000_000;
const segment: Segment = {
	activity: [
		{
			type: "assistant",
			uuid: "first",
			rawText: "Unclassified update",
			html: "<p>Unclassified update</p>",
			finalized: true,
			createdAt: START,
		},
		{
			type: "thinking",
			uuid: "thinking",
			text: "Checking",
			done: true,
			duration: 1000,
			createdAt: START + 1000,
		},
		{
			type: "assistant",
			uuid: "saved",
			rawText: "Previously numbered update",
			html: "<p>Previously numbered update</p>",
			finalized: true,
			createdAt: START + 2000,
			surfacingOrdinal: 7,
		},
		{
			type: "thinking",
			uuid: "last",
			text: "Finishing",
			done: true,
			duration: 1000,
			createdAt: START + 3000,
		},
	],
	reply: [],
};
const turn: Turn = {
	id: "turn",
	storeId: "turn",
	user: { type: "user", uuid: "turn", text: "Check routing", createdAt: START },
	segments: [segment],
	notices: [],
	live: false,
};
const surfacing = {
	status: {
		...DEFAULT_MESSAGE_SURFACING_SETTINGS,
		summariesEnabled: true,
		active: false,
		key: { source: "none" as const, rejected: false },
	},
	categorySet: DEFAULT_CATEGORY_SET,
};
const recap: TurnRecap = {
	sessionId: "session",
	turnId: turn.id,
	version: 1,
	scope: "whole",
	firstOrdinal: 1,
	lastOrdinal: 7,
	text: "Unclassified update [#1]. Previously numbered update [#7].",
	model: "sonnet",
	durationMs: 1000,
	createdAt: START + 4000,
};

beforeEach(() => {
	rpc.mockImplementation(async (tag) => {
		if (tag === "ListRecaps") return [];
		if (tag === "GenerateRecap") return recap;
		throw new Error(`Unexpected RPC: ${tag}`);
	});
	Element.prototype.scrollIntoView = vi.fn();
	vi.stubGlobal("CSS", { escape: (value: string) => value });
});
afterEach(() => {
	cleanup();
	rpc.mockReset();
	vi.unstubAllGlobals();
});

it("keeps a summary generated without Jev clickable and its log numbered after enabling Jev", async () => {
	const { container, rerender } = render(TurnActivity, {
		turn,
		segment,
		final: true,
		sessionId: "session",
		surfacing,
	});
	// The head chip and the phone row share a test id; jsdom renders both.
	await fireEvent.click(
		screen.getAllByTestId("surfacing-summary-generate")[0] as HTMLElement,
	);
	await fireEvent.click(await screen.findByTestId("surfacing-summary-new"));
	await fireEvent.click(await screen.findByTestId("surfacing-recap-cite-1"));
	expect(
		container.querySelector(
			'[data-log-part="first"] [data-message-number="1"]',
		),
	).not.toBeNull();
	await rerender({
		surfacing: {
			...surfacing,
			status: {
				...surfacing.status,
				enabled: true,
				active: true,
				key: { source: "stored", rejected: false },
			},
		},
	});
	await fireEvent.click(screen.getByTestId("surfacing-recap-cite-1"));
	expect(screen.getByTestId("surfacing-recap-reader").textContent).toContain(
		"Unclassified update",
	);
	expect(
		container.querySelector(
			'[data-log-part="first"] [data-message-number="1"]',
		),
	).not.toBeNull();
	expect(
		container.querySelector(
			'[data-log-part="saved"] [data-message-number="7"]',
		),
	).not.toBeNull();
	expect(screen.getByTestId("surfacing-recap-cite-7").textContent?.trim()).toBe(
		"#7",
	);
	expect(
		rpc.mock.calls.filter(([tag]) => tag === "GenerateRecap"),
	).toHaveLength(1);
});

it("renders the base activity strip with both switches off and opens its unnumbered log", async () => {
	const { container } = render(TurnActivity, {
		turn,
		segment,
		final: true,
		surfacing: {
			...surfacing,
			status: { ...surfacing.status, summariesEnabled: false },
		},
	});
	const timeline = screen.getByRole("slider", { name: /Activity timeline/ });
	const base = render(ActivityStrip, {
		turn,
		segment,
		final: true,
		now: START + 4000,
		running: new Set<string>(),
	});
	expect(timeline.outerHTML).toBe(
		within(base.container).getByRole("slider").outerHTML,
	);
	base.unmount();
	expect(timeline.getAttribute("aria-valuetext")).toContain("1s");
	await fireEvent.focus(timeline);
	await waitFor(() =>
		expect(screen.getByRole("tooltip").textContent).toContain("1s"),
	);
	await fireEvent.keyDown(timeline, { key: "Enter" });
	// The strip opens the log at its step, as today, without moving focus into it.
	await waitFor(() =>
		expect(container.querySelector('[data-highlighted="true"]')).not.toBeNull(),
	);
	expect(document.activeElement?.closest("[data-log-part]")).toBeNull();
	expect(container.querySelector("[data-message-number]")).toBeNull();
	expect(screen.queryByTestId("surfacing-summary-generate")).toBeNull();
	expect(screen.queryByTestId("surfacing-minimise-toggle")).toBeNull();
});
