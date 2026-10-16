import { stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import type {
	CanonicalToolInput,
	StoredEvent,
} from "../contracts/stored-event.js";
import type { SessionWorkspace } from "../domain/relay/Services/session-workspace.js";
import { readWorktrees, realWorkspacePath } from "../git/worktrees.js";

export interface WorkspaceHintCandidate {
	readonly path: string;
	readonly recordedWorkspace: string;
}

/** Only a literal leading cd with one argument and an unambiguous separator. */
function leadingCd(command: string): string | undefined {
	const match =
		/^[ \t]*cd[ \t]+(?:'([^'\r\n]*)'|"([^"\r\n]*)"|([^\s;&|<>]+))[ \t]*(?:&&[^\r\n]*|;(?!;)[^\r\n]*|(?![\s\S]))/.exec(
			command,
		);
	const path = match?.[1] ?? match?.[2] ?? match?.[3];
	return path && !path.startsWith("-") && !/[~$`\\*?[\]{}()'"!]/.test(path)
		? path
		: undefined;
}

/** Fold each call once, using its final normalized args and its turn's folder. */
export function collectWorkspaceHintPaths(
	events: readonly StoredEvent[],
	recordedWorkspace: string,
): readonly WorkspaceHintCandidate[] {
	let directory = recordedWorkspace;
	const calls = new Map<
		string,
		{ input: CanonicalToolInput; directory: string }
	>();
	for (const event of events) {
		if (event.type === "session.workspace_changed") {
			// A user move starts on the next turn; a declaration takes effect now.
			if (event.data.cause === "agent" && event.data.path !== undefined)
				directory = event.data.path;
			continue;
		}
		if (
			event.type !== "tool.started" &&
			event.type !== "tool.running" &&
			event.type !== "tool.completed"
		)
			continue;
		const key = JSON.stringify([event.data.messageId, event.data.partId]);
		const previous = calls.get(key);
		if (event.data.input !== undefined)
			calls.set(key, {
				input: event.data.input,
				directory: previous?.directory ?? directory,
			});
	}
	return [...calls.values()].flatMap(({ input, directory: base }) => {
		let paths: readonly string[];
		switch (input.tool) {
			case "Edit":
			case "Write":
				paths = [input.filePath];
				break;
			case "Patch":
				paths = input.filePaths;
				break;
			case "Bash": {
				const cd = leadingCd(input.command);
				paths = [input.workingDirectory, cd].filter(
					(path): path is string => path !== undefined,
				);
				break;
			}
			default:
				return [];
		}
		// One call naming the same folder twice is still one write.
		return [
			...new Set(
				paths
					.filter((path) => path.trim().length > 0)
					.map((path) => resolve(base, path)),
			),
		].map((path) => ({ path, recordedWorkspace: base }));
	});
}

const nearestExistingDirectory = (path: string) =>
	Effect.gen(function* () {
		let candidate = path;
		while (true) {
			const normalized = yield* realWorkspacePath(candidate).pipe(
				Effect.option,
			);
			if (normalized._tag === "Some") {
				const info = yield* Effect.tryPromise(() =>
					stat(normalized.value),
				).pipe(Effect.option);
				if (info._tag === "Some")
					return info.value.isDirectory()
						? normalized.value
						: dirname(normalized.value);
			}
			const parent = dirname(candidate);
			if (parent === candidate) return undefined;
			candidate = parent;
		}
	});

/** Returns a path to show, null to clear, or undefined to keep the stored hint. */
export const resolveWorkspaceHint = (
	sessionId: string,
	paths: readonly WorkspaceHintCandidate[],
	resolveTarget: SessionWorkspace["resolve"],
): Effect.Effect<string | null | undefined> =>
	Effect.gen(function* () {
		const recorded = new Map<string, { directory: string; root: string }>();
		const resolved = new Map<string, string | undefined>();
		let runPath: string | undefined;
		let runCount = 0;
		let lastHome = false;
		for (const { path, recordedWorkspace } of paths) {
			let base = recorded.get(recordedWorkspace);
			if (base === undefined) {
				const normalized = yield* realWorkspacePath(recordedWorkspace).pipe(
					Effect.option,
				);
				if (normalized._tag === "None") return null;
				const repo = yield* readWorktrees(normalized.value).pipe(Effect.option);
				base = {
					directory: normalized.value,
					root: repo._tag === "Some" ? repo.value.root : normalized.value,
				};
				recorded.set(recordedWorkspace, base);
			}
			const directory = yield* nearestExistingDirectory(path);
			if (directory === undefined) continue;
			if (!resolved.has(directory)) {
				const repo = yield* readWorktrees(directory).pipe(Effect.option);
				const target =
					repo._tag === "Some"
						? yield* resolveTarget(sessionId, repo.value.root, "agent").pipe(
								Effect.option,
							)
						: undefined;
				resolved.set(
					directory,
					target?._tag === "Some" ? target.value.path : undefined,
				);
			}
			let worktree = resolved.get(directory);
			if (worktree === undefined) {
				// An unrelated repository inside this write's recorded folder counts as
				// home; one outside is ignored. A nested linked worktree has its own identity.
				const fromRecorded = relative(base.directory, directory);
				if (
					fromRecorded === "" ||
					(fromRecorded !== ".." &&
						!fromRecorded.startsWith(`..${sep}`) &&
						!isAbsolute(fromRecorded))
				)
					worktree = base.root;
				else continue;
			}
			lastHome = worktree === base.root;
			runCount = runPath === worktree ? runCount + 1 : 1;
			runPath = worktree;
		}
		if (lastHome) return null;
		return runCount >= 3 ? runPath : undefined;
	});
