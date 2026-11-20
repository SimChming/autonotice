import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const runFile = promisify(execFile);

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 8_000;

export interface HostCommandResult {
  ok: boolean;
  output: string;
  durationMs: number;
}

/**
 * 5.1.0：她不再被关在容器里。
 *
 * 容器以 privileged + pid:host 运行，这里用 nsenter 进入宿主的 mount/pid/net
 * 命名空间执行命令，因此 `whoami` 是 root、`ls /` 是真实的 debian 根目录。
 * 本地开发（不在容器里）时自动回退到普通 bash，方便调试。
 */
export function isInContainer(): boolean {
  return existsSync("/.dockerenv");
}

function hostExecDisabled(): boolean {
  return process.env.HOST_EXEC_ENABLED === "false";
}

function hostCwd(): string {
  return process.env.HOST_EXEC_CWD || "/home/simchm";
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function nsenterAvailable(): boolean {
  return existsSync("/usr/bin/nsenter");
}

function collect(error: unknown): { stdout: string; stderr: string } {
  const detail = error as { stdout?: string; stderr?: string };
  return { stdout: detail?.stdout ?? "", stderr: detail?.stderr ?? "" };
}

export async function runOnHost(
  command: string,
  options: { timeoutMs?: number } = {},
): Promise<HostCommandResult> {
  const trimmed = command.trim();
  const startedAt = Date.now();
  if (!trimmed) {
    return { ok: false, output: "空命令", durationMs: 0 };
  }
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const execOptions = {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  };

  try {
    const result =
      hostExecDisabled() || !isInContainer() || !nsenterAvailable()
        ? await runFile("/bin/bash", ["-lc", trimmed], {
            ...execOptions,
            cwd: isInContainer() ? "/repo/apps/server" : process.cwd(),
          })
        : await runFile(
            "/usr/bin/nsenter",
            [
              "-t",
              "1",
              "-m",
              "-u",
              "-i",
              "-n",
              "-p",
              "--",
              "/bin/bash",
              "-lc",
              `cd ${quote(hostCwd())} && ${trimmed}`,
            ],
            execOptions,
          );
    const combined = `${result.stdout}${result.stderr}`.trim() || "（无输出）";
    return {
      ok: true,
      output: combined.slice(0, MAX_OUTPUT),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const { stdout, stderr } = collect(error);
    const combined = `${stdout}${stderr}`.trim();
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      output: (combined || message).slice(0, MAX_OUTPUT),
      durationMs: Date.now() - startedAt,
    };
  }
}
