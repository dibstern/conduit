import { getContext, setContext } from "svelte";

const FIELD_KEY = Symbol("ui-field");

/** Live a11y wiring published by `Field` and consumed by the inputs. */
export type FieldContext = {
	/** Stable id for the control; `Field`'s <label for> targets it. */
	readonly inputId: string;
	/** id(s) for `aria-describedby` (error id if invalid, else hint id, else undefined). */
	readonly describedBy: string | undefined;
	readonly invalid: boolean;
	readonly required: boolean;
};

export const setFieldContext = (ctx: FieldContext): void => {
	setContext(FIELD_KEY, ctx);
};

export const getFieldContext = (): FieldContext | undefined =>
	getContext<FieldContext | undefined>(FIELD_KEY);
