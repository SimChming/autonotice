import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import { adminAudit, soulCommands } from "../../db/schema.js";
import { runOnHost } from "../../host/exec.js";
import type { LlmClient } from "../../llm/client.js";
import type { OneBotClient } from "../../onebot/client.js";
import { activityCompanion } from "../companion.js";
import { activityHands } from "../hands.js";
import {
  activityBrowse,
  activityHot,
  activityMonologue,
  activityRest,
  activityTalk,
} from "../idle.js";
import { writeDailyJournal } from "../journal.js";
import { addIntention, pickIntention, relieveDrive, type IntentionKind } from "../life.js";
import { addEvent, dayKey } from "../store.js";
import { sendToSession } from "./channel.js";
import type { AgentAction, AgentActivationRow, AgentTriggerSpec } from "./types.js";
import { createTrigger, disableTrigger, listTriggers, removeTrigger } from "./store.js";

export interface EffectorDeps {
  db: Db;
  config: Config;
  llm: LlmClient;
  companion: LlmClient;
  onebot: OneBotClient;
  logger: FastifyBaseLogger;
  onAssistant?: (sessionKey: string, text: string) => void;
}

export interface ActionOutcome {
  ok: boolean;
  text: string;
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

function recordCommand(
  deps: EffectorDeps,
  command: string,
  output: string,
  ok: boolean,
  reason: string,
): void {
  const now = Date.now();
  deps.db
    .insert(soulCommands)
    .values({
      command: command.slice(0, 2000),
      output: output.slice(0, 8000),
      ok: ok ? 1 : 0,
      durationMs: 0,
      trigger: "self",
      reason: reason.slice(0, 300),
      day: dayKey(),
      createdAt: now,
    })
    .run();
  deps.db
    .insert(adminAudit)
    .values({
      action: "agent_host_command",
      detail: JSON.stringify({ command: command.slice(0, 500), ok, reason: reason.slice(0, 200) }),
      createdAt: now,
    })
    .run();
}

function validTriggerSpec(spec: unknown): spec is AgentTriggerSpec {
  if (!spec || typeof spec !== "object") {
    return false;
  }
  const value = spec as Record<string, unknown>;
  const condition = value.condition as Record<string, unknown> | undefined;
  if (!condition || typeof condition.type !== "string") {
    return false;
  }
  return ["time", "keyword", "event", "drive", "idle", "shell"].includes(condition.type);
}

async function runActivity(
  deps: EffectorDeps,
  activation: AgentActivationRow,
  name: string,
): Promise<ActionOutcome> {
  const soulDeps = {
    db: deps.db,
    config: deps.config,
    llm: deps.llm,
    companion: deps.companion,
    onebot: deps.onebot,
    logger: deps.logger,
  };
  const intention = pickIntention(deps.db);

  switch (name) {
    case "hot":
      await activityHot(soulDeps, intention);
      relieveDrive(deps.db, "hot");
      return { ok: true, text: "刷了一会儿热搜" };
    case "browse":
      await activityBrowse(soulDeps, intention);
      relieveDrive(deps.db, "browse");
      return { ok: true, text: "顺着心里的问题查了查" };
    case "monologue":
      await activityMonologue(soulDeps, intention);
      relieveDrive(deps.db, "monologue");
      return { ok: true, text: "一个人自言自语了几句" };
    case "talk":
      await activityTalk(soulDeps, intention);
      relieveDrive(deps.db, "talk");
      return { ok: true, text: "主动找主人说了话" };
    case "rest":
      await activityRest(soulDeps);
      relieveDrive(deps.db, "rest");
      return { ok: true, text: "发了一会儿呆" };
    case "hands":
      await activityHands({ db: deps.db, config: deps.config, llm: deps.llm, logger: deps.logger }, intention);
      relieveDrive(deps.db, "hands");
      return { ok: true, text: "亲手在这台机器上做了点事" };
    case "companion":
      await activityCompanion(
        {
          db: deps.db,
          config: deps.config,
          llm: deps.llm,
          companion: deps.companion,
          logger: deps.logger,
        },
        intention,
      );
      relieveDrive(deps.db, "companion");
      return { ok: true, text: "和住在同一台机器上的另一个声音聊了几句" };
    case "journal": {
      const wrote = await writeDailyJournal(deps.db, deps.config, deps.llm, deps.logger);
      if (wrote) {
        relieveDrive(deps.db, "journal");
      }
      return { ok: true, text: wrote ? "写了今天的日记" : "今天已经写过日记了" };
    }
    default:
      return { ok: false, text: `未知活动：${name}` };
  }
}

/** 执行模型给出的动作；所有结果都会被写回经历，供下一轮环境感知。 */
export async function executeActions(
  deps: EffectorDeps,
  activation: AgentActivationRow,
  actions: AgentAction[],
): Promise<ActionOutcome[]> {
  const outcomes: ActionOutcome[] = [];

  for (const action of actions.slice(0, 4)) {
    switch (action.type) {
      case "say": {
        const target = action.target?.trim() || activation.sessionKey;
        if (!target) {
          outcomes.push({ ok: false, text: "没有可发送的会话" });
          break;
        }
        const ok = await sendToSession(
          {
            db: deps.db,
            onebot: deps.onebot,
            logger: deps.logger,
            onAssistant: deps.onAssistant,
          },
          target,
          action.text,
        );
        if (ok) {
          addEvent(deps.db, "talk", `她主动说：${action.text.slice(0, 200)}`);
        }
        outcomes.push({ ok, text: ok ? `发到 ${target}：${action.text.slice(0, 120)}` : "发送失败" });
        break;
      }

      case "activity": {
        outcomes.push(await runActivity(deps, activation, action.name));
        break;
      }

      case "shell": {
        const result = await runOnHost(action.command);
        recordCommand(deps, action.command, result.output, result.ok, action.reason ?? "自主行动");
        addEvent(
          deps.db,
          "hands",
          `她执行了 $ ${action.command.slice(0, 160)}\n${result.output.slice(0, 500)}`,
        );
        outcomes.push({
          ok: result.ok,
          text: `$ ${action.command.slice(0, 120)}\n${result.output.slice(0, 600)}`,
        });
        break;
      }

      case "trigger": {
        if (action.op === "add") {
          if (!validTriggerSpec(action.trigger)) {
            outcomes.push({ ok: false, text: "触发器条件不合法" });
            break;
          }
          if (listTriggers(deps.db).length >= 30) {
            outcomes.push({ ok: false, text: "触发器太多了，先删掉几个" });
            break;
          }
          const spec: AgentTriggerSpec = {
            ...action.trigger,
            sessionKey: action.trigger.sessionKey ?? activation.sessionKey,
          };
          const row = createTrigger(deps.db, spec);
          outcomes.push({ ok: true, text: `设了一个条件触发器 #${row.id}：${row.name}` });
        } else if (action.op === "disable" && Number.isFinite(action.id)) {
          disableTrigger(deps.db, action.id as number);
          outcomes.push({ ok: true, text: `停用了触发器 #${action.id}` });
        } else if (action.op === "remove" && Number.isFinite(action.id)) {
          removeTrigger(deps.db, action.id as number);
          outcomes.push({ ok: true, text: `删除了触发器 #${action.id}` });
        } else {
          outcomes.push({ ok: false, text: "触发器操作缺少 id" });
        }
        break;
      }

      case "intention": {
        const text = action.text.trim();
        if (text.length < 2) {
          outcomes.push({ ok: false, text: "挂念太短" });
          break;
        }
        const kinds = ["goal", "question", "worry", "promise"];
        const kind = (kinds.includes(String(action.kind)) ? action.kind : "goal") as IntentionKind;
        const id = addIntention(deps.db, text, kind, 60);
        outcomes.push({ ok: true, text: `心里挂上了一件事 #${id}：${text.slice(0, 80)}` });
        break;
      }

      case "event": {
        addEvent(deps.db, action.kind || "thought", action.content);
        outcomes.push({ ok: true, text: `记下了一条经历` });
        break;
      }

      default:
        outcomes.push({ ok: false, text: "未知动作" });
    }
  }

  return outcomes;
}

/** 把模型输出的 actions 从宽松 JSON 里捞出来，过滤掉明显不合法的项。 */
export function parseActions(raw: unknown): AgentAction[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: AgentAction[] = [];
  for (const item of raw.slice(0, 6)) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const value = item as Record<string, unknown>;
    const type = String(value.type ?? "");
    if (type === "say" && typeof value.text === "string" && value.text.trim()) {
      out.push({
        type: "say",
        text: value.text.slice(0, 1000),
        target: typeof value.target === "string" ? value.target : undefined,
      });
    } else if (type === "activity" && typeof value.name === "string") {
      out.push({ type: "activity", name: value.name, reason: String(value.reason ?? "") });
    } else if (type === "shell" && typeof value.command === "string" && value.command.trim()) {
      out.push({
        type: "shell",
        command: value.command.slice(0, 2000),
        reason: String(value.reason ?? ""),
      });
    } else if (type === "trigger" && (value.op === "add" || value.op === "disable" || value.op === "remove")) {
      out.push({
        type: "trigger",
        op: value.op,
        id: Number.isFinite(Number(value.id)) ? Number(value.id) : undefined,
        trigger: validTriggerSpec(value.trigger) ? value.trigger : undefined,
      });
    } else if (type === "intention" && typeof value.text === "string" && value.text.trim()) {
      out.push({
        type: "intention",
        text: value.text.slice(0, 300),
        kind: typeof value.kind === "string" ? value.kind : undefined,
      });
    } else if (type === "event" && typeof value.content === "string" && value.content.trim()) {
      out.push({
        type: "event",
        kind: typeof value.kind === "string" ? value.kind : "thought",
        content: value.content.slice(0, 1000),
      });
    }
  }
  return out;
}

/** 从宽松输出里解析触发器数组。 */
export function parseTriggerSpecs(raw: unknown): AgentTriggerSpec[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item): item is AgentTriggerSpec => validTriggerSpec(item))
    .slice(0, 4)
    .map((spec) => ({
      ...spec,
      name: String(spec.name ?? "未命名触发器").slice(0, 120),
      prompt: String(spec.prompt ?? "").slice(0, 1200),
    }));
}

export { parseLoose };
