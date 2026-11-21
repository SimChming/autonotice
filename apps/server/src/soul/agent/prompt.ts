import type { Db } from "../../db/client.js";
import type { LlmMessage } from "../../llm/client.js";
import { renderLifeBlock } from "../life.js";
import { SOUL_INNER_PERSONA } from "../persona.js";
import { getSoulSnapshot, listEvents as listSoulEvents, renderSoulBlock } from "../store.js";
import type { AgentActivationRow } from "./types.js";
import { listOpenActivations, listTriggers, recentEventsText } from "./store.js";

export interface AgentPromptInput {
  activation: AgentActivationRow;
  /** 分类器带进来的信息。 */
  carry?: string;
  /** 触发这轮的条件/事件说明。 */
  triggerNote?: string;
}

const ACTION_GUIDE = `【你这一轮可以做的事】actions 是数组，可以一次做 0-3 件：
- {"type":"activity","name":"hot|browse|monologue|talk|rest|hands|companion|journal","reason":"为什么"}
- {"type":"say","text":"要发出去的话","target":"group:群号 或 private:QQ（不填就发到当前会话）"}
- {"type":"shell","command":"非交互式命令","reason":"为什么想执行"}
- {"type":"trigger","op":"add","trigger":{"name":"名字","condition":{"type":"time|keyword|event|drive|idle|shell",...},"prompt":"条件满足时提醒你想什么","sessionKey":"可省略","oneShot":true,"cooldownMs":300000}}
- {"type":"trigger","op":"disable","id":触发器id}
- {"type":"trigger","op":"remove","id":触发器id}
- {"type":"intention","text":"想长期惦记的事","kind":"goal|question|worry|promise"}
- {"type":"event","kind":"thought","content":"值得写进经历的短句"}

条件触发器写法：
- 时间：{"type":"time","afterSeconds":3600,"repeatSeconds":86400}
- 关键词：{"type":"keyword","sessionKey":"group:123","keywords":["作业","考试"]}
- 事件：{"type":"event","source":"qq","eventType":"group_message","sessionKey":"group:123"}
- 驱力：{"type":"drive","name":"curiosity","gte":75}
- 闲置：{"type":"idle","minutes":90}
- 服务器指标：{"type":"shell","command":"df -P / | awk 'NR==2{print $5}'","expectRegex":"9[0-9]%","intervalSeconds":300}

【自激触发器】
如果你觉得这件事还没说完、或工作没完成，把 self.continue 设为 true，并写 nextInSeconds（20-300 秒）和 task（下一轮要接着做什么）。
如果你觉得可以闭嘴了，self.continue=false 且 done=true。`;

export function buildAgentPrompt(
  db: Db,
  input: AgentPromptInput,
): LlmMessage[] {
  const soul = getSoulSnapshot(db);
  const experiences = listSoulEvents(db, 10)
    .map((row) => `- （${row.kind}）${row.content.slice(0, 120)}`)
    .join("\n");
  const triggers = listTriggers(db, true)
    .slice(0, 12)
    .map((row) => {
      let condition = row.condition;
      try {
        condition = JSON.stringify(JSON.parse(row.condition));
      } catch {
        // 原样展示
      }
      return `- #${row.id}「${row.name}」${condition}${row.sessionKey ? ` @${row.sessionKey}` : ""}`;
    })
    .join("\n");
  const open = listOpenActivations(db)
    .filter((row) => row.id !== input.activation.id)
    .slice(0, 5)
    .map((row) => `- #${row.id} ${row.kind}/${row.status}：${row.task.slice(0, 80)}`)
    .join("\n");

  const context = [
    `【你现在这一轮】#${input.activation.id} kind=${input.activation.kind} mode=${input.activation.mode}`,
    input.activation.task ? `要做的事：${input.activation.task}` : "（没有明确任务，按你此刻的驱动决定）",
    input.activation.context ? `你带进来的上下文：${input.activation.context}` : "",
    input.triggerNote ? `触发原因：${input.triggerNote}` : "",
    input.carry ? `刚带进来的环境信息：${input.carry}` : "",
    open ? `【你另外还在进行的事】\n${open}` : "",
    triggers ? `【你现在设着的条件触发器】\n${triggers}` : "（还没设条件触发器）",
    `【最近经历】\n${experiences || "（最近很安静）"}`,
    `【环境里刚发生的事】\n${recentEventsText(db, 8)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    {
      role: "system",
      content: `${SOUL_INNER_PERSONA}
你现在不是在回复某个人，而是在自己的意识循环里：先看环境，再决定要不要做点什么。
你可以什么都不做；不要为了输出而编造没有发生的事。`,
    },
    {
      role: "user",
      content: `${renderSoulBlock(soul)}

${renderLifeBlock(db)}

${context}

${ACTION_GUIDE}

只输出 json：
{"thought":"你此刻真实的一两句想法","actions":[],"triggers":[],"self":{"continue":false,"nextInSeconds":45,"task":"","context":""},"done":true}`,
    },
  ];
}
