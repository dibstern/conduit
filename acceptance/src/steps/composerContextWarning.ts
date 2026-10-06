import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import {
	openModelPicker,
	requireRelayControl,
	requireRpcControl,
} from "./shared.js";

export const composerContextWarningHandlers: StepHandler[] = [
	{
		name: "choose composer context warning threshold",
		match:
			/^I choose (60|70|80|90|Never|default) for composer context warnings$/,
		run: async ({ world, match }) => {
			const threshold = match[1] ?? "default";
			const control = world.page.getByTestId(
				`settings-composer-context-warning-${threshold === "default" ? "80" : threshold.toLowerCase()}`,
			);
			if (threshold !== "default") await control.click();
			await expect(control).toHaveAttribute("aria-checked", "true");
			await world.page.getByTestId("settings-close-btn").click();
			await expect(world.page.locator("#settings-panel")).toBeHidden();
		},
	},
	{
		name: "report context usage through mock relay transcript",
		match: /^the mock relay reports context ([0-9]+(?:\.[0-9]+)?) percent$/,
		run: async ({ world, match }) => {
			const percent = Number(match[1]);
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("Context usage requires an open session");
			// Usage reaches the composer through the durable detail feed, not a raw result.
			requireRelayControl(world.page).sendMessage({
				type: "mock_transcript_snapshot",
				sessionId,
				history: {
					messages: [
						{
							id: "context-warning-turn",
							role: "assistant",
							time: { created: 1_000, completed: 2_000 },
							parts: [],
							tokens: {
								input: (percent / 100) * 200_000,
								output: 0,
								cache: { read: 0, write: 0 },
								context_window: 200_000,
							},
						},
					],
					hasMore: false,
				},
			});
			// Wait for the actual percent before asserting that a warning is absent.
			await openModelPicker(world.page);
			await expect(world.page.getByTestId("picker-context-usage")).toHaveText(
				`${Math.round(percent)}% used`,
			);
			await world.page.keyboard.press("Escape");
			await expect(world.page.locator("#model-picker")).toHaveCount(0);
			// Escape hands keyboard focus back to the chip; its ring is not part
			// of the state under test and would land in the visual baselines.
			await world.page.evaluate(() =>
				(document.activeElement as HTMLElement | null)?.blur(),
			);
		},
	},
	{
		name: "assert composer context warning visibility",
		match: /^the composer context warning is (visible|not visible)$/,
		run: async ({ world, match }) => {
			const warning = world.page.getByTestId("composer-context-warning");
			if (match[1] === "visible") await expect(warning).toBeVisible();
			else await expect(warning).toBeHidden();
		},
	},
	{
		name: "assert composer context warning copy",
		match: /^the composer context warning reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("composer-context-warning"),
			).toContainText(match[1] ?? "");
		},
	},
	{
		name: "assert context usage warning flag",
		match: /^the (Words row|picker) context usage is (warned|not warned)$/,
		run: async ({ world, match }) => {
			const usage = world.page.getByTestId(
				match[1] === "Words row"
					? "composer-word-context-usage"
					: "picker-context-usage",
			);
			await expect(usage).toBeVisible();
			if (match[2] === "warned")
				await expect(usage).toHaveAttribute("data-warning", "true");
			else await expect(usage).not.toHaveAttribute("data-warning", /.*/);
		},
	},
	{
		name: "press composer Compact action",
		match: /^I press Compact in the composer context warning$/,
		run: async ({ world }) => {
			await world.page.getByTestId("composer-context-compact").click();
		},
	},
	{
		name: "assert Compact RPC text and current session",
		match: /^the Compact RPC sends exactly \/compact for the current session$/,
		run: async ({ world }) => {
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("Compact requires an open session");
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "SendMessage",
			);
			await expect(request.payload["text"]).toBe("/compact");
			await expect(request.payload["sessionId"]).toBe(sessionId);
		},
	},
	{
		name: "replay current session compaction state",
		match:
			/^the mock relay (starts|fails|completes) compaction for the current session$/,
		run: async ({ world, match }) => {
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("Compaction requires an open session");
			const state =
				match[1] === "starts"
					? "started"
					: match[1] === "fails"
						? "failed"
						: "completed";
			// A compaction in progress rides the shell row; its outcome is a
			// projected transcript message (ni8.33).
			const rpc = requireRpcControl(world.page);
			const { compacting: _, ...row } = (rpc.shellRows?.find(
				(candidate) => (candidate as { id?: string }).id === sessionId,
			) ?? { title: sessionId, status: "idle" }) as Record<string, unknown>;
			rpc.upsertShellRow({
				...row,
				id: sessionId,
				...(state === "started" ? { compacting: "Compacting…" } : {}),
			});
			if (state === "started") return;
			requireRelayControl(world.page).sendMessage({
				type: "compaction",
				sessionId,
				state,
				detail:
					state === "failed" ? "Compaction failed." : "Context compacted.",
				...(state === "completed"
					? { preTokens: 170_000, postTokens: 164_000 }
					: {}),
			});
		},
	},
	{
		name: "assert transcript Compacting notice",
		match: /^the transcript has a Compacting notice$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.locator("#messages")
					.getByText("Compacting…", { exact: true }),
			).toBeVisible();
		},
	},
	{
		name: "assert OpenCode has no Compact action",
		match: /^the composer Compact action is absent$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("composer-context-compact"),
			).toHaveCount(0);
		},
	},
];
