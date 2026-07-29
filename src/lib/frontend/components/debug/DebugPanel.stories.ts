import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn, userEvent, within } from "storybook/test";
import { wsState } from "../../stores/ws.svelte.js";
import {
	clearDebugLog,
	wsDebugLog,
	wsDebugLogMessage,
	wsDebugState,
} from "../../stores/ws-debug.svelte.js";
import DebugPanel from "./DebugPanel.svelte";

const FIXED_NOW = Date.parse("2026-02-25T10:30:12.000Z");
const originalDateNow = Date.now;

const meta = {
	title: "Debug/DebugPanel",
	component: DebugPanel,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false, height: "420px" } },
	},
	args: {
		visible: true,
		onClose: fn(),
	},
	beforeEach: () => {
		Date.now = () => FIXED_NOW;
		clearDebugLog();
		wsDebugState.verboseMessages = false;
		wsDebugState.lastTransitionTime = FIXED_NOW - 12_000;
		wsState.status = "connected";
		wsState.statusText = "Connected to the Conduit relay";
		wsState.attempts = 1;
		wsState.relayStatus = "ready";
		return () => {
			Date.now = originalDateNow;
			clearDebugLog();
		};
	},
} satisfies Meta<typeof DebugPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LifecycleEvents: Story = {
	beforeEach: () => {
		wsDebugLog("connect", "connecting", "slug=conduit");
		wsDebugLog("ws:open", "connected", "generation=3");
		wsDebugLog("relay:status", "connected", "ready");
	},
};

export const ExpandedPayload: Story = {
	beforeEach: () => {
		wsDebugState.verboseMessages = true;
		wsDebugLogMessage("connected", "tool_start", {
			type: "tool_start",
			id: "tool-storybook-001",
			name: "Read",
			messageId: "msg-storybook-001",
		});
	},
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole("button", { name: "[+]" }),
		);
	},
};
