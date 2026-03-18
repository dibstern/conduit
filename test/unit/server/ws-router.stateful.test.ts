// ─── State-Machine Model Test: WebSocket Message Router (Ticket 2.2) ─────────
//
// Uses fc.commands() + fc.modelRun() to exercise arbitrary interleavings of:
//   - AddClient (new WS connection)
//   - RemoveClient (WS disconnect)
//   - DuplicateAdd (re-add existing client — idempotent)
//   - GetBroadcastTargets (with and without exclusion)
//   - RouteValidMessage (parse + route a known message type)
//   - RouteInvalidMessage (parse + route an unknown type)
//
// Model: Set<string> for connected client IDs
// Invariants verified after each command:
//   - Real tracker count matches model set size
//   - Real tracker membership matches model membership
//   - Broadcast targets always exclude the sender

import fc from "fast-check";
import { describe, it } from "vitest";
import {
	type ClientTracker,
	createClientCountMessage,
	createClientTracker,
	type IncomingMessageType,
	isRouteError,
	parseIncomingMessage,
	routeMessage,
} from "../../../src/lib/server/ws-router.js";

const SEED = 42;
const NUM_RUNS = 100;

// ─── Model ──────────────────────────────────────────────────────────────────

interface ModelState {
	clients: Set<string>;
}

interface RealState {
	tracker: ClientTracker;
}

// ─── Commands ───────────────────────────────────────────────────────────────

class AddClientCommand implements fc.Command<ModelState, RealState> {
	constructor(readonly clientId: string) {}

	check(model: Readonly<ModelState>): boolean {
		// Only add truly new clients for this command
		return !model.clients.has(this.clientId) && this.clientId.length > 0;
	}

	run(model: ModelState, real: RealState): void {
		model.clients.add(this.clientId);
		const count = real.tracker.addClient(this.clientId);

		// Count should match model
		if (count !== model.clients.size) {
			throw new Error(
				`addClient count mismatch: model=${model.clients.size}, real=${count}`,
			);
		}

		// Tracker should report the client
		if (!real.tracker.hasClient(this.clientId)) {
			throw new Error(`Client "${this.clientId}" not found after add`);
		}

		this.assertInvariant(model, real);
	}

	private assertInvariant(model: ModelState, real: RealState): void {
		if (real.tracker.getClientCount() !== model.clients.size) {
			throw new Error(
				`Count invariant: model=${model.clients.size}, real=${real.tracker.getClientCount()}`,
			);
		}
	}

	toString(): string {
		return `AddClient(${this.clientId})`;
	}
}

class RemoveClientCommand implements fc.Command<ModelState, RealState> {
	constructor(readonly clientId: string) {}

	check(model: Readonly<ModelState>): boolean {
		// Only remove existing clients
		return model.clients.has(this.clientId);
	}

	run(model: ModelState, real: RealState): void {
		model.clients.delete(this.clientId);
		const count = real.tracker.removeClient(this.clientId);

		if (count !== model.clients.size) {
			throw new Error(
				`removeClient count mismatch: model=${model.clients.size}, real=${count}`,
			);
		}

		if (real.tracker.hasClient(this.clientId)) {
			throw new Error(`Client "${this.clientId}" still found after remove`);
		}

		if (real.tracker.getClientCount() !== model.clients.size) {
			throw new Error(
				`Count invariant after remove: model=${model.clients.size}, real=${real.tracker.getClientCount()}`,
			);
		}
	}

	toString(): string {
		return `RemoveClient(${this.clientId})`;
	}
}

class RemoveNonExistentCommand implements fc.Command<ModelState, RealState> {
	constructor(readonly clientId: string) {}

	check(model: Readonly<ModelState>): boolean {
		// Only run when client doesn't exist
		return !model.clients.has(this.clientId);
	}

	run(model: ModelState, real: RealState): void {
		const countBefore = real.tracker.getClientCount();
		real.tracker.removeClient(this.clientId);
		const countAfter = real.tracker.getClientCount();

		if (countAfter !== countBefore) {
			throw new Error(
				`Removing non-existent client changed count: ${countBefore} → ${countAfter}`,
			);
		}

		if (real.tracker.getClientCount() !== model.clients.size) {
			throw new Error(
				`Count invariant after remove non-existent: model=${model.clients.size}, real=${real.tracker.getClientCount()}`,
			);
		}
	}

	toString(): string {
		return `RemoveNonExistent(${this.clientId})`;
	}
}

class DuplicateAddCommand implements fc.Command<ModelState, RealState> {
	constructor(readonly clientId: string) {}

