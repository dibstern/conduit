import { vi } from "vitest";
import type { ProcessMark } from "./fake-claude-process-sdk.js";

export type QueryMark = Extract<ProcessMark, { kind: "query" }>;

export function firstQueryMark(harness: {
	readonly marks: readonly ProcessMark[];
}): Promise<QueryMark> {
	return vi.waitFor(
		() => {
			const query = harness.marks.find(
				(mark): mark is QueryMark => mark.kind === "query",
			);
			if (!query) throw new Error("Missing original query");
			return query;
		},
		{ timeout: 15_000 },
	);
}
