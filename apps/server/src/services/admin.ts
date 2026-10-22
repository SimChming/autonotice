import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { admins } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/password.js";

/**
 * 管理员口令只以 scrypt 哈希保存在 admins 表。
 * .env 里的 ADMIN_PASSWORD 仅作为首次部署/轮换时的引导值：
 * 启动时若库里没有该账号或哈希与当前值不匹配，就写入新的哈希。
 */
export function ensureAdmin(db: Db, username: string, password: string): void {
  const existing = db.select().from(admins).where(eq(admins.username, username)).get();
  if (!existing) {
    db.insert(admins).values({ username, passwordHash: hashPassword(password) }).run();
    return;
  }
  if (!verifyPassword(password, existing.passwordHash)) {
    db.update(admins)
      .set({ passwordHash: hashPassword(password) })
      .where(eq(admins.id, existing.id))
      .run();
  }
}

export function verifyAdmin(db: Db, username: string, password: string): boolean {
  const row = db.select().from(admins).where(eq(admins.username, username)).get();
  return row ? verifyPassword(password, row.passwordHash) : false;
}
