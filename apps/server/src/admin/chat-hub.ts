import type { FastifyInstance } from "fastify";
import type { SocketStream } from "@fastify/websocket";
import type { WebSocket } from "ws";

export interface AdminChatMessage {
  role: "user" | "assistant";
  text: string;
  qq: string;
  at: string;
}

/** 管理后台聊天通道：QQ 私聊消息与 AI 回复实时镜像，QQ 不可用时仍可对话。 */
export class AdminChatHub {
  private readonly sockets = new Set<WebSocket>();

  push(message: AdminChatMessage): void {
    const text = JSON.stringify({ type: "chat", ...message });
    for (const socket of this.sockets) {
      if (socket.readyState === 1) {
        socket.send(text);
      }
    }
  }

  registerRoute(app: FastifyInstance): void {
    app.get("/api/v1/admin/chat/ws", { websocket: true }, (connection: SocketStream, request) => {
      const socket = connection.socket;
      const token = (request.query as Record<string, string | undefined>).token;
      if (!token) {
        socket.close(1008, "missing token");
        return;
      }
      try {
        const claims = app.jwt.verify(token) as { scope?: string };
        if (claims.scope !== "admin") {
          socket.close(1008, "forbidden");
          return;
        }
      } catch {
        socket.close(1008, "unauthorized");
        return;
      }

      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.send(JSON.stringify({ type: "ready" }));
    });
  }
}
