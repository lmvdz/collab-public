/**
 * Performance overlay — game-style HUD showing real-time rendering metrics.
 *
 * Displays:
 *   - FPS counter (1-second smoothed)
 *   - Frame time graph (rolling sparkline, last 120 samples)
 *   - CPU time (JS-side frame work)
 *   - GPU time (via EXT_disjoint_timer_query_webgl2, when available)
 *   - Memory usage (Chromium performance.memory)
 *   - Terminal count
 *
 * Toggle with F3. Zero overhead when hidden — the RAF loop only runs
 * while the overlay is visible.
 *
 * @module perf-overlay
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_SIZE = 120;
const OVERLAY_WIDTH = 280;
const OVERLAY_HEIGHT = 160;
const GRAPH_HEIGHT = 60;
const GRAPH_Y = 90;
const GRAPH_MARGIN = 8;
const TARGET_FPS = 60;
const BG_COLOR = "rgba(0, 0, 0, 0.75)";
const TEXT_COLOR = "#e0e0e0";
const ACCENT_GREEN = "#4caf50";
const ACCENT_YELLOW = "#ffeb3b";
const ACCENT_RED = "#f44336";
const GRAPH_LINE_CPU = "#64b5f6";
const GRAPH_LINE_GPU = "#ff8a65";
const GRAPH_LINE_FRAME = ACCENT_GREEN;
const FONT = '11px "JetBrains Mono", "Cascadia Code", Consolas, monospace';
const FONT_SMALL = '10px "JetBrains Mono", "Cascadia Code", Consolas, monospace';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {HTMLCanvasElement | null} */
let canvas = null;

/** @type {CanvasRenderingContext2D | null} */
let ctx = null;

/** @type {boolean} */
let visible = false;

/** @type {number} */
let rafId = 0;

// Frame timing
let lastFrameTime = 0;
let frameCount = 0;
let fpsAccum = 0;
let currentFps = 0;

// Rolling history (circular buffer)
const frameTimes = new Float32Array(HISTORY_SIZE);
const cpuTimes = new Float32Array(HISTORY_SIZE);
const gpuTimes = new Float32Array(HISTORY_SIZE);
let historyIndex = 0;

// CPU timing — set externally via markCpuStart / markCpuEnd
let cpuStart = 0;
let lastCpuTime = 0;

// GPU timing
/** @type {WebGL2RenderingContext | null} */
let gl = null;
/** @type {any} */
let timerExt = null;
/** @type {WebGLQuery | null} */
let pendingQuery = null;
let lastGpuTime = 0;
let gpuTimingAvailable = false;

// External stats
let terminalCount = 0;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function createCanvas() {
  canvas = document.createElement("canvas");
  canvas.width = OVERLAY_WIDTH * (window.devicePixelRatio || 1);
  canvas.height = OVERLAY_HEIGHT * (window.devicePixelRatio || 1);
  canvas.style.cssText = `
    position: fixed;
    top: 8px;
    right: 8px;
    width: ${OVERLAY_WIDTH}px;
    height: ${OVERLAY_HEIGHT}px;
    z-index: 99999;
    pointer-events: none;
    border-radius: 6px;
    image-rendering: auto;
  `;
  ctx = canvas.getContext("2d");
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  document.body.appendChild(canvas);
}

// ---------------------------------------------------------------------------
// GPU Timer Queries
// ---------------------------------------------------------------------------

/**
 * Attach a WebGL2 context for GPU timer queries.
 * Call once after the shared GL context is created.
 * @param {WebGL2RenderingContext} glContext
 */
export function attachGL(glContext) {
  gl = glContext;
  timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  gpuTimingAvailable = timerExt !== null;
}

/**
 * Begin a GPU timer query. Call before rendering.
 */
export function gpuTimerBegin() {
  if (!gpuTimingAvailable || !gl || pendingQuery) return;
  pendingQuery = gl.createQuery();
  gl.beginQuery(timerExt.TIME_ELAPSED_EXT, pendingQuery);
}

