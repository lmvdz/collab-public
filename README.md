# Collaborator

A new workspace for a new way of creating: with agents.

![Collaborator](screenshot.png)

Agents are incredible, and multiagent workflows are becoming a reality. But today, working with multiple agents means juggling terminal panes, switching between apps, and losing track of what's running where. It's a mess.

Collaborator is an end-to-end environment for agentic development. Terminals, context files, and running code — all arranged on an infinite canvas in one place. No context switching, no tab hunting. Just your agents and your work, side by side.

The app is early-stage and in active development. macOS only for now.

**[Download the latest release](https://github.com/collaborator-ai/collab-public/releases/latest)**

***

## Specification

### Application overview

Collaborator is a single-window application for macOS (arm64). It operates entirely on local files with no cloud services or accounts.

The window is divided into two regions:

* **Navigator** — a resizable sidebar on the left containing a file tree and workspace switcher

* **Main area** — the canvas, an infinite pan-and-zoom surface where tiles are arranged; also hosts the viewer, which displays the content of the file selected in the navigator

All application state is stored as JSON files in `~/.collaborator/`.

### Multiworkspace navigation

The navigator sidebar displays a file tree rooted at the active workspace folder. Users can maintain multiple workspaces and switch between them.

#### Workspace management

A dropdown at the top of the navigator shows the active workspace name. It provides:

* A list of all workspaces for quick switching

* "Add workspace" to open a new local folder (also available via Cmd+Shift+O)

* "Remove workspace" to remove a workspace from the list (does not delete files)

Each workspace gets its own independent file tree. The canvas and viewer are shared across workspaces.

#### File tree

The file tree shows all files and folders in the active workspace. It supports:

* **Expand/collapse** folders by clicking

* **Two view modes**: hierarchical tree view, and a chronological feed view sorted by date

* **Sorting**: cycles through created (newest/oldest), modified (newest/oldest), and name (A-Z/Z-A)

* **File operations**: create new note (generates `Untitled.md`), create new folder, rename (F2), delete (moves to trash)

* **Move files** by dragging between folders

* **Multi-select** with Shift+click and Cmd+click

* **Search** via Cmd+K

Selecting a file in the tree opens it in the viewer. Dragging a file from the tree onto the canvas creates a tile.

### Canvas

The canvas is an infinite pan-and-zoom surface that fills the main area. It uses a dot grid background for spatial orientation.

#### Viewport controls

| Action     | Input                                             |
| ---------- | ------------------------------------------------- |
| Pan        | Scroll wheel, or Space+drag, or middle-click+drag |
| Zoom in    | Cmd+= or Ctrl+scroll up                           |
| Zoom out   | Cmd+- or Ctrl+scroll down                         |
| Reset zoom | Cmd+0                                             |

* **Zoom range**: 33% to 100%, with rubber-band effect when overshooting limits

* **Zoom indicator**: appears briefly in the bottom-right corner after zoom changes, showing the current percentage

#### Grid

* Minor grid dots at regular intervals

* Major grid lines at every 4th interval

* All tile positions and sizes snap to the grid

#### Data model

Tiles are live views, not standalone containers.

* **File tiles** (note, code, image) are bound to a file on disk by absolute path. If the file is renamed, the tile updates to track the new path. If the file is deleted, the tile is closed. If the file's content changes on disk, the tile reloads.

* **Terminal tiles** are bound to a tmux session. Each terminal tile creates and manages its own session, which persists independently of the tile's lifecycle on the canvas.

#### Tile management

Tiles are the content units on the canvas. Each tile has:

* A **title bar** for dragging

* **Eight resize handles** (four edges, four corners)

* A **z-index** for layering — clicking a tile brings it to front

Tiles are created by:

* **Double-clicking** empty canvas space — creates a terminal tile at that position

* **Dragging a file** from the navigator onto the canvas — creates a note, code, or image tile depending on file type

Tiles can be closed via their title bar. Holding Shift while scrolling passes scroll events through tiles to the canvas.

### Tile types

#### Terminal

An interactive terminal session. Created by double-clicking empty canvas space. The terminal's working directory is set to the active workspace path.

Terminals are the primary interface for running AI agents. Each terminal tile manages its own independent session.

#### Note

A rich markdown editor. Created by dragging a markdown file (`.md`, `.mdx`, `.markdown`, `.txt`) from the navigator onto the canvas. Supports inline editing with live rendering.

#### Code

A syntax-highlighted code editor. Created by dragging any non-markdown, non-image file from the navigator onto the canvas. Supports inline editing with language detection.

#### Image

A read-only image display. Created by dragging an image file (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`) from the navigator onto the canvas.

### Viewer

The viewer displays the content of the currently selected file in the navigator. It occupies the main area alongside the canvas.

| File type                                                | Display                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Markdown (`.md`, `.mdx`, `.markdown`, `.txt`)            | Rich text editor with frontmatter support, cover images, and wiki-style links |
| Code (all other text files)                              | Syntax-highlighted editor with line numbers                                   |
| Image (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`) | Image display with metadata                                                   |
| Folder                                                   | Table listing of directory contents                                           |

Markdown and code files support inline editing in the viewer. The viewer watches for external file changes on disk and reloads automatically.

Pressing Escape closes the viewer (when not actively editing).

### Persistence

All state is stored locally in `~/.collaborator/`.

#### Canvas state (`canvas-state.json`)

```json
{
  "version": 1,
  "tiles": [
    {
      "id": "tile-<timestamp>-<index>",
      "type": "term | note | code | image",
      "x": 0,
      "y": 0,
      "width": 440,
      "height": 540,
      "filePath": "/absolute/path/to/file",
      "zIndex": 1
    }
  ],
  "viewport": {
    "panX": 0,
    "panY": 0,
    "zoom": 1.0
  }
}
```

Canvas state is saved 500ms after each change (debounced) and immediately when tiles are created or closed.

#### Workspace config (`collaborator.json`)

```json
{
  "workspaces": ["/path/to/workspace1", "/path/to/workspace2"],
  "active_workspace": 0,
  "window_state": {
    "x": 0,
    "y": 0,
    "width": 1440,
    "height": 900,
    "isMaximized": false
  }
}
```

### Keyboard shortcuts

| Shortcut           | Action               |
| ------------------ | -------------------- |
| Cmd+\              | Toggle navigator     |
| Cmd+,              | Settings             |
| Cmd+Shift+O        | Add workspace        |
| Cmd+K              | Search               |
| Cmd+=              | Zoom in              |
| Cmd+-              | Zoom out             |
| Cmd+0              | Reset zoom           |
| F2                 | Rename selected file |
| Delete / Backspace | Delete selected file |
| Escape             | Close viewer         |

### Appearance

The application supports light and dark modes.

| Property   | Light              | Dark                     |
| ---------- | ------------------ | ------------------------ |
| Background | rgb(248, 248, 248) | rgb(18, 18, 18)          |
| Canvas     | rgb(230, 230, 230) | rgb(24, 24, 24)          |
| Text       | rgb(32, 32, 32)    | rgb(220, 220, 220)       |
| Border     | rgb(206, 206, 206) | rgba(255, 255, 255, 0.2) |

Tiles have rounded corners and a subtle drop shadow.
