// ─── Instance Management Handlers ────────────────────────────────────────────
// Handle instance_add, instance_remove, instance_start, instance_stop messages
// from browser clients. Delegates to InstanceManager via Effect Tags and
// broadcasts updated instance_list to all connected clients after mutations.

import { Effect } from "effect";
import {
	InstanceMgmtTag,
	ProjectMgmtTag,
	ScanDepsTag,
	WebSocketHandlerTag,
} from "../effect/services.js";
import { formatErrorDetail } from "../errors.js";
import type { PayloadMap } from "./payloads.js";

/** Default port for CCS (Claude Code Switch) proxy. */
const CCS_DEFAULT_PORT = 8317;

/** Effect helper: send error to client. */
const sendError = (clientId: string, message: string) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		wsHandler.sendTo(clientId, {
			type: "system_error",
			code: "INSTANCE_ERROR",
			message,
		});
	});

/** Effect helper: broadcast instance list. */
const broadcastInstanceList = Effect.gen(function* () {
	const wsHandler = yield* WebSocketHandlerTag;
	const instanceMgmtOption = yield* Effect.serviceOption(InstanceMgmtTag);
	if (instanceMgmtOption._tag === "Some") {
		const instances = instanceMgmtOption.value.getInstances();
		wsHandler.broadcast({ type: "instance_list", instances });
	}
});

export const handleInstanceAdd = (
	clientId: string,
	payload: PayloadMap["instance_add"],
) =>
	Effect.gen(function* () {
		const instanceMgmtOption = yield* Effect.serviceOption(InstanceMgmtTag);
		if (instanceMgmtOption._tag === "None") {
			yield* sendError(clientId, "Instance management not available");
			return;
		}
		const instanceMgmt = instanceMgmtOption.value;

		const { name } = payload;
		if (!name) {
			yield* sendError(clientId, "Instance name is required");
			return;
		}

		// Derive ID from name
		let id =
			name
				.toLowerCase()
				.replace(/[^a-z0-9-]/g, "-")
				.replace(/-+/g, "-")
				.replace(/^-|-$/g, "") || "instance";

		// Ensure uniqueness
		{
			let counter = 2;
			const baseId = id;
			while (instanceMgmt.getInstances().some((i) => i.id === id)) {
				id = `${baseId}-${counter}`;
				counter++;
			}
		}

		const addResult = yield* Effect.either(
			Effect.try(() => {
				const hasUrl =
					typeof payload.url === "string" && payload.url.length > 0;
				const managed =
					typeof payload.managed === "boolean" ? payload.managed : !hasUrl;

				instanceMgmt.addInstance(id, {
					name,
					port: typeof payload.port === "number" ? payload.port : 0,
					managed,
					...(payload.env != null && { env: payload.env }),
					...(hasUrl && payload.url != null && { url: payload.url }),
				});
			}),
		);
		if (addResult._tag === "Left") {
			yield* sendError(clientId, formatErrorDetail(addResult.left));
			return;
		}
		yield* broadcastInstanceList;
		instanceMgmt.persistConfig();
	});

export const handleInstanceRemove = (
	clientId: string,
	payload: PayloadMap["instance_remove"],
) =>
	Effect.gen(function* () {
		const instanceMgmtOption = yield* Effect.serviceOption(InstanceMgmtTag);
		if (instanceMgmtOption._tag === "None") {
			yield* sendError(clientId, "Instance management not available");
			return;
		}
		const instanceMgmt = instanceMgmtOption.value;

		const { instanceId } = payload;
		if (!instanceId) {
			yield* sendError(clientId, "instanceId is required");
			return;
		}

		const removeResult = yield* Effect.either(
			Effect.try(() => instanceMgmt.removeInstance(instanceId)),
		);
		if (removeResult._tag === "Left") {
			yield* sendError(clientId, formatErrorDetail(removeResult.left));
			return;
		}
		yield* broadcastInstanceList;
		instanceMgmt.persistConfig();
	});

export const handleInstanceStart = (
	clientId: string,
	payload: PayloadMap["instance_start"],
) =>
	Effect.gen(function* () {
		const instanceMgmtOption = yield* Effect.serviceOption(InstanceMgmtTag);
		if (instanceMgmtOption._tag === "None") {
			yield* sendError(clientId, "Instance management not available");
			return;
		}
		const instanceMgmt = instanceMgmtOption.value;

		const { instanceId } = payload;
		if (!instanceId) {
			yield* sendError(clientId, "instanceId is required");
			return;
		}

		const startResult = yield* Effect.either(
			Effect.tryPromise(() => instanceMgmt.startInstance(instanceId)),
		);
		if (startResult._tag === "Left") {
			yield* sendError(clientId, formatErrorDetail(startResult.left));
			return;
		}
		yield* broadcastInstanceList;
	});

export const handleInstanceStop = (
	clientId: string,
	payload: PayloadMap["instance_stop"],
) =>
	Effect.gen(function* () {
		const instanceMgmtOption = yield* Effect.serviceOption(InstanceMgmtTag);
		if (instanceMgmtOption._tag === "None") {
			yield* sendError(clientId, "Instance management not available");
			return;
		}
		const instanceMgmt = instanceMgmtOption.value;

		const { instanceId } = payload;
		if (!instanceId) {
			yield* sendError(clientId, "instanceId is required");
			return;
		}

		const stopResult = yield* Effect.either(
			Effect.try(() => instanceMgmt.stopInstance(instanceId)),
		);
		if (stopResult._tag === "Left") {
			yield* sendError(clientId, formatErrorDetail(stopResult.left));
			return;
		}
		yield* broadcastInstanceList;
	});