	check(model: Readonly<ModelState>): boolean {
		// Only re-add existing clients
		return model.clients.has(this.clientId);
	}

	run(model: ModelState, real: RealState): void {
		// Model: set is unchanged (already has it)
		const countBefore = model.clients.size;
		real.tracker.addClient(this.clientId);

		// Count should not change
		if (real.tracker.getClientCount() !== countBefore) {
			throw new Error(
				`Duplicate add changed count: expected ${countBefore}, got ${real.tracker.getClientCount()}`,
			);
		}

		if (real.tracker.getClientCount() !== model.clients.size) {
			throw new Error(
				`Count invariant after duplicate add: model=${model.clients.size}, real=${real.tracker.getClientCount()}`,
			);
		}
	}

	toString(): string {
		return `DuplicateAdd(${this.clientId})`;
	}
}

class BroadcastWithExclusionCommand
	implements fc.Command<ModelState, RealState>
{
	constructor(readonly excludeId: string) {}

	check(model: Readonly<ModelState>): boolean {
		return model.clients.size > 0;
	}

	run(model: ModelState, real: RealState): void {
		const targets = real.tracker.getBroadcastTargets(this.excludeId);

		// Sender must never be in targets
		if (targets.includes(this.excludeId)) {
			throw new Error(`Sender "${this.excludeId}" found in broadcast targets`);
		}

		// Expected targets: all model clients except the excluded one
		const expected = [...model.clients].filter((id) => id !== this.excludeId);
		if (targets.length !== expected.length) {
			throw new Error(
				`Broadcast target count: expected ${expected.length}, got ${targets.length}`,
			);
		}

		// Every target should be a known client
		for (const t of targets) {
			if (!model.clients.has(t)) {
				throw new Error(`Broadcast target "${t}" not in model clients`);
			}
		}
	}

	toString(): string {
		return `BroadcastExclude(${this.excludeId})`;
	}
}

class BroadcastAllCommand implements fc.Command<ModelState, RealState> {
	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		const targets = real.tracker.getBroadcastTargets();

		if (targets.length !== model.clients.size) {
			throw new Error(
				`Broadcast all count: expected ${model.clients.size}, got ${targets.length}`,
			);
		}

		for (const t of targets) {
			if (!model.clients.has(t)) {
				throw new Error(`Broadcast target "${t}" not in model clients`);
			}
		}
	}

	toString(): string {
		return "BroadcastAll()";
	}
}

class GetClientIdsCommand implements fc.Command<ModelState, RealState> {
	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		const ids = real.tracker.getClientIds();
		const idSet = new Set(ids);

		// Should match model exactly
		if (idSet.size !== model.clients.size) {
			throw new Error(
				`getClientIds size: model=${model.clients.size}, real=${idSet.size}`,
			);
		}

		for (const id of model.clients) {
			if (!idSet.has(id)) {
				throw new Error(`Model client "${id}" missing from getClientIds`);
			}
		}

		for (const id of idSet) {
			if (!model.clients.has(id)) {
				throw new Error(`Real client "${id}" not in model`);
			}
		}
	}

	toString(): string {
		return "GetClientIds()";
	}
}

class ClientCountMessageCommand implements fc.Command<ModelState, RealState> {
	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		const msg = createClientCountMessage(real.tracker.getClientCount());

		if (msg.type !== "client_count") {
			throw new Error(`Expected "client_count" message, got "${msg.type}"`);
		}

		const countMsg = msg as { type: "client_count"; count: number };
		if (countMsg.count !== model.clients.size) {
			throw new Error(
				`Client count message value: model=${model.clients.size}, message=${countMsg.count}`,
			);
		}
	}

	toString(): string {
		return "ClientCountMessage()";
	}
}

class RouteValidCommand implements fc.Command<ModelState, RealState> {
	constructor(
		readonly msgType: IncomingMessageType,
		readonly payload: Record<string, unknown>,
	) {}

	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(_model: ModelState, _real: RealState): void {
		const raw = JSON.stringify({ type: this.msgType, ...this.payload });
		const parsed = parseIncomingMessage(raw);

		if (parsed === null) {
			throw new Error(
				`parseIncomingMessage returned null for valid message type "${this.msgType}"`,
			);
		}

		const result = routeMessage(parsed);

		if (isRouteError(result)) {
			throw new Error(
				`routeMessage returned error for valid type "${this.msgType}": ${result.message}`,
			);
		}

		if (result.handler !== this.msgType) {
			throw new Error(
				`Route handler mismatch: expected "${this.msgType}", got "${result.handler}"`,
			);
		}

		// Payload should not contain 'type'
		if ("type" in result.payload) {
			throw new Error(
				`Route payload contains "type" field — should be stripped`,
			);
		}
	}

