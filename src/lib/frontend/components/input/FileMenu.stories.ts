import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect } from "storybook/test";
import { menuOpensUpwardFrame } from "../../stories/frames";
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
	// See conduit-test-7jv.
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
 * intended behaviour, ratified as decision 3B on conduit-test-qf3s: there is no
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
