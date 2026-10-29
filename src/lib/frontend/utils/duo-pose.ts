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

/** The right-edge strip every pose but unfolded portrait shows, with no left inset. */
const hasStrip = ({ right, left }: PoseInput["insets"]): boolean =>
	right >= 76 && right <= 92 && left < NO_INSET;

const stripPose = (portrait: boolean, width: number): DuoPose | null => {
	if (portrait) return width < 600 ? "duo-folded-portrait" : null;
	return width < 768 ? "duo-folded-landscape" : "duo-unfolded-landscape";
};

/** Unfolded portrait's top status bar, no side insets, at its 600-767 width. */
const isUnfoldedPortraitBand = (
	width: number,
	{ top, right, left }: PoseInput["insets"],
): boolean =>
	right < NO_INSET &&
	left < NO_INSET &&
	top >= 55 &&
	top <= 67 &&
	width >= 600 &&
	width < 768;

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
	if (hasStrip(insets)) return stripPose(portrait, width);
	return portrait && isUnfoldedPortraitBand(width, insets)
		? "duo-unfolded-portrait"
		: null;
}
