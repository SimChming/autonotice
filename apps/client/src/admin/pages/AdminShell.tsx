import { useEffect, useRef, useState, type FormEvent } from "react";
import { useOutletContext } from "react-router-dom";
import { AdminNotice, AdminPageHead } from "../AdminKit";
import type { AdminOutletContext } from "../AdminLayout";
import { adminApi, adminErrorMessage } from "../api";

interface ShellEntry {
  id: number;
  command: string;
  output: string;
  ok: boolean;
}

const QUICK_COMMANDS = [
  "docker ps --format 'table {{.Names}}\\t{{.Status}}'",
  "docker logs --tail 80 autonotice-napcat",
  "docker logs --tail 80 autonotice-server",
  "docker restart autonotice-napcat",
  "cd /opt/autonotice && bash deploy.sh",
  "df -h",
];

/** 后台 Shell：在服务端容器内执行命令，命令会写入审计表。 */
export function AdminShellPage() {
  const { notify } = useOutletContext<AdminOutletContext>();
  const [command, setCommand] = useState("");
  const [entries, setEntries] = useState<ShellEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [entries]);

  const run = async (raw: string) => {
    const value = raw.trim();
    if (!value || running) {
      return;
    }
    setRunning(true);
    setError(null);
    sequence.current += 1;
    const id = sequence.current;
    setEntries((current) => [...current, { id, command: value, output: "执行中…", ok: true }]);
    try {
      const result = await adminApi.runShell(value);
      setEntries((current) =>
        current.map((entry) =>
          entry.id === id ? { ...entry, output: result.output, ok: result.ok } : entry,
        ),
      );
    } catch (runError) {
      setError(adminErrorMessage(runError));
      setEntries((current) =>
        current.map((entry) =>
          entry.id === id ? { ...entry, output: "命令未执行", ok: false } : entry,
        ),
      );
    } finally {
      setRunning(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = command;
    setCommand("");
    void run(value);
  };

  const clear = () => {
    setEntries([]);
    notify("已清空输出", "命令记录仍保留在服务器审计表");
  };

  return (
    <>
      <AdminPageHead
        eyebrow="ADMIN SHELL"
        title="服务器 Shell"
        subtitle="命令在 autonotice-server 容器内执行（60 秒超时）；容器已挂载 docker 与 /opt/autonotice，可直接做容器运维。"
        actions={
          <button type="button" className="btn btn--ghost btn--sm" onClick={clear} disabled={running}>
            清空输出
          </button>
        }
      />

      {error ? <AdminNotice>{error}</AdminNotice> : null}

      <section className="panel admin-shell" aria-label="管理员 Shell">
        <div className="admin-shell__quick">
          {QUICK_COMMANDS.map((item) => (
            <button
              key={item}
              type="button"
              className="admin-shell__chip"
              onClick={() => {
                setCommand(item);
                void run(item);
              }}
              disabled={running}
            >
              {item}
            </button>
          ))}
        </div>

        <div className="admin-shell__log" ref={logRef} role="log" aria-live="polite">
          {entries.length === 0 ? (
            <p className="admin-shell__empty">
              输入命令后按 Enter 执行。常用命令可点击上方快捷按钮。
            </p>
          ) : (
            entries.map((entry) => (
              <div key={entry.id} className="admin-shell__entry">
                <div className="admin-shell__cmd">
                  <span className="admin-shell__prompt">$</span>
                  {entry.command}
                </div>
                <pre className={`admin-shell__out${entry.ok ? "" : " is-error"}`}>{entry.output}</pre>
              </div>
            ))
          )}
        </div>

        <form className="admin-shell__form" onSubmit={handleSubmit}>
          <span className="admin-shell__prompt" aria-hidden="true">
            $
          </span>
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="例如 docker ps 或 ls /opt/autonotice"
            autoComplete="off"
            spellCheck={false}
            aria-label="Shell 命令"
          />
          <button type="submit" className="btn btn--primary btn--sm" disabled={running || !command.trim()}>
            {running ? <span className="spinner" aria-hidden="true" /> : null}
            {running ? "执行中" : "执行"}
          </button>
        </form>
      </section>
    </>
  );
}
