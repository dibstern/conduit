import type { Logger } from "../logger.js";
import type { RelayMessage } from "../shared-types.js";
import type { MonitoringEffect } from "./monitoring-types.js";

export interface EffectDeps {
	startPoller: (sessionId: string) => void;
	stopPoller: (sessionId: string) => void;
	emitDone: (sessionId: string) => void;
	sendStatusToSession: (sessionId: string, msg: RelayMessage) => void;
	processAndApplyDone: (sessionId: string, isSubagent: boolean) => void;
	sendPush: (msg: RelayMessage) => void;
	broadcastNotification: (payload: RelayMessage) => void;
	clearProcessingTimeout: (sessionId: string) => void;
	clearMessageActivity: (sessionId: string) => void;
	log: Pick<Logger, "info" | "warn" | "error">;
}

export function executeEffects(
	effects: readonly MonitoringEffect[],
	deps: EffectDeps,
): void {
	for (const effect of effects) {
		switch (effect.effect) {
			case "start-poller":
				deps.startPoller(effect.sessionId);
				break;

			case "stop-poller":
				deps.emitDone(effect.sessionId);
				deps.stopPoller(effect.sessionId);
				deps.clearProcessingTimeout(effect.sessionId);
				deps.clearMessageActivity(effect.sessionId);
				break;

			case "notify-busy":
				deps.sendStatusToSession(effect.sessionId, {
					type: "status",
					status: "processing",
				} as RelayMessage);
				break;

			case "notify-idle":
				deps.processAndApplyDone(effect.sessionId, effect.isSubagent);
				break;

			default: {
				const _exhaustive: never = effect;
				deps.log.warn(`Unknown effect: ${JSON.stringify(_exhaustive)}`);
			}
		}
	}
}
