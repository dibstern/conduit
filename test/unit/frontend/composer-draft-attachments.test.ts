import { describe, expect, it } from "vitest";
import {
	type DraftEvent,
	type DraftState,
	draftKeyId,
	hasContent,
	initialState,
	step,
} from "../../../src/lib/frontend/stores/composer-draft/state.js";

const key = { session: "session-a" };
const other = { session: "session-b" };
const local = (id = "a") => ({
	id,
	name: `${id}.png`,
	mime: "image/png",
	size: 3,
	dataUrl: "data:image/png;base64,YWJj",
});
const saved = (id = "a") => ({
	id,
	name: `${id}.png`,
	mime: "image/png",
	size: 3,
	hash: id.repeat(64),
});
const apply = (state: DraftState, event: DraftEvent) => step(state, event)[0];
const items = (state: DraftState, target = key) =>
	state.attachments.get(draftKeyId(target)) ?? [];
const added = () =>
	apply(initialState(), { _tag: "AttachmentAdded", key, attachment: local() });
const received = (state: DraftState, attachments = [saved()]) =>
	apply(state, { _tag: "AttachmentsReceived", key, attachments });
const failed = () =>
	apply(added(), {
		_tag: "AttachmentAddFailed",
		key,
		id: "a",
		error: "offline",
	});
const removing = (state = added()) =>
	apply(state, { _tag: "AttachmentRemoved", key, id: "a" });

