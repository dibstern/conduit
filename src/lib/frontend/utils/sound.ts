// ─── Sound Notification ──────────────────────────────────────────────────────
// Synthesized tone via Web Audio API. No audio files needed.
// Pattern from claude-relay (notifications.js:24-39).

let audioCtx: AudioContext | null = null;

/**
 * Play a short notification tone (880 Hz sine wave, 300ms, 10% volume).
 * AudioContext is created lazily on first call. The `resume()` call succeeds
 * because the user has previously interacted with the page (toggling settings,
 * typing messages), which satisfies Chrome's autoplay policy.
 */
export function playDoneSound(): void {
	try {
		if (!audioCtx) {
			audioCtx = new AudioContext();
		}
		if (audioCtx.state === "suspended") {
			audioCtx.resume();
		}

		const osc = audioCtx.createOscillator();
		const gain = audioCtx.createGain();
		osc.type = "sine";
		osc.frequency.value = 880;
		gain.gain.value = 0.1;
		osc.connect(gain);
		gain.connect(audioCtx.destination);
		osc.start();
		gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
		osc.stop(audioCtx.currentTime + 0.3);
	} catch {
		// Silently ignore — AudioContext may not be available
	}
}
