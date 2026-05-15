import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelVariant from "../../../src/lib/frontend/components/model/ModelVariant.svelte";
import {
	clearDiscoveryState,
	discoveryState,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

interface SwitchVariantInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly variant: string;
}

const switchVariantRpcSpy = vi.hoisted(() =>
	vi.fn(async (input: SwitchVariantInput) => ({
		projectSlug: input.projectSlug,
		variant: input.variant,
		variants: ["low", "medium", "high", "max"],
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
	switchVariantRpc: (input: SwitchVariantInput) => switchVariantRpcSpy(input),
}));

describe("ModelVariant", () => {
	beforeEach(() => {
		switchVariantRpcSpy.mockClear();
		clearDiscoveryState();
		discoveryState.currentVariant = "";
		discoveryState.availableVariants = ["low", "medium", "high", "max"];
		sessionState.currentId = "session-1";
	});

	afterEach(() => {
		cleanup();
		sessionState.currentId = null;
	});

	it("switches variants through RPC for the active session", async () => {
		const { getByTestId } = render(ModelVariant);

		await fireEvent.click(getByTestId("variant-badge"));
		await fireEvent.click(getByTestId("variant-option-high"));

		await waitFor(() => {
			expect(switchVariantRpcSpy).toHaveBeenCalledWith({
				projectSlug: "project-a",
				sessionId: "session-1",
				variant: "high",
			});
		});
		expect(discoveryState.currentVariant).toBe("high");
	});
});
