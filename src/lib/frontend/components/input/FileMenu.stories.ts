import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
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

// ─── Grouped results (conduit-test-de3.30) ──────────────────────────────────

/**
 * What `filterFiles("…", "src/lib/")` returns: immediate children of the queried
 * directory first, then everything deeper that still matched. `dividerAt` is the
 * boundary — the count of immediate children — and the divider is drawn *between*
 * two options rather than being one, so these indices are also the option indices.
 */
const GROUPED_ENTRIES = [
	"src/lib/frontend/",
	"src/lib/handlers/",
	"src/lib/server.ts",
	"src/lib/frontend/App.svelte",
	"src/lib/frontend/stores/chat.svelte.ts",
	"src/lib/handlers/files.ts",
];
const GROUPED_DIVIDER_AT = 3;

const GROUPED_ARGS = {
	query: "src/lib/",
	visible: true,
	entries: GROUPED_ENTRIES,
	onSelect: noopSelect,
	onClose: noopClose,
	loading: false,
} satisfies Partial<StoryObj<typeof meta>["args"]>;

// Exactly one rule is disabled, and it names a decision open elsewhere:
//
//   color-contrast  Disabled, matching InputArea.stories.ts and
//                   DirectoryAutocomplete.stories.ts. The divider caption uses the
//                   same `text-text-muted` on the menu surface (3.08:1) as the
//                   pre-existing parent-path spans and the "No files found" row —
//                   it introduces no new pair. That floor is conduit-test-de3.28.2,
//                   gated on a pending colour decision; enabling the rule here would
//                   silently make that decision. Expires when de3.28.2 lands.
//
// `aria-allowed-role` and `aria-required-children` stay live — the latter is the
// whole point of these stories, since a divider inside role="listbox" is exactly
// the thing that could break the listbox's owned-children contract.
const STRICT_ARIA = {
	a11y: {
		test: "error",
		config: { rules: [{ id: "color-contrast", enabled: false }] },
	},
} as const;

/**
 * The divider renders once, in the right place, and is invisible to AT — a
 * `role="listbox"` may own only `option` and `group`, so it must not count as a
 * child. Keyboard traffic is driven through the real exported `handleKeydown`, the
 * same way InputArea drives it, to prove the wrap needs no divider-skip logic.
 */
export const GroupedResults: Story = {
	tags: ["viewport-capture"],
	parameters: STRICT_ARIA,
	args: { ...GROUPED_ARGS, dividerAt: GROUPED_DIVIDER_AT },
	render: (args) => ({ Component: FileMenuGroupedDemo, props: args }),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole("listbox", { name: "File suggestions" });

		const options = canvas.getAllByRole("option");
		// The divider is not an option: 1:1 with entries, which is what keeps the
		// `-option-{i}` ids and `activeIndex` arithmetic correct.
		await expect(options).toHaveLength(GROUPED_ENTRIES.length);

		const dividers = canvasElement.querySelectorAll(
			'[data-testid="file-menu-divider"]',
		);
		await expect(dividers).toHaveLength(1);
		const divider = dividers[0] as HTMLElement;
		await expect(divider).toHaveAttribute("aria-hidden", "true");
		await expect(divider).not.toHaveAttribute("role", "option");
		// Placement, not just presence: it sits between the last immediate child and
		// the first deeper descendant.
		await expect(divider.previousElementSibling).toBe(
			options[GROUPED_DIVIDER_AT - 1],
		);
		await expect(divider.nextElementSibling).toBe(options[GROUPED_DIVIDER_AT]);

		// ── ArrowDown walks every option, crosses the boundary, and wraps ─────────
		const composer = canvas.getByTestId("composer");
		composer.focus();
		await expect(options[0]).toHaveAttribute("aria-selected", "true");

		for (let i = 1; i < GROUPED_ENTRIES.length; i += 1) {
			await userEvent.keyboard("{ArrowDown}");
			await expect(canvas.getByTestId("active-index")).toHaveTextContent(
				String(i),
			);
			// The boundary step lands on the first deeper entry, never on the divider.
			await expect(options[i]).toHaveAttribute("aria-selected", "true");
			await expect(divider).not.toHaveAttribute("aria-selected");
		}

		await userEvent.keyboard("{ArrowDown}");
		await expect(canvas.getByTestId("active-index")).toHaveTextContent("0");
		await expect(options[0]).toHaveAttribute("aria-selected", "true");

		await userEvent.keyboard("{ArrowUp}");
		await expect(canvas.getByTestId("active-index")).toHaveTextContent(
			String(GROUPED_ENTRIES.length - 1),
		);
	},
};

/** `dividerAt === 0` — nothing matched as an immediate child, so no divider. */
export const GroupedNoImmediateChildren: Story = {
	tags: ["viewport-capture"],
	parameters: STRICT_ARIA,
	args: { ...GROUPED_ARGS, dividerAt: 0 },
	render: (args) => ({ Component: FileMenuGroupedDemo, props: args }),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole("listbox", { name: "File suggestions" });
		await expect(
			canvasElement.querySelectorAll('[data-testid="file-menu-divider"]'),
		).toHaveLength(0);
		await expect(canvas.getAllByRole("option")).toHaveLength(
			GROUPED_ENTRIES.length,
		);
	},
};

/** `dividerAt === entries.length` — everything is an immediate child, so no divider. */
export const GroupedAllImmediateChildren: Story = {
	tags: ["viewport-capture"],
	parameters: STRICT_ARIA,
	args: { ...GROUPED_ARGS, dividerAt: GROUPED_ENTRIES.length },
	render: (args) => ({ Component: FileMenuGroupedDemo, props: args }),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole("listbox", { name: "File suggestions" });
		await expect(
			canvasElement.querySelectorAll('[data-testid="file-menu-divider"]'),
		).toHaveLength(0);
	},
};
