import { readFile, writeFile, rename, mkdir, readdir, unlink, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { COLLAB_DIR } from "./paths";

const STATE_DIR = COLLAB_DIR;
const STATE_FILE = join(STATE_DIR, "canvas-state.json");
const BACKUP_DIR = join(STATE_DIR, "canvas-state-backups");

const BACKUP_EVERY_N_SAVES = 30;
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BACKUPS = 3;

interface TileState {
  id: string;
  type: "term" | "note" | "code" | "image" | "graph" | "browser";
  x: number;
  y: number;
  width: number;
  height: number;
  filePath?: string;
  folderPath?: string;
  url?: string | null;
  workspacePath?: string;
  ptySessionId?: string;
  zIndex: number;
}

export interface CanvasState {
  version: 1;
  tiles: TileState[];
  viewport: {
    centerX: number;
    centerY: number;
    zoom: number;
  };
}

let saveCountSinceBackup = 0;
let lastBackupTime = 0;
let dirty = false;
let periodicBackupTimer: ReturnType<typeof setInterval> | null = null;

function sanitizeCoord(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function isValidCanvasState(state: unknown): state is CanvasState {
  if (state == null || typeof state !== "object") return false;
  const s = state as Record<string, unknown>;
  if (s.version !== 1) return false;
  if (!Array.isArray(s.tiles)) return false;
  if (s.viewport == null || typeof s.viewport !== "object") return false;
  return true;
}

function parseAndValidate(raw: string): CanvasState | null {
  try {
    const state = JSON.parse(raw) as unknown;
    if (!isValidCanvasState(state)) return null;
    for (const tile of state.tiles) {
      tile.x = sanitizeCoord(tile.x);
      tile.y = sanitizeCoord(tile.y);
    }
    state.viewport.panX = sanitizeCoord(state.viewport.panX);
    state.viewport.panY = sanitizeCoord(state.viewport.panY);
    const z = state.viewport.zoom;
    state.viewport.zoom = (typeof z === "number" && Number.isFinite(z) && z > 0) ? z : 1;
    return state;
  } catch {
    return null;
  }
}

async function tryLoadFile(filePath: string): Promise<CanvasState | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return parseAndValidate(raw);
  } catch {
    return null;
  }
}

async function listBackupsSorted(): Promise<string[]> {
  try {
    if (!existsSync(BACKUP_DIR)) return [];
    const files = await readdir(BACKUP_DIR);
    const backups = files
      .filter((f: string) => f.startsWith("canvas-state.") && f.endsWith(".json"))
      .sort()
      .reverse();
    return backups.map((f: string) => join(BACKUP_DIR, f));
  } catch {
    return [];
  }
}

export async function loadState(): Promise<CanvasState | null> {
  const primary = await tryLoadFile(STATE_FILE);
  if (primary) return primary;

  console.warn("[canvas-persistence] Primary state file invalid or missing, trying backups...");

  const backups = await listBackupsSorted();
  for (const backupPath of backups) {
    const state = await tryLoadFile(backupPath);
    if (state) {
      console.warn(`[canvas-persistence] Restored from backup: ${basename(backupPath)}`);
      try {
        await ensureDir(STATE_DIR);
        const json = JSON.stringify(state, null, 2);
        const tmp = join(STATE_DIR, `canvas-state-tmp-${randomUUID()}.json`);
        await writeFile(tmp, json, "utf-8");
        await rename(tmp, STATE_FILE);
      } catch (err) {
        console.error("[canvas-persistence] Failed to restore backup as primary:", err);
      }
      return state;
    }
  }

  console.error("[canvas-persistence] All backups failed or none exist");
  return null;
}

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

function shouldCreateBackup(): boolean {
  const now = Date.now();
  if (saveCountSinceBackup >= BACKUP_EVERY_N_SAVES) return true;
  if (now - lastBackupTime >= BACKUP_INTERVAL_MS) return true;
  return false;
}

async function createBackup(): Promise<void> {
  try {
    const fileStat = await stat(STATE_FILE).catch(() => null);
    if (!fileStat || fileStat.size === 0) return;

    await ensureDir(BACKUP_DIR);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupName = `canvas-state.${timestamp}.json`;
    const backupPath = join(BACKUP_DIR, backupName);

    await copyFile(STATE_FILE, backupPath);

    saveCountSinceBackup = 0;
    lastBackupTime = Date.now();

    await pruneBackups();
  } catch (err) {
    console.error("[canvas-persistence] Failed to create backup:", err);
  }
}

async function pruneBackups(): Promise<void> {
  const backups = await listBackupsSorted();
  if (backups.length <= MAX_BACKUPS) return;

  const toDelete = backups.slice(MAX_BACKUPS);
  for (const path of toDelete) {
    try {
      await unlink(path);
    } catch {
      // Already deleted or inaccessible
    }
  }
}

export async function saveState(state: CanvasState): Promise<void> {
  if (!isValidCanvasState(state)) {
    console.error("[canvas-persistence] Refusing to save invalid state");
    return;
  }

  await ensureDir(STATE_DIR);

  const tmp = join(STATE_DIR, `canvas-state-tmp-${randomUUID()}.json`);
  const json = JSON.stringify(state, null, 2);
  await writeFile(tmp, json, "utf-8");
  await rename(tmp, STATE_FILE);

  dirty = true;
  saveCountSinceBackup++;

  if (shouldCreateBackup()) {
    await createBackup();
  }
}

export async function cleanupTempFiles(): Promise<void> {
  try {
    if (!existsSync(STATE_DIR)) return;
    const files = await readdir(STATE_DIR);
    const temps = files.filter((f: string) => f.startsWith("canvas-state-tmp-") && f.endsWith(".json"));
    for (const f of temps) {
      try {
        await unlink(join(STATE_DIR, f));
      } catch {
        // Best-effort cleanup
      }
    }
    if (temps.length > 0) {
      console.log(`[canvas-persistence] Cleaned up ${temps.length} temp file(s)`);
    }
  } catch {
    // Non-fatal
  }
}

export function startPeriodicBackup(): void {
  if (periodicBackupTimer) return;

  periodicBackupTimer = setInterval(async () => {
    if (!dirty) return;
    dirty = false;
    await createBackup();
  }, 10_000);
}

export function stopPeriodicBackup(): void {
  if (periodicBackupTimer) {
    clearInterval(periodicBackupTimer);
    periodicBackupTimer = null;
  }
}
