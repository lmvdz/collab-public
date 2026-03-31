# Tile Manager: Webview to Div
STATUS: done
PRIORITY: p0
REPOS: collab-electron
COMPLEXITY: architectural
TOUCHES: src/windows/shell/src/tile-manager.js, src/windows/shell/src/tile-renderer.js

## Goal
Replace `spawnTerminalWebview()` with `spawnTerminalDiv()` for terminal tiles when
in-process mode is enabled. The tile's `contentArea` gets a `<div>` with an xterm.js
instance instead of a `<webview>` element.

## Approach

### 1. New function in tile-manager.js

Add `spawnTerminalDiv(tile, autoFocus)` alongside the existing `spawnTerminalWebview()`:

```javascript
import { createTerminal, disposeTerminal } from "./terminal-embed.js";

function spawnTerminalDiv(tile, autoFocus = false) {
  const dom = tileDOMs.get(tile.id);
  if (!dom) return;

  // Create container div for xterm.js
  const container = document.createElement("div");
  container.className = "terminal-embed-container";
  container.style.width = "100%";
  container.style.height = "100%";
  dom.contentArea.appendChild(container);
  dom.terminalContainer = container;

  // Create or reconnect session
  const initTerminal = async () => {
    let sessionId = tile.ptySessionId;
    let scrollbackData = null;

    if (sessionId) {
      // Reconnect existing session
      try {
        const result = await window.shellApi.ptyReconnect(sessionId, 80, 24);
        scrollbackData = result.scrollback;
      } catch {
        // Session gone, create new
        sessionId = null;
      }
    }

    if (!sessionId) {
      const result = await window.shellApi.ptyCreate(tile.cwd);
      sessionId = result.sessionId;
      tile.ptySessionId = sessionId;
      saveCanvasDebounced();
    }

    const handle = createTerminal(container, sessionId, { scrollbackData });

    if (autoFocus) {
      handle.focus();
    }
  };

  initTerminal();
}
```

### 2. Gate by feature flag

In `createCanvasTile()` and `restoreCanvasState()`, check config:

```javascript
if (tile.type === "term") {
  if (getInProcessTerminals()) {
    spawnTerminalDiv(tile, autoFocus);
  } else {
    spawnTerminalWebview(tile, autoFocus);
  }
}
```

### 3. Update closeCanvasTile()

When closing a terminal tile in in-process mode, dispose the terminal embed:

```javascript
if (dom.terminalContainer) {
  disposeTerminal(tile.ptySessionId);
}
```

### 4. Update focus handling

`focusCanvasTile()` currently calls `dom.webview.focus()` (line 170). For in-process
terminals, call the terminal embed's `focus()` instead:

```javascript
if (dom.terminalContainer) {
  const handle = getTerminal(tile.ptySessionId);
  handle?.focus();
} else if (dom.webview) {
  dom.webview.focus();
}
```

### 5. Update blur handling

`blurCanvasTileGuest()` sends `shell-blur` to webview (line 121). For in-process:

```javascript
if (dom.terminalContainer) {
  const handle = getTerminal(tile.ptySessionId);
  handle?.blur();
} else if (dom.webview) {
  dom.webview.send("shell-blur");
}
```

### 6. CSS for terminal-embed-container

Add to `shell.css`:
```css
.terminal-embed-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
```

## Cross-Repo Side Effects
None.

## Verify
- Double-click canvas creates terminal tile with xterm.js (no webview in DevTools)
- Terminal is interactive: type commands, see output
- Close tile kills PTY session
- Focus/blur works correctly when switching between tiles
- Drag and resize tile, terminal reflows
- Canvas zoom: terminal content scales correctly
- Multiple terminal tiles work simultaneously
- Non-terminal tiles (graph, browser, code) still use webviews
