import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema.js";

/** 打开 SQLite 并执行迁移；容器内 migrations 目录随 apps/server 一起复制。 */
export function createDatabase(path: string) {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(process.cwd(), "migrations") });

  return { db, sqlite };
}

export type DatabaseHandle = ReturnType<typeof createDatabase>;
export type Db = DatabaseHandle["db"];
