/**
 * SharedGLContext — manages a single WebGL2 context shared across all terminal
 * tiles in the Collaborator shell window.
 *
 * Solves Chromium's ~16 WebGL context limit by allocating per-terminal
 * framebuffer objects (FBOs) for offscreen rendering, then blitting results
 * to each terminal's visible canvas.
 *
 * Architecture:
 *   1. One hidden OffscreenCanvas holds the sole WebGL2 context.
 *   2. Each terminal gets an FBO + color texture attachment sized to its
 *      pixel dimensions.
 *   3. The renderer binds a terminal's FBO before drawing, unbinds after.
 *   4. blitToCanvas() copies the FBO content to the visible <canvas> via
 *      blitFramebuffer → transferToImageBitmap → transferFromImageBitmap.
 *
 * Designed for integration with WebGL2TerminalRenderer (step 10d will
 * refactor that class to accept an external GL context + FBO handle instead
 * of creating its own context).
 *
 * @module shared-gl-context
 */

import FontAtlas from "./font-atlas.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default offscreen canvas width in pixels. */
const DEFAULT_WIDTH = 1920;

/** Default offscreen canvas height in pixels. */
const DEFAULT_HEIGHT = 1080;

// ---------------------------------------------------------------------------
// Types (JSDoc)
// ---------------------------------------------------------------------------

/**
 * Per-terminal FBO handle returned by allocateTerminal().
 * @typedef {Object} TerminalFBOHandle
 * @property {WebGLFramebuffer} fbo      - The framebuffer object
 * @property {WebGLTexture}     texture  - The color attachment texture
 * @property {number}           width    - Current texture width in pixels
 * @property {number}           height   - Current texture height in pixels
 */

/**
 * Internal record stored per terminal in the allocation map.
 * @typedef {Object} TerminalRecord
 * @property {string}            id       - Terminal identifier
 * @property {WebGLFramebuffer}  fbo      - Framebuffer object
 * @property {WebGLTexture}      texture  - Color attachment (RGBA)
 * @property {number}            width    - Pixel width
 * @property {number}            height   - Pixel height
 */

// ---------------------------------------------------------------------------
// SharedGLContext
// ---------------------------------------------------------------------------

export default class SharedGLContext {
  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  /**
   * Creates the hidden offscreen canvas and WebGL2 context.
   *
   * @param {Object} [options]
   * @param {number} [options.fontSize=14]           - Logical font size (CSS px)
   * @param {string} [options.fontFamily='Menlo, Monaco, "Courier New", monospace']
   * @param {number} [options.devicePixelRatio=1]    - Display DPR
   */
  constructor(options = {}) {
    const {
      fontSize = 14,
      fontFamily = 'Menlo, Monaco, "Courier New", monospace',
      devicePixelRatio = (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1,
    } = options;

    // --- OffscreenCanvas + WebGL2 context ---------------------------------

    /** @type {OffscreenCanvas} */
    this._offscreen = new OffscreenCanvas(DEFAULT_WIDTH, DEFAULT_HEIGHT);

    /** @type {WebGL2RenderingContext | null} */
    this._gl = this._offscreen.getContext("webgl2", {
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });

    if (!this._gl) {
      throw new Error("SharedGLContext: WebGL2 not available on OffscreenCanvas");
    }

    // --- Context loss / restore -------------------------------------------

    /** @type {boolean} */
    this._contextLost = false;

    /** @type {boolean} */
    this._disposed = false;

    this._onContextLost = /** @param {Event} e */ (e) => {
      e.preventDefault();
      this._contextLost = true;
      console.warn("[shared-gl-context] WebGL2 context lost");
    };

    this._onContextRestored = () => {
      console.info("[shared-gl-context] WebGL2 context restored, rebuilding resources");
      this._contextLost = false;
      this._rebuildAfterRestore();
    };

    this._offscreen.addEventListener("webglcontextlost", this._onContextLost);
    this._offscreen.addEventListener("webglcontextrestored", this._onContextRestored);

    // --- Font atlas (shared singleton) ------------------------------------

    /** @type {number} */
    this._fontSize = fontSize;

    /** @type {string} */
    this._fontFamily = fontFamily;

    /** @type {number} */
    this._dpr = devicePixelRatio;

    /** @type {FontAtlas} */
    this._fontAtlas = new FontAtlas(fontSize, fontFamily, devicePixelRatio);

    /** @type {WebGLTexture | null} */
    this._atlasTexture = null;

    // --- Per-terminal FBO map ---------------------------------------------

    /** @type {Map<string, TerminalRecord>} */
    this._terminals = new Map();

    // Initial atlas upload
    this._uploadAtlas();
  }

  // -----------------------------------------------------------------------
  // Shared resources
  // -----------------------------------------------------------------------

  /**
   * Returns the shared WebGL2 rendering context.
   * The renderer uses this directly for draw calls, shader compilation, etc.
   *
   * @returns {WebGL2RenderingContext}
   */
  getGL() {
    return this._gl;
  }

  /**
   * Returns the shared FontAtlas instance.
   * All terminals share one atlas (same font configuration).
   *
   * @returns {FontAtlas}
   */
  getFontAtlas() {
    return this._fontAtlas;
  }

  /**
   * Returns the shared atlas WebGLTexture, uploading if the atlas has been
   * modified since the last call.
   *
   * @returns {WebGLTexture}
   */
  getAtlasTexture() {
    this._uploadAtlas();
    return this._atlasTexture;
  }

  /**
   * Returns true if the WebGL2 context is currently lost.
   * Callers should skip rendering and fall back to Canvas2D when true.
   *
   * @returns {boolean}
   */
  isContextLost() {
    return this._contextLost;
  }

  // -----------------------------------------------------------------------
  // Terminal lifecycle
  // -----------------------------------------------------------------------

  /**
   * Allocate an FBO and color texture for a terminal.
   *
   * @param {string} id          - Unique terminal identifier
   * @param {number} pixelWidth  - Framebuffer width in device pixels
   * @param {number} pixelHeight - Framebuffer height in device pixels
   * @returns {TerminalFBOHandle}
   */
  allocateTerminal(id, pixelWidth, pixelHeight) {
    if (this._terminals.has(id)) {
      console.warn(`[shared-gl-context] Terminal "${id}" already allocated, resizing`);
      return this.resizeTerminal(id, pixelWidth, pixelHeight);
    }

    const gl = this._gl;
    const width = Math.max(1, Math.round(pixelWidth));
    const height = Math.max(1, Math.round(pixelHeight));

    // Create color texture
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8,
      width, height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Create FBO and attach texture
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, texture, 0,
    );

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(fbo);
      throw new Error(
        `[shared-gl-context] Framebuffer incomplete for terminal "${id}": 0x${status.toString(16)}`,
      );
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    /** @type {TerminalRecord} */
    const record = { id, fbo, texture, width, height };
    this._terminals.set(id, record);

    // Ensure the offscreen canvas is large enough for blitting
    this._ensureOffscreenSize(width, height);

    return { fbo, texture, width, height };
  }

