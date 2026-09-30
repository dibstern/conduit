import { getContext, setContext } from "svelte";

type DialogTarget = () => HTMLDialogElement | null;
const dialogTargetKey = Symbol("dialog-target");

export function provideDialogTarget(target: DialogTarget): void {
	setContext(dialogTargetKey, target);
}

export function getDialogTarget(): DialogTarget | undefined {
	return getContext<DialogTarget>(dialogTargetKey);
}
