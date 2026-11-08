"use client";

import { Toaster } from "sonner";
import { useLocale } from "@/components/i18n";
import { useAppearance } from "@/components/settings/appearance";

/** The app's one toast outlet: themed from the resolved scheme, mirrored in
 *  RTL (bottom-left there, so it clears the sidebar-on-the-right layout). */
export function AppToaster() {
	const { scheme } = useAppearance();
	const { dir } = useLocale();
	return (
		<Toaster
			theme={scheme}
			dir={dir}
			position={dir === "rtl" ? "bottom-left" : "bottom-right"}
			closeButton
			toastOptions={{ classNames: { toast: "font-ui text-xs !rounded-xl !shadow-float", description: "text-muted-foreground" } }}
			style={
				{
					"--normal-bg": "var(--card)",
					"--normal-text": "var(--card-foreground)",
					"--normal-border": "var(--border)",
					"--border-radius": "18px",
				} as React.CSSProperties
			}
		/>
	);
}
