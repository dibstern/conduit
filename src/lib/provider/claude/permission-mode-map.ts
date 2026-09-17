// src/lib/provider/claude/permission-mode-map.ts
// ─── Permission mode mapping ────────────────────────────────────────────────
// Conduit's session permission modes correspond 1:1 to the Claude Agent SDK's
// six. Conduit keeps its own spellings for the two that predate the mapping
// ("ask", "full") so persisted rows and the UI stay valid without a migration;
// everything else is the SDK's own name.
//
// The map is bijective on purpose. The forward direction decides what the
// session actually enforces; the reverse direction is what lets conduit treat
// the mode the SDK reports on each turn's init message as the source of truth,
// instead of guessing from its own last write.

import type { ClaudeSDKPermissionMode } from "../../contracts/providers/claude-agent-sdk.js";
import type { SessionPermissionMode } from "../../shared-types.js";

const TO_SDK: Readonly<Record<SessionPermissionMode, ClaudeSDKPermissionMode>> =
	{
		ask: "default",
		acceptEdits: "acceptEdits",
		full: "bypassPermissions",
		auto: "auto",
		plan: "plan",
		dontAsk: "dontAsk",
	};

const FROM_SDK = Object.freeze(
	Object.fromEntries(
		Object.entries(TO_SDK).map(([conduit, sdk]) => [sdk, conduit]),
	) as Record<ClaudeSDKPermissionMode, SessionPermissionMode>,
);

/** The SDK mode a conduit session mode puts the query into. */
export const toSdkPermissionMode = (
	mode: SessionPermissionMode,
): ClaudeSDKPermissionMode => TO_SDK[mode];

/**
 * The conduit mode an SDK-reported mode corresponds to. Returns undefined for
 * a value outside the pinned SDK's set, so a future SDK mode conduit does not
 * model yet is ignored rather than silently coerced to "ask".
 */
export const fromSdkPermissionMode = (
	mode: string,
): SessionPermissionMode | undefined =>
	(FROM_SDK as Record<string, SessionPermissionMode | undefined>)[mode];

/**
 * The SDK refuses `bypassPermissions` unless the caller opts in explicitly at
 * query creation, so this has to travel with the mode rather than be inferred.
 */
export const requiresDangerousSkip = (mode: SessionPermissionMode): boolean =>
	TO_SDK[mode] === "bypassPermissions";
