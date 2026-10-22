import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useOutletContext } from "react-router-dom";
import { WhaleMark } from "../../components/Icons";
import { formatDateTime } from "../../utils/date";
import { AdminNotice, AdminPageHead } from "../AdminKit";
import type { AdminOutletContext } from "../AdminLayout";
import {
  ADMIN_UNAUTHORIZED_EVENT,
  adminApi,
  adminErrorMessage,
  buildAdminChatSocketUrl,
  getAdminToken,
  parseAdminChatMessage,
  setAdminToken,
  type AdminChatHistoryItem,
} from "../api";

type ChatStatus = "connecting" | "online" | "reconnecting";

const STATUS_LABELS: Record<ChatStatus, string> = {
  connecting: "连接中…",
  online: "已连接",
  reconnecting: "重连中…",
};

/** 乐观气泡与 WS 回推的近似去重窗口。 */
const DEDUPE_WINDOW_MS = 10_000;

interface ChatItem extends AdminChatHistoryItem {
  key: string;
  local?: boolean;
}

function sameMessage(left: AdminChatHistoryItem, right: AdminChatHistoryItem): boolean {
  if (left.role !== right.role || left.text !== right.text) {
    return false;
  }
  const leftTime = Date.parse(left.at);
  const rightTime = Date.parse(right.at);
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    return left.at === right.at;
  }
  return Math.abs(leftTime - rightTime) <= DEDUPE_WINDOW_MS;
}

function sortByTime(items: ChatItem[]): ChatItem[] {
  return [...items].sort((left, right) => {
    const leftTime = Date.parse(left.at);
    const rightTime = Date.parse(right.at);
    return (Number.isNaN(leftTime) ? 0 : leftTime) - (Number.isNaN(rightTime) ? 0 : rightTime);
  });
}

function mergeItems(base: ChatItem[], extra: ChatItem[]): ChatItem[] {
  const merged = [...base];
  for (const item of extra) {
    const index = merged.findIndex(
      (existing) => existing.key !== item.key && sameMessage(existing, item),
    );
    const existing = index >= 0 ? merged[index] : undefined;
    if (!existing) {
      merged.push(item);
    } else if (existing.local && !item.local) {
      // 服务端回推的真实消息优先于本地乐观气泡。
      merged[index] = item;
    }
  }
  return sortByTime(merged);
}

