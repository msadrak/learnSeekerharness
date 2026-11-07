"use client";

import { useT } from "@/components/i18n";
import { textDirection } from "@/lib/i18n/direction";

/** Example learning goals under an empty teaching composer; a pick fills the
 *  composer (the caller owns the text and focus). */
export function ExampleChips({ onPick }: { onPick: (text: string) => void }) {
	const t = useT();
	return (
		<div
			role="group"
			aria-label={t.shell.newSession.examplesLabel}
			data-testid="example-chips"
			className="pointer-events-auto mt-2 flex flex-wrap justify-center gap-2"
		>
			{t.shell.newSession.examples.map((ex) => (
				<button
					key={ex}
					type="button"
					dir={textDirection(ex)}
					onClick={() => onPick(ex)}
					className="rounded-full border border-border px-3 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					{ex}
				</button>
			))}
		</div>
	);
}
