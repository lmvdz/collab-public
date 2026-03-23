import {
  app,
  ipcMain,
  dialog,
  type BrowserWindow,
} from "electron";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import fm from "front-matter";
import { saveConfig, type AppConfig } from "./config";
import {
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  type WorkspaceConfig,
} from "./workspace-config";
import { createFileFilter, type FileFilter } from "./file-filter";
import { setThumbnailCacheDir } from "./image-service";
import { shouldIncludeEntryWithContent, fsWriteFile } from "./files";
import * as watcher from "./watcher";
import * as wikilinkIndex from "./wikilink-index";
import * as agentActivity from "./agent-activity";
import { trackEvent } from "./analytics";
import type { TreeNode } from "@collab/shared/types";

export interface IpcWorkspaceContext {
  mainWindow: () => BrowserWindow | null;
  getActiveWorkspacePath: () => string;
  forwardToWebview: (
    target: string,
    channel: string,
    ...args: unknown[]
  ) => void;
}

const wsConfigMap = new Map<string, WorkspaceConfig>();

function getWsConfig(workspacePath: string): WorkspaceConfig {
  let config = wsConfigMap.get(workspacePath);
  if (!config) {
    config = loadWorkspaceConfig(workspacePath);
    wsConfigMap.set(workspacePath, config);
  }
  return config;
}

export function getWorkspaceConfig(
  path: string,
): WorkspaceConfig {
  return getWsConfig(path);
}

const CLAUDE_MD_TEMPLATE = `# Collaborator Workspace

This is a Collaborator workspace. Files in the root are sources (notes, articles, transcripts).
Files in \`.collaborator/\` are managed by the Collaborator agent.

## File types
- Sources (root): note, article, transcript, pdf
- Inferences (.collaborator/inferences/): concept, insight, objective

## Front-matter
All .md files should have YAML front-matter with at least a \`type\` field.
Files without \`collab_reviewed: true\` are inbox items awaiting processing.

## Persona
- \`.collaborator/persona/identity.md\` — who this collaborator is
- \`.collaborator/persona/values.md\` — beliefs, priorities, decision style
`;

const AGENT_NOTIFY_SCRIPT = `#!/bin/bash
set -euo pipefail
LOG="$HOME/.collaborator/hook-debug.log"
INPUT=$(cat)
echo "[$(date -Iseconds)] hook fired" >> "$LOG"
echo "  raw input: $INPUT" >> "$LOG"
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name')

# Discover the socket path from the breadcrumb file written by the
# JSON-RPC server. This works for both dev (~/.collaborator/dev/)
# and prod (~/.collaborator/) instances.
SOCKET_PATH_FILE="$HOME/.collaborator/socket-path"
if [ -f "$SOCKET_PATH_FILE" ]; then
  SOCKET=$(cat "$SOCKET_PATH_FILE")
else
  SOCKET="$HOME/.collaborator/ipc.sock"
fi

if [ ! -S "$SOCKET" ]; then
  echo "  socket not found at $SOCKET" >> "$LOG"
  exit 0
fi

case "$EVENT" in
  SessionStart)
    METHOD="agent.sessionStart"
    PAYLOAD=$(echo "$INPUT" | jq -c --arg pty "$COLLAB_PTY_SESSION_ID" '{session_id: .session_id, cwd: .cwd, pty_session_id: $pty}')
    ;;
  PostToolUse)
    METHOD="agent.fileTouched"
    PAYLOAD=$(echo "$INPUT" | jq -c '{session_id: .session_id, tool_name: .tool_name, file_path: (.tool_input.file_path // .tool_input.path // null)}')
    ;;
  SessionEnd)
    METHOD="agent.sessionEnd"
    PAYLOAD=$(echo "$INPUT" | jq -c '{session_id: .session_id}')
    ;;
  *)
    echo "  unknown event: $EVENT" >> "$LOG"
    exit 0
    ;;
esac

echo "  method=$METHOD payload=$PAYLOAD" >> "$LOG"
RESULT=$(printf '{"jsonrpc":"2.0","id":1,"method":"%s","params":%s}\\n' "$METHOD" "$PAYLOAD" \\
  | nc -U -w1 "$SOCKET" 2>&1) || true
echo "  rpc result: $RESULT" >> "$LOG"

exit 0
`;

