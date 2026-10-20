import { Schema } from "effect";
import {
	type CategorySet,
	CategorySetRejected,
	DEFAULT_CATEGORY_SET,
} from "../../../src/lib/contracts/category-set.js";
import {
	DEFAULT_MESSAGE_SURFACING_SETTINGS,
	MessageSurfacingPatchSchema,
	type MessageSurfacingStatus,
} from "../../../src/lib/contracts/message-surfacing.js";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";

/** Contains status only. No saved secret ever exists in these browser fixtures. */
export function surfacingSettingsFixture(
	key: MessageSurfacingStatus["key"] = { source: "none", rejected: false },
) {
	let settings: MessageSurfacingStatus = {
		...DEFAULT_MESSAGE_SURFACING_SETTINGS,
		active: false,
		key,
	};
	let categories: CategorySet = structuredClone(DEFAULT_CATEGORY_SET);
	const stubs = {
		GetMessageSurfacing: () => settings,
		GetSurfacingLedger: () => [],
		ScoreCategorySet: () => ({
			agree: 0,
			total: 0,
			levels: [],
			requiredCalls: 0,
			jevCalls: 0,
			complete: true,
			canTest: false,
		}),
		UpdateMessageSurfacing: (payload) => {
			const patch = Schema.decodeUnknownSync(MessageSurfacingPatchSchema)(
				payload,
			);
			const { apiKey, recap } = patch;
			if (apiKey !== undefined && settings.key.source === "env")
				throw new WsRpcError({ message: "TypeSafe key is set by environment" });
			if (apiKey === "rejected-fixture-key")
				throw new WsRpcError({ message: "TypeSafe rejected the key" });
			const nextKey: MessageSurfacingStatus["key"] =
				apiKey === undefined
					? settings.key
					: { source: apiKey === null ? "none" : "stored", rejected: false };
			const enabled = patch.enabled ?? settings.enabled;
			settings = {
				...settings,
				enabled,
				summariesEnabled:
					patch.summariesEnabled ??
					(recap?.model === "off" ? false : settings.summariesEnabled),
				defaultLevel: patch.defaultLevel ?? settings.defaultLevel,
				turnsOpen: patch.turnsOpen ?? settings.turnsOpen,
				tuningModel: patch.tuningModel ?? settings.tuningModel,
				recap: {
					model: recap?.model ?? settings.recap.model,
					when: recap?.when ?? settings.recap.when,
				},
				key: nextKey,
				active: enabled && nextKey.source !== "none" && !nextKey.rejected,
			};
			return settings;
		},
		GetCategorySet: () => categories,
		ReplaceCategorySet: ({ expectedVersion, nextSet }) => {
			if (expectedVersion !== categories.version)
				throw new CategorySetRejected({
					reason: "stale_version",
					message: "Categories changed elsewhere",
					currentVersion: categories.version,
				});
			categories = {
				version: categories.version + 1,
				categories: nextSet.categories,
			};
			return categories;
		},
	} satisfies StubTable;
	return {
		stubs,
		get settings() {
			return settings;
		},
		get categories() {
			return categories;
		},
		changeElsewhere() {
			categories = {
				version: categories.version + 1,
				categories: categories.categories.map((c) =>
					c.id === "finding" ? { ...c, weight: 75 } : c,
				),
			};
		},
		fillActiveCategories() {
			categories = {
				...categories,
				categories: [
					...DEFAULT_CATEGORY_SET.categories,
					...Array.from({ length: 11 }, (_, i) => ({
						id: `custom-${i}`,
						label: `Custom ${i}`,
						glyph: "●",
						colour: "#2a9fd6",
						origin: "custom" as const,
						weight: 50,
						retired: false,
						criteria: { what: "Fixture category" },
					})),
				],
			};
		},
	};
}