  /**
   * Resize an existing terminal's FBO and texture.
   * The old texture is deleted and a new one is created at the new size.
   *
   * @param {string} id          - Terminal identifier
   * @param {number} pixelWidth  - New width in device pixels
   * @param {number} pixelHeight - New height in device pixels
   * @returns {TerminalFBOHandle}
   */
  resizeTerminal(id, pixelWidth, pixelHeight) {
    const record = this._terminals.get(id);
    if (!record) {
      throw new Error(`[shared-gl-context] Terminal "${id}" not allocated`);
    }

    const gl = this._gl;
    const width = Math.max(1, Math.round(pixelWidth));
    const height = Math.max(1, Math.round(pixelHeight));

    // Skip if dimensions unchanged
    if (record.width === width && record.height === height) {
      return { fbo: record.fbo, texture: record.texture, width, height };
    }

    // Delete old texture, reallocate at new size
    gl.deleteTexture(record.texture);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8,
      width, height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Re-attach to existing FBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, record.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, texture, 0,
    );

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(
        `[shared-gl-context] Framebuffer incomplete after resize for "${id}": 0x${status.toString(16)}`,
      );
    }

    record.texture = texture;
    record.width = width;
    record.height = height;

    // Ensure the offscreen canvas is large enough for blitting
    this._ensureOffscreenSize(width, height);

    return { fbo: record.fbo, texture, width, height };
  }

  /**
   * Release an FBO and its texture for a terminal.
   *
   * @param {string} id - Terminal identifier
   */
  releaseTerminal(id) {
    const record = this._terminals.get(id);
    if (!record) return;

    const gl = this._gl;
    gl.deleteFramebuffer(record.fbo);
    gl.deleteTexture(record.texture);
    this._terminals.delete(id);
  }

  /**
   * Returns the FBO handle for a terminal, or null if not allocated.
   *
   * @param {string} id - Terminal identifier
   * @returns {TerminalFBOHandle | null}
   */
  getTerminalHandle(id) {
    const record = this._terminals.get(id);
    if (!record) return null;
    return {
      fbo: record.fbo,
      texture: record.texture,
      width: record.width,
      height: record.height,
    };
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  /**
   * Bind a terminal's FBO and set the viewport to its dimensions.
   * Call this before the renderer issues draw calls for the terminal.
   *
   * @param {string} id - Terminal identifier
   */
  bindForRendering(id) {
    const record = this._terminals.get(id);
    if (!record) {
      throw new Error(`[shared-gl-context] Cannot bind: terminal "${id}" not allocated`);
    }

    const gl = this._gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, record.fbo);
    gl.viewport(0, 0, record.width, record.height);
  }

  /**
   * Unbind the current FBO (bind default framebuffer).
   * Call after the renderer finishes drawing for a terminal.
   */
  unbindFramebuffer() {
    const gl = this._gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Copy the rendered FBO content to a visible canvas element.
   *
   * Strategy: blit FBO -> default framebuffer (offscreen canvas), then
   * transferToImageBitmap -> transferFromImageBitmap on the visible canvas.
   * This avoids gl.readPixels entirely for maximum throughput.
   *
   * @param {string} id                  - Terminal identifier
   * @param {HTMLCanvasElement} canvas    - The visible canvas to draw into
   */
  blitToCanvas(id, canvas) {
    const record = this._terminals.get(id);
    if (!record) {
      throw new Error(`[shared-gl-context] Cannot blit: terminal "${id}" not allocated`);
    }

    if (this._contextLost) return;

    const gl = this._gl;
    const { width, height } = record;

    // Resize offscreen canvas to match this terminal's FBO so the blit
    // covers exactly the right region and transferToImageBitmap captures
    // just the terminal content.
    this._resizeOffscreen(width, height);

    // Blit from terminal FBO (READ) to default framebuffer (DRAW)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, record.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

    gl.blitFramebuffer(
      0, 0, width, height,   // src rect
      0, 0, width, height,   // dst rect
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);

    // Transfer the default framebuffer content to an ImageBitmap
    const bitmap = this._offscreen.transferToImageBitmap();

    // Draw onto the visible canvas
    // Ensure the visible canvas has a bitmaprenderer or 2d context
    let ctx = canvas._sharedGLBitmapCtx;
    if (!ctx) {
      // Prefer ImageBitmapRenderingContext (zero-copy) over 2D drawImage
      ctx = canvas.getContext("bitmaprenderer");
      if (!ctx) {
        // Fallback: use 2D context
        ctx = canvas.getContext("2d");
      }
      canvas._sharedGLBitmapCtx = ctx;
    }

    if (typeof ctx.transferFromImageBitmap === "function") {
      // ImageBitmapRenderingContext path (zero-copy, fastest)
      ctx.transferFromImageBitmap(bitmap);
    } else if (typeof ctx.drawImage === "function") {
      // CanvasRenderingContext2D fallback
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
    } else {
      bitmap.close();
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Upload (or re-upload) the font atlas texture to the shared GL context.
   * @private
   */
  _uploadAtlas() {
    if (this._contextLost) return;
    this._atlasTexture = this._fontAtlas.uploadToGL(this._gl);
  }

  /**
   * Ensure the offscreen canvas is at least as large as the given dimensions.
   * Only grows; never shrinks (to avoid constant reallocation).
   *
   * @param {number} width
   * @param {number} height
   * @private
   */
  _ensureOffscreenSize(width, height) {
    let changed = false;
    let newW = this._offscreen.width;
    let newH = this._offscreen.height;

    if (width > newW) {
      newW = width;
      changed = true;
    }
    if (height > newH) {
      newH = height;
      changed = true;
    }

    if (changed) {
      this._offscreen.width = newW;
      this._offscreen.height = newH;
    }
  }

  /**
   * Resize the offscreen canvas to exactly the given dimensions.
   * Used before blitFramebuffer so transferToImageBitmap captures the
   * correct region.
   *
   * @param {number} width
   * @param {number} height
   * @private
   */
  _resizeOffscreen(width, height) {
    if (this._offscreen.width !== width || this._offscreen.height !== height) {
      this._offscreen.width = width;
      this._offscreen.height = height;
    }
  }

  /**
   * Rebuild all GPU resources after a WebGL2 context restore.
   * Re-creates FBO/texture pairs for every tracked terminal and
   * re-uploads the font atlas.
   * @private
   */
  _rebuildAfterRestore() {
    const gl = this._gl;

    // Re-upload atlas
    this._atlasTexture = this._fontAtlas.uploadToGL(gl);

    // Re-create all terminal FBOs
    for (const [id, record] of this._terminals) {
      const { width, height } = record;

      // Create new texture
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA8,
        width, height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);

      // Create new FBO
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D, texture, 0,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      record.fbo = fbo;
      record.texture = texture;
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Release all GPU resources and the WebGL2 context.
   * After calling dispose(), this instance must not be reused.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    const gl = this._gl;

    // Release all terminal FBOs
    for (const [id] of [...this._terminals.keys()]) {
      this.releaseTerminal(id);
    }

    // Release atlas
    if (this._atlasTexture) {
      gl.deleteTexture(this._atlasTexture);
      this._atlasTexture = null;
    }
    this._fontAtlas.destroy();

    // Remove event listeners
    this._offscreen.removeEventListener("webglcontextlost", this._onContextLost);
    this._offscreen.removeEventListener("webglcontextrestored", this._onContextRestored);

    // Lose the context explicitly (frees GPU resources)
    const loseCtx = gl.getExtension("WEBGL_lose_context");
    if (loseCtx) {
      loseCtx.loseContext();
    }

    this._gl = null;
    this._offscreen = null;
  }
}
