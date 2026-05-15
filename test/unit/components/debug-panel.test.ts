import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DebugPanel from "../../../src/lib/frontend/components/debug/DebugPanel.svelte";
import { wsDebugState } from "../../../src/lib/frontend/stores/ws-debug.svelte.js";

interface SetLogLevelInput {
	readonly projectSlug: string;
	readonly level: "info" | "verbose" | "debug";
}

const setLogLevelRpcSpy = vi.hoisted(() =>
	vi.fn<(input: SetLogLevelInput) => Promise<void>>(async () => {
		throw new Error("RPC unavailable");
	}),
);

vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: () => "conduit",
}));

vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	setLogLevelRpc: (input: SetLogLevelInput) => setLogLevelRpcSpy(input),
}));

describe("DebugPanel", () => {
	beforeEach(() => {
		wsDebugState.verboseMessages = false;
		setLogLevelRpcSpy.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it("keeps local verbose logging enabled when the relay RPC is unavailable", async () => {
		const { getByText } = render(DebugPanel, {
			props: { visible: true },
		});

		await fireEvent.click(getByText("verbose:off"));
		await waitFor(() => {
			expect(setLogLevelRpcSpy).toHaveBeenCalledWith({
				projectSlug: "conduit",
				level: "verbose",
			});
		});
		await tick();

		expect(getByText("verbose:on")).toBeTruthy();
	});
});
