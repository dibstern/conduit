// The tool wire projection: the one rule for how a stored tool part's input
// and output reach the browser, used by transcript pages, live re-reads, REST
// snapshots and the full-detail request alike.
//
// Every input or output string over PREVIEW_CODE_POINTS code points travels as
// its first PREVIEW_CODE_POINTS code points plus its full size in UTF-8 bytes;
// shorter ones travel whole. Tools whose content is the point (a pending
// question's options, a subagent's reply) are never cut. The transcript query
// applies the same rule to outputs in SQL, reading these constants.

import {
	CodePoints,
	PartVersion,
	SUBAGENT_TOOL_NAMES,
	ToolCallId,
	type ToolDetail,
	type ToolInput,
	type ToolText,
	Utf8Bytes,
	type WholeInput,
	type WholeText,
} from "../contracts/tool-wire.js";

export const PREVIEW_CODE_POINTS = CodePoints.make(2_000);

/** Question tools (Claude, OpenCode) and subagent tools: always whole. */
export const NEVER_CUT_TOOL_NAMES = [
	"AskUserQuestion",
	"question",
	...SUBAGENT_TOOL_NAMES,
] as const;

const neverCut: ReadonlySet<string> = new Set(NEVER_CUT_TOOL_NAMES);

/** A tool the browser must always see whole holds whole text only. */
interface NeverCutToolWire {
	readonly input?: WholeInput;
	readonly output?: WholeText;
}

export interface ToolWire {
	readonly input?: ToolInput;
	readonly output?: ToolText;
}

/** The first PREVIEW_CODE_POINTS code points, or undefined when within budget. */
const head = (text: string): string | undefined => {
	// UTF-16 units never undercount code points.
	if (text.length <= PREVIEW_CODE_POINTS) return undefined;
	let units = 0;
	let points = 0;
	for (const char of text) {
		if (points === PREVIEW_CODE_POINTS) return text.slice(0, units);
		units += char.length;
		points++;
	}
	return undefined;
};

const utf8Bytes = (text: string) =>
	Utf8Bytes.make(Buffer.byteLength(text, "utf8"));

const parseInput = (stored: string): unknown => {
	try {
		return JSON.parse(stored);
	} catch {
		return stored;
	}
};

type InputPath = readonly (string | number)[];
type InputCut = { readonly path: InputPath; readonly fullBytes: Utf8Bytes };

const cutStrings = (
	value: unknown,
	path: InputPath,
	cuts: InputCut[],
): unknown => {
	if (typeof value === "string") {
		const preview = head(value);
		if (preview === undefined) return value;
		cuts.push({ path, fullBytes: utf8Bytes(value) });
		return preview;
	}
	if (Array.isArray(value))
		return value.map((item, index) => cutStrings(item, [...path, index], cuts));
	if (typeof value === "object" && value !== null)
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				cutStrings(item, [...path, key], cuts),
			]),
		);
	return value;
};

/**
 * One stored tool part as the browser sees it on open. `input` is the JSON
 * the projector stored; `output` the decoded result text. When the transcript
 * query has already cut `output`, `outputBytes` is the whole output's size.
 */
export function projectTool(tool: {
	readonly name: string | null | undefined;
	readonly input?: string | null | undefined;
	readonly output?: string | null | undefined;
	readonly outputBytes?: number | null | undefined;
}): ToolWire {
	if (tool.name != null && neverCut.has(tool.name)) {
		const whole: NeverCutToolWire = {
			...(tool.input == null
				? {}
				: { input: { _tag: "whole", value: parseInput(tool.input) } }),
			...(tool.output == null
				? {}
				: { output: { _tag: "whole", text: tool.output } }),
		};
		return whole;
	}
	return {
		...(tool.input == null ? {} : { input: inputWire(tool.input) }),
		...(tool.output == null
			? {}
			: { output: outputWire(tool.output, tool.outputBytes) }),
	};
}

const inputWire = (stored: string): ToolInput => {
	const value = parseInput(stored);
	// JSON never makes a string shorter, so a short input has no long field.
	if (stored.length <= PREVIEW_CODE_POINTS) return { _tag: "whole", value };
	const cuts: InputCut[] = [];
	const cut = cutStrings(value, [], cuts);
	const [first, ...rest] = cuts;
	return first === undefined
		? { _tag: "whole", value }
		: { _tag: "preview", value: cut, cuts: [first, ...rest] };
};

const outputWire = (
	output: string,
	cutBytes: number | null | undefined,
): ToolText => {
	if (cutBytes != null)
		return {
			_tag: "preview",
			text: output,
			fullBytes: Utf8Bytes.make(cutBytes),
		};
	const preview = head(output);
	return preview === undefined
		? { _tag: "whole", text: output }
		: { _tag: "preview", text: preview, fullBytes: utf8Bytes(output) };
};

/** A stored tool part whole, for the full-detail request. */
export function toolDetail(stored: {
	readonly toolId: string;
	readonly version: number;
	readonly input: string | null;
	readonly output: string | null;
}): ToolDetail {
	return {
		toolId: ToolCallId.make(stored.toolId),
		version: PartVersion.make(stored.version),
		...(stored.input == null
			? {}
			: { input: { _tag: "whole", value: parseInput(stored.input) } }),
		...(stored.output == null
			? {}
			: { output: { _tag: "whole", text: stored.output } }),
	};
}
