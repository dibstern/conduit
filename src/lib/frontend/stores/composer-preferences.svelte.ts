export type ComposerPreferences = {
	controls: "icons" | "words";
	contextWarning: 60 | 70 | 80 | 90 | "never";
};

const STORAGE_KEY = "conduit-composer-preferences";

function readPreferences(): ComposerPreferences {
	const preferences: ComposerPreferences = {
		controls: "icons",
		contextWarning: 80,
	};
	try {
		const stored: unknown = JSON.parse(
			localStorage.getItem(STORAGE_KEY) ?? "{}",
		);
		if (typeof stored === "object" && stored !== null) {
			if (
				"controls" in stored &&
				(stored.controls === "icons" || stored.controls === "words")
			) {
				preferences.controls = stored.controls;
			}
			if (
				"contextWarning" in stored &&
				(stored.contextWarning === 60 ||
					stored.contextWarning === 70 ||
					stored.contextWarning === 80 ||
					stored.contextWarning === 90 ||
					stored.contextWarning === "never")
			) {
				preferences.contextWarning = stored.contextWarning;
			}
		}
	} catch {
		// Storage can be unavailable or contain an older, invalid value.
	}
	return preferences;
}

export function isContextWarning(
	percent: number,
	threshold: ComposerPreferences["contextWarning"],
): boolean {
	return percent > 0 && threshold !== "never" && percent >= threshold;
}

export const composerPreferences = $state<ComposerPreferences>(
	readPreferences(),
);

export function setComposerPreferences(
	preferences: Partial<ComposerPreferences>,
): void {
	Object.assign(composerPreferences, preferences);
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(composerPreferences));
	} catch {
		// The preference still applies when device storage is unavailable.
	}
}
