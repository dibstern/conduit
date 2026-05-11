import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelSelector from "../../../src/lib/frontend/components/model/ModelSelector.svelte";
import {
	clearDiscoveryState,
	discoveryState,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";

const wsSendSpy = vi.hoisted(() => vi.fn());
const emptyComponent = vi.hoisted(
	() => async () => import("../../helpers/Empty.svelte"),
);
const closeableEmptyComponent = vi.hoisted(
	() => async () => import("../../helpers/CloseableEmpty.svelte"),
);

vi.mock(
	"../../../src/lib/frontend/components/shared/Icon.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/model/ModelVariant.svelte",
	closeableEmptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/model/ContextWindowSelector.svelte",
	closeableEmptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/shared/use-click-outside.svelte.js",
	() => ({
		clickOutside: () => ({ destroy: () => {} }),
	}),
);
vi.mock("../../../src/lib/frontend/stores/ws.svelte.js", () => ({
	wsSend: (...args: unknown[]) => wsSendSpy(...args),
}));
vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	showToast: vi.fn(),
}));

describe("ModelSelector", () => {
	beforeEach(() => {
		wsSendSpy.mockClear();
		clearDiscoveryState();
		discoveryState.currentModelId = "claude-sonnet-4-7";
		discoveryState.currentProviderId = "claude";
		discoveryState.providers = [
			{
				id: "claude",
				name: "Anthropic - claude",
				configured: true,
				models: [
					{
						id: "claude-sonnet-4-7",
						name: "Claude Sonnet 4.7",
						provider: "claude",
					},
					{
						id: "claude-opus-4-7",
						name: "Claude Opus 4.7",
						provider: "claude",
					},
				],
			},
		];
	});

	afterEach(() => {
		cleanup();
	});

	it("refreshes active-provider agents after switching model", async () => {
		const { container, getByTitle } = render(ModelSelector);
		await fireEvent.click(getByTitle("Switch model"));
		const opus = container.querySelector<HTMLButtonElement>(
			'[data-model-id="claude-opus-4-7"]',
		);
		expect(opus).not.toBeNull();

		await fireEvent.click(opus as HTMLButtonElement);

		expect(wsSendSpy.mock.calls.map((call) => call[0])).toEqual([
			{
				type: "switch_model",
				modelId: "claude-opus-4-7",
				providerId: "claude",
			},
			{ type: "get_agents" },
		]);
	});
});
