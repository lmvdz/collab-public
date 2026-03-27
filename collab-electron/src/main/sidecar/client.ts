// src/main/sidecar/client.ts
import * as net from "node:net";
import {
  makeRequest,
  type JsonRpcResponse,
  type SessionCreateParams,
  type SessionCreateResult,
  type SessionReconnectResult,
  type SessionInfo,
  type PingResult,
} from "./protocol";

type NotificationHandler = (
  method: string,
  params: Record<string, unknown>,
) => void;

export class SidecarClient {
  private socket: net.Socket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (resp: JsonRpcResponse) => void;
      reject: (err: Error) => void;
    }
  >();
  private buf = "";
  private notificationHandler: NotificationHandler | null = null;

  constructor(private readonly controlSocketPath: string) {}

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(
        this.controlSocketPath,
        () => {
          // Replace the connect-time error handler with one that
          // rejects all pending RPCs on unexpected socket errors.
          this.socket!.removeListener("error", reject);
          this.socket!.on("error", () => this.rejectAllPending());
          this.socket!.on("close", () => this.rejectAllPending());
          resolve();
        },
      );
      this.socket.on("error", reject);
      this.socket.on("data", (chunk) => this.handleData(chunk));
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.rejectAllPending();
  }

  private rejectAllPending(): void {
    const err = new Error("Sidecar connection lost");
    for (const [id, { reject }] of this.pending) {
      reject(err);
    }
    this.pending.clear();
  }

  private handleData(chunk: Buffer): void {
    this.buf += chunk.toString();
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.id === undefined) {
        this.notificationHandler?.(
          msg.method as string,
          (msg.params ?? {}) as Record<string, unknown>,
        );
        continue;
      }

      const pending = this.pending.get(msg.id as number);
      if (pending) {
        this.pending.delete(msg.id as number);
        pending.resolve(msg as unknown as JsonRpcResponse);
      }
    }
  }

  private async rpc(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.socket) throw new Error("Not connected");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 10_000);

      this.pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timer);
          if (resp.error) {
            reject(new Error(resp.error.message));
          } else {
            resolve(resp.result);
          }
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.socket!.write(makeRequest(id, method, params));
    });
  }

  async ping(): Promise<PingResult> {
    return this.rpc("sidecar.ping") as Promise<PingResult>;
  }

  async createSession(
    params: SessionCreateParams,
  ): Promise<SessionCreateResult> {
    return this.rpc(
      "session.create",
      params as unknown as Record<string, unknown>,
    ) as Promise<SessionCreateResult>;
  }

  async reconnectSession(
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<SessionReconnectResult> {
    return this.rpc("session.reconnect", {
      sessionId,
      cols,
      rows,
    }) as Promise<SessionReconnectResult>;
  }

  async resizeSession(
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    await this.rpc("session.resize", { sessionId, cols, rows });
  }

  async killSession(sessionId: string): Promise<void> {
    await this.rpc("session.kill", { sessionId });
  }

  async listSessions(): Promise<SessionInfo[]> {
    const result = (await this.rpc("session.list")) as {
      sessions: SessionInfo[];
    };
    return result.sessions;
  }

  async getForeground(sessionId: string): Promise<string> {
    const result = (await this.rpc("session.foreground", {
      sessionId,
    })) as { command: string };
    return result.command;
  }

  async sendSignal(
    sessionId: string,
    signal: string,
  ): Promise<void> {
    await this.rpc("session.signal", { sessionId, signal });
  }

  async shutdownSidecar(): Promise<void> {
    await this.rpc("sidecar.shutdown");
  }

  async attachDataSocket(
    socketPath: string,
    onData: (data: string) => void,
  ): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath, () => {
        resolve(sock);
      });
      sock.on("data", (chunk) => onData(chunk.toString()));
      sock.on("error", reject);
    });
  }
}
