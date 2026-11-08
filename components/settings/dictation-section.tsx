"use client";
/**
 * The Dictation section: the Deepgram key row, the dictation-language
 * setting and the Deepgram setup hint. Split out of the Providers section
 * (Phase 5): dictation is not a model provider. The row is the same
 * KeyTableRow, so the dictation error's deep link
 * (openSettings("dictation", DEEPGRAM_API_KEY)) unfolds it on arrival.
 */

import { DictationLanguageSetting } from "@/components/dictation-language";
import { useT } from "@/components/i18n";
import { SettingsGroup } from "./controls.tsx";
import { classifyKeys, ToolKeyRows } from "./keys-section.tsx";
import { useKeyStatuses } from "./use-key-statuses.ts";

export function DictationSection({ initialRow }: { initialRow?: string }) {
	const k = useT().settings.keys;
	const ks = useKeyStatuses();
	if (ks.statuses === null) {
		return <p className="p-6 text-xs text-muted-foreground">{k.loading}</p>;
	}
	const { toolRows } = classifyKeys(ks.statuses, ks.providers);
	return (
		<SettingsGroup label={k.dictation} testid="group-dictation">
			<ToolKeyRows statuses={toolRows.filter((status) => status.id === "DEEPGRAM_API_KEY")} ks={ks} initialRow={initialRow} />
			<DictationLanguageSetting />
			<p data-testid="dictation-setup-hint" className="px-3 text-xs leading-relaxed text-muted-foreground">
				{k.deepgramHintBefore}<a
					href="https://console.deepgram.com/"
					target="_blank"
					rel="noreferrer"
					className="text-brand underline-offset-2 hover:underline"
				>{k.deepgramHintLink}</a>{k.deepgramHintAfter}
			</p>
		</SettingsGroup>
	);
}
