// ─── Instance Management Handlers ────────────────────────────────────────────
// Handle instance_add, instance_remove, instance_start, instance_stop messages
// from browser clients. Delegates to InstanceManager via HandlerDeps and
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
import type { HandlerDeps } from "./types.js";

/**
 * Helper: broadcast the current instance list to all clients.
 * Called after every mutation so all browsers stay in sync.
 */
function broadcastInstanceList(deps: HandlerDeps): void {
	if (!deps.instanceMgmt) return;
	const instances = deps.instanceMgmt.getInstances();
	deps.wsHandler.broadcast({ type: "instance_list", instances });
}

/**
 * Send an error back to the requesting client.
 */
function sendError(deps: HandlerDeps, clientId: string, message: string): void {
	deps.wsHandler.sendTo(clientId, {
		type: "system_error",
		code: "INSTANCE_ERROR",
		message,
	});
}

// ─── instance_add ───────────────────────────────────────────────────────────

export async function handleInstanceAdd(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["instance_add"],
): Promise<void> {
	if (!deps.instanceMgmt) {
		sendError(deps, clientId, "Instance management not available");
		return;
	}

	const { name } = payload;
	if (!name) {
		sendError(deps, clientId, "Instance name is required");
		return;
	}

	// Derive ID from name (same logic as IPC handler in daemon-ipc.ts)
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
		while (deps.instanceMgmt.getInstances().some((i) => i.id === id)) {
			id = `${baseId}-${counter}`;
			counter++;
		}
	}

	try {
		const hasUrl = typeof payload.url === "string" && payload.url.length > 0;
		const managed =
			typeof payload.managed === "boolean" ? payload.managed : !hasUrl; // default: managed unless a URL is provided

		deps.instanceMgmt.addInstance(id, {
			name,
			port: typeof payload.port === "number" ? payload.port : 0,
			managed,
			...(payload.env != null && { env: payload.env }),
			...(hasUrl && payload.url != null && { url: payload.url }),
		});
		broadcastInstanceList(deps);
		deps.instanceMgmt.persistConfig();
	} catch (err) {
		sendError(deps, clientId, formatErrorDetail(err));
	}
}

// ─── instance_remove ────────────────────────────────────────────────────────

export async function handleInstanceRemove(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["instance_remove"],
): Promise<void> {
	if (!deps.instanceMgmt) {
		sendError(deps, clientId, "Instance management not available");
		return;
	}

	const { instanceId } = payload;
	if (!instanceId) {
		sendError(deps, clientId, "instanceId is required");
		return;
	}

	try {
		deps.instanceMgmt.removeInstance(instanceId);
		broadcastInstanceList(deps);
		deps.instanceMgmt.persistConfig();
	} catch (err) {
		sendError(deps, clientId, formatErrorDetail(err));
	}
}

// ─── instance_start ─────────────────────────────────────────────────────────

export async function handleInstanceStart(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["instance_start"],
): Promise<void> {
	if (!deps.instanceMgmt) {
		sendError(deps, clientId, "Instance management not available");
		return;
	}

	const { instanceId } = payload;
	if (!instanceId) {
		sendError(deps, clientId, "instanceId is required");
		return;
	}

	try {
		await deps.instanceMgmt.startInstance(instanceId);
		broadcastInstanceList(deps);
	} catch (err) {
		sendError(deps, clientId, formatErrorDetail(err));
	}
}

// ─── instance_stop ──────────────────────────────────────────────────────────

export async function handleInstanceStop(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["instance_stop"],
): Promise<void> {
	if (!deps.instanceMgmt) {
		sendError(deps, clientId, "Instance management not available");
		return;
	}

	const { instanceId } = payload;
	if (!instanceId) {
		sendError(deps, clientId, "instanceId is required");
		return;
	}

	try {
		deps.instanceMgmt.stopInstance(instanceId);
		broadcastInstanceList(deps);
	} catch (err) {
		sendError(deps, clientId, formatErrorDetail(err));
	}
}

// ─── instance_update ────────────────────────────────────────────────────────

