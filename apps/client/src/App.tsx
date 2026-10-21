import { useEffect, useState } from "react";
import { healthResponseSchema, SERVICE_VERSION, type HealthResponse } from "@autonotice/shared";

type Probe = { state: "loading" } | { state: "ok"; data: HealthResponse } | { state: "error"; message: string };

export function App() {
  const [probe, setProbe] = useState<Probe>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        // API 一律同源相对路径（§9-坑12）
        const response = await fetch("/api/v1/healthz");
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = healthResponseSchema.parse(await response.json());
        if (!cancelled) {
          setProbe({ state: "ok", data });
        }
      } catch (error) {
        if (!cancelled) {
          setProbe({ state: "error", message: error instanceof Error ? error.message : String(error) });
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="shell">
      <section className="card">
        <p className="eyebrow">AUTONOTICE</p>
        <h1>v2 骨架就位</h1>
        <p className="subtitle">群消息 → 日程 → 多端强提醒。当前阶段：Phase 2 基础设施。</p>

        <dl className="facts">
          <div>
            <dt>客户端版本</dt>
            <dd>{SERVICE_VERSION}</dd>
          </div>
          <div>
            <dt>服务端状态</dt>
            <dd className={`status status--${probe.state}`}>
              {probe.state === "loading" && "探测中…"}
              {probe.state === "ok" && `在线 · v${probe.data.version}`}
              {probe.state === "error" && `不可用 · ${probe.message}`}
            </dd>
          </div>
          {probe.state === "ok" && (
            <div>
              <dt>运行时长</dt>
              <dd>{Math.floor(probe.data.uptime)} 秒</dd>
            </div>
          )}
        </dl>
      </section>
    </main>
  );
}
