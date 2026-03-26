import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { getTheme } from "./theme";
import "@xterm/xterm/css/xterm.css";
import "./TerminalTab.css";

// Matches VS Code's TerminalDataBufferer throttle interval.
// Coalesces rapid PTY data events into a single term.write()
// call, preventing partial-render artifacts from the renderer
// processing many small sequential writes.
const DATA_BUFFER_FLUSH_MS = 5;

function captureCurrentViewport(term: Terminal): string {
	const buf = term.buffer.active;
	const lines: string[] = [];
	for (let y = 0; y < term.rows; y++) {
		const line = buf.getLine(y);
		if (line) {
			lines.push(line.translateToString(true));
		}
	}
	while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') {
		lines.pop();
	}
	return lines.join('\r\n');
}

interface TerminalTabProps {
	sessionId: string;
	visible: boolean;
	restored?: boolean;
	scrollbackData?: string | null;
}

function TerminalTab({ sessionId, visible, restored, scrollbackData }: TerminalTabProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const fitRef = useRef<FitAddon | null>(null);

	useEffect(() => {
		if (!containerRef.current) return;

		const term = new Terminal({
			theme: getTheme(),
			fontFamily: 'Menlo, Monaco, "Courier New", monospace',
			fontSize: 12,
			fontWeight: "300",
			fontWeightBold: "500",
			cursorBlink: true,
			scrollback: 200000,
			allowProposedApi: true,
		});

		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(containerRef.current);
		fitRef.current = fit;

		let altScreenSnapshots: string[] = [];
		let snapshotInterval: number | undefined;
		let lastSnapshotContent = '';
		let pendingFinalCapture: string | null = null;

		const decrstDisposable = term.parser.registerCsiHandler(
			{ prefix: '?', final: 'l' },
			(params) => {
				for (const p of params) {
					const mode = Array.isArray(p) ? p[0] : p;
					if (mode === 1049 || mode === 1047 || mode === 47) {
						pendingFinalCapture = captureCurrentViewport(term);
					}
				}
				return false;
			}
		);

		const bufferChangeDisposable = term.buffer.onBufferChange((buf) => {
			if (buf.type === 'alternate') {
				altScreenSnapshots = [];
				lastSnapshotContent = '';
				snapshotInterval = window.setInterval(() => {
					const current = captureCurrentViewport(term);
					if (current !== lastSnapshotContent) {
						altScreenSnapshots.push(current);
						lastSnapshotContent = current;
						if (altScreenSnapshots.length > 500) {
							altScreenSnapshots.shift();
						}
					}
				}, 3000);
			} else if (buf.type === 'normal') {
				if (snapshotInterval !== undefined) {
					clearInterval(snapshotInterval);
					snapshotInterval = undefined;
				}

				if (pendingFinalCapture && pendingFinalCapture !== lastSnapshotContent) {
					altScreenSnapshots.push(pendingFinalCapture);
				}
				pendingFinalCapture = null;

				if (altScreenSnapshots.length > 0) {
					const sep = '\r\n\x1b[38;2;60;60;60m' + '\u2500'.repeat(Math.min(term.cols, 80)) + '\x1b[0m\r\n';
					const scrollbackContent = altScreenSnapshots.join(sep);
					term.write(sep + scrollbackContent + sep);
					altScreenSnapshots = [];
				}
			}
		});

		const unicode11 = new Unicode11Addon();
		term.loadAddon(unicode11);
		term.unicode.activeVersion = "11";

		// WebGL renderer: double-buffered canvas avoids the
		// partial-paint artifacts the DOM renderer can show
		// during rapid sequential writes. Falls back to DOM
		// if the GPU context can't be acquired.
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			term.loadAddon(webgl);
		} catch {
			// DOM renderer fallback — no action needed
		}

		// Delay initial fit: the webview may not have its final
		// dimensions when the page first loads. Double-rAF ensures
		// the layout pass has finished before we measure.
		requestAnimationFrame(() => {
			requestAnimationFrame(() => fit.fit());
		});

		// Auto-focus xterm when the webview already has focus (e.g.
		// tile created via Cmd+N or double-click where focusCanvasTile
		// ran before xterm mounted).
		if (document.hasFocus()) {
			term.focus();
		}

		// Keep xterm focused whenever the webview window gains focus,
		// so typing works immediately after clicking a tile title bar
		// or programmatic webview.focus() calls.
		const onWindowFocus = () => term.focus();
		window.addEventListener("focus", onWindowFocus);

		if (!restored) {
			term.write(
				`\x1b[38;2;100;100;100mStarting...\x1b[0m`,
			);
		}

		if (restored && scrollbackData) {
			term.write(scrollbackData);
		}

		// Shift+Enter: inject a CSI u escape sequence directly into the
		// tmux pane (via send-keys -l) so TUI apps like Claude Code can
		// detect the shift modifier. The normal ptyWrite path goes through
		// tmux's input parser which strips modifier info in legacy mode.
		// Block both keydown AND keypress to prevent xterm from also
		// sending \r through the normal onData path.
		term.attachCustomKeyEventHandler((e) => {
			if (e.key === "Enter" && e.shiftKey) {
				if (e.type === "keydown") {
					window.api.ptySendRawKeys(sessionId, "\x1b[13;2u");
				}
				return false;
			}
			if (e.type === "keydown" && e.metaKey) {
				if (e.key === "t" || (e.key >= "1" && e.key <= "9")) {
					return false;
				}
			}
			return true;
		});

		term.onData((data: string) => {
			window.api.ptyWrite(sessionId, data);
		});

		let dataBuffer: string[] = [];
		let flushTimer: number | undefined;
		let firstData = true;

		const flushData = () => {
			const chunk = dataBuffer.join("");
			dataBuffer.length = 0;
			flushTimer = undefined;
			if (!chunk) return;
			if (firstData) {
				firstData = false;
				if (restored) {
					// Clear viewport so tmux's initial screen
					// draw has a clean surface. Scrollback from
					// capture-pane stays in xterm's buffer.
					term.write("\x1b[2J\x1b[H");
				} else {
					term.reset();
				}
			}
			term.write(chunk);
		};

		const handleData = (payload: {
			sessionId: string;
			data: string;
		}) => {
			if (payload.sessionId !== sessionId) return;
			dataBuffer.push(payload.data);
			if (flushTimer === undefined) {
				flushTimer = window.setTimeout(
					flushData,
					DATA_BUFFER_FLUSH_MS,
				);
			}
		};
		window.api.onPtyData(handleData);

		term.onResize(({ cols, rows }) => {
			window.api.ptyResize(sessionId, cols, rows);
		});

		const offShellBlur = window.api.onShellBlur(() => {
			term.blur();
			const active = document.activeElement as HTMLElement | null;
			active?.blur();
		});

		// Debounce resize via rAF to coalesce rapid events
		let rafId = 0;
		const resizeObserver = new ResizeObserver((entries) => {
			const { width, height } = entries[0].contentRect;
			if (width > 0 && height > 0) {
				cancelAnimationFrame(rafId);
				rafId = requestAnimationFrame(() => fit.fit());
			}
		});
		resizeObserver.observe(containerRef.current);

		const mediaQuery = window.matchMedia(
			"(prefers-color-scheme: dark)",
		);
		const onThemeChange = () => {
			term.options.theme = getTheme();
		};
		mediaQuery.addEventListener("change", onThemeChange);

		return () => {
			if (flushTimer !== undefined) {
				clearTimeout(flushTimer);
				flushData();
			}
			cancelAnimationFrame(rafId);
			window.removeEventListener("focus", onWindowFocus);
			mediaQuery.removeEventListener("change", onThemeChange);
			resizeObserver.disconnect();
			window.api.offPtyData(handleData);
			offShellBlur();
			decrstDisposable.dispose();
			bufferChangeDisposable.dispose();
			if (snapshotInterval !== undefined) {
				clearInterval(snapshotInterval);
			}
			term.dispose();
			fitRef.current = null;
		};
	}, [sessionId]);

	useEffect(() => {
		if (visible && fitRef.current) {
			requestAnimationFrame(() => fitRef.current?.fit());
		}
	}, [visible]);

	return (
		<div
			ref={containerRef}
			className="terminal-tab"
			style={{ display: visible ? "block" : "none" }}
		/>
	);
}

export default TerminalTab;
