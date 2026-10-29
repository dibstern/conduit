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

/**
 * A patch's hunks from its first `@@`, each header renumbered from its lines.
 * A header without numbers (apply_patch) continues from the previous hunk;
 * a bare run of diff lines is one such hunk. Undefined when it has no hunk.
 */
const hunks = (patch: string) => {
	const lines = patch.replace(/\r?\n$/, "").split("\n");
	const first = lines.findIndex((line) => line.startsWith("@@"));
	const body =
		first >= 0
			? lines.slice(first)
			: lines.every((line) => /^[ +\-\\]/.test(line))
				? ["@@", ...lines]
				: [];
	const out: string[] = [];
	let header: { old: number; new: number; context: string } | undefined;
	let block: string[] = [];
	let next = { old: 1, new: 1 };
	let insertions = 0;
	let deletions = 0;
	const flush = () => {
		if (!header) return;
		const olds = block.filter((line) => /^[ -]/.test(line)).length;
		const news = block.filter((line) => /^[ +]/.test(line)).length;
		// Git numbers an empty side from the line before it.
		const start = (at: number, count: number) =>
			count === 0 && at > 0 ? at - 1 : at;
		const from = start(header.old, olds);
		const to = start(header.new, news);
		out.push(
			`@@ -${from},${olds} +${to},${news} @@${header.context}`,
			...block,
		);
		next = { old: header.old + olds, new: header.new + news };
		insertions += block.filter((line) => line[0] === "+").length;
		deletions += block.filter((line) => line[0] === "-").length;
	};
	for (const line of body) {
		if (line.startsWith("@@")) {
			flush();
			const numbered = HUNK.exec(line.trimEnd());
			header = numbered
				? {
						old: Math.max(Number(numbered[1]), 1),
						new: Math.max(Number(numbered[2]), 1),
						context: numbered[3] ?? "",
					}
				: {
						...next,
						context: line.slice(2).trim() ? ` ${line.slice(2).trim()}` : "",
					};
			block = [];
		} else if (/^[ +\-\\]/.test(line)) block.push(line);
		// apply_patch keeps an empty context line without its space.
		else if (line === "") block.push(" ");
	}
	flush();
	return out.length === 0 ? undefined : { lines: out, insertions, deletions };
};

const id = (side: string, content: string) =>
	createHash("sha1").update(side).update("\0").update(content).digest("hex");

/**
 * One Tool File Change as a listed file and its git-style patch. The provider
 * calls a Write `add` even when it overwrote a file, so an add is checked
 * against the run's capture: a path that existed at the run's start reads as
 * replaced, and one the capture cannot vouch for as unchecked.
 */
const toolCallFile = (
	change: ToolFileChange,
	path: string,
	oldPath: string | undefined,
	existed: boolean | undefined,
) => {
	const body =
		hunks(change.patch ?? "") ??
		hunks(createTwoFilesPatch("", "", change.before ?? "", change.after ?? ""));
	const status =
		change.kind === "delete"
			? "deleted"
			: change.kind === "move"
				? "renamed"
				: change.kind === "update" || existed
					? "modified"
					: "added";
	const text = body?.lines.join("\n") ?? "";
	const before =
		status === "added" ? null : id("before", change.before ?? text);
	const after = status === "deleted" ? null : id("after", change.after ?? text);
	const from = oldPath ?? path;
	const patch = [
		`diff --git a/${from} b/${path}`,
		before === null ? "--- /dev/null" : `--- a/${from}`,
		after === null ? "+++ /dev/null" : `+++ b/${path}`,
		...(body?.lines ?? []),
		"",
	].join("\n");
	const notes = [
		...(patch.includes("\r\n") ? (["crlf"] as const) : []),
		...(change.kind !== "add"
			? []
			: existed
				? (["replaced"] as const)
				: existed === undefined
					? (["unchecked"] as const)
					: []),
	];
	const bytes = Math.max(
		...[change.before, change.after, patch].map((value) =>
			Buffer.byteLength(value ?? ""),
		),
	);
	const fields = {
		path,
		...(oldPath === undefined ? {} : { oldPath }),
		status,
		before,
		after,
		bytes,
	} as const;
	const insertions = body?.insertions ?? 0;
	const deletions = body?.deletions ?? 0;
	const file: SessionDiffFile =
		bytes > SESSION_DIFF_TOO_LARGE_BYTES
			? { ...fields, tier: "tooLarge" }
			: {
					...fields,
					tier:
						insertions + deletions > SESSION_DIFF_AUTO_LINES
							? "onDemand"
							: "auto",
					insertions,
					deletions,
					binary: false,
				};
	const listed: SessionDiffPatch =
		notes.length === 0 ? { patch } : { patch, notes };
	return { file, patch: listed };
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
		const inside = (directory: string, path: string) =>
			isAbsolute(path) && !relative(directory, path).startsWith("..");
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
		const captured = capture?.folders.find(
			({ directory }) => directory === folder.directory,
		);
		const entry =
			captured && "changes" in captured
				? captured.changes.find((listed) => listed.path === path)
				: undefined;
		const { file, patch } = toolCallFile(
			change,
			path,
			change.kind === "move" ? local(change.oldPath) : undefined,
			entry ? entry.before !== null : undefined,
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
