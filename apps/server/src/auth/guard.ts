import type { FastifyReply, FastifyRequest } from "fastify";

export interface UserClaims {
  sub: number;
  scope: "user";
  username: string;
}

export interface ErrorBody {
  code: string;
  message: string;
}

export function fail(reply: FastifyReply, status: number, code: string, message: string, details?: unknown) {
  return reply.code(status).send({ code, message, ...(details === undefined ? {} : { details }) });
}

export interface AdminClaims {
  sub: string;
  scope: "admin";
  username: string;
}

/**
 * 管理员守卫：scope 必须为 `admin`，与普通用户 token 完全隔离（Phase 7 双 scope）。
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AdminClaims | null> {
  try {
    await request.jwtVerify();
  } catch {
    fail(reply, 401, "unauthorized", "请先登录管理后台");
    return null;
  }
  const claims = request.user as Partial<AdminClaims>;
  if (claims.scope !== "admin" || typeof claims.sub !== "string") {
    fail(reply, 403, "forbidden", "需要管理员权限");
    return null;
  }
  return claims as AdminClaims;
}

/**
 * 普通用户守卫：校验 JWT 且 scope 必须为 `user`。
 * 管理员 token（Phase 7）不得通过此守卫，避免双 scope 混用（§7 Phase 7）。
 */
export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<UserClaims | null> {
  try {
    await request.jwtVerify();
  } catch {
    fail(reply, 401, "unauthorized", "请先登录");
    return null;
  }
  const claims = request.user as Partial<UserClaims>;
  if (claims.scope !== "user" || typeof claims.sub !== "number") {
    fail(reply, 403, "forbidden", "token 权限不匹配");
    return null;
  }
  return claims as UserClaims;
}
