<!-- Rain on the dot grid behind the connect overlay; every few seconds one drop lands on the logo tile. -->
<script lang="ts">
	import { MediaQuery } from "svelte/reactivity";

	let { tile, onhit }: { tile: HTMLElement | undefined; onhit: () => void } = $props();

	type Drop = { x: number; y: number; t: number; speed: number; strength: number; life: number; onTile: boolean; landed: boolean };

	const PITCH = 16;
	const FALL_S = 0.2;
	const FADE_S = 2.2;
	const rand = (min: number, max: number) => min + Math.random() * (max - min);

	let canvas: HTMLCanvasElement;
	const reduced = new MediaQuery("(prefers-reduced-motion: reduce)");

	$effect(() => {
		const still = reduced.current;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		let width = 0;
		let height = 0;
		let frame = 0;
		const drops: Drop[] = [];
		let time = 0;
		let nextDrop = 0.3;
		let nextTileDrop = 1.4;
		// Date.now, not the frame timestamp: the visual suite pins the clock, which holds the rain on its still grid.
		let last = Date.now();

		const draw = () => {
			const ink = getComputedStyle(canvas).color;
			ctx.clearRect(0, 0, width, height);
			ctx.fillStyle = ink;
			ctx.strokeStyle = ink;
			for (let x = (width % PITCH) / 2 + PITCH / 2; x < width; x += PITCH) {
				for (let y = (height % PITCH) / 2 + PITCH / 2; y < height; y += PITCH) {
					let energy = 0;
					for (const d of drops) {
						const age = time - d.t;
						if (age < 0) continue;
						const ring = (Math.hypot(x - d.x, y - d.y) - age * d.speed) / 7;
						energy += Math.exp(-ring * ring) * Math.max(0, 1 - age / FADE_S) * d.strength;
					}
					ctx.globalAlpha = Math.min(1, 0.16 + energy * 0.75);
					ctx.beginPath();
					ctx.arc(x, y, 0.9 + energy * 1.6, 0, 2 * Math.PI);
					ctx.fill();
				}
			}
			for (const d of drops) {
				const age = time - d.t;
				if (age < 0) {
					const fall = 46 * (-age / FALL_S);
					ctx.globalAlpha = 0.7;
					ctx.lineWidth = 1.5;
					ctx.beginPath();
					ctx.moveTo(d.x, d.y - fall - 10);
					ctx.lineTo(d.x, d.y - fall);
					ctx.stroke();
				} else if (age < d.life) {
					ctx.globalAlpha = 0.4 * d.strength * (1 - age / d.life);
					ctx.lineWidth = 1;
					ctx.beginPath();
					ctx.arc(d.x, d.y, age * d.speed, 0, 2 * Math.PI);
					ctx.stroke();
				}
			}
			ctx.globalAlpha = 1;
		};

		const step = () => {
			const now = Date.now();
			// Clamped so a backgrounded tab resumes where it left off instead of dumping a storm.
			const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
			last = now;
			time += dt;
			nextDrop -= dt;
			nextTileDrop -= dt;
			if (nextDrop < 0) {
				nextDrop = -Math.log(Math.random()) * 0.7;
				drops.push({ x: rand(10, width - 10), y: rand(10, height - 10), t: time + FALL_S, speed: 85, strength: 1, life: 1.1, onTile: false, landed: false });
			}
			if (nextTileDrop < 0 && tile) {
				nextTileDrop = rand(2.6, 3.6);
				const box = tile.getBoundingClientRect();
				const origin = canvas.getBoundingClientRect();
				const x = box.left - origin.left + box.width / 2 + rand(-18, 18);
				const y = box.top - origin.top + box.height / 2 + rand(-18, 18);
				drops.push({ x, y, t: time + FALL_S, speed: 150, strength: 1.4, life: 1.6, onTile: true, landed: false });
			}
			for (let i = drops.length - 1; i >= 0; i--) {
				const d = drops[i];
				if (!d) continue;
				const age = time - d.t;
				if (age > FADE_S) drops.splice(i, 1);
				else if (d.onTile && !d.landed && age >= 0) {
					d.landed = true;
					onhit();
				}
			}
			draw();
			frame = requestAnimationFrame(step);
		};

		const observer = new ResizeObserver(() => {
			const ratio = devicePixelRatio || 1;
			width = canvas.clientWidth;
			height = canvas.clientHeight;
			canvas.width = width * ratio;
			canvas.height = height * ratio;
			ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
			draw();
		});
		observer.observe(canvas);
		if (!still) frame = requestAnimationFrame(step);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	});
</script>

<canvas bind:this={canvas} class="absolute inset-0 w-full h-full pointer-events-none text-accent" aria-hidden="true"></canvas>
