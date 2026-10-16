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
	},
	opencode: {
		logo: "opencode",
		label: "OpenCode",
		settingsTab: "server",
		namePlaceholder: "Staging OC",
		configDirPlaceholder: undefined,
	},
} as const satisfies Record<
	KnownProviderDriverKind,
	{
		readonly logo: string;
		readonly label: string;
		readonly settingsTab: SettingsSection;
		readonly namePlaceholder: string;
		readonly configDirPlaceholder: string | undefined;
	}
>;

export function getProviderPresentation(driver: string | undefined) {
	return isKnownDriverKind(driver) ? PROVIDER_PRESENTATION[driver] : undefined;
}
