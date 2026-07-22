// ─── Visibility Handlers ─────────────────────────────────────────────────────
// Global hide-lists for the agent/model dropdowns. Persisted in relay settings.

import { Data, Effect } from "effect";
import {
	ConfigTag,
	LoggerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../relay/relay-settings.js";

export interface HiddenEntries {
	readonly hiddenModels: string[];
	readonly hiddenAgents: string[];
}

/** Read the persisted hide-lists (empty arrays when unset). */
export function getHiddenEntries(configDir?: string): HiddenEntries {
	const settings = loadRelaySettings(configDir);
	return {
		hiddenModels: settings.hiddenModels ?? [],
		hiddenAgents: settings.hiddenAgents ?? [],
	};
}

class RelaySettingsSaveError extends Data.TaggedError(
	"RelaySettingsSaveError",
)<{
	readonly cause: unknown;
}> {}

export interface SetHiddenEntriesInput {
	readonly clientId: string;
	readonly hiddenModels?: readonly string[] | undefined;
	readonly hiddenAgents?: readonly string[] | undefined;
}

/**
 * Persist the provided hide-lists (replace semantics; an omitted list is left
 * untouched), broadcast the merged view as `visibility_info`, and return it.
 */
export const setHiddenEntriesForRelay = (input: SetHiddenEntriesInput) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const log = yield* LoggerTag;
		const config = yield* ConfigTag;

		// Effect.try (not Effect.sync): an fs throw must surface as a typed
		// failure the RPC entry's Effect.catchAll can convert to WsRpcError.
		yield* Effect.try({
			try: () =>
				saveRelaySettings(
					{
						...(input.hiddenModels !== undefined
							? { hiddenModels: [...input.hiddenModels] }
							: {}),
						...(input.hiddenAgents !== undefined
							? { hiddenAgents: [...input.hiddenAgents] }
							: {}),
					},
					config.configDir,
				),
			catch: (cause) => new RelaySettingsSaveError({ cause }),
		});

		const entries = getHiddenEntries(config.configDir);
		wsHandler.broadcast({ type: "visibility_info", ...entries });
		log.info(
			`client=${input.clientId} Hidden entries updated: ${entries.hiddenModels.length} models, ${entries.hiddenAgents.length} agents`,
		);
		return entries;
	});
