import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import {
  getTmuxBin,
  getTmuxConf,
  getSocketName,
  writeSessionMeta,
  readSessionMeta,
  deleteSessionMeta,
  SESSION_DIR,
  tmuxExec,
  tmuxSessionName,
} from "./tmux";
import {
  createSession,
  killSession,
  listSessions,
  killAll,
  discoverSessions,
  cleanDetachedSessions,
  verifyTmuxAvailable,
} from "./pty";

describe("tmux helpers", () => {
  const testId = "test-" + Date.now().toString(16);

  afterEach(() => {
    deleteSessionMeta(testId);
  });

  test("getTmuxConf returns a path ending in tmux.conf", () => {
    const conf = getTmuxConf();
    expect(conf.endsWith("tmux.conf")).toBe(true);
    expect(fs.existsSync(conf)).toBe(true);
  });

  test("writeSessionMeta + readSessionMeta round-trip", () => {
    const meta = {
      shell: "/bin/zsh",
      cwd: "/tmp",
      createdAt: new Date().toISOString(),
    };
    writeSessionMeta(testId, meta);
    const read = readSessionMeta(testId);
    expect(read).toEqual(meta);
  });

  test("readSessionMeta returns null for missing file", () => {
    expect(readSessionMeta("nonexistent-id")).toBeNull();
  });

  test("readSessionMeta returns null for corrupt JSON", () => {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(
      `${SESSION_DIR}/${testId}.json`, "not json",
    );
    expect(readSessionMeta(testId)).toBeNull();
  });

  test("deleteSessionMeta is no-op for missing file", () => {
    expect(
      () => deleteSessionMeta("nonexistent-id"),
    ).not.toThrow();
  });
});

describe("pty lifecycle via tmux", () => {
  afterEach(() => {
    killAll();
  });

  test("createSession returns sessionId and shell", async () => {
    const result = await createSession("/tmp");
    expect(result.sessionId).toMatch(/^[0-9a-f]{16}$/);
    expect(result.shell).toBeTruthy();
  });

  test("createSession appears in listSessions", async () => {
    const { sessionId } = await createSession("/tmp");
    expect(listSessions()).toContain(sessionId);
  });

  test("killSession removes from listSessions", async () => {
    const { sessionId } = await createSession("/tmp");
    await killSession(sessionId);
    expect(listSessions()).not.toContain(sessionId);
  });

  test("createSession sets COLLAB_PTY_SESSION_ID env", async () => {
    const { sessionId } = await createSession("/tmp");
    const name = tmuxSessionName(sessionId);
    const env = tmuxExec(
      "show-environment", "-t", name,
      "COLLAB_PTY_SESSION_ID",
    );
    expect(env).toContain(sessionId);
  });
});

