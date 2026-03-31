# Terminal Embed Module
STATUS: done
PRIORITY: p0
REPOS: collab-electron
COMPLEXITY: architectural
TOUCHES: NEW: src/windows/shell/src/terminal-embed.js

## Goal
Create a module that manages xterm.js Terminal instances in the shell renderer process.
Each instance renders into a `<div>` container, handles I/O, and supports full terminal
interaction (keyboard, clipboard, IME, selection, resize).

## Approach

Create `src/windows/shell/src/terminal-embed.js` with the following API:

```javascript
// Creates and returns a terminal instance bound to a container div
export function createTerminal(container, sessionId, options) → TerminalHandle

// TerminalHandle interface:
// {
//   write(data: Uint8Array): void     — feed PTY data
//   resize(cols, rows): void          — resize
//   focus(): void                     — focus terminal
//   blur(): void                      — blur terminal
//   dispose(): void                   — cleanup
//   getScrollback(): string           — for session persistence
//   sessionId: string
// }

// Registry for dispatch
export function getTerminal(sessionId) → TerminalHandle | undefined
export function disposeTerminal(sessionId): void
```

### Internal implementation

Port logic from `TerminalTab.tsx` (lines 29-295):

1. **xterm.js setup** (from TerminalTab.tsx lines 29-70):
   - `new Terminal({ fontSize: 12, fontFamily: "Menlo, ...", scrollback: 200000, ... })`
   - Load `FitAddon`, `Unicode11Addon`, `WebglAddon`
   - WebGL context loss fallback (line 59)

2. **Data buffering** (from TerminalTab.tsx lines 169-206):
   - 5ms coalescing via `DATA_BUFFER_FLUSH_MS`
   - Buffer array + flush timer pattern

3. **Input handling** (from TerminalTab.tsx lines 126-163):
   - `term.onData` → `window.shellApi.ptyWrite(sessionId, data)`
   - Shift+Enter → `window.shellApi.ptySendRawKeys(sessionId, "\x1b[13;2u")`
   - Cmd/Ctrl+C copy, Cmd/Ctrl+V paste
   - Custom key event handler for platform shortcuts

4. **Resize** (from TerminalTab.tsx lines 245-252):
   - ResizeObserver on container
   - Debounced via rAF → `fit.fit()` → `window.shellApi.ptyResize(sessionId, cols, rows)`

5. **Focus/blur** (from TerminalTab.tsx lines 238-242):
   - `term.focus()` / `term.blur()` methods exposed on handle
   - Shell-blur signal handled by tile-manager (concern 04)

6. **Theme** (from TerminalTab.tsx lines 81-87, theme.ts):
   - Import `getTheme()` and apply. Listen for prefers-color-scheme changes.

### Data dispatch

Register with the shell preload's `onPtyData` listener:

```javascript
window.shellApi.onPtyData((sessionId, data) => {
  const terminal = getTerminal(sessionId);
  if (terminal) terminal.write(data);
});
```

## Cross-Repo Side Effects
None — self-contained new module.

## Verify
- Mount a terminal embed into a test div, confirm cursor blinks
- Type characters, confirm echo appears
- Resize container, confirm terminal reflows
- Copy/paste works (Cmd+C/V)
- WebGL context loss: terminal falls back to DOM renderer gracefully
- Multiple terminals simultaneously, each receives correct session data
