import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { effortOptions, requireRpcControl } from "./shared.js";

const sessionId = "sess-first-send";
// Parameter combinations from basic.jsonl, using the driver's variant labels.
const composerChoices = ["Standard", "Fast"];
const grokChoices = ["low", "medium", "high", "xhigh"].flatMap((effort) => [
	effort,
	`${effort} · Fast`,
]);

export const cursorModelParametersHandlers: StepHandler[] = [
	{
		name: "prepare Cursor parameter catalogue",
		match: /^the Cursor parameter catalogue is ready for (\S+)$/,
		run: ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const modelId = match[1] ?? "";
			const choices =
				modelId === "composer-2.5" ? composerChoices : grokChoices;
			effortOptions.set(world.page, choices);
			rpc.setProjectSetting({
				_tag: "providerModels",
				accountId: "cursor-work",
				providers: [
					{
						id: "cursor",
						name: "Cursor",
						configured: true,
						models: [
							{
								id: "composer-2.5",
								name: "Composer 2.5",
								provider: "cursor",
								variants: composerChoices,
							},
							{
								id: "grok-4.6",
								name: "Grok 4.6",
								provider: "cursor",
								variants: grokChoices,
							},
						],
					},
				],
			});
			const {
				GetModels: getModels,
				GetAgents: getAgents,
				CreateSession: createSession,
				SwitchVariant: switchVariant,
			} = rpc.stubs;
			if (!getModels || !getAgents || !createSession || !switchVariant)
				throw new Error("Cursor parameters wrap the mockup's typed stubs");
			let variant = "";
			rpc.setStubs({
				GetModels: (payload) =>
					payload.instanceId === "cursor-work" ||
					("sessionId" in payload && payload.sessionId === sessionId)
						? {
								projectSlug: "myapp",
								instanceId: "cursor-work",
								providers: [],
								active: { provider: "cursor", model: modelId },
								variant: { variant, variants: choices },
							}
						: getModels(payload),
				GetAgents: (payload) =>
					payload.instanceId === "cursor-work" ||
					("sessionId" in payload && payload.sessionId === sessionId)
						? {
								projectSlug: "myapp",
								instanceId: "cursor-work",
								providerScope: { id: "cursor", name: "Cursor" },
								agents: [],
							}
						: getAgents(payload),
				CreateSession: (payload) => {
					if (payload.instanceId === "cursor-work")
						variant = payload.model?.variant ?? "";
					return createSession(payload);
				},
				SwitchVariant: (payload) => {
					if (payload.sessionId === sessionId) variant = payload.variant;
					return switchVariant(payload);
				},
			});
		},
	},
	{
		name: "assert Cursor shared effort choices",
		match: /^the shared effort picker offers Cursor choices (.+)$/,
		run: async ({ world, match }) => {
			const choices = (match[1] ?? "").split(", ");
			const picker = world.page.getByTestId("model-picker");
			await expect(picker.getByTestId("picker-row-effort")).toBeVisible();
			await expect(
				picker.locator('[data-testid^="picker-effort-option-"]'),
			).toHaveCount(choices.length);
			for (const choice of choices)
				await expect(
					picker.getByTestId(`picker-effort-option-${choice}`),
				).toBeVisible();
		},
	},
	{
		name: "assert Cursor parameter options fit the picker",
		match: /^the Cursor parameter options fit inside the model picker$/,
		run: async ({ world }) => {
			const picker = world.page.getByTestId("model-picker");
			const bounds = await picker.boundingBox();
			if (!bounds) throw new Error("Model picker has no visible bounds");
			const options = picker.locator('[data-testid^="picker-effort-option-"]');
			for (const option of await options.all()) {
				const box = await option.boundingBox();
				if (!box) throw new Error("Cursor parameter option is hidden");
				expect(box.x).toBeGreaterThanOrEqual(bounds.x);
				expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
			}
			await expect
				.poll(() =>
					options.evaluateAll((buttons) =>
						buttons.every(
							(button) => button.scrollWidth <= button.clientWidth + 1,
						),
					),
				)
				.toBe(true);
		},
	},
	{
		name: "choose Cursor parameters in shared picker",
		match: /^I choose Cursor parameters (.+) in the shared picker$/,
		run: async ({ world, match }) => {
			const option = world.page.getByTestId(`picker-effort-option-${match[1]}`);
			await option.click();
			await expect(option).toHaveAttribute("aria-checked", "true");
		},
	},
	{
		name: "assert Cursor creation parameters",
		match:
			/^the Cursor session is created with model (\S+) and parameters (.+)$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "CreateSession",
			);
			expect(request.payload["instanceId"]).toBe("cursor-work");
			expect(request.payload["model"]).toMatchObject({
				providerId: "cursor",
				modelId: match[1],
				variant: match[2],
			});
		},
	},
	{
		name: "assert Cursor next-turn parameter switch",
		match: /^the Cursor parameter switch to (.+) is sent for the same session$/,
		run: async ({ world, match }) => {
			await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "SwitchVariant" &&
					request.payload["sessionId"] === sessionId &&
					request.payload["variant"] === match[1],
			);
		},
	},
	{
		name: "assert second Cursor turn stays in session",
		match: /^the same Cursor session receives its second turn$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			await expect
				.poll(
					() =>
						rpc
							.getRequests()
							.filter((request) => request.tag === "input.submit").length,
				)
				.toBe(2);
			expect(
				rpc.getRequests().filter((request) => request.tag === "CreateSession"),
			).toHaveLength(1);
			const submissions = rpc
				.getRequests()
				.filter((request) => request.tag === "input.submit");
			expect(
				submissions.map((request) => request.payload["sessionId"]),
			).toEqual([sessionId, sessionId]);
			expect(submissions[1]?.payload["text"]).toBe("Next Cursor turn");
		},
	},
	{
		name: "assert parameter catalogue preserves other accounts",
		match: /^no project-loading error toast is shown$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.getByRole("status")
					.filter({ hasText: "Failed to load projects" }),
			).toHaveCount(0);
		},
	},
];
