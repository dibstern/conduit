import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { createTwoFilesPatch } from "diff";
import {
	SESSION_DIFF_AUTO_LINES,
	SESSION_DIFF_TOO_LARGE_BYTES,
	type SessionDiffFile,
	type SessionDiffPatch,
} from "../../../contracts/session-diff.js";
import type {
	RunChangesCaptured,
	ToolFileChange,
} from "../../../contracts/stored-event.js";
import type { SessionDiffFolder as SessionFolder } from "../Services/session-diff.js";

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
const DIFF_LINE = /^[ +\-\\]/;

type Body = { lines: string[]; insertions: number; deletions: number };
type Start = { old: number; new: number };

const count = (lines: readonly string[], pattern: RegExp) =>
	lines.filter((line) => pattern.test(line)).length;

/** The lines from the first `@@`; a bare run of diff lines gets an unnumbered header. */
const hunkLines = (patch: string) => {
	const lines = patch.replace(/\r?\n$/, "").split("\n");
	const first = lines.findIndex((line) => line.startsWith("@@"));
	if (first >= 0) return lines.slice(first);
	return lines.every((line) => DIFF_LINE.test(line)) ? ["@@", ...lines] : [];
};

/** Each `@@` header with its diff lines. apply_patch drops an empty context line's space. */
const splitHunks = (lines: readonly string[]) => {
	const hunks: { header: string; block: string[] }[] = [];
	for (const line of lines) {
		if (line.startsWith("@@")) hunks.push({ header: line, block: [] });
		else if (DIFF_LINE.test(line) || line === "")
			hunks.at(-1)?.block.push(line || " ");
	}
	return hunks;
};

/** Where a hunk starts; a header without numbers (apply_patch) continues from the last. */
const hunkStart = (header: string, next: Start) => {
	const numbered = HUNK.exec(header.trimEnd());
	if (!numbered) {
		const context = header.slice(2).trim();
		return { ...next, context: context ? ` ${context}` : "" };
	}
	return {
		old: Math.max(Number(numbered[1]), 1),
		new: Math.max(Number(numbered[2]), 1),
		context: numbered[3] ?? "",
	};
};

/** A patch's hunks, each header renumbered from its lines. Undefined when it has none. */
const hunks = (patch: string): Body | undefined => {
	const split = splitHunks(hunkLines(patch));
	if (split.length === 0) return undefined;
	// Git numbers an empty side from the line before it.
	const from = (at: number, lines: number) => (lines === 0 ? at - 1 : at);
	let next: Start = { old: 1, new: 1 };
	const lines = split.flatMap(({ header, block }) => {
		const at = hunkStart(header, next);
		const olds = count(block, /^[ -]/);
		const news = count(block, /^[ +]/);
		next = { old: at.old + olds, new: at.new + news };
		return [
			`@@ -${from(at.old, olds)},${olds} +${from(at.new, news)},${news} @@${at.context}`,
			...block,
		];
	});
	return {
		lines,
		insertions: count(lines, /^\+/),
		deletions: count(lines, /^-/),
	};
};

const id = (side: string, content: string) =>
	createHash("sha1").update(side).update("\0").update(content).digest("hex");

/** The provider calls a Write `add` even when it overwrote a file, so an add is checked against the run's start. */
const statusOf = (
	kind: ToolFileChange["kind"],
	existed: boolean | undefined,
) => {
	if (kind === "delete") return "deleted";
	if (kind === "move") return "renamed";
	return kind === "update" || existed ? "modified" : "added";
};

/** An add that replaced a file at the run's start, or one the capture cannot vouch for. */
const addNotes = (existed: boolean | undefined) => {
	if (existed) return ["replaced"] as const;
	return existed === undefined ? (["unchecked"] as const) : [];
};

const withTier = (
	fields: Omit<SessionDiffFile, "tier" | "insertions" | "deletions" | "binary">,
	body: Body | undefined,
): SessionDiffFile => {
	if (fields.bytes > SESSION_DIFF_TOO_LARGE_BYTES)
		return { ...fields, tier: "tooLarge" };
	const insertions = body?.insertions ?? 0;
	const deletions = body?.deletions ?? 0;
	const tier =
		insertions + deletions > SESSION_DIFF_AUTO_LINES ? "onDemand" : "auto";
	return { ...fields, tier, insertions, deletions, binary: false };
};