export async function handleInstanceUpdate(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["instance_update"],
): Promise<void> {
	if (!deps.instanceMgmt) {
		sendError(deps, clientId, "Instance update not supported");
		return;
	}

	const { instanceId } = payload;
	if (!instanceId) {
		sendError(deps, clientId, "instanceId is required");
		return;
	}

	const updates: {
		name?: string;
		env?: Record<string, string>;
		port?: number;
	} = {};
	if (typeof payload.name === "string") updates.name = payload.name;
	if (typeof payload.port === "number") updates.port = payload.port;
	if (payload.env !== undefined) {
		updates.env = payload.env;
	}

	try {
		deps.instanceMgmt.updateInstance(instanceId, updates);
		broadcastInstanceList(deps);
		deps.instanceMgmt.persistConfig();
	} catch (err) {
		sendError(deps, clientId, formatErrorDetail(err));
	}
}

// ─── instance_rename ────────────────────────────────────────────────────────

export async function handleInstanceRename(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["instance_rename"],
): Promise<void> {
	if (!deps.instanceMgmt) {
		sendError(deps, clientId, "Instance management not available");
		return;
	}

	const { instanceId, name } = payload;
	if (!instanceId) {
		sendError(deps, clientId, "instanceId is required");
		return;
	}
	if (!name || !name.trim()) {
		sendError(deps, clientId, "name is required and cannot be empty");
		return;
	}

	try {
		deps.instanceMgmt.updateInstance(instanceId, { name: name.trim() });
		broadcastInstanceList(deps);
		deps.instanceMgmt.persistConfig();
	} catch (err) {
		sendError(deps, clientId, formatErrorDetail(err));
	}
}

// ─── set_project_instance ───────────────────────────────────────────────────

/**
 * Helper: broadcast the current project list to all clients.
 * Called after project-instance binding changes so all browsers stay in sync.
 */
function broadcastProjectList(deps: HandlerDeps): void {
	if (!deps.projectMgmt) return;
	const projects = deps.projectMgmt.getProjects();
	deps.wsHandler.broadcast({ type: "project_list", projects });
}

export async function handleSetProjectInstance(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["set_project_instance"],
): Promise<void> {
	if (!deps.projectMgmt) {
		sendError(deps, clientId, "Project instance binding not available");
		return;
	}

	const { slug, instanceId } = payload;
	if (!slug) {
		sendError(deps, clientId, "slug is required");
		return;
	}
	if (!instanceId) {
		sendError(deps, clientId, "instanceId is required");
		return;
	}

	try {
		await deps.projectMgmt.setProjectInstance(slug, instanceId);
		broadcastProjectList(deps);
	} catch (err) {
		sendError(deps, clientId, formatErrorDetail(err));
	}
}

// ─── proxy_detect ───────────────────────────────────────────────────────────

/** Default port for CCS (Claude Code Switch) proxy. */
const CCS_DEFAULT_PORT = 8317;

export async function handleProxyDetect(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["proxy_detect"],
): Promise<void> {
	let found = false;
	try {
		const res = await fetch(`http://127.0.0.1:${CCS_DEFAULT_PORT}/health`, {
			signal: AbortSignal.timeout(3_000),
		});
		found = res.ok; // Only treat 2xx responses as CCS detected
	} catch {
		// Not reachable
	}
	deps.wsHandler.sendTo(clientId, {
		type: "proxy_detected",
		found,
		port: CCS_DEFAULT_PORT,
	});
}

// ─── scan_now ───────────────────────────────────────────────────────────────

export async function handleScanNow(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["scan_now"],
): Promise<void> {
	if (!deps.scanDeps) {
		sendError(deps, clientId, "Port scanning not available");
		return;
	}

	try {
		const result = await deps.scanDeps.triggerScan();
		deps.wsHandler.sendTo(clientId, {
			type: "scan_result",
			discovered: result.discovered,
			lost: result.lost,
			active: result.active,
		});
	} catch (err) {
		sendError(deps, clientId, formatErrorDetail(err));
	}
}

// ─── Effect-based handler implementations ──────────────────────────────────
// These will replace the above functions once the dispatch table is rewired
// in Task 5.3. Until then they coexist alongside the original handlers.

