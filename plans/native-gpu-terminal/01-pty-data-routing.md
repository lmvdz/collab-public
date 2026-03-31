# PTY Data Routing to Shell Window
STATUS: done
PRIORITY: p0
REPOS: collab-electron
COMPLEXITY: architectural
TOUCHES: src/main/pty.ts, src/main/index.ts

## Goal
Route all PTY data events (`pty:data`, `pty:exit`, `pty:status-changed`) to the shell
BrowserWindow's webContents instead of per-terminal-tile webview webContents, when
in-process terminal mode is enabled.

## Approach

### 1. Register shell window as PTY data target

In `src/main/index.ts`, after the shell BrowserWindow is created, register its
`webContents.id` with the PTY module:

```typescript
import { registerShellWebContents } from "./pty";
// After shell window creation (~line 500):
registerShellWebContents(mainWindow.webContents.id);
```

### 2. Modify sendToSender routing in pty.ts

Add a `shellWebContentsId` variable and a `registerShellWebContents()` export.

For sessions created via the shell window (in-process mode), `senderWebContentsId`
should be set to `shellWebContentsId` at session creation time.

Key call sites in `pty.ts` that use `sendToSender`:
- `createDirectSession()` — onData handler (~line 376)
- `createDirectSession()` — onExit handler (~line 388)
- `attachClient()` — onData handler for tmux sessions
- `createSession()` sidecar path — data socket routing
- `reconnectSession()` — re-attaching data flow

For the `direct` backend (Bear's branch), this is straightforward: the
`senderWebContentsId` parameter in `createDirectSession` is set to `shellWebContentsId`
when in-process mode is active.

### 3. Unified dispatch in shell renderer

The shell renderer receives ALL `pty:data` events and dispatches by `sessionId`.
This is handled by concern 02 (shell preload) and 03 (terminal-embed).

### Cross-Repo Side Effects
None — contained to collab-electron.

## Verify
- Create a terminal in in-process mode
- Confirm PTY data arrives at shell window (not webview)
- Confirm `echo test` output appears
- Confirm multiple terminals receive independent data streams
- Confirm webview-mode terminals still work (feature flag off)
