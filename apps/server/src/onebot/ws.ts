import { timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { SocketStream } from "@fastify/websocket";
import type { Config } from "../config.js";
import type { OneBotClient } from "./client.js";
import { normalizeMessageEvent } from "./normalize.js";
import type { IngestDeps } from "../pipeline/ingest.js";
import { ingestMessage } from "../pipeline/ingest.js";

interface OneBotWsOptions {
  config: Config;
  client: OneBotClient;
  ingest: IngestDeps;
  botQq: string;
  logger: FastifyBaseLogger;
}

function safeEqual(value: string | undefined, expected: string): boolean {
  if (!value) {
    return false;
  }
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function extractToken(query: unknown, authorization: string | undefined): string | undefined {
  const params = query as Record<string, string | undefined>;
  if (params.access_token) {
    return params.access_token;
  }
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice(7);
  }
  return undefined;
}

export function registerOneBotWs(app: FastifyInstance, options: OneBotWsOptions): void {
  const { config, client, ingest, botQq, logger } = options;

  app.get(config.onebot.wsPath, { websocket: true }, (connection: SocketStream, request) => {
    const socket = connection.socket;
    const token = extractToken(request.query, request.headers.authorization);
    if (config.onebot.accessToken && !safeEqual(token, config.onebot.accessToken)) {
      logger.warn("OneBot 反向 WS 鉴权失败，已拒绝连接");
      socket.close(1008, "unauthorized");
      return;
    }

    client.attach(socket);
    logger.info("OneBot 反向 WS 已连接");

    socket.on("message", (raw) => {
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        logger.warn("OneBot 消息不是合法 JSON，已忽略");
        return;
      }
      if (client.handleResponse(payload)) {
        return;
      }

      const message = normalizeMessageEvent(payload, botQq);
      if (!message) {
        return;
      }
      void ingestMessage(ingest, message).catch((error: unknown) => {
        logger.warn({ err: error }, "群消息入库失败");
      });
    });

    socket.on("close", () => {
      client.detach(socket);
      logger.info("OneBot 反向 WS 已断开");
    });
  });
}
