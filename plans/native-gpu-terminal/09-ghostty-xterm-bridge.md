# ghostty-vt ↔ xterm.js Bridge
STATUS: done (ghostty-web has xterm.js-compatible API, no bridge needed)
PRIORITY: p1
REPOS: collab-electron
COMPLEXITY: architectural
TOUCHES: src/windows/shell/src/terminal-embed.js, src/windows/shell/src/ghostty-adapter.js

## Goal
When ghostty-vt adapter is available, feed raw PTY bytes through ghostty-vt for parsing
while still using xterm.js as the renderer. xterm.js's internal parser is bypassed;
ghostty-vt's cell grid is synced to xterm.js's buffer.

## Approach

### Strategy A: Cell-grid sync (preferred)

After ghostty-vt processes bytes, read its cell grid and write the corresponding
characters + attributes to xterm.js's buffer via the public API:

```javascript
// On each data chunk:
ghosttySession.feed(data);
if (ghosttySession.isDirty()) {
  const grid = ghosttySession.getCellGrid();
  syncGridToXterm(grid, xtermInstance);
}
```

`syncGridToXterm` would use xterm.js's `Terminal.write()` with ANSI sequences to position
the cursor and write characters. This is slow but correct — it preserves xterm.js's
internal state for selection, scrollback, and rendering.

### Strategy B: Dual-write (alternative)

Feed data to BOTH ghostty-vt and xterm.js. Use ghostty-vt as the "source of truth" for
cell grid verification, while xterm.js handles rendering as usual. This is simpler but
doesn't actually replace the VT parser — it validates it.

### Recommendation

Start with Strategy B for Phase 2 initial integration (validation mode). Switch to
Strategy A when the custom GPU renderer (concern 10) is ready and xterm.js's parser
is no longer needed.

### Integration in terminal-embed.js

```javascript
// In createTerminal():
const ghosttyAvailable = await initGhosttyVt();

if (ghosttyAvailable && useGhosttyParser()) {
  const vtSession = new GhosttyVtSession(cols, rows, scrollback);

  // Data handler feeds both (Strategy B)
  const handleData = (data) => {
    vtSession.feed(data);
    term.write(data);  // xterm.js still parses for rendering
  };
} else {
  // Fallback: xterm.js handles everything (Phase 1 behavior)
  const handleData = (data) => term.write(data);
}
```

## Cross-Repo Side Effects
None.

## Verify
- Terminal renders correctly with ghostty-vt in dual-write mode
- vttest passes with both parsers active
- Performance: no measurable slowdown from dual parsing
- Fallback works when ghostty-vt is unavailable
