import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { getTheme } from "@collab/components/Terminal/theme";
import "@xterm/xterm/css/xterm.css";
import { setTerminalCount, attachGL, markCpuStart, markCpuEnd } from "./perf-overlay.js";

// ---------------------------------------------------------------------------
// GPU renderer flag
// ---------------------------------------------------------------------------

let useGpuRenderer = false;

/**
 * Probe for WebGL2 support and enable the GPU renderer if available.
 * Call once on startup alongside initPtyDataDispatch().
 */
export async function initGpuRenderer() {
	try {
		const enabled = await window.shellApi.getGpuRenderer();
		if (!enabled) {
			useGpuRenderer = false;
			console.log("[terminal-embed] GPU renderer disabled by config");
			return;
		}
		// xterm.js WebglAddon handles the WebGL context internally —
		// just check if WebGL is available at all.
		const testCanvas = new OffscreenCanvas(1, 1);
		const gl = testCanvas.getContext("webgl2") || testCanvas.getContext("webgl");
		if (gl) {
			useGpuRenderer = true;
			const loseCtx = gl.getExtension("WEBGL_lose_context");
			if (loseCtx) loseCtx.loseContext();
			console.log("[terminal-embed] GPU renderer enabled");
		}
	} catch {
		useGpuRenderer = false;
		console.log("[terminal-embed] WebGL not available, using DOM fallback");
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_BUFFER_FLUSH_MS = 5;
const IS_MAC = window.shellApi.getPlatform() === "darwin";
const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Terminal registry
// ---------------------------------------------------------------------------

/** @type {Map<string, TerminalHandle>} */
const registry = new Map();

// ---------------------------------------------------------------------------
// TerminalHandle
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TerminalHandle
 * @property {string} sessionId
 * @property {(data: string|Uint8Array) => void} write
 * @property {() => void} focus
 * @property {() => void} blur
 * @property {() => void} dispose
 * @property {Terminal} term
 */

// ---------------------------------------------------------------------------
// createTerminal
// ---------------------------------------------------------------------------

/**
 * Create an xterm.js terminal instance inside the given container element.
 * Optionally loads the WebglAddon for GPU-accelerated rendering.
 *
 * @param {HTMLElement} container
 * @param {string} sessionId
 * @param {{ scrollbackData?: string|null, mode?: "tmux"|"sidecar"|"direct", restored?: boolean }} [options]
 * @returns {Promise<TerminalHandle>}
 */
export async function createTerminal(container, sessionId, options = {}) {
	const { scrollbackData = null, restored = false } = options;

	// -- xterm.js instance -----------------------------------------------------

	const term = new Terminal({
		theme: getTheme(),
		fontFamily: 'Menlo, Monaco, "Cascadia Mono", Consolas, "Courier New", monospace',
		fontSize: 12,
		fontWeight: "300",
		fontWeightBold: "500",
		cursorBlink: true,
		scrollback: 200000,
		allowProposedApi: true,
	});

	const fit = new FitAddon();
	term.loadAddon(fit);
	term.open(container);

	// Force 2x rendering for sharper text with the WebGL addon.
	// The WebGL canvas renders at double resolution and CSS scales it down,
	// producing crisper glyphs similar to native ClearType rendering.
	if (useGpuRenderer && window.devicePixelRatio <= 1) {
		term.options.devicePixelRatio = 2;
	}

	// Unicode 11 support for proper emoji/wide character handling
	const unicode11 = new Unicode11Addon();
	term.loadAddon(unicode11);
	term.unicode.activeVersion = "11";

	// -- GPU renderer (xterm.js WebglAddon) ------------------------------------
	// WebglAddon provides hardware-accelerated rendering via WebGL, avoiding
	// the DOM renderer's partial-paint artifacts during rapid writes.

	let webglAddon = null;

	if (useGpuRenderer) {
		try {
			webglAddon = new WebglAddon();
			webglAddon.onContextLoss(() => {
				console.warn("[terminal-embed] WebGL context lost, falling back to DOM renderer");
				webglAddon?.dispose();
				webglAddon = null;
			});
			term.loadAddon(webglAddon);
			console.log("[terminal-embed] WebGL renderer loaded");

			// Attach the WebGL context to the perf overlay for GPU timer queries.
			// The WebglAddon stores its context as _gl on the renderer.
			requestAnimationFrame(() => {
				try {
					const renderer = webglAddon._renderer;
					const glCtx = renderer?._gl;
					if (glCtx) attachGL(glCtx);
				} catch {
					// WebglAddon internals may change — non-fatal.
				}
			});
		} catch (err) {
			console.warn("[terminal-embed] WebGL addon failed, using DOM fallback:", err);
			webglAddon = null;
		}
	}

	// -- Scroll handling -------------------------------------------------------
	// Prevent wheel events from bubbling to the canvas pan/zoom handler.
	// tmux mouse mode handles scrollback via mouse wheel natively.
	// Hold Shift while clicking/dragging to select text (bypasses tmux mouse capture).
	const handleWheel = (e) => { e.stopPropagation(); };
	container.addEventListener("wheel", handleWheel, { passive: true });

	// Delay initial fit until layout pass has finished
	requestAnimationFrame(() => {
		requestAnimationFrame(() => fit.fit());
	});

	// -- Restore / initial content ---------------------------------------------

	if (!restored) {
		term.write("\x1b[38;2;100;100;100mStarting...\x1b[0m");
	}

	if (restored && scrollbackData) {
		term.write(scrollbackData);
	}

	// -- Data buffering --------------------------------------------------------

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
			// Clear the "Starting..." placeholder (or tmux stale frame).
			// Avoid term.reset() — it destroys the WebGL texture atlas and
			// can leave the renderer in a broken state where subsequent
			// writes are invisible.
			term.write("\x1b[2J\x1b[H");
		}
		markCpuStart();
		for (const chunk of chunks) {
			term.write(chunk);
		}
		markCpuEnd();
	};

	/**
	 * Buffer incoming PTY data and flush on a short timer.
	 * @param {string|Uint8Array} data
	 */
	const writeBuffered = (data) => {
		const chunk = typeof data === "string" ? textEncoder.encode(data) : data;
		dataBuffer.push(chunk);
		if (flushTimer === undefined) {
			flushTimer = window.setTimeout(flushData, DATA_BUFFER_FLUSH_MS);
		}
	};

	// -- Input handling --------------------------------------------------------

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

	// -- Clipboard events ------------------------------------------------------

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

	// -- Resize observer -------------------------------------------------------
	// fit.fit() is expensive: it forces a synchronous DOM reflow, recalculates
	// cols/rows, and triggers a full terminal re-layout + re-render.  During
	// continuous tile-drag resizing this was called on every animation frame,
	// which is the main cause of choppiness.
	//
	// Strategy: debounce fit() so it only fires once resize activity pauses
	// (100ms).  The CSS transform resize remains smooth because tile-renderer
	// handles that independently via GPU-composited translate3d/scale.

	const FIT_DEBOUNCE_MS = 100;
	let fitTimer = 0;

	term.onResize(({ cols, rows }) => {
		window.shellApi.ptyResize(sessionId, cols, rows);
	});

	const resizeObserver = new ResizeObserver((entries) => {
		const { width, height } = entries[0].contentRect;
		if (width > 0 && height > 0) {
			clearTimeout(fitTimer);
			fitTimer = window.setTimeout(() => fit.fit(), FIT_DEBOUNCE_MS);
		}
	});
	resizeObserver.observe(container);

	// -- Theme change listener -------------------------------------------------

	const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
	const onThemeChange = () => {
		term.options.theme = getTheme();
	};
	mediaQuery.addEventListener("change", onThemeChange);

	// -- Build handle ----------------------------------------------------------

	/** @type {TerminalHandle} */
	const handle = {
		sessionId,
		write: writeBuffered,
		focus: () => term.focus(),
		blur: () => term.blur(),
		term,
		dispose() {
			if (flushTimer !== undefined) {
				clearTimeout(flushTimer);
				flushData();
			}
			clearTimeout(fitTimer);
			mediaQuery.removeEventListener("change", onThemeChange);
			resizeObserver.disconnect();
			container.removeEventListener("wheel", handleWheel);
			container.removeEventListener("copy", handleCopy, true);
			container.removeEventListener("paste", handlePaste, true);
			if (webglAddon) {
				webglAddon.dispose();
				webglAddon = null;
			}
			term.dispose();
			registry.delete(sessionId);
			earlyDataBuffers.delete(sessionId);
			setTerminalCount(registry.size);
		},
	};

	registry.set(sessionId, handle);
	setTerminalCount(registry.size);

	// Flush any PTY data that arrived before the terminal was registered
	const early = earlyDataBuffers.get(sessionId);
	if (early) {
		earlyDataBuffers.delete(sessionId);
		for (const chunk of early) {
			handle.write(chunk);
		}
	}

	return handle;
}

