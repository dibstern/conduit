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
	identifiers: Set<string>;
	groups: Map<string, Set<string>>;
	polarities: Map<string, boolean>;
};
// Generic English function words only. Negation remains in the similarity input.
const stop = new Set(
	"a an the and or but if then than to of in on at as is are was were be been being it its this that these those with by for from has have had do does did only also all both which so into".split(
		" ",
	),
);
const identifierTokens =
	/(?:~?\/|\.\.?\/)?[a-zA-Z0-9_]+(?:[./*-][a-zA-Z0-9_*]+)*/g;
const similarityTokens = /[a-z0-9]+(?:[._/-][a-z0-9]+)*/g;
const letter = /[a-z]/;
const suffix = /\.[a-zA-Z][a-zA-Z0-9]{0,11}$/;
const literalTokens =
	/(?:^|[\s(])(["'`])([^\s"'`]{1,80})\1(?=$|[\s.,:;!?)]|\*)/g;
const clauses = /(?<=[.!?;])\s+|\n/;
const qualifying = /\b(?:no|without)\b/;
const copulas =
	/\b(?:is|are|was|were|has been|have been|had been)\s+(not\s+)?([a-z]+)\b/g;
const subjectTokens = /[a-z0-9_]+(?:[./*-][a-z0-9_*]+)*/g;
const ordinary = /^[a-z]{2,}$/;
const letterCode = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const digitCode = (c: number) => c >= 48 && c <= 57;
const singleQuotes = /[’‘]/g,
	doubleQuotes = /[“”]/g;
const dates =
	/\b\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?)?\b/g;
const meridians = /\b\d{1,2}\s*[ap]m\b/gi;
const ordinals = /\b\d+(?:st|nd|rd|th)\b/gi;
const clocks = /\b\d{1,2}:\d\d(?::\d\d)?(?:\s*[ap]m)?\b/gi;
const quantities =
	/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|weeks?|months?|years?|bytes?|[kmgt]i?b|hz|khz|mhz|ghz|%)\b/gi;
const ranges = /\b([a-zA-Z]{1,12})(\d+)\s*(?:[-–—]|\bto\b)\s*(?:\1)?(\d+)\b/g;
const asciiLetter = /[a-zA-Z]/,
	lowercase = /^[a-z]+$/,
	markdown = /^\*+|\*+$/g;
// Only immutable extraction is shared. Bound entries and retained UTF-16 units;
// oversized reasons/features bypass the cache without changing extraction.
const memo = new Map<string, { value: Vector; weight: number }>();
let memoWeight = 0;
const memoLimit = 4 * 1024 * 1024;
function extract(reason: string): Vector {
	const cached = memo.get(reason);
	if (cached) return cached.value;
	const value = vector(reason);
	if (reason.length > 4096) return value;
	let weight =
		reason.length +
		value.keys.length +
		value.identifiers.size +
		value.polarities.size;
	for (const token of value.keys) weight += token.length;
	for (const id of value.identifiers) weight += id.length;
	for (const [family, ids] of value.groups) {
		weight += family.length + ids.size;
		for (const id of ids) weight += id.length;
	}
	for (const predicate of value.polarities.keys()) weight += predicate.length;
	if (weight > 65536) return value;
	while (memo.size >= 4096 || memoWeight + weight > memoLimit) {
		const oldest = memo.entries().next().value;
		if (!oldest) break;
		memoWeight -= oldest[1].weight;
		memo.delete(oldest[0]);
	}
	memo.set(reason, { value, weight });
	memoWeight += weight;
	return value;
}

function vector(reason: string): Vector {
	const raw = reason
		.normalize("NFKC")
		.replace(singleQuotes, "'")
		.replace(doubleQuotes, '"');
	// Quantities never supply identity, including quantities inside quotations.
	const stable = raw
		.replace(dates, " ")
		.replace(meridians, " ")
		.replace(ordinals, " ")
		.replace(clocks, " ")
		.replace(quantities, " ");
	const identifiers = new Set<string>();
	const groups = new Map<string, Set<string>>();
	const expanded = stable.replace(
		ranges,
		(whole: string, prefix: string, left: string, right: string) => {
			const start = Number(left),
				end = Number(right);
			if (end < start || end - start > 100) return whole;
			return Array.from(
				{ length: end - start + 1 },
				(_, i) => `${prefix}${start + i}`,
			).join(" ");
		},
	);
	for (const token of expanded.match(identifierTokens) ?? []) {
		let letters = false,
			mixed = false,
			symbol = false,
			slashes = 0,
			dot = false;
		let hex = token.length >= 7 && token.length <= 64;
		let prefixLength = 0,
			digits = false,
			group = true,
			prior = 0;
		for (let i = 0; i < token.length; i++) {
			const c = token.charCodeAt(i),
				isLetter = letterCode(c),
				isDigit = digitCode(c);
			letters ||= isLetter;
			if (hex && !(isDigit || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)))
				hex = false;
			if ((isLetter && digitCode(prior)) || (isDigit && letterCode(prior)))
				mixed = true;
			if (c === 47) slashes++;
			if (c === 46) dot = true;
			if (
				c === 95 &&
				letterCode(prior) &&
				(letterCode(token.charCodeAt(i + 1)) || token.charCodeAt(i + 1) === 95)
			)
				symbol = true;
			if (group) {
				if (isLetter && !digits) prefixLength++;
				else if (isDigit) digits = true;
				else group = false;
			}
			prior = c;
		}
		if (!letters) continue;
		const path =
			token[0] === "/" ||
			token.startsWith("~/") ||
			token.startsWith("./") ||
			token.startsWith("../") ||
			slashes > 1 ||
			(dot && suffix.test(token));
		if (hex || mixed || path || symbol) identifiers.add(token);
		if (group && digits && prefixLength >= 1 && prefixLength <= 12) {
			const family = token.slice(0, prefixLength);
			if (!groups.has(family)) groups.set(family, new Set());
			groups.get(family)?.add(token);
		}
	}
	// Short literal values only, not arbitrary quotations of changing prose.
	// Lowercase prose words stay in similarity; structured or case-marked literals are IDs.
	for (const match of stable.matchAll(literalTokens)) {
		const literal = (match[2] ?? "").replace(markdown, "");
		if (asciiLetter.test(literal) && !lowercase.test(literal))
			identifiers.add(literal);
	}
	// Track polarity by a syntactically selected subject and predicate, with no domain vocabulary.
	// Ignore contradictory predicates within a check and clauses qualifying evidence.
	const observed = new Map<string, Set<boolean>>();
	for (const clause of stable.toLowerCase().split(clauses)) {
		if (qualifying.test(clause)) continue;
		for (const match of clause.matchAll(copulas)) {
			const prefix = clause.slice(0, match.index);
			const boundary = Math.max(
				prefix.lastIndexOf(","),
				prefix.lastIndexOf(";"),
				prefix.lastIndexOf(":"),
				prefix.lastIndexOf("("),
				prefix.lastIndexOf(")"),
			);
			const words = prefix.slice(boundary + 1).match(subjectTokens);
			let subject: string | undefined;
			for (let i = (words?.length ?? 0) - 1; i >= 0; i--) {
				const word = words?.[i] ?? "";
				if (ordinary.test(word) && !stop.has(word)) {
					subject = word;
					break;
				}
			}
			if (!subject || stop.has(match[2] ?? "")) continue;
			const predicate = `${subject}:${match[2] ?? ""}`;
			if (!observed.has(predicate)) observed.set(predicate, new Set());
			observed.get(predicate)?.add(!match[1]);
		}
	}
	const polarities = new Map<string, boolean>();
	for (const [predicate, values] of observed)
		if (values.size === 1) polarities.set(predicate, values.has(true));
	const unique = new Set<string>();
	for (const token of expanded.toLowerCase().match(similarityTokens) ?? []) {
		if (token.length > 1 && letter.test(token) && !stop.has(token))
			unique.add(token);
	}
	const keys = [...unique];
	return {
		keys,
		inverseNorm: 1 / Math.sqrt(keys.length),
		identifiers,
		groups,
		polarities,
	};
}

/** Pure online segmentation. Centroid = sum of unit vectors of the observed segment.
 * A central observed reason minimises summed cosine distance to all reasons in its run.
 * This computes the exact cosine medoid in O(total tokens), without a pairwise matrix.
 */
function createStuckDetector(options: Options = {}, retainHistory = true) {
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
	let members: { check: Check; keys: number[]; inverseNorm: number }[] = [];
	let count = 0;
	let first: Check | undefined;
	const vocabulary = new Map<string, number>();
	const sum: number[] = [];
	let sumSquared = 0;
	let known = new Set<string>();
	let groups = new Map<string, Set<string>>(),
		polarities = new Map<string, boolean>();
	let confirmed: Run | null = null;
	let previous: Check | undefined;
	const finish = (preserveIdentifiers = false) => {
		if (confirmed) {
			// Denominator common to all candidates is omitted; earliest wins ties.
			let best = -Infinity;
			for (const member of members) {
				let score = 0;
				for (let i = 0; i < member.keys.length; i++)
					score += sum[member.keys[i] ?? 0] ?? 0;
				score *= member.inverseNorm;
				if (score > best + 1e-12) {
					best = score;
					confirmed.blocker = member.check.reason ?? "";
				}
			}
		}
		members = [];
		count = 0;
		first = undefined;
		vocabulary.clear();
		sum.length = 0;
		sumSquared = 0;
		if (!preserveIdentifiers) known = new Set();
		groups = new Map();
		polarities = new Map();
		confirmed = null;
	};
	const add = (check: Check) => {
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
			if (retainHistory)
				verdicts.push({
					iteration: check.iteration,
					stuck: false,
					blockerId: null,
				});
			return;
		}
		const value = extract(check.reason);
		if (!value.keys.length) {
			finish();
			if (retainHistory)
				verdicts.push({
					iteration: check.iteration,
					stuck: false,
					blockerId: null,
				});
			return;
		}
		if (count) {
			let dot = 0;
			for (const token of value.keys) {
				const id = vocabulary.get(token);
				if (id !== undefined) dot += sum[id] ?? 0;
			}
			const similarity = (dot * value.inverseNorm) / Math.sqrt(sumSquared);
			// Previously observed identifiers remain context across inferred boundaries.
			// Missing reasons or explicit gaps clear them; incidental old details do not
			// repeatedly reset a newly anchored run. This cannot detect every role reuse.
			let changed = false;
			if (contextGuards) {
				for (const id of value.identifiers)
					if (!known.has(id)) {
						changed = true;
						break;
					}
				if (!changed)
					for (const [family, current] of value.groups) {
						const prior = groups.get(family);
						if (prior !== undefined && (prior.size > 1 || current.size > 1)) {
							if (prior.size !== current.size) {
								changed = true;
								break;
							}
							for (const id of prior)
								if (!current.has(id)) {
									changed = true;
									break;
								}
							if (changed) break;
						}
					}
				if (!changed)
					for (const [predicate, positive] of value.polarities) {
						if (
							polarities.has(predicate) &&
							polarities.get(predicate) !== positive
						) {
							changed = true;
							break;
						}
					}
			}
			if (
				similarity < (confirmed ? continuationThreshold : threshold) ||
				changed
			)
				finish(true);
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
		if (!count) first = check;
		count++;
		if (retainHistory)
			members.push({ check, keys, inverseNorm: value.inverseNorm });
		for (const id of value.identifiers) known.add(id);
		for (const [family, ids] of value.groups) groups.set(family, ids);
		for (const [predicate, positive] of value.polarities)
			polarities.set(predicate, positive);
		if (count >= minChecks) {
			if (!confirmed) {
				if (!first) return;
				confirmed = {
					id: `${first.iteration}@${first.at}`,
					since: first.at,
					sinceIteration: first.iteration,
					count,
					blocker: first.reason ?? "",
					until: check.at,
					untilIteration: check.iteration,
					detectedAt: check.at,
					detectedIteration: check.iteration,
				};
				if (retainHistory) runs.push(confirmed);
			}
			confirmed.count = count;
			confirmed.until = check.at;
			confirmed.untilIteration = check.iteration;
		}
		if (retainHistory)
			verdicts.push({
				iteration: check.iteration,
				stuck: confirmed !== null,
				blockerId: confirmed?.id ?? null,
			});
	};
	return {
		add,
		get first() {
			return first;
		},
		get current() {
			return confirmed;
		},
		result: (): Result => {
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
		},
	};
}

export function detectStuck(
	checks: readonly Check[],
	options: Options = {},
): Result {
	const detector = createStuckDetector(options);
	for (const check of checks) detector.add(check);
	return detector.result();
}
export default detectStuck;

const goalOptions = { minChecks: 3, threshold: 0.55 };
const goalReasonLimit = 4_096;

/** Projection needs the run bounds/count, not the medoid or historical verdicts.
 * The centroid and identifier context have no finite lookback, so retain those
 * statistics across checks without retaining the run's reasons or row history.
 */
export function createGoalStuckTracker() {
	const detector = createStuckDetector(goalOptions, false);
	let at = -Infinity;
	let since = 0;
	let invalid = false;
	return {
		add(check: Check): { since: number; lastAt: number; count: number } | null {
			if (invalid) return null;
			try {
				at = Math.max(at, check.at);
				detector.add({
					...check,
					at,
					reason: check.reason?.slice(0, goalReasonLimit) ?? null,
				});
				if (detector.first?.iteration === check.iteration) since = check.at;
				return detector.current
					? { since, lastAt: check.at, count: detector.current.count }
					: null;
			} catch {
				// One invalid imported prefix invalidates every subsequent verdict too.
				invalid = true;
				return null;
			}
		},
	};
}

/** Production boundary shared by projection and summary generation. */
export function detectGoalStuck(checks: readonly Check[]): Result {
	try {
		let at = -Infinity;
		return detectStuck(
			checks.map((check) => {
				// Iteration owns chronology; leave persisted/display timestamps untouched.
				at = Math.max(at, check.at);
				// Real reasons are about 1.5 KB; cap pathological parser work without changing normal evidence.
				return {
					...check,
					at,
					reason: check.reason?.slice(0, goalReasonLimit) ?? null,
				};
			}),
			goalOptions,
		);
	} catch {
		// Imported/old histories can violate ordering. Never stall projection or reuse a run key.
		return {
			stuck: null,
			runs: [],
			verdicts: checks.map(({ iteration }) => ({
				iteration,
				stuck: false,
				blockerId: null,
			})),
		};
	}
}
