// The tray shows pending inputs; native session cancellation belongs to the composer.
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PendingInputTray from "../../../src/lib/frontend/components/input/PendingInputTray.svelte";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import { rpc } from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import { seedSessions } from "../stores/session-fixtures.js";

vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (original) => ({
		...(await original<
			typeof import("../../../src/lib/frontend/transport/ws-rpc-client.js")
		>()),
		rpc: vi.fn(() => Promise.resolve({ ok: true })),
	}),
);

beforeEach(() => {
	vi.stubGlobal("CSS", { escape: (value: string) => value });
	seedSessions([
		{ id: "tray-session", title: "Retained input", status: "busy" },
		{ id: "other-session", title: "Other", status: "idle" },
	]);
	openSessionForSetup("other-session", "project-a");
	vi.mocked(rpc).mockClear();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	openSessionForSetup(null);
	seedSessions([]);
});

it("shows a retained steer without adding a session Stop action", () => {
	render(PendingInputTray, {
		sessionId: "tray-session",
		inputs: [
			{
				inputId: "retained-steer",
				state: "steering",
				request: { text: "correction" },
				admittedAt: 1,
			},
		],
		onEdit: vi.fn(),
		onSteerRefused: vi.fn(),
	});
	expect(screen.queryByRole("button", { name: "Stop session" })).toBeNull();
	expect(rpc).not.toHaveBeenCalled();
	expect(
		screen.queryByRole("button", { name: "Remove queued message" }),
	).toBeNull();
});

it("keeps queued input controls distinct from session Stop", async () => {
	render(PendingInputTray, {
		sessionId: "tray-session",
		inputs: [
			{
				inputId: "queued-input",
				state: "queued",
				request: { text: "later" },
				admittedAt: 2,
			},
		],
		onEdit: vi.fn(),
		onSteerRefused: vi.fn(),
	});
	expect(screen.queryByRole("button", { name: "Stop session" })).toBeNull();
	expect(screen.getByRole("button", { name: "Run now" })).toBeDefined();
	expect(
		screen.getByRole("button", { name: "Edit queued message" }),
	).toBeDefined();
	await fireEvent.click(
		screen.getByRole("button", { name: "Remove queued message" }),
	);
	await waitFor(() => {
		expect(rpc).toHaveBeenCalledExactlyOnceWith("input.cancel", {
			sessionId: "tray-session",
			inputId: "queued-input",
		});
	});
});
