// ─── Instance Management Handlers ────────────────────────────────────────────
// Handle instance_add, instance_remove, instance_start, instance_stop messages
// from browser clients. Delegates to InstanceManager via Effect Tags and
// broadcasts updated instance_list to all connected clients after mutations.

import { Effect } from "effect";
import { InstanceManagementServiceTag } from "../effect/instance-management-service.js";
import { ProjectManagementServiceTag } from "../effect/project-management-service.js";
import { ScanServiceTag } from "../effect/scan-service.js";
import { WebSocketHandlerTag } from "../effect/services.js";
import { formatErrorDetail } from "../errors.js";
import type { OpenCodeInstance, ProjectInfo } from "../shared-types.js";
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

const broadcastInstanceList = (
	instances: ReadonlyArray<Readonly<OpenCodeInstance>>,
) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		wsHandler.broadcast({ type: "instance_list", instances });
	});

export const handleInstanceAdd = (
	clientId: string,
	payload: PayloadMap["instance_add"],
) =>
	Effect.gen(function* () {
		const serviceOption = yield* Effect.serviceOption(
			InstanceManagementServiceTag,
		);
		if (serviceOption._tag === "None") {
			yield* sendError(clientId, "Instance management not available");
			return;
		}
		const { name } = payload;
		if (!name) {
			yield* sendError(clientId, "Instance name is required");
			return;
		}

		const addResult = yield* Effect.either(serviceOption.value.add(payload));
		if (addResult._tag === "Left") {
			yield* sendError(clientId, formatErrorDetail(addResult.left.cause));
			return;
		}
		yield* broadcastInstanceList(addResult.right);
	});

export const handleInstanceRemove = (
	clientId: string,
	payload: PayloadMap["instance_remove"],
) =>
	Effect.gen(function* () {
		const serviceOption = yield* Effect.serviceOption(
			InstanceManagementServiceTag,
		);
		if (serviceOption._tag === "None") {
			yield* sendError(clientId, "Instance management not available");
			return;
		}
		const { instanceId } = payload;
		if (!instanceId) {
			yield* sendError(clientId, "instanceId is required");
			return;
		}

		const removeResult = yield* Effect.either(
			serviceOption.value.remove(instanceId),
		);
		if (removeResult._tag === "Left") {
			yield* sendError(clientId, formatErrorDetail(removeResult.left.cause));
			return;
		}
		yield* broadcastInstanceList(removeResult.right);
	});

export const handleInstanceStart = (
	clientId: string,
	payload: PayloadMap["instance_start"],
) =>
	Effect.gen(function* () {
		const serviceOption = yield* Effect.serviceOption(
			InstanceManagementServiceTag,
		);
		if (serviceOption._tag === "None") {
			yield* sendError(clientId, "Instance management not available");
			return;
		}
		const { instanceId } = payload;
		if (!instanceId) {
			yield* sendError(clientId, "instanceId is required");
			return;
		}

		const startResult = yield* Effect.either(
			serviceOption.value.start(instanceId),
		);
		if (startResult._tag === "Left") {
			yield* sendError(clientId, formatErrorDetail(startResult.left.cause));
			return;
		}
		yield* broadcastInstanceList(startResult.right);
	});

export const handleInstanceStop = (
	clientId: string,
	payload: PayloadMap["instance_stop"],
) =>
	Effect.gen(function* () {
		const serviceOption = yield* Effect.serviceOption(
			InstanceManagementServiceTag,
		);
		if (serviceOption._tag === "None") {
			yield* sendError(clientId, "Instance management not available");
			return;
		}
		const { instanceId } = payload;
		if (!instanceId) {
			yield* sendError(clientId, "instanceId is required");
			return;
		}

		const stopResult = yield* Effect.either(
			serviceOption.value.stop(instanceId),
		);
		if (stopResult._tag === "Left") {
			yield* sendError(clientId, formatErrorDetail(stopResult.left.cause));
			return;
		}
		yield* broadcastInstanceList(stopResult.right);
	});

export const handleInstanceUpdate = (
	clientId: string,
	payload: PayloadMap["instance_update"],
) =>
	Effect.gen(function* () {
		const serviceOption = yield* Effect.serviceOption(
			InstanceManagementServiceTag,
		);
		if (serviceOption._tag === "None") {
			yield* sendError(clientId, "Instance update not supported");
			return;
		}
		const { instanceId } = payload;
		if (!instanceId) {
			yield* sendError(clientId, "instanceId is required");
			return;
		}

		const updateResult = yield* Effect.either(
			serviceOption.value.update(instanceId, payload),
		);
		if (updateResult._tag === "Left") {
			yield* sendError(clientId, formatErrorDetail(updateResult.left.cause));
			return;
		}
		yield* broadcastInstanceList(updateResult.right);
	});

export const handleInstanceRename = (
	clientId: string,
	payload: PayloadMap["instance_rename"],
) =>
	Effect.gen(function* () {
		const serviceOption = yield* Effect.serviceOption(
			InstanceManagementServiceTag,
		);
		if (serviceOption._tag === "None") {
			yield* sendError(clientId, "Instance management not available");
			return;
		}
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
			serviceOption.value.rename(instanceId, name),
		);
		if (renameResult._tag === "Left") {
			yield* sendError(clientId, formatErrorDetail(renameResult.left.cause));
			return;
		}
		yield* broadcastInstanceList(renameResult.right);
	});

/** Effect helper: broadcast project list. */
const broadcastProjectList = (projects: ReadonlyArray<ProjectInfo>) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		wsHandler.broadcast({ type: "project_list", projects });
	});

export const handleSetProjectInstance = (
	clientId: string,
	payload: PayloadMap["set_project_instance"],
) =>
	Effect.gen(function* () {
		const projectServiceOption = yield* Effect.serviceOption(
			ProjectManagementServiceTag,
		);
		if (projectServiceOption._tag === "None") {
			yield* sendError(clientId, "Project instance binding not available");
			return;
		}
		const projectService = projectServiceOption.value;

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
			projectService.setProjectInstance(slug, instanceId),
		);
		if (setResult._tag === "Left") {
			yield* sendError(
				clientId,
				setResult.left._tag === "ProjectManagementNotSupported"
					? setResult.left.message
					: formatErrorDetail(setResult.left.cause),
			);
			return;
		}
		yield* broadcastProjectList(setResult.right);
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
		const scanServiceOption = yield* Effect.serviceOption(ScanServiceTag);
		if (scanServiceOption._tag === "None") {
			yield* sendError(clientId, "Port scanning not available");
			return;
		}

		const scanResult = yield* Effect.either(scanServiceOption.value.scanNow());
		if (scanResult._tag === "Left") {
			yield* sendError(
				clientId,
				scanResult.left._tag === "ScanServiceNotAvailable"
					? scanResult.left.message
					: formatErrorDetail(scanResult.left.cause),
			);
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
