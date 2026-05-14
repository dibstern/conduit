import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContextWindowSelector from "../../../src/lib/frontend/components/model/ContextWindowSelector.svelte";
import {
	clearDiscoveryState,
	discoveryState,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

interface SwitchContextWindowInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly contextWindow: string;
}

const switchContextWindowRpcSpy = vi.hoisted(() =>
	vi.fn(async (input: SwitchContextWindowInput) => ({
		projectSlug: input.projectSlug,
		contextWindow: input.contextWindow,
		options: [
			{ value: "200k", label: "200K", isDefault: true },
			{ value: "1m", label: "1M (beta)" },
		],
	})),
);
const emptyComponent = vi.hoisted(
	() => async () => import("../../helpers/Empty.svelte"),
);

vi.mock(
	"../../../src/lib/frontend/components/shared/Icon.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/shared/use-click-outside.svelte.js",
	() => ({
		clickOutside: () => ({ destroy: () => {} }),
	}),
);
vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: () => "project-a",
}));
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	switchContextWindowRpc: (input: SwitchContextWindowInput) =>
		switchContextWindowRpcSpy(input),
}));

describe("ContextWindowSelector", () => {
	beforeEach(() => {
		switchContextWindowRpcSpy.mockClear();
		clearDiscoveryState();
		discoveryState.availableContextWindowOptions = [
			{ value: "200k", label: "200K", isDefault: true },
			{ value: "1m", label: "1M (beta)" },
		];
		discoveryState.currentContextWindow = "";
		sessionState.currentId = "session-1";
	});

	afterEach(() => {
		cleanup();
		sessionState.currentId = null;
	});

	it("switches context windows through RPC for the active session", async () => {
		const { getByTestId } = render(ContextWindowSelector);

		await fireEvent.click(getByTestId("context-window-badge"));
		await fireEvent.click(getByTestId("context-window-option-1m"));

		await waitFor(() => {
			expect(switchContextWindowRpcSpy).toHaveBeenCalledWith({
				projectSlug: "project-a",
				sessionId: "session-1",
				contextWindow: "1m",
			});
		});
		expect(discoveryState.currentContextWindow).toBe("1m");
	});
});
