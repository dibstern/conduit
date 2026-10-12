export type PickerSection =
	| "harness"
	| "account"
	| "model"
	| "context"
	| "effort"
	| "agent";

export const composerPickerState = $state<{
	request: { section: PickerSection; opener: HTMLElement | null } | null;
}>({ request: null });

export function openPicker(section: PickerSection): void {
	composerPickerState.request = {
		section,
		opener:
			typeof document !== "undefined" &&
			document.activeElement instanceof HTMLElement &&
			document.activeElement !== document.body
				? document.activeElement
				: null,
	};
}
