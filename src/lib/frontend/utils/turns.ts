// A turn is one user prompt, everything the model did in response, and its
// reply segments. The transcript renders one collapsed activity line per segment
// (summary sentence + duration strip), expandable to the log.

import { skillNameFromTool } from "../../skill-recognition.js";
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
		let segment = turn.segments.at(-1);
		if (segment === undefined) continue;
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
	// A queued prompt waits in the tray, so the transcript's last turn is the live one.
	const last = turns.at(-1);
	// A closed segment is the only thing that settles a turn, and a closed
	// segment can never receive more work — the types see to that. So a result
	// mid-turn no longer strands the transcript: the next part opens a fresh
	// segment and the turn reads as live again.
	if (last) last.live = processing && last.segments.at(-1)?.end === undefined;
	return turns;
}

/** Latest reported usage remains available even when later work is running. */
export function lastResult(turn: Turn): ResultMessage | undefined {
	for (let i = turn.segments.length - 1; i >= 0; i--) {
		const end = turn.segments[i]?.end;
		if (end?.type === "result") return end;
	}
	return undefined;
}

/** The newest message id in this turn no later than the selected reply. */
export function forkMessageIdAtReply(
	turn: Turn,
	reply: AssistantMessage,
): string | undefined {
	let messageId: string | undefined;
	for (const segment of turn.segments) {
		for (const part of segment.activity) {
			if ("messageId" in part && part.messageId) messageId = part.messageId;
		}
		for (const part of segment.reply) {
			if (part.messageId) messageId = part.messageId;
			if (part === reply) return messageId;
		}
		if (segment.handBack?.messageId) messageId = segment.handBack.messageId;
		if (segment.end?.messageId) messageId = segment.end.messageId;
	}
	return undefined;
}

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
	ComputerUse: ["Used computer", "Using computer"],
	CreatePlan: ["Created plan", "Planning"],
	Delete: ["Deleted", "Deleting"],
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
	const progress = tool.metadata?.["progress"];
	if (
		tool.result === undefined &&
		tool.status !== "error" &&
		typeof tool.metadata?.["cursorToolType"] === "string" &&
		typeof progress === "string" &&
		progress
	)
		return progress;
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

export function skillName(tool: ToolMessage): string {
	return skillNameFromTool(ensureCanonical(tool.name, tool.input), tool.result);
}

export function toolCommand(tool: ToolMessage): string | undefined {
	const canonicalTool = ensureCanonical(tool.name, tool.input);
	return canonicalTool.tool === "Bash" ? canonicalTool.command : undefined;
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
			if (part.done)
				return `Thought${part.duration ? ` for ${fmtDuration(part.duration)}` : ""}`;
			return `${thinkingVerb(part)}…`;
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
	const stats: TurnStats = {
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
			stats.thinking++;
			continue;
		}
		if (part.type === "system") {
			stats.compactions++;
			continue;
		}
		if (part.type !== "tool") continue;
		stats.tools++;
		if (part.status === "error" || part.isError) stats.failed++;
		const canonicalTool = ensureCanonical(part.name, part.input);
		switch (canonicalTool.tool) {
			case "Read":
				read.add(canonicalTool.filePath);
				break;
			case "Edit":
			case "Write":
				edited.add(canonicalTool.filePath);
				break;
			case "Bash":
				stats.commands++;
				break;
			case "Grep":
			case "Glob":
			case "LSP":
				stats.searches++;
				break;
			case "WebFetch":
			case "WebSearch":
				stats.fetches++;
				break;
			case "Skill":
				stats.skills++;
				break;
			case "Task":
				stats.subagents++;
				break;
			default:
				if (isSubagentToolName(part.name)) stats.subagents++;
				else stats.others++;
		}
	}
	stats.reads = read.size;
	stats.edits = edited.size;
	return stats;
}

