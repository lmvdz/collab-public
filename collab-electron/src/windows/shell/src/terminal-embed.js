import { init as initGhostty, Terminal, FitAddon } from "ghostty-web";

// ---------------------------------------------------------------------------
// WASM initialization gate
// ---------------------------------------------------------------------------

let ghosttyReady = false;
async function ensureGhosttyInit() {
	if (!ghosttyReady) {
		await initGhostty();
		ghosttyReady = true;
	}
}

// ---------------------------------------------------------------------------
// Theme (ported from packages/components/src/Terminal/theme.ts)
// ---------------------------------------------------------------------------

/** @type {import("ghostty-web").ITheme} */
const darkTheme = {
	background: "#080808",
	foreground: "#d4d4d4",
	cursor: "#d4d4d4",
	cursorAccent: "#1e1e1e",
	selectionBackground: "#264f78",
	black: "#000000",
	red: "#cd3131",
	green: "#0dbc79",
	yellow: "#e5e510",
	blue: "#2472c8",
	magenta: "#bc3fbc",
	cyan: "#11a8cd",
	white: "#e5e5e5",
	brightBlack: "#666666",
	brightRed: "#f14c4c",
	brightGreen: "#23d18b",
	brightYellow: "#f5f543",
	brightBlue: "#3b8eea",
	brightMagenta: "#d670d6",
	brightCyan: "#29b8db",
	brightWhite: "#ffffff",
};

/** @type {import("ghostty-web").ITheme} */
const lightTheme = {
	background: "#f8f8f8",
	foreground: "#383a42",
	cursor: "#383a42",
	cursorAccent: "#ffffff",
	selectionBackground: "#add6ff",
	black: "#383a42",
	red: "#e45649",
	green: "#50a14f",
	yellow: "#c18401",
	blue: "#4078f2",
	magenta: "#a626a4",
	cyan: "#0184bc",
	white: "#fafafa",
	brightBlack: "#4f525e",
	brightRed: "#e06c75",
	brightGreen: "#98c379",
	brightYellow: "#e5c07b",
	brightBlue: "#61afef",
	brightMagenta: "#c678dd",
	brightCyan: "#56b6c2",
	brightWhite: "#ffffff",
};

