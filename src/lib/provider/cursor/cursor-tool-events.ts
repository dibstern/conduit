import { readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { Effect } from "effect";
import type { CanonicalToolInput } from "../../persistence/events.js";
import { optStr, str, toRecord } from "../normalize-tool-input-helpers.js";

export interface CursorToolCall {
	readonly type: string;
	readonly args: Readonly<Record<string, unknown>>;
	readonly result?: unknown;
}

export interface CursorToolMedia {
	readonly path: string;
	readonly mime: string;
	readonly url: string;
}

/** Shapes follow SDK 1.0.37's public ToolCall union; unknowns retain their wire input. */
export function cursorToolInput(call: CursorToolCall): {
	toolName: string;
	input: CanonicalToolInput;
} {
	const args = { ...call.args };
	const unknown = (name: string, raw = args): CanonicalToolInput => ({
		tool: "Unknown",
		name,
		raw,
	});
	switch (call.type) {
		case "shell":
			return {
				toolName: "Bash",
				input: {
					tool: "Bash",
					command: str(args, "command"),
					...optStr(args, "workingDirectory"),
					...(typeof args["timeout"] === "number"
						? { timeoutMs: args["timeout"] }
						: {}),
				},
			};
		case "read":
			return {
				toolName: "Read",
				input: { tool: "Read", filePath: str(args, "path") },
			};
		case "edit":
			return {
				toolName: "Edit",
				input: {
					tool: "Edit",
					filePath: str(args, "path"),
					oldString: "",
					newString: "",
				},
			};
		case "write":
			return {
				toolName: "Write",
				input: {
					tool: "Write",
					filePath: str(args, "path"),
					content: str(args, "fileText"),
				},
			};
		case "delete":
			return { toolName: "Delete", input: unknown("Delete") };
		case "glob":
			return {
				toolName: "Glob",
				input: {
					tool: "Glob",
					pattern: str(args, "globPattern"),
					...optStr(args, "path", "targetDirectory"),
				},
			};
		case "ls":
			return {
				toolName: "Glob",
				input: { tool: "Glob", pattern: "*", path: str(args, "path") },
			};
		case "grep":
			return {
				toolName: "Grep",
				input: {
					tool: "Grep",
					pattern: str(args, "pattern"),
					...optStr(args, "path"),
					...optStr(args, "include", "glob"),
				},
			};
		case "semSearch": {
			const paths = args["targetDirectories"];
			return {
				toolName: "Grep",
				input: {
					tool: "Grep",
					pattern: str(args, "query"),
					...(Array.isArray(paths) && typeof paths[0] === "string"
						? { path: paths[0] }
						: {}),
				},
			};
		}
		case "readLints": {
			const paths = args["paths"];
			return {
				toolName: "LSP",
				input: {
					tool: "LSP",
					operation: "diagnostics",
					...(Array.isArray(paths) && typeof paths[0] === "string"
						? { filePath: paths[0] }
						: {}),
				},
			};
		}
		case "mcp": {
			// Conduit's own ask_user renders as the question card, like Claude's.
			if (
				args["providerIdentifier"] === "custom-user-tools" &&
				args["toolName"] === "ask_user"
			)
				return {
					toolName: "AskUserQuestion",
					input: {
						tool: "AskUserQuestion",
						questions: toRecord(args["args"])["questions"] ?? null,
					},
				};
			const name = `mcp__${str(args, "providerIdentifier")}__${str(args, "toolName")}`;
			return {
				toolName: name,
				input: unknown(name, {
					...toRecord(args["args"]),
					server: str(args, "providerIdentifier"),
					toolName: str(args, "toolName"),
				}),
			};
		}
		case "updateTodos": {
			const todos = Array.isArray(args["todos"])
				? args["todos"].map((item) => {
						const todo = toRecord(item);
						return {
							...todo,
							status:
								todo["status"] === "inProgress"
									? "in_progress"
									: todo["status"],
						};
					})
				: [];
			return { toolName: "TodoWrite", input: unknown("TodoWrite", { todos }) };
		}
		case "createPlan":
			return { toolName: "CreatePlan", input: unknown("CreatePlan") };
		case "computerUse":
			return { toolName: "ComputerUse", input: unknown("ComputerUse") };
		case "task":
			// .10 will connect this generic call to live child-session ownership.
			return { toolName: "cursor.task", input: unknown("task") };
		default:
			return { toolName: call.type, input: unknown(call.type) };
	}
}

function isTruncated(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(isTruncated);
	if (value === null || typeof value !== "object") return false;
	return Object.entries(value).some(
		([key, entry]) =>
			(/truncated$/i.test(key) && entry === true) || isTruncated(entry),
	);
}

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

export class CursorToolResults {
	constructor(private readonly cwd: string) {}

	/** Only SDK-returned workspace/temp media paths may be read. */
	private read(path: string) {
		const candidate = isAbsolute(path)
			? resolve(path)
			: resolve(this.cwd, path);
		const allowedRoots = [resolve(this.cwd), resolve(tmpdir()), "/tmp"];
		if (
			candidate.split(sep).includes(".cursor") ||
			!allowedRoots.some((root) => candidate.startsWith(`${root}${sep}`))
		)
			return Effect.succeed(undefined);
		return Effect.tryPromise(async () => {
			const file = await realpath(candidate);
			if (file.split(sep).includes(".cursor")) return undefined;
			const root = await realpath(this.cwd);
			const temps = await Promise.all([realpath(tmpdir()), realpath("/tmp")]);
			if (
				!file.startsWith(`${root}${sep}`) &&
				!temps.some((temp) => file.startsWith(`${temp}${sep}`))
			)
				return undefined;
			if ((await stat(file)).size > MAX_MEDIA_BYTES) return undefined;
			return await readFile(file);
		}).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
	}

	complete(call: CursorToolCall, truncated = false) {
		return Effect.gen(this, function* () {
			const args = { ...call.args };
			const envelope = toRecord(call.result);
			const success = envelope["status"] === "success";
			const value = toRecord(success ? envelope["value"] : envelope["error"]);
			const metadata: Record<string, unknown> = {
				cursorToolType: call.type,
				...(call.type === "shell" ? { output: null } : {}),
				...(truncated || isTruncated(call.result) ? { truncated: true } : {}),
			};
			let result: unknown = call.result ?? null;
			const media: CursorToolMedia[] = [];
			if (call.type === "computerUse")
				metadata["computerUse"] = {
					actions: args["actions"],
					...optStr(args, "description"),
				};
			if (envelope["status"] === "error") {
				metadata["isError"] = true;
				result =
					typeof envelope["error"] === "string"
						? envelope["error"]
						: str(value, "message") || call.result;
			}
			if (success) {
				switch (call.type) {
					case "shell":
						metadata["exitCode"] = value["exitCode"];
						metadata["isError"] =
							typeof value["exitCode"] === "number" && value["exitCode"] !== 0;
						result = str(value, "stdout") + str(value, "stderr");
						break;
					case "read":
						result = str(value, "content");
						break;
					case "edit":
						metadata["fileChange"] = {
							filePath: str(args, "path"),
							...(typeof value["diffString"] === "string"
								? { diff: value["diffString"] }
								: {}),
							...(typeof value["linesAdded"] === "number"
								? { linesAdded: value["linesAdded"] }
								: {}),
							...(typeof value["linesRemoved"] === "number"
								? { linesRemoved: value["linesRemoved"] }
								: {}),
						};
						result = str(value, "diffString") || call.result;
						break;
					case "write":
						metadata["fileChange"] = {
							filePath: str(args, "path"),
							linesAdded: value["linesCreated"],
						};
						break;
					case "delete":
						metadata["fileChange"] = {
							filePath: str(args, "path"),
							deleted: true,
							...(typeof value["fileSize"] === "number"
								? { fileSize: value["fileSize"] }
								: {}),
						};
						break;
					case "glob":
						result = Array.isArray(value["files"])
							? value["files"].join("\n")
							: call.result;
						break;
					case "semSearch":
						result = str(value, "results");
						break;
					case "createPlan":
						metadata["plan"] = { title: "Plan", content: str(args, "plan") };
						result = str(args, "plan");
						break;
				}
			}
			const path = str(value, "screenshotPath", "filePath", "path");
			if (
				["computerUse", "generateImage", "recordScreen"].includes(call.type) &&
				path
			) {
				const extension = extname(path).toLowerCase();
				const mime =
					call.type === "recordScreen"
						? extension === ".mp4"
							? "video/mp4"
							: "video/webm"
						: extension === ".jpg" || extension === ".jpeg"
							? "image/jpeg"
							: "image/png";
				const inline =
					call.type === "generateImage" ? str(value, "imageData") : "";
				const bytes = inline ? undefined : yield* this.read(path);
				if (
					(inline && inline.length <= Math.ceil(MAX_MEDIA_BYTES / 3) * 4) ||
					bytes
				)
					media.push({
						path,
						mime,
						url: `data:${mime};base64,${inline || bytes?.toString("base64")}`,
					});
				else metadata["mediaUnavailable"] = { path, filename: basename(path) };
			}
			if (media.length) metadata["media"] = media;
			return { result, metadata };
		});
	}
}
