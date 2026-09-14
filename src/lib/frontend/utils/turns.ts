// ─── Turns — Utility Functions ────────────────────────────────────────────────
// A turn is one user prompt, everything the model did in response, and its
// trailing reply. The transcript renders one collapsed activity line per turn
// (summary sentence + duration strip + the turn's bill), expandable to the log.

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

export interface Turn {
	id: string;
	user?: UserMessage;
	/** Everything between the prompt and the trailing reply, in order. */
	activity: ActivityPart[];
	/** Trailing assistant text: streaming while live, the final reply once done. */
	reply?: AssistantMessage;
	result?: ResultMessage;
	/**
	 * Transcript-level notices — errors and compaction dividers. Kept out of the
	 * activity log so a failure is never hidden behind a collapsed panel.
	 */
	notices: SystemMessage[];
	live: boolean;
}

// ─── Segmentation ────────────────────────────────────────────────────────────

/**
 * Split a flat transcript into turns.
 *
 * A user message opens a turn; everything else appends to the open turn. Once
 * the whole transcript is walked, a turn whose LAST activity entry is assistant
 * text moves that entry to `reply`. That single rule is why no "final reply"
 * flag is needed: streaming text at the tail shows in flow, and the moment a
 * tool call follows it, it folds back into the activity on its own.
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
				activity: [],
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
				activity: [],
				notices: [],
				live: false,
			};
			turns.push(turn);
		}
		if (msg.type === "result") turn.result = msg;
		else if (msg.type === "system") turn.notices.push(msg);
		else turn.activity.push(msg);
	}
	for (const turn of turns) {
		const tail = turn.activity.at(-1);
		if (tail?.type === "assistant") {
			turn.reply = tail;
			turn.activity = turn.activity.slice(0, -1);
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
export function currentStepLabel(turn: Turn): string {
	if (turn.reply) return "Replying…";
	const tail = turn.activity.at(-1);
	if (
		tail?.type === "tool" &&
		(tail.status === "running" || tail.status === "pending")
	) {
		return `${toolVerb(tail, "present")} ${toolSubject(tail)}`.trim();
	}
	return tail ? "Thinking…" : "Starting…";
}

/**
 * Tools that own an interactive card (question prompt, subagent navigation,
 * skill detail) keep it inside the expanded log instead of degrading to a row.
 */
export function isSoloTool(tool: ToolMessage): boolean {
	return (
		tool.name === "AskUserQuestion" ||
		tool.name === "Skill" ||
		isSubagentToolName(tool.name)
	);
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
	subagents: number;
	others: number;
}

export function turnStats(activity: ActivityPart[]): TurnStats {
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
		subagents: 0,
		others: 0,
	};
	for (const part of activity) {
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
		plural(s.subagents, "subagent"),
		plural(s.others, "other"),
	].filter(Boolean);
	if (parts.length > 0) return parts.join(" · ");
	return plural(s.thinking, "thought") || "no tools";
}

// ─── Timing ──────────────────────────────────────────────────────────────────

export function fmtDuration(ms: number): string {
	if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	const m = Math.floor(ms / 60_000);
	const sec = Math.round((ms % 60_000) / 1000);
	return `${m}m ${sec}s`;
}

export function turnDuration(turn: Turn, now: number): number | undefined {
	// `!== undefined`, not truthiness: a provider-reported 0 is a measurement.
	if (turn.result?.duration !== undefined) return turn.result.duration;
	const start = turn.user?.createdAt ?? turn.activity[0]?.createdAt;
	if (start === undefined) return undefined;
	const end = turn.live
		? now
		: (turn.result?.createdAt ??
			turn.reply?.createdAt ??
			turn.activity.at(-1)?.createdAt);
	if (end === undefined) return undefined;
	// Stamps can arrive out of order across a provider boundary. A negative span
	// is not a measurement, so show nothing rather than "-1.0s".
	return end < start ? undefined : end - start;
}

/**
 * Wall-clock ms per step: each runs until the next one starts, the last until
 * the reply or result lands. `undefined` when any step lacks a timestamp —
 * durations are never guessed.
 */
export function stepDurations(turn: Turn, now: number): number[] | undefined {
	const stamps: number[] = [];
	for (const part of turn.activity) {
		if (part.createdAt === undefined) return undefined;
		stamps.push(part.createdAt);
	}
	const lastStamp = stamps.at(-1) ?? now;
	// A live turn's last step is still running — unless the reply has started, in
	// which case the work is already over and the step must stop there. Without
	// that boundary the last segment grows for as long as the reply streams and
	// then snaps back when the result lands.
	const end = turn.live
		? (turn.reply?.createdAt ?? now)
		: (turn.reply?.createdAt ?? turn.result?.createdAt ?? lastStamp);
	return stamps.map((t, i) => Math.max(0, (stamps[i + 1] ?? end) - t));
}

/**
 * Relative segment widths for the strip. Falls back to equal widths when
 * durations are unknown, so the strip still shows the shape of the work.
 */
export function stepWeights(turn: Turn, now: number): number[] {
	return (
		stepDurations(turn, now)?.map((d) => Math.max(300, d)) ??
		turn.activity.map(() => 1)
	);
}

/** "Edited src/auth.ts · 1s" for the i-th step, for the hover caption. */
export function stepCaption(turn: Turn, i: number, now: number): string {
	const part = turn.activity[i];
	if (!part) return "";
	const d = stepDurations(turn, now)?.[i];
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
