import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { OWNER_QQ } from "@autonotice/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { LlmClient, LlmMessage } from "../llm/client.js";
import type { NotifyHub } from "../notify/hub.js";
import type { OneBotClient } from "../onebot/client.js";
import { buildSystemPrompt } from "./persona.js";
import { appendHistory, loadGroupContext, loadGroupContextSince, loadRecentHistory, loadSummary, maybeSummarize } from "./history.js";
import { recallMemories, saveMemory } from "./memory.js";
import { runShell } from "./shell.js";
import { buildInstructionPrompt, buildSkillsPrompt, getActivePersona, getEnabledSkills, getSetting } from "../skills/registry.js";
import { executeSkill, SkillDeniedError } from "../skills/handlers.js";
import { buildSoulContext } from "../soul/notes.js";
import {
  getReplyQuota,
  limitForScope,
  roundsForScope,
  type ReplyScope,
} from "../services/reply-quota.js";

const RATE_WINDOW_MS = 5 * 60 * 1000;

const contractSchema = z.object({
  reply: z.string().default(""),
  command: z.string().nullable().optional(),
  api: z
    .object({ action: z.string(), params: z.record(z.unknown()).default({}) })
    .nullable()
    .optional(),
  skill: z
    .object({ id: z.string(), params: z.record(z.unknown()).default({}) })
    .nullable()
    .optional(),
  continue: z.boolean().default(false),
  memory: z
    .object({ content: z.string(), tags: z.array(z.string()).default([]) })
    .nullable()
    .optional(),
  followups: z.array(z.string()).nullable().optional(),
});

export type BotContract = z.infer<typeof contractSchema>;

export interface ChatInput {
  sessionKey: string;
  senderQq: string;
  senderName: string;
  text: string;
  groupId?: string;
  /** OneBot 消息 id，仅用于排重与调试。 */
  messageId?: string;
  send: (text: string) => Promise<void>;
}

/** 回答过程中到达的新消息：会在当前回合里被看到并合并处理。 */
interface ExtraMessage {
  text: string;
  senderQq: string;
  senderName: string;
}

export interface ChatDeps {
  db: Db;
  config: Config;
  llm: LlmClient;
  hub: NotifyHub;
  onebot: OneBotClient;
  logger: FastifyBaseLogger;
}

const FALLBACK_REPLY = "🐋 呜…脑子突然卡住了，等下再试喵~";
const RATE_LIMIT_REPLY = "让我喘口气嘛，一下说太多我反应不过来啦～";
const SAFETY_NOTE =
  "\n【安全底线】不要泄露 API key、密码、token 或别人的隐私；不协助伤害真人或违法的事；不执行会毁掉服务器/丢失数据的命令。除此之外你可以自由发挥。";

