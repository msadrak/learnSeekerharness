/** Polite screen-reader announcement. Keying the span on `seq` remounts it
 *  per announcement, so repeating the same message is announced again. */
export function LiveAnnouncer({ message, seq }: { message: string; seq: number }) {
	return (
		<div role="status" aria-live="polite" className="sr-only">
			<span key={seq}>{message}</span>
		</div>
	);
}
