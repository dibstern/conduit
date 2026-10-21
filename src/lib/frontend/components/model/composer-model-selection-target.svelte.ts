import {
	contextWindow,
	effort,
	model,
} from "../../stores/composer-settings.svelte.js";
import {
	discoveryState,
	draftModelInventory,
	getActiveModel,
	getAvailableInstances,
	getEffectiveInstanceId,
	getProviderGroupsForInstance,
	getSessionDriver,
	getSessionPick,
	selectInstance,
} from "../../stores/discovery.svelte.js";
import { findSession, sessionState } from "../../stores/session.svelte.js";
import type { ModelSelectionTarget } from "./model-selection-target.js";

/** Borrows the composer's inventory; other targets own their own subscription. */
export const composerModelSelectionTarget: ModelSelectionTarget = {
	get pick() {
		const sessionId = sessionState.currentId;
		const account = sessionId
			? (findSession(sessionId)?.accountId ?? undefined)
			: getEffectiveInstanceId();
		return {
			account,
			driver: sessionId
				? this.loading
					? undefined
					: getSessionDriver(sessionId)
				: (this.accounts.find((instance) => instance.id === account)?.driver ??
					discoveryState.currentDriver),
			providerId: discoveryState.currentProviderId,
			modelId: discoveryState.currentModelId,
			effort: effort.current,
			contextWindow: contextWindow.current,
		};
	},
	get accounts() {
		return getAvailableInstances();
	},
	get catalog() {
		return getProviderGroupsForInstance(this.pick.account);
	},
	get activeModel() {
		return getActiveModel();
	},
	get inventory() {
		const selected =
			!sessionState.currentId &&
			draftModelInventory.instanceId === this.pick.account;
		return {
			loading: !!selected && draftModelInventory.loading,
			error: selected ? draftModelInventory.error : null,
		};
	},
	get loading() {
		return (
			!!sessionState.currentId &&
			getSessionPick(sessionState.currentId) === undefined
		);
	},
	get effortOptions() {
		return effort.options;
	},
	get contextWindowOptions() {
		return contextWindow.options;
	},
	get pending() {
		return {
			model: model.pending,
			effort: effort.pending,
			contextWindow: contextWindow.pending,
		};
	},
	selectAccount: selectInstance,
	selectModel: model.select,
	selectEffort: effort.select,
	selectContextWindow: contextWindow.select,
};
