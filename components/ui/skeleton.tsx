import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="skeleton"
			aria-hidden="true"
			className={cn("animate-pulse motion-reduce:animate-none rounded-lg bg-accent/70", className)}
			{...props}
		/>
	);
}
