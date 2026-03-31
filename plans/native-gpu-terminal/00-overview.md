# Native GPU Terminal Rendering — Plan Overview

## Goal
Replace per-terminal `<webview>` processes with in-process xterm.js in shell renderer,
then incrementally adopt libghostty-vt for VT parsing and custom GPU rendering.

Branch: `BearHuddleston/fix-windows-terminal-backend`

## Scope

| # | Concern | Complexity | Touches | Phase |
|---|---------|-----------|---------|-------|
| 01 | PTY data routing to shell window | architectural | pty.ts, index.ts, preload/shell.ts | 1 |
| 02 | Shell preload PTY API | mechanical | preload/shell.ts | 1 |
| 03 | Terminal embed module | architectural | NEW: shell/src/terminal-embed.js | 1 |
| 04 | Tile manager: webview → div | architectural | shell/src/tile-manager.js | 1 |
| 05 | Vite config: bundle xterm.js into shell | mechanical | electron.vite.config.ts, package.json | 1 |
| 06 | Feature flag + backward compat | mechanical | config.ts, tile-manager.js | 1 |
| 07 | Session restore for in-process terminals | architectural | tile-manager.js, terminal-embed.js, pty.ts | 1 |
| 08 | ghostty-vt WASM adapter | research | NEW: shell/src/ghostty-adapter.js | 2 |
| 09 | ghostty-vt ↔ xterm.js bridge | architectural | terminal-embed.js, ghostty-adapter.js | 2 |
| 10 | Custom WebGL2 instanced renderer | research | NEW: shell/src/gpu-terminal-renderer.js | 3 |

## Dependency Graph

```
[05] Vite config ─────────────────┐
[06] Feature flag ────────────────┤
[02] Shell preload PTY API ──────┤
                                  ├──> [01] PTY routing ──> [03] Terminal embed ──> [04] Tile manager
                                  │                                                       │
                                  │                                                  [07] Session restore
                                  │
                                  └──────────────> Phase 1 complete
                                                        │
                                                   [08] ghostty-vt adapter ──> [09] ghostty ↔ xterm bridge
                                                        │
                                                   Phase 2 complete
                                                        │
                                                   [10] Custom GPU renderer
                                                        │
                                                   Phase 3 complete
```

## Batch Order

### Batch 1 (parallel, no blockers)
- 02-shell-preload-pty-api.md (mechanical)
- 05-vite-config.md (mechanical)
- 06-feature-flag.md (mechanical)

### Batch 2 (depends on Batch 1)
- 01-pty-data-routing.md (architectural)

### Batch 3 (depends on Batch 2)
- 03-terminal-embed.md (architectural)

### Batch 4 (depends on Batch 3)
- 04-tile-manager-webview-to-div.md (architectural)

### Batch 5 (depends on Batch 4)
- 07-session-restore.md (architectural)

### Batch 6 (Phase 2, depends on Phase 1 complete)
- 08-ghostty-vt-adapter.md (research)

### Batch 7 (depends on Batch 6)
- 09-ghostty-xterm-bridge.md (architectural)

### Batch 8 (Phase 3, depends on Phase 2 complete)
- 10-custom-gpu-renderer.md (research)

## Estimated Batches: 8 (Phase 1: 5, Phase 2: 2, Phase 3: 1)
