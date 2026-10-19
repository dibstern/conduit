import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelVariant from "../../../src/lib/frontend/components/model/ModelVariant.svelte";
import {
	applyGetModelsResponse,
	clearDiscoveryState,
	discoveryState,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import type { rpc } from "../../../src/lib/frontend/transport/ws-rpc-client.js";

type SwitchVariantInput = Parameters<typeof rpc<"SwitchVariant">>[1];

const switchVariantRpcSpy = vi.hoisted(() =>
	vi.fn((input: SwitchVariantInput) =>
		Promise.resolve({
			projectSlug: "project-a",
			variant: input.variant,
			variants: ["low", "medium", "high", "max"],
		}),
	),
);
const emptyComponent = vi.hoisted(
	() => async () => import("../../helpers/Empty.svelte"),
);

vi.mock("../../../src/lib/frontend/components/ui/Icon.svelte", emptyComponent);
vi.mock(
	"../../../src/lib/frontend/stores/router.svelte.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/stores/router.svelte.js")
		>()),
		getCurrentSlug: () => "project-a",
	}),
);
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rpc: (tag: string, input: SwitchVariantInput) =>
		tag === "SwitchVariant"
			? switchVariantRpcSpy(input)
			: Promise.reject(new Error("Catalog not configured in this fixture")),
}));

describe("ModelVariant", () => {
	beforeEach(() => {
		switchVariantRpcSpy.mockClear();
		clearDiscoveryState();
		applyGetModelsResponse(
			{
				projectSlug: "project-a",
				instanceId: "claude",
				providers: [],
				active: { model: "sonnet", provider: "claude" },
				variant: { variant: "", variants: ["low", "medium", "high", "max"] },
				contextWindow: { contextWindow: "", options: [] },
			},
			"session-1",
		);
		openSessionForSetup("session-1", "project-a");
	});

	afterEach(() => {
		cleanup();
		openSessionForSetup(null);
	});

	it("switches variants through RPC for the active session", async () => {
		const { getByTestId } = render(ModelVariant);

		await fireEvent.click(getByTestId("variant-badge"));
		await fireEvent.click(getByTestId("variant-option-high"));

		await waitFor(() => {
			expect(switchVariantRpcSpy).toHaveBeenCalledWith({
				sessionId: "session-1",
				variant: "high",
			});
		});
		expect(discoveryState.currentVariant).toBe("high");
	});
});