/**
 * End the GPU timer query. Call after rendering.
 */
export function gpuTimerEnd() {
  if (!gpuTimingAvailable || !gl || !pendingQuery) return;
  gl.endQuery(timerExt.TIME_ELAPSED_EXT);
}

/**
 * Collect the GPU timer result (non-blocking).
 * Must be called on the next frame or later.
 */
function collectGpuTime() {
  if (!gl || !pendingQuery) return;

  // Check for disjoint — GPU timer results are unreliable
  const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
  if (disjoint) {
    gl.deleteQuery(pendingQuery);
    pendingQuery = null;
    return;
  }

  const available = gl.getQueryParameter(pendingQuery, gl.QUERY_RESULT_AVAILABLE);
  if (!available) return; // not ready yet, try next frame

  const nsElapsed = gl.getQueryParameter(pendingQuery, gl.QUERY_RESULT);
  lastGpuTime = nsElapsed / 1_000_000; // ns → ms
  gl.deleteQuery(pendingQuery);
  pendingQuery = null;
}

// ---------------------------------------------------------------------------
// CPU timing (called externally around render work)
// ---------------------------------------------------------------------------

export function markCpuStart() {
  cpuStart = performance.now();
}

export function markCpuEnd() {
  lastCpuTime = performance.now() - cpuStart;
}

// ---------------------------------------------------------------------------
// External stats
// ---------------------------------------------------------------------------

/**
 * Update the terminal count displayed in the overlay.
 * @param {number} count
 */