/** Effect helper: send error to client. */
const sendErrorEffect = (clientId: string, message: string) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		wsHandler.sendTo(clientId, {
			type: "system_error",
			code: "INSTANCE_ERROR",
			message,
		});
	});

/** Effect helper: broadcast instance list. */
const broadcastInstanceListEffect = Effect.gen(function* () {
	const wsHandler = yield* WebSocketHandlerTag;
	const instanceMgmtOption = yield* Effect.serviceOption(InstanceMgmtTag);
	if (instanceMgmtOption._tag === "Some") {
		const instances = instanceMgmtOption.value.getInstances();
		wsHandler.broadcast({ type: "instance_list", instances });
	}
});

export const handleInstanceAddEffect = (
	clientId: string,
	payload: PayloadMap["instance_add"],
) =>
	Effect.gen(function* () {
		const instanceMgmtOption = yield* Effect.serviceOption(InstanceMgmtTag);
		if (instanceMgmtOption._tag === "None") {
			yield* sendErrorEffect(clientId, "Instance management not available");
			return;
		}
		const instanceMgmt = instanceMgmtOption.value;

		const { name } = payload;
		if (!name) {
			yield* sendErrorEffect(clientId, "Instance name is required");
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
			yield* sendErrorEffect(clientId, formatErrorDetail(addResult.left));
			return;
		}
		yield* broadcastInstanceListEffect;
		instanceMgmt.persistConfig();
	});

export const handleInstanceRemoveEffect = (
	clientId: string,
	payload: PayloadMap["instance_remove"],
) =>
	Effect.gen(function* () {
		const instanceMgmtOption = yield* Effect.serviceOption(InstanceMgmtTag);
		if (instanceMgmtOption._tag === "None") {
			yield* sendErrorEffect(clientId, "Instance management not available");
			return;
		}
		const instanceMgmt = instanceMgmtOption.value;

		const { instanceId } = payload;
		if (!instanceId) {
			yield* sendErrorEffect(clientId, "instanceId is required");
			return;
		}

		const removeResult = yield* Effect.either(
			Effect.try(() => instanceMgmt.removeInstance(instanceId)),
		);
		if (removeResult._tag === "Left") {
			yield* sendErrorEffect(clientId, formatErrorDetail(removeResult.left));
			return;
		}
		yield* broadcastInstanceListEffect;
		instanceMgmt.persistConfig();
	});

export const handleInstanceStartEffect = (
	clientId: string,
	payload: PayloadMap["instance_start"],
) =>
	Effect.gen(function* () {
		const instanceMgmtOption = yield* Effect.serviceOption(InstanceMgmtTag);
		if (instanceMgmtOption._tag === "None") {
			yield* sendErrorEffect(clientId, "Instance management not available");
			return;
		}
		const instanceMgmt = instanceMgmtOption.value;

		const { instanceId } = payload;
		if (!instanceId) {
			yield* sendErrorEffect(clientId, "instanceId is required");
			return;
		}

		const startResult = yield* Effect.either(
			Effect.tryPromise(() => instanceMgmt.startInstance(instanceId)),
		);
		if (startResult._tag === "Left") {
			yield* sendErrorEffect(clientId, formatErrorDetail(startResult.left));
			return;
		}
		yield* broadcastInstanceListEffect;
	});

export const handleInstanceStopEffect = (
	clientId: string,
	payload: PayloadMap["instance_stop"],
) =>
	Effect.gen(function* () {
		const instanceMgmtOption = yield* Effect.serviceOption(InstanceMgmtTag);
		if (instanceMgmtOption._tag === "None") {
			yield* sendErrorEffect(clientId, "Instance management not available");
			return;
		}
		const instanceMgmt = instanceMgmtOption.value;

		const { instanceId } = payload;
		if (!instanceId) {
			yield* sendErrorEffect(clientId, "instanceId is required");
			return;
		}

		const stopResult = yield* Effect.either(
			Effect.try(() => instanceMgmt.stopInstance(instanceId)),
		);
		if (stopResult._tag === "Left") {
			yield* sendErrorEffect(clientId, formatErrorDetail(stopResult.left));
			return;
		}
		yield* broadcastInstanceListEffect;
	});

