# Custom WebGL2 Instanced Renderer
STATUS: open
PRIORITY: p2
REPOS: collab-electron
COMPLEXITY: research
TOUCHES: NEW: src/windows/shell/src/gpu-terminal-renderer.js, NEW: src/windows/shell/src/font-atlas.js

## Goal
Replace xterm.js's WebGL addon with a purpose-built instanced-quad GPU renderer that
reads directly from ghostty-vt's cell grid. Eliminate xterm.js from the rendering path.

## Approach

### 1. Rendering architecture

Single WebGL2 context shared across all terminal tiles in the shell window. Per-terminal
framebuffer objects (FBOs) for offscreen rendering. The shell compositor blits FBO textures
to per-tile canvases.

### 2. Instanced cell rendering

Each terminal cell = one GPU instance. Three render passes:

**Pass 1 — Backgrounds:**
- Instance data: `[col, row, r, g, b, a]` per cell with non-default background
- Vertex shader positions a quad at grid position
- Fragment shader fills solid color

**Pass 2 — Glyphs:**
- Instance data: `[col, row, atlas_x, atlas_y, atlas_w, atlas_h, fg_r, fg_g, fg_b]`
- Font atlas texture (see section 3)
- Fragment shader samples glyph texture, multiplies by foreground color

**Pass 3 — Cursor:**
- Single quad for cursor position (block, underline, or bar style)

Total draw calls per terminal per frame: 3, regardless of terminal size.

### 3. Font atlas (font-atlas.js)

- Pre-warm with ASCII printable range (0x20-0x7E) on creation
- Rasterize glyphs via OffscreenCanvas + Canvas2D `fillText()`
- Pack into a single GPU texture (atlas)
- Cache miss: rasterize on demand, append to atlas, grow texture if needed
- Use grayscale antialiasing (avoid subpixel fringing, per red team concern)
- Share one atlas across all terminals (same font config)

### 4. Cell grid consumption

Read ghostty-vt's `CellGrid` (from concern 08 adapter):
```javascript
const grid = ghosttySession.getCellGrid();
// Pack into Float32Array for GPU upload
for (let i = 0; i < grid.cells.length; i++) {
  const cell = grid.cells[i];
  bgInstances.push(cell.col, cell.row, cell.bg[0], cell.bg[1], cell.bg[2]);
  if (cell.codepoint > 0x20) {
    const glyph = fontAtlas.getGlyph(cell.codepoint, cell.attrs);
    fgInstances.push(cell.col, cell.row, glyph.u, glyph.v, glyph.w, glyph.h,
                     cell.fg[0], cell.fg[1], cell.fg[2]);
  }
}
```

### 5. Selection rendering

Overlay pass between bg and glyph passes. Selected cells get an inverted or highlighted
background. Selection state comes from a selection model that tracks mouse drag across
the character grid.

### 6. Scrollback

ghostty-vt manages scrollback buffer internally. On scroll, re-snapshot the visible
viewport from ghostty-vt's scroll position and re-render.

### 7. xterm.js fallback

If WebGL2 context is lost, fall back to xterm.js for that specific terminal. This
requires keeping xterm.js as a dependency even in Phase 3.

## Cross-Repo Side Effects
None.

## Verify
- Terminal renders correctly with custom renderer
- Performance: measure frame time for rapid output (`find /`, `yes`, `cat large-file`)
- Font rendering: all ASCII, Unicode, emoji, wide characters display correctly
- Selection: mouse drag selects text, Cmd+C copies
- Scrollback: scroll up/down works
- Context loss: terminal falls back to xterm.js gracefully
- Compare visual output with xterm.js side-by-side for correctness
