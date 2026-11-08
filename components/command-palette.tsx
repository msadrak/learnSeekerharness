"use client";

/**
 * Mod+P command palette — one searchable list over the app's actions,
 * sessions, graph propositions and settings sections. Sessions and the graph
 * snapshot are fetched once per open (a failed fetch leaves that group
 * empty); every selection closes the palette first, then acts.
 */

import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLocale, useT } from "@/components/i18n";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { textDirection } from "@/lib/i18n/direction";
import { kbdEventForAction, propositionSessionHref } from "@/src/core";
import type { ChatListItem, GraphNode, GraphSnapshot } from "@/src/core";

/** Settings sections in the Settings dialog's nav order. */
const SETTINGS_SECTION_IDS = ["keys", "dictation", "search", "agent", "appearance", "graph", "keyboard", "general"] as const;

const ITEM_CLASS =
	"flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors duration-150 motion-reduce:transition-none data-[selected=true]:bg-accent";
const GROUP_CLASS =
	"[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground";

interface PropositionEntry {
	node: GraphNode;
	chatId: string;
}

function propositionEntries(snapshot: GraphSnapshot | null): PropositionEntry[] {
	if (!snapshot) return [];
	const entries: PropositionEntry[] = [];
	for (const node of snapshot.propositions) {
		const chatId = snapshot.nodeSessions[node.id]?.find((id) => id in snapshot.sessions);
		if (chatId !== undefined) entries.push({ node, chatId });
	}
	return entries;
}

export function CommandPalette({
	open,
	onOpenChange,
	onCheatSheet,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCheatSheet: () => void;
}) {
	const t = useT();
	const p = t.shell.palette;
	const { dir } = useLocale();
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const [chats, setChats] = useState<ChatListItem[]>([]);
	const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
	const [loading, setLoading] = useState(false);

	// One fetch pair per open; a failed fetch leaves its group empty.
	useEffect(() => {
		if (!open) return;
		const controller = new AbortController();
		setChats([]);
		setSnapshot(null);
		setLoading(true);
		const chatsRequest = fetch("/api/chats", { cache: "no-store", signal: controller.signal })
			.then((res) => (res.ok ? (res.json() as Promise<{ chats?: ChatListItem[] }>) : null))
			.then((body) => {
				if (!controller.signal.aborted && Array.isArray(body?.chats)) setChats(body.chats);
			})
			.catch(() => {});
		const graphRequest = fetch("/api/graph", { cache: "no-store", signal: controller.signal })
			.then((res) => (res.ok ? (res.json() as Promise<GraphSnapshot>) : null))
			.then((body) => {
				if (!controller.signal.aborted && body && Array.isArray(body.propositions)) setSnapshot(body);
			})
			.catch(() => {});
		void Promise.all([chatsRequest, graphRequest]).then(() => {
			if (!controller.signal.aborted) setLoading(false);
		});
		return () => controller.abort();
	}, [open]);

	const run = (action: () => void) => () => {
		onOpenChange(false);
		action();
	};

	const actions = t.shell.keyboard.actions;
	const propositions = propositionEntries(snapshot);

	return (
		<Command.Dialog
			open={open}
			onOpenChange={onOpenChange}
			label={p.title}
			dir={dir}
			overlayClassName="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]"
			contentClassName="fixed start-1/2 top-[15vh] z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 rtl:translate-x-1/2 rounded-xl border bg-popover p-2 shadow-float"
		>
			<Command.Input
				placeholder={p.placeholder}
				className="lh-input mb-1 w-full rounded-lg border bg-card/50 px-3 py-2 font-ui text-sm outline-none focus-visible:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40"
			/>
			<Command.List className="max-h-80 overflow-y-auto">
				<Command.Empty className="px-3 py-4 text-center text-xs text-muted-foreground">{p.empty}</Command.Empty>
				{loading && (
					<Command.Loading>
						<div className="px-3 py-2 text-xs text-muted-foreground">{t.common.states.loading}</div>
					</Command.Loading>
				)}
				<Command.Group heading={p.groups.actions} className={GROUP_CLASS}>
					<Command.Item value="action:new-teaching" keywords={[p.newTeaching]} className={ITEM_CLASS} onSelect={run(() => router.push("/chat/new"))}>
						{p.newTeaching}
					</Command.Item>
					<Command.Item value="action:new-practice" keywords={[p.newPractice]} className={ITEM_CLASS} onSelect={run(() => router.push("/chat/new?mode=practice"))}>
						{p.newPractice}
					</Command.Item>
					<Command.Item value="action:open-graph" keywords={[p.openGraph]} className={ITEM_CLASS} onSelect={run(() => router.push("/"))}>
						{p.openGraph}
					</Command.Item>
					<Command.Item value="action:open-settings" keywords={[actions["open-settings"]]} className={ITEM_CLASS} onSelect={run(() => openSettings())}>
						{actions["open-settings"]}
					</Command.Item>
					<Command.Item
						value="action:open-model-picker"
						keywords={[actions["open-model-picker"]]}
						className={ITEM_CLASS}
						onSelect={run(() => window.dispatchEvent(new CustomEvent(kbdEventForAction("open-model-picker"))))}
					>
						{actions["open-model-picker"]}
					</Command.Item>
					<Command.Item value="action:cheat-sheet" keywords={[actions["cheat-sheet"]]} className={ITEM_CLASS} onSelect={run(onCheatSheet)}>
						{actions["cheat-sheet"]}
					</Command.Item>
				</Command.Group>
				{chats.length > 0 && (
					<Command.Group heading={p.groups.sessions} className={GROUP_CLASS}>
						{chats.map((chat) => (
							<Command.Item
								key={chat.id}
								value={`session:${chat.id}`}
								keywords={[chat.title]}
								className={ITEM_CLASS}
								onSelect={run(() => router.push(`/chat/${chat.id}`))}
							>
								<span dir={textDirection(chat.title)} className="truncate">{chat.title}</span>
							</Command.Item>
						))}
					</Command.Group>
				)}
				{propositions.length > 0 && (
					<Command.Group heading={p.groups.propositions} className={GROUP_CLASS}>
						{propositions.map(({ node, chatId }) => (
							<Command.Item
								key={node.id}
								value={`prop:${node.id}`}
								keywords={[node.name, node.statement]}
								className={ITEM_CLASS}
								onSelect={run(() => router.push(propositionSessionHref(node, chatId)))}
							>
								<span dir={textDirection(node.name)} className="truncate">{node.name}</span>
							</Command.Item>
						))}
					</Command.Group>
				)}
				<Command.Group heading={p.groups.settings} className={GROUP_CLASS}>
					{SETTINGS_SECTION_IDS.map((id) => (
						<Command.Item
							key={id}
							value={`settings:${id}`}
							keywords={[t.settings.dialog.nav[id]]}
							className={ITEM_CLASS}
							onSelect={run(() => openSettings(id))}
						>
							{t.settings.dialog.nav[id]}
						</Command.Item>
					))}
				</Command.Group>
			</Command.List>
		</Command.Dialog>
	);
}
