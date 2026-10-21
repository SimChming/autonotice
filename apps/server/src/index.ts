import { buildServer } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildServer(config);

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, "收到退出信号，开始优雅关闭");
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error, "关闭失败");
    process.exit(1);
  }
};

process.on("SIGTERM", (signal) => void shutdown(signal));
process.on("SIGINT", (signal) => void shutdown(signal));

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error, "服务启动失败");
  process.exit(1);
}