/** @returns {import("ghostty-web").ITheme} */
function getTheme() {
	const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
	return prefersDark ? darkTheme : lightTheme;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Coalesce rapid PTY data events into a single term.write() call. */
const DATA_BUFFER_FLUSH_MS = 5;

const IS_MAC = window.shellApi.getPlatform() === "darwin";

// ---------------------------------------------------------------------------
// Terminal registry  –  sessionId → TerminalHandle
// ---------------------------------------------------------------------------

/** @type {Map<string, TerminalHandle>} */
const registry = new Map();

// ---------------------------------------------------------------------------
// TerminalHandle
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TerminalHandle
 * @property {string} sessionId
 * @property {(data: string|Uint8Array) => void} write  - Feed buffered PTY data
 * @property {() => void} focus
 * @property {() => void} blur
 * @property {() => void} dispose
 * @property {Terminal} term  - ghostty-web instance for advanced access
 */

// ---------------------------------------------------------------------------
// createTerminal
// ---------------------------------------------------------------------------

/**
 * Create a ghostty-web terminal instance inside the given container element.
 *
 * @param {HTMLElement} container  - DOM element to host the terminal
 * @param {string} sessionId      - PTY session identifier
 * @param {{ scrollbackData?: string|null, mode?: "tmux"|"sidecar"|"direct", restored?: boolean }} [options]
 * @returns {Promise<TerminalHandle>}
 */
export async function createTerminal(container, sessionId, options = {}) {
	await ensureGhosttyInit();
	const { scrollbackData = null, mode = "direct", restored = false } = options;

	// -- ghostty-web instance -----------------------------------------------

	const term = new Terminal({
		theme: getTheme(),
		fontFamily: 'Menlo, Monaco, "Courier New", monospace',
		fontSize: 12,
		fontWeight: "300",
		fontWeightBold: "500",
		cursorBlink: true,
		scrollback: 200000,
	});

	const fit = new FitAddon();
	term.loadAddon(fit);
	term.open(container);

	// Delay initial fit until layout pass has finished
	requestAnimationFrame(() => {
		requestAnimationFrame(() => fit.fit());
	});

	// Note: focus is managed by tile-manager.js (focusCanvasTile / blurCanvasTileGuest).
	// We do NOT register a window "focus" listener here because multiple terminals
	// would race to steal focus on window re-focus.

	// -- Restore / initial content ------------------------------------------

	if (!restored) {
		term.write("\x1b[38;2;100;100;100mStarting...\x1b[0m");
	}

	if (restored && scrollbackData) {
		term.write(scrollbackData);
	}

	// -- Data buffering -----------------------------------------------------

	/** @type {Uint8Array[]} */
	let dataBuffer = [];
	/** @type {number|undefined} */
	let flushTimer;
	let firstData = true;

	const flushData = () => {
		if (dataBuffer.length === 0) {
			flushTimer = undefined;
			return;
		}
		const chunks = dataBuffer;
		dataBuffer = [];
		flushTimer = undefined;

		if (firstData) {
			firstData = false;
			if (restored && mode === "tmux") {
				term.write("\x1b[2J\x1b[H");
			} else if (!restored) {
				term.reset();
			}
		}
		for (const chunk of chunks) {
			term.write(chunk);
		}
	};

	/**
	 * Buffer incoming PTY data and flush on a short timer.
	 * @param {string|Uint8Array} data
	 */
	const writeBuffered = (data) => {
		const chunk = typeof data === "string" ? new TextEncoder().encode(data) : data;
		dataBuffer.push(chunk);
		if (flushTimer === undefined) {
			flushTimer = window.setTimeout(flushData, DATA_BUFFER_FLUSH_MS);
		}
	};

	// -- Input handling -----------------------------------------------------

	const copySelectionToClipboard = () => {
		const selection = term.getSelection();
		if (!selection) return false;
		void navigator.clipboard.writeText(selection).catch(() => {});
		return true;
	};

	let suppressPasteEvent = false;

	const pasteClipboardText = async () => {
		try {
			const text = await navigator.clipboard.readText();
			if (text) {
				window.shellApi.ptyWrite(sessionId, text);
			}
		} catch {
			// Clipboard access can fail outside a user gesture.
		}
	};

	const pasteFromShortcut = () => {
		suppressPasteEvent = true;
		void pasteClipboardText();
	};

	term.attachCustomKeyEventHandler((e) => {
		// Shift+Enter — send CSI u escape for TUI apps
		if (e.key === "Enter" && e.shiftKey) {
			if (e.type === "keydown") {
				window.shellApi.ptySendRawKeys(sessionId, "\x1b[13;2u");
			}
			return false;
		}

		const primaryModifier = IS_MAC ? e.metaKey : e.ctrlKey;

		if (e.type === "keydown" && primaryModifier) {
			const key = e.key.toLowerCase();
			if (key === "c" && copySelectionToClipboard()) return false;
			if (key === "v") { pasteFromShortcut(); return false; }

			// Windows/Linux: also support Ctrl+Shift+C / Ctrl+Shift+V
			if (!IS_MAC && e.shiftKey) {
				if (key === "c" && copySelectionToClipboard()) return false;
				if (key === "v") { pasteFromShortcut(); return false; }
			}
		}

		// Shift+Insert paste
		if (e.type === "keydown" && e.shiftKey && e.key === "Insert") {
			pasteFromShortcut();
			return false;
		}

		// Block Cmd+T, Cmd+1-9 from reaching the terminal
		if (e.type === "keydown" && e.metaKey) {
			if (e.key === "t" || (e.key >= "1" && e.key <= "9")) {
				return false;
			}
		}

		return true;
	});

	term.onData((data) => {
		window.shellApi.ptyWrite(sessionId, data);
	});

	// -- Clipboard events ---------------------------------------------------

	const handleCopy = (event) => {
		const selection = term.getSelection();
		if (!selection) return;
		event.clipboardData?.setData("text/plain", selection);
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	const handlePaste = (event) => {
		if (suppressPasteEvent) {
			suppressPasteEvent = false;
			event.preventDefault();
			event.stopImmediatePropagation();
			return;
		}
		const text = event.clipboardData?.getData("text/plain");
		if (!text) return;
		window.shellApi.ptyWrite(sessionId, text);
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	container.addEventListener("copy", handleCopy, true);
	container.addEventListener("paste", handlePaste, true);

	// -- Resize observer (debounced via rAF) --------------------------------

	term.onResize(({ cols, rows }) => {
		window.shellApi.ptyResize(sessionId, cols, rows);
	});

	let rafId = 0;
	const resizeObserver = new ResizeObserver((entries) => {
		const { width, height } = entries[0].contentRect;
		if (width > 0 && height > 0) {
			cancelAnimationFrame(rafId);
			rafId = requestAnimationFrame(() => fit.fit());
		}
	});
	resizeObserver.observe(container);

	// -- Theme change listener ----------------------------------------------

	const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
	const onThemeChange = () => { term.options.theme = getTheme(); };
	mediaQuery.addEventListener("change", onThemeChange);

	// -- Build handle -------------------------------------------------------

	/** @type {TerminalHandle} */
	const handle = {
		sessionId,
		write: writeBuffered,
		focus: () => term.focus(),
		blur: () => term.blur(),
		term,
		dispose() {
			// Flush any remaining buffered data
			if (flushTimer !== undefined) {
				clearTimeout(flushTimer);
				flushData();
			}
			cancelAnimationFrame(rafId);
			mediaQuery.removeEventListener("change", onThemeChange);
			resizeObserver.disconnect();
			container.removeEventListener("copy", handleCopy, true);
			container.removeEventListener("paste", handlePaste, true);
			term.dispose();
			registry.delete(sessionId);
		},
	};

	registry.set(sessionId, handle);
	return handle;
}

// ---------------------------------------------------------------------------
// getTerminal
// ---------------------------------------------------------------------------

/**
 * Look up an existing terminal handle by session ID.
 *
 * @param {string} sessionId
 * @returns {TerminalHandle|undefined}
 */
export function getTerminal(sessionId) {
	return registry.get(sessionId);
}

// ---------------------------------------------------------------------------
// disposeTerminal
// ---------------------------------------------------------------------------

/**
 * Dispose a specific terminal and remove it from the registry.
 *
 * @param {string} sessionId
 */
export function disposeTerminal(sessionId) {
	const handle = registry.get(sessionId);
	if (handle) {
		handle.dispose();
	}
}

// ---------------------------------------------------------------------------
// initPtyDataDispatch
// ---------------------------------------------------------------------------

/**
 * Wire up the global PTY data and exit listeners. Call once on startup.
 * Routes incoming PTY data to the correct terminal handle's write buffer.
 */
export function initPtyDataDispatch() {
	window.shellApi.onPtyData((sessionId, data) => {
		const handle = registry.get(sessionId);
		if (handle) {
			handle.write(data);
		}
	});

	window.shellApi.onPtyExit((payload) => {
		const sid = typeof payload === "string" ? payload : payload?.sessionId;
		if (sid) {
			disposeTerminal(sid);
		}
	});
}