	toString(): string {
		return `RouteValid(${this.msgType})`;
	}
}

class RouteInvalidCommand implements fc.Command<ModelState, RealState> {
	constructor(readonly msgType: string) {}

	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(_model: ModelState, _real: RealState): void {
		const raw = JSON.stringify({ type: this.msgType });
		const parsed = parseIncomingMessage(raw);

		if (parsed === null) {
			throw new Error(
				`parseIncomingMessage returned null for raw JSON with type "${this.msgType}"`,
			);
		}

		const result = routeMessage(parsed);

		if (!isRouteError(result)) {
			throw new Error(
				`routeMessage did NOT return error for invalid type "${this.msgType}"`,
			);
		}

		if (result.code !== "UNKNOWN_MESSAGE_TYPE") {
			throw new Error(
				`Expected error code "UNKNOWN_MESSAGE_TYPE", got "${result.code}"`,
			);
		}
	}

	toString(): string {
		return `RouteInvalid(${this.msgType})`;
	}
}

// ─── Arbitraries ────────────────────────────────────────────────────────────

const arbClientId = fc.oneof(
	{ weight: 5, arbitrary: fc.uuid() },
	{ weight: 3, arbitrary: fc.stringMatching(/^client-[0-9]{1,5}$/) },
	{ weight: 1, arbitrary: fc.constant("admin") },
	{ weight: 1, arbitrary: fc.constant("viewer") },
);

const validMessageTypes: IncomingMessageType[] = [
	"message",
	"permission_response",
	"ask_user_response",
	"question_reject",
	"new_session",
	"switch_session",
	"delete_session",
	"rename_session",
	"fork_session",
	"list_sessions",
	"search_sessions",
	"load_more_history",
	"terminal_command",
	"input_sync",
	"switch_agent",
	"switch_model",
	"get_todo",
	"get_agents",
	"get_models",
	"get_commands",
	"get_projects",
	"add_project",
	"get_file_list",
	"get_file_content",
	"get_file_tree",
	"get_tool_content",
	"pty_create",
	"pty_input",
	"pty_resize",
	"pty_close",
	"cancel",
	"rewind",
	"instance_add",
	"instance_remove",
	"instance_start",
	"instance_stop",
	"instance_update",
	"set_project_instance",
];

const arbInvalidType = fc
	.oneof(
		{
			weight: 3,
			arbitrary: fc.constantFrom("unknown", "INVALID", "connect", "disconnect"),
		},
		{ weight: 2, arbitrary: fc.string({ minLength: 1, maxLength: 20 }) },
	)
	.filter((t) => !validMessageTypes.includes(t as IncomingMessageType));

const allCommands = fc.commands(
	[
		// Add new client
		arbClientId.map((id) => new AddClientCommand(id)),

		// Remove existing client
		arbClientId.map((id) => new RemoveClientCommand(id)),

		// Remove non-existent client (no-op)
		arbClientId.map((id) => new RemoveNonExistentCommand(id)),

		// Duplicate add (idempotent)
		arbClientId.map((id) => new DuplicateAddCommand(id)),

		// Broadcast with exclusion
		arbClientId.map((id) => new BroadcastWithExclusionCommand(id)),

		// Broadcast all
		fc.constant(new BroadcastAllCommand()),

		// Get client IDs (membership check)
		fc.constant(new GetClientIdsCommand()),

		// Client count message factory
		fc.constant(new ClientCountMessageCommand()),

		// Route valid message
		fc
			.tuple(
				fc.constantFrom(...validMessageTypes),
				fc.dictionary(
					fc.string({ minLength: 1, maxLength: 10 }),
					fc.jsonValue(),
				),
			)
			.map(([type, payload]) => new RouteValidCommand(type, payload)),

		// Route invalid message
		arbInvalidType.map((type) => new RouteInvalidCommand(type)),
	],
	{ maxCommands: 50 },
);

// ─── Test ───────────────────────────────────────────────────────────────────

describe("Ticket 2.2 — WebSocket Router State Machine PBT", () => {
	it("property: arbitrary command sequences maintain model/real client set consistency", () => {
		fc.assert(
			fc.property(allCommands, (cmds) => {
				const model: ModelState = {
					clients: new Set(),
				};

				const real: RealState = {
					tracker: createClientTracker(),
				};

				fc.modelRun(() => ({ model, real }), cmds);
			}),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});
});
