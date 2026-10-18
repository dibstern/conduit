// Failure modes: dependency inferred from capacity instead of the proposal;
// estimates or paid tests omit required retirements; one failed hunk hides all
// evidence; ticking an addition or unticking its retirement breaks the group.
// A rejected estimate must retain a per-hunk retry, preserve other scores, and
// never imply that unknown or paid estimates are free.
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
	CategorySetContentsSchema,
	DEFAULT_CATEGORY_SET,
} from "../../../src/lib/contracts/category-set.js";
import type { CategoryTuningScore } from "../../../src/lib/contracts/category-tuning.js";
import SurfacingFeedbackTab from "../../../src/lib/frontend/components/overlays/SurfacingFeedbackTab.svelte";
import { surfacingTuningFixture } from "../../e2e/fixtures/surfacing-tuning.js";

const rpc = vi.hoisted(() =>
	vi.fn<(tag: string, payload: unknown) => Promise<unknown>>(),
);
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rpc,
}));
afterEach(() => {
	cleanup();
	rpc.mockReset();
});

it("keeps failed estimates retryable on the same proposal and labels only successful zero-call estimates free", async () => {
	const fixture = surfacingTuningFixture({ marks: 5 });
	const current = DEFAULT_CATEGORY_SET;
	const finding = current.categories.find(({ id }) => id === "finding");
	const risk = current.categories.find(({ id }) => id === "risk");
	if (!finding || !risk) throw new Error("Missing built-in categories");
	const proposal = {
		baseVersion: current.version,
		rationale: "Change findings and adjust risk independently.",
		hunks: [
			{
				id: "finding-criteria",
				categoryId: finding.id,
				before: finding,
				after: { ...finding, criteria: { what: "Measured root causes only" } },
				rationale: "Clarify findings.",
			},
			{
				id: "risk-weight",
				categoryId: risk.id,
				before: risk,
				after: { ...risk, weight: 90 },
				rationale: "Raise risks.",
			},
		],
	};
	const score: CategoryTuningScore = {
		agree: 0,
		total: 5,
		levels: [],
		complete: true,
		requiredCalls: 0,
		jevCalls: 0,
		canTest: true,
	};
	let attempts = 0;
	let paidTests = 0;
	let finishRetry: (() => void) | undefined;
	rpc.mockImplementation(async (tag, payload) => {
		switch (tag) {
			case "GetSurfacingLedger":
				return fixture.records;
			case "GetCategorySet":
				return current;
			case "ProposeCategoryTuning":
				return proposal;
			case "ScoreCategorySet": {
				const { set, estimateOnly } = Schema.decodeUnknownSync(
					Schema.Struct({
						set: CategorySetContentsSchema,
						estimateOnly: Schema.optional(Schema.Boolean),
					}),
				)(payload);
				const criteriaChanged = set.categories.some(
					({ id, criteria }) =>
						id === "finding" && criteria.what === "Measured root causes only",
				);
				const weightChanged = set.categories.some(
					({ id, weight }) => id === "risk" && weight === 90,
				);
				if (criteriaChanged) {
					if (!estimateOnly) paidTests++;
					else if (!weightChanged && !paidTests) {
						attempts++;
						if (attempts <= 2) throw new Error("Estimate unavailable");
						await new Promise<void>((resolve) => {
							finishRetry = resolve;
						});
					}
					return paidTests
						? { ...score, agree: 5 }
						: { ...score, complete: false, requiredCalls: 2 };
				}
				return weightChanged ? { ...score, agree: 4 } : score;
			}
			default:
				throw new Error(`Unexpected RPC: ${tag}`);
		}
	});
	render(SurfacingFeedbackTab, { active: true, onApplied: vi.fn() });
	await fireEvent.click(
		await screen.findByRole("button", { name: "Propose changes" }),
	);
	const failed = await screen.findByTestId(
		"surfacing-proposal-hunk-finding-criteria",
	);
	const healthy = await screen.findByTestId(
		"surfacing-proposal-hunk-risk-weight",
	);
	await waitFor(() =>
		expect(within(healthy).getByText(/Agreement 0 → 4/)).toBeTruthy(),
	);
	const retry = await within(failed).findByRole("button", {
		name: "Retry estimate",
	});
	expect(within(failed).getByRole("alert").textContent).toContain(
		"Could not estimate",
	);
	expect(within(failed).queryByText("free to score")).toBeNull();
	await fireEvent.click(retry);
	await waitFor(() => expect(attempts).toBe(2));
	await waitFor(() =>
		expect(
			within(failed).getByRole<HTMLButtonElement>("button", {
				name: "Retry estimate",
			}).disabled,
		).toBe(false),
	);
	expect(within(failed).getByRole("alert")).toBeTruthy();
	await fireEvent.click(
		within(failed).getByRole("button", { name: "Retry estimate" }),
	);
	await waitFor(() => expect(finishRetry).toBeDefined());
	expect(within(failed).queryByText("free to score")).toBeNull();
	expect(within(healthy).getByText(/Agreement 0 → 4/)).toBeTruthy();
	finishRetry?.();
	const test = await within(failed).findByRole("button", {
		name: "Test · 2 Jev calls",
	});
	expect(within(failed).queryByRole("alert")).toBeNull();
	expect(within(failed).queryByText("free to score")).toBeNull();
	expect(paidTests).toBe(0);
	await fireEvent.click(test);
	await waitFor(() =>
		expect(within(failed).getByText("free to score")).toBeTruthy(),
	);
	expect(paidTests).toBe(1);
	expect(within(healthy).getByText(/Agreement 0 → 4/)).toBeTruthy();
	expect(
		rpc.mock.calls.filter(([tag]) => tag === "ProposeCategoryTuning"),
	).toHaveLength(1);
});

