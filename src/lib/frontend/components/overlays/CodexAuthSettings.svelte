<script lang="ts">
	import { onDestroy, onMount, untrack } from "svelte";
	import { CodexAuth } from "../../stores/codex-auth.svelte.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import Button from "../ui/Button.svelte";

	let { accountId }: { accountId: string } = $props();
	const accountAuth = new CodexAuth(untrack(() => accountId));
	const auth = $derived(accountAuth.current);
	const busy = $derived(accountAuth.busy);
	const error = $derived(accountAuth.error);
	let copied = $state<"code" | "url">();
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	let active = true;
	const pending = $derived(auth?.login.state === "pending");
	const fromEnvironment = $derived(auth?.source === "environment");
	const loginUrl = $derived.by(() => {
		const raw = auth?.login.verificationUrl ?? auth?.login.url;
		if (!pending || !raw) return undefined;
		try {
			const url = new URL(raw);
			return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
		} catch {
			return undefined;
		}
	});

	async function signIn(method: "browser" | "device-code") {
		if (busy) return;
		// Reserve the tab during the click, before the RPC consumes the browser's user gesture.
		const browserWindow = method === "browser"
			? window.open("about:blank", "_blank")
			: null;
		if (browserWindow) browserWindow.opener = null;
		await accountAuth.start(method);
		if (active && browserWindow && loginUrl) browserWindow.location.replace(loginUrl);
		else browserWindow?.close();
	}

	async function copy(value: string | undefined, kind: "code" | "url") {
		if (!value) return;
		if (!await copyToClipboard(value)) {
			accountAuth.error = "Could not copy. Select and copy the text below.";
			return;
		}
		copied = kind;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => { copied = undefined; }, 2_000);
	}

	onMount(() => { void accountAuth.refresh(); });
	onDestroy(() => {
		active = false;
		accountAuth.dispose();
		if (copyTimer) clearTimeout(copyTimer);
	});
	$effect(() => {
		const timer = setInterval(() => { void accountAuth.refresh(); }, pending ? 1_000 : 30_000);
		return () => clearInterval(timer);
	});
</script>

<div class="flex flex-col gap-2 text-[12px] leading-[1.4]" data-testid="codex-auth-account">
	<div role="status" aria-live="polite" data-testid="codex-auth-status" class="text-text-secondary">
		{#if fromEnvironment}From environment
		{:else if auth?.status === "logged-in"}Signed in{auth.email ? ` as ${auth.email}` : ""}
		{:else if auth?.status === "error"}{auth.error ?? "Could not check login status."}
		{:else if auth}Not signed in
		{:else}Checking login status…{/if}
	</div>
	{#if fromEnvironment && auth?.status === "error" && auth.error}<p role="alert" class="text-error">{auth.error}</p>{/if}
	{#if error}<p role="alert" class="text-error">{error}</p>{/if}
	{#if !fromEnvironment && auth}
		{#if pending}
			<div class="flex flex-col items-start gap-2" data-testid="codex-login-prompt">
				{#if auth.login.method === "device-code"}
					<p class="text-text-muted">Open the verification page and enter this code.</p>
					{#if auth.login.userCode}
						<div class="flex flex-wrap items-center gap-2">
							<code class="select-all rounded bg-bg-alt px-2.5 py-1.5 text-[16px] font-semibold tracking-wider text-text" data-testid="codex-login-code">{auth.login.userCode}</code>
							<Button touchTarget variant="secondary" size="sm" data-testid="codex-login-copy-code" onclick={() => void copy(auth?.login.userCode, "code")}>{copied === "code" ? "Copied" : "Copy code"}</Button>
						</div>
					{/if}
				{:else}<p class="text-text-muted">Finish signing in in your browser.</p>{/if}
				{#if loginUrl}
					<div class="flex flex-wrap gap-2">
						<Button touchTarget variant="primary" size="sm" href={loginUrl} target="_blank" rel="noopener noreferrer" data-testid="codex-login-link">{auth.login.method === "device-code" ? "Open verification page" : "Open Codex sign-in"}</Button>
						<Button touchTarget variant="secondary" size="sm" data-testid="codex-login-copy-url" onclick={() => void copy(loginUrl, "url")}>{copied === "url" ? "Copied" : "Copy URL"}</Button>
					</div>
					<p class="max-w-full select-all break-all font-mono text-[11px] text-text-muted" data-testid="codex-login-url">{loginUrl}</p>
				{:else}<p class="text-text-muted">Waiting for the sign-in link…</p>{/if}
				{#if auth.login.deadlineAtMs !== undefined}<p class="text-text-muted" data-testid="codex-login-deadline">Complete sign-in by <time datetime={new Date(auth.login.deadlineAtMs).toISOString()}>{new Date(auth.login.deadlineAtMs).toLocaleTimeString()}</time></p>{/if}
				<Button touchTarget variant="secondary" size="sm" disabled={busy} data-testid="codex-login-cancel" onclick={() => void accountAuth.cancel()}>Cancel sign-in</Button>
			</div>
		{:else}
			{#if auth.login.state === "cancelled"}<p class="text-text-muted" data-testid="codex-login-result">Sign-in cancelled.</p>
			{:else if auth.login.state === "timed-out"}<p role="alert" class="text-warning" data-testid="codex-login-result">Sign-in timed out. Start again to get a new code or link.</p>
			{:else if auth.login.state === "error"}<p role="alert" class="text-error" data-testid="codex-login-result">{auth.login.error ?? "Sign-in failed. Try again."}</p>{/if}
			<div class="flex flex-wrap gap-2">
				<Button touchTarget variant="secondary" size="sm" disabled={busy} data-testid="codex-login-browser" onclick={() => void signIn("browser")}>Sign in with browser</Button>
				<Button touchTarget variant="secondary" size="sm" disabled={busy} data-testid="codex-login-device-code" onclick={() => void signIn("device-code")}>Use device code</Button>
				{#if auth.source === "codex-login"}<Button touchTarget variant="danger-outline" size="sm" disabled={busy} data-testid="codex-logout" onclick={() => void accountAuth.logout()}>Sign out</Button>{/if}
				<Button touchTarget variant="ghost-accent" size="sm" disabled={busy} data-testid="codex-auth-refresh" onclick={() => void accountAuth.refresh()}>Refresh status</Button>
			</div>
		{/if}
	{:else if fromEnvironment || error}
		<Button touchTarget variant="ghost-accent" size="sm" disabled={busy} data-testid="codex-auth-refresh" onclick={() => void accountAuth.refresh()}>Refresh status</Button>
	{/if}
</div>
