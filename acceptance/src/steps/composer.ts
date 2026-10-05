import { expect, type Page } from "@playwright/test";
import { InputPage } from "../../../test/e2e/page-objects/input.page.js";
import { DESKTOP_VIEWPORT } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	exampleValue,
	holdUntilVisible,
	openSessionRoute,
	relayControls,
	requireRpcControl,
	rpcControls,
} from "./shared.js";

const composerMessages = new WeakMap<Page, string>();

async function openApprovalsMenu(page: Page): Promise<void> {
	const menu = page.getByTestId("permission-mode-dropdown");
	if (await menu.isVisible()) return;
	const button = page.getByTestId(
		/^(permission-mode-badge|composer-word-approvals)$/,
	);
	await expect(button).not.toHaveAttribute("aria-busy", "true");
	if (
		(page.viewportSize()?.width ?? 1440) < 768 ||
		(await button.getAttribute("data-testid")) === "composer-word-approvals"
	) {
		await button.press("Shift+F10");
	} else {
		await button.click();
	}
	await expect(menu).toBeVisible();
}

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
		name: "set desktop viewport",
		match: /^the viewport is a desktop$/,
		run: async ({ world }) => {
			await world.driver.setViewport(world.page, DESKTOP_VIEWPORT);
		},
	},
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
		name: "assert command menu entries",
		match: /^the command menu (offers|does not offer) (\S+)$/,
		run: async ({ world, match }) => {
			const names = world.page.locator("#command-menu .cmd-name");
			await names.first().waitFor({ state: "visible" });
			const offered = (await names.allInnerTexts()).map((name) => name.trim());
			const expected = match[1] === "offers";
			if (offered.includes(match[2] ?? "") !== expected) {
				throw new Error(
					`Expected command menu to ${match[1]} ${match[2]}; it lists ${offered.join(", ")}`,
				);
			}
		},
	},
	{
		name: "assert sent text",
		match: /^the relay receives the sent text (.+)$/,
		run: async ({ world, match }) => {
			const rpcControl = rpcControls.get(world.page);
			if (!rpcControl) throw new Error("Mock RPC was not initialised");
			await rpcControl.waitForRequest(
				(request) =>
					request.tag === "SendMessage" && request.payload["text"] === match[1],
			);
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
		match: /^I set approvals to (dontAsk|plan|ask|acceptEdits|auto|full)$/,
		run: async ({ world, match }) => {
			const mode = match[1] ?? "";
			await openApprovalsMenu(world.page);
			await world.page.getByTestId(`permission-mode-option-${mode}`).click();
		},
	},
	{
		name: "assert approvals dropdown omits a mode",
		match:
			/^the approvals dropdown does not offer (dontAsk|plan|ask|acceptEdits|auto|full)$/,
		run: async ({ world, match }) => {
			const mode = match[1] ?? "";
			await openApprovalsMenu(world.page);
			await expect(
				world.page.getByTestId(`permission-mode-option-${mode}`),
			).toHaveCount(0);
		},
	},
	{
		name: "assert approvals chip label",
		match:
			/^the approvals chip shows (Never ask|Plan|Ask|Edits|Auto|Full access)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("permission-mode-badge")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "seed approvals mode",
		match: /^approvals are (dontAsk|plan|ask|acceptEdits|auto|full)$/,
		run: async ({ world, match }) => {
			// The open session's shell row carries its approval mode.
			const rpc = requireRpcControl(world.page);
			const id = decodeURIComponent(
				new URL(world.page.url()).pathname.split("/")[2] ?? "",
			);
			const row = rpc.shellRows?.find(
				(candidate) => (candidate as { id?: string }).id === id,
			);
			rpc.upsertShellRow({
				title: id,
				status: "idle",
				...(row as object | undefined),
				id,
				permissionMode: match[1],
			});
		},
	},
	{
		name: "tap approvals shield",
		match: /^I tap the approvals (shield|word)$/,
		run: async ({ world, match }) => {
			const button = world.page.getByTestId(
				match[1] === "word"
					? "composer-word-approvals"
					: "permission-mode-badge",
			);
			await expect(button).not.toHaveAttribute("aria-busy", "true");
			await button.click();
		},
	},
	{
		name: "hold approvals shield",
		match: /^I hold the approvals (shield|word)$/,
		run: async ({ world, match }) => {
			const button = world.page.getByTestId(
				match[1] === "word"
					? "composer-word-approvals"
					: "permission-mode-badge",
			);
			await expect(button).not.toHaveAttribute("aria-busy", "true");
			await holdUntilVisible(
				button,
				world.page.getByTestId("permission-mode-dropdown"),
			);
		},
	},
	{
		name: "assert approvals micro label and shield",
		match:
			/^the approvals (shield|word) shows (NEVER|PLAN|ASK|EDITS|AUTO|FULL|never|plan|ask|edits|auto|full)$/,
		run: async ({ world, match }) => {
			const word = match[1] === "word";
			const button = world.page.getByTestId(
				word ? "composer-word-approvals" : "permission-mode-badge",
			);
			await expect(button).toHaveText(match[2] ?? "");
			await expect(button.locator("svg")).toHaveCount(word ? 0 : 1);
			await expect(button).not.toHaveAttribute("aria-busy", "true");
		},
	},
	{
		name: "assert approval tone and tint",
		match:
			/^the approvals (shield|word) uses the (never|plan|ask|edits|auto|full) tone(?: with tint (true|false))?$/,
		run: async ({ world, match }) => {
			const button = world.page.getByTestId(
				match[1] === "word"
					? "composer-word-approvals"
					: "permission-mode-badge",
			);
			if (match[3])
				await expect(button).toHaveAttribute("data-tinted", match[3]);
			// The tone animates (transition-colors), so poll until it settles.
			await expect
				.poll(() =>
					button.evaluate((element, tone) => {
						const probe = document.createElement("span");
						probe.style.color = `var(--color-p-${tone})`;
						document.body.append(probe);
						const expected = getComputedStyle(probe).color;
						probe.remove();
						return getComputedStyle(element).color === expected;
					}, match[2] ?? ""),
				)
				.toBe(true);
		},
	},
	{
		name: "assert ranked approvals menu",
		match: /^the approvals menu is ranked (.+)$/,
		run: async ({ world, match }) => {
			const expected = (match[1] ?? "").split(", ");
			const menu = world.page.getByTestId("permission-mode-dropdown");
			await expect(menu).toBeVisible();
			await expect(menu.getByRole("menuitemradio")).toHaveCount(
				expected.length,
			);
			const actual = await menu
				.getByRole("menuitemradio")
				.evaluateAll((items) =>
					items.map((item) =>
						item
							.getAttribute("data-testid")
							?.replace("permission-mode-option-", ""),
					),
				);
			if (actual.join(", ") !== expected.join(", ")) {
				throw new Error(
					`Expected approval order ${expected.join(", ")}, got ${actual.join(", ")}`,
				);
			}
		},
	},
	{
		name: "assert approvals menu description",
		match:
			/^the approvals option (dontAsk|plan|ask|acceptEdits|auto|full) describes (.+)$/,
		run: async ({ world, match }) => {
			const option = world.page.getByTestId(
				`permission-mode-option-${match[1]}`,
			);
			await expect(option).toContainText(match[2] ?? "");
			await expect(option.locator("svg").first()).toBeVisible();
		},
	},
	{
		name: "assert Claude-only approval tags",
		match: /^only dontAsk, plan and auto carry Claude tags$/,
		run: async ({ world }) => {
			for (const mode of [
				"dontAsk",
				"plan",
				"ask",
				"acceptEdits",
				"auto",
				"full",
			]) {
				const option = world.page.getByTestId(`permission-mode-option-${mode}`);
				const tag = option.getByText("Claude", { exact: true });
				await expect(tag).toHaveCount(
					["dontAsk", "plan", "auto"].includes(mode) ? 1 : 0,
				);
			}
		},
	},
	{
		name: "assert approvals menu closed",
		match: /^the approvals menu is closed$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("permission-mode-dropdown"),
			).toHaveCount(0);
		},
	},
];
