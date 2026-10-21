import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { SocketStream } from "@fastify/websocket";
import type { WebSocket } from "ws";

interface WsClaims {
  sub: number;
  scope: string;
}

/** 客户端实时提醒推送：按 user_id 定向，断线自动移除。 */
export class NotifyHub {
  private readonly sockets = new Map<number, Set<WebSocket>>();

  constructor(private readonly logger: FastifyBaseLogger) {}

  attach(userId: number, socket: WebSocket): void {
    let set = this.sockets.get(userId);
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    set.add(socket);
    socket.on("close", () => this.detach(userId, socket));
  }

  detach(userId: number, socket: WebSocket): void {
    const set = this.sockets.get(userId);
    if (!set) {
      return;
    }
    set.delete(socket);
    if (!set.size) {
      this.sockets.delete(userId);
    }
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
