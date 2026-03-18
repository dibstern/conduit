/**
 * Augment Navigator with the non-standard iOS Safari `standalone` property.
 * @see https://developer.apple.com/documentation/webkitjs/navigator/1382801-standalone
 */
interface Navigator {
	readonly standalone?: boolean;
}
