import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectManagerPanel from "../../../src/lib/frontend/components/project/ProjectManagerPanel.svelte";

const addProjectRpcSpy = vi.hoisted(() =>
	vi.fn(async (input: { directory: string }) => ({
		projects: [],
		addedSlug: input.directory,
	})),
);
const emptyComponent = vi.hoisted(
	() => async () => import("../../helpers/Empty.svelte"),
);

vi.mock("../../../src/lib/frontend/components/ui/Icon.svelte", emptyComponent);
vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: () => undefined,
}));
vi.mock("../../../src/lib/frontend/stores/ws.svelte.js", () => ({
	onProject: () => () => undefined,
}));
vi.mock("../../../src/lib/frontend/stores/project.svelte.js", () => ({
	applyProjectMutationResponse: vi.fn(),
}));
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	addProjectRpc: (input: { directory: string }) => addProjectRpcSpy(input),
	removeProjectRpc: vi.fn(),
	renameProjectRpc: vi.fn(),
	listDirectoriesRpc: vi.fn(),
}));

afterEach(() => {
	cleanup();
	addProjectRpcSpy.mockClear();
});

describe("ProjectManagerPanel", () => {
	it("adds the first project when no project is attached", async () => {
		const { getByText, getByRole } = render(ProjectManagerPanel, {
			props: { projects: [], currentSlug: undefined },
		});

		await fireEvent.click(getByText("Add project"));
		await fireEvent.input(getByRole("combobox"), {
			target: { value: "/src/new-project" },
		});
		await fireEvent.click(getByText("Add"));

		await waitFor(() =>
			expect(addProjectRpcSpy).toHaveBeenCalledWith({
				directory: "/src/new-project",
			}),
		);
	});
});
