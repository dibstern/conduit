// ─── Turns — Utility Functions ────────────────────────────────────────────────
// A turn is one user prompt, everything the model did in response, and its
// reply segments. The transcript renders one collapsed activity line per segment
// (summary sentence + duration strip), expandable to the log.

import type {
	AssistantMessage,
	ChatMessage,
	ResultMessage,
	SystemMessage,
	ThinkingMessage,
	ToolMessage,
	UserMessage,
} from "../types.js";
import { isSubagentToolName } from "./subagent-tools.js";
import { ensureCanonical } from "./tool-summarizers/ensure-canonical.js";
import { lookupSummarizer } from "./tool-summarizers/index.js";

/** A finished context compaction: a boundary in the work, not a unit of it. */
export type CompactionPart = SystemMessage & { compaction: "completed" };

/** Anything that can appear between a prompt and the model's trailing reply. */
export type ActivityPart =
	| ToolMessage
	| ThinkingMessage
	| AssistantMessage
	| CompactionPart;

/** Started and failed compactions stay notices; only a completed one is activity. */
export function isCompaction(msg: ChatMessage): msg is CompactionPart {
	return msg.type === "system" && msg.compaction === "completed";
}

export interface OpenSegment {
	/** Everything between the segment's start and its trailing reply, in order. */
	activity: ActivityPart[];
	/** Trailing run of assistant text: streaming while live, the reply once done. */
	reply: AssistantMessage[];
	end?: never;
	handBack?: never;
}

export interface ClosedSegment {
	readonly activity: readonly ActivityPart[];
	readonly reply: readonly AssistantMessage[];
	readonly end: ResultMessage | ToolMessage;
	/** The tool call that handed control to the user and closed this segment. */
	readonly handBack?: ToolMessage;
}

export type Segment = OpenSegment | ClosedSegment;

export interface Turn {
	id: string;
	user?: UserMessage;
	/** Always at least one. */
	segments: Segment[];
	/**
	 * Transcript-level notices — errors and in-flight or failed compactions. Kept
	 * out of the activity log so a failure is never hidden behind a collapsed panel.
	 */
	notices: SystemMessage[];
	live: boolean;
}

// ─── Segmentation ────────────────────────────────────────────────────────────

/** AskUserQuestion or ExitPlanMode: the model stops and waits for the user. */
export function isHandBack(tool: ToolMessage): boolean {
	return tool.name === "AskUserQuestion" || tool.name === "ExitPlanMode";
}

/** Only an open segment can receive new work. */
export function appendActivity(segment: OpenSegment, part: ActivityPart): void {
	if (part.type === "assistant") segment.reply.push(part);
	else {
		segment.activity.push(...segment.reply, part);
		segment.reply = [];
	}
}

/**
 * Split a flat transcript into turns.
 *
 * A user message opens a turn and its first segment. A hand-back tool closes the
 * current segment, as does a result. Later activity opens another lazily.
 * Trailing assistant text stays in `reply`; a later non-text part folds it
 * back into activity, but only within the same open segment.
 *
 * @param processing whether the session is currently producing output — only
 *   the last turn can be live, according to its last segment's signal.
 */
export function segmentTurns(
	messages: ChatMessage[],
	processing: boolean,
): Turn[] {
	const turns: Turn[] = [];
	for (const msg of messages) {
		if (msg.type === "user") {
			turns.push({
				id: msg.uuid,
				user: msg,
				segments: [{ activity: [], reply: [] }],
				notices: [],
				live: false,
			});
			continue;
		}
		let turn = turns.at(-1);
		if (!turn) {
			// Transcript opens mid-turn (history trimmed above the prompt).
			turn = {
				id: `turn-${msg.uuid}`,
				segments: [{ activity: [], reply: [] }],
				notices: [],
				live: false,
			};
			turns.push(turn);
		}
		let segment = turn.segments.at(-1)!;
		if (msg.type === "system" && !isCompaction(msg)) {
			turn.notices.push(msg);
			continue;
		}
		if (msg.type === "result") {
			turn.segments[turn.segments.length - 1] = { ...segment, end: msg };
			continue;
		}
		if (segment.end !== undefined) {
			segment = { activity: [], reply: [] };
			turn.segments.push(segment);
		}
		if (msg.type === "tool" && isHandBack(msg)) {
			turn.segments[turn.segments.length - 1] = {
				...segment,
				end: msg,
				handBack: msg,
			};
		} else appendActivity(segment, msg);
	}
	const last = turns.at(-1);
	// A closed segment is the only thing that settles a turn, and a closed
	// segment can never receive more work — the types see to that. So a result
	// mid-turn no longer strands the transcript: the next part opens a fresh
	// segment and the turn reads as live again.
	if (last) last.live = processing && last.segments.at(-1)!.end === undefined;
	return turns;
}