export const handleInstanceUpdate = (
	clientId: string,
	payload: PayloadMap["instance_update"],
) =>
	Effect.gen(function* () {
		const instanceMgmtOption = yield* Effect.serviceOption(InstanceMgmtTag);
		if (instanceMgmtOption._tag === "None") {
			yield* sendError(clientId, "Instance update not supported");
			return;
		}
		const instanceMgmt = instanceMgmtOption.value;

		const { instanceId } = payload;
		if (!instanceId) {
			yield* sendError(clientId, "instanceId is required");
			return;
		}

		const updates: {
			name?: string;
			env?: Record<string, string>;
			port?: number;
		} = {};
		if (typeof payload.name === "string") updates.name = payload.name;
		if (typeof payload.port === "number") updates.port = payload.port;
		if (payload.env !== undefined) updates.env = payload.env;

		const updateResult = yield* Effect.either(
			Effect.try(() => instanceMgmt.updateInstance(instanceId, updates)),
		);
		if (updateResult._tag === "Left") {
			yield* sendError(clientId, formatErrorDetail(updateResult.left));
			return;
		}
		yield* broadcastInstanceList;
		instanceMgmt.persistConfig();
	});

export const handleInstanceRename = (
	clientId: string,
	payload: PayloadMap["instance_rename"],
) =>
	Effect.gen(function* () {
		const instanceMgmtOption = yield* Effect.serviceOption(InstanceMgmtTag);
		if (instanceMgmtOption._tag === "None") {
			yield* sendError(clientId, "Instance management not available");
			return;
		}
		const instanceMgmt = instanceMgmtOption.value;

		const { instanceId, name } = payload;
		if (!instanceId) {
			yield* sendError(clientId, "instanceId is required");
			return;
		}
		if (!name || !name.trim()) {
			yield* sendError(clientId, "name is required and cannot be empty");
			return;
		}

		const renameResult = yield* Effect.either(
			Effect.try(() =>
				instanceMgmt.updateInstance(instanceId, { name: name.trim() }),
			),
		);
		if (renameResult._tag === "Left") {
			yield* sendError(clientId, formatErrorDetail(renameResult.left));
			return;
		}
		yield* broadcastInstanceList;
		instanceMgmt.persistConfig();
	});

/** Effect helper: broadcast project list. */
const broadcastProjectList = Effect.gen(function* () {
	const wsHandler = yield* WebSocketHandlerTag;
	const projectMgmtOption = yield* Effect.serviceOption(ProjectMgmtTag);
	if (projectMgmtOption._tag === "Some") {
		const projects = projectMgmtOption.value.getProjects();
		wsHandler.broadcast({ type: "project_list", projects });
	}
});

export const handleSetProjectInstance = (
	clientId: string,
	payload: PayloadMap["set_project_instance"],
) =>
	Effect.gen(function* () {
		const projectMgmtOption = yield* Effect.serviceOption(ProjectMgmtTag);
		if (projectMgmtOption._tag === "None") {
			yield* sendError(clientId, "Project instance binding not available");
			return;
		}
		const projectMgmt = projectMgmtOption.value;

		const { slug, instanceId } = payload;
		if (!slug) {
			yield* sendError(clientId, "slug is required");
			return;
		}
		if (!instanceId) {
			yield* sendError(clientId, "instanceId is required");
			return;
		}

		const setResult = yield* Effect.either(
			Effect.tryPromise(() =>
				Promise.resolve(projectMgmt.setProjectInstance(slug, instanceId)),
			),
		);
		if (setResult._tag === "Left") {
			yield* sendError(clientId, formatErrorDetail(setResult.left));
			return;
		}
		yield* broadcastProjectList;
	});

export const handleProxyDetect = (
	clientId: string,
	_payload: PayloadMap["proxy_detect"],
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;

		let found = false;
		const fetchResult = yield* Effect.either(
			Effect.tryPromise(() =>
				fetch(`http://127.0.0.1:${CCS_DEFAULT_PORT}/health`, {
					signal: AbortSignal.timeout(3_000),
				}),
			),
		);
		if (fetchResult._tag === "Right") {
			found = fetchResult.right.ok;
		}

		wsHandler.sendTo(clientId, {
			type: "proxy_detected",
			found,
			port: CCS_DEFAULT_PORT,
		});
	});

export const handleScanNow = (
	clientId: string,
	_payload: PayloadMap["scan_now"],
) =>
	Effect.gen(function* () {
		const scanDepsOption = yield* Effect.serviceOption(ScanDepsTag);
		if (scanDepsOption._tag === "None") {
			yield* sendError(clientId, "Port scanning not available");
			return;
		}
		const scanDeps = scanDepsOption.value;

		const scanResult = yield* Effect.either(
			Effect.tryPromise(() => scanDeps.triggerScan()),
		);
		if (scanResult._tag === "Left") {
			yield* sendError(clientId, formatErrorDetail(scanResult.left));
			return;
		}
		const wsHandler = yield* WebSocketHandlerTag;
		const result = scanResult.right;
		wsHandler.sendTo(clientId, {
			type: "scan_result",
			discovered: result.discovered,
			lost: result.lost,
			active: result.active,
		});
	});
