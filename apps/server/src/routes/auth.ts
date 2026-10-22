import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { authResponseSchema, loginRequestSchema, registerRequestSchema } from "@autonotice/shared";
import type { Db } from "../db/client.js";
import type { Config } from "../config.js";
import { users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { fail } from "../auth/guard.js";
import { getUserBinding } from "../services/bind.js";

interface AuthRouteOptions {
  db: Db;
  config: Config;
}

export function registerAuthRoutes(app: FastifyInstance, { db, config }: AuthRouteOptions): void {
  const signToken = (user: { id: number; username: string }) =>
    app.jwt.sign({ sub: user.id, scope: "user", username: user.username }, { expiresIn: config.jwt.ttl });

  app.post("/api/v1/auth/register", async (request, reply) => {
    const parsed = registerRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "参数不合法");
    }

    const existing = db.select().from(users).where(eq(users.username, parsed.data.username)).get();
    if (existing) {
      return fail(reply, 409, "username_taken", "用户名已存在");
    }

    const createdAt = Date.now();
    const inserted = db
      .insert(users)
      .values({
        username: parsed.data.username,
        passwordHash: hashPassword(parsed.data.password),
        createdAt,
      })
      .returning({ id: users.id, username: users.username })
      .get();

    return authResponseSchema.parse({
      token: signToken(inserted),
      user: inserted,
      binding: null,
    });
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", "用户名或密码格式不正确");
    }

    const user = db.select().from(users).where(eq(users.username, parsed.data.username)).get();
    if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
      return fail(reply, 401, "invalid_credentials", "用户名或密码错误");
    }

    const binding = getUserBinding(db, user.id);
    return authResponseSchema.parse({
      token: signToken({ id: user.id, username: user.username }),
      user: { id: user.id, username: user.username },
      binding: binding
        ? { qq: binding.qq, verifiedAt: new Date(binding.verifiedAt).toISOString() }
        : null,
    });
  });
}
