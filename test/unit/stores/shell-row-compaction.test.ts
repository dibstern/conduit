// @vitest-environment jsdom
// A compaction in progress is transient status on the session's shell row
// (ni8.33, C1): the row's `compacting` shows the transcript's Compacting
// notice and the row clearing it retires the notice. The outcome is the
// transcript's own projected message.
import { beforeEach, expect, it } from "vitest";
import {
	getMessages,
	getOrCreateSessionSlot,
	sessionActivity,
	sessionMessages,
	setMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	clearSessionState,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";
import { applySessionChange } from "./session-fixtures.js";

const row = (compacting?: string): SessionInfo => ({
	id: "s",
	title: "s",
	status: "busy",
	...(compacting === undefined ? {} : { compacting }),
});
const upsert = (compacting?: string) =>
	applySessionChange({ _tag: "upsert", item: row(compacting) });
const snapshot = (compacting?: string) =>
	applySessionChange({ _tag: "snapshot", rows: [row(compacting)] });
const systemTexts = () =>
	getMessages(sessionMessages.get("s")).flatMap((message) =>
		message.type === "system" ? [`${message.compaction}:${message.text}`] : [],
	);

beforeEach(() => {
	clearSessionState();
	sessionActivity.clear();
	sessionMessages.clear();
	sessionState.currentId = "s";
});

it("the row's compaction shows a notice until the row clears it", () => {
	snapshot();
	getOrCreateSessionSlot("s");

	upsert("Compacting conversation…");
	expect(systemTexts()).toEqual(["started:Compacting conversation…"]);

	upsert();
	expect(systemTexts()).toEqual([]);
});

it("clearing the row leaves the projected outcome in place", () => {
	snapshot("Compacting conversation…");
	const { messages } = getOrCreateSessionSlot("s");
	setMessages(messages, [
		...getMessages(messages),
		{
			type: "system",
			uuid: "compaction-1/compaction-part-1",
			text: "Context compacted",
			variant: "info",
			compaction: "completed",
		},
	]);

	upsert();

	expect(systemTexts()).toEqual(["completed:Context compacted"]);
});

it("a resent snapshot of a compacting session keeps one notice", () => {
	snapshot();
	getOrCreateSessionSlot("s");
	snapshot("Compacting conversation…");
	snapshot("Compacting conversation…");
	expect(systemTexts()).toEqual(["started:Compacting conversation…"]);
});
