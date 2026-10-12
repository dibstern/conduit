import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import {
	firstQueryMark,
	type QueryMark,
} from "../../helpers/claude-process-marks.js";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";

// Relay turn completion can arrive before the SDK's file/IPC query mark.
it("reads the first SDK query after delayed mark delivery", async () => {
	const events = new EventEmitter();
	const marks: ProcessMark[] = [];
	const query: QueryMark = {
		kind: "query",
		queryId: "query-1",
		at: "2026-10-11T00:00:00.000Z",
		sessionId: "native-1",
		pid: 123,
		optionsJson: "{}",
		effectiveSettingsJson: "{}",
		options: {},
		env: {},
	};
	events.once("query", (mark: QueryMark) => marks.push(mark));
	queueMicrotask(() => events.emit("query", query));
	expect(marks).toEqual([]);
	expect(await firstQueryMark({ marks })).toBe(query);
});
