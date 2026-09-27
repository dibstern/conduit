import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
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

vi.mock("../../../src/lib/frontend/components/ui/Icon.svelte", emptyComponent);
vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: () => "project-a",
}));
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	listDirectoriesRpc: (input: { projectSlug: string; path: string }) =>
		listDirectoriesRpcSpy(input),
}));

/**
 * Real `requestAnimationFrame` runs after Svelte has flushed the DOM, so a
 * synchronous stub would let `scrollActiveIntoView` read the previous active
 * row. Queue the callbacks instead and drain them after `tick()`.
 */
let frames: FrameRequestCallback[] = [];

async function flushFrames(): Promise<void> {
	await tick();
	const pending = frames;
	frames = [];
	for (const frame of pending) frame(0);
}

async function typePath(input: HTMLElement, path: string): Promise<void> {
	await fireEvent.input(input, { target: { value: path } });
	await vi.advanceTimersByTimeAsync(151);
	await tick();
}

describe("DirectoryAutocomplete", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		listDirectoriesRpcSpy.mockClear();
		frames = [];
		vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => {
			frames.push(frame);
			return frames.length;
		});
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
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

	it("completes the combobox relationship on its own input", async () => {
		const { getByRole, getAllByRole } = render(DirectoryAutocomplete);
		const input = getByRole("combobox", {
			name: "Project directory",
		}) as HTMLInputElement;

		expect(input.getAttribute("aria-expanded")).toBe("false");
		expect(input.hasAttribute("aria-controls")).toBe(false);
		expect(input.hasAttribute("aria-activedescendant")).toBe(false);

		await typePath(input, "/src/");

		const listbox = getByRole("listbox", { name: "Directory suggestions" });
		expect(listbox.classList.contains("dir-autocomplete-list")).toBe(true);
		expect(listbox.hasAttribute("tabindex")).toBe(false);
		expect(listbox.hasAttribute("aria-activedescendant")).toBe(false);
		expect(input.getAttribute("aria-expanded")).toBe("true");
		expect(
			document.getElementById(input.getAttribute("aria-controls") ?? ""),
		).toBe(listbox);

		const options = getAllByRole("option");
		expect(options.map((option) => option.id)).toEqual([
			`${listbox.id}-option-0`,
			`${listbox.id}-option-1`,
		]);
		for (const option of options) {
			expect(listbox.contains(option)).toBe(true);
			// The contract is "never a tab stop", not "no tabindex attribute".
			// tabindex="-1" satisfies it and is what FileMenu and CommandMenu
			// both carry; dropping the attribute entirely is the more canonical
			// aria-activedescendant shape, but it is a change HEAD did not have,
			// so it belongs in the normalize pass applied to all three consumers
			// at once — not to one of three inside a swap commit.
			expect(option.getAttribute("tabindex")).toBe("-1");
			expect(option).not.toBe(document.activeElement);
		}

		const selected = options.filter(
			(option) => option.getAttribute("aria-selected") === "true",
		);
		expect(selected).toHaveLength(1);
		expect(
			document.getElementById(
				input.getAttribute("aria-activedescendant") ?? "",
			),
		).toBe(selected[0]);
	});

	it("keeps Tab as a drill into the active directory, not a commit", async () => {
		const { getByRole, getAllByRole } = render(DirectoryAutocomplete);
		const input = getByRole("combobox", {
			name: "Project directory",
		}) as HTMLInputElement;

		await typePath(input, "/src/");
		await fireEvent.keyDown(input, { key: "ArrowDown" });
		await tick();
		expect(getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe(
			"true",
		);

		listDirectoriesRpcSpy.mockClear();
		const notCancelled = await fireEvent.keyDown(input, { key: "Tab" });
		await vi.advanceTimersByTimeAsync(0);
		await tick();

		expect(notCancelled).toBe(false);
		expect(input.value).toBe("/src/personal/");
		expect(listDirectoriesRpcSpy).toHaveBeenCalledWith({
			projectSlug: "project-a",
			path: "/src/personal/",
		});
		// Drill, not commit: the surface stays open on the next level.
		expect(
			getByRole("listbox", { name: "Directory suggestions" }),
		).toBeTruthy();
		expect(input.getAttribute("aria-expanded")).toBe("true");
	});

	it("commits and closes on Enter while open", async () => {
		const { getByRole, queryByRole } = render(DirectoryAutocomplete);
		const input = getByRole("combobox", {
			name: "Project directory",
		}) as HTMLInputElement;

		await typePath(input, "/src/");
		const notCancelled = await fireEvent.keyDown(input, { key: "Enter" });
		await tick();

		expect(notCancelled).toBe(false);
		expect(input.value).toBe("/src/work/");
		expect(
			queryByRole("listbox", { name: "Directory suggestions" }),
		).toBeNull();
		expect(input.getAttribute("aria-expanded")).toBe("false");
	});

	it("submits on Enter while closed", async () => {
		const onsubmit = vi.fn();
		const { getByRole } = render(DirectoryAutocomplete, { onsubmit });
		const input = getByRole("combobox", { name: "Project directory" });

		const notCancelled = await fireEvent.keyDown(input, { key: "Enter" });

		expect(notCancelled).toBe(false);
		expect(onsubmit).toHaveBeenCalledOnce();
	});

	it("consumes Escape while open and lets it bubble while closed", async () => {
		const parentEscape = vi.fn();
		document.body.addEventListener("keydown", parentEscape);
		try {
			const { getByRole, queryByRole } = render(DirectoryAutocomplete);
			const input = getByRole("combobox", { name: "Project directory" });

			await typePath(input, "/src/");
			const openEscape = await fireEvent.keyDown(input, { key: "Escape" });
			await tick();

			expect(openEscape).toBe(false);
			expect(parentEscape).not.toHaveBeenCalled();
			expect(
				queryByRole("listbox", { name: "Directory suggestions" }),
			).toBeNull();

			const closedEscape = await fireEvent.keyDown(input, { key: "Escape" });

			expect(closedEscape).toBe(true);
			expect(parentEscape).toHaveBeenCalledOnce();
		} finally {
			document.body.removeEventListener("keydown", parentEscape);
		}
	});

	it("keeps the list through 199 ms after blur and closes at 200 ms", async () => {
		const { getByRole, queryByRole } = render(DirectoryAutocomplete);
		const input = getByRole("combobox", { name: "Project directory" });

		await typePath(input, "/src/");
		await fireEvent.blur(input);

		await vi.advanceTimersByTimeAsync(199);
		await tick();
		expect(
			queryByRole("listbox", { name: "Directory suggestions" }),
		).not.toBeNull();

		await vi.advanceTimersByTimeAsync(1);
		await tick();
		expect(
			queryByRole("listbox", { name: "Directory suggestions" }),
		).toBeNull();
	});

	it("scrolls the active option, still a descendant of the inline list", async () => {
		const scrollTargets: Element[] = [];
		const scrollIntoView = vi.fn(function (this: Element) {
			scrollTargets.push(this);
		});
		Element.prototype.scrollIntoView = scrollIntoView;

		const { getByRole, getAllByRole } = render(DirectoryAutocomplete);
		const input = getByRole("combobox", { name: "Project directory" });

		await typePath(input, "/src/");
		const listbox = getByRole("listbox", { name: "Directory suggestions" });
		await fireEvent.keyDown(input, { key: "ArrowDown" });
		await flushFrames();

		const options = getAllByRole("option");
		expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
		expect(scrollTargets).toHaveLength(1);
		expect(scrollTargets[0]).toBe(options[1]);
		expect(listbox.contains(scrollTargets[0] as Element)).toBe(true);
	});
});
