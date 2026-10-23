import { describe, expect, it } from "vitest";
import {
	initialState,
	step,
} from "../../../src/lib/frontend/stores/composer-draft/state.js";

describe("composer draft restoration", () => {
	const key = { session: "session-1" };
	const restored = "refused message";
	const serverText = `${restored}\n\nsynced draft`;

	it("adopts the restored server draft when local text is synced", () => {
		const [state, commands] = step(
			{
				...initialState(),
				key,
				text: "synced draft",
				acked: "synced draft",
				snapshot: "ready",
			},
			{ _tag: "ServerTextReceived", key, text: serverText, restored },
		);

		expect(state).toMatchObject({ text: serverText, acked: serverText });
		expect(commands).toEqual([]);
	});

	it.each([
		false,
		true,
	])("resyncs restored text after a late local write, timer expired: %s", (timerExpired) => {
		const localText = "synced draft, with unsynced edits";
		const [edited] = step(
			{
				...initialState(),
				key,
				text: "synced draft",
				acked: "synced draft",
				snapshot: "ready",
			},
			{ _tag: "TextChanged", text: localText },
		);
		let [state, commands] = step(edited, { _tag: "LocalEdited" });
		expect(commands).toEqual([
			{ _tag: "SyncDraft", key, text: localText, projectSlug: null },
			{ _tag: "ScheduleSync", delay: 300 },
		]);
		expect(state.pending).toBe(false);
		if (timerExpired) [state] = step(state, { _tag: "SyncDue" });

		[state, commands] = step(state, {
			_tag: "ServerTextReceived",
			key,
			text: serverText,
			restored,
		});
		const mergedText = `${restored}\n\n${localText}`;
		expect(state).toMatchObject({
			text: mergedText,
			acked: serverText,
			pending: true,
			throttled: true,
		});
		expect(commands).toEqual([{ _tag: "ScheduleSync", delay: 300 }]);

		[state] = step(state, {
			_tag: "SyncSucceeded",
			key,
			text: localText,
			projectSlug: null,
		});
		expect(step(state, { _tag: "SyncDue" })[1]).toEqual([
			{ _tag: "SyncDraft", key, text: mergedText, projectSlug: null },
			{ _tag: "ScheduleSync", delay: 300 },
		]);
	});

	it("still ignores ordinary server updates while local edits are unsynced", () => {
		const before = {
			...initialState(),
			key,
			text: "unsynced local text",
			acked: "synced draft",
		};

		expect(
			step(before, {
				_tag: "ServerTextReceived",
				key,
				text: "another tab's draft",
			}),
		).toEqual([before, []]);
	});
});
