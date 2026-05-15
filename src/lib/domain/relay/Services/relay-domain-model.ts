export type RelayLifecycle = "starting" | "ready" | "stopping" | "stopped";

export interface QueuedRelayCommand {
	readonly commandId: string;
	readonly clientId: string;
	readonly messageType: string;
	readonly sessionId?: string;
	readonly receivedAt: number;
}

export interface RelayReadModel {
	readonly projectSlug: string;
	readonly lifecycle: RelayLifecycle;
	readonly readyAt?: number;
	readonly queuedCommands: readonly QueuedRelayCommand[];
	readonly inFlightCommandIds: ReadonlySet<string>;
	readonly completedCommandIds: ReadonlySet<string>;
}

export type RelayCommand =
	| {
			readonly _tag: "RelayReady";
			readonly readyAt: number;
	  }
	| {
			readonly _tag: "ClientCommandReceived";
			readonly commandId: string;
			readonly clientId: string;
			readonly messageType: string;
			readonly sessionId?: string;
			readonly receivedAt: number;
	  }
	| {
			readonly _tag: "ClientCommandCompleted";
			readonly commandId: string;
			readonly completedAt: number;
	  }
	| {
			readonly _tag: "RelayStopping";
			readonly stoppedAt: number;
	  };

export type RelayEvent =
	| {
			readonly _tag: "RelayBecameReady";
			readonly projectSlug: string;
			readonly readyAt: number;
	  }
	| {
			readonly _tag: "ClientCommandQueued";
			readonly projectSlug: string;
			readonly command: QueuedRelayCommand;
	  }
	| {
			readonly _tag: "ClientCommandAccepted";
			readonly projectSlug: string;
			readonly command: QueuedRelayCommand;
	  }
	| {
			readonly _tag: "ClientCommandCompleted";
			readonly projectSlug: string;
			readonly commandId: string;
			readonly completedAt: number;
	  }
	| {
			readonly _tag: "RelayStopped";
			readonly projectSlug: string;
			readonly stoppedAt: number;
	  };

export function initialRelayReadModel(projectSlug: string): RelayReadModel {
	return {
		projectSlug,
		lifecycle: "starting",
		queuedCommands: [],
		inFlightCommandIds: new Set(),
		completedCommandIds: new Set(),
	};
}

function hasSeenCommand(model: RelayReadModel, commandId: string): boolean {
	return (
		model.completedCommandIds.has(commandId) ||
		model.inFlightCommandIds.has(commandId) ||
		model.queuedCommands.some((command) => command.commandId === commandId)
	);
}

function commandEnvelope(
	command: Extract<RelayCommand, { _tag: "ClientCommandReceived" }>,
): QueuedRelayCommand {
	return {
		commandId: command.commandId,
		clientId: command.clientId,
		messageType: command.messageType,
		...(command.sessionId != null ? { sessionId: command.sessionId } : {}),
		receivedAt: command.receivedAt,
	};
}

export function decideRelayCommand(
	model: RelayReadModel,
	command: RelayCommand,
): readonly RelayEvent[] {
	switch (command._tag) {
		case "RelayReady": {
			if (model.lifecycle === "ready") return [];
			return [
				{
					_tag: "RelayBecameReady",
					projectSlug: model.projectSlug,
					readyAt: command.readyAt,
				},
				...model.queuedCommands.map((queued) => ({
					_tag: "ClientCommandAccepted" as const,
					projectSlug: model.projectSlug,
					command: queued,
				})),
			];
		}
		case "ClientCommandReceived": {
			if (hasSeenCommand(model, command.commandId)) return [];
			const queued = commandEnvelope(command);
			if (model.lifecycle === "ready") {
				return [
					{
						_tag: "ClientCommandAccepted",
						projectSlug: model.projectSlug,
						command: queued,
					},
				];
			}
			return [
				{
					_tag: "ClientCommandQueued",
					projectSlug: model.projectSlug,
					command: queued,
				},
			];
		}
		case "ClientCommandCompleted": {
			if (!model.inFlightCommandIds.has(command.commandId)) return [];
			return [
				{
					_tag: "ClientCommandCompleted",
					projectSlug: model.projectSlug,
					commandId: command.commandId,
					completedAt: command.completedAt,
				},
			];
		}
		case "RelayStopping": {
			if (model.lifecycle === "stopped") return [];
			return [
				{
					_tag: "RelayStopped",
					projectSlug: model.projectSlug,
					stoppedAt: command.stoppedAt,
				},
			];
		}
		default: {
			const _exhaustive: never = command;
			return _exhaustive;
		}
	}
}

export function projectRelayEvent(
	model: RelayReadModel,
	event: RelayEvent,
): RelayReadModel {
	switch (event._tag) {
		case "RelayBecameReady":
			return {
				...model,
				lifecycle: "ready",
				readyAt: event.readyAt,
			};
		case "ClientCommandQueued":
			return {
				...model,
				queuedCommands: [...model.queuedCommands, event.command],
			};
		case "ClientCommandAccepted": {
			const inFlightCommandIds = new Set(model.inFlightCommandIds);
			inFlightCommandIds.add(event.command.commandId);
			return {
				...model,
				queuedCommands: model.queuedCommands.filter(
					(command) => command.commandId !== event.command.commandId,
				),
				inFlightCommandIds,
			};
		}
		case "ClientCommandCompleted": {
			const inFlightCommandIds = new Set(model.inFlightCommandIds);
			inFlightCommandIds.delete(event.commandId);
			const completedCommandIds = new Set(model.completedCommandIds);
			completedCommandIds.add(event.commandId);
			return {
				...model,
				inFlightCommandIds,
				completedCommandIds,
			};
		}
		case "RelayStopped":
			return {
				...model,
				lifecycle: "stopped",
				queuedCommands: [],
				inFlightCommandIds: new Set(),
			};
		default: {
			const _exhaustive: never = event;
			return _exhaustive;
		}
	}
}

export function projectRelayEvents(
	model: RelayReadModel,
	events: readonly RelayEvent[],
): RelayReadModel {
	return events.reduce(projectRelayEvent, model);
}
