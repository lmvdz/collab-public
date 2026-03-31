# Feature Flag + Backward Compatibility
STATUS: done
PRIORITY: p0
REPOS: collab-electron
COMPLEXITY: mechanical
TOUCHES: src/main/config.ts, src/windows/shell/src/tile-manager.js

## Goal
Add a configuration flag `ui.inProcessTerminals` that gates the new in-process terminal
rendering. Default: `true` on Windows, `false` on macOS (until validated). Both code
paths coexist.

## Approach

### 1. Config flag in src/main/config.ts

```typescript
export function getInProcessTerminals(): boolean {
  const config = loadConfig();
  const pref = getPref(config, "inProcessTerminals");
  if (pref === true || pref === false) return pref;
  // Default: true on Windows (where perf matters most), false on macOS
  return process.platform === "win32";
}
```

### 2. Expose via shell preload

In `src/preload/shell.ts`, add to `shellApi`:
```typescript
getInProcessTerminals: () => ipcRenderer.invoke("shell:get-in-process-terminals"),
```

In `src/main/index.ts`, register handler:
```typescript
ipcMain.handle("shell:get-in-process-terminals", () => getInProcessTerminals());
```

### 3. Pass to shell renderer at startup

Include in the existing `shell:get-view-config` response or as a separate config call.
The shell renderer queries this on init and stores it for tile-manager to check.

### 4. Settings UI (optional)

Add a toggle in the Windows terminal settings pane (`src/windows/settings/src/App.tsx`
`WindowsTerminalPane`) for users to switch between modes.

## Cross-Repo Side Effects
None.

## Verify
- Flag defaults to true on Windows, false on macOS
- Setting `inProcessTerminals: false` in config falls back to webview mode
- Setting `inProcessTerminals: true` uses in-process mode
- Both modes work simultaneously (different terminals can't mix, but switching the flag works)