/** The change's own hunks, else a diff of its recorded texts. */
const bodyOf = (change: ToolFileChange) =>
	hunks(change.patch ?? "") ??
	hunks(createTwoFilesPatch("", "", change.before ?? "", change.after ?? ""));

/** Content ids for each side, null where the file does not exist. Not git blob ids. */
const sideIds = (
	change: ToolFileChange,
	status: SessionDiffFile["status"],
	text: string,
) => ({
	before: status === "added" ? null : id("before", change.before ?? text),
	after: status === "deleted" ? null : id("after", change.after ?? text),
});

const gitPatch = (
	path: string,
	from: string,
	sides: { before: string | null; after: string | null },
	lines: readonly string[],
) =>
	[
		`diff --git a/${from} b/${path}`,
		sides.before === null ? "--- /dev/null" : `--- a/${from}`,
		sides.after === null ? "+++ /dev/null" : `+++ b/${path}`,
		...lines,
		"",
	].join("\n");

const notesOf = (
	patch: string,
	kind: ToolFileChange["kind"],
	existed: boolean | undefined,
) => [
	...(patch.includes("\r\n") ? (["crlf"] as const) : []),
	...(kind === "add" ? addNotes(existed) : []),
];

/** One Tool File Change as a listed file and its git-style patch. */
const toolCallFile = (
	change: ToolFileChange,
	path: string,
	oldPath: string | undefined,
	existed: boolean | undefined,
) => {
	const body = bodyOf(change);
	const status = statusOf(change.kind, existed);
	const lines = body?.lines ?? [];
	const sides = sideIds(change, status, lines.join("\n"));
	const patch = gitPatch(path, oldPath ?? path, sides, lines);
	const notes = notesOf(patch, change.kind, existed);
	const bytes = Math.max(
		...[change.before ?? "", change.after ?? "", patch].map((value) =>
			Buffer.byteLength(value),
		),
	);
	const file = withTier(
		{
			path,
			...(oldPath === undefined ? {} : { oldPath }),
			status,
			...sides,
			bytes,
		},
		body,
	);
	const listed: SessionDiffPatch =
		notes.length === 0 ? { patch } : { patch, notes };
	return { file, patch: listed };
};

const inside = (directory: string, path: string) =>
	isAbsolute(path) && !relative(directory, path).startsWith("..");

/** Whether the run's capture saw the path before the run; undefined when it cannot say. */
const existedAtStart = (
	capture: RunChangesCaptured | undefined,
	directory: string,
	path: string,
) => {
	const captured = capture?.folders.find(
		(folder) => folder.directory === directory,
	);
	if (!captured || !("changes" in captured)) return undefined;
	const entry = captured.changes.find((listed) => listed.path === path);
	return entry ? entry.before !== null : undefined;
};

/**
 * A tool call's Tool File Changes per session folder. A path joins the folder
 * whose directory holds it, relative to that directory; any other path joins
 * the first folder as the tool named it.
 */
export const listToolCall = (
	folders: readonly SessionFolder[],
	changes: readonly ToolFileChange[],
	capture: RunChangesCaptured | undefined,
) => {
	type Group = {
		files: SessionDiffFile[];
		patches: Map<string, SessionDiffPatch>;
	};
	const listed = new Map<string, Group>();
	for (const change of changes) {
		const holder = folders.find(({ directory }) =>
			inside(directory, change.path),
		);
		const folder = holder ?? folders[0];
		if (!folder) continue;
		const local = (path: string) =>
			holder && inside(holder.directory, path)
				? relative(holder.directory, path)
				: path;
		const path = local(change.path);
		const { file, patch } = toolCallFile(
			change,
			path,
			change.kind === "move" ? local(change.oldPath) : undefined,
			existedAtStart(capture, folder.directory, path),
		);
		const group: Group = listed.get(folder.root) ?? {
			files: [],
			patches: new Map(),
		};
		group.files.push(file);
		group.patches.set(path, patch);
		listed.set(folder.root, group);
	}
	return [...listed].map(([folder, group]) => ({ folder, ...group }));
};
