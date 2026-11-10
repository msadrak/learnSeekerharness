# Getting started

Download LearnHarness from [learnharness.ai](https://learnharness.ai) or [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases). For running from source, see [Development](development.md).

## Connect models

Open **Settings → Providers** and configure a connection:

- **Provider API keys:** use your own account and pay that provider's rates.
- **Subscription connections:** ChatGPT, GitHub Copilot, and Grok use their respective sign-in flows and account limits. They do not silently fall back to API-key billing.
- **[Claude Code](claude-code.md):** use a separately installed and authenticated CLI. Its own configuration controls routing and billing; this is not a subscription-only guarantee.
- **[Custom endpoint](custom-providers.md):** connect one OpenAI-compatible server, including a local model server. LearnHarness does not install or download models.

Choose **Strong**, **Cheap**, and **Vision** models in Settings. There are no factory model selections. New sessions start with Strong; background roles use their assigned slots or role overrides. A model selected inside an existing session belongs to that session and does not change background-role choices.

Optional web search supports Tavily, Brave, Exa, Firecrawl, and hosted Ollama search; configure a key for the engine you want to use under **Settings → Search**. Research can still fetch known URLs without a search key. Dictation has its own service key below.

## Start a session

Choose **Teach** and describe what you want to understand. The agent probes your starting point, presents a plan, and teaches through explanations and checks. Reply naturally to accept or revise the plan.

Use the thinking fields to explain your reasoning, uncertainty, or reaction—not only your selected answer. You can type or dictate. Your confidence is self-reported, not an independent assessment.

Choose **Practice** for problems rather than a lesson. Start from selected graph material or describe material directly. Submit your thinking as you work; the model's committed solution is revealed when the problem concludes. Use **Next problem** when ready to continue.

Sessions are saved locally, including earlier messages when context is compacted. The [keyboard guide](keyboard.md) covers submission, focus, question controls, and cancellation.

## Dictation

1. Create a [Deepgram API key](https://console.deepgram.com/) with the **Member role or higher**, required for [short-lived token minting](https://developers.deepgram.com/reference/auth/tokens/grant).
2. Add it under **Settings → Dictation** and choose the language below the key. **Multilingual** supports automatic recognition and mixed-language speech.
3. Use the microphone or **Mod+D** to start and stop. Review the text before sending. **Esc cancellation discards the pending transcript**; stop normally to keep it.

Audio streams from your browser directly to Deepgram using a short-lived token. A `403 Insufficient permissions` error while obtaining that token can mean the key's role is insufficient.

## Read documents beside a session

Open the document viewer with the book button in the session's top bar (or **Mod+Shift+E**) and add a PDF, Word (`.docx`) or Markdown file with **Open document**, by dropping it on the panel, or with **Open in viewer** on a file path in the transcript.
Each document is a tab.
On the desktop the file stays where it is; in a plain browser it is uploaded and kept under your data folder (up to 100 MB).
Drag the divider to resize the panel.

Select a passage to **Explain** it, be **Quiz**zed on it, **Quote** it into your next message, or **Add to graph**.
The agent can read your documents, point to a passage (you get a **Go** prompt; your view never moves by itself), assign a reading that waits for **Done reading**, and propose highlights with notes.
A proposal changes your file only when you accept it: PDFs get a highlight annotation, Word files a comment, Markdown a `<mark>` plus a footnote.
Accepting rewrites the file, so close a Word file before accepting.

Scanned PDFs have no text to select.
Use the crop button in the viewer's header (or hold **Alt** and drag) to draw a rectangle on a page, then choose **Explain this section**, **Quiz me on this section** or **Quote**.
A vision model reads the rectangle into text and you can check and fix that text before it is sent; **Edit and resend** on the card in the chat sends a corrected version later.
Reading scans needs a model that accepts images: in Settings → Agent, open the per-role overrides under the vision tier and pick one for **Scan reader** (for example a Gemini 3 model through your Google Antigravity login); without one it uses the vision tier's model.

The agent can read scanned pages on its own too: ask about a chapter or topic in a scanned file and it names the section to the same vision model, which finds the pages (using the contents) and returns their text or a summary. Only the pages it needs are read, once: they are remembered for later questions. Section text is machine-read, so the agent treats it as possibly imperfect.

The agent can also propose a highlight with a note on a scanned page. A vision model places the box on the page image; you see it as a dashed box and accept or reject it like any other proposal, and accepting writes a normal highlight into your PDF. The placement is the model's best reading of the page, so check the box before accepting; a box that is off is simply rejected.

## Use local files in a session

In the desktop app, use the paperclip's **Files** or **Folder** choice, or drag files/folders into the content area, to insert their local paths.
Files supports any file type and multiple selections; Folder attaches one directory path, including an empty folder, without expanding or reading its contents.
Newly picked or dropped known folders get a trailing directory separator so their Folder icon survives saved messages and reloads; files stay unchanged.
Older unmarked paths are not retrospectively classified.
The agent can then locate/read supported content on the machine running LearnHarness under the existing file-access guards; attaching a path does not grant permissions.
This is **not an upload**: originals stay where they are.
Ordinary browsers cannot expose these local paths through the picker or drag-and-drop; you can paste a full path instead.

In a browser, the paperclip inside a session uploads instead: it opens a picker for PDF, Word (`.docx`), and Markdown files, up to 100 MB each, and each pick opens in the document viewer, where the agent reads it by document id.
The server keeps one copy per content hash under the data folder's `documents` directory.
The new-session screen has no session to upload into yet, so there the paperclip only explains; start the session first.

The teacher can show a local raster image or request an annotated visual based on it. Displayed/annotated pictures are saved as session-owned snapshots, so those saved results no longer depend on the original file. This does not snapshot every file attachment. Offline regression tests cover snapshot/payload behavior, not the quality of model-generated annotations.

File tools are read-only but have broad filesystem access under the server's user; they are not confined to a selected folder.
The sensitive-path guard blocks known credential/private locations, not all sensitive content.
Review what you make available: file content read by an agent may be sent to its configured model provider.
See [file-access boundaries](architecture.md#file-access-and-external-services).

## Extract into the graph

For lessons, attach material to a session instead. Use the graph's **Extract files… → Files** or **Folder** picker for Markdown, plain text, or PDFs. This is a separate import flow, not the session's path attachments. Each supported file is uploaded for processing; folders organize imported sources.

- Files are limited to **25 MiB each**. Imports queue independently, with up to three files in flight.
- PDF conversion is local text extraction, not OCR. Image-only pages are skipped and counted; scanner text can be inaccurate. Check the import's notices.
- Imported text then goes through model-based proposition/chain extraction. Local PDF conversion does not make the whole import offline.
- Completed chunks survive later failures. Retry is explicit and reprocesses the file; unchanged content is not automatically skipped. The file queue does not survive a page reload.

The graph stores propositions and reasoning chains with source provenance, **not mastery scores**. A proposition's presence is not proof that you understood or retained it. Automatic session extraction can be disabled independently of graph rendering.

## Data, privacy, and usage

Chats, graph records, settings, and credentials live on your machine. Packaged desktop data normally lives under:

| OS | Learning-data folder |
| --- | --- |
| macOS | `~/Library/Application Support/LearnHarness/data` |
| Windows | `%APPDATA%\LearnHarness\data` |
| Linux | `$XDG_CONFIG_HOME/LearnHarness/data`, or `~/.config/LearnHarness/data` |

API-key files sit beside `data`, not inside it. They are plaintext with restrictive file permissions, not an encrypted vault. Keep complete profiles private; do not share credential files or raw debug captures in bug reports.

**Local storage does not mean local-only processing.** Configured models, subscription/CLI services, web research, and dictation can receive content. A local custom model is a separate setup choice, not an offline guarantee for other enabled services.

Click the context/cost row beneath the composer for Session stats. Dollar figures estimate known API costs; subscription, CLI, and custom-endpoint usage are not treated as free. See [context, caching, and costs](compaction-accounting.md) for the details.

Packaged apps support updates under **Settings → General**. Development builds do not run the updater. Report problems through [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues), with reproduction steps and the app/OS version rather than private learning records or keys.
