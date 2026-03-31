# Shell Preload PTY API
STATUS: done
PRIORITY: p0
REPOS: collab-electron
COMPLEXITY: mechanical
TOUCHES: src/preload/shell.ts

## Goal
Expose PTY IPC methods on `window.shellApi` so the shell renderer can create, write to,
resize, and receive data from terminal sessions without going through a webview.

## Approach

Add the following methods to the `shellApi` context bridge in `src/preload/shell.ts`:

```typescript
// Session lifecycle
ptyCreate: (cwd?: string, cols?: number, rows?: number, target?: string) =>
  ipcRenderer.invoke("pty:create", cwd, cols, rows, target),

ptyReconnect: (sessionId: string, cols: number, rows: number) =>
  ipcRenderer.invoke("pty:reconnect", sessionId, cols, rows),

ptyReadMeta: (sessionId: string) =>
  ipcRenderer.invoke("pty:read-meta", sessionId),

ptyDiscover: () =>
  ipcRenderer.invoke("pty:discover"),

ptyCleanDetached: (activeSessionIds: string[]) =>
  ipcRenderer.invoke("pty:clean-detached", activeSessionIds),

// Session I/O
ptyWrite: (sessionId: string, data: string) =>
  ipcRenderer.invoke("pty:write", sessionId, data),

ptySendRawKeys: (sessionId: string, data: string) =>
  ipcRenderer.invoke("pty:send-raw-keys", sessionId, data),

ptyResize: (sessionId: string, cols: number, rows: number) =>
  ipcRenderer.invoke("pty:resize", sessionId, cols, rows),

ptyKill: (sessionId: string) =>
  ipcRenderer.invoke("pty:kill", sessionId),

// Data listeners (dispatched by sessionId in renderer)
onPtyData: (callback: (sessionId: string, data: Uint8Array) => void) => {
  const handler = (_: any, payload: { sessionId: string; data: Uint8Array }) =>
    callback(payload.sessionId, payload.data);
  ipcRenderer.on("pty:data", handler);
  return () => ipcRenderer.removeListener("pty:data", handler);
},

onPtyExit: (callback: (sessionId: string, exitCode: number) => void) => {
  const handler = (_: any, payload: { sessionId: string; exitCode: number }) =>
    callback(payload.sessionId, payload.exitCode);
  ipcRenderer.on("pty:exit", handler);
  return () => ipcRenderer.removeListener("pty:exit", handler);
},
```

Mirror the API shape from `universal.ts` but without per-session buffering (the
terminal-embed module handles dispatch).

## Cross-Repo Side Effects
None.

## Verify
- TypeScript compiles without errors
- `window.shellApi.ptyCreate` is callable from shell renderer console
- IPC handlers in main process respond correctly
