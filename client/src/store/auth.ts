import { create } from 'zustand'

import type { Binding, User } from '../types'
import { KEYS, getJSON, getRaw, removeRaw, setJSON, setRaw } from '../utils/storage'

export interface Privileges {
  isOwner: boolean
  controlQQ: string
}

interface AuthState {
  token: string | null
  user: User | null
  bindings: Binding[]
  privileges: Privileges
  hydrate: () => void
  setAuth: (token: string, user: User) => void
  setBindings: (bindings: Binding[]) => void
  loadPrivileges: () => Promise<void>
  logout: () => void
}

const NO_PRIVILEGES: Privileges = { isOwner: false, controlQQ: '' }

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  user: null,
  bindings: [],
  privileges: NO_PRIVILEGES,

  hydrate: () => {
    set({
      token: getRaw(KEYS.token),
      user: getJSON<User | null>(KEYS.user, null),
      bindings: getJSON<Binding[]>(KEYS.bindings, [])
    })
  },

  setAuth: (token, user) => {
    setRaw(KEYS.token, token)
    setJSON(KEYS.user, user)
    set({ token, user })
  },

  setBindings: (bindings) => {
    setJSON(KEYS.bindings, bindings)
    set({ bindings })
  },

  /** 服务端判定当前账号是否为主人（绑定主人 QQ），决定是否显示后台入口 */
  loadPrivileges: async () => {
    if (!get().token) {
      set({ privileges: NO_PRIVILEGES })
      return
    }
    try {
      // 惰性 import，避免与 services/api 形成循环依赖
      const { api } = await import('../services/api')
      const res = await api.myPrivileges()
      set({ privileges: { isOwner: Boolean(res.is_owner), controlQQ: res.control_qq || '' } })
    } catch {
      /* 网络异常时保持未授权，入口隐藏即可 */
    }
  },

  logout: () => {
    removeRaw(KEYS.token)
    removeRaw(KEYS.user)
    removeRaw(KEYS.bindings)
    set({ token: null, user: null, bindings: [], privileges: NO_PRIVILEGES })
  }
}))

/** 记住的账号密码（明文存本地，仅用于自动登录；登录页「记住账号密码」开关控制） */
export interface SavedCredentials {
  username: string
  password: string
}

export function saveCredentials(username: string, password: string): void {
  if (!username || !password) return
  setJSON(KEYS.credentials, { username, password } satisfies SavedCredentials)
}

export function loadCredentials(): SavedCredentials | null {
  const cred = getJSON<SavedCredentials | null>(KEYS.credentials, null)
  if (!cred || !cred.username || !cred.password) return null
  return { username: cred.username, password: cred.password }
}

export function clearCredentials(): void {
  removeRaw(KEYS.credentials)
}

/**
 * 静默重登：用本地保存的凭据换取新 token。
 * 惰性 import api，避免与 services/api 形成循环依赖。失败返回 false，不抛错。
 */
export async function silentRelogin(): Promise<boolean> {
  const cred = loadCredentials()
  if (!cred) return false
  try {
    const { api } = await import('../services/api')
    const res = await api.login(cred.username, cred.password)
    if (!res?.token || !res.user) return false
    useAuthStore.getState().setAuth(res.token, res.user)
    return true
  } catch {
    return false
  }
}

/** 供非 React 环境（服务层）读取 */
export function getToken(): string | null {
  return useAuthStore.getState().token || getRaw(KEYS.token)
}

export function isLoggedIn(): boolean {
  return Boolean(getToken())
}

useAuthStore.getState().hydrate()
