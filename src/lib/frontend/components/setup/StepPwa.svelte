<!-- ─── Step: PWA ─────────────────────────────────────────────────────────── -->
<!-- Setup step for adding the app to the home screen.                       -->

<script lang="ts">
	import StepHeader from "./StepHeader.svelte";

	let {
		totalSteps,
		currentIdx,
		isIOS,
		isAndroid,
		isDesktop,
		isSafari,
		isIPad,
		onnextstep,
	}: {
		totalSteps: number;
		currentIdx: number;
		isIOS: boolean;
		isAndroid: boolean;
		isDesktop: boolean;
		isSafari: boolean;
		isIPad: boolean;
		onnextstep: () => void;
	} = $props();
</script>

<div class="animate-fadeIn">
	<StepHeader
		{totalSteps}
		{currentIdx}
		title="Add to Home Screen"
		description="Install Conduit as an app for quick access and a full-screen experience."
	/>

	{#if isIOS}
		<div
		class="flex items-center gap-2 px-4 py-3 rounded-[10px] text-base my-4 bg-bg-alt text-text border border-border"
		>
			On iOS, push notifications only work from the installed app. This
			step is required.
		</div>

		{#if !isSafari}
			<div
				class="flex items-center gap-2 px-4 py-3 rounded-[10px] text-base my-4 bg-bg-alt text-text border border-border"
			>
				You must use <b>Safari</b> to install. Open this page in Safari
				first.
			</div>
		{:else}
			<div class="flex gap-3 mb-4">
				<div
					class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
				>
					1
				</div>
				<div class="text-sm leading-relaxed">
					Tap the <b>Share</b> button
					<svg
						width="18"
						height="18"
						viewBox="0 0 17.695 26.475"
						class="inline align-middle mx-0.5"
						><g fill="currentColor"
							><path
								d="M17.334 10.762v9.746c0 2.012-1.025 3.027-3.066 3.027H3.066C1.026 23.535 0 22.52 0 20.508v-9.746C0 8.75 1.025 7.734 3.066 7.734h2.94v1.573h-2.92c-.977 0-1.514.527-1.514 1.543v9.57c0 1.015.537 1.543 1.514 1.543h11.152c.967 0 1.524-.527 1.524-1.543v-9.57c0-1.016-.557-1.543-1.524-1.543h-2.91V7.734h2.94c2.04 0 3.066 1.016 3.066 3.028Z"
							/><path
								d="M8.662 15.889c.42 0 .781-.352.781-.762V5.097l-.058-1.464.654.693 1.484 1.582a.698.698 0 0 0 .528.235c.4 0 .713-.293.713-.694 0-.205-.088-.361-.235-.508l-3.3-3.183c-.196-.196-.362-.264-.567-.264-.195 0-.361.069-.566.264L4.795 4.94a.681.681 0 0 0-.225.508c0 .4.293.694.703.694.186 0 .4-.079.538-.235l1.474-1.582.664-.693-.058 1.465v10.029c0 .41.351.762.771.762Z"
							/></g
						></svg
					>
					at the bottom of the Safari toolbar.
					{#if isIPad}
						<div class="text-xs text-text-muted mt-1">
							On iPad, the Share button is in the top toolbar.
						</div>
					{/if}
				</div>
			</div>
			<div class="flex gap-3 mb-4">
				<div
					class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
				>
					2
				</div>
				<div class="text-sm leading-relaxed">
					Scroll down in the share sheet and tap <b
						>Add to Home Screen</b
					>
					<svg
						width="18"
						height="18"
						viewBox="0 0 25 25"
						class="inline align-middle mx-0.5"
						><g fill="currentColor"
							><path
								d="m23.40492,1.60784c-1.32504,-1.32504 -3.19052,-1.56912 -5.59644,-1.56912l-10.65243,0c-2.33622,0 -4.2017,0.24408 -5.5267,1.56912c-1.32504,1.34243 -1.56911,3.17306 -1.56911,5.50924l0,10.5827c0,2.40596 0.22665,4.254 1.55165,5.57902c1.34246,1.32501 3.19052,1.5691 5.59647,1.5691l10.60013,0c2.40592,0 4.2714,-0.24408 5.59644,-1.5691c1.325,-1.34245 1.55166,-3.17306 1.55166,-5.57902l0,-10.51293c0,-2.40596 -0.22666,-4.25401 -1.55166,-5.57901zm-0.38355,5.21289l0,11.24518c0,1.51681 -0.20924,2.94643 -1.02865,3.78327c-0.83683,0.83685 -2.30134,1.0635 -3.81815,1.0635l-11.33234,0c-1.51681,0 -2.96386,-0.22665 -3.80073,-1.0635c-0.83683,-0.83684 -1.04607,-2.26646 -1.04607,-3.78327l0,-11.19288c0,-1.5517 0.20924,-3.01617 1.02865,-3.85304c0.83687,-0.83683 2.31876,-1.04607 3.87042,-1.04607l11.28007,0c1.51681,0 2.98132,0.22666 3.81815,1.06353c0.81941,0.81941 1.02865,2.26645 1.02865,3.78327zm-10.53039,12.08205c0.64506,0 1.02861,-0.43586 1.02861,-1.13326l0,-4.34117l4.53294,0c0.66252,0 1.13326,-0.36613 1.13326,-0.99376c0,-0.64506 -0.43586,-1.02861 -1.13326,-1.02861l-4.53294,0l0,-4.53294c0,-0.6974 -0.38355,-1.13326 -1.02861,-1.13326c-0.62763,0 -0.99376,0.45332 -0.99376,1.13326l0,4.53294l-4.51552,0c-0.69737,0 -1.15069,0.38355 -1.15069,1.02861c0,0.62763 0.48817,0.99376 1.15069,0.99376l4.51552,0l0,4.34117c0,0.66252 0.36613,1.13326 0.99376,1.13326z"
							/></g
						></svg
					>
				</div>
			</div>
			<div class="flex gap-3 mb-4">
				<div
					class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
				>
					3
				</div>
				<div class="text-sm leading-relaxed">
					Tap <b>Add</b> in the top right corner to confirm.
				</div>
			</div>
		{/if}
	{:else if isAndroid}
		<div class="flex gap-3 mb-4">
			<div
				class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
			>
				1
			</div>
			<div class="text-sm leading-relaxed">
				Tap the <b>three dots menu</b>
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					class="inline align-middle mx-0.5"
					><circle
						cx="12"
						cy="4"
						r="2.5"
						fill="currentColor"
					/><circle
						cx="12"
						cy="12"
						r="2.5"
						fill="currentColor"
					/><circle
						cx="12"
						cy="20"
						r="2.5"
						fill="currentColor"
					/></svg
				> in the top right corner of Chrome.
			</div>
		</div>
		<div class="flex gap-3 mb-4">
			<div
				class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
			>
				2
			</div>
			<div class="text-sm leading-relaxed">
				Tap <b>Install app</b> or
				<b>Add to Home screen</b>.
				<div class="text-xs text-text-muted mt-1">
					If you don't see it, try <b>Open in Chrome</b> first if
					using another browser.
				</div>
			</div>
		</div>
		<div class="flex gap-3 mb-4">
			<div
				class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
			>
				3
			</div>
			<div class="text-sm leading-relaxed">
				Tap <b>Install</b> in the confirmation dialog.
			</div>
		</div>
	{:else}
		<div class="flex gap-3 mb-4">
			<div
				class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
			>
				1
			</div>
			<div class="text-sm leading-relaxed">
				Look for the <b>install icon</b> in the address bar (a monitor with
				a down arrow).
			</div>
		</div>
		<div class="flex gap-3 mb-4">
			<div
				class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
			>
				2
			</div>
			<div class="text-sm leading-relaxed">
				Click it and then click <b>Install</b> to confirm.
				<div class="text-xs text-text-muted mt-1">
					If there is no icon, go to <b
						>Menu &gt; Install Conduit</b
					>
					or
					<b>Menu &gt; Save and Share &gt; Install</b>.
				</div>
			</div>
		</div>
	{/if}

	<!-- Status -->
	<div
		class="flex items-center gap-2 px-4 py-3 rounded-[10px] text-base my-4 bg-bg-alt text-text-muted border border-border"
	>
		{#if isAndroid}
			Optional: install for quick access and full-screen experience.
		{:else}
			After installing, open Conduit from your home screen to
			continue setup.
		{/if}
	</div>

	<!-- Skip button (Android or desktop) -->
	{#if isAndroid || isDesktop}
		<button
			class="block w-full text-center text-text-muted text-base no-underline mt-3 cursor-pointer border-none bg-transparent font-sans hover:text-text-dimmer"
			onclick={onnextstep}
		>
			Skip for now
		</button>
	{/if}
</div>
