import {
	isKnownDriverKind,
	type KnownProviderDriverKind,
} from "../../contracts/provider-instance.js";
import type { SettingsSection } from "../components/layout/chrome-actions.js";
import type { SessionPermissionMode } from "../types.js";

export const PROVIDER_PRESENTATION = {
	claude: {
		logo: "claude",
		label: "Claude",
		settingsTab: "claude",
		namePlaceholder: "Work Claude",
		configDirPlaceholder: "~/.config/claude/work",
		composerNotice: undefined,
	},
	opencode: {
		logo: "opencode",
		label: "OpenCode",
		settingsTab: "server",
		namePlaceholder: "Staging OC",
		configDirPlaceholder: undefined,
		composerNotice: undefined,
	},
	cursor: {
		logo: "cursor",
		label: "Cursor",
		settingsTab: "server",
		namePlaceholder: "Work Cursor",
		configDirPlaceholder: "~/.config/cursor/work",
		// Cursor has no per-call approval hook (spike conduit-test-xqsg.3), so each
		// mode says what cursor-session-config.ts actually enforces instead.
		composerNotice: {
			ask: "Cursor can't ask per call. Its auto-review decides in the sandbox and can let calls through.",
			acceptEdits:
				"Cursor applies edits without asking. Commands run in its sandbox.",
			auto: "Cursor's auto-review decides in the sandbox and can let calls through.",
			plan: "Cursor plans without per-call approval, inside its sandbox.",
			full: "Cursor runs every call with no approval and no sandbox.",
		},
	},
} as const satisfies Record<
	KnownProviderDriverKind,
	{
		readonly logo: string;
		readonly label: string;
		readonly settingsTab: SettingsSection;
		readonly namePlaceholder: string;
		readonly configDirPlaceholder: string | undefined;
		readonly composerNotice:
			| Partial<Record<SessionPermissionMode, string>>
			| undefined;
	}
>;

export function getProviderPresentation(driver: string | undefined) {
	return isKnownDriverKind(driver) ? PROVIDER_PRESENTATION[driver] : undefined;
}
