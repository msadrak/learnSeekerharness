import type { Metadata } from "next";
import { JetBrains_Mono, Source_Sans_3, Vazirmatn } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { languageDirection } from "@/lib/i18n/direction";
import { resolveSettings } from "@/src/core";
import { readSettingsRecord } from "@/src/server";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN). Persian
// glyphs in all three fall through to Vazirmatn (globals.css stacks);
// next/font self-hosts it at build time, so the desktop app stays offline.
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });
const persian = Vazirmatn({ subsets: ["arabic"], variable: "--font-vazirmatn" });

// Dynamic: <html lang/dir> comes from the settings record on every request
// (a prerendered shell would freeze the build machine's language).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	const record = readSettingsRecord();
	const appearance = record?.appearance;
	const language = resolveSettings(record ?? null).appearance.language;
	return (
		// suppressHydrationWarning: browser extensions (Grammarly, asbplayer …)
		// inject attributes into <html>/<body> before React hydrates. One level
		// deep only — mismatches inside the app still report.
		<html
			lang={language}
			dir={languageDirection(language)}
			className={`dark ${ui.variable} ${prose.variable} ${persian.variable}`}
			suppressHydrationWarning
		>
			<body className="min-h-dvh antialiased" suppressHydrationWarning>
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider initialAppearance={appearance}>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
		</body>
		</html>
	);
}
