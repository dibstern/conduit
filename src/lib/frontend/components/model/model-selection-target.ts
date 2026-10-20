import type { ProviderDriverKind } from "../../../contracts/provider-instance.js";
import type { InstanceOption } from "../../stores/discovery.svelte.js";
import type {
	ContextWindowOption,
	Immutable,
	ModelInfo,
	ProviderGroup,
} from "../../types.js";

/** Selection state and actions, independent of the surface that owns the pick. */
export interface ModelSelectionTarget {
	readonly pick: {
		readonly account: string | undefined;
		readonly driver: ProviderDriverKind | undefined;
		readonly providerId: string;
		readonly modelId: string;
		readonly effort: string | null;
		readonly contextWindow: Immutable<ContextWindowOption> | null;
	};
	readonly accounts: readonly InstanceOption[];
	readonly catalog: readonly Immutable<ProviderGroup>[];
	/** Includes a selected model hidden from the visible catalog. */
	readonly activeModel: Immutable<ModelInfo> | undefined;
	readonly inventory: {
		readonly loading: boolean;
		readonly error: string | null;
	};
	readonly loading: boolean;
	readonly effortOptions: readonly string[];
	readonly contextWindowOptions: readonly Immutable<ContextWindowOption>[];
	/** Independent writes keep their existing per-control pending behavior. */
	readonly pending: {
		readonly model: boolean;
		readonly effort: boolean;
		readonly contextWindow: boolean;
	};
	selectAccount(id: string): void;
	selectModel(pick: { modelId: string; providerId: string }): void;
	selectEffort(value: string): void;
	selectContextWindow(value: Immutable<ContextWindowOption> | null): void;
}
