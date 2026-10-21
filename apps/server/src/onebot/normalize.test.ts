import { describe, expect, it } from "vitest";
import { normalizeMessageEvent, normalizePrivateMessage } from "./normalize.js";

const BOT = "3754609823";

function groupEvent(message: unknown) {
  return {
    post_type: "message",
    message_type: "group",
    group_id: 1130297603,
    user_id: 3874095145,
    time: 1_700_000_000,
    sender: { nickname: "无冕", card: "" },
    message,
  };
}

describe("normalizeMessageEvent", () => {
  it("兼容段数组并识别 @ 机器人", () => {
    const result = normalizeMessageEvent(
      groupEvent([
        { type: "at", data: { qq: BOT } },
        { type: "text", data: { text: " 明天交作业 " } },
      ]),
      BOT,
    );

    expect(result).not.toBeNull();
    expect(result?.text).toBe("明天交作业");
    expect(result?.isAtBot).toBe(true);
    expect(result?.atTargets).toEqual([BOT]);
    expect(result?.msgTime).toBe(1_700_000_000_000);
  });

  it("兼容 CQ 字符串并剥离 CQ 码", () => {
    const result = normalizeMessageEvent(
      groupEvent(`[CQ:at,qq=${BOT}] [CQ:image,file=a.jpg] 周五前提交`),
      BOT,
    );

    expect(result?.text).toBe("周五前提交");
    expect(result?.isAtBot).toBe(true);
  });

  it("忽略机器人自己的消息与非群消息", () => {
    expect(normalizeMessageEvent({ ...groupEvent("hi"), user_id: 3754609823 }, BOT)).toBeNull();
    expect(
      normalizeMessageEvent({ ...groupEvent("hi"), message_type: "private" }, BOT),
    ).toBeNull();
  });
});

describe("normalizePrivateMessage", () => {
  it("提取私聊文本并忽略机器人自身", () => {
    const event = {
      post_type: "message",
      message_type: "private",
      user_id: 3874095145,
      time: 1_700_000_000,
      sender: { nickname: "无冕" },
      message: [{ type: "text", data: { text: " 在吗 " } }],
    };
    const result = normalizePrivateMessage(event, BOT);
    expect(result?.text).toBe("在吗");
    expect(result?.senderQq).toBe("3874095145");
    expect(normalizePrivateMessage({ ...event, user_id: 3754609823 }, BOT)).toBeNull();
  });
});
