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
		discoveryState.agentProviderScope = { id: "claude", name: "Claude" };
		discoveryState.agents = [
			{
				id: "code",
				name: "Code",
				description: "Writes code changes in the workspace",
			},
			{
				id: "plan",
				name: "Plan",
				description: "Creates implementation plans without editing files",
				model: "opus",
			},
		];
		discoveryState.activeAgentId = "code";
		sessionState.currentId = "session-1";
		vi.stubGlobal("innerHeight", 768);
		vi.stubGlobal("innerWidth", 1024);
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		cleanup();
		document.querySelector("[data-testid='agent-dropdown']")?.remove();
		sessionState.currentId = null;
		vi.unstubAllGlobals();
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

	it("renders scoped compact rows in provider order", async () => {
		const { getByTitle, queryByText } = render(AgentSelector);

		await fireEvent.click(getByTitle("Switch agent"));

		expect(document.body.textContent).toContain("Claude agents");
		expect(queryByText("Writes code changes in the workspace")).toBeNull();
		const rows = Array.from(
			document.body.querySelectorAll<HTMLButtonElement>("[data-agent-id]"),
		);
		expect(rows.map((row) => row.dataset["agentId"])).toEqual(["code", "plan"]);
		expect(rows[0]?.getAttribute("title")).toBe(
			"Writes code changes in the workspace",
		);
		expect(
			rows[1]?.querySelector("[data-testid='agent-model-badge']")?.textContent,
		).toContain("opus");
		expect(rows[0]?.className).toContain("text-accent");
	});

	it("uses provider scope in the empty state", async () => {
		discoveryState.agentProviderScope = { id: "opencode", name: "OpenCode" };
		discoveryState.agents = [];
		discoveryState.activeAgentId = null;
		const { getByTitle } = render(AgentSelector);

		await fireEvent.click(getByTitle("Switch agent"));

		expect(document.body.textContent).toContain("OpenCode agents");
		expect(document.body.textContent).toContain("No OpenCode agents available");
	});

	it("selects the highlighted agent with the keyboard", async () => {
		const { getByTitle } = render(AgentSelector);

		await fireEvent.click(getByTitle("Switch agent"));
		await fireEvent.keyDown(document, { key: "ArrowDown" });
		await fireEvent.keyDown(document, { key: "Enter" });

		await waitFor(() => {
			expect(switchAgentRpcSpy).toHaveBeenCalledWith({
				projectSlug: "project-a",
				sessionId: "session-1",
				agentId: "plan",
			});
		});
		expect(discoveryState.activeAgentId).toBe("plan");
	});

	it("caps long lists and scrolls the highlighted row into view", async () => {
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		discoveryState.agents = Array.from({ length: 24 }, (_, index) => ({
			id: `agent-${index}`,
			name: `Agent ${index}`,
		}));
		discoveryState.activeAgentId = "agent-0";
		vi.stubGlobal("innerHeight", 220);
		const { getByTitle } = render(AgentSelector);
		const trigger = getByTitle("Switch agent") as HTMLButtonElement;
		trigger.getBoundingClientRect = vi.fn(
			() =>
				({
					left: 16,
					right: 136,
					top: 180,
					bottom: 216,
					width: 120,
					height: 36,
				}) as DOMRect,
		);

		await fireEvent.click(trigger);
		const dropdown = document.body.querySelector<HTMLElement>(
			"[data-testid='agent-dropdown']",
		);
		expect(dropdown).not.toBeNull();
		expect(dropdown?.style.overflowY).toBe("auto");
		expect(Number.parseInt(dropdown?.style.maxHeight ?? "0", 10)).toBeLessThan(
			220,
		);

		await fireEvent.keyDown(document, { key: "ArrowDown" });

		expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
	});
});
