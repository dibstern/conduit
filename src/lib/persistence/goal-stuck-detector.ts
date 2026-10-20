/** Causal, dependency-free reason-history heuristic. Call separately for each goal identity.
 * Requires strictly increasing iterations and nondecreasing finite millisecond timestamps.
 * Missing/empty reasons and iteration gaps end a segment. No timers or model calls.
 */
export type Check = Readonly<{
	iteration: number;
	at: number;
	reason: string | null;
}>;
export type Stuck = {
	since: number;
	sinceIteration: number;
	count: number;
	blocker: string;
};
export type Run = Stuck & {
	id: string;
	until: number;
	untilIteration: number;
	detectedAt: number;
	detectedIteration: number;
};
export type Verdict = {
	iteration: number;
	stuck: boolean;
	blockerId: string | null;
};
export type Result = { stuck: Stuck | null; runs: Run[]; verdicts: Verdict[] };
export type Options = {
	threshold?: number;
	minChecks?: number;
	maxGapMs?: number;
	continuationThreshold?: number;
	contextGuards?: boolean;
};

type Vector = {
	keys: string[];
	inverseNorm: number;
	hashes: Set<string>;
	questions: Set<number>;
	foreign: boolean;
	files: Set<string>;
	actionHashes: Set<string>;
	states: Map<string, boolean>;
};
const stop = new Set(
	"a an the and or but if then than to of in on at as is are was were be been being it its this that these those with by for from has have had do does did not no yet still only also all both which so per into condition goal requires require transcript shows show assistant message last latest says states evidence evidenced satisfied met stopping explicitly".split(
		" ",
	),
);

function vector(reason: string): Vector {
	const text = reason.toLowerCase().replace(/[’‘]/g, "'");
	const keys = [
		...new Set(
			(text.match(/[a-z0-9]+(?:[._/-][a-z0-9]+)*/g) ?? []).filter(
				(token) => token.length > 1 && !stop.has(token),
			),
		),
	];
	const files = new Set<string>(),
		states = new Map<string, boolean>();
	let foreign = false;
	// Completion and obstruction details are guards; similarity uses the whole reason.
	for (const clause of text.split(/(?<=[.!?;])\s+|\n/)) {
		if (clause.includes("uncommitted") || clause.includes("foreign"))
			for (const part of clause.split(",")) {
				if (!/\b(uncommitted|foreign)\b/.test(part)) continue;
				foreign = true;
				for (const path of part.match(
					/\b[\w.-]+(?:\/[\w.-]+)*\.[a-z]{1,6}\b/g,
				) ?? [])
					files.add(path.split("/").at(-1) ?? path);
			}
		if (
			clause.includes("branches") ||
			clause.includes("worktrees") ||
			clause.includes("tickets")
		)
			for (const m of clause.matchAll(
				/\b(branches|worktrees|tickets)\b(?:\s+[^\s,;]+){0,5}?\s+(?:are|is|were|was|have been|has been)\s+(not\s+)?(deleted|removed|closed|merged|finished|complete)\b/g,
			)) {
				if (!/\b(?:no|without)\b.*\bevidence\b/.test(clause.slice(0, m.index)))
					states.set(`${m[1]}:${m[3]}`, !m[2]);
			}
	}
	const hashes = new Set(
		(text.match(/\b[a-f0-9]{7,40}\b/g) ?? []).filter(
			(s) => /[a-f]/.test(s) && /[0-9]/.test(s),
		),
	);
	const questions = new Set<number>();
	for (const m of text.matchAll(/\bq(\d+)(?:\s*(?:[-–—]|to)\s*q?(\d+))?/g)) {
		const start = Number(m[1]),
			end = m[2] ? Number(m[2]) : start;
		for (let i = start; i <= Math.min(end, start + 100); i++) questions.add(i);
	}
	const actionHashes = new Set(
		[
			...text.matchAll(
				/\b(?:merged|committed|tip)\s+(?:as\s+|commit\s+)?([a-f0-9]{7,40})\b/g,
			),
		].map((m) => m[1] ?? ""),
	);
	return {
		keys,
		inverseNorm: 1 / Math.sqrt(keys.length),
		hashes,
		questions,
		foreign,
		files,
		actionHashes,
		states,
	};
}

/** Pure online segmentation. Centroid = sum of unit vectors of the observed segment.
 * A central observed reason minimises summed cosine distance to all reasons in its run.
 * This computes the exact cosine medoid in O(total tokens), without a pairwise matrix.
 */