/** Latest reported usage remains available even when later work is running. */
export function lastResult(turn: Turn): ResultMessage | undefined {
	for (let i = turn.segments.length - 1; i >= 0; i--) {
		const end = turn.segments[i]!.end;
		if (end?.type === "result") return end;
	}
	return undefined;
}

// ─── Labels ──────────────────────────────────────────────────────────────────

const VERBS: Record<string, [past: string, present: string]> = {
	Read: ["Read", "Reading"],
	Edit: ["Edited", "Editing"],
	Write: ["Wrote", "Writing"],
	Bash: ["Ran", "Running"],
	Grep: ["Searched", "Searching"],
	Glob: ["Listed", "Listing"],
	LSP: ["Inspected", "Inspecting"],
	WebFetch: ["Fetched", "Fetching"],
	WebSearch: ["Searched", "Searching"],
	Task: ["Delegated", "Delegating"],
	Skill: ["Loaded", "Loading"],
	AskUserQuestion: ["Asked", "Asking"],
};

export function toolVerb(
	tool: ToolMessage,
	tense: "past" | "present" = "past",
): string {
	const verb = VERBS[tool.name];
	if (verb) return tense === "past" ? verb[0] : verb[1];
	return tense === "past" ? tool.name : `${tool.name}…`;
}

/** The tool's own one-line summary (file path, command, pattern…). */
export function toolSubject(tool: ToolMessage): string {
	return (
		lookupSummarizer(tool.name).summarize(
			ensureCanonical(tool.name, tool.input),
			{},
		).subtitle ?? ""
	);
}

/** Short qualifiers a tool carries alongside its subject, such as which kind of
 *  subagent ran. Empty for most tools. */
export function toolTags(tool: ToolMessage): readonly string[] {
	return (
		lookupSummarizer(tool.name).summarize(
			ensureCanonical(tool.name, tool.input),
			{},
		).tags ?? []
	);
}

/** Which skill a Skill call loaded. Sessions recorded before Skill inputs were
 *  normalized carry the name only in the result text, so recover it from there. */
export function skillName(tool: ToolMessage): string {
	const match = tool.result?.match(
		/^<skill_content\b[^>]*(?:name|skill_name)=["']([^"']+)["']|^"?Launching skill: ([^"\s]+)/,
	);
	return toolSubject(tool) || match?.[1] || match?.[2] || "";
}

export function toolCommand(tool: ToolMessage): string | undefined {
	const c = ensureCanonical(tool.name, tool.input);
	return c.tool === "Bash" ? c.command : undefined;
}

