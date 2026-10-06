import { PERMISSION_MODES } from "../permission-modes.js";
import {
	getAgentsRpc,
	switchContextWindowRpc,
	switchModelRpc,
	switchPermissionModeRpc,
	switchVariantRpc,
} from "../transport/ws-rpc-client.js";
import type {
	ContextWindowOption,
	Immutable,
	SessionPermissionMode,
} from "../types.js";
import {
	applyContextWindowSwitched,
	applyGetAgentsResponse,
	applyModelSwitched,
	applyVariantSwitched,
	chooseContextWindow,
	chooseModel,
	choosePermissionMode,
	chooseVariant,
	discoveryState,
	getActiveContextWindowOptions,
	getActiveModelVariants,
	getEffectiveInstanceId,
	getProviderGroupsForInstance,
	instanceIdForProviderId,
} from "./discovery.svelte.js";
import { getCurrentSlug } from "./router.svelte.js";
import { findSession, sessionState } from "./session.svelte.js";
import { showToast } from "./ui.svelte.js";

export type ComposerSetting<T> = {
	readonly options: readonly T[];
	readonly current: T | null;
	readonly pending: boolean;
	select(value: T | null): void;
	cycle(): void;
};

export type ComposerModel = {
	readonly modelId: string;
	readonly providerId: string;
};

type ApprovalOption = (typeof PERMISSION_MODES)[number];

const APPROVAL_CYCLE_ORDER: readonly SessionPermissionMode[] = [
	"plan",
	"ask",
	"acceptEdits",
	"auto",
	"full",
	"dontAsk",
];
const APPROVAL_MENU_ORDER: readonly SessionPermissionMode[] = [
	"dontAsk",
	"plan",
	"ask",
	"acceptEdits",
	"auto",
	"full",
];

const pending = $state({ effort: 0, approvals: 0, contextWindow: 0, model: 0 });

function switchSetting(
	setting: keyof typeof pending,
	undo: () => void,
	request: () => Promise<unknown>,
	failure: string,
): void {
	pending[setting] += 1;
	void request()
		.catch((error: unknown) => {
			undo();
			const reason =
				error instanceof Error ? error.message : "the daemon rejected it.";
			showToast(`${failure}: ${reason}`, { variant: "warn" });
		})
		.finally(() => {
			pending[setting] -= 1;
		});
}

function approvalOptions(
	order: readonly SessionPermissionMode[],
): readonly ApprovalOption[] {
	const claude = discoveryState.currentProviderId === "claude";
	// OpenCode enforces Plan only on Side Threads, through session rules.
	const sideThread =
		findSession(sessionState.currentId ?? "")?.sideThread === true;
	return order.flatMap((mode) =>
		PERMISSION_MODES.filter(
			(option) =>
				option.mode === mode &&
				(claude ||
					(!option.claudeOnly && !option.sessionOnly) ||
					(sideThread && option.mode === "plan")),
		),
	);
}

export function getRankedApprovalOptions(): readonly ApprovalOption[] {
	return approvalOptions(APPROVAL_MENU_ORDER);
}

export const effort: ComposerSetting<string> = {
	get options() {
		return getActiveModelVariants();
	},
	get current() {
		return discoveryState.currentVariant || null;
	},
	get pending() {
		return pending.effort > 0;
	},
	select(value) {
		const variant = value ?? "";
		const undo = chooseVariant(variant);
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (!projectSlug || !sessionId) return;
		switchSetting(
			"effort",
			undo,
			() =>
				switchVariantRpc({ projectSlug, sessionId, variant }).then(
					applyVariantSwitched,
				),
			`Couldn't switch thinking level to "${variant || "default"}"`,
		);
	},
	cycle() {
		const options = effort.options;
		const next =
			options[(options.indexOf(effort.current ?? "") + 1) % options.length];
		if (next !== undefined) effort.select(next);
	},
};

export const approvals: ComposerSetting<ApprovalOption> = {
	get options() {
		return approvalOptions(APPROVAL_CYCLE_ORDER);
	},
	get current() {
		return (
			PERMISSION_MODES.find(
				(option) => option.mode === discoveryState.permissionMode,
			) ?? null
		);
	},
	get pending() {
		return pending.approvals > 0;
	},
	select(value) {
		if (!value) return;
		// Re-assert even unchanged modes: a daemon restart can reset its mode.
		const mode = value.mode;
		const undo = choosePermissionMode(mode);
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (!projectSlug || !sessionId) {
			discoveryState.pendingPermissionMode = mode;
			return;
		}
		discoveryState.pendingPermissionMode = null;
		switchSetting(
			"approvals",
			undo,
			() => switchPermissionModeRpc({ projectSlug, sessionId, mode }),
			`Couldn't switch approval mode to "${value.label}"`,
		);
	},
	cycle() {
		const options = approvals.options;
		const index = options.findIndex(
			(option) => option.mode === approvals.current?.mode,
		);
		const next = options[(index + 1) % options.length];
		if (next) approvals.select(next);
	},
};

export const contextWindow: ComposerSetting<Immutable<ContextWindowOption>> = {
	get options() {
		return getActiveContextWindowOptions();
	},
	get current() {
		const options = contextWindow.options;
		const selectedValue =
			discoveryState.currentContextWindow ||
			(options.find((option) => option.isDefault)?.value ??
				options[0]?.value ??
				"");
		return (
			options.find((option) => option.value === selectedValue) ??
			options.find((option) => option.isDefault) ??
			options[0] ??
			null
		);
	},
	get pending() {
		return pending.contextWindow > 0;
	},
	select(value) {
		const contextWindowValue = value?.value ?? "";
		const undo = chooseContextWindow(contextWindowValue);
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (!projectSlug || !sessionId) return;
		switchSetting(
			"contextWindow",
			undo,
			() =>
				switchContextWindowRpc({
					projectSlug,
					sessionId,
					contextWindow: contextWindowValue,
				}).then(applyContextWindowSwitched),
			`Couldn't switch context window to "${value?.label ?? "default"}"`,
		);
	},
	cycle() {
		const options = contextWindow.options;
		const index = options.findIndex(
			(option) => option.value === contextWindow.current?.value,
		);
		const next = options[(index + 1) % options.length];
		if (next) contextWindow.select(next);
	},
};

export const model: ComposerSetting<ComposerModel> = {
	get options() {
		const providerId = discoveryState.currentProviderId;
		const instanceId =
			sessionState.currentId && providerId
				? instanceIdForProviderId(providerId)
				: getEffectiveInstanceId();
		return getProviderGroupsForInstance(instanceId).flatMap((group) =>
			group.models.flatMap((entry) =>
				[
					entry.id,
					...(entry.routingOptions?.map((option) => option.value) ?? []),
				].map((modelId) => ({ modelId, providerId: entry.provider })),
			),
		);
	},
	get current() {
		return discoveryState.currentModelId
			? {
					modelId: discoveryState.currentModelId,
					providerId: discoveryState.currentProviderId,
				}
			: null;
	},
	get pending() {
		return pending.model > 0;
	},
	select(value) {
		if (!value) return;
		const undo = chooseModel(value);
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (!projectSlug || !sessionId) return;
		switchSetting(
			"model",
			undo,
			() =>
				switchModelRpc({ projectSlug, sessionId, ...value }).then(
					(response) => {
						applyModelSwitched(response);
						void getAgentsRpc({ projectSlug, sessionId })
							.then((response) => applyGetAgentsResponse(response, sessionId))
							.catch(() => undefined);
					},
				),
			`Couldn't switch model to "${value.modelId}"`,
		);
	},
	cycle() {},
};