describe("composer Draft attachment transitions", () => {
	it("local add enters saving, previews immediately, and captures its Draft key", () => {
		const [state, commands] = step(initialState(), {
			_tag: "AttachmentAdded",
			key,
			attachment: local(),
		});
		expect(items(state)).toEqual([{ ...local(), status: "saving" }]);
		expect(commands).toEqual([
			{ _tag: "AddAttachment", key, attachment: local() },
		]);
		const switched = apply(state, {
			_tag: "KeySwitched",
			key: other,
			projectSlug: "project",
			projectChosen: false,
		});
		expect(items(switched, other)).toEqual([]);
		expect(items(switched)).toHaveLength(1);
		expect(hasContent(switched, key)).toBe(true);
		expect(hasContent(switched, other)).toBe(false);
	});

	it("add acknowledgment saves metadata, releases bytes, and drops ended ids", () => {
		const acknowledged = apply(added(), {
			_tag: "AttachmentAddAcknowledged",
			key,
			id: "a",
			result: { attachment: saved() },
		});
		expect(items(acknowledged)).toEqual([{ ...saved(), status: "saved" }]);
		for (const ended of ["removed", "sent"] as const)
			expect(
				items(
					apply(added(), {
						_tag: "AttachmentAddAcknowledged",
						key,
						id: "a",
						result: { ended },
					}),
				),
			).toEqual([]);
	});

	it("add failure and connection loss turn saving into failed", () => {
		expect(items(failed())[0]).toMatchObject({
			status: "failed",
			error: "offline",
		});
		expect(items(apply(added(), { _tag: "ConnectionLost" }))[0]).toMatchObject({
			status: "failed",
		});
	});

	it("snapshot own echoes save saving and failed items in server order before local items", () => {
		for (const state of [added(), failed()]) {
			const withLocal = apply(state, {
				_tag: "AttachmentAdded",
				key,
				attachment: local("c"),
			});
			expect(items(received(withLocal, [saved("b"), saved()]))).toEqual([
				{ ...saved("b"), status: "saved" },
				{ ...saved(), status: "saved" },
				{ ...local("c"), status: "saving" },
			]);
		}
	});

	it("snapshot echoes never reveal removing items or let a late Add reveal them", () => {
		const hidden = received(removing());
		expect(items(hidden)[0]?.status).toBe("removing");
		expect(hasContent(hidden, key)).toBe(false);
		expect(
			items(
				apply(hidden, {
					_tag: "AttachmentAddAcknowledged",
					key,
					id: "a",
					result: { attachment: saved() },
				}),
			)[0]?.status,
		).toBe("removing");
	});

	it("snapshot absence drops saved items removed elsewhere", () => {
		expect(items(received(received(added()), []))).toEqual([]);
	});

	it("snapshot absence preserves saving and failed local-only items", () => {
		for (const state of [added(), failed()])
			expect(items(received(state, []))).toEqual(items(state));
		expect(initialState().attachments.size).toBe(0);
	});

	it("snapshot absence drops removing items", () => {
		expect(items(received(removing(), []))).toEqual([]);
	});

	it("local remove hides each status, remembers it, and addresses the owning key", () => {
		for (const state of [added(), failed(), received(added())]) {
			const [next, commands] = step(state, {
				_tag: "AttachmentRemoved",
				key,
				id: "a",
			});
			expect(items(next)[0]).toMatchObject({
				status: "removing",
				previousStatus: items(state)[0]?.status,
			});
			expect(commands).toEqual([{ _tag: "RemoveAttachment", key, id: "a" }]);
			expect(hasContent(next, key)).toBe(false);
		}
	});

	it("remove acknowledgment drops the removing id", () => {
		expect(
			items(
				apply(removing(), {
					_tag: "AttachmentRemoveAcknowledged",
					key,
					id: "a",
				}),
			),
		).toEqual([]);
	});

	it("remove failure restores its previous status and displays the error", () => {
		for (const state of [added(), failed(), received(added())]) {
			const next = apply(removing(state), {
				_tag: "AttachmentRemoveFailed",
				key,
				id: "a",
				error: "remove refused",
			});
			expect(items(next)[0]).toMatchObject({
				status: items(state)[0]?.status,
				error: "remove refused",
			});
			expect(hasContent(next, key)).toBe(true);
		}
	});

	it("remove failure restores the Add settlement received while hidden", () => {
		for (const settlement of [
			{ _tag: "AttachmentAddFailed", key, id: "a", error: "offline" },
			{ _tag: "ConnectionLost" },
			{
				_tag: "AttachmentAddAcknowledged",
				key,
				id: "a",
				result: { attachment: saved() },
			},
			{ _tag: "AttachmentsReceived", key, attachments: [saved()] },
		] satisfies DraftEvent[]) {
			const settled = apply(removing(), settlement);
			expect(items(settled)[0]?.status).toBe("removing");
			const restored = apply(settled, {
				_tag: "AttachmentRemoveFailed",
				key,
				id: "a",
				error: "remove refused",
			});
			const savedAdd =
				settlement._tag === "AttachmentAddAcknowledged" ||
				settlement._tag === "AttachmentsReceived";
			expect(items(restored)[0]).toMatchObject({
				status: savedAdd ? "saved" : "failed",
				error: "remove refused",
				...(savedAdd ? saved() : local()),
			});
			const [retried, commands] = step(restored, { _tag: "Reconnected" });
			expect(items(retried)[0]?.status).toBe(savedAdd ? "saved" : "saving");
			expect(commands).toEqual(
				savedAdd ? [] : [{ _tag: "AddAttachment", key, attachment: local() }],
			);
		}
	});

	it("failed sends flush dirty empty text for active and cached session Drafts", () => {
		for (const cached of [false, true]) {
			let state = apply(initialState(), {
				_tag: "KeySwitched",
				key,
				projectSlug: "project",
				projectChosen: false,
			});
			state = apply(state, {
				_tag: "ServerTextReceived",
				key,
				text: "sent text",
				initial: true,
			});
			state = apply(state, { _tag: "SendStarted", clear: true });
			state = apply(state, { _tag: "TextChanged", text: "" });
			expect(step(state, { _tag: "LocalEdited" })[1]).toEqual([]);
			if (cached)
				state = apply(state, {
					_tag: "KeySwitched",
					key: other,
					projectSlug: "project",
					projectChosen: false,
				});
			const [next, commands] = step(state, {
				_tag: "SendFailed",
				key,
				text: "sent text",
				restore: true,
				sentTo: null,
				hasAttachments: false,
				alreadySent: false,
			});
			expect(
				commands.filter((command) => command._tag === "SyncDraft"),
			).toEqual([{ _tag: "SyncDraft", key, text: "", projectSlug: "project" }]);
			expect(next.inFlight.size).toBe(0);
			expect(cached ? next.drafts.get(draftKeyId(key))?.text : next.text).toBe(
				"",
			);
		}
	});

	it.each([
		["Promoted", "SendSucceeded", "draft"],
		["Promoted", "SendSucceeded", "session"],
		["Promoted", "SendFailed", "draft"],
		["Promoted", "SendFailed", "session"],
		["Retired", "SendSucceeded", "draft"],
		["Retired", "SendSucceeded", "session"],
		["Retired", "SendFailed", "draft"],
		["Retired", "SendFailed", "session"],
	] as const)("%s transfers an in-flight send; %s for the %s key settles it", (promotion, settlement, scope) => {
		const source = { draft: "sending-draft" };
		const destination = { session: "created-session" };
		let state = apply(initialState(), {
			_tag: "KeySwitched",
			key: source,
			projectSlug: "project",
			projectChosen: false,
		});
		state = apply(state, { _tag: "TextChanged", text: "sent text" });
		state = apply(state, { _tag: "SendStarted", clear: true });
		state = apply(state, {
			_tag: promotion,
			key: source,
			sessionId: destination.session,
			text: "sent text",
			freshDraftId: "fresh",
		});
		expect(state.key).toEqual(destination);
		expect([...state.inFlight]).toEqual([
			[draftKeyId(destination), ["sent text"]],
		]);
		// A duplicate publication or reconnect must keep the pending attempt.
		state = apply(state, {
			_tag: "Retired",
			key: source,
			sessionId: destination.session,
			freshDraftId: "fresh",
		});
		expect(state.inFlight.has(draftKeyId(destination))).toBe(true);
		const [settled] = step(state, {
			_tag: settlement,
			key: scope === "draft" ? source : destination,
			text: "sent text",
			sentTo: null,
			steer: false,
			clear: true,
			restore: true,
			hasAttachments: false,
			alreadySent: false,
		});
		expect(settled.inFlight.size).toBe(0);
	});

	it("promotion transfers a cached send without blocking another Draft", () => {
		const source = { draft: "sending-draft" };
		let state = apply(initialState(), {
			_tag: "KeySwitched",
			key: source,
			projectSlug: "project",
			projectChosen: false,
		});
		state = apply(state, { _tag: "SendStarted", clear: true });
		state = apply(state, {
			_tag: "KeySwitched",
			key: other,
			projectSlug: "project",
			projectChosen: false,
		});
		state = apply(state, {
			_tag: "Promoted",
			key: source,
			sessionId: "created",
			text: "",
			freshDraftId: "fresh",
		});
		expect(state.key).toEqual(other);
		expect([...state.inFlight]).toEqual([["session:created", [""]]]);
		state = apply(state, {
			_tag: "SendFailed",
			key: source,
			text: "",
			sentTo: "created",
			restore: true,
			hasAttachments: true,
			alreadySent: false,
		});
		expect(state.inFlight.size).toBe(0);
	});

	it("DraftAlreadySent settles its attempt and follows the winner's delayed promotion", () => {
		const draftKey = { draft: "draft-a" };
		let state = apply(initialState(), {
			_tag: "KeySwitched",
			key: draftKey,
			projectSlug: "project",
			projectChosen: false,
		});
		state = apply(state, {
			_tag: "ServerTextReceived",
			key: draftKey,
			text: "sent text",
			initial: true,
		});
		state = apply(state, { _tag: "SendStarted", clear: true });
		const [refused, writes] = step(state, {
			_tag: "SendFailed",
			key: draftKey,
			text: "sent text",
			restore: true,
			sentTo: null,
			hasAttachments: false,
			alreadySent: true,
		});
		expect(writes.filter((command) => command._tag === "SyncDraft")).toEqual(
			[],
		);
		expect(refused.text).toBe("");
		expect(refused.inFlight.size).toBe(0);
		const [promoted, commands] = step(refused, {
			_tag: "Promoted",
			key: draftKey,
			text: "sent text",
			sessionId: "winner",
			freshDraftId: "fresh-draft",
		});
		expect(promoted.key).toEqual({ session: "winner" });
		expect(promoted.inFlight.size).toBe(0);
		expect(commands).toContainEqual({
			_tag: "NavigateSession",
			sessionId: "winner",
		});
	});

	it("reconnect retries failed adds with the same data and key only", () => {
		const state = apply(failed(), {
			_tag: "AttachmentAdded",
			key: other,
			attachment: local("b"),
		});
		const [next, commands] = step(state, { _tag: "Reconnected" });
		expect(items(next)[0]).toEqual({ ...local(), status: "saving" });
		expect(commands).toEqual([
			{ _tag: "AddAttachment", key, attachment: local() },
		]);
		expect(items(next, other)[0]?.status).toBe("saving");
	});

	it("accepted send drops listed ids, retaining later picks and other Drafts", () => {
		let state = apply(received(added()), {
			_tag: "AttachmentAdded",
			key,
			attachment: local("b"),
		});
		state = apply(state, {
			_tag: "AttachmentAdded",
			key: other,
			attachment: local("c"),
		});
		state = apply(state, { _tag: "SendAttachmentsAccepted", key, ids: ["a"] });
		expect(items(state).map(({ id }) => id)).toEqual(["b"]);
		expect(items(state, other).map(({ id }) => id)).toEqual(["c"]);
		const textOnly = apply(
			apply(initialState(), {
				_tag: "KeySwitched",
				key,
				projectSlug: "project",
				projectChosen: false,
			}),
			{ _tag: "TextChanged", text: "text" },
		);
		expect(hasContent(textOnly, key)).toBe(true);
	});
});
