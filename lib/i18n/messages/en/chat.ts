/** The chat area: the session transcript, header, composer, dock chrome,
 *  dictation, session Find, and the markdown blocks' own chrome. */
export const chat = {
	/** session-core's client-authored error lines (display mapping only). */
	errors: {
		providerError: "The model provider returned an error.",
		technicalDetails: "Technical details",
		generic: "An error occurred.",
		emptyStream: "The turn stream body is empty.",
		attachFailed: "Failed to attach to the running turn.",
		turnRunning: "A turn is already running — try again in a moment.",
		sendFailed: (status: number) => `The send failed (${status}).`,
		steerFailed: (status: number) => `The steer failed (${status}).`,
		dismissalFailed: (status: number) => `The dismissal failed (${status}).`,
		answerRemainingQuestion: "Answer or discard the remaining question first.",
		openSessionFailed: "Couldn’t open the session. Your message is still here. Try sending again.",
		streamDropped: "The connection dropped before the turn completed.",
	},
	/** Screen-reader announcements (LiveAnnouncer). */
	announce: {
		responseComplete: "Response complete",
		questionReady: "A question is waiting for your answer",
	},
	header: {
		titleInput: "Session title",
		renameThis: "Rename this session",
		renameSession: "Rename session",
		openPlan: "Open the full plan",
		plan: "Plan",
		practice: "Practice",
	},
	emptySession: {
		title: "New session",
		description: "The teacher will open by probing what you already know.",
	},
	/** ConversationEmptyState's generic defaults. */
	emptyState: {
		title: "No messages yet",
		description: "Start a conversation to see messages here",
	},
	transcript: {
		you: "You",
		retrying: "Retrying…",
		compactingSpinner: "Compacting context",
		compacting: "COMPACTING CONTEXT…",
		thinking: "THINKING…",
		errorPrefix: "Something went wrong: ",
		setupModels: "Set up your models",
	},
	composer: {
		placeholder: "Ask, answer, or steer the lesson…",
		nextPlaceholder: "Ask anything, or press Enter for the next one.",
		nextProblem: "Next problem",
		nodesSelected: (n: number) => `${n} ${n === 1 ? "node" : "nodes"} selected`,
		pickNodes: "Pick nodes",
		clear: "Clear",
	},
	compaction: {
		contextCompacted: "Context compacted",
		historyCompacted: "History compacted",
		kTok: (k: number) => ` · ${k}k tok`,
	},
	phase: {
		/** Header-chip labels: the phases as the learner thinks of them. */
		chip: {
			probe: "Probing",
			plan: "Planning",
			teach: "Teaching",
		},
		planNodes: (n: number) => `Plan · ${n} node${n === 1 ? "" : "s"}`,
	},
	abort: {
		turn: {
			title: "Abort this turn?",
			line: "The partial answer stays in the transcript.",
			action: "Abort",
		},
		question: {
			title: "Dismiss this question?",
			line: "Skipped — the teacher moves on without it.",
			action: "Dismiss",
		},
		problem: {
			title: "Discard this problem?",
			line: "The problem is dropped — no solution is revealed.",
			action: "Discard",
		},
		turnStopsToo: " The working turn stops too.",
	},
	find: {
		region: "Session Find",
		input: "Find in session",
		placeholder: "Find in session…",
		previous: "Previous match",
		previousHint: "Previous match (Shift+Enter)",
		next: "Next match",
		nextHint: "Next match (Enter)",
		close: "Close Find",
		closeHint: "Close Find (Esc)",
	},
	dictation: {
		dictate: "Dictate",
		start: "Start dictation",
		failed: (error: string) => `Dictation failed: ${error}`,
		stop: "Stop dictation",
		stopHint: "Stop dictation (Esc)",
		keyless: "Dictation needs a Deepgram key",
		micDenied: "Microphone permission denied",
		micUnavailable: "mic unavailable",
		reconnectFailed: "Deepgram reconnect failed",
		connectionLost: (code: string) => `Deepgram connection lost (${code})`,
		tokenRoute: (status: number) => `token route ${status}`,
		languageUnavailable: "Dictation language unavailable",
		tokenUnavailable: "token unavailable",
	},
	thinking: {
		yourThinking: "YOUR THINKING",
	},
	readingThinking: {
		heading: "Thinking while reading",
		placeholder: "Whatever comes to mind as you read.",
	},
	reasoning: {
		spinner: "Thinking",
		thinking: "Thinking...",
		agentsThinking: "AGENT’S THINKING",
	},
	spinner: {
		working: "Working",
	},
	markdown: {
		copyDiagramSource: "Copy diagram source",
		openFullScreen: "Open full-screen",
		expandDiagram: "Expand diagram",
		copyEquationSource: "Copy equation source",
	},
	mermaid: {
		failed: "Diagram failed to render",
		showSource: "Show diagram source",
	},
	message: {
		previousBranch: "Previous branch",
		nextBranch: "Next branch",
		branchPage: (current: number, total: number) => `${current} of ${total}`,
	},
};
