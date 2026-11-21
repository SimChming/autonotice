/**
 * 5.4.0 仿人闭环的公共类型。
 *
 * 这里刻意只放类型，不引入运行时依赖：
 * BotChat 只需要知道自己要返回什么、内核会给自己什么，避免和 kernel 互相 import。
 */

export type AgentEventSource = "qq" | "admin" | "timer" | "soul" | "tool" | "system";

export interface AgentEventRow {
  id: number;
  source: string;
  type: string;
  sessionKey: string | null;
  addressed: number;
  payload: string;
  importance: number;
  createdAt: number;
  consumedAt: number | null;
}

export type AgentCondition =
  | { type: "time"; at?: number; afterSeconds?: number; repeatSeconds?: number }
  | { type: "keyword"; sessionKey?: string; keywords: string[] }
  | { type: "event"; source?: string; eventType?: string; sessionKey?: string }
  | { type: "drive"; name: string; gte: number }
  | { type: "idle"; minutes: number; sessionKey?: string }
  | {
      type: "shell";
      command: string;
      expectContains?: string;
      expectRegex?: string;
      exitOk?: boolean;
      intervalSeconds?: number;
    };

export interface AgentTriggerSpec {
  name: string;
  condition: AgentCondition;
  prompt?: string;
  sessionKey?: string | null;
  oneShot?: boolean;
  cooldownMs?: number;
  priority?: number;
}

export interface AgentTriggerRow {
  id: number;
  name: string;
  kind: string;
  sessionKey: string | null;
  condition: string;
  prompt: string;
  enabled: number;
  oneShot: number;
  cooldownMs: number;
  priority: number;
  expiresAt: number | null;
  lastCheckedAt: number | null;
  lastFiredAt: number | null;
  fireCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentActivationRow {
  id: number;
  sessionKey: string | null;
  mode: string;
  kind: string;
  triggerId: number | null;
  eventId: number | null;
  status: string;
  task: string;
  context: string;
  nextRunAt: number | null;
  leaseUntil: number | null;
  continueCount: number;
  maxContinues: number;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  lastError: string;
}

export interface AgentCycleRow {
  id: number;
  activationId: number | null;
  eventId: number | null;
  classifier: string;
  thought: string;
  actions: string;
  result: string;
  createdAt: number;
}

export interface AgentEventInput {
  source: AgentEventSource;
  type: string;
  sessionKey?: string | null;
  addressed?: boolean;
  payload?: Record<string, unknown>;
  importance?: number;
}

export type ClassifierDecision = "ignore" | "wake" | "interrupt" | "stop";

export interface ClassifierResult {
  decision: ClassifierDecision;
  triggerIds: number[];
  carry: string;
  reason: string;
  urgency: number;
}

/** 一次对话回合结束时，BotChat 交给内核的「未完待续」。 */
export interface ChatPending {
  task: string;
  nextInSeconds: number;
  context?: string;
}

export interface ChatRunResult {
  activationId?: number;
  sessionKey?: string;
  pending?: ChatPending;
  triggers?: AgentTriggerSpec[];
  thought?: string;
  /** 回合进行中又来了用户消息：这时不要再安排自激续跑，让用户先说。 */
  preempted?: boolean;
  sent: number;
}

/** 内核只需要对话层提供这两个能力，不依赖 BotChat 的具体实现。 */
export interface AgentChatBridge {
  resume(input: {
    sessionKey: string;
    groupId?: string;
    note: string;
    send: (text: string) => Promise<void>;
    activationId?: number;
  }): Promise<ChatRunResult>;
  isRunning(sessionKey: string): boolean;
}

/** BotChat 在用户回合开始/结束时通知内核。 */
export interface AgentChatHooks {
  /** 用户消息刚到达：先记事件并取消她正在进行的自激续跑（插话抢占）。 */
  noteUserMessage(input: {
    sessionKey: string;
    groupId?: string;
    senderQq: string;
    text: string;
  }): void;
  beginUserTurn(input: {
    sessionKey: string;
    groupId?: string;
    senderQq: string;
    text: string;
  }): number | undefined;
  endTurn(result: ChatRunResult, internal: boolean): void;
}

export type AgentAction =
  | { type: "say"; text: string; target?: string }
  | { type: "activity"; name: string; reason?: string }
  | { type: "shell"; command: string; reason?: string }
  | {
      type: "trigger";
      op: "add" | "remove" | "disable";
      id?: number;
      trigger?: AgentTriggerSpec;
    }
  | { type: "intention"; text: string; kind?: string }
  | { type: "event"; kind: string; content: string };

export interface AgentPlan {
  thought: string;
  actions: AgentAction[];
  triggers: AgentTriggerSpec[];
  self: {
    continue: boolean;
    nextInSeconds: number;
    task: string;
    context: string;
  };
  done: boolean;
}

export interface AgentKernel {
  hooks: AgentChatHooks;
  attachChat(bridge: AgentChatBridge): void;
  emit(input: AgentEventInput): void;
  addTrigger(spec: AgentTriggerSpec): AgentTriggerRow;
  wake(prompt?: string, sessionKey?: string | null): void;
  cancelActivation(id: number): void;
  start(): void;
  stop(): void;
  isRunning(sessionKey?: string): boolean;
  snapshot(): {
    activations: AgentActivationRow[];
    triggers: AgentTriggerRow[];
    cycles: AgentCycleRow[];
    events: AgentEventRow[];
  };
}

export function emptyPlan(): AgentPlan {
  return {
    thought: "",
    actions: [],
    triggers: [],
    self: { continue: false, nextInSeconds: 45, task: "", context: "" },
    done: true,
  };
}
