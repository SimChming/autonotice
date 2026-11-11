import { BrowserRouter, HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { isNativeShell } from "./services/api";
import { AdminRoot } from "./admin/AdminRoot";
import { AdminChatPage } from "./admin/pages/AdminChat";
import { AdminModelsPage } from "./admin/pages/AdminModels";
import { AdminOpsPage } from "./admin/pages/AdminOps";
import { AdminOverviewPage } from "./admin/pages/AdminOverview";
import { AdminPromptPage } from "./admin/pages/AdminPrompt";
import { AdminShellPage } from "./admin/pages/AdminShell";
import { AdminSkillsPage } from "./admin/pages/AdminSkills";
import { AdminUsersPage } from "./admin/pages/AdminUsers";

/**
 * V4.4.4 彩蛋版：用户端（登录/绑定/日程/提醒）全部下线，
 * 前端只保留管理后台；她的房间在服务端 /soul（独立 HTML 页面）。
 */
export function App() {
  // 原生壳（Tauri file:// / Capacitor http://localhost）用 hash 路由，避免刷新丢页。
  const Router = isNativeShell() ? HashRouter : BrowserRouter;

  return (
    <Router>
      <Routes>
        <Route path="/admin" element={<AdminRoot />}>
          <Route index element={<AdminOverviewPage />} />
          <Route path="skills" element={<AdminSkillsPage />} />
          <Route path="prompt" element={<AdminPromptPage />} />
          <Route path="models" element={<AdminModelsPage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="chat" element={<AdminChatPage />} />
          <Route path="ops" element={<AdminOpsPage />} />
          <Route path="shell" element={<AdminShellPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </Router>
  );
}
