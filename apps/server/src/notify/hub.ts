import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { SocketStream } from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { AdminPresence } from "@autonotice/shared";

interface WsClaims {
  sub: number;
  scope: string;
}

interface ClientMeta extends AdminPresence {
  userId: number;
}

const PLATFORMS = new Set(["web", "desktop", "android"]);

/** 客户端实时提醒推送：按 user_id 定向，断线自动移除，并记录在线端信息。 */
export class NotifyHub {
  private readonly sockets = new Map<number, Set<WebSocket>>();
  private readonly meta = new Map<WebSocket, ClientMeta>();

  constructor(private readonly logger: FastifyBaseLogger) {}

  attach(userId: number, socket: WebSocket): void {
    let set = this.sockets.get(userId);
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    set.add(socket);

    const now = Date.now();
    this.meta.set(socket, {
      userId,
      platform: "web",
      version: "",
      shellVersion: null,
      connectedAt: now,
      lastSeen: now,
    });

    // 客户端连上后会发 hello，补充平台与版本，供后台展示多端在线状态。
    socket.on("message", (raw: unknown) => {
      const current = this.meta.get(socket);
      if (!current) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof payload !== "object" || payload === null) {
        return;
      }
      const record = payload as Record<string, unknown>;
      if (record.type !== "hello") {
        return;
      }
      const platform = typeof record.platform === "string" && PLATFORMS.has(record.platform)
        ? (record.platform as AdminPresence["platform"])
        : current.platform;
      current.platform = platform;
      current.version = typeof record.version === "string" ? record.version.slice(0, 24) : current.version;
      current.shellVersion =
        typeof record.shellVersion === "string" ? record.shellVersion.slice(0, 24) : null;
      current.lastSeen = Date.now();
    });

    socket.on("close", () => this.detach(userId, socket));
  }

  detach(userId: number, socket: WebSocket): void {
    this.meta.delete(socket);
    const set = this.sockets.get(userId);
    if (!set) {
      return;
    }
    set.delete(socket);
    if (!set.size) {
      this.sockets.delete(userId);
    }
  }

  /** 某个账号当前在线的所有端（同一账号多端并列）。 */
  presenceFor(userId: number): AdminPresence[] {
    const set = this.sockets.get(userId);
    if (!set?.size) {
      return [];
    }
    const result: AdminPresence[] = [];
    for (const socket of set) {
      if (socket.readyState !== 1) {
        continue;
      }
      const info = this.meta.get(socket);
      if (!info) {
        continue;
      }
      result.push({
        platform: info.platform,
        version: info.version,
        shellVersion: info.shellVersion,
        connectedAt: info.connectedAt,
        lastSeen: info.lastSeen,
      });
    }
    return result.sort((a, b) => a.connectedAt - b.connectedAt);
  }

  push(userId: number, payload: unknown): boolean {
    const set = this.sockets.get(userId);
    if (!set?.size) {
      return false;
    }
    const text = JSON.stringify(payload);
    let delivered = false;
    for (const socket of set) {
      if (socket.readyState === 1) {
        socket.send(text);
        delivered = true;
      }
    }
    return delivered;
  }

  registerRoute(app: FastifyInstance): void {
    app.get("/api/v1/ws", { websocket: true }, (connection: SocketStream, request) => {
      const socket = connection.socket;
      const token = (request.query as Record<string, string | undefined>).token;
      if (!token) {
        socket.close(1008, "missing token");
        return;
      }

      let claims: WsClaims;
      try {
        claims = app.jwt.verify(token) as WsClaims;
      } catch {
        socket.close(1008, "unauthorized");
        return;
      }
      if (claims.scope !== "user" || typeof claims.sub !== "number") {
        socket.close(1008, "forbidden");
        return;
      }

      this.attach(claims.sub, socket);
      this.logger.info({ userId: claims.sub }, "客户端 WS 已连接");
      socket.send(JSON.stringify({ type: "ready" }));
    });
  }
}
