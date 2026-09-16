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

/** Anything that can appear between a prompt and the model's trailing reply. */
export type ActivityPart = ToolMessage | ThinkingMessage | AssistantMessage;

export interface Segment {
	/** Everything between the segment's start and its trailing reply, in order. */
	activity: ActivityPart[];
	/** Trailing run of assistant text: streaming while live, the reply once done. */
	reply: AssistantMessage[];
	/** The tool call that handed control to the user and closed this segment. */
	handBack?: ToolMessage;
}

export interface Turn {
	id: string;
	user?: UserMessage;
	/** Always at least one. */
	segments: Segment[];
	result?: ResultMessage;
	/**
	 * Transcript-level notices — errors and compaction dividers. Kept out of the
	 * activity log so a failure is never hidden behind a collapsed panel.
	 */
	notices: SystemMessage[];
	live: boolean;
}

// ─── Segmentation ────────────────────────────────────────────────────────────

/** AskUserQuestion or ExitPlanMode: the model stops and waits for the user. */
export function isHandBack(tool: ToolMessage): boolean {
	return tool.name === "AskUserQuestion" || tool.name === "ExitPlanMode";
}

/**
 * Split a flat transcript into turns.
 *
 * A user message opens a turn and its first segment. A hand-back tool closes the
 * current segment and opens another. Once the transcript is walked, every
 * segment's trailing run of assistant text moves to `reply`; a later non-text
 * part is the only thing that folds narration back into activity.
 *
 * @param processing whether the session is currently producing output — only
 *   the last turn can be live, and only when it has no result yet.
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
		if (msg.type === "result") turn.result = msg;
		else if (msg.type === "system") turn.notices.push(msg);
		else if (msg.type === "tool" && isHandBack(msg)) {
			turn.segments.at(-1)!.handBack = msg;
			turn.segments.push({ activity: [], reply: [] });
		} else turn.segments.at(-1)!.activity.push(msg);
	}
	for (const turn of turns) {
		for (const segment of turn.segments) {
			let replyStart = segment.activity.length;
			while (segment.activity[replyStart - 1]?.type === "assistant") {
				replyStart--;
			}
			if (replyStart < segment.activity.length) {
				segment.reply = segment.activity.splice(
					replyStart,
				) as AssistantMessage[];
			}
		}
	}
	const last = turns.at(-1);
	if (last && processing && !last.result) last.live = true;
	return turns;
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
	}
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
 * Tools that own an interactive card (subagent navigation or skill detail) keep
 * it inside the expanded log instead of degrading to a row.
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
	};
	for (const part of segment.activity) {
		if (part.type === "thinking") {
			s.thinking++;
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

/** "3 reads · 2 searches · 3 edits · 2 commands · 1 subagent" */
export function countsPhrase(s: TurnStats): string {
	const parts = [
		plural(s.reads, "read"),
		plural(s.searches, "search", "searches"),
		plural(s.edits, "edit"),
		plural(s.commands, "command"),
		plural(s.fetches, "fetch", "fetches"),
		plural(s.skills, "skill"),
		plural(s.subagents, "subagent"),
		plural(s.others, "other"),
	].filter(Boolean);
	if (parts.length > 0) return parts.join(" · ");
	return plural(s.thinking, "thought") || "no tools";
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

export function turnDuration(turn: Turn, now: number): number | undefined {
	// `!== undefined`, not truthiness: a provider-reported 0 is a measurement.
	if (turn.result?.duration !== undefined) return turn.result.duration;
	let start = turn.user?.createdAt;
	if (start === undefined) {
		for (const segment of turn.segments) {
			start =
				segment.activity[0]?.createdAt ??
				segment.reply[0]?.createdAt ??
				segment.handBack?.createdAt;
			if (start !== undefined) break;
		}
	}
	if (start === undefined) return undefined;
	let end = turn.live ? now : turn.result?.createdAt;
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
	const lastStamp = Math.max(last?.endedAt ?? 0, last?.createdAt ?? now);
	// A live turn's work is still running — unless the reply has started, in
	// which case it is already over and must stop there. Without that boundary
	// the segment grows for as long as the reply streams and then snaps back
	// when the result lands.
	return (
		segment.reply[0]?.createdAt ??
		segment.handBack?.createdAt ??
		(final && turn.live
			? now
			: Math.max(turn.result?.createdAt ?? 0, lastStamp))
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
 * `undefined` when any step lacks a timestamp: durations are never guessed.
 */
export function stepDurations(
	segment: Segment,
	turn: Turn,
	final: boolean,
	now: number,
): number[] | undefined {
	const stamps: number[] = [];
	for (const part of segment.activity) {
		if (part.createdAt === undefined) return undefined;
		stamps.push(part.createdAt);
	}
	const end = segmentEnd(segment, turn, final, now);
	return stamps.map((t, i) => {
		const own = segment.activity[i]?.endedAt;
		if (own !== undefined && own > t) return own - t;
		return Math.max(0, (stamps[i + 1] ?? end) - t);
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
	const d = stepDurations(segment, turn, final, now)?.[i];
	return d === undefined
		? partLabel(part)
		: `${partLabel(part)} · ${fmtDuration(d)}`;
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
	const r = turn.result;
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
