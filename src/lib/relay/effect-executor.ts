import type { Logger } from "../logger.js";
import type { MonitoringEffect } from "./monitoring-types.js";

export interface EffectDeps {
	startPoller: (sessionId: string) => void;
	stopPoller: (sessionId: string) => void;
	processAndApplyDone: (
		sessionId: string,
		isSubagent: boolean,
		busySince: number,
	) => void;
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
				deps.stopPoller(effect.sessionId);
				deps.clearProcessingTimeout(effect.sessionId);
				deps.clearMessageActivity(effect.sessionId);
				break;

			case "clear-processing":
			case "notify-idle":
				if (effect.effect === "notify-idle") {
					deps.processAndApplyDone(
						effect.sessionId,
						effect.isSubagent,
						effect.busySince,
					);
				}
				deps.clearProcessingTimeout(effect.sessionId);
				deps.clearMessageActivity(effect.sessionId);
				break;

			default: {
				const _exhaustive: never = effect;
				deps.log.warn(`Unknown effect: ${JSON.stringify(_exhaustive)}`);
			}
		}
	}
}
