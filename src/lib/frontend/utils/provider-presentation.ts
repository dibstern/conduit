import {
	isKnownDriverKind,
	type KnownProviderDriverKind,
} from "../../contracts/provider-instance.js";
import type { SettingsSection } from "../components/layout/chrome-actions.js";

export const PROVIDER_PRESENTATION = {
	claude: {
		logo: "claude",
		label: "Claude",
		settingsTab: "claude",
		namePlaceholder: "Work Claude",
		configDirPlaceholder: "~/.config/claude/work",
		composerNotice: undefined,
		auth: undefined,
	},
	opencode: {
		logo: "opencode",
		label: "OpenCode",
		settingsTab: "server",
		namePlaceholder: "Staging OC",
		configDirPlaceholder: undefined,
		composerNotice: undefined,
		auth: undefined,
	},
	cursor: {
		logo: "cursor",
		label: "Cursor",
		settingsTab: "server",
		namePlaceholder: "Work Cursor",
		configDirPlaceholder: "~/.config/cursor/work",
		composerNotice: "Cursor runs without per-call approval.",
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
	},
} as const satisfies Record<
	KnownProviderDriverKind,
	{
		readonly logo: string;
		readonly label: string;
		readonly settingsTab: SettingsSection;
		readonly namePlaceholder: string;
		readonly configDirPlaceholder: string | undefined;
		readonly composerNotice: string | undefined;
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
	}
>;

export function getProviderPresentation(driver: string | undefined) {
	return isKnownDriverKind(driver) ? PROVIDER_PRESENTATION[driver] : undefined;
}
