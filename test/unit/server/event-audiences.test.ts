import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type {
	BrowserEvent,
	Interests,
} from "../../../src/lib/server/event-audiences.js";

const interests = (
	sessions: readonly string[] = [],
	projects: readonly string[] = [],
	ptys: readonly string[] = [],
): Interests => ({
	sessions: new Set(sessions),
	projects: new Set(projects),
	ptys: new Map(ptys.map((id) => [id, new Set(projects)])),
});
const projects = new Map([
	["session-a", "project-a"],
	["session-b", "project-b"],
]);
const projectOf = (sessionId: string) => projects.get(sessionId);
const output: BrowserEvent = { type: "delta", sessionId: "session-a" };

describe("Event Audiences failure catalogue", () => {
	it("EA01 session output requires the session and its project", async () => {
		const { audienceOf, delivers } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const audience = audienceOf(output, projectOf);
		expect(audience).toEqual({
			_tag: "session",
			sessionId: "session-a",
			projectId: "project-a",
		});
		expect(delivers(audience, interests(["session-a"], ["project-a"]))).toBe(
			true,
		);
		expect(delivers(audience, interests(["session-a"], ["project-b"]))).toBe(
			false,
		);
		expect(delivers(audience, interests(["session-b"], ["project-a"]))).toBe(
			false,
		);
	});

	it("EA02 project events cannot cross project interests", async () => {
		const { audienceOf, delivers } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const audience = audienceOf(
			{ type: "project_settings", projectId: "project-a" },
			projectOf,
		);
		expect(audience).toEqual({ _tag: "project", projectId: "project-a" });
		expect(delivers(audience, interests([], ["project-a"]))).toBe(true);
		expect(delivers(audience, interests([], ["project-b"]))).toBe(false);
		expect(delivers(audience, interests(["session-a"]))).toBe(false);
	});

	it("EA03 approvals and questions remain global", async () => {
		const { audienceOf, EventDelivery } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const connection = new EventDelivery();
		const send = vi.fn();
		for (const type of ["permission", "question"]) {
			const event = { type, sessionId: "session-b", projectId: "project-b" };
			expect(audienceOf(event, projectOf)).toEqual({ _tag: "global" });
			expect(connection.deliver(event, projectOf, send)).toBe(true);
		}
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("EA04 unknown session provenance fails closed", async () => {
		const { audienceOf, delivers, EventDelivery } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const event = {
			type: "delta",
			sessionId: "missing",
			projectId: "project-a",
		};
		const audience = audienceOf(event, projectOf);
		expect(audience).toEqual({
			_tag: "session",
			sessionId: "missing",
			projectId: undefined,
		});
		const views = interests(["missing"], ["project-a"]);
		expect(delivers(audience, views)).toBe(false);
		const connection = new EventDelivery();
		connection.view(views);
		const send = vi.fn();
		expect(connection.deliver(event, projectOf, send)).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});

	it("EA05 delivery rechecks ownership between emissions", async () => {
		const { EventDelivery } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const connection = new EventDelivery();
		connection.view(interests(["session-a"], ["project-a"]));
		let owner: string | undefined = "project-a";
		const send = vi.fn();
		expect(connection.deliver(output, () => owner, send)).toBe(true);
		owner = "project-b";
		expect(connection.deliver(output, () => owner, send)).toBe(false);
		owner = undefined;
		expect(connection.deliver(output, () => owner, send)).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("EA06 interest changes take effect at the next delivery", async () => {
		const { EventDelivery } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const connection = new EventDelivery();
		const release = connection.view(interests(["session-a"], ["project-a"]));
		const send = vi.fn();
		expect(
			connection.deliver(
				output,
				() => {
					release();
					connection.view(interests(["session-b"], ["project-b"]));
					return "project-a";
				},
				send,
			),
		).toBe(false);
		expect(
			connection.deliver(
				{ type: "delta", sessionId: "session-b" },
				projectOf,
				send,
			),
		).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("EA07 closing a scope revokes queued run output", async () => {
		const { EventDelivery } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const connection = new EventDelivery();
		const release = connection.view(interests(["session-a"], ["project-a"]));
		const send = vi.fn();
		const queuedOutput = () => connection.deliver(output, projectOf, send);
		release();
		expect(queuedOutput()).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});

	it("EA08 overlapping scopes retain the remaining interests", async () => {
		const { EventDelivery } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const connection = new EventDelivery();
		const releaseFirst = connection.view(
			interests(["session-a"], ["project-a"]),
		);
		const releaseSecond = connection.view(
			interests(["session-a"], ["project-a"]),
		);
		const send = vi.fn();
		releaseFirst();
		releaseFirst();
		expect(connection.deliver(output, projectOf, send)).toBe(true);
		releaseSecond();
		expect(connection.deliver(output, projectOf, send)).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("EA09 reconnect starts empty and restores explicitly", async () => {
		const { EventDelivery } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const oldConnection = new EventDelivery();
		oldConnection.view(interests(["session-a"], ["project-a"]));
		oldConnection.close();
		const reconnected = new EventDelivery();
		const send = vi.fn();
		expect(reconnected.interests).toEqual(interests());
		expect(reconnected.deliver(output, projectOf, send)).toBe(false);
		expect(reconnected.deliver({ type: "permission" }, projectOf, send)).toBe(
			true,
		);
		reconnected.view(interests(["session-a"], ["project-a"]));
		expect(reconnected.deliver(output, projectOf, send)).toBe(true);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("EA10 restart discards old connection interests", async () => {
		const { EventDelivery } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const oldDaemonConnection = new EventDelivery();
		oldDaemonConnection.view(interests(["session-a"], ["project-a"]));
		oldDaemonConnection.close();
		oldDaemonConnection.view(interests(["session-a"], ["project-a"]));
		const send = vi.fn();
		expect(oldDaemonConnection.deliver(output, projectOf, send)).toBe(false);
		expect(
			oldDaemonConnection.deliver({ type: "question" }, projectOf, send),
		).toBe(false);
		const newDaemonConnection = new EventDelivery();
		expect(newDaemonConnection.deliver(output, projectOf, send)).toBe(false);
		expect(send).not.toHaveBeenCalled();
	});

	it("EA11 PTY detach revokes output without crossing projects", async () => {
		const { audienceOf, delivers, EventDelivery } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const event = {
			type: "pty_output",
			ptyId: "pty-a",
			projectId: "project-a",
		};
		const audience = audienceOf(event, projectOf);
		expect(audience).toEqual({
			_tag: "pty",
			ptyId: "pty-a",
			projectId: "project-a",
		});
		expect(delivers(audience, interests([], ["project-b"], ["pty-a"]))).toBe(
			false,
		);
		expect(delivers(audience, interests([], ["project-a"], ["pty-b"]))).toBe(
			false,
		);
		expect(
			delivers(
				audienceOf({ type: "pty_output", ptyId: "pty-a" }, projectOf),
				interests([], ["project-a"], ["pty-a"]),
			),
		).toBe(false);
		const connection = new EventDelivery();
		const detach = connection.view(interests([], ["project-a"], ["pty-a"]));
		const send = vi.fn();
		expect(connection.deliver(event, projectOf, send)).toBe(true);
		detach();
		expect(connection.deliver(event, projectOf, send)).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
		connection.view(interests([], ["project-a"], ["shared-pty-id"]));
		connection.view(interests([], ["project-b"]));
		expect(
			connection.deliver(
				{ type: "pty_output", ptyId: "shared-pty-id", projectId: "project-b" },
				projectOf,
				send,
			),
		).toBe(false);
	});

	it("EA12 setClientSession replaces selected interests", async () => {
		const { EventDelivery } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const { EffectWsHandler } = await import(
			"../../../src/lib/server/effect-ws-handler.js"
		);
		const connection = new EventDelivery();
		const handler = new EffectWsHandler();
		handler.setClientSession("client", "session-a", "project-a", connection);
		expect(handler.getClientInterests("client")).toEqual(
			interests(["session-a"], ["project-a"]),
		);
		handler.setClientSession("client", "session-b", "project-b", connection);
		expect(handler.getClientSession("client")).toBe("session-b");
		expect(handler.getClientInterests("client")).toEqual(
			interests(["session-b"], ["project-b"]),
		);
		const send = vi.fn();
		expect(connection.deliver(output, projectOf, send)).toBe(false);
		expect(
			connection.deliver(
				{ type: "delta", sessionId: "session-b" },
				projectOf,
				send,
			),
		).toBe(true);
		handler.close();
		expect(handler.getClientInterests("client")).toBeUndefined();
	});

	it("EA13 late cleanup cannot erase a newer selection", async () => {
		const { EventDelivery } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const connection = new EventDelivery();
		const releaseOld = connection.view(interests(["session-a"], ["project-a"]));
		connection.setClientSession("client", "session-a", "project-a");
		connection.setClientSession("client", "session-b", "project-b");
		releaseOld();
		const send = vi.fn();
		expect(connection.deliver(output, projectOf, send)).toBe(false);
		expect(
			connection.deliver(
				{ type: "delta", sessionId: "session-b" },
				projectOf,
				send,
			),
		).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		const { EffectWsHandler } = await import(
			"../../../src/lib/server/effect-ws-handler.js"
		);
		const oldRelay = new EffectWsHandler();
		const newRelay = new EffectWsHandler();
		const selected = new EventDelivery();
		oldRelay.setClientSession("client", "session-a", "project-a", selected);
		newRelay.setClientSession("client", "session-b", "project-b", selected);
		oldRelay.close();
		expect(selected.interests).toEqual(interests(["session-b"], ["project-b"]));
	});

	it("EA14 daemon and relay streams share the delivery seam", async () => {
		const { EventDelivery } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const connection = new EventDelivery();
		connection.view(interests(["session-a"], ["project-a"]));
		const received: string[] = [];
		for (const producer of ["daemon", "routed-relay", "standalone-relay"]) {
			expect(
				connection.deliver(output, projectOf, () => received.push(producer)),
			).toBe(true);
			expect(
				connection.deliver(
					{ type: "delta", sessionId: "session-b" },
					projectOf,
					() => received.push(`foreign-${producer}`),
				),
			).toBe(false);
		}
		expect(received).toEqual(["daemon", "routed-relay", "standalone-relay"]);
	});

	it("EA15 generated deliveries match policy and never leak projects", async () => {
		const { audienceOf, delivers, EventDelivery } = await import(
			"../../../src/lib/server/event-audiences.js"
		);
		const projectId = fc.constantFrom("project-a", "project-b", "project-c");
		const sessionId = fc.constantFrom("session-a", "session-b", "session-c");
		const ptyId = fc.constantFrom("pty-a", "pty-b", "pty-c");
		const event = fc.oneof(
			fc.record({ type: fc.constant("delta"), sessionId }),
			fc.record({ type: fc.constant("project_settings"), projectId }),
			fc.record({
				type: fc.constantFrom("permission", "question"),
				sessionId,
				projectId,
			}),
			fc.record({ type: fc.constant("pty_output"), ptyId, projectId }),
		);
		const views = fc.record({
			sessions: fc.uniqueArray(sessionId),
			projects: fc.uniqueArray(projectId),
			ptys: fc.uniqueArray(ptyId),
		});
		fc.assert(
			fc.property(
				event,
				fc.array(views, { minLength: 1, maxLength: 8 }),
				fc.tuple(
					fc.option(projectId, { nil: undefined }),
					fc.option(projectId, { nil: undefined }),
					fc.option(projectId, { nil: undefined }),
				),
				(generated, connections, owners) => {
					const ownership = new Map([
						["session-a", owners[0]],
						["session-b", owners[1]],
						["session-c", owners[2]],
					]);
					const currentProjectOf = (id: string) => ownership.get(id);
					for (const view of connections) {
						const held = interests(view.sessions, view.projects, view.ptys);
						const connection = new EventDelivery();
						const release = connection.view(held);
						const send = vi.fn();
						const audience = audienceOf(generated, currentProjectOf);
						const expected = delivers(audience, held);
						expect(connection.deliver(generated, currentProjectOf, send)).toBe(
							expected,
						);
						expect(send).toHaveBeenCalledTimes(expected ? 1 : 0);
						const isGlobal =
							generated.type === "permission" || generated.type === "question";
						if (!isGlobal && send.mock.calls.length > 0) {
							const owner =
								generated.type === "delta" && "sessionId" in generated
									? currentProjectOf(generated.sessionId)
									: "projectId" in generated
										? generated.projectId
										: undefined;
							expect(owner).toBeDefined();
							expect(owner !== undefined && held.projects.has(owner)).toBe(
								true,
							);
						}
						release();
						expect(
							connection.deliver(generated, currentProjectOf, () => {}),
						).toBe(isGlobal);
					}
				},
			),
			{ numRuns: 300, seed: 42, endOnFailure: true },
		);
	});
});
