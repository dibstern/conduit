import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InstanceModelPicker from "../../../src/lib/frontend/components/model/InstanceModelPicker.svelte";
import {
	applyGetModelsResponse,
	clearDiscoveryState,
	discoveryState,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

interface SwitchContextWindowInput {
	readonly sessionId: string;
	readonly contextWindow: string;
}

const switchContextWindowRpcSpy = vi.hoisted(() =>
	vi.fn(async (input: SwitchContextWindowInput) => ({
		projectSlug: "project-a",
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

vi.mock("../../../src/lib/frontend/components/ui/Icon.svelte", emptyComponent);
vi.mock(
	"../../../src/lib/frontend/stores/router.svelte.js",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		getCurrentSlug: () => "project-a",
	}),
);
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	switchContextWindowRpc: (input: SwitchContextWindowInput) =>
		switchContextWindowRpcSpy(input),
}));

describe("InstanceModelPicker context window", () => {
	beforeEach(() => {
		Element.prototype.scrollIntoView = vi.fn();
		switchContextWindowRpcSpy.mockClear();
		clearDiscoveryState();
		applyGetModelsResponse(
			{
				projectSlug: "project-a",
				instanceId: "claude",
				providers: [],
				active: { model: "sonnet", provider: "claude" },
				variant: { variant: "", variants: [] },
				contextWindow: {
					contextWindow: "200k",
					options: [
						{ value: "200k", label: "200K", isDefault: true },
						{ value: "1m", label: "1M (beta)" },
					],
				},
			},
			"session-1",
		);
		sessionState.currentId = "session-1";
	});

	afterEach(() => {
		cleanup();
		sessionState.currentId = null;
	});

	it("switches context windows through RPC for the active session", async () => {
		const { getByTestId } = render(InstanceModelPicker);

		await fireEvent.click(getByTestId("composer-harness-trigger"));
		await fireEvent.click(getByTestId("picker-context-option-1m"));

		await waitFor(() => {
			expect(switchContextWindowRpcSpy).toHaveBeenCalledWith({
				sessionId: "session-1",
				contextWindow: "1m",
			});
		});
		expect(discoveryState.currentContextWindow).toBe("1m");
		expect(
			getByTestId("composer-harness-trigger").getAttribute("aria-expanded"),
		).toBe("true");
	});
});
