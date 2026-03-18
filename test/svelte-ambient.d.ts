// ─── Svelte 5 Rune Ambient Types ─────────────────────────────────────────────
// These declarations let tsc understand $state/$derived/$effect in .svelte.ts
// files when type-checking test files that import them.
// The actual runtime transformation is handled by the Svelte Vite plugin.

declare function $state<T>(initial: T): T;
declare function $state<T>(): T | undefined;
declare namespace $state {
	export function raw<T>(initial: T): T;
	export function raw<T>(): T | undefined;
	export function snapshot<T>(value: T): T;
}

declare function $derived<T>(expression: T): T;
declare namespace $derived {
	export function by<T>(fn: () => T): T;
}

declare function $effect(fn: () => undefined | (() => void)): void;
declare namespace $effect {
	export function pre(fn: () => undefined | (() => void)): void;
	export function root(fn: () => () => void): () => void;
}

declare function $props<T>(): T;
declare function $bindable<T>(initial?: T): T;
