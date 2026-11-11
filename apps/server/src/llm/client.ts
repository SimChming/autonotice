export interface LlmRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** V4.4.4：采样温度（默认 0.85，允许她说话有起伏）。 */
  temperature?: number;
  maxTokens?: number;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClient {
  /** 调用 JSON 模式；prompt 必须包含 "json" 关键词（DashScope 硬要求）。 */
  chatJson(messages: LlmMessage[]): Promise<string>;
}

interface ChatCompletionMessage {
  content?: string;
  /** qwen3 思考模式下正文可能为空，思考内容在这里。 */
  reasoning_content?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: ChatCompletionMessage }>;
}

/** 从思考内容里尽量捞出一个 JSON 对象。 */
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : "";
}

export function createLlmClient(getConfig: () => LlmRuntimeConfig): LlmClient {
  return {
    async chatJson(messages) {
      const config = getConfig();
      const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

      const call = async (disableThinking: boolean) => {
        const body: Record<string, unknown> = {
          model: config.model,
          messages,
          temperature: config.temperature ?? 0.85,
          max_tokens: config.maxTokens ?? 2400,
          response_format: { type: "json_object" },
        };
        // qwen3 系列默认会先输出思考链，JSON 模式下会把 content 挤空。
        if (disableThinking) {
          body.enable_thinking = false;
        }
        return fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
      };

      let response = await call(true);
      if (response.status === 400) {
        const detail = await response.text();
        // 某些模型不认 enable_thinking：去掉该参数重试一次。
        if (detail.includes("enable_thinking")) {
          response = await call(false);
        } else {
          throw new Error(`LLM 调用失败 400: ${detail.slice(0, 300)}`);
        }
      }
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`LLM 调用失败 ${response.status}: ${detail.slice(0, 300)}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const message = data.choices?.[0]?.message;
      let content = typeof message?.content === "string" ? message.content.trim() : "";
      if (!content && message?.reasoning_content) {
        content = extractJson(message.reasoning_content);
      }
      if (!content) {
        throw new Error("LLM 返回缺少 content");
      }
      return content;
    },
  };
}
