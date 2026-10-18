import {
	type Category,
	type CategorySetContents,
	type SurfacingFeedbackEntry,
	surfacingLevel,
} from "../../../src/lib/contracts/category-set.js";
import type {
	CategoryTuningHunk,
	CategoryTuningProposal,
	CategoryTuningScore,
} from "../../../src/lib/contracts/category-tuning.js";
import {
	UpdateMessageSurfacing,
	WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";
import { surfacingSettingsFixture } from "./surfacing-settings.js";

export type ProposalFixtureState = "ready" | "pending" | "failed" | "empty";

/** Shared browser seam for acceptance and the real SettingsPanel stories. */
export function surfacingTuningFixture({
	marks = 6,
	key = "valid",
	unjudged = false,
}: {
	marks?: number;
	key?: "valid" | "none";
	unjudged?: boolean;
} = {}) {
	const settings = surfacingSettingsFixture({
		source: key === "valid" ? "stored" : "none",
		rejected: false,
	});
	settings.stubs.UpdateMessageSurfacing(
		new UpdateMessageSurfacing({ enabled: true }),
	);
	const examples = [
		[
			1,
			"finding",
			0.81,
			"raise",
			"balanced",
			"The session switch has three consumers, not one.",
			"changed the plan",
		],
		[
			26,
			"finding",
			0.72,
			"raise",
			"balanced",
			"The push deep link opens before history loads.",
			"users saw this",
		],
		[
			5,
			"milestone",
			0.92,
			"lower",
			"hidden",
			"Contracts for subscribeSessionDetail compile.",
			"just a compile",
		],
		[
			20,
			"risk",
			0.94,
			"retype",
			"key",
			"The badge store still fans out per row.",
			"this was scope creep",
		],
		[
			9,
			"replan",
			0.95,
			"raise",
			"key",
			"Inspect the routing trace before changing the relay.",
			"changed the order",
		],
		[
			21,
			"milestone",
			0.91,
			"lower",
			"hidden",
			"The gate run only reports green.",
			"no useful change",
		],
	] as const;
	let records: SurfacingFeedbackEntry[] = examples
		.slice(0, marks)
		.map(
			(
				[ordinal, category, probability, direction, level, text, reason],
				index,
			) => ({
				projectId: "project-surfacing",
				sessionId: index === 3 ? "session-badges" : "session-routing",
				sessionTitle:
					index === 3 ? "Sidebar unread badges" : "Typed session list",
				partId: `tuning-part-${ordinal}`,
				messageId: `tuning-message-${ordinal}`,
				turnId: "tuning-turn",
				ordinal,
				text,
				requestExcerpt:
					"Review the session routing and identify the next change.",
				probabilities:
					unjudged && index === 5
						? null
						: { [category]: probability, routine: 0.02 },
				mark: {
					level,
					direction,
					reason,
					...(direction === "retype" ? { category: "scope" } : {}),
				},
				createdAt: Date.UTC(2026, 9, 16, 12, index),
			}),
		)
		.reverse();
	const unmarked = [
		{
			partId: "tuning-unmarked-1",
			sessionId: "session-routing",
			probabilities: { finding: 0.85, routine: 0.02 },
		},
		{
			partId: "tuning-unmarked-2",
			sessionId: "session-routing",
			probabilities: { milestone: 0.9, routine: 0.02 },
		},
		{
			partId: "tuning-unmarked-3",
			sessionId: "session-routing",
			probabilities: { replan: 0.95, routine: 0.02 },
		},
	];
	let proposalState: ProposalFixtureState = "ready";
	let pendingProposal: ((proposal: CategoryTuningProposal) => void) | undefined;
	const scoreRequests: {
		set: CategorySetContents;
		estimateOnly: boolean;
		jevCalls: number;
	}[] = [];
	const proposalRequests: { avoid: readonly CategoryTuningHunk[] }[] = [];
	const scoredDefinitions = new Set<string>();
	const category = (id: string): Category => {
		const found = settings.categories.categories.find((item) => item.id === id);
		if (!found) throw new Error(`Missing fixture category ${id}`);
		return found;
	};
	const proposal = (): CategoryTuningProposal => ({
		baseVersion: settings.categories.version,
		rationale:
			"Raise findings and replans that changed the work. Exclude routine gate runs.",
		hunks: [
			{
				id: "finding-weight",
				categoryId: "finding",
				before: category("finding"),
				after: { ...category("finding"), weight: 60 },
				rationale: "Raised findings identified the root cause.",
			},
			{
				id: "milestone-definition",
				categoryId: "milestone",
				before: category("milestone"),
				after: {
					...category("milestone"),
					criteria: {
						...category("milestone").criteria,
						not_for: "build or test runs that only report green",
					},
				},
				rationale: "Lowered milestones were routine gate runs.",
			},
			{
				id: "replan-weight",
				categoryId: "replan",
				before: category("replan"),
				after: { ...category("replan"), weight: 75 },
				rationale: "Replans changed the order of work.",
			},
		],
	});
	const stubs = {
		...settings.stubs,
		GetSurfacingLedger: () => records,
		SetSurfacingMark: ({ partId, mark }) => {
			records = records.flatMap((record) =>
				record.partId !== partId ? [record] : mark ? [{ ...record, mark }] : [],
			);
			return { ok: true as const };
		},
		ScoreCategorySet: ({ set, estimateOnly = false }) => {
			const changed = set.categories.filter((next) => {
				const previous = settings.categories.categories.find(
					({ id }) => id === next.id,
				);
				return (
					!previous ||
					JSON.stringify(previous.criteria) !== JSON.stringify(next.criteria)
				);
			});
			const definitions = JSON.stringify(
				changed.map(({ id, criteria }) => ({ id, criteria })),
			);
			const needed =
				changed.length && !scoredDefinitions.has(definitions)
					? records.length + unmarked.length
					: records.filter(({ probabilities }) => probabilities === null)
							.length;
			const canTest = settings.settings.active;
			const jevCalls = !estimateOnly && canTest ? needed : 0;
			if (jevCalls) scoredDefinitions.add(definitions);
			const requiredCalls = jevCalls ? 0 : needed;
			const complete = requiredCalls === 0;
			const levels = [...records, ...unmarked].map((part) => {
				const verdict =
					complete &&
					changed.some(({ id }) => id === "milestone") &&
					(part.probabilities?.["milestone"] ?? 0) > 0
						? { probabilities: { routine: 1 } }
						: part;
				return {
					partId: part.partId,
					sessionId: part.sessionId,
					...(verdict.probabilities === null
						? { level: null, category: null }
						: surfacingLevel(verdict, set)),
				};
			});
			const result: CategoryTuningScore = {
				agree: records.filter(
					(record) =>
						levels.find(({ partId }) => partId === record.partId)?.level ===
						record.mark.level,
				).length,
				total: records.length,
				levels,
				requiredCalls,
				jevCalls,
				complete,
				canTest,
				...(!complete && !canTest
					? {
							unavailableReason:
								"Set a valid TypeSafe key in General to score definition changes.",
						}
					: {}),
			};
			scoreRequests.push({ set: structuredClone(set), estimateOnly, jevCalls });
			return result;
		},
		ProposeCategoryTuning: ({ avoid = [] }) => {
			proposalRequests.push({ avoid: structuredClone(avoid) });
			if (proposalState === "failed") {
				proposalState = "ready";
				throw new WsRpcError({
					message: "Claude is not signed in. Run claude auth login.",
				});
			}
			if (proposalState === "empty")
				return {
					...proposal(),
					hunks: [],
					rationale:
						"Your marks already agree with the current weights and definitions.",
				};
			if (proposalState === "pending")
				return new Promise<CategoryTuningProposal>((resolve) => {
					pendingProposal = resolve;
				});
			return proposal();
		},
	} satisfies StubTable;
	return {
		stubs,
		settings,
		scoreRequests,
		proposalRequests,
		get records() {
			return records;
		},
		setProposalState(state: ProposalFixtureState) {
			proposalState = state;
		},
		resolveProposal() {
			proposalState = "ready";
			pendingProposal?.(proposal());
			pendingProposal = undefined;
		},
	};
}
