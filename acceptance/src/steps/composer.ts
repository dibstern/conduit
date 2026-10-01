import type { Page } from "@playwright/test";
import { InputPage } from "../../../test/e2e/page-objects/input.page.js";
import type { StepHandler } from "../runtime.js";
import {
	exampleValue,
	openSessionRoute,
	relayControls,
	rpcControls,
} from "./shared.js";

const composerMessages = new WeakMap<Page, string>();

function booleanExampleValue(
	example: Record<string, string>,
	key: string,
): boolean {
	const value = exampleValue(example, key);
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`Malformed boolean example value for <${key}>: ${value}`);
}

export const composerHandlers: StepHandler[] = [
	{
		name: "type into composer",
		match: /^I type (.*) into the composer$/,
		run: async ({ world, match }) => {
			const message = match[1] ?? "";
			composerMessages.set(world.page, message);
			await new InputPage(world.page).type(message);
		},
	},
	{
		name: "send composer message",
		match: /^I send the composer message$/,
		run: async ({ world }) => {
			await new InputPage(world.page).send();
		},
	},
	{
		name: "replay sent message for selected session",
		match: /^the mock relay replays the sent message for the selected session$/,
		run: async ({ world }) => {
			const message = composerMessages.get(world.page);
			const rpcControl = rpcControls.get(world.page);
			const relayControl = relayControls.get(world.page);
			if (message == null || !rpcControl || !relayControl) {
				throw new Error("Mock relay controls were not initialised");
			}

			const sendRequest = await rpcControl.waitForRequest(
				(request) =>
					request.tag === "SendMessage" && request.payload["text"] === message,
			);
			// Echo the sender's originId like the real relay: the sending tab
			// ignores its own broadcast and keeps its local echo (no duplicate).
			await relayControl.sendMessages([
				{
					type: "user_message",
					text: message,
					originId: sendRequest.payload["originId"],
				},
			]);
		},
	},
	{
		name: "replay subagent family",
		match: /^the mock relay replays a session family with a parent$/,
		run: async ({ world }) => {
			const relayControl = relayControls.get(world.page);
			if (!relayControl) throw new Error("Mock relay was not initialised");
			await openSessionRoute(world.page, "sess-subagent");
			relayControl.sendMessage({
				type: "session_family",
				rootId: "sess-mockup-001",
				sessions: [
					{ id: "sess-mockup-001", title: "Parent session", status: "idle" },
					{
						id: "sess-subagent",
						title: "Subagent session",
						status: "idle",
						parentID: "sess-mockup-001",
					},
				],
			});
		},
	},
	{
		name: "assert transcript message",
		match: /^the transcript shows (.*)$/,
		run: async ({ world, match }) => {
			const message = match[1] ?? "";
			await world.page
				.locator("#messages")
				.getByText(message, { exact: true })
				.waitFor({ state: "visible" });
		},
	},
	{
		name: "assert subagent parent link",
		match: /^the subagent parent link is visible$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("button", { name: /PARENT/ })
				.waitFor({ state: "visible" });
		},
	},
	{
		name: "clear composer",
		match: /^I clear the composer$/,
		run: async ({ world }) => {
			await new InputPage(world.page).type("");
		},
	},
	{
		name: "assert send button state",
		match: /^the send button is (true|false)$/,
		run: async ({ world, example }) => {
			const expectedEnabled = booleanExampleValue(example, "enabled");
			const input = new InputPage(world.page);
			await world.page.waitForFunction(
				(expected) => {
					const send = document.getElementById(
						"send",
					) as HTMLButtonElement | null;
					return send != null && !send.disabled === expected;
				},
				expectedEnabled,
				{ timeout: 2_000 },
			);
			const actualEnabled = await input.sendBtn.isEnabled();
			if (actualEnabled !== expectedEnabled) {
				throw new Error(
					`Expected send button enabled=${expectedEnabled}, got ${actualEnabled}`,
				);
			}
		},
	},
	{
		name: "set approvals mode",
		match: /^I set approvals to (ask|acceptEdits|auto|full)$/,
		run: async ({ world, match }) => {
			const mode = match[1] ?? "";
			await world.page.getByTestId("permission-mode-badge").click();
			await world.page.getByTestId(`permission-mode-option-${mode}`).click();
		},
	},
	{
		name: "assert approvals dropdown omits a mode",
		match:
			/^the approvals dropdown does not offer (ask|acceptEdits|auto|full)$/,
		run: async ({ world, match }) => {
			const mode = match[1] ?? "";
			await world.page.getByTestId("permission-mode-badge").click();
			await world.page.waitForFunction(
				(m) =>
					document.querySelector(
						`[data-testid="permission-mode-option-${m}"]`,
					) === null,
				mode,
				{ timeout: 5_000 },
			);
		},
	},
	{
		name: "assert approvals pill label",
		match: /^the approvals pill shows (Ask|Edits|Auto|Full access)$/,
		run: async ({ world, match }) => {
			const label = match[1] ?? "";
			await world.page.waitForFunction(
				(expected) => {
					const badge = document.querySelector(
						'[data-testid="permission-mode-badge"]',
					);
					return badge?.textContent?.trim().startsWith(expected) ?? false;
				},
				label,
				{ timeout: 2_000 },
			);
		},
	},
];
