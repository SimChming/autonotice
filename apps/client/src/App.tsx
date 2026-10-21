import { useEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AlertsPage } from "./pages/Alerts";
import { BindPage } from "./pages/Bind";
import { LoginPage } from "./pages/Login";
import { SchedulePage } from "./pages/Schedule";
import { SettingsPage } from "./pages/Settings";
import { UNAUTHORIZED_EVENT } from "./services/api";
import { useAuthStore } from "./stores/auth";

function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAuthStore((state) => state.token);
  return token ? <>{children}</> : <Navigate to="/login" replace />;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const token = useAuthStore((state) => state.token);
  return token ? <Navigate to="/schedule" replace /> : <>{children}</>;
}

function RootRedirect() {
  const token = useAuthStore((state) => state.token);
  return <Navigate to={token ? "/schedule" : "/login"} replace />;
}

export function App() {
  const logout = useAuthStore((state) => state.logout);

  useEffect(() => {
    // API 401 与 WS 鉴权失败共用同一个事件，避免各页面重复处理。
    const handleUnauthorized = () => logout();
    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
  }, [logout]);

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={
            <PublicOnly>
              <LoginPage />
            </PublicOnly>
          }
        />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/schedule" replace />} />
          <Route path="schedule" element={<SchedulePage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="bind" element={<BindPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<RootRedirect />} />
      </Routes>
    </BrowserRouter>
  );
}
