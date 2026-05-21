import type { ProviderRuntimeEvent } from "../contracts/providers/provider-runtime-event.js";

export function providerRefsFromRuntimeData(
	type: ProviderRuntimeEvent["type"],
	data: unknown,
): ProviderRuntimeEvent["providerRefs"] {
	const record = isRecord(data) ? data : {};
	const metadata = isRecord(record["metadata"]) ? record["metadata"] : {};
	const refs: Record<string, string> = {};

	const providerSessionId =
		stringField(record["providerSessionId"]) ??
		stringField(metadata["providerSessionId"]);
	const providerMessageId =
		stringField(record["messageId"]) ??
		stringField(metadata["providerMessageId"]);
	const providerToolUseId =
		stringField(record["callId"]) ??
		(type.startsWith("tool.") || type.startsWith("thinking.")
			? stringField(record["partId"])
			: undefined) ??
		stringField(metadata["providerToolUseId"]);
	const providerRequestId =
		type.startsWith("permission.") || type.startsWith("question.")
			? (stringField(record["id"]) ??
				stringField(metadata["providerRequestId"]))
			: stringField(metadata["providerRequestId"]);
	const providerTaskId =
		stringField(record["providerTaskId"]) ??
		stringField(metadata["providerTaskId"]);
	const parentProviderTaskId =
		stringField(record["parentProviderTaskId"]) ??
		stringField(metadata["parentProviderTaskId"]);

	if (providerSessionId) refs["providerSessionId"] = providerSessionId;
	if (providerMessageId) refs["providerMessageId"] = providerMessageId;
	if (providerToolUseId) refs["providerToolUseId"] = providerToolUseId;
	if (providerRequestId) refs["providerRequestId"] = providerRequestId;
	if (providerTaskId) refs["providerTaskId"] = providerTaskId;
	if (parentProviderTaskId) refs["parentProviderTaskId"] = parentProviderTaskId;
	return refs;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}