function buildHooksConfig(): Record<string, unknown> {
  const agentScript =
    '"$CLAUDE_PROJECT_DIR"/.claude/hooks/agent-notify.sh';
  return {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: agentScript,
            timeout: 5,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "Read|Write|Edit",
        hooks: [
          {
            type: "command",
            command: agentScript,
            timeout: 5,
          },
        ],
      },
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: "command",
            command: agentScript,
            timeout: 5,
          },
        ],
      },
    ],
  };
}

function ensureGitignoreEntry(workspacePath: string): void {
  const gitignorePath = join(workspacePath, ".gitignore");
  if (!existsSync(gitignorePath)) return;

  const content = readFileSync(gitignorePath, "utf-8");
  const lines = content.split("\n");
  const alreadyIgnored = lines.some(
    (l) => l.trim() === ".collaborator" || l.trim() === ".collaborator/",
  );
  if (alreadyIgnored) return;

  const suffix = content.endsWith("\n") ? "" : "\n";
  appendFileSync(
    gitignorePath,
    `${suffix}.collaborator\n`,
    "utf-8",
  );
}

const RPC_BLOCK_START = "<!-- collaborator:rpc-start -->";
const RPC_BLOCK_END = "<!-- collaborator:rpc-end -->";

function buildRpcBlock(): string {
  const socketPathFile = join(homedir(), ".collaborator", "socket-path");
  return [
    RPC_BLOCK_START,
    "",
    "## Collaborator RPC",
    "",
    "The Collaborator desktop app exposes a JSON-RPC 2.0 server over a Unix domain socket.",
    `Read the socket path from \`${socketPathFile}\`, then send newline-delimited JSON.`,
    "",
    "Call `rpc.discover` to list available methods:",
    "```bash",
    `SOCK=$(cat "${socketPathFile}")`,
    `echo '{"jsonrpc":"2.0","id":1,"method":"rpc.discover"}' | nc -U "$SOCK"`,
    "```",
    "",
    RPC_BLOCK_END,
  ].join("\n");
}

function ensureRpcBlock(claudeMdPath: string): void {
  let content = existsSync(claudeMdPath)
    ? readFileSync(claudeMdPath, "utf-8")
    : "";

  const startIdx = content.indexOf(RPC_BLOCK_START);
  const endIdx = content.indexOf(RPC_BLOCK_END);
  const block = buildRpcBlock();

  if (startIdx !== -1 && endIdx !== -1) {
    content =
      content.slice(0, startIdx) +
      block +
      content.slice(endIdx + RPC_BLOCK_END.length);
  } else {
    content = content.trimEnd() + "\n\n" + block + "\n";
  }

  writeFileSync(claudeMdPath, content, "utf-8");
}

function initWorkspaceFiles(workspacePath: string): void {
  const collabDir = join(workspacePath, ".collaborator");
  const claudeDir = join(workspacePath, ".claude");

  mkdirSync(collabDir, { recursive: true });
  mkdirSync(claudeDir, { recursive: true });

  const claudeMd = join(claudeDir, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    writeFileSync(claudeMd, CLAUDE_MD_TEMPLATE, "utf-8");
  }
  ensureRpcBlock(claudeMd);

  ensureGitignoreEntry(workspacePath);
}

function readJsonFileSync(
  filePath: string,
): Record<string, unknown> {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function installPluginSync(workspacePath: string): void {
  const claudeDir = join(workspacePath, ".claude");
  const hooksDir = join(claudeDir, "hooks");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });

  const settingsPath = join(claudeDir, "settings.json");
  const settings = readJsonFileSync(settingsPath);
  const existingHooks =
    settings.hooks && typeof settings.hooks === "object"
      ? (settings.hooks as Record<string, unknown>)
      : {};
  settings.hooks = { ...existingHooks, ...buildHooksConfig() };
  writeFileSync(
    settingsPath,
    JSON.stringify(settings, null, 2),
    "utf-8",
  );

  writeFileSync(
    join(hooksDir, "agent-notify.sh"),
    AGENT_NOTIFY_SCRIPT,
    { mode: 0o755 },
  );
}

/**
 * Start all workspace-dependent services for the given path.
 * Handles watcher, file filter, wikilink index, agent activity,
 * thumbnail cache, and workspace config loading.
 */
