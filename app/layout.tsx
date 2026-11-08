import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Source_Sans_3, Vazirmatn } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { AppToaster } from "@/components/ui/sonner";
import { InlineScript } from "@/components/inline-script";
import { languageDirection } from "@/lib/i18n/direction";
import { MESSAGES } from "@/lib/i18n/messages";
import { resolveSettings } from "@/src/core";
import { readSettingsRecord } from "@/src/server";

// Chrome = Inter, teaching prose = Source Sans 3, titles = CMU, mono =
// JetBrains Mono (code/keys/numbers only)
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN). Persian
// glyphs in all three fall through to Vazirmatn (globals.css stacks);
// next/font self-hosts it at build time, so the desktop app stays offline.
const sans = Inter({ subsets: ["latin"], variable: "--font-inter" });
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });
const persian = Vazirmatn({ subsets: ["arabic"], variable: "--font-vazirmatn" });

// "system" mode: the server can't know the OS scheme, so it renders dark and
// this script flips <html> to light before first paint (no flash on reload).
const SYSTEM_SCHEME_SCRIPT = `(function(){try{if(window.matchMedia("(prefers-color-scheme: light)").matches){var c=document.documentElement.classList;c.remove("dark");c.add("light");}}catch(e){}})()`;

// Dynamic: <html lang/dir> comes from the settings record on every request
// (a prerendered shell would freeze the build machine's language).
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
	const { language } = resolveSettings(readSettingsRecord() ?? null).appearance;
	const { title, description } = MESSAGES[language].shell.meta;
	return { title, description };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
	const record = readSettingsRecord();
	const appearance = resolveSettings(record ?? null).appearance;
	const language = appearance.language;
	return (
		// suppressHydrationWarning: browser extensions (Grammarly, asbplayer …)
		// inject attributes into <html>/<body> before React hydrates. One level
		// deep only — mismatches inside the app still report.
		<html
			lang={language}
			dir={languageDirection(language)}
			className={`${appearance.mode === "light" ? "light" : "dark"} ${sans.variable} ${ui.variable} ${prose.variable} ${persian.variable}`}
			suppressHydrationWarning
		>
			<head>{appearance.mode === "system" && <InlineScript html={SYSTEM_SCHEME_SCRIPT} />}</head>
			<body className="min-h-dvh antialiased" suppressHydrationWarning>
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider initialAppearance={record?.appearance}>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
					<AppToaster />
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
		</body>
		</html>
	);
}
