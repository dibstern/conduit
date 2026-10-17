<script lang="ts">
	import { onMount } from "svelte";
	import { changeCursorAuth, cursorAuth, refreshCursorAuth } from "../../stores/cursor-auth.svelte.js";
	import { PROVIDER_PRESENTATION } from "../../utils/provider-presentation.js";
	import AccountDot from "../ui/AccountDot.svelte";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";

	let { account }: { account?: { id: string; name: string; isDefault?: boolean } | undefined } = $props();
	const copy = PROVIDER_PRESENTATION.cursor.auth;
	const auth = $derived(cursorAuth.current);
	const pending = $derived(auth?.login.state === "pending");
	const fromEnvironment = $derived(auth?.source === "environment");
	const loginUrl = $derived.by(() => {
		if (!pending || !auth?.login.url) return undefined;
		try {
			const url = new URL(auth.login.url);
			return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
		} catch {
			return undefined;
		}
	});

	onMount(() => { void refreshCursorAuth(); });
	$effect(() => {
		const timer = setInterval(() => { void refreshCursorAuth(); }, pending ? 1_000 : 30_000);
		return () => clearInterval(timer);
	});
</script>

<SettingsGroup title={copy.title} testId="cursor-accounts-list">
	<div class="flex flex-col gap-2 px-[14px] py-[10px] text-[12px] leading-[1.4]" data-testid={account ? `instance-row-${account.id}` : "cursor-auth-account"} data-driver="cursor">
		{#if account}
			<div class="flex min-w-0 items-center gap-2 text-[13.5px] text-text max-md:text-[15px]">
				<AccountDot instanceId={account.id} size={9} />
				<span class="truncate">{account.name}</span>
				{#if account.isDefault}<Badge variant="quiet" size="xs" shape="pill" data-testid="default-account-marker">default</Badge>{/if}
			</div>
		{/if}
		<div role="status" aria-live="polite" data-testid="cursor-auth-status" class="text-text-secondary">
			{#if fromEnvironment}{copy.environment}
			{:else if auth?.status === "logged-in"}{copy.loggedIn}{auth.email ? ` as ${auth.email}` : ""}
			{:else if auth?.status === "error"}{auth.error ?? "Could not check login status."}
			{:else if auth}{copy.loggedOut}
			{:else}Checking login status…{/if}
		</div>
		{#if fromEnvironment && auth?.status === "error" && auth.error}
			<p role="alert" data-testid="cursor-auth-error" class="text-error">{auth.error}</p>
		{/if}
		{#if !fromEnvironment && auth?.apiKeyExpiresAtMs !== undefined}
			<p data-testid="cursor-auth-expiry" class="text-text-muted">Key expires <time datetime={new Date(auth.apiKeyExpiresAtMs).toISOString()}>{new Date(auth.apiKeyExpiresAtMs).toLocaleString()}</time></p>
		{/if}
		{#if !fromEnvironment && auth?.expiresSoon}
			<p role="alert" data-testid="cursor-auth-expiry-warning" class="text-warning">{copy.expiryWarning}</p>
		{/if}
		{#if cursorAuth.error}<p role="alert" class="text-error">{cursorAuth.error}</p>{/if}
		{#if !fromEnvironment && auth}
			{#if pending}
				<div class="flex flex-col items-start gap-2" data-testid="cursor-login-prompt">
					<p class="text-text-muted">{copy.pending}</p>
					{#if loginUrl}
						<Button touchTarget variant="primary" size="sm" href={loginUrl} target="_blank" rel="noopener noreferrer" data-testid="cursor-login-link">{copy.openLogin}</Button>
						<p class="max-w-full break-all font-mono text-[11px] text-text-muted" data-testid="cursor-login-url">{loginUrl}</p>
					{:else}<p class="text-text-muted">Waiting for the login link…</p>{/if}
					{#if auth?.login.deadlineAtMs !== undefined}<p data-testid="cursor-login-deadline" class="text-text-muted">Complete login by <time datetime={new Date(auth.login.deadlineAtMs).toISOString()}>{new Date(auth.login.deadlineAtMs).toLocaleTimeString()}</time></p>{/if}
					<Button touchTarget variant="secondary" size="sm" disabled={cursorAuth.busy} data-testid="cursor-login-cancel" onclick={() => void changeCursorAuth("CancelCursorLogin")}>{copy.cancel}</Button>
				</div>
			{:else}
				{#if auth?.login.state === "cancelled"}<p data-testid="cursor-login-result" class="text-text-muted">Login cancelled.</p>
				{:else if auth?.login.state === "timed-out"}<p role="alert" data-testid="cursor-login-result" class="text-warning">Login timed out. Start again to get a new link.</p>
				{:else if auth?.login.state === "error"}<p role="alert" data-testid="cursor-login-result" class="text-error">{auth.login.error ?? "Login failed. Try again."}</p>{/if}
				<div class="flex flex-wrap gap-2">
					<Button touchTarget variant="secondary" size="sm" disabled={cursorAuth.busy} data-testid="cursor-login-start" onclick={() => void changeCursorAuth("StartCursorLogin")}>{copy.login}</Button>
					{#if auth?.source === "sdk-login"}<Button touchTarget variant="danger-outline" size="sm" disabled={cursorAuth.busy} data-testid="cursor-logout" onclick={() => void changeCursorAuth("LogoutCursor")}>{copy.logout}</Button>{/if}
					<Button touchTarget variant="ghost-accent" size="sm" disabled={cursorAuth.busy} data-testid="cursor-auth-refresh" onclick={() => void refreshCursorAuth()}>Refresh status</Button>
				</div>
			{/if}
		{:else if !auth && cursorAuth.error}
			<Button touchTarget variant="secondary" size="sm" disabled={cursorAuth.busy} data-testid="cursor-auth-refresh" onclick={() => void refreshCursorAuth()}>Refresh status</Button>
		{/if}
	</div>
</SettingsGroup>
