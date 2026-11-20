import { runOnHost } from "../host/exec.js";

export interface ShellResult {
  ok: boolean;
  output: string;
}

/**
 * 主人与她那双手共用的命令入口。
 * 5.1.0 起命令真正跑在宿主 debian 上（容器内用 nsenter 进入宿主命名空间），
 * 不再限制具体命令；超时、输出长度与审计仍在执行层处理。
 */
export async function runShell(command: string): Promise<ShellResult> {
  const result = await runOnHost(command);
  return { ok: result.ok, output: result.output };
}