export function startWorkspaceServices(
  path: string,
  fileFilterSetter: (f: FileFilter) => void,
): void {
  wsConfigMap.set(path, loadWorkspaceConfig(path));
  setThumbnailCacheDir(path);
  watcher.watchWorkspace(path);
  createFileFilter(path).then(
    (f) => { fileFilterSetter(f); },
    (err) => { console.error("[workspace] Failed to create file filter:", err); },
  );
  void wikilinkIndex.buildIndex(path);
  agentActivity.setWorkspacePath(path);

  try {
    installPluginSync(path);
  } catch (err) {
    console.error("[workspace] Failed to install plugin hooks:", err);
  }
}

/**
 * Stop workspace services and reset state.
 */
export function stopWorkspaceServices(): void {
  watcher.watchWorkspace("");
  agentActivity.setWorkspacePath("");
}

function notifyWorkspaceChanged(
  ctx: IpcWorkspaceContext,
  path: string,
): void {
  ctx.forwardToWebview("nav", "workspace-changed", path);
  ctx.forwardToWebview("viewer", "workspace-changed", path);
  ctx.forwardToWebview("terminal", "workspace-changed", path);
  ctx.mainWindow()?.webContents.send("shell:workspace-changed", path);
}

const LEGACY_FM_FIELDS = new Set([
  "createdAt",
  "modifiedAt",
  "author",
]);

async function readTreeRecursive(
  dirPath: string,
  rootPath: string,
  filter: FileFilter | null,
): Promise<TreeNode[]> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const folders: TreeNode[] = [];
  const files: TreeNode[] = [];

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (
      !(await shouldIncludeEntryWithContent(
        dirPath,
        entry,
        filter ?? undefined,
        rootPath,
      ))
    ) {
      continue;
    }

    let stats;
    try {
      stats = await stat(fullPath);
    } catch {
      continue;
    }

    const ctime = stats.birthtime.toISOString();
    const mtime = stats.mtime.toISOString();

    if (entry.isDirectory()) {
      const children = await readTreeRecursive(
        fullPath,
        rootPath,
        filter,
      );
      folders.push({
        path: fullPath,
        name: entry.name,
        kind: "folder",
        ctime,
        mtime,
        children,
      });
    } else {
      const stem = basename(entry.name, extname(entry.name));
      const node: TreeNode = {
        path: fullPath,
        name: stem,
        kind: "file",
        ctime,
        mtime,
      };

      if (entry.name.endsWith(".md")) {
        try {
          const fileContent = await readFile(
            fullPath,
            "utf-8",
          );
          const parsed = fm<Record<string, unknown>>(
            fileContent,
          );
          node.frontmatter = parsed.attributes;
          node.preview = parsed.body.slice(0, 200);
        } catch {
          // Skip frontmatter parsing on failure
        }
      }

      files.push(node);
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...folders, ...files];
}