export const handleInstanceUpdateEffect = (
	clientId: string,
	payload: PayloadMap["instance_update"],
) =>
	Effect.gen(function* () {
		const instanceMgmtOption = yield* Effect.serviceOption(InstanceMgmtTag);
		if (instanceMgmtOption._tag === "None") {
			yield* sendErrorEffect(clientId, "Instance update not supported");
			return;
		}
		const instanceMgmt = instanceMgmtOption.value;

		const { instanceId } = payload;
		if (!instanceId) {
			yield* sendErrorEffect(clientId, "instanceId is required");
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
			yield* sendErrorEffect(clientId, formatErrorDetail(updateResult.left));
			return;
		}
		yield* broadcastInstanceListEffect;
		instanceMgmt.persistConfig();
	});

export const handleInstanceRenameEffect = (
	clientId: string,
	payload: PayloadMap["instance_rename"],
) =>
	Effect.gen(function* () {
		const instanceMgmtOption = yield* Effect.serviceOption(InstanceMgmtTag);
		if (instanceMgmtOption._tag === "None") {
			yield* sendErrorEffect(clientId, "Instance management not available");
			return;
		}
		const instanceMgmt = instanceMgmtOption.value;

		const { instanceId, name } = payload;
		if (!instanceId) {
			yield* sendErrorEffect(clientId, "instanceId is required");
			return;
		}
		if (!name || !name.trim()) {
			yield* sendErrorEffect(clientId, "name is required and cannot be empty");
			return;
		}

		const renameResult = yield* Effect.either(
			Effect.try(() =>
				instanceMgmt.updateInstance(instanceId, { name: name.trim() }),
			),
		);
		if (renameResult._tag === "Left") {
			yield* sendErrorEffect(clientId, formatErrorDetail(renameResult.left));
			return;
		}
		yield* broadcastInstanceListEffect;
		instanceMgmt.persistConfig();
	});

/** Effect helper: broadcast project list. */
const broadcastProjectListEffect = Effect.gen(function* () {
	const wsHandler = yield* WebSocketHandlerTag;
	const projectMgmtOption = yield* Effect.serviceOption(ProjectMgmtTag);
	if (projectMgmtOption._tag === "Some") {
		const projects = projectMgmtOption.value.getProjects();
		wsHandler.broadcast({ type: "project_list", projects });
	}
});

export const handleSetProjectInstanceEffect = (
	clientId: string,
	payload: PayloadMap["set_project_instance"],
) =>
	Effect.gen(function* () {
		const projectMgmtOption = yield* Effect.serviceOption(ProjectMgmtTag);
		if (projectMgmtOption._tag === "None") {
			yield* sendErrorEffect(
				clientId,
				"Project instance binding not available",
			);
			return;
		}
		const projectMgmt = projectMgmtOption.value;

		const { slug, instanceId } = payload;
		if (!slug) {
			yield* sendErrorEffect(clientId, "slug is required");
			return;
		}
		if (!instanceId) {
			yield* sendErrorEffect(clientId, "instanceId is required");
			return;
		}

		const setResult = yield* Effect.either(
			Effect.tryPromise(() =>
				Promise.resolve(projectMgmt.setProjectInstance(slug, instanceId)),
			),
		);
		if (setResult._tag === "Left") {
			yield* sendErrorEffect(clientId, formatErrorDetail(setResult.left));
			return;
		}
		yield* broadcastProjectListEffect;
	});

export const handleProxyDetectEffect = (
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

export const handleScanNowEffect = (
	clientId: string,
	_payload: PayloadMap["scan_now"],
) =>
	Effect.gen(function* () {
		const scanDepsOption = yield* Effect.serviceOption(ScanDepsTag);
		if (scanDepsOption._tag === "None") {
			yield* sendErrorEffect(clientId, "Port scanning not available");
			return;
		}
		const scanDeps = scanDepsOption.value;

		const scanResult = yield* Effect.either(
			Effect.tryPromise(() => scanDeps.triggerScan()),
		);
		if (scanResult._tag === "Left") {
			yield* sendErrorEffect(clientId, formatErrorDetail(scanResult.left));
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
