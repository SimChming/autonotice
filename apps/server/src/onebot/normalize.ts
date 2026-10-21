/**
 * OneBot v11 message 双形态兼容（段数组 / CQ 字符串），§7 Phase 3。
 * 只做归一化，不判权限、不落库。
 */

export interface NormalizedMessage {
  groupId: string;
  senderQq: string;
  senderName: string;
  text: string;
  atTargets: string[];
  isAtBot: boolean;
  msgTime: number;
  raw: unknown;
}

interface Segment {
  type?: string;
  data?: Record<string, unknown>;
}

const CQ_AT = /\[CQ:at,qq=(\d+)[^\]]*\]/g;
const CQ_ANY = /\[CQ:[^\]]+\]/g;

/**
 * 私聊消息归一化；机器人自己发的、非私聊事件返回 null。
 */
export function normalizePrivateMessage(event: unknown, botQq: string): NormalizedPrivateMessage | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const payload = event as Record<string, unknown>;
  if (payload.post_type !== "message" || payload.message_type !== "private") {
    return null;
  }

  const senderQq = String(payload.user_id ?? "");
  if (!senderQq || senderQq === botQq) {
    return null;
  }

  const sender = (payload.sender ?? {}) as Record<string, unknown>;
  const rawMessage = payload.message;
  const parsed = Array.isArray(rawMessage)
    ? segmentsFromArray(rawMessage as Segment[])
    : typeof rawMessage === "string"
      ? parseCqString(rawMessage)
      : { text: "" };

  const seconds = Number(payload.time);
  return {
    senderQq,
    senderName: String(sender.nickname ?? ""),
    text: parsed.text,
    msgTime: Number.isFinite(seconds) ? seconds * 1000 : Date.now(),
    raw: event,
  };
}


export interface NormalizedPrivateMessage {
  senderQq: string;
  senderName: string;
  text: string;
  msgTime: number;
  raw: unknown;
}

function segmentsFromArray(message: Segment[]): { text: string; atTargets: string[] } {
  const atTargets: string[] = [];
  let text = "";
  for (const segment of message) {
    if (segment.type === "text") {
      text += String(segment.data?.text ?? "");
    } else if (segment.type === "at") {
      const qq = String(segment.data?.qq ?? "");
      if (qq) {
        atTargets.push(qq);
      }
    }
  }
  return { text: text.trim(), atTargets };
}

function parseCqString(message: string): { text: string; atTargets: string[] } {
  const atTargets: string[] = [];
  for (const match of message.matchAll(CQ_AT)) {
    const qq = match[1];
    if (qq) {
      atTargets.push(qq);
    }
  }
  return { text: message.replace(CQ_ANY, "").trim(), atTargets };
}

export interface NormalizedPrivateMessage {
  senderQq: string;
  senderName: string;
  text: string;
  msgTime: number;
  raw: unknown;
}

/**
 * 从 OneBot message 事件中提取群消息。非群消息、机器人自身消息返回 null。
 */
export function normalizeMessageEvent(event: unknown, botQq: string): NormalizedMessage | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const payload = event as Record<string, unknown>;
  if (payload.post_type !== "message" || payload.message_type !== "group") {
    return null;
  }

  const sender = (payload.sender ?? {}) as Record<string, unknown>;
  const senderQq = String(payload.user_id ?? sender.user_id ?? "");
  if (!senderQq || senderQq === botQq) {
    return null;
  }

  const rawMessage = payload.message;
  const parsed = Array.isArray(rawMessage)
    ? segmentsFromArray(rawMessage as Segment[])
    : typeof rawMessage === "string"
      ? parseCqString(rawMessage)
      : { text: "", atTargets: [] as string[] };

  const seconds = Number(payload.time);
  return {
    groupId: String(payload.group_id ?? ""),
    senderQq,
    senderName: String(sender.card || sender.nickname || ""),
    text: parsed.text,
    atTargets: parsed.atTargets,
    isAtBot: parsed.atTargets.includes(botQq),
    msgTime: Number.isFinite(seconds) ? seconds * 1000 : Date.now(),
    raw: event,
  };
}
