import type {
	MessagePartRow,
	MessageWithParts,
} from "../persistence/read-model-types.js";
import { toolOutputText } from "../persistence/session-history-adapter.js";

function objectJson(value: string | null): Record<string, unknown> {
	if (value === null) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function historicalPart(
	part: MessagePartRow,
	summarizeTools = false,
	attachments?: ReadonlyMap<string, Uint8Array>,
): string {
	if (part.type === "tool" && summarizeTools)
		return `Tool: ${part.tool_name ?? "unknown"} (${part.status ?? "unknown"})`.replace(
			/\s+/g,
			" ",
		);
	switch (part.type) {
		case "text":
		case "error":
		case "interrupted":
		case "plan":
			return part.text;
		case "file_change":
			return `File change: ${part.text}`;
		case "file": {
			if (!attachments) return "";
			const metadata = {
				...objectJson(part.metadata),
				...objectJson(part.rest_payload ?? null),
			};
			const name =
				typeof metadata["filename"] === "string"
					? metadata["filename"]
					: "File";
			const mime =
				typeof metadata["mime"] === "string"
					? metadata["mime"]
					: "application/octet-stream";
			const source = metadata["source"];
			const bytes =
				source !== null &&
				typeof source === "object" &&
				"attachmentHash" in source &&
				typeof source.attachmentHash === "string"
					? attachments.get(source.attachmentHash)
					: undefined;
			const label = `Attachment: ${name} (${mime}${bytes ? `, ${bytes.byteLength} bytes` : ""})`;
			if (!bytes || mime !== "text/plain") return label;
			try {
				return `${label}\n${new TextDecoder("utf-8", { fatal: true }).decode(bytes)}`;
			} catch {
				return label;
			}
		}
		case "tool": {
			const input = objectJson(part.input);
			const tool = part.tool_name?.toLowerCase();
			if (tool === "bash" || tool === "shell") {
				const result = objectJson(part.result);
				const metadata = objectJson(part.metadata);
				return [
					`Command: ${typeof input["command"] === "string" ? input["command"] : ""}`,
					`Exit code: ${result["exitCode"] ?? metadata["exitCode"] ?? metadata["exit"] ?? "unknown"}`,
					typeof result["output"] === "string"
						? result["output"]
						: toolOutputText(part.result ?? ""),
				].join("\n");
			}
			if (tool === "write" || tool === "edit" || tool === "multiedit") {
				const filename = input["file_path"] ?? input["filePath"];
				return typeof filename === "string" ? `File change: ${filename}` : "";
			}
			if (tool === "exitplanmode") {
				const raw = input["raw"];
				const plan =
					input["plan"] ??
					(raw !== null && typeof raw === "object" && "plan" in raw
						? raw.plan
						: undefined);
				return typeof plan === "string" ? plan : "";
			}
			return "";
		}
		default:
			return "";
	}
}

export const historicalMessageText = (
	message: MessageWithParts,
	options?: {
		readonly summarizeTools?: boolean;
		/** Name the user's attachments and inline fetched text. ThreadRead only:
		 *  handoffs and resends never carry attachments. */
		readonly attachments?: ReadonlyMap<string, Uint8Array>;
	},
): string =>
	message.parts.length > 0
		? message.parts
				.map((part) =>
					historicalPart(
						part,
						options?.summarizeTools,
						message.role === "user" ? options?.attachments : undefined,
					),
				)
				.filter(Boolean)
				.join("\n")
		: message.text;
