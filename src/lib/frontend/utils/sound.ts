// ─── Sound Notification ──────────────────────────────────────────────────────
// Synthesized tone via Web Audio API. No audio files needed.
// Pattern from claude-relay (notifications.js:24-39).

let audioCtx: AudioContext | null = null;

/** Prepare audio before asking the worker to hand over delivery ownership. */
export async function readyDoneSound(): Promise<void> {
	audioCtx ??= new AudioContext();
	if (audioCtx.state === "suspended") await audioCtx.resume();
	if (audioCtx.state !== "running")
		throw new DOMException(
			`AudioContext is ${audioCtx.state}: the ding cannot play`,
			"InvalidStateError",
		);
}

/**
 * Play the notification tone (880 Hz sine wave, 300ms, 10% volume).
 * Only call this once `readyDoneSound()` has resolved.
 */
export function emitDoneSound(): void {
	const ctx = audioCtx;
	if (!ctx || ctx.state !== "running")
		throw new DOMException(
			"readyDoneSound() must resolve before emitDoneSound()",
			"InvalidStateError",
		);

	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = "sine";
	osc.frequency.value = 880;
	gain.gain.value = 0.1;
	osc.connect(gain);
	gain.connect(ctx.destination);
	gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
	osc.start();
	osc.stop(ctx.currentTime + 0.3);
}
