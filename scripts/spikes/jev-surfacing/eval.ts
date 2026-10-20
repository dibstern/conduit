/**
 * SPIKE for conduit-test-ahu8.1: score the decision-4 Jev Choice and a no-AI keyword
 * heuristic against the agreed labelled fixture.
 * Run (key from the interactive profile, never printed):
 *   export TYPESAFE_API_KEY="$(zsh -ic 'printenv TYPESAFE_API_KEY' 2>/dev/null | tail -n1)"
 *   node --import tsx scripts/spikes/jev-surfacing/eval.ts > scripts/spikes/jev-surfacing/results.json
 * Progress goes to stderr; stdout is the JSON evidence artifact (summary + per-part verdicts).
 * Set RESULTS_IN=<results.json> to recompute metrics from saved verdicts without calling Jev.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
	CATEGORIES,
	criteriaMap,
	type Fixture,
	type FixturePart,
	instructions,
	type Label,
} from "./rubric.js";

const model = "jev-1.13.0";
const concurrency = Number(process.env["JEV_CONCURRENCY"] ?? 4);
const fixture = JSON.parse(
	await readFile(
		resolve("test/fixtures/jev-surfacing/labelled-parts.json"),
		"utf8",
	),
) as Fixture;

type Probabilities = Record<Label, number>;
type Verdict = {
	id: string;
	probabilities: Probabilities | null;
	latencyMs: number;
	inputTokens: number | null;
	attempts: number;
	error?: string;
};
type Variant = "withRequest" | "messageOnly";

// --- Jev --------------------------------------------------------------------

async function judge(part: FixturePart, variant: Variant): Promise<Verdict> {
	const withRequest = variant === "withRequest";
	const body = JSON.stringify({
		model,
		state: withRequest
			? { request: part.request, message: part.message }
			: { message: part.message },
		questions: {
			category: {
				type: "choice",
				instructions: instructions(withRequest),
				criteria: criteriaMap(),
			},
		},
	});
	let latencyMs = 0;
	let error = "";
	// Latency spans every attempt and the backoff, as a caller would see it.
	const started = performance.now();
	// Decision 4: one retry on 429/5xx.
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const res = await fetch("https://api.typesafe.ai/v1/systemone", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${process.env["TYPESAFE_API_KEY"] ?? ""}`,
					"Content-Type": "application/json",
				},
				body,
				signal: AbortSignal.timeout(15_000),
			});
			const text = await res.text();
			latencyMs = performance.now() - started;
			if (res.ok) {
				const json = JSON.parse(text) as {
					answers: { category: { probabilities: Probabilities } };
					usage: { input_tokens: number };
				};
				return {
					id: part.id,
					probabilities: json.answers.category.probabilities,
					latencyMs,
					inputTokens: json.usage.input_tokens,
					attempts: attempt,
				};
			}
			error = `HTTP ${res.status}: ${text.slice(0, 200)}`;
			if (res.status !== 429 && res.status < 500) break;
		} catch (e) {
			latencyMs = performance.now() - started;
			error = String(e);
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	return {
		id: part.id,
		probabilities: null,
		latencyMs,
		inputTokens: null,
		attempts: 2,
		error,
	};
}

async function judgeAll(variant: Variant): Promise<Verdict[]> {
	const out: Verdict[] = [];
	let next = 0;
	const worker = async () => {
		while (next < fixture.parts.length) {
			const i = next++;
			out[i] = await judge(fixture.parts[i] as FixturePart, variant);
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
	console.error(
		`${variant}: ${out.filter((v) => v.probabilities).length}/${out.length} ok`,
	);
	return out;
}

// --- heuristic --------------------------------------------------------------

/** The ticket's no-AI baseline: questions, "blocked" and "risk" keywords; everything else routine. */
const heuristic = (message: string): Label =>
	/\w[)`'"]?\?(\s|$)/.test(message) ||
	/\b(should I|shall I|do you want|want me to|would you like|which do you prefer|let me know)\b/i.test(
		message,
	)
		? "ask"
		: /\b(blocked|can'?t proceed|cannot proceed|permission denied|unable to)\b/i.test(
					message,
				)
			? "blocked"
			: /\b(risks?|risky|regressions?|hazard|could break|might break|data loss)\b/i.test(
						message,
					)
				? "risk"
				: "routine";

// --- levels (decision 5) ----------------------------------------------------

type Level = "key" | "balanced" | "all" | "hidden";
const weights = Object.fromEntries(
	CATEGORIES.map((c) => [c.id, c.weight]),
) as Record<Exclude<Label, "routine">, number>;

const surfacing = (
	p: Probabilities | null,
	key = 70,
	balanced = 40,
): { level: Level; category: Label } => {
	if (!p) return { level: "hidden", category: "routine" };
	let best: {
		c: Exclude<Label, "routine">;
		prominence: number;
		p: number;
	} | null = null;
	let maxP = 0;
	for (const { id } of CATEGORIES) {
		const pc = p[id] ?? 0;
		maxP = Math.max(maxP, pc);
		const prominence = weights[id] * pc;
		if (!best || prominence > best.prominence)
			best = { c: id, prominence, p: pc };
	}
	if (!best || (p.routine ?? 0) > maxP)
		return { level: "hidden", category: "routine" };
	const level =
		best.prominence >= key
			? "key"
			: best.prominence >= balanced
				? "balanced"
				: "all";
	return { level, category: best.c };
};

const certain = (label: Label): Probabilities =>
	Object.fromEntries(
		[...CATEGORIES.map((c) => c.id), "routine"].map((l) => [
			l,
			l === label ? 1 : 0,
		]),
	) as Probabilities;

const argmax = (p: Probabilities | null): Label | null =>
	p
		? (Object.entries(p).reduce((a, b) => (b[1] > a[1] ? b : a))[0] as Label)
		: null;

// --- metrics ----------------------------------------------------------------

const ratio = (n: number, d: number) => (d ? (100 * n) / d : null);
const pct = (n: number, d: number) => {
	const r = ratio(n, d);
	return r === null ? null : Math.round(r * 10) / 10;
};
const quantile = (xs: number[], q: number) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length
		? (s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? null)
		: null;
};

const levelOrder: Level[] = ["hidden", "all", "balanced", "key"];
const atLeast = (l: Level, floor: Level) =>
	levelOrder.indexOf(l) >= levelOrder.indexOf(floor);

// `rate` defaults to rounded percentages for display; gates pass `ratio`.
function score(predicted: Array<Label | null>, levels: Level[], rate = pct) {
	const truth = fixture.parts.map((p) => p.label);
	const truthLevels = fixture.parts.map(
		(p) => surfacing(certain(p.label)).level,
	);
	const n = truth.length;
	const hit = (i: number) => predicted[i] === truth[i];
	const predRoutine = predicted.filter((l) => l === "routine").length;
	const trueRoutine = truth.filter((l) => l === "routine").length;
	const bothRoutine = truth.filter(
		(l, i) => l === "routine" && predicted[i] === "routine",
	).length;
	const binary = (floor: Level) =>
		rate(
			levels.filter(
				(l, i) => atLeast(l, floor) === atLeast(truthLevels[i] as Level, floor),
			).length,
			n,
		);
	return {
		categoryAccuracy: rate(truth.filter((_, i) => hit(i)).length, n),
		nonRoutineAccuracy: rate(
			truth.filter((l, i) => l !== "routine" && hit(i)).length,
			n - trueRoutine,
		),
		routinePrecision: rate(bothRoutine, predRoutine),
		routineRecall: rate(bothRoutine, trueRoutine),
		levelExactAgreement: rate(
			levels.filter((l, i) => l === truthLevels[i]).length,
			n,
		),
		keyAgreement: binary("key"),
		balancedOrAboveAgreement: binary("balanced"),
	};
}

const confusion = (
	predicted: Array<string | null>,
	truth: string[] = fixture.parts.map((p) => p.label),
) => {
	const m: Record<string, Record<string, number>> = {};
	truth.forEach((t, i) => {
		const row = (m[t] ??= {});
		const k = predicted[i] ?? "failed";
		row[k] = (row[k] ?? 0) + 1;
	});
	return m;
};

/** One-time threshold check: level agreement for every (key, balanced) pair on a 5-point grid. */
const sweep = (verdicts: Verdict[]) => {
	const truthLevels = fixture.parts.map(
		(p) => surfacing(certain(p.label)).level,
	);
	const rows: Array<{
		key: number;
		balanced: number;
		agreement: number | null;
	}> = [];
	for (let key = 40; key <= 95; key += 5)
		for (let balanced = 10; balanced < key; balanced += 5)
			rows.push({
				key,
				balanced,
				agreement: pct(
					verdicts.filter(
						(v, i) =>
							surfacing(v.probabilities, key, balanced).level ===
							truthLevels[i],
					).length,
					verdicts.length,
				),
			});
	return rows
		.sort((a, b) => (b.agreement ?? 0) - (a.agreement ?? 0))
		.slice(0, 5);
};

function summarise(verdicts: Verdict[]) {
	const ok = verdicts.filter((v) => v.probabilities);
	const latencies = verdicts.map((v) => v.latencyMs);
	const tokens = ok.map((v) => v.inputTokens ?? 0);
	return {
		calls: verdicts.length,
		failures: verdicts.length - ok.length,
		retried: verdicts.filter((v) => v.attempts > 1).length,
		choice: score(
			verdicts.map((v) => argmax(v.probabilities)),
			verdicts.map((v) => surfacing(v.probabilities).level),
		),
		weightedCategory: score(
			verdicts.map((v) => surfacing(v.probabilities).category),
			verdicts.map((v) => surfacing(v.probabilities).level),
		),
		latencyMs: {
			p50: Math.round(quantile(latencies, 0.5) ?? 0),
			p95: Math.round(quantile(latencies, 0.95) ?? 0),
			max: Math.round(Math.max(...latencies)),
		},
		inputTokens: {
			mean: Math.round(
				tokens.reduce((a, b) => a + b, 0) / (tokens.length || 1),
			),
			p50: quantile(tokens, 0.5),
			p95: quantile(tokens, 0.95),
			max: Math.max(...tokens),
		},
		confusion: confusion(verdicts.map((v) => argmax(v.probabilities))),
		levelConfusion: confusion(
			verdicts.map((v) => surfacing(v.probabilities).level),
			fixture.parts.map((p) => surfacing(certain(p.label)).level),
		),
		levelAgreementAt70_30: pct(
			verdicts.filter(
				(v, i) =>
					surfacing(v.probabilities, 70, 30).level ===
					surfacing(certain((fixture.parts[i] as FixturePart).label)).level,
			).length,
			verdicts.length,
		),
		// What a stricter hide rule would buy: routine only when it is the argmax and p(routine) >= cutoff.
		routineCutoffs: [0.5, 0.7, 0.8, 0.9, 0.95].map((cutoff) => {
			const hidden = verdicts.map(
				(v) =>
					argmax(v.probabilities) === "routine" &&
					(v.probabilities?.routine ?? 0) >= cutoff,
			);
			const right = hidden.filter(
				(h, i) => h && fixture.parts[i]?.label === "routine",
			).length;
			const total = fixture.parts.filter((p) => p.label === "routine").length;
			return {
				cutoff,
				precision: pct(right, hidden.filter(Boolean).length),
				recall: pct(right, total),
			};
		}),
		thresholdSweepTop5: sweep(verdicts),
	};
}

// --- main -------------------------------------------------------------------

const saved = process.env["RESULTS_IN"]
	? (JSON.parse(await readFile(process.env["RESULTS_IN"], "utf8")) as {
			verdicts: Record<Variant, Verdict[]>;
		})
	: null;
if (!saved && !process.env["TYPESAFE_API_KEY"])
	throw new Error("TYPESAFE_API_KEY is not set");
// Replay aligns saved verdicts to fixture parts by id, never by position.
const byId = (saved: Verdict[]): Verdict[] => {
	const map = new Map(saved.map((v) => [v.id, v]));
	const ids = new Set(fixture.parts.map((p) => p.id));
	const missing = [...ids].filter((id) => !map.has(id));
	const extra = [...map.keys()].filter((id) => !ids.has(id));
	if (missing.length || extra.length || map.size !== saved.length)
		throw new Error(
			`RESULTS_IN does not match the fixture: missing ${missing.join(",") || "none"}, extra ${extra.join(",") || "none"}, duplicates ${saved.length - map.size}`,
		);
	return fixture.parts.map((p) => map.get(p.id) as Verdict);
};
const verdicts: Record<Variant, Verdict[]> = saved
	? {
			withRequest: byId(saved.verdicts.withRequest),
			messageOnly: byId(saved.verdicts.messageOnly),
		}
	: {
			withRequest: await judgeAll("withRequest"),
			messageOnly: await judgeAll("messageOnly"),
		};

const heuristicLabels = fixture.parts.map((p) => heuristic(p.message));
const labelCounts: Record<string, number> = {};
for (const p of fixture.parts)
	labelCounts[p.label] = (labelCounts[p.label] ?? 0) + 1;
const withRequest = summarise(verdicts.withRequest);
const heuristicScore = score(
	heuristicLabels,
	heuristicLabels.map((l) => surfacing(certain(l)).level),
);
// The gates judge the shipping configuration: decision 4's state, request included.
// Gate on unrounded rates; round only for display.
const p95 = withRequest.latencyMs.p95;
const choiceRaw = score(
	verdicts.withRequest.map((v) => argmax(v.probabilities)),
	verdicts.withRequest.map((v) => surfacing(v.probabilities).level),
	ratio,
);
const heuristicRaw = score(
	heuristicLabels,
	heuristicLabels.map((l) => surfacing(certain(l)).level),
	ratio,
);
const margin =
	(choiceRaw.categoryAccuracy ?? 0) - (heuristicRaw.categoryAccuracy ?? 0);
const gates = {
	accuracyMarginPoints: Math.round(margin * 10) / 10,
	accuracyGate: margin >= 10,
	routinePrecision: withRequest.choice.routinePrecision,
	routinePrecisionGate: (choiceRaw.routinePrecision ?? 0) >= 90,
	p95LatencyMs: Math.round(p95),
	latencyGate: p95 <= 5000,
};

console.log(
	JSON.stringify(
		{
			model,
			fixture: {
				parts: fixture.parts.length,
				sampled: fixture.sampled,
				bothLabelled: fixture.bothLabelled,
				agreementRate: pct(fixture.agreed, fixture.bothLabelled),
				labelCounts,
			},
			gates,
			verdict:
				gates.accuracyGate && gates.routinePrecisionGate && gates.latencyGate
					? "GO"
					: "NO-GO",
			jev: { withRequest, messageOnly: summarise(verdicts.messageOnly) },
			heuristic: { ...heuristicScore, confusion: confusion(heuristicLabels) },
			verdicts,
		},
		null,
		"\t",
	),
);