export function setTerminalCount(count) {
  terminalCount = count;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fpsColor(fps) {
  if (fps >= TARGET_FPS - 2) return ACCENT_GREEN;
  if (fps >= 30) return ACCENT_YELLOW;
  return ACCENT_RED;
}

function msColor(ms) {
  if (ms <= 16.7) return ACCENT_GREEN;
  if (ms <= 33.3) return ACCENT_YELLOW;
  return ACCENT_RED;
}

function drawOverlay(now) {
  // Frame timing
  const dt = now - lastFrameTime;
  lastFrameTime = now;
  frameCount++;
  fpsAccum += dt;

  if (fpsAccum >= 1000) {
    currentFps = Math.round((frameCount * 1000) / fpsAccum);
    frameCount = 0;
    fpsAccum = 0;
  }

  // Record history
  frameTimes[historyIndex] = dt;
  cpuTimes[historyIndex] = lastCpuTime;
  gpuTimes[historyIndex] = lastGpuTime;
  historyIndex = (historyIndex + 1) % HISTORY_SIZE;

  // Collect GPU timer from previous frame
  collectGpuTime();

  // Memory
  const mem = /** @type {any} */ (performance).memory;
  const usedMB = mem ? (mem.usedJSHeapSize / (1024 * 1024)).toFixed(0) : "—";
  const totalMB = mem ? (mem.totalJSHeapSize / (1024 * 1024)).toFixed(0) : "—";

  // Draw
  const w = OVERLAY_WIDTH;
  const h = OVERLAY_HEIGHT;
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = BG_COLOR;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 6);
  ctx.fill();

  // -- Text stats --
  let y = 16;
  const col1 = 8;
  const col2 = 150;

  // FPS
  ctx.font = FONT;
  ctx.fillStyle = fpsColor(currentFps);
  ctx.fillText(`${currentFps} FPS`, col1, y);

  ctx.fillStyle = TEXT_COLOR;
  ctx.fillText(`${dt.toFixed(1)} ms/frame`, col2, y);
  y += 16;

  // CPU / GPU
  ctx.fillStyle = msColor(lastCpuTime);
  ctx.fillText(`CPU: ${lastCpuTime.toFixed(2)} ms`, col1, y);

  if (gpuTimingAvailable) {
    ctx.fillStyle = msColor(lastGpuTime);
    ctx.fillText(`GPU: ${lastGpuTime.toFixed(2)} ms`, col2, y);
  } else {
    ctx.fillStyle = "#666";
    ctx.fillText("GPU: n/a", col2, y);
  }
  y += 16;

  // Memory / Terminals
  ctx.fillStyle = TEXT_COLOR;
  ctx.fillText(`Mem: ${usedMB} / ${totalMB} MB`, col1, y);
  ctx.fillText(`Terminals: ${terminalCount}`, col2, y);
  y += 16;

  // Renderer label
  ctx.font = FONT_SMALL;
  ctx.fillStyle = "#888";
  ctx.fillText("WebGL2 Instanced", col1, y);
  if (gpuTimingAvailable) {
    ctx.fillText("GPU timer: active", col2, y);
  }

  // -- Frame time graph --
  const gx = GRAPH_MARGIN;
  const gy = GRAPH_Y;
  const gw = w - GRAPH_MARGIN * 2;
  const gh = GRAPH_HEIGHT;

  // Graph background
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.fillRect(gx, gy, gw, gh);

  // 16.67ms target line
  const targetY = gy + gh - (16.67 / 50) * gh;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(gx, targetY);
  ctx.lineTo(gx + gw, targetY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw graph lines
  drawGraphLine(gx, gy, gw, gh, frameTimes, GRAPH_LINE_FRAME, 50);
  drawGraphLine(gx, gy, gw, gh, cpuTimes, GRAPH_LINE_CPU, 50);
  if (gpuTimingAvailable) {
    drawGraphLine(gx, gy, gw, gh, gpuTimes, GRAPH_LINE_GPU, 50);
  }

  // Graph legend
  const legendY = gy + gh + 12;
  ctx.font = FONT_SMALL;
  drawLegendDot(gx, legendY, GRAPH_LINE_FRAME, "frame");
  drawLegendDot(gx + 55, legendY, GRAPH_LINE_CPU, "cpu");
  if (gpuTimingAvailable) {
    drawLegendDot(gx + 100, legendY, GRAPH_LINE_GPU, "gpu");
  }

  // Target label
  ctx.fillStyle = "#666";
  ctx.fillText("16.67ms", gx + gw - 42, targetY - 3);
}

function drawGraphLine(gx, gy, gw, gh, data, color, maxMs) {
  const step = gw / (HISTORY_SIZE - 1);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  for (let i = 0; i < HISTORY_SIZE; i++) {
    const idx = (historyIndex + i) % HISTORY_SIZE;
    const val = Math.min(data[idx], maxMs);
    const x = gx + i * step;
    const y = gy + gh - (val / maxMs) * gh;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  ctx.stroke();
  ctx.lineWidth = 1;
}

function drawLegendDot(x, y, color, label) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y - 4, 6, 6);
  ctx.fillStyle = TEXT_COLOR;
  ctx.fillText(label, x + 10, y + 1);
}

// ---------------------------------------------------------------------------
// RAF loop
// ---------------------------------------------------------------------------

function tick(now) {
  if (!visible) return;
  drawOverlay(now);
  rafId = requestAnimationFrame(tick);
}

function startLoop() {
  lastFrameTime = performance.now();
  frameCount = 0;
  fpsAccum = 0;
  rafId = requestAnimationFrame(tick);
}

function stopLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

export function toggle() {
  visible = !visible;
  if (visible) {
    if (!canvas) createCanvas();
    canvas.style.display = "block";
    startLoop();
  } else {
    if (canvas) canvas.style.display = "none";
    stopLoop();
  }
}

export function isVisible() {
  return visible;
}

// ---------------------------------------------------------------------------
// Keyboard shortcut (F3)
// ---------------------------------------------------------------------------

export function initKeyboardShortcut() {
  window.addEventListener("keydown", (e) => {
    if (e.key === "F3" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      toggle();
    }
  });
}
