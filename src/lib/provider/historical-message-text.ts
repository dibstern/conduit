import { parseAttachmentDataUrl } from "../attachment-data-url.js";
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
	includeAttachments = false,
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
			if (!includeAttachments) return "";
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
			const url = metadata["url"];
			if (typeof url !== "string") return `Attachment: ${name} (${mime})`;
			try {
				const attachment = parseAttachmentDataUrl(url);
				const bytes = Buffer.from(attachment.data, "base64");
				const label = `Attachment: ${name} (${mime}, ${bytes.length} bytes)`;
				return attachment.mime === "text/plain"
					? `${label}\n${new TextDecoder("utf-8", { fatal: true }).decode(bytes)}`
					: label;
			} catch {
				return `Attachment: ${name} (${mime})`;
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
		/** Name the user's attachments and inline their text. ThreadRead only:
		 *  handoffs and resends never carry attachments. */
		readonly includeAttachments?: boolean;
	},
): string =>
	message.parts.length > 0
		? message.parts
				.map((part) =>
					historicalPart(
						part,
						options?.summarizeTools,
						options?.includeAttachments === true && message.role === "user",
					),
				)
				.filter(Boolean)
				.join("\n")
		: message.text;
