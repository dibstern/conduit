// ─── IPC Dispatch ────────────────────────────────────────────────────────────
// Schema-driven dispatch system that decodes raw JSON lines and routes to
// the appropriate Effect-returning IPC handler.

import type { Socket } from "node:net";
import { Effect, Schema, Stream } from "effect";
import {
	IPCCommandSchema,
	serializeResponse,
} from "../../../daemon/ipc-protocol.js";
import type { IPCResponse } from "../../../types.js";
import type { OverridesStateTag } from "../../relay/Services/session-overrides-state.js";
import type { ShutdownSignalTag } from "../Layers/daemon-layers.js";
import type { KeepAwakeTag } from "../Layers/keep-awake-layer.js";
import type { ConfigPersistenceTag } from "./config-persistence-service.js";
import type { DaemonConfigRefTag } from "./daemon-config-ref.js";
import type { DaemonStateTag } from "./daemon-state.js";
import {
	handleAddProject,
	handleGetStatus,
	handleInstanceAdd,
	handleInstanceList,
	handleInstanceRemove,
	handleInstanceStart,
	handleInstanceStatus,
	handleInstanceStop,
	handleInstanceUpdate,
	handleListProjects,
	handleRemoveProject,
	handleRestartWithConfig,
	handleSetAgent,
	handleSetKeepAwake,
	handleSetKeepAwakeCommand,
	handleSetModel,
	handleSetPin,
	handleSetProjectTitle,
	handleShutdown,
} from "./ipc-handlers.js";
import type { InstanceMgmtTag, ProjectMgmtTag } from "./management-service.js";

// ─── Dependency type ─────────────────────────────────────────────────────────

/** Union of all Tags needed by all IPC handlers. */
export type IpcHandlerDeps =
	| DaemonStateTag
	| DaemonConfigRefTag
	| ConfigPersistenceTag
	| InstanceMgmtTag
	| ProjectMgmtTag
	| OverridesStateTag
	| KeepAwakeTag
	| ShutdownSignalTag;

// ─── Decode + Dispatch ───────────────────────────────────────────────────────

const decode = Schema.decodeUnknown(IPCCommandSchema);

/**
 * Parse a raw JSON string, decode via IPCCommandSchema, and dispatch
 * to the appropriate handler. All errors are caught at the boundary
 * and converted to `{ ok: false, error: ... }`.
 */
export const decodeAndDispatch = (
	raw: string,
): Effect.Effect<IPCResponse, never, IpcHandlerDeps> =>
	Effect.gen(function* () {
		// Step 1: JSON.parse
		const parsed = yield* Effect.try(() => JSON.parse(raw) as unknown);

		// Step 2: Decode via Schema
		const command = yield* decode(parsed);

		// Step 3: Dispatch based on cmd discriminant
		const response: IPCResponse = yield* dispatch(command);

		return response;
	}).pipe(
		Effect.withSpan("ipc.dispatch"),
		Effect.catchAll((e) =>
			Effect.succeed({
				ok: false as const,
				error: String(e),
			}),
		),
	);

/**
 * Dispatch a decoded command to the right handler.
 * Exhaustive switch ensures every `cmd` is covered.
 */
const dispatch = (
	command: Schema.Schema.Type<typeof IPCCommandSchema>,
): Effect.Effect<IPCResponse, never, IpcHandlerDeps> => {
	switch (command.cmd) {
		case "add_project":
			return handleAddProject(command);
		case "remove_project":
			return handleRemoveProject(command);
		case "list_projects":
			return handleListProjects(command);
		case "set_project_title":
			return handleSetProjectTitle(command);
		case "get_status":
			return handleGetStatus(command);
		case "set_pin":
			return handleSetPin(command);
		case "set_keep_awake":
			return handleSetKeepAwake(command);
		case "set_keep_awake_command":
			return handleSetKeepAwakeCommand(command);
		case "shutdown":
			return handleShutdown(command);
		case "set_agent":
			return handleSetAgent(command);
		case "set_model":
			return handleSetModel(command);
		case "restart_with_config":
			return handleRestartWithConfig(command);
		case "instance_list":
			return handleInstanceList(command);
		case "instance_add":
			return handleInstanceAdd(command);
		case "instance_remove":
			return handleInstanceRemove(command);
		case "instance_start":
			return handleInstanceStart(command);
		case "instance_stop":
			return handleInstanceStop(command);
		case "instance_update":
			return handleInstanceUpdate(command);
		case "instance_status":
			return handleInstanceStatus(command);
	}
};

// ─── Stream-based connection handler ─────────────────────────────────────────

/**
 * Stream-based IPC connection handler for a Node.js net.Socket.
 *
 * Reads newline-delimited JSON messages from the socket, decodes and
 * dispatches each one, and writes the response back. Connection-level
 * errors are caught and the stream terminates cleanly.
 */
export const ipcConnectionStream = (
	socket: Socket,
): Stream.Stream<void, never, IpcHandlerDeps> => {
	// Read newline-delimited messages from the socket
	const messageStream = Stream.async<string, Error>((emit) => {
		let buffer = "";

		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			// Keep the last (potentially incomplete) segment in the buffer
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed.length > 0) {
					emit.single(trimmed);
				}
			}
		});

		socket.on("end", () => {
			// Process any remaining buffer content
			const trimmed = buffer.trim();
			if (trimmed.length > 0) {
				emit.single(trimmed);
			}
			emit.end();
		});

		socket.on("error", (err) => {
			emit.fail(err);
		});
	});

	return messageStream.pipe(
		// Decode and dispatch each line
		Stream.mapEffect((line) =>
			Effect.gen(function* () {
				const response = yield* decodeAndDispatch(line);
				// Write response back to socket
				const serialized = serializeResponse(response);
				yield* Effect.async<void, Error>((resume) => {
					socket.write(serialized, (err) => {
						if (err) {
							resume(Effect.fail(err));
						} else {
							resume(Effect.void);
						}
					});
				});
			}),
		),
		// Catch connection-level errors
		Stream.catchAll(() => Stream.empty),
	);
};
