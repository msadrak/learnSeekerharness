/**
 * The UI dictionaries (Persian locale wave). English is the SOURCE: its
 * shape is the `Messages` type, and every other language must satisfy it
 * key-for-key (a missing Persian string is a compile error). Entries are
 * plain strings or functions (interpolation/plurals live in the function,
 * so each language words its own grammar).
 *
 * One file per area — common (shared vocabulary), shell (sidebar, home,
 * session list, dialogs, docks), chat (the transcript, composer, and
 * markdown chrome), cards (question/practice docks, plan blocks, transcript
 * artifact cards), graph (graph view, chains, coverage), settings.
 */

import type { UiLanguage } from "@/src/core";
import { common as en_common } from "./en/common.ts";
import { chat as en_chat } from "./en/chat.ts";
import { shell as en_shell } from "./en/shell.ts";
import { graph as en_graph } from "./en/graph.ts";
import { settings as en_settings } from "./en/settings.ts";
import { cards as en_cards } from "./en/cards.ts";
import { errors as en_errors } from "./en/errors.ts";
import { common as fa_common } from "./fa/common.ts";
import { chat as fa_chat } from "./fa/chat.ts";
import { shell as fa_shell } from "./fa/shell.ts";
import { graph as fa_graph } from "./fa/graph.ts";
import { settings as fa_settings } from "./fa/settings.ts";
import { cards as fa_cards } from "./fa/cards.ts";
import { errors as fa_errors } from "./fa/errors.ts";

export const en = {
	common: en_common,
	chat: en_chat,
	shell: en_shell,
	graph: en_graph,
	settings: en_settings,
	cards: en_cards,
	errors: en_errors,
};

export type Messages = typeof en;

export const fa: Messages = {
	common: fa_common,
	chat: fa_chat,
	shell: fa_shell,
	graph: fa_graph,
	settings: fa_settings,
	cards: fa_cards,
	errors: fa_errors,
};

export const MESSAGES: Record<UiLanguage, Messages> = { en, fa };
