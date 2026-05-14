import { describe, expect, it } from "vitest";
import {
	decideRelayCommand,
	initialRelayReadModel,
	projectRelayEvents,
	type RelayCommand,
} from "../../../src/lib/domain/relay/Services/relay-domain-model.js";

const clientCommand = (
	commandId: string,
	messageType = "message",
): RelayCommand => ({
	_tag: "ClientCommandReceived",
	commandId,
	clientId: "client-1",
	messageType,
	receivedAt: 1000,
});

describe("relay domain model", () => {
	it("queues client commands until the relay is ready, then accepts them FIFO", () => {
		let model = initialRelayReadModel("project-a");

		const queuedA = decideRelayCommand(model, clientCommand("cmd-a"));
		model = projectRelayEvents(model, queuedA);
		const queuedB = decideRelayCommand(model, clientCommand("cmd-b", "cancel"));
		model = projectRelayEvents(model, queuedB);

		expect(model.lifecycle).toBe("starting");
		expect(model.queuedCommands.map((command) => command.commandId)).toEqual([
			"cmd-a",
			"cmd-b",
		]);

		const readyEvents = decideRelayCommand(model, {
			_tag: "RelayReady",
			readyAt: 2000,
		});
		model = projectRelayEvents(model, readyEvents);

		expect(readyEvents.map((event) => event._tag)).toEqual([
			"RelayBecameReady",
			"ClientCommandAccepted",
			"ClientCommandAccepted",
		]);
		expect(model.lifecycle).toBe("ready");
		expect(model.queuedCommands).toEqual([]);
		expect([...model.inFlightCommandIds]).toEqual(["cmd-a", "cmd-b"]);
	});

	it("accepts client commands immediately once ready", () => {
		let model = initialRelayReadModel("project-a");
		model = projectRelayEvents(
			model,
			decideRelayCommand(model, { _tag: "RelayReady", readyAt: 1000 }),
		);

		const events = decideRelayCommand(model, clientCommand("cmd-ready"));

		expect(events.map((event) => event._tag)).toEqual([
			"ClientCommandAccepted",
		]);
		expect(projectRelayEvents(model, events).queuedCommands).toEqual([]);
	});

	it("ignores duplicate client command ids across queued and in-flight commands", () => {
		let model = initialRelayReadModel("project-a");
		model = projectRelayEvents(
			model,
			decideRelayCommand(model, clientCommand("cmd-a")),
		);

		const duplicateWhileQueued = decideRelayCommand(
			model,
			clientCommand("cmd-a"),
		);
		expect(duplicateWhileQueued).toEqual([]);

		model = projectRelayEvents(
			model,
			decideRelayCommand(model, { _tag: "RelayReady", readyAt: 2000 }),
		);

		const duplicateWhileInFlight = decideRelayCommand(
			model,
			clientCommand("cmd-a"),
		);
		expect(duplicateWhileInFlight).toEqual([]);
	});

	it("rebuilds read model from events and completes in-flight commands", () => {
		let model = initialRelayReadModel("project-a");
		model = projectRelayEvents(model, [
			...decideRelayCommand(model, { _tag: "RelayReady", readyAt: 1000 }),
		]);
		model = projectRelayEvents(
			model,
			decideRelayCommand(model, clientCommand("cmd-a")),
		);

		model = projectRelayEvents(
			model,
			decideRelayCommand(model, {
				_tag: "ClientCommandCompleted",
				commandId: "cmd-a",
				completedAt: 3000,
			}),
		);

		expect(model.inFlightCommandIds.has("cmd-a")).toBe(false);
		expect(model.completedCommandIds.has("cmd-a")).toBe(true);
	});
});
