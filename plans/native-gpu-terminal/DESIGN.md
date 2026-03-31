# Design: Native GPU Terminal Rendering

## Approach: In-Process xterm.js with Deferred GPU Renderer (Phased Hybrid)

Eliminate per-terminal `<webview>` processes by mounting xterm.js instances directly in the
shell renderer DOM. Then incrementally replace xterm.js internals with libghostty-vt for VT
parsing (Phase 2) and a custom instanced GPU renderer (Phase 3).

Builds on `BearHuddleston/fix-windows-terminal-backend` branch (direct PTY backend).

## Key Decisions

| Decision | Choice | Alternatives considered | Rationale |
|----------|--------|------------------------|-----------|
| Rendering location | Shell renderer process (in-process) | Hidden BrowserWindow (rejected) | Red team proved offscreen approach has 3 structural flaws: GPU-CPU-GPU readback, COOP/COEP breaks browser tiles, Chromium throttles hidden windows |
| Terminal embedding | `<div>` in tile DOM, xterm.js attached directly | `<webview>` per terminal (current), `<canvas>` only | xterm.js in shell DOM preserves IME, selection, clipboard, a11y with zero reimplementation |
| VT parser (Phase 2) | ghostty-web WASM (~400KB) behind adapter | xterm.js parser (keep), native N-API addon | WASM has zero build-system dependency, ~400KB committed binary, adapter isolates API instability. N-API adds Zig toolchain to CI |
| GPU renderer (Phase 3) | Custom WebGL2 instanced-quad renderer | xterm.js WebglAddon (keep), WebGPU | WebGL2 is stable in Electron 40, sufficient for instanced cell rendering. WebGPU needs flag. Phase 3 only triggers if xterm.js perf is insufficient |
| PTY data routing | All sessions route to shell window webContentsId | Per-webview routing (current) | One dispatch point; shell renderer demuxes by sessionId |
| Pixel transport | None (same-process rendering) | SharedArrayBuffer (rejected), ImageBitmap (rejected) | No cross-process boundary = no transport needed |
| Backward compatibility | Config flag `ui.inProcessTerminals` gates new path | Big-bang rewrite | Both webview and in-process paths coexist during transition |
| macOS compatibility | Same architecture, platform-agnostic | Windows-only | Phase 1 is pure renderer-side JS — works on all platforms |

## Architecture

### Phase 1: Webview Elimination
```
node-pty (main process)
  | onData -> sendToSender(shellWindowId, "pty:data", {sessionId, data})
  v
Shell BrowserWindow preload (shell.ts)
  | ipcRenderer.on("pty:data") -> dispatch by sessionId
  v
terminal-embed.js -> TerminalInstance[sessionId]
  | xterm.js Terminal.write(data) -> WebglAddon renders
  v
<canvas> inside tile <div> in shell DOM
```

### Phase 2: ghostty-vt Parser
```
pty:data -> ghostty_vt_wasm.feed(bytes) -> cell grid
  -> sync to xterm.js buffer -> WebglAddon renders
```

### Phase 3: Custom GPU Renderer
```
pty:data -> ghostty_vt_wasm.feed(bytes) -> cell grid (ArrayBuffer)
  -> custom WebGL2 instanced renderer reads cell grid directly
  -> renders to tile <canvas>
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Shell renderer crash kills all terminals + canvas | Low | High | RingBuffer scrollback in main process (Bear's branch) enables recovery. Same risk level as current shell renderer crash |
| Many xterm.js instances cause main-thread jank | Medium | Medium | 5ms coalescing already exists. Only write() to visible terminals; buffer hidden terminals |
| WebGL context limit (~16 per process) | Medium | Medium | xterm.js handles context loss gracefully (DOM fallback). Lazy-dispose offscreen terminals |
| ghostty-web WASM API instability (Phase 2) | High | Low | Adapter pattern. Phase 1 works without ghostty-vt. Pin version |
| Single renderer process memory pressure | Medium | Low | 10 in-process terminals ~150MB vs ~600MB in webviews. Net savings even with overhead |

## Red Team Concerns Addressed

| Concern | Severity | Resolution |
|---------|----------|------------|
| GPU-CPU-GPU readback defeats purpose | Critical | Eliminated. No pixel transport. All rendering in shell GPU context |
| SharedArrayBuffer COOP/COEP breaks browser tiles | Critical | Eliminated. No SharedArrayBuffer needed |
| Hidden window throttled by Chromium | Critical | No hidden window. Shell window always has full GPU priority |
| PTY sendToSender hardwired to webview ID | Critical | senderWebContentsId points to shell window. Dispatch by sessionId in renderer |
| IME incompatible with canvas-only | Significant | xterm.js handles IME natively via hidden textarea |
| Selection/clipboard not deferrable | Significant | xterm.js handles both natively |
| GPU context loss kills all terminals | Significant | In-process: context loss per-terminal, xterm.js falls back to DOM renderer per instance |
| Pixel bandwidth infeasible (~5.6 GB/s) | Critical | Eliminated. No pixel transport |

## Open Questions

1. **WebGL context limit**: How many simultaneous xterm.js WebGL contexts can one Chromium renderer sustain? (~16 limit). Test empirically. Beyond 16, Canvas2D fallback per-terminal.
2. **ghostty-web distribution**: npm package or vendored WASM? Check Coder's publishing strategy.
3. **Sidecar data sockets**: sidecar sessions stream via Unix socket to webview webContentsId. Needs same rerouting.
4. **terminal-tile window removal**: Keep behind flag for one release cycle, then remove.
