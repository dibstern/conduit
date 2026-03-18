export interface RGB {
	r: number;
	g: number;
	b: number;
}

export function hexToRgb(hex: string): RGB {
	const h = hex.replace("#", "");
	if (!/^[0-9a-fA-F]{6}$/.test(h)) {
		return { r: 0, g: 0, b: 0 };
	}
	return {
		r: parseInt(h.substring(0, 2), 16),
		g: parseInt(h.substring(2, 4), 16),
		b: parseInt(h.substring(4, 6), 16),
	};
}

export function rgbToHex(r: number, g: number, b: number): string {
	return (
		"#" +
		[r, g, b]
			.map((v) => {
				const c = Math.max(0, Math.min(255, Math.round(v)));
				return c.toString(16).padStart(2, "0");
			})
			.join("")
	);
}

export function darken(hex: string, amount: number): string {
	const c = hexToRgb(hex);
	const f = 1 - amount;
	return rgbToHex(c.r * f, c.g * f, c.b * f);
}

export function lighten(hex: string, amount: number): string {
	const c = hexToRgb(hex);
	return rgbToHex(
		c.r + (255 - c.r) * amount,
		c.g + (255 - c.g) * amount,
		c.b + (255 - c.b) * amount,
	);
}

export function mixColors(hex1: string, hex2: string, weight: number): string {
	const c1 = hexToRgb(hex1);
	const c2 = hexToRgb(hex2);
	return rgbToHex(
		c1.r * weight + c2.r * (1 - weight),
		c1.g * weight + c2.g * (1 - weight),
		c1.b * weight + c2.b * (1 - weight),
	);
}

export function hexToRgba(hex: string, alpha: number): string {
	const c = hexToRgb(hex);
	return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

export function luminance(hex: string): number {
	const c = hexToRgb(hex);
	return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
}
