import { create } from "zustand";
import type {
  AuthResponse,
  LoginRequest,
  RegisterRequest,
} from "@autonotice/shared";
import { api, getStoredToken, storeToken } from "../services/api";
import { useScheduleStore } from "./schedule";

const USER_KEY = "autonotice_user";
const BIND_KEY = "autonotice_bind";

export type AuthUser = AuthResponse["user"];

export interface BindRecord {
  qq: string;
  verifiedAt: string;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  bound: BindRecord | null;
  login: (input: LoginRequest) => Promise<void>;
  register: (input: RegisterRequest) => Promise<void>;
  logout: () => void;
  setBound: (record: BindRecord) => void;
  clearBound: () => void;
}

function storage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readUser(): AuthUser | null {
  try {
    const raw = storage()?.getItem(USER_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.id === "number" && typeof record.username === "string") {
      return { id: record.id, username: record.username };
    }
    return null;
  } catch {
    return null;
  }
}

/** 绑定记录带上 userId，换账号登录时不会误读上一个人的绑定状态。 */
function readBind(userId: number): BindRecord | null {
  try {
    const raw = storage()?.getItem(BIND_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.userId === userId &&
      typeof record.qq === "string" &&
      typeof record.verifiedAt === "string"
    ) {
      return { qq: record.qq, verifiedAt: record.verifiedAt };
    }
    return null;
  } catch {
    return null;
  }
}

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(normalized + padding);
}

/** token 里带有 sub/username，刷新页面时即使 user 缓存丢失也能恢复账号信息。 */
function userFromToken(token: string): AuthUser | null {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) {
      return null;
    }
    const payload: unknown = JSON.parse(decodeBase64Url(payloadPart));
    if (typeof payload !== "object" || payload === null) {
      return null;
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.sub === "number" && typeof record.username === "string") {
      return { id: record.sub, username: record.username };
    }
    return null;
  } catch {
    return null;
  }
}

function writeUser(user: AuthUser | null): void {
  const target = storage();
  if (!target) {
    return;
  }
  try {
    if (user) {
      target.setItem(USER_KEY, JSON.stringify(user));
    } else {
      target.removeItem(USER_KEY);
    }
  } catch {
    // 忽略存储不可写的情况。
  }
}

function writeBind(bind: BindRecord, userId: number): void {
  const target = storage();
  if (!target) {
    return;
  }
  try {
    target.setItem(BIND_KEY, JSON.stringify({ ...bind, userId }));
  } catch {
    // 忽略存储不可写的情况。
  }
}

function removeBind(): void {
  try {
    storage()?.removeItem(BIND_KEY);
  } catch {
    // 忽略存储不可写的情况。
  }
}

const initialToken = getStoredToken();
const initialUser = initialToken ? readUser() ?? userFromToken(initialToken) : null;
const initialBind = initialToken && initialUser ? readBind(initialUser.id) : null;

export const useAuthStore = create<AuthState>()((set, get) => ({
  token: initialToken,
  user: initialUser,
  bound: initialBind,

  login: async (input) => {
    const response = await api.login(input);
    storeToken(response.token);
    writeUser(response.user);
    set({
      token: response.token,
      user: response.user,
      bound: readBind(response.user.id),
    });
  },

  register: async (input) => {
    const response = await api.register(input);
    storeToken(response.token);
    writeUser(response.user);
    set({
      token: response.token,
      user: response.user,
      bound: readBind(response.user.id),
    });
  },

  logout: () => {
    storeToken(null);
    writeUser(null);
    useScheduleStore.getState().reset();
    // 保留绑定记录供本账号下次登录识别，换账号时靠 userId 校验隔离。
    set({ token: null, user: null, bound: null });
  },

  setBound: (record) => {
    const userId = get().user?.id;
    if (userId !== undefined) {
      writeBind(record, userId);
    }
    set({ bound: record });
  },

  clearBound: () => {
    removeBind();
    set({ bound: null });
  },
}));
