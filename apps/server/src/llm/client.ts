import type { Config } from "../config.js";

export interface LlmMessage {
  role: "system" | "user";
  content: string;
}

export interface LlmClient {
  /** 调用 JSON 模式；prompt 必须包含 "json" 关键词（DashScope 硬要求）。 */
  chatJson(messages: LlmMessage[]): Promise<string>;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export function createLlmClient(config: Config): LlmClient {
  const endpoint = `${config.llm.baseUrl.replace(/\/$/, "")}/chat/completions`;

  return {
    async chatJson(messages) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.llm.apiKey}`,
        },
        body: JSON.stringify({
          model: config.llm.model,
          messages,
          temperature: 0.2,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(90_000),
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`LLM 调用失败 ${response.status}: ${detail.slice(0, 300)}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("LLM 返回缺少 content");
      }
      return content;
    },
  };
}
