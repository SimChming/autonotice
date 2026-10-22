import { and, eq, gt } from "drizzle-orm";
import { bindCodes, bindings } from "../db/schema.js";
import type { Db } from "../db/client.js";

export interface BindTicket {
  code: string;
  expiresAt: number;
}

export type StartBindResult = { ok: true; ticket: BindTicket } | { ok: false; reason: "qq_taken" };

function generateCode(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
}

/** 发起绑定：为当前登录用户的目标 QQ 生成 6 位绑定码（默认 10 分钟）。 */
export function startBind(db: Db, userId: number, qq: string, ttlSeconds: number): StartBindResult {
  const existing = db.select().from(bindings).where(eq(bindings.qq, qq)).get();
  if (existing && existing.userId !== userId) {
    return { ok: false, reason: "qq_taken" };
  }

  const expiresAt = Date.now() + ttlSeconds * 1000;
  db.delete(bindCodes).where(eq(bindCodes.userId, userId)).run();

  let code = generateCode();
  for (let i = 0; i < 10; i += 1) {
    const clash = db.select().from(bindCodes).where(eq(bindCodes.code, code)).get();
    if (!clash) {
      break;
    }
    code = generateCode();
  }

  db.insert(bindCodes).values({ code, qq, userId, expiresAt }).run();
  return { ok: true, ticket: { code, expiresAt } };
}

export interface ConfirmBindResult {
  userId: number;
  qq: string;
  verifiedAt: number;
}

export function getUserBinding(db: Db, userId: number) {
  return db.select().from(bindings).where(eq(bindings.userId, userId)).get();
}

/**
 * 完成绑定：同一账号只保留一条绑定，换绑时先删旧记录。
 * 群内发码会先自动确认并消费绑定码；此时网页再确认应幂等返回已有绑定，
 * 而不是误报「绑定码无效或已过期」。
 */
export function confirmBind(db: Db, userId: number, code: string): ConfirmBindResult | null {
  const row = db
    .select()
    .from(bindCodes)
    .where(
      and(eq(bindCodes.code, code), eq(bindCodes.userId, userId), gt(bindCodes.expiresAt, Date.now())),
    )
    .get();
  if (!row) {
    const existing = getUserBinding(db, userId);
    return existing
      ? { userId, qq: existing.qq, verifiedAt: existing.verifiedAt }
      : null;
  }

  const occupied = db.select().from(bindings).where(eq(bindings.qq, row.qq)).get();
  if (occupied && occupied.userId !== userId) {
    return null;
  }

  const verifiedAt = Date.now();
  db.delete(bindings).where(eq(bindings.userId, userId)).run();
  db.insert(bindings)
    .values({ userId, qq: row.qq, verifiedAt })
    .onConflictDoUpdate({ target: bindings.qq, set: { userId, verifiedAt } })
    .run();
  db.delete(bindCodes).where(eq(bindCodes.code, code)).run();

  return { userId, qq: row.qq, verifiedAt };
}

/** 群消息触发：大号发送 6 位码即自动完成绑定，无需网页再点确认。 */
export function autoConfirmBind(db: Db, senderQq: string, text: string): ConfirmBindResult | null {
  const code = text.trim();
  if (!/^\d{6}$/.test(code)) {
    return null;
  }

  const row = db
    .select()
    .from(bindCodes)
    .where(
      and(eq(bindCodes.code, code), eq(bindCodes.qq, senderQq), gt(bindCodes.expiresAt, Date.now())),
    )
    .get();
  if (!row) {
    return null;
  }

  return confirmBind(db, row.userId, code);
}