/** First non-empty line of markdown, stripped of leading syntax and truncated. */
export function firstLine(text: string, max = 90): string {
	const line =
		text
			.split("\n")
			.map((l) => l.replace(/^[#>*\-\s`]+/, "").trim())
			.find((l) => l.length > 0) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const THINKING_VERBS = [
	"Contemplating",
	"Architecting",
	"Brewing",
	"Calibrating",
	"Channeling",
	"Composing",
	"Computing",
	"Conjuring",
	"Constructing",
	"Crafting",
	"Crystallizing",
	"Debugging",
	"Deciphering",
	"Designing",
	"Distilling",
	"Drafting",
	"Engineering",
	"Evaluating",
	"Evolving",
	"Exploring",
	"Fabricating",
	"Formulating",
	"Generating",
	"Ideating",
	"Imagining",
	"Innovating",
	"Integrating",
	"Iterating",
	"Manifesting",
	"Mapping",
	"Materializing",
	"Modeling",
	"Navigating",
	"Optimizing",
	"Orchestrating",
	"Parsing",
	"Pondering",
	"Processing",
	"Projecting",
	"Prototyping",
	"Reasoning",
	"Refining",
	"Resolving",
	"Sculpting",
	"Shaping",
	"Simulating",
	"Sketching",
	"Solving",
	"Strategizing",
	"Structuring",
	"Synthesizing",
	"Theorizing",
	"Thinking",
	"Transforming",
	"Unraveling",
	"Visualizing",
	"Weaving",
];

/**
 * A verb with some personality for a thinking step. Drawn from the step's own
 * uuid rather than at random, so it stays put across re-renders instead of
 * flickering on every streamed token.
 */
export function thinkingVerb(part: ThinkingMessage): string {
	let hash = 0;
	for (let i = 0; i < part.uuid.length; i++) {
		hash = (hash * 31 + part.uuid.charCodeAt(i)) | 0;
	}
	return THINKING_VERBS[Math.abs(hash) % THINKING_VERBS.length] ?? "Thinking";
}

export function partLabel(part: ActivityPart): string {
	switch (part.type) {
		case "tool":
			return `${toolVerb(part)} ${toolSubject(part)}`.trim();
		case "thinking":
			return part.done
				? `Thought${part.duration ? ` for ${fmtDuration(part.duration)}` : ""}`
				: `${thinkingVerb(part)}…`;
		case "assistant":
			return firstLine(part.rawText);
		case "system":
			return compactionLabel(part);
	}
}

/** "Compacted context · 180k → 42k, 138k saved" — or just the first half when
 *  the provider reported no sizes. */
export function compactionLabel(part: CompactionPart): string {
	const { preTokens: pre, postTokens: post } = part;
	if (pre === undefined || post === undefined) return "Compacted context";
	const saved = pre > post ? `, ${fmtTokens(pre - post)} saved` : "";
	return `Compacted context · ${fmtTokens(pre)} → ${fmtTokens(post)}${saved}`;
}

/** What the model is doing right now, for the live header. */
export function currentStepLabel(segment: Segment): string {
	if (segment.reply.length > 0) return "Replying…";
	const tail = segment.activity.at(-1);
	if (
		tail?.type === "tool" &&
		(tail.status === "running" || tail.status === "pending")
	) {
		return `${toolVerb(tail, "present")} ${toolSubject(tail)}`.trim();
	}
	return tail ? "Thinking…" : "Starting…";
}

/**
 * Tools whose row in the expanded log carries a coloured rail. Loading a skill
 * or handing work to a subagent is a different kind of step than reading a file,
 * and the rail says so without breaking the log's rhythm the way the old
 * full-width cards did.
 */
export function isSoloTool(tool: ToolMessage): boolean {
	return tool.name === "Skill" || isSubagentToolName(tool.name);
}

// ─── Stats ───────────────────────────────────────────────────────────────────

/** Counts behind the collapsed summary sentence. Files are counted uniquely. */
export interface TurnStats {
	tools: number;
	failed: number;
	thinking: number;
	reads: number;
	edits: number;
	searches: number;
	commands: number;
	fetches: number;
	skills: number;
	subagents: number;
	others: number;
	compactions: number;
}

export function turnStats(segment: Segment): TurnStats {
	const read = new Set<string>();
	const edited = new Set<string>();
	const s: TurnStats = {
		tools: 0,
		failed: 0,
		thinking: 0,
		reads: 0,
		edits: 0,
		searches: 0,
		commands: 0,
		fetches: 0,
		skills: 0,
		subagents: 0,
		others: 0,
		compactions: 0,
	};
	for (const part of segment.activity) {
		if (part.type === "thinking") {
			s.thinking++;
			continue;
		}
		if (part.type === "system") {
			s.compactions++;
			continue;
		}
		if (part.type !== "tool") continue;
		s.tools++;
		if (part.status === "error" || part.isError) s.failed++;
		const c = ensureCanonical(part.name, part.input);
		switch (c.tool) {
			case "Read":
				read.add(c.filePath);
				break;
			case "Edit":
			case "Write":
				edited.add(c.filePath);
				break;
			case "Bash":
				s.commands++;
				break;
			case "Grep":
			case "Glob":
			case "LSP":
				s.searches++;
				break;
			case "WebFetch":
			case "WebSearch":
				s.fetches++;
				break;
			case "Skill":
				s.skills++;
				break;
			case "Task":
				s.subagents++;
				break;
			default:
				if (isSubagentToolName(part.name)) s.subagents++;
				else s.others++;
		}
	}
	s.reads = read.size;
	s.edits = edited.size;
	return s;
}

export function plural(n: number, one: string, many = `${one}s`): string {
	return n === 0 ? "" : `${n} ${n === 1 ? one : many}`;
}

/**
 * "3 reads · 2 searches · 3 edits · 2 commands · 1 subagent". Skills and
 * compactions are left out: each has its own control beside the sentence, so
 * the phrase is empty when they are all the turn did.
 */
export function countsPhrase(s: TurnStats): string {
	const parts = [
		plural(s.reads, "read"),
		plural(s.searches, "search", "searches"),
		plural(s.edits, "edit"),
		plural(s.commands, "command"),
		plural(s.fetches, "fetch", "fetches"),
		plural(s.subagents, "subagent"),
		plural(s.others, "other"),
	].filter(Boolean);
	if (parts.length > 0) return parts.join(" · ");
	if (s.thinking > 0) return plural(s.thinking, "thought");
	return s.skills > 0 || s.compactions > 0 ? "" : "no tools";
}

// ─── Timing ──────────────────────────────────────────────────────────────────

export function fmtDuration(ms: number): string {
	// Fast tools really do finish in single-digit milliseconds. Rendering those
	// as "0.0s" reads like a broken clock, so sub-second spans keep their unit.
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const m = Math.floor(ms / 60_000);
	const sec = Math.round((ms % 60_000) / 1000);
	return `${m}m ${sec}s`;
}

/** When the prompt was sent, or failing that, when the first stamped work began. */
function turnStart(turn: Turn): number | undefined {
	if (turn.user?.createdAt !== undefined) return turn.user.createdAt;
	for (const segment of turn.segments) {
		const start =
			segment.activity[0]?.createdAt ??
			segment.reply[0]?.createdAt ??
			segment.handBack?.createdAt;
		if (start !== undefined) return start;
	}
	return undefined;
}

export function turnDuration(turn: Turn, now: number): number | undefined {
	const result = turn.segments.at(-1)?.end;
	// `!== undefined`, not truthiness: a provider-reported 0 is a measurement.
	if (result?.type === "result" && result.duration !== undefined)
		return result.duration;
	const start = turnStart(turn);
	if (start === undefined) return undefined;
	let end = turn.live ? now : result?.createdAt;
	if (end === undefined) {
		for (let i = turn.segments.length - 1; i >= 0; i--) {
			const segment = turn.segments[i]!;
			end =
				segment.handBack?.createdAt ??
				segment.reply.at(-1)?.createdAt ??
				segment.activity.at(-1)?.createdAt;
			if (end !== undefined) break;
		}
	}
	if (end === undefined) return undefined;
	// Stamps can arrive out of order across a provider boundary. A negative span
	// is not a measurement, so show nothing rather than "-1.0s".
	return end < start ? undefined : end - start;
}

/**
 * Where the segment's work ends: the reply, a hand-back, or — while live — now.
 * A settled turn falls back to the last thing that carries a stamp.
 */
function segmentEnd(
	segment: Segment,
	turn: Turn,
	final: boolean,
	now: number,
): number {
	const last = segment.activity.at(-1);
	const lastEnded = last?.type === "system" ? undefined : last?.endedAt;
	const lastStamp = Math.max(lastEnded ?? 0, last?.createdAt ?? now);
	// A live turn's work is still running — unless the reply has started, in
	// which case it is already over and must stop there. Without that boundary
	// the segment grows for as long as the reply streams and then snaps back
	// when the result lands.
	return (
		segment.reply[0]?.createdAt ??
		segment.handBack?.createdAt ??
		(final && turn.live
			? now
			: Math.max(segment.end?.createdAt ?? 0, lastStamp))
	);
}

/**
 * Wall-clock ms for the whole segment. Steps can overlap, so this is the span
 * from the first step to the end of the work — never the sum of the steps.
 */
export function segmentDuration(
	segment: Segment,
	turn: Turn,
	final: boolean,
	now: number,
): number | undefined {
	const start = segment.activity[0]?.createdAt;
	if (start === undefined) return undefined;
	return Math.max(0, segmentEnd(segment, turn, final, now) - start);
}

/**
 * How long each step itself took. A step that reports its own completion is
 * measured by that; the rest run until the next step starts, which is the only
 * signal available for thinking and for anything still in flight.
 *
 * Own-span first matters because tools dispatched together start milliseconds
 * apart and then run concurrently — charging each one only the gap to its
 * sibling reports 0.0s for work that took seconds.
 *
 * A compaction is a boundary, not work, so it always measures 0. It needs no
 * stamp of its own, but when it has one the step before it ends there.
 *
 * `undefined` when any step lacks a timestamp: durations are never guessed.
 */
export function stepDurations(
	segment: Segment,
	turn: Turn,
	final: boolean,
	now: number,
): number[] | undefined {
	const { activity } = segment;
	if (activity.some((p) => p.type !== "system" && p.createdAt === undefined)) {
		return undefined;
	}
	// Where each step's successor starts, filled back to front so an unstamped
	// compaction hands its slot on to whatever follows it.
	const nextStart: number[] = [];
	let next = segmentEnd(segment, turn, final, now);
	for (let i = activity.length - 1; i >= 0; i--) {
		nextStart[i] = next;
		next = activity[i]!.createdAt ?? next;
	}
	return activity.map((part, i) => {
		if (part.type === "system") return 0;
		const t = part.createdAt;
		if (t === undefined) return 0;
		if (part.endedAt !== undefined && part.endedAt > t) return part.endedAt - t;
		return Math.max(0, nextStart[i]! - t);
	});
}

/**
 * Relative segment widths for the strip. Falls back to equal widths when
 * durations are unknown, so the strip still shows the shape of the work.
 */
export function stepWeights(
	segment: Segment,
	turn: Turn,
	final: boolean,
	now: number,
): number[] {
	return (
		stepDurations(segment, turn, final, now)?.map((d) => Math.max(300, d)) ??
		segment.activity.map(() => 1)
	);
}

/** "Edited src/auth.ts · 1s" for the i-th step, for the hover caption. */
export function stepCaption(
	segment: Segment,
	turn: Turn,
	final: boolean,
	i: number,
	now: number,
): string {
	const part = segment.activity[i];
	if (!part) return "";
	const d =
		part.type === "system"
			? undefined
			: stepDurations(segment, turn, final, now)?.[i];
	return d === undefined
		? partLabel(part)
		: `${partLabel(part)} · ${fmtDuration(d)}`;
}

/** One skill as a chapter of the turn. */
export interface SkillChapter {
	/** Position of the Skill call in `segment.activity`. */
	index: number;
	name: string;
	/** Ms from the start of the turn to the Skill call. */
	offset?: number;
	/** Ms until the next skill took over or the work ended. */
	duration?: number;
	/** The last skill of a turn still working: its chapter has no end yet. */
	running: boolean;
}

/**
 * The skills a segment loaded, in order. Loading one takes milliseconds, so a
 * skill's own span says nothing; what matters is the stretch of work it
 * governed, which runs until the next skill loads or the segment's work ends.
 * Any figure that would need a missing stamp is left out rather than guessed.
 */
export function skillChapters(
	segment: Segment,
	turn: Turn,
	final: boolean,
	now: number,
): SkillChapter[] {
	const start = turnStart(turn);
	const open =
		final && turn.live && segment.reply.length === 0 && !segment.handBack;
	const skills = segment.activity.flatMap((part, index) =>
		part.type === "tool" &&
		ensureCanonical(part.name, part.input).tool === "Skill"
			? [{ part, index }]
			: [],
	);
	return skills.map(({ part, index }, k) => {
		const t = part.createdAt;
		const next = skills[k + 1];
		const running = !next && open;
		const end = next
			? next.part.createdAt
			: running
				? undefined
				: segmentEnd(segment, turn, final, now);
		return {
			index,
			name: skillName(part),
			running,
			...(t !== undefined && start !== undefined && t >= start
				? { offset: t - start }
				: {}),
			...(t !== undefined && end !== undefined && end >= t
				? { duration: end - t }
				: {}),
		};
	});
}

// ─── Economics ───────────────────────────────────────────────────────────────

export interface TurnEconomics {
	duration?: number;
	cost?: number;
	tokensIn?: number;
	tokensOut?: number;
	/** Present only when the provider reported a context window — never guessed. */
	context?: { used: number; window: number; pct: number };
}

/**
 * What the turn cost, and how full the context was when it finished. Context
 * used is the final call's fresh input plus everything read from and written to
 * cache; a provider that reports no window gets no context reading at all.
 */
export function economics(turn: Turn, now: number): TurnEconomics {
	const r = lastResult(turn);
	const duration = turnDuration(turn, now);
	const window = r?.context_window;
	const used =
		r && (r.inputTokens !== undefined || r.cacheRead !== undefined)
			? (r.inputTokens ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0)
			: undefined;
	return {
		...(duration !== undefined ? { duration } : {}),
		...(r?.cost !== undefined ? { cost: r.cost } : {}),
		...(r?.inputTokens !== undefined ? { tokensIn: r.inputTokens } : {}),
		...(r?.outputTokens !== undefined ? { tokensOut: r.outputTokens } : {}),
		...(used !== undefined && window !== undefined && window > 0
			? {
					context: {
						used,
						window,
						pct: Math.min(100, Math.round((used / window) * 100)),
					},
				}
			: {}),
	};
}

export function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}
