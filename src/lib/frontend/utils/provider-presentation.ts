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
		environment: undefined,
		composerNotice: undefined,
		auth: undefined,
		subagentNotice: undefined,
	},
	opencode: {
		logo: "opencode",
		label: "OpenCode",
		settingsTab: "server",
		namePlaceholder: "Staging OC",
		configDirPlaceholder: undefined,
		environment: undefined,
		composerNotice: undefined,
		auth: undefined,
		subagentNotice: undefined,
	},
	cursor: {
		logo: "cursor",
		label: "Cursor",
		settingsTab: "server",
		namePlaceholder: "Work Cursor",
		configDirPlaceholder: "~/.config/cursor/work",
		environment: {
			placeholder: "CURSOR_AUTH_TOKEN=...",
			hint: "Saved usage tokens stay hidden. Enter CURSOR_AUTH_TOKEN=value to replace one, or CURSOR_AUTH_TOKEN= to remove it.",
		},
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
		auth: {
			title: "Cursor account",
			login: "Log in to Cursor",
			manage: "Cursor account settings",
			logout: "Log out",
			cancel: "Cancel login",
			openLogin: "Open Cursor login",
			pending:
				"Open the link to finish logging in, on this device or another one.",
			loggedIn: "Logged in",
			loggedOut: "Not logged in",
			environment: "From environment (CURSOR_API_KEY)",
			expiryWarning: "Your Cursor key expires soon. Log in again to renew it.",
			errorCode: "auth_required",
		},
		subagentNotice: "Subagent sessions are read-only.",
	},
} as const satisfies Record<
	KnownProviderDriverKind,
	{
		readonly logo: string;
		readonly label: string;
		readonly settingsTab: SettingsSection;
		readonly namePlaceholder: string;
		readonly configDirPlaceholder: string | undefined;
		readonly environment:
			| { readonly placeholder: string; readonly hint: string }
			| undefined;
		readonly composerNotice:
			| Partial<Record<SessionPermissionMode, string>>
			| undefined;
		readonly auth:
			| {
					readonly title: string;
					readonly login: string;
					readonly manage: string;
					readonly logout: string;
					readonly cancel: string;
					readonly openLogin: string;
					readonly pending: string;
					readonly loggedIn: string;
					readonly loggedOut: string;
					readonly environment: string;
					readonly expiryWarning: string;
					readonly errorCode: string;
			  }
			| undefined;
		readonly subagentNotice: string | undefined;
	}
>;

export function getProviderPresentation(driver: string | undefined) {
	return isKnownDriverKind(driver) ? PROVIDER_PRESENTATION[driver] : undefined;
}
