import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { menuOpensUpwardFrame } from "../../stories/frames";
import FileMenuGroupedDemo from "./__fixtures__/FileMenuGroupedDemo.svelte";
import FileMenu from "./FileMenu.svelte";

const sampleEntries = [
	"src/lib/server.ts",
	"src/lib/frontend/App.svelte",
	"src/lib/frontend/stores/chat.svelte.ts",
	"src/lib/frontend/stores/discovery.svelte.ts",
	"src/lib/frontend/utils/format.ts",
	"src/lib/handlers/files.ts",
	"src/lib/handlers/",
	"src/lib/frontend/",
	"test/unit/prompts.test.ts",
	"package.json",
];

const noopSelect = (_path: string) => {};
const noopClose = () => {};

const meta = {
	title: "Input/FileMenu",
	component: FileMenu,
	tags: ["autodocs"],
	parameters: {
		layout: "padded",
	},
	// Standalone stories render without InputArea, which owns the textarea that
	// points `aria-controls` here. A fixed id keeps the listbox named and stable.
	args: {
		listboxId: "file-menu-listbox",
	},
	// This menu opens upward (`absolute bottom-full`), so without a positioned
	// ancestor it renders above the viewport and the capture is a blank page.
	beforeEach: () => menuOpensUpwardFrame(),
} satisfies Meta<typeof FileMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithResults: Story = {
	args: {
		query: "lib",
		visible: true,
		entries: sampleEntries,
		onSelect: noopSelect,
		onClose: noopClose,
		loading: false,
	},
};

export const Loading: Story = {
	args: {
		query: "",
		visible: true,
		entries: [],
		onSelect: noopSelect,
		onClose: noopClose,
		loading: true,
	},
};

/**
 * Typing a query with no matches dismisses the menu silently. That is the
 * intended behaviour: there is no
 * "no results" empty state, and the markup that used to imply one was
 * unreachable in every state and has been deleted.
 *
 * Excluded from visual capture (SKIP_STORIES in test/visual/components.spec.ts)
 * because the render is empty: the baseline was a blank PNG, and a blank PNG
 * compares equal to any other blank PNG, so the pixels could never have caught a
 * regression. The behaviour is asserted in play() instead, where it is real.
 */
export const HidesWhenNoMatches: Story = {
	args: {
		query: "zzzzz",
		visible: true,
		entries: [],
		onSelect: noopSelect,
		onClose: noopClose,
		loading: false,
	},
	play: ({ canvasElement }) => {
		expect(canvasElement.querySelector('[role="listbox"]')).toBeNull();
	},
};

export const ManyResults: Story = {
	args: {
		query: "test",
		visible: true,
		entries: Array.from({ length: 20 }, (_, i) => `test/unit/test-${i}.ts`),
		onSelect: noopSelect,
		onClose: noopClose,
		loading: false,
	},
};

export const SingleResult: Story = {
	args: {
		query: "package",
		visible: true,
		entries: ["package.json"],
		onSelect: noopSelect,
		onClose: noopClose,
		loading: false,
	},
};

export const DirectoriesOnly: Story = {
	args: {
		query: "",
		visible: true,
		entries: ["src/", "test/", "node_modules/", "docs/"],
		onSelect: noopSelect,
		onClose: noopClose,
		loading: false,
	},
};

const groupedEntries = [
	"src/lib/frontend/",
	"src/lib/handlers/",
	"src/lib/server.ts",
	"src/lib/frontend/App.svelte",
	"src/lib/frontend/stores/chat.svelte.ts",
	"src/lib/handlers/files.ts",
];
const groupedDividerAt = 3;
const groupedArgs = {
	query: "src/lib/",
	visible: true,
	entries: groupedEntries,
	onSelect: noopSelect,
	onClose: noopClose,
	loading: false,
} satisfies Partial<Story["args"]>;

