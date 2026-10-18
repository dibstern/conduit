<script lang="ts">
	import { untrack } from "svelte";
	import type { TerminalKeysSetting } from "../../../contracts/terminal-keys.js";
	import { projectState } from "../../stores/project-state.svelte.js";
	import { getCurrentRoute, getCurrentSlug } from "../../stores/router.svelte.js";
	import { getIsConnected } from "../../transport/connection-status.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import SettingsPicker from "../ui/SettingsPicker.svelte";

	let saving = $state(false);
	const settings = $derived(projectState.terminalKeys);
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
