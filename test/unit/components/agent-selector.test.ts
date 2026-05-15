import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentSelector from "../../../src/lib/frontend/components/model/AgentSelector.svelte";
import {
	clearDiscoveryState,
	discoveryState,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

interface SwitchAgentInput {
	readonly projectSlug: string;
	readonly sessionId: string;
	readonly agentId: string;
}

const switchAgentRpcSpy = vi.hoisted(() =>
	vi.fn<(input: SwitchAgentInput) => Promise<void>>(async () => undefined),
);
const emptyComponent = vi.hoisted(
	() => async () => import("../../helpers/Empty.svelte"),
);

vi.mock(
	"../../../src/lib/frontend/components/shared/Icon.svelte",
	emptyComponent,
);
vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: () => "project-a",
}));
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	switchAgentRpc: (input: SwitchAgentInput) => switchAgentRpcSpy(input),
}));

describe("AgentSelector", () => {
	beforeEach(() => {
		switchAgentRpcSpy.mockClear();
		clearDiscoveryState();
		discoveryState.agents = [
			{ id: "code", name: "Code" },
			{ id: "plan", name: "Plan" },
		];
		discoveryState.activeAgentId = "code";
		sessionState.currentId = "session-1";
	});

	afterEach(() => {
		cleanup();
		document.querySelector("#agent-dropdown-portal")?.remove();
		sessionState.currentId = null;
	});

	it("switches agents through RPC for the active session", async () => {
		const { getByTitle } = render(AgentSelector);

		await fireEvent.click(getByTitle("Switch agent"));
		const planButton = document.querySelector<HTMLButtonElement>(
			"[data-agent-id='plan']",
		);
		expect(planButton).not.toBeNull();
		await fireEvent.click(planButton as HTMLButtonElement);

		await waitFor(() => {
			expect(switchAgentRpcSpy).toHaveBeenCalledWith({
				projectSlug: "project-a",
				sessionId: "session-1",
				agentId: "plan",
			});
		});
		expect(discoveryState.activeAgentId).toBe("plan");
	});
});
