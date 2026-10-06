// The attached project's settings and live facts (browser count, OpenCode
// upstream state), fed by its SubscribeProjectSettings stream.
// Each fact lands in the store that already owns it, so a change made in
// another tab, or by the CLI, shows here with no refetch.

import { Effect, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import type { ProjectSetting } from "../transport/ws-rpc.js";
import { handleClaudeSettingsInfo } from "./claude-settings.svelte.js";
import {
	applyDefaultPermissionMode,
	handleDefaultModelInfo,
	handleModelInfo,
	handleVisibilityInfo,
} from "./discovery.svelte.js";
import { sessionState } from "./session.svelte.js";
import { setClientCount, uiState } from "./ui.svelte.js";

export const applyProjectSetting = (setting: ProjectSetting): void => {
	switch (setting._tag) {
		case "defaultModel":
			handleDefaultModelInfo(setting);
			// A draft has no session model of its own, so it shows the default.
			if (!sessionState.currentId && setting.model && setting.provider)
				handleModelInfo({ model: setting.model, provider: setting.provider });
			break;
		case "visibility":
			handleVisibilityInfo(setting);
			break;
		case "defaultPermissionMode":
			applyDefaultPermissionMode(setting.mode);
			break;
		case "claudeSettings":
			handleClaudeSettingsInfo(setting);
			break;
		case "clientCount":
			setClientCount(setting.count);
			break;
		case "opencodeConnection":
			uiState.opencodeConnectionStatus = setting.status;
			break;
	}
};

let viewed: string | null = null;
let generation = 0;
let fiber: RuntimeFiber<void, never> | null = null;

/** Follow `project`'s settings until the attached project moves; `null` stops. */
export function viewProjectSettings(project: string | null): void {
	if (viewed === project) return;
	viewed = project;
	const currentGeneration = ++generation;
	const old = fiber;
	fiber = null;
	void (old ? runTransportEffect(Fiber.interrupt(old)) : Promise.resolve())
		.catch(() => undefined)
		.then(async () => {
			if (currentGeneration !== generation || !project) return;
			const runtime = await getRuntime();
			if (currentGeneration !== generation) return;
			const next = runtime.runFork(
				Effect.flatMap(WsRpcClients, (clients) =>
					Effect.flatMap(clients.forProject(project), ({ subscriptions }) =>
						Stream.runForEach(
							supervise(
								Stream.suspend(() => subscriptions.projectSettings()),
								() => undefined,
							),
							(envelope) =>
								Effect.sync(() => {
									if (currentGeneration !== generation) return;
									if (envelope._tag === "snapshot")
										envelope.rows.forEach(applyProjectSetting);
									if (envelope._tag === "upsert")
										applyProjectSetting(envelope.item);
								}),
						),
					),
				),
			);
			if (currentGeneration === generation) fiber = next;
			else runtime.runFork(Fiber.interrupt(next));
		});
}