// ---------------------------------------------------------------------------
// getTerminal
// ---------------------------------------------------------------------------

export function getTerminal(sessionId) {
	return registry.get(sessionId);
}

// ---------------------------------------------------------------------------
// disposeTerminal
// ---------------------------------------------------------------------------

export function disposeTerminal(sessionId) {
	const handle = registry.get(sessionId);
	if (handle) {
		handle.dispose();
	}
}

// ---------------------------------------------------------------------------
// initPtyDataDispatch
// ---------------------------------------------------------------------------

/** @type {Map<string, Array<string|Uint8Array>>} */
const earlyDataBuffers = new Map();

export function initPtyDataDispatch() {
	// Expose registry for DevTools debugging only
	if (typeof process === "undefined" || process.env?.NODE_ENV !== "production") {
		window.__terminalRegistry = registry;
	}

	window.shellApi.onPtyData((sessionId, data) => {
		const handle = registry.get(sessionId);
		if (handle) {
			handle.write(data);
		} else {
			// Buffer data that arrives before createTerminal finishes
			let buf = earlyDataBuffers.get(sessionId);
			if (!buf) {
				buf = [];
				earlyDataBuffers.set(sessionId, buf);
			}
			buf.push(data);
		}
	});

	window.shellApi.onPtyExit((payload) => {
		const sid = typeof payload === "string" ? payload : payload?.sessionId;
		if (sid) {
			disposeTerminal(sid);
		}
	});
}