export function registerWorkspaceHandlers(
  ctx: IpcWorkspaceContext,
  appConfig: AppConfig,
  fileFilterRef: { current: FileFilter | null },
): void {
  function activeWsConfig(): WorkspaceConfig {
    const path = ctx.getActiveWorkspacePath();
    if (!path) {
      return {
        selected_file: null,
        expanded_dirs: [],
        agent_skip_permissions: false,
      };
    }
    return getWsConfig(path);
  }

  ipcMain.handle("config:get", () => appConfig);
  ipcMain.handle("app:version", () => app.getVersion());

  ipcMain.handle(
    "workspace-pref:get",
    (_event, key: string) => {
      const config = activeWsConfig();
      if (key === "selected_file") return config.selected_file;
      if (key === "expanded_dirs") return config.expanded_dirs;
      if (key === "agent_skip_permissions")
        return config.agent_skip_permissions;
      return null;
    },
  );

  ipcMain.handle(
    "workspace-pref:set",
    (_event, key: string, value: unknown) => {
      const active = ctx.getActiveWorkspacePath();
      if (!active) return;
      const config = getWsConfig(active);
      if (key === "selected_file") {
        config.selected_file =
          (value as string | null) ?? null;
      } else if (key === "expanded_dirs") {
        config.expanded_dirs = Array.isArray(value)
          ? value
          : [];
      } else if (key === "agent_skip_permissions") {
        config.agent_skip_permissions = value === true;
      }
      saveWorkspaceConfig(active, config);
    },
  );

  ipcMain.handle(
    "shell:get-workspace-path",
    () => ctx.getActiveWorkspacePath() || null,
  );

  ipcMain.handle("workspace:list", () => ({
    workspaces: appConfig.workspaces,
    active: appConfig.active_workspace,
  }));

  ipcMain.handle("workspace:add", async () => {
    const win = ctx.mainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const chosen = realpathSync(result.filePaths[0]!);

    const existingIndex = appConfig.workspaces.indexOf(chosen);
    if (existingIndex !== -1) {
      if (existingIndex !== appConfig.active_workspace) {
        appConfig.active_workspace = existingIndex;
        saveConfig(appConfig);
        startWorkspaceServices(chosen, (f) => {
          fileFilterRef.current = f;
        });
        notifyWorkspaceChanged(ctx, chosen);
      }
      return {
        workspaces: appConfig.workspaces,
        active: existingIndex,
      };
    }

    const collabDir = join(chosen, ".collaborator");
    const isNew = !existsSync(collabDir);
    if (isNew) {
      initWorkspaceFiles(chosen);
    }

    appConfig.workspaces.push(chosen);
    appConfig.active_workspace = appConfig.workspaces.length - 1;
    saveConfig(appConfig);
    trackEvent("workspace_added", { is_new: isNew });

    startWorkspaceServices(chosen, (f) => {
      fileFilterRef.current = f;
    });
    notifyWorkspaceChanged(ctx, chosen);

    return {
      workspaces: appConfig.workspaces,
      active: appConfig.active_workspace,
    };
  });

  ipcMain.handle(
    "workspace:remove",
    (_event, index: number) => {
      if (index < 0 || index >= appConfig.workspaces.length) {
        return {
          workspaces: appConfig.workspaces,
          active: appConfig.active_workspace,
        };
      }

      const removedPath = appConfig.workspaces[index]!;
      wsConfigMap.delete(removedPath);

      const wasActive = index === appConfig.active_workspace;
      appConfig.workspaces.splice(index, 1);

      if (appConfig.workspaces.length === 0) {
        appConfig.active_workspace = -1;
      } else if (wasActive) {
        appConfig.active_workspace = Math.min(
          index,
          appConfig.workspaces.length - 1,
        );
      } else if (appConfig.active_workspace > index) {
        appConfig.active_workspace -= 1;
      }

      saveConfig(appConfig);
      trackEvent("workspace_removed");

      if (wasActive) {
        const newPath = ctx.getActiveWorkspacePath();
        if (newPath) {
          startWorkspaceServices(newPath, (f) => {
            fileFilterRef.current = f;
          });
          notifyWorkspaceChanged(ctx, newPath);
        } else {
          stopWorkspaceServices();
          fileFilterRef.current = null;
          notifyWorkspaceChanged(ctx, "");
        }
      }

      return {
        workspaces: appConfig.workspaces,
        active: appConfig.active_workspace,
      };
    },
  );

  ipcMain.handle(
    "workspace:switch",
    (_event, index: number) => {
      if (
        index < 0 ||
        index >= appConfig.workspaces.length ||
        index === appConfig.active_workspace
      ) {
        return;
      }

      appConfig.active_workspace = index;
      saveConfig(appConfig);
      trackEvent("workspace_switched");

      const newPath = appConfig.workspaces[index]!;
      startWorkspaceServices(newPath, (f) => {
        fileFilterRef.current = f;
      });
      notifyWorkspaceChanged(ctx, newPath);
    },
  );

  ipcMain.handle(
    "workspace:read-tree",
    async (
      _event,
      params: { root: string },
    ): Promise<TreeNode[]> => {
      return readTreeRecursive(
        params.root,
        params.root,
        fileFilterRef.current,
      );
    },
  );

  ipcMain.handle(
    "workspace:update-frontmatter",
    async (
      _event,
      filePath: string,
      field: string,
      value: unknown,
    ): Promise<{ ok: boolean; retried?: boolean }> => {
      const MAX_ATTEMPTS = 3;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const fileStat = await stat(filePath);
        const expectedMtime = fileStat.mtime.toISOString();

        const content = await readFile(filePath, "utf-8");
        const parsed = fm<Record<string, unknown>>(content);
        const attrs = { ...parsed.attributes, [field]: value };

        for (const key of LEGACY_FM_FIELDS) {
          delete attrs[key];
        }

        const yaml = Object.entries(attrs)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join("\n");
        const output = `---\n${yaml}\n---\n${parsed.body}`;

        const result = await fsWriteFile(filePath, output, expectedMtime);
        if (result.ok) {
          return { ok: true, retried: attempt > 0 };
        }
      }
      return { ok: false };
    },
  );
}
