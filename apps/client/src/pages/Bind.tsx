import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { BindStartResponse } from "@autonotice/shared";
import { useAuthStore } from "../stores/auth";
import { api } from "../services/api";
import { formatDateTime } from "../utils/date";
import { copyText } from "../utils/clipboard";
import { CopyIcon, LinkIcon } from "../components/Icons";

export function BindPage() {
  const bound = useAuthStore((state) => state.bound);
  const setBound = useAuthStore((state) => state.setBound);

  const [qq, setQq] = useState(bound?.qq ?? "");
  const [ticket, setTicket] = useState<BindStartResponse | null>(null);
  const [code, setCode] = useState("");
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rebinding, setRebinding] = useState(false);
  const [justBound, setJustBound] = useState(false);

  const showBoundCard = bound !== null && !rebinding;
  const currentStep = showBoundCard ? 3 : ticket ? 2 : 1;

  // 群内发码会先自动确认并消费绑定码；轮询状态，避免网页再点确认时误报「绑定码失效」。
  useEffect(() => {
    if (!ticket) {
      return;
    }
    let stopped = false;
    const timer = window.setInterval(() => {
      void api
        .bindStatus()
        .then((status) => {
          if (stopped || !status.bound || !status.qq || !status.verifiedAt) {
            return;
          }
          stopped = true;
          window.clearInterval(timer);
          setBound({ qq: status.qq, verifiedAt: status.verifiedAt });
          setTicket(null);
          setRebinding(false);
          setJustBound(true);
          setError(null);
        })
        .catch(() => undefined);
    }, 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [ticket, setBound]);

  const handleStart = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = qq.trim();
    if (!/^\d{5,12}$/.test(value)) {
      setError("请输入 5-12 位数字 QQ 号");
      return;
    }

    setStarting(true);
    setError(null);
    try {
      const result = await api.startBind({ qq: value });
      setTicket(result);
      setCode(result.code);
      setCopied(false);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "获取绑定码失败，请稍后重试");
    } finally {
      setStarting(false);
    }
  };

  const handleConfirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = code.trim();
    if (!/^\d{6}$/.test(value)) {
      setError("请输入 6 位数字绑定码");
      return;
    }

    setConfirming(true);
    setError(null);
    try {
      const result = await api.confirmBind({ code: value });
      setBound({ qq: result.qq, verifiedAt: result.verifiedAt });
      setTicket(null);
      setRebinding(false);
      setJustBound(true);
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "确认绑定失败，请检查绑定码");
    } finally {
      setConfirming(false);
    }
  };

  const copyCode = async () => {
    if (!ticket) {
      return;
    }
    const ok = await copyText(ticket.code);
    if (!ok) {
      setError("复制失败，请手动选择绑定码");
      return;
    }
    setCopied(true);
  };

  const startRebind = () => {
    setRebinding(true);
    setTicket(null);
    setCode("");
    setError(null);
    setJustBound(false);
    setQq(bound?.qq ?? "");
  };

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">CONNECT</p>
          <h1>绑定 QQ</h1>
          <p className="page-subtitle">用你的大号在群里发一次绑定码，机器人才能识别你的消息。</p>
        </div>
      </header>

      <section className="panel bind-panel">
        <ol className="steps" aria-label="绑定进度">
          <li className={`step${currentStep === 1 ? " is-active" : ""}`}>
            <span className="step__num">1</span>
            填写大号 QQ
          </li>
          <li className={`step${currentStep === 2 ? " is-active" : ""}`}>
            <span className="step__num">2</span>
            群内发送绑定码
          </li>
          <li className={`step${currentStep === 3 ? " is-active" : ""}`}>
            <span className="step__num">3</span>
            完成绑定
          </li>
        </ol>

        {showBoundCard ? (
          <>
            {justBound ? (
              <p className="notice notice--success" role="status">
                绑定成功。之后的群消息会开始生成你的日程。
              </p>
            ) : null}
            <div className="bind-state">
              <div className="bind-state__main">
                <span className="status-dot" aria-hidden="true" />
                <div>
                  <strong>已绑定 QQ {bound.qq}</strong>
                  <span>确认于 {formatDateTime(bound.verifiedAt)}</span>
                </div>
              </div>
              <button type="button" className="btn btn--ghost btn--sm" onClick={startRebind}>
                重新绑定
              </button>
            </div>
            <div className="bind-actions">
              <Link className="btn btn--primary" to="/schedule">
                进入日程
              </Link>
            </div>
            <p className="panel-note">
              绑定关系保存在服务器，换设备登录同一账号会自动同步，无需重新绑定。
            </p>
          </>
        ) : (
          <>
            <div className="panel-head">
              <h2>{ticket ? "在群里发送绑定码" : "绑定大号 QQ"}</h2>
              <p>
                {ticket
                  ? "机器人收到群内消息后会自动确认；若没有反应，也可以在下方手动确认。"
                  : "填写你自己的 QQ 号，不是机器人账号。"}
              </p>
            </div>

            {!ticket ? (
              <form className="form" onSubmit={handleStart} aria-busy={starting}>
                <div className="field">
                  <label htmlFor="bind-qq">大号 QQ</label>
                  <input
                    id="bind-qq"
                    value={qq}
                    onChange={(event) => setQq(event.target.value)}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={12}
                    placeholder="例如 123456789"
                    autoComplete="off"
                  />
                  <span className="field__hint">5-12 位数字，必须与群内发码的账号一致。</span>
                </div>

                {error ? (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                ) : null}

                <button type="submit" className="btn btn--primary" disabled={starting}>
                  {starting ? <span className="spinner" aria-hidden="true" /> : <LinkIcon />}
                  {starting ? "生成中…" : "获取绑定码"}
                </button>
              </form>
            ) : (
              <>
                <div className="bind-code">
                  <div>
                    <span className="bind-code__label">你的 6 位绑定码</span>
                    <strong>{ticket.code}</strong>
                  </div>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={copyCode}>
                    <CopyIcon />
                    {copied ? "已复制" : "复制"}
                  </button>
                </div>

                <dl className="bind-details">
                  <div>
                    <dt>目标群号</dt>
                    <dd>{ticket.groupId}</dd>
                  </div>
                  <div>
                    <dt>有效期至</dt>
                    <dd>{formatDateTime(ticket.expiresAt)}</dd>
                  </div>
                </dl>

                <p className="bind-instruction">{ticket.instruction}</p>

                <form className="confirm-row" onSubmit={handleConfirm} aria-busy={confirming}>
                  <div className="field">
                    <label htmlFor="bind-code">手动确认绑定码</label>
                    <input
                      id="bind-code"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={6}
                      placeholder="输入 6 位数字"
                      autoComplete="one-time-code"
                    />
                  </div>
                  <button type="submit" className="btn btn--primary" disabled={confirming}>
                    {confirming ? <span className="spinner" aria-hidden="true" /> : null}
                    {confirming ? "确认中…" : "确认绑定"}
                  </button>
                </form>

                <div className="bind-actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      setTicket(null);
                      setError(null);
                    }}
                  >
                    返回修改 QQ
                  </button>
                </div>
              </>
            )}

            {ticket && error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
