<script lang="ts">
	import { untrack } from "svelte";
	import {
		TERMINAL_KEY_ACTIONS,
		type TerminalKeyAction,
		type TerminalKeysSetting,
	} from "../../../contracts/terminal-keys.js";
	import { projectState } from "../../stores/project-state.svelte.js";
	import { getCurrentRoute, getCurrentSlug } from "../../stores/router.svelte.js";
	import { getIsConnected } from "../../transport/connection-status.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { isTerminalModifier, TERMINAL_KEY_LABELS } from "../../utils/terminal-keys.svelte.js";
	import ArrowPad from "../ui/ArrowPad.svelte";
	import Button from "../ui/Button.svelte";
	import FlickKey from "../ui/FlickKey.svelte";
	import Modal from "../ui/Modal.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import SettingsPicker from "../ui/SettingsPicker.svelte";

	let saving = $state(false);
	let editingKey = $state<number | null>(null);
	let editingSlot = $state<"tap" | "up">("tap");
	let editorOpener: HTMLButtonElement | null = null;
	const settings = $derived(projectState.terminalKeys);
	const editedKey = $derived(editingKey === null ? undefined : settings.row.keys[editingKey]);
	const pasteEscTab = $derived(settings.bar.paste || settings.bar.escTab);
	// Read when the section mounts, including platform overrides installed
	// before the page starts. userAgentData takes precedence when available.
	const platform = typeof navigator === "undefined" ? "" :
		(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
	const isMac = /mac/i.test(platform);

	$effect(() => {
		if (!getIsConnected()) return;
		const route = getCurrentRoute();
		if (route.page === "chat" && route.sessionId && !getCurrentSlug()) return;
		let current = true;
		const readRevision = untrack(() => projectState.terminalKeysRevision);
		void rpc("GetTerminalKeys", {})
			.then(({ terminalKeys }) => {
				if (current && readRevision === projectState.terminalKeysRevision) projectState.terminalKeys = terminalKeys;
			})
			.catch((error) => {
				if (current) toastFailure("Couldn't load terminal settings")(error);
			});
		return () => { current = false; };
	});

	function save(terminalKeys: TerminalKeysSetting): void {
		const saveRevision = ++projectState.terminalKeysRevision;
		saving = true;
		void rpc("SetTerminalKeys", { terminalKeys })
			.then(({ terminalKeys: saved }) => {
				if (saveRevision === projectState.terminalKeysRevision) projectState.terminalKeys = saved;
			})
			.catch(toastFailure("Couldn't save terminal settings"))
			.finally(() => { saving = false; });
	}

	function saveBar(patch: Partial<TerminalKeysSetting["bar"]>): void {
		save({ ...settings, bar: { ...settings.bar, ...patch } });
	}

	function saveRow(patch: Partial<TerminalKeysSetting["row"]>): void {
		save({ ...settings, row: { ...settings.row, ...patch } });
	}

	function openEditor(index: number): void {
		editorOpener = document.querySelector<HTMLButtonElement>(`[data-testid="terminal-row-key-${index}"] button`);
		editingSlot = "tap";
		editingKey = index;
	}

	function chooseAction(action: TerminalKeyAction): void {
		if (editingKey === null || saving) return;
		// Preserve the four-element tuple when replacing just one key.
		const keys = [...settings.row.keys] satisfies TerminalKeysSetting["row"]["keys"];
		const current = keys[editingKey];
		if (!current) return;
		keys[editingKey] = { ...current, [editingSlot]: action };
		saveRow({ keys });
	}
</script>

<SettingsGroup id="settings-terminal-desktop" title="Desktop">
	<div>
		<SettingsRow label="Keys in the tab bar" ariaLabel="Keys in the tab bar" checked={settings.bar.show} disabled={saving} onchange={() => saveBar({ show: !settings.bar.show })} />
		{#if settings.bar.show}
			<div class="ml-[20px] divide-y divide-settings-separator border-t border-settings-separator">
				<SettingsRow label="Paste, esc and tab" ariaLabel="Paste, esc and tab" checked={pasteEscTab} disabled={saving} onchange={() => saveBar({ paste: !pasteEscTab, escTab: !pasteEscTab })} />
				<SettingsRow label="Modifiers" ariaLabel="Modifiers" checked={settings.bar.modifiers} disabled={saving} onchange={() => saveBar({ modifiers: !settings.bar.modifiers })} />
				<SettingsRow label="Arrows" ariaLabel="Arrows" checked={settings.bar.arrows} disabled={saving} onchange={() => saveBar({ arrows: !settings.bar.arrows })} />
			</div>
		{/if}
	</div>
</SettingsGroup>

<SettingsGroup id="settings-terminal-phone" title="Phone and tablet" caption="Tap a key to change its tap and flick actions.">
	<div class="p-3">
		<div data-testid="terminal-row-preview" class="flex gap-[6px]" role="group" aria-label="Key row preview">
			{#each settings.row.keys as { tap, up }, index (index)}
				<!-- Opens on the click, not FlickKey's pointerup: a sheet opened on
				     pointerup would take the click that follows as a backdrop click
				     and close. Keyboard activation reaches here as the inner
				     button's click. -->
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div data-testid="terminal-row-key-{index}" class="contents" onclick={() => openEditor(index)}>
					<FlickKey
						tap={TERMINAL_KEY_LABELS[tap]}
						up={up === "nothing" ? undefined : TERMINAL_KEY_LABELS[up]}
						hints={settings.row.hints}
						preserveFocus={false}
						onpress={() => undefined}
					/>
				</div>
			{/each}
			<div inert aria-hidden="true" class="contents">
				<ArrowPad class="flex-[1.5]" onarrow={() => undefined} />
				<Button variant="ghost" size="content" tone="secondary" hoverFill="none" icon="keyboard" iconSize={21} iconOnly ariaLabel="Keyboard" class="h-[46px] w-[40px] shrink-0 rounded-xl" />
			</div>
		</div>
	</div>
	<SettingsRow label="Show the key row" ariaLabel="Show the key row" checked={settings.row.show} disabled={saving} onchange={() => saveRow({ show: !settings.row.show })} />
	<SettingsRow label="Flick hints" ariaLabel="Flick hints" checked={settings.row.hints} disabled={saving} onchange={() => saveRow({ hints: !settings.row.hints })} />
</SettingsGroup>

<SettingsGroup id="settings-terminal-behavior" title="How keys behave">
	{#if isMac}
		<SettingsRow label="Option key" labelFor="settings-terminal-option-key">
			{#snippet control()}
				<SettingsPicker id="settings-terminal-option-key" data-testid="settings-terminal-option-key" label="Option key" value={settings.optionKey} disabled={saving} onvaluechange={(optionKey) => {
					if (optionKey === "characters" || optionKey === "meta") save({ ...settings, optionKey });
				}} options={[{ value: "characters", label: "Types characters" }, { value: "meta", label: "Meta" }]} />
			{/snippet}
		</SettingsRow>
	{/if}
	<SettingsRow label="Tap twice to lock" ariaLabel="Tap twice to lock" checked={settings.tapTwiceToLock} disabled={saving} onchange={() => save({ ...settings, tapTwiceToLock: !settings.tapTwiceToLock })} />
	<SettingsRow label="Paste as one block" ariaLabel="Paste as one block" description="Ask before a multi-line paste into a program that can't take it as one block." checked={settings.pasteAsOneBlock} disabled={saving} onchange={() => save({ ...settings, pasteAsOneBlock: !settings.pasteAsOneBlock })} />
</SettingsGroup>
<p class="mt-[10px] px-[4px] text-[12px] leading-[1.4] text-text-muted">Tap the on-screen ⌘, then V to paste, C to copy the selection, K to clear, or F to find.</p>

<Modal open={editingKey !== null} onclose={() => (editingKey = null)} title="Edit key {editingKey === null ? '' : editingKey + 1}" placement="sheet" class="mx-auto max-w-md" returnFocus={() => editorOpener}>
	<div id="terminal-key-editor" data-testid="terminal-key-editor" class="flex flex-col gap-4">
		{#if editedKey}
			<div class="flex gap-2" role="group" aria-label="Key slot">
				{#each (["tap", "up"] as const) as slot (slot)}
					<Button variant={editingSlot === slot ? "accent-soft" : "secondary"} size="content" class="min-h-[52px] flex-1 rounded-lg px-3 py-2" data-testid="terminal-key-slot-{slot}" aria-pressed={editingSlot === slot} onclick={() => (editingSlot = slot)}>
						<span class="flex flex-col gap-1">
							<span>{slot === "tap" ? "Tap" : "Flick up"}</span>
							<span class="text-xs">{TERMINAL_KEY_LABELS[editedKey[slot]].name}</span>
						</span>
					</Button>
				{/each}
			</div>
			<div class="grid grid-cols-4 gap-2" role="group" aria-label="Actions">
				{#each TERMINAL_KEY_ACTIONS as action (action)}
					{@const label = TERMINAL_KEY_LABELS[action]}
					<Button variant={editedKey[editingSlot] === action ? "accent-soft" : "secondary"} size="content" class="min-h-[44px] rounded-lg px-1 py-2 text-sm" ariaLabel={label.name} aria-pressed={editedKey[editingSlot] === action} data-testid="terminal-key-action-{action}" disabled={saving} onclick={() => chooseAction(action)}>
						{#if isTerminalModifier(action)}<span class="text-[17px]">{label.text}</span>{:else if action === "esc" || action === "tab"}{label.text}{:else}{label.name}{/if}
					</Button>
				{/each}
			</div>
		{/if}
	</div>
	{#snippet footer()}
		<Button data-testid="terminal-key-editor-close" onclick={() => (editingKey = null)}>Done</Button>
	{/snippet}
</Modal>
