/**
 * 跨端共享契约入口。
 * 硬规则（§4.3）：服务端与客户端之间的所有类型/常量只从这里导出，禁止各自复制。
 */
export * from "./constants.js";
export * from "./api/health.js";
export * from "./api/auth.js";
export * from "./api/bind.js";
export * from "./api/schedule.js";
export * from "./api/skill.js";
