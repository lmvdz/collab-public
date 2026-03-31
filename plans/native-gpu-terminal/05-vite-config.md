# Vite Config: Bundle xterm.js into Shell
STATUS: done (no changes needed)
PRIORITY: p0
REPOS: collab-electron
COMPLEXITY: mechanical
TOUCHES: electron.vite.config.ts

## Goal
Ensure xterm.js and its addons are bundled into the shell renderer window's build output,
not just the terminal-tile window.

## Approach

Currently xterm.js is imported by `packages/components/src/Terminal/TerminalTab.tsx` which
is bundled into the terminal-tile renderer entry. The shell renderer entry
(`src/windows/shell/index.html`) does not import xterm.js.

When `terminal-embed.js` (concern 03) imports xterm.js, Vite will automatically bundle
it into the shell renderer output. No explicit config change should be needed because:

1. The shell entry in `electron.vite.config.ts` line 76 is:
   `shell: resolve(__dirname, "src/windows/shell/index.html")`
2. Vite traces imports from there through `renderer.js` → `tile-manager.js` → `terminal-embed.js`
3. xterm.js will be tree-shaken into the shell bundle

**Verify this works.** If xterm.js fails to bundle (e.g., due to CSS imports or
dynamic requires), add explicit resolve aliases:

```typescript
// In renderer config:
resolve: {
  alias: {
    '@xterm/xterm': resolve(__dirname, 'node_modules/@xterm/xterm'),
  }
}
```

Also ensure xterm.js CSS is imported in `terminal-embed.js`:
```javascript
import "@xterm/xterm/css/xterm.css";
```

## Cross-Repo Side Effects
None.

## Verify
- `bun run build` succeeds
- Shell renderer bundle includes xterm.js
- `bun run dev` hot-reload works for terminal-embed changes
- Terminal-tile window (webview mode) still works independently
