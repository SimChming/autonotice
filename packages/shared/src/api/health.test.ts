import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "./health.js";

describe("healthResponseSchema", () => {
  it("接受合法响应", () => {
    const parsed = healthResponseSchema.parse({
      status: "ok",
      version: "2.0.0",
      uptime: 12.5,
      time: new Date().toISOString(),
    });
    expect(parsed.status).toBe("ok");
  });

  it("拒绝错误状态", () => {
    expect(() =>
      healthResponseSchema.parse({
        status: "down",
        version: "2.0.0",
        uptime: 0,
        time: "now",
      }),
    ).toThrow();
  });
});
