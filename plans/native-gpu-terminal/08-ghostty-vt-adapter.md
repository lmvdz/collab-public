# ghostty-vt WASM Adapter
STATUS: done (ghostty-web is a drop-in replacement, no adapter needed)
PRIORITY: p1
REPOS: collab-electron
COMPLEXITY: research
TOUCHES: NEW: src/windows/shell/src/ghostty-adapter.js, NEW: resources/ghostty-vt.wasm

## Goal
Integrate ghostty-web (Coder's WASM build of libghostty-vt) as the VT parser, behind
a stable adapter interface that isolates API instability.

## Approach

### 1. Acquire ghostty-web WASM build

Check https://github.com/coder/ghostty-web for distribution:
- If npm package: `bun add ghostty-web`
- If not published: build from source or vendor the .wasm file

Pin to a specific commit/version hash for reproducibility.

### 2. Adapter interface

Create `src/windows/shell/src/ghostty-adapter.js`:

```javascript
// Stable interface — does not change when ghostty-vt API changes
export class GhosttyVtSession {
  constructor(cols, rows, scrollback)

  feed(data: Uint8Array): void        // Feed raw PTY bytes
  resize(cols: number, rows: number): void
  isDirty(): boolean                   // Has cell grid changed since last read?
  getCellGrid(): CellGrid             // Snapshot of current terminal state
  getScrollback(): string             // Text content for clipboard/save
  getCursorPosition(): { col, row }
  destroy(): void

  // CellGrid: { cols, rows, cells: Array<Cell> }
  // Cell: { codepoint, fg: [r,g,b], bg: [r,g,b], attrs: number, wide: boolean }
}

export async function initGhosttyVt(): Promise<boolean>  // Load WASM, returns false if unavailable
```

### 3. WASM loading

Load the WASM module lazily on first terminal creation. If loading fails (corrupt binary,
unsupported platform), fall back to xterm.js parser.

### 4. API mapping

Map ghostty-web's internal API to the adapter interface. The ghostty-web project should
expose something similar to:
- `ghostty_terminal_new(cols, rows)` → terminal handle
- `ghostty_terminal_vt_write(handle, bytes, len)` → feed data
- `ghostty_terminal_resize(handle, cols, rows)` → resize
- Render state iteration via `ghostty_render_state_*` functions

The adapter wraps these raw C-ABI-style calls into the JS class above.

### 5. Testing

Build a test harness that feeds VT test sequences through both ghostty-vt and xterm.js,
compares the resulting cell grids. Use vttest and common TUI app output as test corpus.

## Cross-Repo Side Effects
None.

## Verify
- WASM loads successfully on Windows and macOS
- `feed()` + `getCellGrid()` produces correct cell data for basic ANSI sequences
- `resize()` triggers reflow
- Adapter falls back gracefully if WASM is unavailable
- Memory usage is reasonable (~10-20MB per terminal session)
