import { desc } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { adminAudit, soulCommands } from "../db/schema.js";
import { runOnHost } from "../host/exec.js";
import type { LlmClient } from "../llm/client.js";
import { progressIntention, type IntentionRow } from "./life.js";
import { addEvent, dayKey, listEvents } from "./store.js";
import { innerThought } from "./think.js";

export interface HandsDeps {
  db: Db;
  config: Config;
  llm: LlmClient;
  logger: FastifyBaseLogger;
}

export interface CommandRow {
  id: number;
  command: string;
  output: string;
  ok: number;
  durationMs: number;
  trigger: string;
  reason: string;
  day: string;
  createdAt: number;
}

export function listCommands(db: Db, limit = 20): CommandRow[] {
  return db.select().from(soulCommands).orderBy(desc(soulCommands.id)).limit(limit).all();
}

function parseLoose<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function record(
  deps: HandsDeps,
  input: {
    command: string;
    output: string;
    ok: boolean;
    durationMs: number;
    trigger: "self" | "owner";
    reason: string;
  },
): void {
  const now = Date.now();
  deps.db
    .insert(soulCommands)
    .values({
      command: input.command.slice(0, 2000),
      output: input.output.slice(0, 8000),
      ok: input.ok ? 1 : 0,
      durationMs: input.durationMs,
      trigger: input.trigger,
      reason: input.reason.slice(0, 300),
      day: dayKey(),
      createdAt: now,
    })
    .run();
  deps.db
    .insert(adminAudit)
    .values({
      action: "soul_host_command",
      detail: JSON.stringify({
        trigger: input.trigger,
        command: input.command.slice(0, 500),
        ok: input.ok,
        reason: input.reason.slice(0, 200),
      }),
      createdAt: now,
    })
    .run();
}

/** 让她自己想一条要执行的命令；想不出来就返回 null。 */
async function planCommand(
  deps: HandsDeps,
  intention: IntentionRow | null,
  previous: string,
): Promise<{ command: string; reason: string } | null> {
  const recent = listEvents(deps.db, 8)
    .map((row) => `- （${row.kind}）${row.content.slice(0, 120)}`)
    .join("\n");
  const raw = await deps.llm.chatJson([
    {
      role: "system",
      content:
        "你在模拟一个住在服务器里的少女。你只输出 json，不要解释。所有文字都是中文口语。",
    },
    {
      role: "user",
      content: `你现在不是聊天，是亲手操作这台机器——你就活在这台 debian 上，拥有 root 权限，可以执行任何命令：看日志、看进程、查磁盘、读文件、装工具、改配置、重启服务，都可以。

你最近经历的事：
${recent || "（最近很安静）"}

你心里挂着：${intention ? `${intention.text}（${intention.kind}）` : "（暂时没有）"}
${previous ? `\n你刚刚已经执行过：\n${previous}\n` : ""}

请决定你现在想亲手做什么。要求：
- 只能给一条非交互式命令（不能是 vim/top 这种会卡住的）；
- 如果是查看类，尽量加 -n / --no-pager 之类避免刷屏；
- 必须和你此刻的状态或心里的事有关，不要为了执行而执行；
- 如果你现在不想动服务器，就把 command 设为 null。
输出 json：{"command":"……或 null","reason":"为什么想做这件事，一句口语"}`,
    },
  ]);
  const parsed = parseLoose<{ command?: string | null; reason?: string }>(raw);
  const command = String(parsed?.command ?? "").trim();
  if (!command || command === "null") {
    return null;
  }
  return { command, reason: String(parsed?.reason ?? "").trim() };
}

/** 她自主动手：一次醒来最多执行 N 条命令，然后把感受写进经历。 */
export async function activityHands(
  deps: HandsDeps,
  intention: IntentionRow | null,
): Promise<void> {
  const max = deps.config.soul.handsMaxPerTick;
  const executed: string[] = [];
  let previous = "";

  for (let index = 0; index < max; index += 1) {
    const plan = await planCommand(deps, intention, previous);
    if (!plan) {
      break;
    }
    const result = await runOnHost(plan.command);
    record(deps, {
      command: plan.command,
      output: result.output,
      ok: result.ok,
      durationMs: result.durationMs,
      trigger: "self",
      reason: plan.reason,
    });
    deps.logger.info(
      { command: plan.command, ok: result.ok, durationMs: result.durationMs },
      "她亲手执行了一条命令",
    );
    executed.push(`$ ${plan.command}\n${result.output.slice(0, 400)}`);
    previous = `$ ${plan.command}\n${result.output.slice(0, 600)}`;
    if (!result.ok && index > 0) {
      break;
    }
  }

  if (!executed.length) {
    return;
  }
  const thought = await innerThought(
    deps,
    `你刚刚亲手在这台机器上做了这些：\n${executed.join("\n\n").slice(0, 1500)}\n\n写下你做完之后真实的一句感想，不要复述输出。`,
    intention,
  );
  if (thought) {
    addEvent(deps.db, "hands", thought);
  }
  if (intention) {
    progressIntention(
      deps.db,
      intention.id,
      `你亲手执行了 ${executed.length} 条命令：${previous.slice(0, 120)}`,
    );
  }
}

/**
 * 主人让她做一件事：把自然语言转成一条命令并立即执行。
 * 她不会因为是主人的要求就绕过自己的判断，只是这次动机来自主人。
 */
export async function runOwnerInstruction(
  deps: HandsDeps,
  instruction: string,
): Promise<{ command: string; output: string; ok: boolean }> {
  const raw = await deps.llm.chatJson([
    {
      role: "system",
      content: "你只输出 json，不要解释。你在把一句人类指令翻译成一条可执行的非交互式 shell 命令。",
    },
    {
      role: "user",
      content: `这台机器是 debian，你是 root，工作目录 /home/simchm。
请把下面这句话变成一条非交互式 bash 命令：
「${instruction}」
要求：只输出命令本身，不要 markdown 代码块，不要解释，不要交互式程序。
输出 json：{"command":"……"}`,
    },
  ]);
  const parsed = parseLoose<{ command?: string }>(raw);
  const command = String(parsed?.command ?? "").trim().replace(/^```(?:bash)?|```$/g, "").trim();
  if (!command) {
    return { command: "", output: "没听懂要做什么", ok: false };
  }
  const result = await runOnHost(command);
  record(deps, {
    command,
    output: result.output,
    ok: result.ok,
    durationMs: result.durationMs,
    trigger: "owner",
    reason: instruction.slice(0, 200),
  });
  return { command, output: result.output, ok: result.ok };
}
