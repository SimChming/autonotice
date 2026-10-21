import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 反向 WS 上的 OneBot API 调用器：NapCat 连进来后，服务端用 echo 关联响应。
 * 同一时刻只允许一个小号在线（与 ACCOUNT 单实例一致）。
 */
export class OneBotClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();

  get connected(): boolean {
    return this.socket?.readyState === 1;
  }

  attach(socket: WebSocket): void {
    this.socket = socket;
  }

  detach(socket?: WebSocket): void {
    if (socket && this.socket !== socket) {
      return;
    }
    this.socket = null;
    for (const [echo, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("OneBot 连接已断开"));
      this.pending.delete(echo);
    }
  }

  /** 处理带 echo 的 API 响应；返回 true 表示该消息已被消费。 */
  handleResponse(payload: unknown): boolean {
    if (!payload || typeof payload !== "object") {
      return false;
    }
    const data = payload as Record<string, unknown>;
    const echo = data.echo;
    if (typeof echo !== "string" || !this.pending.has(echo)) {
      return false;
    }
    const waiter = this.pending.get(echo)!;
    clearTimeout(waiter.timer);
    this.pending.delete(echo);

    if (data.status === "failed" || data.retcode === 100) {
      waiter.reject(new Error(String(data.wording ?? data.message ?? "OneBot 调用失败")));
    } else {
      waiter.resolve(data.data);
    }
    return true;
  }

  request<T>(action: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new Error("OneBot 尚未连接"));
    }

    const echo = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot 调用超时: ${action}`));
      }, timeoutMs);

      this.pending.set(echo, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket!.send(JSON.stringify({ action, params, echo }));
    });
  }

  async sendGroupMsg(groupId: string, text: string): Promise<void> {
    await this.request("send_group_msg", {
      group_id: Number(groupId),
      message: [{ type: "text", data: { text } }],
    });
  }
}
