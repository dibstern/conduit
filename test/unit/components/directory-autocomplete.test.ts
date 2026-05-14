import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DirectoryAutocomplete from "../../../src/lib/frontend/components/project/DirectoryAutocomplete.svelte";

const listDirectoriesRpcSpy = vi.hoisted(() =>
	vi.fn(async (input: { projectSlug: string; path: string }) => ({
		projectSlug: input.projectSlug,
		path: input.path,
		entries: ["/src/work/", "/src/personal/"],
	})),
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
	listDirectoriesRpc: (input: { projectSlug: string; path: string }) =>
		listDirectoriesRpcSpy(input),
}));

describe("DirectoryAutocomplete", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		listDirectoriesRpcSpy.mockClear();
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("loads directory suggestions through RPC after debounced input", async () => {
		const { getByPlaceholderText, container } = render(DirectoryAutocomplete);
		const input = getByPlaceholderText("/path/to/project") as HTMLInputElement;

		await fireEvent.input(input, { target: { value: "/src/" } });
		await vi.advanceTimersByTimeAsync(151);

		await waitFor(() => {
			expect(listDirectoriesRpcSpy).toHaveBeenCalledWith({
				projectSlug: "project-a",
				path: "/src/",
			});
			expect(container.querySelectorAll(".dir-item")).toHaveLength(2);
		});
	});
});