export function AdminChatPage() {
  const { notify } = useOutletContext<AdminOutletContext>();

  const [items, setItems] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [status, setStatus] = useState<ChatStatus>("connecting");

  const logRef = useRef<HTMLDivElement>(null);
  const liveSequence = useRef(0);

  const scrollToBottom = useCallback(() => {
    const log = logRef.current;
    if (log) {
      log.scrollTop = log.scrollHeight;
    }
  }, []);

  const handleUnauthorized = useCallback(() => {
    setAdminToken(null);
    window.dispatchEvent(new Event(ADMIN_UNAUTHORIZED_EVENT));
  }, []);

  const appendIncoming = useCallback((message: AdminChatHistoryItem) => {
    liveSequence.current += 1;
    const incoming: ChatItem = {
      ...message,
      key: `live-${liveSequence.current}-${message.at}`,
    };
    setItems((current) => {
      const duplicate = current.find((item) => sameMessage(item, incoming));
      if (!duplicate) {
        return sortByTime([...current, incoming]);
      }
      if (duplicate.local) {
        return current.map((item) => (item.key === duplicate.key ? incoming : item));
      }
      return current;
    });
  }, []);

  // 读取最近 100 条历史；与 WS 先行到达的消息合并去重。
  useEffect(() => {
    let cancelled = false;

    const loadHistory = async () => {
      try {
        const history = await adminApi.chatHistory(100);
        if (cancelled) {
          return;
        }
        const historyItems: ChatItem[] = history.map((item, index) => ({
          ...item,
          key: `history-${index}-${item.at}`,
        }));
        setItems((current) => mergeItems(historyItems, current));
        setHistoryError(null);
      } catch (loadError) {
        if (!cancelled) {
          setHistoryError(adminErrorMessage(loadError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, []);

  // WebSocket 实时通道：1s 起步指数退避，最长 15s；鉴权失败直接回登录页。
  useEffect(() => {
    const token = getAdminToken();
    if (!token) {
      handleUnauthorized();
      return;
    }

    let stopped = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let attempts = 0;
    let hasConnected = false;

    const connect = () => {
      if (stopped) {
        return;
      }
      setStatus(hasConnected ? "reconnecting" : "connecting");
      socket = new WebSocket(buildAdminChatSocketUrl(token));

      socket.addEventListener("open", () => {
        // 等待服务端 ready 再标记为已连接。
      });

      socket.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data !== "string") {
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (typeof payload !== "object" || payload === null) {
          return;
        }
        const record = payload as Record<string, unknown>;
        if (record.type === "ready") {
          attempts = 0;
          hasConnected = true;
          setStatus("online");
          return;
        }
        if (record.type === "chat") {
          const message = parseAdminChatMessage(record);
          if (message) {
            appendIncoming(message);
          }
        }
      });

      socket.addEventListener("close", (event: CloseEvent) => {
        if (stopped) {
          return;
        }
        if (event.code === 1008 || event.code === 4401 || event.code === 4403) {
          handleUnauthorized();
          return;
        }
        attempts += 1;
        setStatus("reconnecting");
        const delay = Math.min(1000 * 2 ** Math.min(attempts - 1, 4), 15_000);
        retryTimer = window.setTimeout(connect, delay);
      });

      socket.addEventListener("error", () => {
        socket?.close();
      });
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
      socket?.close();
    };
  }, [appendIncoming, handleUnauthorized]);

  useEffect(() => {
    scrollToBottom();
  }, [items.length, scrollToBottom]);

  const send = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) {
      return;
    }

    liveSequence.current += 1;
    const optimistic: ChatItem = {
      key: `local-${liveSequence.current}`,
      role: "user",
      text,
      qq: "",
      at: new Date().toISOString(),
      local: true,
    };

    setDraft("");
    setSending(true);
    setItems((current) => [...current, optimistic]);

    try {
      await adminApi.sendChat(text);
      // 服务端已受理：本地气泡转为正式消息，避免一直显示“发送中”。
      setItems((current) =>
        current.map((item) => (item.key === optimistic.key ? { ...item, local: false } : item)),
      );
    } catch (sendError) {
      setItems((current) => current.filter((item) => item.key !== optimistic.key));
      setDraft(text);
      notify("发送失败", adminErrorMessage(sendError), "warn");
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <>
      <AdminPageHead
        eyebrow="CHAT"
        title="AI 聊天"
        subtitle="与主人 QQ 私聊共用同一段会话历史；QQ 掉线时也能在这里继续对话。"
        actions={
          <span className={`admin-chat__status is-${status}`} role="status" aria-live="polite">
            <span className="admin-chat__status-dot" aria-hidden="true" />
            {STATUS_LABELS[status]}
          </span>
        }
      />

      {historyError ? <AdminNotice>{historyError}</AdminNotice> : null}

      <section className="admin-chat" aria-label="与鲸鱼娘聊天">
        <div
          className="admin-chat__log"
          ref={logRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
        >
          {loading ? (
            <div className="admin-chat__loading">
              <span className="spinner" aria-hidden="true" />
              正在读取会话…
            </div>
          ) : null}

          {!loading && items.length === 0 ? (
            <div className="admin-chat__empty">
              <span className="admin-chat__empty-mark" aria-hidden="true">
                <WhaleMark />
              </span>
              <strong>和鲸鱼娘说点什么</strong>
              <p>这里会同步显示主人 QQ 私聊与后台发送的消息。</p>
            </div>
          ) : null}

          {items.map((item) => {
            const assistant = item.role === "assistant";
            return (
              <div
                key={item.key}
                className={`admin-chat__row${assistant ? " is-assistant" : " is-user"}${
                  item.local ? " is-pending" : ""
                }`}
              >
                <span
                  className={`admin-chat__avatar${assistant ? "" : " admin-chat__avatar--user"}`}
                  aria-hidden="true"
                >
                  {assistant ? <WhaleMark /> : "我"}
                </span>
                <div className="admin-chat__bubble-wrap">
                  <div className="admin-chat__bubble">{item.text}</div>
                  <span className="admin-chat__time">
                    {formatDateTime(item.at)}
                    {item.local ? " · 发送中" : ""}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <form className="admin-chat__composer" onSubmit={(event) => void send(event)}>
          <textarea
            className="admin-chat__input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="和鲸鱼娘说点什么…（Enter 发送，Shift+Enter 换行）"
            aria-label="聊天消息"
            rows={2}
            maxLength={2000}
          />
          <button
            type="submit"
            className="btn btn--primary admin-chat__send"
            disabled={sending || !draft.trim()}
          >
            {sending ? <span className="spinner" aria-hidden="true" /> : null}
            {sending ? "发送中" : "发送"}
          </button>
        </form>
      </section>
    </>
  );
}