export function plural(n: number, one: string, many = `${one}s`): string {
	if (n === 0) return "";
	return `${n} ${n === 1 ? one : many}`;
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

export function fmtClock(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	const sec = String(seconds % 60).padStart(2, "0");
	if (minutes < 60) return `${minutes}:${sec}`;
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${sec}`;
}

export function fmtDuration(ms: number): string {
	// Fast tools really do finish in single-digit milliseconds. Rendering those
	// as "0.0s" reads like a broken clock, so sub-second spans keep their unit.
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
	const minutes = Math.floor(ms / 60_000);
	const sec = Math.floor((ms % 60_000) / 1000);
	return `${minutes}m ${sec}s`;
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

/** A stamped result closes the segment even if background tasks finish later. */
export function latestStamp(segment: Segment): number | undefined {
	let end = segment.end?.createdAt;
	if (end !== undefined) return end;
	for (const part of segment.activity) {
		for (const stamp of [
			part.createdAt,
			part.type === "system" ? undefined : part.endedAt,
		]) {
			if (stamp !== undefined) end = Math.max(end ?? stamp, stamp);
		}
	}
	for (const reply of segment.reply) {
		if (reply.createdAt !== undefined)
			end = Math.max(end ?? reply.createdAt, reply.createdAt);
	}
	return end;
}

function firstStamp(segment: Segment): number | undefined {
	for (const part of [...segment.activity, ...segment.reply]) {
		if (part.createdAt !== undefined) return part.createdAt;
	}
	return segment.handBack?.createdAt ?? segment.end?.createdAt;
}

/** Approval waits and gaps between segments stay out of the prompt's clock. */
export function workingTime(
	turn: Turn,
	now: number,
	until?: number,
): number | undefined {
	const timing = turn.user?.turnTiming;
	const start = timing?.startedAt ?? turn.user?.createdAt;
	if (start === undefined) return undefined;
	let end = timing?.endedAt ?? (turn.live ? now : undefined);
	if (end === undefined) {
		for (const segment of turn.segments) {
			const stamp = latestStamp(segment);
			if (stamp !== undefined) end = Math.max(end ?? stamp, stamp);
		}
	}
	if (end === undefined) return undefined;
	if (until !== undefined) end = Math.min(end, until);
	let duration = Math.max(0, end - start);
	const waits: { from: number; to?: number }[] = [...(timing?.waits ?? [])];
	for (const [index, segment] of turn.segments.entries()) {
		const previous = turn.segments[index - 1];
		if (previous === undefined) continue;
		const from = latestStamp(previous);
		const to = firstStamp(segment);
		if (from !== undefined && to !== undefined && to > from)
			waits.push({ from, to });
	}
	// Parallel prompts can overlap; time already subtracted is skipped.
	let waitedUntil = start;
	waits.sort((a, b) => a.from - b.from);
	for (const wait of waits) {
		const to = Math.min(wait.to ?? end, end);
		duration -= Math.max(0, to - Math.max(wait.from, waitedUntil));
		waitedUntil = Math.max(waitedUntil, to);
	}
	return duration;
}

export function isPaused(turn: Turn): boolean {
	const timing = turn.user?.turnTiming;
	return (
		timing?.endedAt === undefined &&
		(timing?.waits ?? []).some((wait) => wait.to === undefined)
	);
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
		next = activity[i]?.createdAt ?? next;
	}
	return activity.map((part, i) => {
		if (part.type === "system") return 0;
		const createdAt = part.createdAt;
		if (createdAt === undefined) return 0;
		if (part.endedAt !== undefined && part.endedAt > createdAt)
			return part.endedAt - createdAt;
		return Math.max(0, (nextStart[i] ?? createdAt) - createdAt);
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
	const duration =
		part.type === "system"
			? undefined
			: stepDurations(segment, turn, final, now)?.[i];
	return duration === undefined
		? partLabel(part)
		: `${partLabel(part)} · ${fmtDuration(duration)}`;
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
		const createdAt = part.createdAt;
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
			...(createdAt !== undefined && start !== undefined && createdAt >= start
				? { offset: createdAt - start }
				: {}),
			...(createdAt !== undefined && end !== undefined && end >= createdAt
				? { duration: end - createdAt }
				: {}),
		};
	});
}

export interface TurnEconomics {
	duration?: number;
	cost?: number;
	tokensIn?: number;
	tokensOut?: number;
	/** Present only when the provider reported a context window — never guessed. */
	context?: { used: number; window: number; pct: number };
	contextWithoutCapacity?: number;
}

/**
 * What the turn cost, and how full the context was when it finished. Context
 * used is the final call's fresh input plus everything read from and written to
 * cache; tokens sum the reported usage across segments. A missing or non-positive
 * capacity shows positive, explicitly reported occupancy alone.
 */
export function economics(turn: Turn, now: number): TurnEconomics {
	const result = lastResult(turn);
	const duration = workingTime(turn, now);
	const window = result?.context_window;
	const used =
		result?.contextTokens ??
		(result &&
		(result.inputTokens !== undefined || result.cacheRead !== undefined)
			? (result.inputTokens ?? 0) +
				(result.cacheRead ?? 0) +
				(result.cacheWrite ?? 0)
			: undefined);
	let tokensIn: number | undefined;
	let tokensOut: number | undefined;
	for (const segment of turn.segments) {
		const end = segment.end;
		if (end?.type !== "result") continue;
		if (end.inputTokens !== undefined)
			tokensIn = (tokensIn ?? 0) + end.inputTokens;
		if (end.outputTokens !== undefined)
			tokensOut = (tokensOut ?? 0) + end.outputTokens;
	}
	return {
		...((window === undefined || window <= 0) &&
		result?.contextTokens !== undefined &&
		result.contextTokens > 0
			? { contextWithoutCapacity: result.contextTokens }
			: {}),
		...(duration !== undefined ? { duration } : {}),
		...(result?.cost !== undefined ? { cost: result.cost } : {}),
		...(tokensIn !== undefined ? { tokensIn } : {}),
		...(tokensOut !== undefined ? { tokensOut } : {}),
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

/** How long a task just off the live list waits for its outcome. */
export const LAUNCH_SETTLE_MS = 3_000;

export type LaunchOutcome = "completed" | "failed" | "stopped";

export type LaunchState =
	| { readonly kind: "foreground" }
	| { readonly kind: "running" }
	| { readonly kind: "finished"; readonly outcome: LaunchOutcome }
	| { readonly kind: "gone" };

/** What a step that launched a background task shows about that task. */
export interface LaunchRow {
	readonly state: LaunchState;
	/** What a running task is doing now, e.g. "Running pnpm test". */
	readonly step?: string;
	/** How long it has run, or ran. Absent when the SDK gave no way to know. */
	readonly time?: number;
	readonly tokens?: number;
	readonly toolCalls?: number;
	/** Live tasks this task started (a shell inside an agent). */
	readonly nested: number;
}

/**
 * The launching row for a tool call that started an SDK task, or undefined for
 * any other tool. `live` is the root session's live background tasks: the SDK
 * keeps one list per Claude process, so a Child Session reads its root's.
 * An outcome wins over the list, which is in no order with start and finish
 * messages; without one, a backgrounded task off the list is no longer running.
 * `listedAt` is when the task was last seen on the list: the SDK drops a task
 * just before its outcome, which arrives on another feed, so a task that has
 * just left the list still reads running for LAUNCH_SETTLE_MS.
 */
export function launchRow(
	tool: ToolMessage,
	live: readonly {
		readonly id: string;
		readonly parentTaskId?: string | undefined;
	}[],
	now: number,
	listedAt?: number,
): LaunchRow | undefined {
	const meta = tool.metadata ?? {};
	const taskId = meta["providerTaskId"];
	if (typeof taskId !== "string") return undefined;
	const num = (key: string) => {
		const value = meta[key];
		return typeof value === "number" ? value : undefined;
	};
	const outcome = meta["outcome"];
	const state: LaunchState =
		meta["backgrounded"] !== true
			? { kind: "foreground" }
			: outcome === "completed" || outcome === "failed" || outcome === "stopped"
				? { kind: "finished", outcome }
				: live.some((task) => task.id === taskId) ||
						(listedAt !== undefined && now - listedAt < LAUNCH_SETTLE_MS)
					? { kind: "running" }
					: { kind: "gone" };
	const startedAt = num("taskStartedAt");
	const endTime = num("endTime");
	const paused = num("pausedMs") ?? 0;
	const time =
		state.kind === "running"
			? startedAt === undefined
				? undefined
				: Math.min(now, num("pausedAt") ?? now) - startedAt - paused
			: (num("taskDurationMs") ??
				(endTime === undefined || startedAt === undefined
					? undefined
					: endTime - startedAt - paused));
	const currentStep = meta["currentStep"] ?? meta["activeToolName"];
	const lastTool = meta["lastToolName"];
	const step =
		typeof currentStep === "string" && currentStep !== toolSubject(tool)
			? currentStep
			: typeof lastTool === "string"
				? lastTool
				: undefined;
	const tokens = num("taskTotalTokens") ?? num("totalTokens");
	const toolCalls = num("taskToolUses") ?? num("toolUses");
	return {
		state,
		...(state.kind === "running" && step ? { step } : {}),
		...(time !== undefined ? { time: Math.max(0, time) } : {}),
		...(tokens ? { tokens } : {}),
		...(toolCalls ? { toolCalls } : {}),
		nested: live.filter((task) => task.parentTaskId === taskId).length,
	};
}

/**
 * The live tasks a turn launched, nested tasks included: what its "N running"
 * pill counts and which launching steps keep breathing. A launched task counts
 * while its row reads running; a nested task counts while it is on the list and
 * its parent chain reaches a task this turn launched, whether or not that task
 * still runs. Direct launches use the same observed settle window as their rows.
 */
export function liveLaunchedTasks(
	turn: Turn,
	live: readonly {
		readonly id: string;
		readonly parentTaskId?: string | undefined;
		readonly ancestorTaskIds?: readonly string[] | undefined;
	}[],
	now: number,
	listedAt?: ReadonlyMap<string, number>,
): ReadonlySet<string> {
	const launches = turn.segments.flatMap((segment) =>
		segment.activity.flatMap((part) => {
			if (part.type !== "tool") return [];
			const taskId = part.metadata?.["providerTaskId"];
			return typeof taskId === "string" ? [{ taskId, tool: part }] : [];
		}),
	);
	const launched = new Set(launches.map(({ taskId }) => taskId));
	const running = launches.flatMap(({ taskId, tool }) =>
		launchRow(tool, live, now, listedAt?.get(taskId))?.state.kind === "running"
			? [taskId]
			: [],
	);
	const parents = new Map(live.map((task) => [task.id, task.parentTaskId]));
	const nested = live.flatMap((task) => {
		if (launched.has(task.id)) return [];
		if (task.ancestorTaskIds?.some((parent) => launched.has(parent)))
			return [task.id];
		const seen = new Set([task.id]);
		for (let parent = task.parentTaskId; parent && !seen.has(parent); ) {
			if (launched.has(parent)) return [task.id];
			seen.add(parent);
			parent = parents.get(parent);
		}
		return [];
	});
	return new Set([...running, ...nested]);
}

export function launchStatus(state: LaunchState): string {
	switch (state.kind) {
		case "foreground":
		case "running":
			return "running";
		case "finished":
			return state.outcome === "completed" ? "done" : state.outcome;
		case "gone":
			return "no longer running";
	}
}

/** "done · 18s"; a running task shows only its time, which ticks live. */
export function launchMeta(row: LaunchRow): string {
	return [
		row.state.kind === "running" ? "" : launchStatus(row.state),
		row.time === undefined ? "" : fmtDuration(row.time),
	]
		.filter(Boolean)
		.join(" · ");
}

/** "24k tokens · 6 tools": what the task used, the first thing to go when narrow. */
export function launchUsage(row: LaunchRow): string {
	return [
		row.tokens === undefined ? "" : `${fmtTokens(row.tokens)} tokens`,
		plural(row.toolCalls ?? 0, "tool"),
	]
		.filter(Boolean)
		.join(" · ");
}

export function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}
