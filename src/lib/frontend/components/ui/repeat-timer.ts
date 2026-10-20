/** Hold-to-repeat timing, shared by every control that repeats a key, so a
 *  held on-screen key feels like a held physical one everywhere. Each control
 *  decides when to start it; the timer only owns the delay and the rate. */
export const REPEAT_DELAY_MS = 400;
export const REPEAT_INTERVAL_MS = 50;

export function createRepeatTimer(): {
	start: (fire: () => void) => void;
	stop: () => void;
} {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		clearTimeout(timer);
		timer = undefined;
	};
	const start = (fire: () => void) => {
		stop();
		const tick = () => {
			fire();
			timer = setTimeout(tick, REPEAT_INTERVAL_MS);
		};
		timer = setTimeout(tick, REPEAT_DELAY_MS);
	};
	return { start, stop };
}