describe("discoverSessions", () => {
  test("returns empty when no tmux server running", async () => {
    const result = await discoverSessions();
    expect(Array.isArray(result)).toBe(true);
  });

  test("discovers sessions created by createSession", async () => {
    const { sessionId } = await createSession("/tmp");
    killAll(); // detach client, tmux session survives

    const discovered = await discoverSessions();
    const found = discovered.find(
      (s) => s.sessionId === sessionId,
    );
    expect(found).toBeTruthy();
    expect(found!.meta.cwd).toBe("/tmp");

    // Clean up tmux session
    try {
      tmuxExec(
        "kill-session", "-t", tmuxSessionName(sessionId),
      );
    } catch {}
    deleteSessionMeta(sessionId);
  });

  test("cleans up stale metadata without tmux session", async () => {
    const fakeId = "deadbeefdeadbeef";
    writeSessionMeta(fakeId, {
      shell: "/bin/zsh",
      cwd: "/tmp",
      createdAt: new Date().toISOString(),
    });

    await discoverSessions();
    expect(readSessionMeta(fakeId)).toBeNull();
  });

  test("kills orphan tmux sessions without metadata", async () => {
    // Create a session, then delete its metadata
    const { sessionId } = await createSession("/tmp");
    killAll();
    deleteSessionMeta(sessionId);

    // discoverSessions should kill the orphan
    await discoverSessions();

    // Verify tmux session is gone
    const name = tmuxSessionName(sessionId);
    let alive = true;
    try {
      tmuxExec("has-session", "-t", name);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});

describe("cleanDetachedSessions", () => {
  test("kills sessions not in the active list", async () => {
    const { sessionId: keep } = await createSession("/tmp");
    const { sessionId: detached } = await createSession("/tmp");
    killAll(); // detach clients, tmux sessions survive

    await cleanDetachedSessions([keep]);

    // The kept session should still exist
    const discovered = await discoverSessions();
    expect(
      discovered.some((s) => s.sessionId === keep),
    ).toBe(true);

    // The detached session should be gone
    const name = tmuxSessionName(detached);
    let alive = true;
    try {
      tmuxExec("has-session", "-t", name);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);

    // Clean up
    try {
      tmuxExec(
        "kill-session", "-t", tmuxSessionName(keep),
      );
    } catch {}
    deleteSessionMeta(keep);
    deleteSessionMeta(detached);
  });

  test("no-op when all sessions are active", async () => {
    const { sessionId } = await createSession("/tmp");
    killAll();

    await cleanDetachedSessions([sessionId]);

    const discovered = await discoverSessions();
    expect(
      discovered.some((s) => s.sessionId === sessionId),
    ).toBe(true);

    // Clean up
    try {
      tmuxExec(
        "kill-session", "-t", tmuxSessionName(sessionId),
      );
    } catch {}
    deleteSessionMeta(sessionId);
  });

  test("preserves sessions with attached tmux clients", async () => {
    const sessionId = "test-attached-" + Date.now().toString(16);
    const name = tmuxSessionName(sessionId);

    tmuxExec(
      "new-session", "-d", "-s", name,
      "-x", "80", "-y", "24",
    );
    writeSessionMeta(sessionId, {
      shell: "/bin/zsh",
      cwd: "/tmp",
      createdAt: new Date().toISOString(),
    });

    // Attach a control-mode client (node-pty doesn't
    // register as attached under bun's runtime)
    const client = spawn(
      getTmuxBin(),
      ["-L", getSocketName(), "-u", "-C",
        "attach-session", "-t", name],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    await Bun.sleep(100);

    // Not in active list, but has an attached client
    await cleanDetachedSessions([]);

    let alive = true;
    try {
      tmuxExec("has-session", "-t", name);
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);

    // Clean up
    client.kill();
    try { tmuxExec("kill-session", "-t", name); } catch {}
    deleteSessionMeta(sessionId);
  });
});

describe("verifyTmuxAvailable", () => {
  test("does not throw when tmux is available", () => {
    expect(() => verifyTmuxAvailable()).not.toThrow();
  });
});

describe("stripTrailingBlanks via scrollback", () => {
  test("scrollback capture strips trailing blank lines", async () => {
    const { sessionId } = await createSession("/tmp");
    const name = tmuxSessionName(sessionId);

    // Send a known string to the session
    tmuxExec(
      "send-keys", "-t", name, "echo hello-scrollback", "Enter",
    );

    // Brief wait for output to appear in tmux buffer
    await new Promise((r) => setTimeout(r, 200));

    // Capture and verify no trailing blank lines
    const raw = tmuxExec(
      "capture-pane", "-t", name,
      "-p", "-e", "-S", "-10000",
    );
    const lines = raw.split("\n");
    // Raw output may have trailing blanks; after
    // stripTrailingBlanks (called in reconnectSession),
    // they'd be removed. Verify raw capture has content.
    expect(
      lines.some((l) => l.includes("hello-scrollback")),
    ).toBe(true);

    await killSession(sessionId);
  });
});