it("uses declared dependencies for estimates, paid tests and selection while preserving other hunk evidence", async () => {
	const fixture = surfacingTuningFixture({ marks: 5 });
	const current = DEFAULT_CATEGORY_SET;
	const ask = current.categories.find(({ id }) => id === "ask");
	const risk = current.categories.find(({ id }) => id === "risk");
	const finding = current.categories.find(({ id }) => id === "finding");
	if (!ask || !risk || !finding) throw new Error("Missing built-in categories");
	const proposal = {
		baseVersion: current.version,
		rationale: "Replace risk and keep independent evidence.",
		hunks: [
			{
				id: "retire-ask",
				categoryId: ask.id,
				before: ask,
				after: { ...ask, retired: true },
				rationale: "Retire ask.",
				dependsOn: [],
			},
			{
				id: "retire-risk",
				categoryId: risk.id,
				before: risk,
				after: { ...risk, retired: true },
				rationale: "Retire risk.",
				dependsOn: [],
			},
			{
				id: "add-new",
				categoryId: "new",
				before: null,
				after: {
					...finding,
					id: "new",
					label: "New",
					origin: "custom",
					weight: 50,
				},
				rationale: "Add the replacement.",
				dependsOn: ["retire-risk"],
			},
			{
				id: "finding-weight",
				categoryId: finding.id,
				before: finding,
				after: { ...finding, weight: 90 },
				rationale: "This score fails independently.",
				dependsOn: [],
			},
		],
	};
	const score: CategoryTuningScore = {
		agree: 0,
		total: 5,
		levels: [],
		complete: true,
		requiredCalls: 0,
		jevCalls: 0,
		canTest: true,
	};
	let paidTests = 0;
	rpc.mockImplementation(async (tag, payload) => {
		switch (tag) {
			case "GetSurfacingLedger":
				return fixture.records;
			case "GetCategorySet":
				return current;
			case "ProposeCategoryTuning":
				return proposal;
			case "ScoreCategorySet": {
				const { set, estimateOnly } = Schema.decodeUnknownSync(
					Schema.Struct({
						set: CategorySetContentsSchema,
						estimateOnly: Schema.optional(Schema.Boolean),
					}),
				)(payload);
				if (
					set.categories.some(
						({ id, weight }) => id === "finding" && weight === 90,
					)
				)
					throw new Error("Independent score failed");
				if (set.categories.some(({ id }) => id === "new")) {
					if (
						!set.categories.some(({ id, retired }) => id === "risk" && retired)
					)
						throw new Error("Missing the declared retirement");
					if (estimateOnly)
						return { ...score, complete: false, requiredCalls: 1 };
					paidTests++;
				}
				return score;
			}
			default:
				throw new Error(`Unexpected RPC: ${tag}`);
		}
	});
	render(SurfacingFeedbackTab, { active: true, onApplied: vi.fn() });
	await fireEvent.click(
		await screen.findByRole("button", { name: "Propose changes" }),
	);
	const retirement = await screen.findByTestId(
		"surfacing-proposal-hunk-retire-risk",
	);
	await waitFor(() =>
		expect(within(retirement).getByText(/Agreement 0 → 0/)).toBeTruthy(),
	);
	const test = await screen.findByTestId("surfacing-proposal-test-add-new");
	expect(test.textContent).toContain("1 Jev calls");
	await fireEvent.click(test);
	await waitFor(() => expect(paidTests).toBe(1));
	await waitFor(() =>
		expect(
			screen.getByRole<HTMLInputElement>("checkbox", {
				name: "Include Risk change",
			}).disabled,
		).toBe(false),
	);
	const required = screen.getByRole<HTMLInputElement>("checkbox", {
		name: "Include Risk change",
	});
	const addition = screen.getByRole<HTMLInputElement>("checkbox", {
		name: "Include New change",
	});
	await fireEvent.click(required);
	expect(required.checked).toBe(false);
	expect(addition.checked).toBe(false);
	await fireEvent.click(addition);
	expect(addition.checked).toBe(true);
	expect(required.checked).toBe(true);
});
