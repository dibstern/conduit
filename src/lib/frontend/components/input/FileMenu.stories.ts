import type { Meta, StoryObj } from "@storybook/svelte-vite";
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

export const NoResults: Story = {
	args: {
		query: "zzzzz",
		visible: true,
		entries: [],
		onSelect: noopSelect,
		onClose: noopClose,
		loading: false,
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
