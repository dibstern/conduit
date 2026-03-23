<!-- ─── PinPage ──────────────────────────────────────────────────────────────── -->
<!-- PIN entry page for authentication. Centered card on dark background with -->
<!-- 6-digit input, auto-submit, and lockout handling. -->

<!-- svelte-ignore state_referenced_locally -->
<script lang="ts">
	import { onMount } from "svelte";
	import { navigate } from "../stores/router.svelte.js";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		initialError = "",
		initialDisabled = false,
	}: {
		/** Initial error message (for Storybook). */
		initialError?: string;
		/** Initial disabled state (for Storybook). */
		initialDisabled?: boolean;
	} = $props();

	// ─── State ──────────────────────────────────────────────────────────────────
	// Props are used as seed values only; the component owns the mutable state.

	let pin = $state("");
	let error = $state(initialError);
	let disabled = $state(initialDisabled);
	let inputEl: HTMLInputElement | undefined = $state(undefined);

	// ─── Focus on mount ─────────────────────────────────────────────────────────

	onMount(() => {
		inputEl?.focus();
	});

	// ─── Submit logic ───────────────────────────────────────────────────────────

	async function submitPin() {
		if (pin.length < 4) {
			error = "PIN must be 4-8 digits";
			return;
		}
		try {
			const res = await fetch("/auth", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin }),
			});
			const data = await res.json();
			if (data.ok) {
				// Use client-side navigation instead of window.location.href
				// to avoid the server's single-project 302 redirect, which
				// would dump the user into ChatLayout's ConnectOverlay with
				// no way to navigate back to the dashboard.
				navigate("/");
				return;
			}
			if (data.locked) {
				disabled = true;
				error = `Too many attempts. Try again in ${Math.ceil(data.retryAfter / 60)} min`;
				setTimeout(() => {
					disabled = false;
					error = "";
					inputEl?.focus();
				}, data.retryAfter * 1000);
				return;
			}
			let msg = "Wrong PIN";
			if (typeof data.attemptsLeft === "number" && data.attemptsLeft <= 3) {
				msg += ` (${data.attemptsLeft} left)`;
			}
			error = msg;
			pin = "";
			inputEl?.focus();
		} catch {
			error = "Connection error";
		}
	}

	// ─── Derived ───────────────────────────────────────────────────────────────

	let showButton = $derived(pin.length >= 4);

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Enter") {
			e.preventDefault();
			submitPin();
		}
	}

	function handleInput() {
		if (pin.length === 8) {
			submitPin();
		}
	}
</script>

<div class="bg-bg min-h-dvh flex items-center justify-center p-5">
	<div class="max-w-[320px] w-full text-center">
		<h1 class="text-text text-2xl mb-2 font-semibold">
			Conduit
		</h1>
		<div class="text-text-muted text-sm mb-8">Enter PIN to continue</div>
		<input
			bind:this={inputEl}
			bind:value={pin}
			type="tel"
			maxlength="8"
			placeholder="PIN (4-8 digits)"
			autocomplete="off"
			inputmode="numeric"
			{disabled}
			onkeydown={handleKeydown}
			oninput={handleInput}
			class="w-full bg-bg border border-border rounded-xl text-text text-2xl tracking-[12px] text-center py-3.5 outline-none font-sans focus:border-text-muted placeholder:tracking-normal placeholder:text-lg placeholder:text-text-dimmer"
			style="-webkit-text-security: disc"
		/>
		<div class="mt-4 grid transition-all duration-200 ease-out" style="grid-template-rows: {showButton ? '1fr' : '0fr'}; opacity: {showButton ? 1 : 0}">
			<div class="overflow-hidden">
				<button
					type="button"
					{disabled}
					onclick={submitPin}
					class="w-full bg-accent text-bg px-6 py-3 rounded-xl font-semibold text-sm border-none cursor-pointer font-sans hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-default"
				>
					Continue
				</button>
			</div>
		</div>
		<div class="text-error text-base mt-3 min-h-[1.3em]">
			{error}
		</div>
	</div>
</div>
