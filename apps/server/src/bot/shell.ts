import { exec } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(exec);

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 8_000;

export interface ShellResult {
  ok: boolean;
  output: string;
}

/**
 * 主人专属 shell（运行在服务端容器内，非宿主机）。
 * 60 秒超时、输出截断；不支持交互式命令。
 */
export async function runShell(command: string): Promise<ShellResult> {
  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: false, output: "空命令" };
  }
  if (/\b(rm\s+-rf\s+\/|mkfs|shutdown|reboot|passwd)\b/.test(trimmed)) {
    return { ok: false, output: "拒绝执行破坏性命令" };
  }

  try {
    const { stdout, stderr } = await run(trimmed, {
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      shell: "/bin/bash",
      cwd: "/repo/apps/server",
    });
    const combined = `${stdout}${stderr}`.trim() || "（无输出）";
    return { ok: true, output: combined.slice(0, MAX_OUTPUT) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, output: detail.slice(0, MAX_OUTPUT) };
  }
}
