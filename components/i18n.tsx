"use client";
/**
 * The UI-language hooks (Persian locale wave). The language is an
 * appearance setting, so it rides the AppearanceProvider: the root layout
 * seeds it server-side (no English flash, <html lang/dir> correct on the
 * first frame) and a settings write switches it live.
 *
 * Outside the provider (render tests) the context default resolves to the
 * factory language — English.
 */

import type { UiLanguage } from "@/src/core";
import { languageDirection, type TextDirection } from "@/lib/i18n/direction";
import { MESSAGES, type Messages } from "@/lib/i18n/messages";
import { useAppearance } from "@/components/settings/appearance";

export type { Messages };

/** The active UI language and its writing direction. */
export function useLocale(): { language: UiLanguage; dir: TextDirection } {
	const { language } = useAppearance().appearance;
	return { language, dir: languageDirection(language) };
}

/** The active dictionary: `const t = useT(); t.common.actions.cancel`. */
export function useT(): Messages {
	return MESSAGES[useAppearance().appearance.language];
}