export const GroupedResults: Story = {
	tags: ["viewport-capture"],
	args: { ...groupedArgs, dividerAt: groupedDividerAt },
	render: (args) => ({ Component: FileMenuGroupedDemo, props: args }),
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole("listbox", { name: "File suggestions" });
		const options = canvas.getAllByRole("option");
		await expect(options).toHaveLength(groupedEntries.length);
		for (const [index, option] of options.entries()) {
			await expect(option).toHaveAttribute(
				"id",
				`${args["listboxId"]}-option-${index}`,
			);
		}

		const dividers = canvasElement.querySelectorAll(
			'[data-testid="file-menu-divider"]',
		);
		await expect(dividers).toHaveLength(1);
		const divider = dividers[0];
		await expect(divider).toHaveAttribute("role", "presentation");
		await expect(divider).toHaveAttribute("aria-hidden", "true");
		await expect(divider).toHaveTextContent("in subfolders");
		await expect(divider?.previousElementSibling).toBe(
			options[groupedDividerAt - 1],
		);
		await expect(divider?.nextElementSibling).toBe(options[groupedDividerAt]);

		const composer = canvas.getByTestId("composer");
		composer.focus();
		await expect(options[0]).toHaveAttribute("aria-selected", "true");
		await expect(composer).toHaveAttribute("aria-controls", args["listboxId"]);
		await expect(composer).toHaveAttribute(
			"aria-activedescendant",
			options[0]?.id,
		);

		for (let i = 1; i <= groupedEntries.length; i += 1) {
			await userEvent.keyboard("{ArrowDown}");
			const index = i % groupedEntries.length;
			await expect(canvas.getByTestId("active-index")).toHaveTextContent(
				String(index),
			);
			await expect(options[index]).toHaveAttribute("aria-selected", "true");
			await expect(composer).toHaveAttribute(
				"aria-activedescendant",
				options[index]?.id,
			);
			await expect(divider).not.toHaveAttribute("aria-selected");
		}

		for (let i = groupedEntries.length - 1; i >= groupedDividerAt; i -= 1) {
			await userEvent.keyboard("{ArrowUp}");
			await expect(options[i]).toHaveAttribute("aria-selected", "true");
			await expect(composer).toHaveAttribute(
				"aria-activedescendant",
				options[i]?.id,
			);
		}
		await userEvent.keyboard("{Enter}");
		await expect(canvas.getByTestId("selected-path").textContent).toBe(
			groupedEntries[groupedDividerAt],
		);
		await userEvent.keyboard("{ArrowUp}");
		await expect(options[groupedDividerAt - 1]).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(composer).toHaveAttribute(
			"aria-activedescendant",
			options[groupedDividerAt - 1]?.id,
		);
	},
};

export const GroupedNoImmediateChildren: Story = {
	tags: ["viewport-capture"],
	args: {
		...groupedArgs,
		entries: groupedEntries.slice(groupedDividerAt),
		dividerAt: 0,
	},
	render: (args) => ({ Component: FileMenuGroupedDemo, props: args }),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole("listbox", { name: "File suggestions" });
		await expect(
			canvasElement.querySelectorAll('[data-testid="file-menu-divider"]'),
		).toHaveLength(0);
		await expect(canvas.getAllByRole("option")).toHaveLength(
			groupedEntries.length - groupedDividerAt,
		);
	},
};

export const GroupedAllImmediateChildren: Story = {
	tags: ["viewport-capture"],
	args: {
		...groupedArgs,
		entries: groupedEntries.slice(0, groupedDividerAt),
		dividerAt: groupedDividerAt,
	},
	render: (args) => ({ Component: FileMenuGroupedDemo, props: args }),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole("listbox", { name: "File suggestions" });
		await expect(
			canvasElement.querySelectorAll('[data-testid="file-menu-divider"]'),
		).toHaveLength(0);
		await expect(canvas.getAllByRole("option")).toHaveLength(groupedDividerAt);
	},
};
