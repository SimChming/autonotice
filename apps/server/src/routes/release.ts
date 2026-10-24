import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { releaseResponseSchema, SERVICE_VERSION } from "@autonotice/shared";
import type { Config } from "../config.js";

/**
 * 客户端更新信息：安装包放在服务端 downloads 目录，
 * 原生壳直接从服务端下载，不依赖 GitHub 可达性。
 */
export function registerReleaseRoutes(app: FastifyInstance, config: Config): void {
  app.get("/api/v1/release", async () => {
    const pick = (name: string) =>
      existsSync(resolve(config.downloadDir, name)) ? `/downloads/${name}` : null;
    return releaseResponseSchema.parse({
      version: SERVICE_VERSION,
      notes: null,
      downloads: {
        android: pick(`Autonotice-${SERVICE_VERSION}-android.apk`),
        windowsExe: pick(`Autonotice-${SERVICE_VERSION}-x64-setup.exe`),
        windowsMsi: pick(`Autonotice-${SERVICE_VERSION}-x64.msi`),
      },
    });
  });
}
