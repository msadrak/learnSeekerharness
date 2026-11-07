/**
 * Keyboard-only focus ring (the stray-ring case the no-ring law in
 * app/globals.css was written against). The ring shows once the user has
 * navigated by keyboard (`html[data-kbd-nav]`) and never on an element that
 * received focus from a pointer press (`[data-pointer-focus]`).
 *
 * Capture-phase listeners on `document`, so they observe events that
 * component handlers or the window-level shortcut dispatcher claim.
 */

/** True between a pointerdown and the focusin it causes. */
let armed = false;

export function installFocusVisibility(): () => void {
	const root = document.documentElement;
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Tab" || e.key.startsWith("Arrow")) root.dataset.kbdNav = "";
	};
	const onPointerDown = () => {
		delete root.dataset.kbdNav;
		armed = true;
	};
	const onFocusIn = (e: FocusEvent) => {
		if (!armed) return;
		armed = false;
		if (e.target instanceof Element) e.target.setAttribute("data-pointer-focus", "");
	};
	const onFocusOut = (e: FocusEvent) => {
		if (e.target instanceof Element) e.target.removeAttribute("data-pointer-focus");
	};
	document.addEventListener("keydown", onKeyDown, true);
	document.addEventListener("pointerdown", onPointerDown, true);
	document.addEventListener("focusin", onFocusIn, true);
	document.addEventListener("focusout", onFocusOut, true);
	return () => {
		document.removeEventListener("keydown", onKeyDown, true);
		document.removeEventListener("pointerdown", onPointerDown, true);
		document.removeEventListener("focusin", onFocusIn, true);
		document.removeEventListener("focusout", onFocusOut, true);
	};
}
