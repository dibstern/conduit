/**
 * The iPhone Duo's four poses, recognised from the installed PWA's viewport and
 * safe-area insets. Thresholds bracket the on-device probe (iOS 27, standalone,
 * dpr 3), where insets are T/R/B/L:
 *
 *   folded portrait     466x657  0/84/34/0
 *   folded landscape    678x445  0/84/34/0
 *   unfolded landscape  951x648  0/84/34/0
 *   unfolded portrait   669x930  61/0/34/0
 *
 * Anything outside the bands is null, so an unknown device or a future iOS
 * falls back to the ordinary layout rather than a wrong pose.
 */

export type DuoPose =
	| "duo-folded-portrait"
	| "duo-folded-landscape"
	| "duo-unfolded-landscape"
	| "duo-unfolded-portrait";

export type PoseInput = {
	/** Layout viewport, which the keyboard leaves alone. */
	width: number;
	height: number;
	standalone: boolean;
	insets: { top: number; right: number; bottom: number; left: number };
};

/** Below this an inset counts as absent; landscape iPhone notches sit far above it. */
const NO_INSET = 8;

export function classifyDuoPose({
	width,
	height,
	standalone,
	insets,
}: PoseInput): DuoPose | null {
	if (!standalone) return null;
	// Orientation comes from the same size it is checked against, so a rotation
	// frame can never pair one pose's orientation with another's width.
	const portrait = height >= width;
	if (insets.right >= 76 && insets.right <= 92 && insets.left < NO_INSET) {
		if (portrait) return width < 600 ? "duo-folded-portrait" : null;
		return width < 768 ? "duo-folded-landscape" : "duo-unfolded-landscape";
	}
	if (
		portrait &&
		insets.right < NO_INSET &&
		insets.left < NO_INSET &&
		insets.top >= 55 &&
		insets.top <= 67 &&
		width >= 600 &&
		width < 768
	)
		return "duo-unfolded-portrait";
	return null;
}
