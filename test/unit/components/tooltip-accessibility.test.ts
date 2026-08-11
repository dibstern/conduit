import { cleanup, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emptyComponent = vi.hoisted(
	() => async () => import("../../helpers/Empty.svelte"),
);

vi.mock(
	"../../../src/lib/frontend/components/ui/ConduitLogo.svelte",
	emptyComponent,
);
vi.mock("../../../src/lib/frontend/components/ui/Icon.svelte", emptyComponent);
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	createPtyRpc: vi.fn(async () => undefined),
	setProjectInstanceRpc: vi.fn(async () => undefined),
	startInstanceRpc: vi.fn(async () => undefined),
}));

import Header from "../../../src/lib/frontend/components/layout/Header.svelte";
import ConnectOverlay from "../../../src/lib/frontend/components/overlays/ConnectOverlay.svelte";
import SessionItem from "../../../src/lib/frontend/components/session/SessionItem.svelte";
import { wsState } from "../../../src/lib/frontend/stores/ws.svelte.js";

describe("non-focusable tooltip accessibility", () => {
	beforeEach(() => {
		wsState.status = "disconnected";
		wsState.statusText = "Disconnected";
		wsState.relayStatus = undefined;
		wsState.relayError = undefined;
	});

	afterEach(() => {
		cleanup();
	});

	it("renders screen-reader text for a forked session", () => {
		render(SessionItem, {
			props: {
				session: {
					id: "child-session",
					title: "Forked work",
					parentID: "parent-session",
				},
			},
		});

		const forkedSessionText = screen.getByText("Forked session");
		expect(forkedSessionText.classList.contains("sr-only")).toBe(true);
	});

	it("renders the full relay error with wrapping and scrolling", () => {
		const relayError = `ProviderError: ${"unbroken".repeat(40)}`;
		wsState.relayStatus = "error";
		wsState.relayError = relayError;

		render(ConnectOverlay);

		const error = screen.getByText(relayError);
		expect(error.textContent).toBe(relayError);
		expect(error.classList.contains("truncate")).toBe(false);
		expect(error.hasAttribute("title")).toBe(false);
		expect(error.classList.contains("break-words")).toBe(true);
		expect(error.classList.contains("overflow-y-auto")).toBe(true);
		expect(error.classList.contains("font-mono")).toBe(true);
	});

	it("announces connection state changes through the status region", async () => {
		render(Header);

		const status = screen.getByRole("status");
		expect(status.textContent).toBe("Disconnected");
		expect(status.querySelector(".sr-only")?.textContent).toBe("Disconnected");

		wsState.status = "connected";
		wsState.statusText = "Connected";
		await tick();

		expect(status.textContent).toBe("Connected");
		expect(status.getAttribute("title")).toBe("Connected");
	});
});
