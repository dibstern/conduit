/** Self-contained so Playwright can evaluate it in the page as well as Storybook. */
export function inspectTouchTarget(control: Element, minimum: number) {
	const box = control.getBoundingClientRect();
	const before = getComputedStyle(control, "::before");
	const hasTarget = before.content !== "none" && before.display !== "none";
	let origin = control;
	if (getComputedStyle(control).position === "static") {
		for (
			let parent = control.parentElement;
			parent;
			parent = parent.parentElement
		) {
			if (getComputedStyle(parent).position !== "static") {
				origin = parent;
				break;
			}
		}
	}
	const originBox = origin.getBoundingClientRect();
	const style = getComputedStyle(origin);
	const width = hasTarget ? Number.parseFloat(before.width) : box.width;
	const height = hasTarget ? Number.parseFloat(before.height) : box.height;
	const translate =
		before.translate === "none" ? ["0", "0"] : before.translate.split(" ");
	const offsetX =
		Number.parseFloat(translate[0] ?? "0") *
		(translate[0]?.endsWith("%") ? width / 100 : 1);
	const offsetY =
		Number.parseFloat(translate[1] ?? "0") *
		(translate[1]?.endsWith("%") ? height / 100 : 1);
	const left = hasTarget
		? originBox.left +
			Number.parseFloat(style.borderLeftWidth) +
			Number.parseFloat(before.left) +
			offsetX
		: box.left;
	const top = hasTarget
		? originBox.top +
			Number.parseFloat(style.borderTopWidth) +
			Number.parseFloat(before.top) +
			offsetY
		: box.top;
	const firstX = Math.ceil(left + width / 2) - minimum / 2;
	const firstY = Math.ceil(top + height / 2) - minimum / 2;
	const failures: { x: number; y: number; owner: string | null }[] = [];
	let missing = 0;
	// Probe every owned pixel, including all four edges. Distinct controls
	// cannot both pass for the same point. Stay inside fractional CSS edges.
	for (let x = firstX; x < firstX + minimum; x++) {
		for (let y = firstY; y < firstY + minimum; y++) {
			const hit = document.elementFromPoint(x, y);
			if (!control.contains(hit)) {
				missing++;
				if (failures.length < 5)
					failures.push({
						x,
						y,
						owner:
							hit?.closest("button")?.getAttribute("data-testid") ??
							hit?.tagName ??
							null,
					});
			}
		}
	}
	return {
		width,
		height,
		left,
		top,
		firstX,
		firstY,
		minimum,
		missing,
		failures,
	};
}