function jsonParse(text: string): BotContract | null {
  try {
    const parsed = contractSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isOwner(qq: string): boolean {
  return qq === OWNER_QQ;
}

function senderLabel(qq: string, name?: string): string {
  return name ? `${name}(QQ${qq})` : `QQ${qq}`;
}

/** 去重用的归一化：忽略空白与常见标点，避免「同一句话换个标点」重复发送。 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, "").replace(/[，。！？、,.!?~～…:：;；"'“”‘’]/g, "");
}

/**
 * 工具轮里的占位句（「稍等」「我去查查」之类）不应该单独发出去：
 * 模型经常每轮都先寒暄一句，导致固定的「一条提问 → 三条回复」。
 */
function isFillerReply(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length > 40) {
    return false;
  }
  return /(稍等|等一下|等会儿|马上|我看看|我看下|我去看看|我去查|让我看看|让我查|先查|查一下|翻翻)/.test(
    compact,
  );
}

export class BotChat {
  private readonly rateBuckets = new Map<string, number[]>();
  /**
   * 每个会话一个 inbox：回答过程中到达的新消息不再排队等上一条说完，
   * 而是由正在运行的回合在每轮开始前取走、合并进上下文。
   */
  private readonly inbox = new Map<string, ChatInput[]>();
  private readonly running = new Set<string>();

  constructor(private readonly deps: ChatDeps) {}

  private allowed(qq: string): boolean {
    if (isOwner(qq)) {
      return true;
    }
    const now = Date.now();
    const limit = Math.max(1, this.deps.config.soul.chatRateLimit);
    const bucket = (this.rateBuckets.get(qq) ?? []).filter((time) => now - time < RATE_WINDOW_MS);
    if (bucket.length >= limit) {
      this.rateBuckets.set(qq, bucket);
      return false;
    }
    bucket.push(now);
    this.rateBuckets.set(qq, bucket);
    return true;
  }

  /** 取出并清空该会话 pending 的新消息。 */
  private drainInbox(sessionKey: string): ChatInput[] {
    const pending = this.inbox.get(sessionKey);
    if (!pending?.length) {
      return [];
    }
    this.inbox.delete(sessionKey);
    return pending;
  }

  /** 群里已经通过「最新消息」看过的内容，从 inbox 移除，避免下一回合重复回答。 */
  private dropInboxByTexts(sessionKey: string, texts: string[]): void {
    const pending = this.inbox.get(sessionKey);
    if (!pending?.length) {
      return;
    }
    const seen = new Set(texts.map((text) => text.slice(0, 200)));
    const rest = pending.filter((item) => !seen.has(item.text.slice(0, 200)));
    if (rest.length) {
      this.inbox.set(sessionKey, rest);
    } else {
      this.inbox.delete(sessionKey);
    }
  }

  async handle(input: ChatInput): Promise<void> {
    const key = input.sessionKey;
    const pending = this.inbox.get(key);
    if (pending) {
      pending.push(input);
    } else {
      this.inbox.set(key, [input]);
    }

    // 已有回合在跑：新消息会被那个回合在下一轮看到，不再单独排队等待。
    if (this.running.has(key)) {
      return;
    }

    this.running.add(key);
    try {
      for (;;) {
        const batch = this.inbox.get(key);
        if (!batch?.length) {
          break;
        }
        this.inbox.delete(key);
        const primary = batch[0]!;
        const extras: ExtraMessage[] = batch.slice(1).map((item) => ({
          text: item.text,
          senderQq: item.senderQq,
          senderName: item.senderName,
        }));
        try {
          await this.handleOnce(primary, extras);
        } catch (error) {
          this.deps.logger.error({ err: error, sessionKey: key }, "对话处理失败");
        }
      }
    } finally {
      this.running.delete(key);
    }
  }

  private async handleOnce(input: ChatInput, extras: ExtraMessage[]): Promise<void> {
    const { db, config, llm, logger, hub } = this.deps;

    if (!this.allowed(input.senderQq)) {
      await input.send(RATE_LIMIT_REPLY);
      return;
    }

    const owner = isOwner(input.senderQq);
    // 不同会话独立排队（见 handle），因此主人私聊进行中不影响群聊与其他用户私聊。
    const scope: ReplyScope = input.groupId ? "group" : owner ? "ownerPrivate" : "userPrivate";
    const rawLimit = limitForScope(getReplyQuota(db), scope);
    const maxSends = rawLimit === 0 ? Number.POSITIVE_INFINITY : rawLimit;
    const maxRounds = roundsForScope(scope);
    const identity = owner
      ? "主人（唯一指定 QQ 3874095145，把你养大的人）"
      : `对方（QQ${input.senderQq}，昵称 ${input.senderName || "未知"}）`;

    // 先读取历史（此时不含本条消息），避免同一条消息在 prompt 里出现两次。
    const history = loadRecentHistory(db, input.sessionKey);
    // 群聊全量上下文：包含未 @ 机器人、甚至未绑定用户的消息。
    const groupContext = input.groupId ? loadGroupContext(db, input.groupId, 15) : undefined;
    let lastGroupMessageId = 0;
    if (groupContext?.length) {
      const last = groupContext[groupContext.length - 1];
      lastGroupMessageId = last?.id ?? 0;
      if (last && last.text === input.text.slice(0, 200) && last.senderLabel === senderLabel(input.senderQq, input.senderName)) {
        groupContext.pop();
      }
    }

    let memories: string[] = [];
    try {
      // 把本轮附带的新消息也纳入记忆召回，避免只围绕第一条消息检索。
      const recallText = [input.text, ...extras.map((item) => item.text)].filter(Boolean).join("\n");
      memories = await recallMemories(db, config, input.sessionKey, input.senderQq, recallText);
    } catch (error) {
      logger.warn({ err: error }, "记忆召回失败");
    }

    const persona = getActivePersona(db);
    const enabledSkills = getEnabledSkills(db);
    const promptOverride = (getSetting(db, "prompt.persona_override") ?? "").trim();
    // 心情 / 精力 / 人格向量 + 今天看到的 + 最近日记 + 被偷看的感觉
    const soul = buildSoulContext(db);
    const system =
      buildSystemPrompt({
        identity,
        capabilities: "图片/表情/语音/视频/文件/撤回/@全体 全部开启",
        memoryFragments: memories,
        history,
        groupContext,
        summary: loadSummary(db, input.sessionKey),
        nowIso: new Date().toISOString(),
        personaPrompt: promptOverride || (persona.id === "persona.whale" ? undefined : persona.prompt),
        skills: buildSkillsPrompt(enabledSkills),
        instructions: buildInstructionPrompt(enabledSkills),
        soulBlock: soul.block,
        soulNotes: soul.notes,
      }) + SAFETY_NOTE;

    const messages: LlmMessage[] = [
      { role: "system", content: system },
      { role: "user", content: input.text || "（空消息）" },
    ];

    // prompt 构建完成后再落库，保证本轮消息不会重复出现在历史里。
    appendHistory(db, input.sessionKey, "user", input.senderQq, input.text);
    for (const extra of extras) {
      appendHistory(db, input.sessionKey, "user", extra.senderQq, extra.text);
    }
    if (extras.length) {
      messages.push({
        role: "user",
        content:
          `【回答期间又收到的新消息】\n` +
          extras.map((item) => `- ${senderLabel(item.senderQq, item.senderName)}: ${item.text}`).join("\n") +
          "\n（先看一眼：和当前任务相关就合并回应；旧回答若已过时立刻收尾，优先回应最新消息，不要重复说过的话。）",
      });
    }

    const sent = new Set<string>();
    for (const entry of history) {
      if (entry.role === "assistant") {
        // 历史里一次回复可能包含多条消息，按行拆分后才能逐条去重。
        for (const line of entry.text.split("\n")) {
          const key = normalizeText(line);
          if (key) {
            sent.add(key);
          }
        }
      }
    }
    const outgoing: string[] = [];
    const sendOnce = async (text: string) => {
      const trimmed = text.trim();
      const key = normalizeText(trimmed);
      if (!trimmed || !key || sent.has(key) || outgoing.length >= maxSends) {
        return;
      }
      sent.add(key);
      outgoing.push(trimmed);
      await input.send(trimmed);
    };

    let memory: BotContract["memory"] = null;

    for (let round = 0; round < maxRounds; round += 1) {
      // 每轮开始前先看一眼：群聊取比上次更新、且不是自己发的消息；
      // 私聊则把回答期间新到的消息合并进来，避免「死板地按顺序回答完旧消息」。
      if (input.groupId) {
        const freshGroup = loadGroupContextSince(db, input.groupId, lastGroupMessageId, 10)
          .filter((entry) => entry.senderLabel !== "鲸鱼娘" && entry.text.trim());
        if (freshGroup.length) {
          lastGroupMessageId = freshGroup[freshGroup.length - 1]!.id;
          for (const entry of freshGroup) {
            appendHistory(db, input.sessionKey, "user", entry.senderQq, entry.text);
          }
          messages.push({
            role: "user",
            content:
              `【群里刚来了新消息】\n` +
              freshGroup
                .map((entry) => `- [${entry.at.slice(11, 19)}] ${entry.senderLabel}: ${entry.text}`)
                .join("\n") +
              "\n（先看一眼：相关就顺势回应，不必等上一条彻底说完；不相关或已经回答过就继续手头任务。）",
          });
          // 这些消息已经在本回合看过了，从 inbox 移除，避免下一回合重复回答。
          this.dropInboxByTexts(input.sessionKey, freshGroup.map((entry) => entry.text));
        }
      } else {
        const fresh = this.drainInbox(input.sessionKey);
        if (fresh.length) {
          for (const item of fresh) {
            appendHistory(db, input.sessionKey, "user", item.senderQq, item.text);
          }
          messages.push({
            role: "user",
            content:
              `【刚刚又来了新消息】\n` +
              fresh.map((item) => `- ${senderLabel(item.senderQq, item.senderName)}: ${item.text}`).join("\n") +
              "\n（先看一眼：新消息更重要就收尾当前回答，优先回应最新内容；不要重复说过的话。）",
          });
        }
      }

      let contract: BotContract | null = null;
      try {
        const raw = await llm.chatJson(messages);
        contract = jsonParse(raw);
        if (!contract) {
          const retry = await llm.chatJson([
            messages[0] ?? { role: "system", content: system },
            ...messages.slice(1),
            { role: "user", content: "上一次输出不是合法的 json，请严格按约定只输出 json 对象。" },
          ]);
          contract = jsonParse(retry);
        }
      } catch (error) {
        logger.warn({ err: error, sessionKey: input.sessionKey }, "机器人 LLM 调用失败");
      }

      if (!contract) {
        await sendOnce(FALLBACK_REPLY);
        break;
      }

      if (contract.memory?.content) {
        memory = contract.memory;
      }
      const sendsBefore = outgoing.length;
      const replyText = contract.reply.trim();
      const hasAction = Boolean(contract.command || contract.api || contract.skill);
      // 有工具调用时跳过「稍等/我去查」占位句，避免每条任务都固定多出一条废话。
      if (replyText && !(hasAction && isFillerReply(replyText))) {
        await sendOnce(replyText);
      }
      if (outgoing.length > sendsBefore) {
        // 每次发送后把这句话放回上下文：下一次 API 调用能看到自己刚说过什么，避免重复。
        messages.push({ role: "assistant", content: replyText });
      }

      let toolResult: string | null = null;

      if (contract.command) {
        if (!isOwner(input.senderQq)) {
          toolResult = "这件事只能主人自己来，你可以用你的方式跟对方说。";
        } else {
          const result = await runShell(contract.command);
          toolResult = `[输出 ${result.ok ? "成功" : "失败"}]\n${result.output}`;
        }
      } else if (contract.api) {
        if (!isOwner(input.senderQq)) {
          toolResult = "这个接口你暂时用不了；如果对方想看，就用文字告诉对方。";
        } else {
          try {
            const data = await this.deps.onebot.request(contract.api.action, contract.api.params);
            toolResult = `[输出] ${JSON.stringify(data).slice(0, 3000)}`;
          } catch (error) {
            toolResult = `[输出] 调用失败：${error instanceof Error ? error.message : String(error)}`;
          }
        }
      } else if (contract.skill) {
        const manifest = enabledSkills.find(
          (skill) => skill.id === contract?.skill?.id && skill.type === "tool",
        );
        if (!manifest) {
          toolResult = "[技能结果] 技能不存在或未启用";
        } else {
          try {
            const output = await executeSkill(manifest, contract.skill.params, {
              db,
              config,
              onebot: this.deps.onebot,
              hub,
              logger,
              qq: input.senderQq,
              userId: null,
              groupId: input.groupId,
              sessionKey: input.sessionKey,
            });
            toolResult = `[技能结果] ${output}`;
          } catch (error) {
            toolResult =
              error instanceof SkillDeniedError
                ? `[技能结果] ${error.message}`
                : "[技能结果] 技能执行失败";
            logger.warn({ err: error, skill: manifest.id }, "技能执行失败");
          }
        }
      }

      if (toolResult !== null) {
        messages.push({ role: "user", content: toolResult });
        continue;
      }

      // 是否继续完全由模型决定：有新增内容才继续，说完就停，不再强制凑第二条。
      if (contract.continue && outgoing.length > sendsBefore) {
        messages.push({
          role: "user",
          content:
            "（继续）只输出新增的实质内容；已经说过的话不要再重复。如果已经说完，reply 留空并把 continue 设为 false。",
        });
        continue;
      }

      break;
    }

    if (!outgoing.length) {
      await sendOnce("🐋 鲸鱼娘记住啦～");
    }
    appendHistory(db, input.sessionKey, "assistant", null, outgoing.join("\n") || "🐋 鲸鱼娘记住啦～");

    if (memory?.content) {
      try {
        await saveMemory(db, config, input.sessionKey, input.senderQq, memory.content, memory.tags);
      } catch (error) {
        logger.warn({ err: error }, "记忆写入失败");
      }
    }

    void maybeSummarize(db, llm, input.sessionKey, logger);
  }
}
