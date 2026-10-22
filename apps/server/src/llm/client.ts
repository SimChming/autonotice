export interface LlmRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClient {
  /** 调用 JSON 模式；prompt 必须包含 "json" 关键词（DashScope 硬要求）。 */
  chatJson(messages: LlmMessage[]): Promise<string>;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export function createLlmClient(getConfig: () => LlmRuntimeConfig): LlmClient {
  return {
    async chatJson(messages) {
      const config = getConfig();
      const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
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
