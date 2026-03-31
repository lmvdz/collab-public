# Session Restore for In-Process Terminals
STATUS: done (covered by concerns 03 and 04)
PRIORITY: p1
REPOS: collab-electron
COMPLEXITY: architectural
TOUCHES: src/windows/shell/src/tile-manager.js, src/windows/shell/src/terminal-embed.js, src/main/pty.ts

## Goal
When the app restarts, terminal tiles in in-process mode must reconnect to their PTY
sessions and restore scrollback, matching the existing webview-based restore behavior.

## Approach

### 1. Canvas state already persists ptySessionId

The existing `getCanvasStateForSave()` in `canvas-state.js` already saves `ptySessionId`
per tile. No change needed for persistence.

### 2. Restore flow in tile-manager.js

`restoreCanvasState()` (line 609) iterates saved tiles and re-spawns them. For in-process
terminals, the `spawnTerminalDiv()` function (concern 04) already handles reconnection:

```javascript
// In spawnTerminalDiv initTerminal():
if (tile.ptySessionId) {
  const result = await window.shellApi.ptyReconnect(sessionId, cols, rows);
  // result.scrollback contains terminal history from RingBuffer
  // result.mode tells us the backend type
  const handle = createTerminal(container, sessionId, {
    scrollbackData: result.scrollback,
    mode: result.mode,
  });
}
```

### 3. Terminal embed handles scrollback

In `terminal-embed.js`, when `options.scrollbackData` is provided:
- Write scrollback to terminal before attaching data listener
- For `mode === "tmux"`: clear screen first (`\x1b[2J\x1b[H`) per TerminalTab.tsx line 184
- For `mode === "direct"`: no clear needed, just write scrollback

### 4. Direct backend RingBuffer

Bear's branch stores scrollback in a `RingBuffer` for direct sessions. On reconnect,
`pty.ts` `reconnectSession()` reads from the ring buffer and returns it as `scrollback`.
This works identically regardless of whether the consumer is a webview or the shell window.

### 5. Session discovery on startup

On shell window init, call `window.shellApi.ptyDiscover()` to list active sessions.
Match against saved canvas state `ptySessionId` values. Clean up orphans via
`window.shellApi.ptyCleanDetached(activeSessionIds)`.

This logic currently lives in `terminal-tile/App.tsx` lines 53-101. Port the discovery
+ reconnect + fallback logic to `tile-manager.js` or `terminal-embed.js`.

## Cross-Repo Side Effects
None.

## Verify
- Create terminal, type `echo hello`, quit and relaunch app
- Terminal tile restores with scrollback showing `echo hello`
- Direct backend sessions survive restart and reconnect
- Orphan sessions are cleaned up
- Mixed mode: webview terminals and in-process terminals both restore correctly
