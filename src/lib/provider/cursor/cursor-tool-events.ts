import { readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { Effect } from "effect";
import type { CanonicalToolInput } from "../../persistence/events.js";
import { assertNever } from "../../utils.js";
import { optStr, str, toRecord } from "../normalize-tool-input-helpers.js";
import type { CursorToolKind } from "./sdk-real.js";

export interface CursorWireToolCall {
	readonly type: string;
	readonly args: Readonly<Record<string, unknown>>;
	readonly result?: unknown;
}

export type { CursorToolKind } from "./sdk-real.js";

type KnownToolCall = CursorWireToolCall & { readonly type: CursorToolKind };
export type CursorToolCall =
	| {
			readonly _tag: "Known";
			readonly kind: CursorToolKind;
			readonly call: KnownToolCall;
	  }
	| { readonly _tag: "Unknown"; readonly type: string; readonly raw: unknown };
export type ToolOutcome =
	| { readonly _tag: "Succeeded" }
	| { readonly _tag: "Failed"; readonly reason: string };

/** The delta boundary accepts new SDK kinds without asserting exhaustiveness. */
export function cursorToolCall(call: CursorWireToolCall): CursorToolCall {
	const kind = call.type;
	switch (kind) {
		case "shell":
		case "read":
		case "edit":
		case "write":
		case "delete":
		case "glob":
		case "ls":
		case "grep":
		case "semSearch":
		case "readLints":
		case "mcp":
		case "updateTodos":
		case "createPlan":
		case "computerUse":
		case "task":
		case "generateImage":
		case "recordScreen":
			return { _tag: "Known", kind, call: { ...call, type: kind } };
		default:
			return { _tag: "Unknown", type: kind, raw: call };
	}
}

type ProtobufStep = Readonly<Record<string, unknown>>;

function fields(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
	omitEmpty = false,
) {
	return Object.fromEntries(
		keys
			.filter(
				(key) =>
					value[key] !== undefined &&
					(!omitEmpty ||
						(Array.isArray(value[key])
							? value[key].length > 0
							: Boolean(value[key]))),
			)
			.map((key) => [key, value[key]]),
	);
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(toRecord) : [];
}

function enumName(
	value: unknown,
	names: readonly string[],
	prefix: string,
): string {
	const text = String(value).replace(`${prefix}_`, "");
	return (
		(typeof value === "number"
			? names[value]
			: names.find(
					(name) =>
						name.toLowerCase() === text.replaceAll("_", "").toLowerCase(),
				)) ??
		names[0] ??
		"unspecified"
	);
}

function directoryTree(value: unknown): unknown {
	if (!value) return undefined;
	const tree = toRecord(value);
	return {
		absPath: tree["absPath"] ?? "",
		childrenDirs: records(tree["childrenDirs"]).map(directoryTree),
		childrenFiles: records(tree["childrenFiles"]).map((file) => ({
			name: file["name"] ?? "",
		})),
		childrenWereProcessed: tree["childrenWereProcessed"] ?? false,
		fullSubtreeExtensionCounts: tree["fullSubtreeExtensionCounts"] ?? {},
		numFiles: tree["numFiles"] ?? 0,
	};
}

function coordinate(value: unknown): { x: unknown; y: unknown } | undefined {
	if (!value) return undefined;
	const point = toRecord(value);
	return { x: point["x"] ?? 0, y: point["y"] ?? 0 };
}

/** Mirrors the SDK converters over the JSON conversationSteps returned by Task. */
export function fromConversationStep(
	step: ProtobufStep,
): CursorToolCall | null {
	const tool = toRecord(step["toolCall"]);
	const entry = Object.entries(tool).find(([key]) => key.endsWith("ToolCall"));
	if (!entry) return null;
	const [name, payload] = entry;
	const wire = toRecord(payload);
	if (!wire["args"]) return null;
	const args = toRecord(wire["args"]);
	const known = cursorToolCall({
		type: name.slice(0, -"ToolCall".length),
		args,
	});
	// Internal kinds are also omitted by the SDK's live public converter.
	if (known._tag === "Unknown") return null;
	const result = toRecord(wire["result"]);
	const variant = Object.entries(result).find(
		([key]) =>
			!["isBackground", "sandboxPolicy", "terminalsFolder", "pid"].includes(
				key,
			),
	);
	let status = variant?.[0];
	const value = toRecord(variant?.[1]);
	let input: Record<string, unknown>;
	let success: Record<string, unknown> = value;
	let errorDetails: Record<string, unknown> = {};
	let error = String(
		value["error"] ??
			value["reason"] ??
			value["clientVisibleError"] ??
			(status === "error" ? "" : status) ??
			"Tool failed",
	);
	let succeeded = status === "success";
	switch (known.kind) {
		case "shell":
			errorDetails = {
				command: value["command"] ?? "",
				workingDirectory: value["workingDirectory"] ?? "",
			};
			input = {
				command: args["command"] ?? "",
				...fields(args, ["workingDirectory", "timeout"], true),
			};
			if (
				status &&
				!["success", "failure", "timeout", "rejected", "spawnError"].includes(
					status,
				)
			)
				status = undefined;
			succeeded = status === "success" || status === "failure";
			success = {
				exitCode: value["exitCode"] ?? 0,
				signal: value["signal"] ?? "",
				stdout: value["stdout"] ?? "",
				stderr: value["stderr"] ?? "",
				executionTime: value["executionTime"] ?? 0,
			};
			if (status === "timeout")
				error = `Command timed out after ${value["timeoutMs"] ?? 0}ms`;
			if (status === "rejected") error = str(value, "reason");
			if (status === "spawnError") error = str(value, "error");
			break;
		case "read":
			input = { path: args["path"] ?? "" };
			error = str(value, "error", "reason") || status || "Tool failed";
			errorDetails = {
				path: status === "error" ? value["path"] : (value["path"] ?? ""),
			};
			success = {
				content: value["content"] ?? "",
				totalLines: value["totalLines"] ?? 0,
				fileSize: Number(value["fileSize"] ?? 0),
			};
			break;
		case "edit":
			input = { path: args["path"] ?? "" };
			error = str(value, "error", "reason");
			errorDetails = { path: value["path"] ?? "" };
			success = {
				...fields(value, ["linesAdded", "linesRemoved"]),
				...fields(value, ["diffString"], true),
			};
			break;
		case "write":
			// The SDK's protobuf ToolCall has no writeToolCall variant.
			return null;
		case "delete":
			input = { path: args["path"] ?? "" };
			errorDetails = { path: value["path"] ?? "" };
			success = { fileSize: Number(value["fileSize"] ?? 0) };
			break;
		case "glob":
			input = {
				globPattern: args["globPattern"] ?? "",
				...fields(args, ["targetDirectory"], true),
			};
			success = {
				files: value["files"] ?? [],
				totalFiles: value["totalFiles"] ?? 0,
				clientTruncated: value["clientTruncated"] ?? false,
				ripgrepTruncated: value["ripgrepTruncated"] ?? false,
			};
			break;
		case "grep":
			input = {
				pattern: args["pattern"] ?? "",
				...fields(
					args,
					[
						"path",
						"glob",
						"outputMode",
						"contextBefore",
						"contextAfter",
						"context",
						"caseInsensitive",
						"type",
						"headLimit",
						"multiline",
						"sort",
						"sortAscending",
					],
					true,
				),
				...fields(args, ["offset"]),
			};
			{
				const grepResult = (raw: unknown) => {
					const result = toRecord(raw);
					if (result["content"]) {
						const content = toRecord(result["content"]);
						return {
							type: "content",
							output: {
								matches: records(content["matches"]).map((match) => ({
									file: match["file"] ?? "",
									...fields(match, ["lineNumber"]),
									line: match["line"],
									...fields(match, ["beforeContext", "afterContext"]),
								})),
								totalMatches: content["totalMatches"] ?? 0,
							},
						};
					}
					if (result["files"]) {
						const files = toRecord(result["files"]);
						return {
							type: "files",
							output: {
								files: files["files"] ?? [],
								count: files["count"] ?? 0,
							},
						};
					}
					if (result["count"]) {
						const count = toRecord(result["count"]);
						return {
							type: "count",
							output: {
								counts: records(count["counts"]).map((item) => ({
									file: item["file"] ?? "",
									count: item["count"] ?? 0,
								})),
								total: count["total"] ?? 0,
							},
						};
					}
					return undefined;
				};
				const workspace = toRecord(value["workspaceResults"]);
				success = {
					...(Object.keys(workspace).length
						? {
								workspaceResults: Object.fromEntries(
									Object.entries(workspace).map(([key, result]) => [
										key,
										grepResult(result),
									]),
								),
							}
						: {}),
					...(value["activeEditorResult"]
						? { activeEditorResult: grepResult(value["activeEditorResult"]) }
						: {}),
				};
			}
			break;
		case "ls":
			input = { path: args["path"] ?? "", ...fields(args, ["ignore"], true) };
			success = {
				directoryTreeRoot: directoryTree(value["directoryTreeRoot"]),
			};
			break;
		case "readLints":
			input = { paths: args["paths"] ?? [] };
			success = {
				fileDiagnostics: records(value["fileDiagnostics"]).map((file) => ({
					path: file["path"] ?? "",
					diagnostics: records(file["diagnostics"]).map((diagnostic) => {
						const range = toRecord(diagnostic["range"]);
						const position = (raw: unknown) => {
							const point = toRecord(raw);
							return {
								line: point["line"] ?? 0,
								character: point["character"],
							};
						};
						return {
							severity: enumName(
								diagnostic["severity"],
								["error", "error", "warning", "information", "hint"],
								"DIAGNOSTIC_SEVERITY",
							),
							...(diagnostic["range"]
								? {
										range: {
											...(range["start"]
												? { start: position(range["start"]) }
												: {}),
											...(range["end"] ? { end: position(range["end"]) } : {}),
										},
									}
								: {}),
							message: diagnostic["message"] ?? "",
							source: diagnostic["source"] ?? "",
							code: diagnostic["code"] ?? "",
						};
					}),
					diagnosticsCount: file["diagnosticsCount"] ?? 0,
				})),
				totalFiles: value["totalFiles"] ?? 0,
				totalDiagnostics: value["totalDiagnostics"] ?? 0,
			};
			break;
		case "mcp":
			error = str(value, "error", "reason");
			input = {
				...fields(args, ["providerIdentifier", "toolName"], true),
				args: toRecord(args["args"]),
			};
			success = {
				content: records(value["content"]).map((item) =>
					item["text"]
						? { text: { text: toRecord(item["text"])["text"] ?? "" } }
						: item["image"]
							? {
									image: {
										data: Uint8Array.from(
											Buffer.from(
												str(toRecord(item["image"]), "data"),
												"base64",
											),
										),
										...fields(toRecord(item["image"]), ["mimeType"], true),
									},
								}
							: {},
				),
				isError: value["isError"] ?? false,
			};
			break;
		case "semSearch":
			input = {
				query: args["query"] ?? "",
				...fields(args, ["targetDirectories", "explanation"], true),
			};
			success = { results: value["results"] ?? "" };
			break;
		case "generateImage":
			input = {
				description: args["description"] ?? "",
				...fields(args, ["filePath"], true),
			};
			success = { filePath: value["filePath"] ?? "" };
			break;
		case "recordScreen":
			input = {
				mode:
					typeof args["mode"] === "number"
						? ["START_RECORDING", "SAVE_RECORDING", "DISCARD_RECORDING"][
								args["mode"] - 1
							]
						: String(args["mode"]).replace(/^RECORDING_MODE_/, ""),
			};
			succeeded =
				status === "startSuccess" ||
				status === "saveSuccess" ||
				status === "discardSuccess";
			success =
				status === "startSuccess"
					? {
							wasPriorRecordingCancelled:
								value["wasPriorRecordingCancelled"] ?? false,
						}
					: status === "saveSuccess"
						? {
								path: value["path"] ?? "",
								recordingDurationMs: Number(value["recordingDurationMs"] ?? 0),
							}
						: {};
			error = str(value, "error");
			if (
				status &&
				!["startSuccess", "saveSuccess", "discardSuccess", "failure"].includes(
					status,
				)
			)
				status = undefined;
			break;
		case "createPlan":
			input = { plan: args["plan"] ?? "" };
			success = {};
			break;
		case "updateTodos": {
			const todos = (items: unknown) =>
				records(items).map((todo) => ({
					content: todo["content"] ?? "",
					status: enumName(
						todo["status"],
						["pending", "pending", "inProgress", "completed", "cancelled"],
						"TODO_STATUS",
					),
				}));
			input = { todos: todos(args["todos"]) };
			success = {
				todos: todos(value["todos"]),
				totalCount: value["totalCount"] ?? 0,
			};
			break;
		}
		case "computerUse":
			errorDetails = {
				actionCount: value["actionCount"] ?? 0,
				durationMs: value["durationMs"] ?? 0,
				screenshotPath: value["screenshotPath"],
				log: value["log"],
			};
			input = {
				description: args["description"],
				actions: records(args["actions"]).flatMap<Record<string, unknown>>(
					(action) => {
						const entry = Object.entries(action)[0];
						if (!entry) return [];
						const [type, raw] = entry;
						const value = toRecord(raw);
						const point = coordinate(value["coordinate"]);
						const button = enumName(
							value["button"],
							["unspecified", "left", "right", "middle", "back", "forward"],
							"MOUSE_BUTTON",
						);
						switch (type) {
							case "mouseMove":
								return [{ type, coordinate: point }];
							case "click":
								return [
									{
										type,
										coordinate: point,
										button,
										count: value["count"] ?? 0,
										modifierKeys: value["modifierKeys"],
									},
								];
							case "mouseDown":
							case "mouseUp":
								return [{ type, button }];
							case "drag":
								return [
									{
										type,
										path: records(value["path"]).map(coordinate),
										button,
										modifierKeys: value["modifierKeys"],
									},
								];
							case "scroll":
								return [
									{
										type,
										coordinate: point,
										direction: enumName(
											value["direction"],
											["unspecified", "up", "down", "left", "right"],
											"SCROLL_DIRECTION",
										),
										amount: value["amount"] ?? 0,
										modifierKeys: value["modifierKeys"],
									},
								];
							case "type":
								return [{ type, text: value["text"] ?? "" }];
							case "key":
								return [
									{
										type,
										key: value["key"] ?? "",
										holdDurationMs: value["holdDurationMs"],
										stroke: enumName(
											value["stroke"],
											["unspecified", "tap", "down", "up"],
											"KEY_STROKE",
										),
									},
								];
							case "wait":
								return [{ type, durationMs: value["durationMs"] ?? 0 }];
							case "screenshot":
							case "cursorPosition":
								return [{ type }];
							default:
								return [];
						}
					},
				),
			};
			success = {
				actionCount: value["actionCount"] ?? 0,
				durationMs: value["durationMs"] ?? 0,
				settleMs: value["settleMs"],
				screenshotPath: value["screenshotPath"],
				log: value["log"],
				cursorPosition: coordinate(value["cursorPosition"]),
			};
			if (status && !["success", "error"].includes(status)) status = undefined;
			break;
		case "task": {
			const subagent = toRecord(args["subagentType"]);
			const subagentType =
				typeof subagent["kind"] === "string"
					? subagent
					: "custom" in subagent
						? { kind: "custom", name: toRecord(subagent["custom"])["name"] }
						: { kind: Object.keys(subagent)[0] ?? "unspecified" };
			input = {
				description: args["description"] ?? "",
				prompt: args["prompt"] ?? "",
				...fields(
					args,
					[
						"model",
						"resume",
						"agentId",
						"attachments",
						"respondingToMessageIds",
					],
					true,
				),
				...(args["subagentType"] ? { subagentType } : {}),
				mode: enumName(
					args["mode"],
					["unspecified", "agent", "plan"],
					"TASK_MODE",
				),
			};
			success = {
				...fields(
					value,
					["conversationSteps", "agentId", "resultSuffix", "transcriptPath"],
					true,
				),
				isBackground: value["isBackground"] ?? false,
				...(value["durationMs"] !== undefined
					? { durationMs: Number(value["durationMs"]) }
					: {}),
				backgroundReason: enumName(
					value["backgroundReason"],
					["unspecified", "agentRequest", "userRequest", "queuedFollowUp"],
					"SUBAGENT_BACKGROUND_REASON",
				),
			};
			error = str(value, "error");
			if (status && !["success", "error"].includes(status)) status = undefined;
			break;
		}
		default:
			return assertNever(known.kind);
	}
	return {
		...known,
		call: {
			type: known.kind,
			args: input,
			...(status
				? {
						result: succeeded
							? { status: "success", value: success }
							: {
									status: "error",
									error: {
										...errorDetails,
										message: error,
									},
								},
					}
				: wire["result"] || known.kind === "computerUse"
					? { result: undefined }
					: {}),
		},
	};
}

export interface CursorToolMedia {
	readonly path: string;
	readonly mime: string;
	readonly url: string;
}

/** Shapes follow the SDK's public ToolCall union; unknowns retain their wire input. */
export function cursorToolInput(call: CursorToolCall): {
	toolName: string;
	input: CanonicalToolInput;
} {
	if (call._tag === "Unknown")
		return {
			toolName: call.type,
			input: {
				tool: "Unknown",
				name: call.type,
				raw: toRecord(toRecord(call.raw)["args"]),
			},
		};
	const args = { ...call.call.args };
	const unknown = (name: string, raw = args): CanonicalToolInput => ({
		tool: "Unknown",
		name,
		raw,
	});
	switch (call.kind) {
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
		case "generateImage":
			return { toolName: "generateImage", input: unknown("generateImage") };
		case "recordScreen":
			return { toolName: "recordScreen", input: unknown("recordScreen") };
		case "task": {
			const type = toRecord(args["subagentType"]);
			return {
				toolName: "Task",
				input: {
					tool: "Task",
					description: str(args, "description"),
					prompt: str(args, "prompt"),
					subagentType: str(type, "name") || str(type, "kind") || "unknown",
				},
			};
		}
		default:
			return assertNever(call.kind);
	}
}

/** One failure classification for live deltas and converted conversation steps. */
export function cursorToolOutcome(known: CursorToolCall): {
	toolName: string;
	input: CanonicalToolInput;
	outcome: ToolOutcome;
	result: unknown;
	metadata: Record<string, unknown>;
} {
	const call =
		known._tag === "Known"
			? known.call
			: {
					type: known.type,
					args: toRecord(toRecord(known.raw)["args"]),
					result: toRecord(known.raw)["result"],
				};
	let outcome: ToolOutcome = { _tag: "Succeeded" };
	const args = { ...call.args };
	const envelope = toRecord(call.result);
	const success = envelope["status"] === "success";
	const value = toRecord(success ? envelope["value"] : envelope["error"]);
	const metadata: Record<string, unknown> = {
		cursorToolType: call.type,
		...(call.type === "shell" ? { output: null } : {}),
	};
	let result: unknown = call.result ?? null;
	if (call.type === "computerUse")
		metadata["computerUse"] = {
			actions: args["actions"],
			...optStr(args, "description"),
		};
	if (envelope["status"] === "error") {
		outcome = {
			_tag: "Failed",
			reason:
				typeof envelope["error"] === "string"
					? envelope["error"]
					: str(value, "message") || "Tool failed",
		};
		result =
			typeof envelope["error"] === "string"
				? envelope["error"]
				: str(value, "message") || call.result;
	}
	if (success && known._tag === "Known") {
		switch (known.kind) {
			case "task": {
				// conversationSteps belong only to the child transcript.
				result = value["resultSuffix"] ?? "";
				metadata["backgrounded"] = value["isBackground"] === true;
				break;
			}
			case "shell":
				metadata["exitCode"] = value["exitCode"];
				if (typeof value["exitCode"] === "number" && value["exitCode"] !== 0)
					outcome = {
						_tag: "Failed",
						reason: `Command exited with code ${value["exitCode"]}`,
					};
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
			case "mcp":
				if (value["isError"] === true)
					outcome = { _tag: "Failed", reason: "MCP tool returned an error" };
				break;
			case "grep":
			case "ls":
			case "readLints":
			case "updateTodos":
			case "computerUse":
			case "generateImage":
			case "recordScreen":
				break;
			default:
				assertNever(known.kind);
		}
	}
	return { ...cursorToolInput(known), outcome, result, metadata };
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
		}).pipe(Effect.catch(() => Effect.succeed(undefined)));
	}

	complete(call: CursorWireToolCall, truncated = false) {
		return Effect.gen({ self: this }, function* () {
			const completed = cursorToolOutcome(cursorToolCall(call));
			const { metadata } = completed;
			if (truncated || isTruncated(call.result)) metadata["truncated"] = true;
			const envelope = toRecord(call.result);
			const value = toRecord(
				envelope["status"] === "success"
					? envelope["value"]
					: envelope["error"],
			);
			const media: CursorToolMedia[] = [];
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
				const bytes = yield* this.read(path);
				if (bytes)
					media.push({
						path,
						mime,
						url: `data:${mime};base64,${bytes.toString("base64")}`,
					});
				else metadata["mediaUnavailable"] = { path, filename: basename(path) };
			}
			if (media.length) metadata["media"] = media;
			return completed;
		});
	}
}