export function detectStuck(
	checks: readonly Check[],
	options: Options = {},
): Result {
	const threshold = options.threshold ?? 0.55;
	const minChecks = options.minChecks ?? 2;
	const maxGapMs = options.maxGapMs ?? Infinity;
	const continuationThreshold =
		options.continuationThreshold ?? threshold * 0.8;
	const contextGuards = options.contextGuards ?? true;
	if (
		!(threshold >= 0 && threshold <= 1) ||
		!(continuationThreshold >= 0 && continuationThreshold <= threshold) ||
		!Number.isInteger(minChecks) ||
		minChecks < 2 ||
		!(maxGapMs >= 0)
	) {
		throw new RangeError("Invalid stuck detector options");
	}
	const runs: Run[] = [],
		verdicts: Verdict[] = [];
	// Repeated evaluator text needs only one tokenisation per invocation.
	// The memo stays local, so calls remain independent and deterministic.
	const vectors = new Map<string, Vector>();
	let members: { check: Check; keys: number[]; inverseNorm: number }[] = [];
	const vocabulary = new Map<string, number>();
	const sum: number[] = [];
	let sumSquared = 0;
	let hashes = new Set<string>(),
		questions = new Set<number>();
	let knownHashes = new Set<string>(),
		foreign = false,
		files = new Set<string>(),
		states = new Map<string, boolean>();
	let confirmed: Run | null = null;
	let previous: Check | undefined;
	const finish = () => {
		if (confirmed) {
			// Denominator common to all candidates is omitted; earliest wins ties.
			let best = -Infinity;
			for (const member of members) {
				let score = 0;
				for (const key of member.keys) score += sum[key] ?? 0;
				score *= member.inverseNorm;
				if (score > best + 1e-12) {
					best = score;
					confirmed.blocker = member.check.reason ?? "";
				}
			}
		}
		members = [];
		vocabulary.clear();
		sum.length = 0;
		sumSquared = 0;
		hashes = new Set();
		questions = new Set();
		confirmed = null;
		knownHashes = new Set();
		foreign = false;
		files = new Set();
		states = new Map();
	};
	for (const check of checks) {
		if (
			!Number.isSafeInteger(check.iteration) ||
			!Number.isFinite(check.at) ||
			(previous &&
				(check.iteration <= previous.iteration || check.at < previous.at))
		) {
			throw new RangeError(
				"Checks must be ordered, with unique integer iterations and finite timestamps",
			);
		}
		if (
			previous &&
			(check.iteration !== previous.iteration + 1 ||
				check.at - previous.at > maxGapMs)
		)
			finish();
		previous = check;
		if (!check.reason?.trim()) {
			finish();
			verdicts.push({
				iteration: check.iteration,
				stuck: false,
				blockerId: null,
			});
			continue;
		}
		const value = vectors.get(check.reason) ?? vector(check.reason);
		vectors.set(check.reason, value);
		if (!value.keys.length) {
			finish();
			verdicts.push({
				iteration: check.iteration,
				stuck: false,
				blockerId: null,
			});
			continue;
		}
		if (members.length) {
			let dot = 0;
			for (const token of value.keys) {
				const id = vocabulary.get(token);
				if (id !== undefined) dot += sum[id] ?? 0;
			}
			const similarity = (dot * value.inverseNorm) / Math.sqrt(sumSquared);
			// Do not erase a new revision or a different set of pending questions.
			const revisionChanged =
				hashes.size > 0 &&
				value.hashes.size > 0 &&
				![...value.hashes].some((h) => hashes.has(h));
			const questionsChanged =
				(questions.size > 0 || (contextGuards && confirmed !== null)) &&
				value.questions.size > 0 &&
				(questions.size !== value.questions.size ||
					[...questions].some((q) => !value.questions.has(q)));
			const fileChanged =
				value.files.size > 0 &&
				(!foreign ||
					(files.size > 0 && [...value.files].some((f) => !files.has(f))));
			const actionChanged = [...value.actionHashes].some(
				(h) => !knownHashes.has(h),
			);
			const completionChanged = [...value.states].some(
				([subject, complete]) =>
					states.has(subject) && states.get(subject) !== complete,
			);
			if (
				similarity < (confirmed ? continuationThreshold : threshold) ||
				revisionChanged ||
				questionsChanged ||
				(contextGuards && (fileChanged || actionChanged || completionChanged))
			)
				finish();
		}
		const keys: number[] = [];
		for (const token of value.keys) {
			let id = vocabulary.get(token);
			if (id === undefined) {
				id = vocabulary.size;
				vocabulary.set(token, id);
				sum.push(0);
			}
			keys.push(id);
			const old = sum[id] ?? 0,
				next = old + value.inverseNorm;
			sum[id] = next;
			sumSquared += next * next - old * old;
		}
		members.push({ check, keys, inverseNorm: value.inverseNorm });
		if (value.hashes.size) hashes = value.hashes;
		if (value.questions.size) questions = value.questions;
		for (const h of value.hashes) knownHashes.add(h);
		foreign ||= value.foreign;
		for (const file of value.files) files.add(file);
		for (const [subject, complete] of value.states)
			states.set(subject, complete);
		if (members.length >= minChecks) {
			const first = members[0]?.check;
			if (!first) continue;
			if (!confirmed) {
				confirmed = {
					id: `${first.iteration}@${first.at}`,
					since: first.at,
					sinceIteration: first.iteration,
					count: members.length,
					blocker: first.reason ?? "",
					until: check.at,
					untilIteration: check.iteration,
					detectedAt: check.at,
					detectedIteration: check.iteration,
				};
				runs.push(confirmed);
			}
			confirmed.count = members.length;
			confirmed.until = check.at;
			confirmed.untilIteration = check.iteration;
		}
		verdicts.push({
			iteration: check.iteration,
			stuck: confirmed !== null,
			blockerId: confirmed?.id ?? null,
		});
	}
	const current = confirmed;
	finish();
	return {
		stuck: current
			? {
					since: current.since,
					sinceIteration: current.sinceIteration,
					count: current.count,
					blocker: current.blocker,
				}
			: null,
		runs,
		verdicts,
	};
}
export default detectStuck;
