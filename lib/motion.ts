/** True when the OS asks for reduced motion. Safe on the server (false). */
export function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
