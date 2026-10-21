import { create } from 'zustand'

import { AdminApiError, adminApi, api } from '../services/api'
import type {
  AdminAuditEntry,
  AdminDocFile,
  AdminOwner,
  AdminSettings,
  AdminStatus,
  AdminUser,
  BotRole,
  BotUser
} from '../types'
import { KEYS, getJSON, getRaw, removeRaw, setJSON, setRaw } from '../utils/storage'

interface AdminState {
  token: string | null
  admin: AdminUser | null
  settings: AdminSettings | null
  status: AdminStatus | null
  owners: AdminOwner[]
  botUsers: BotUser[]
  controlQQ: string
  docs: AdminDocFile[]
  audit: AdminAuditEntry[]
  loading: boolean

  hydrate: () => void
  login: (username: string, password: string) => Promise<void>
  loginWithOwner: () => Promise<void>
  logout: () => void
  refresh: () => Promise<void>
  saveSettings: (patch: Record<string, unknown>) => Promise<void>
  addOwner: (qq: string, note: string) => Promise<void>
  deleteOwner: (qq: string) => Promise<void>
  saveBotUser: (qq: string, role: BotRole, note: string) => Promise<void>
  deleteBotUser: (qq: string) => Promise<void>
  testLLM: () => Promise<string>
  resendDoc: (id: string) => Promise<void>
}

function isAuthed(): boolean {
  return Boolean(getRaw(KEYS.adminToken))
}

export const useAdminStore = create<AdminState>((set, get) => ({
  token: null,
  admin: null,
  settings: null,
  status: null,
  owners: [],
  botUsers: [],
  controlQQ: '',
  docs: [],
  audit: [],
  loading: false,

  hydrate: () => {
    const token = getRaw(KEYS.adminToken)
    set({ token, admin: getJSON<AdminUser | null>(KEYS.adminUser, null) })
  },

  login: async (username, password) => {
    const res = await adminApi.login(username, password)
    setRaw(KEYS.adminToken, res.token)
    setJSON(KEYS.adminUser, res.admin)
    set({ token: res.token, admin: res.admin })
    await get().refresh()
  },

  /** 主人免密进入：服务端校验「已绑定主人 QQ」后直接签发后台 token */
  loginWithOwner: async () => {
    const res = await api.ownerSSO()
    setRaw(KEYS.adminToken, res.token)
    setJSON(KEYS.adminUser, res.admin)
    set({ token: res.token, admin: res.admin })
    await get().refresh()
  },

  logout: () => {
    removeRaw(KEYS.adminToken)
    removeRaw(KEYS.adminUser)
    set({
      token: null,
      admin: null,
      settings: null,
      status: null,
      owners: [],
      botUsers: [],
      controlQQ: '',
      docs: [],
      audit: []
    })
  },

  refresh: async () => {
    if (!isAuthed()) return
    set({ loading: true })
    try {
      const [settings, ownerList, botUsers, status, docRes, auditRes] = await Promise.all([
        adminApi.getSettings(),
        adminApi.listOwners(),
        adminApi.listBotUsers(),
        adminApi.status(),
        adminApi.docFiles(50),
        adminApi.audit(50)
      ])
      set({
        settings,
        owners: ownerList.owners || [],
        botUsers: botUsers.users || [],
        controlQQ: botUsers.control_qq || ownerList.control_qq || settings.control_qq,
        status,
        docs: docRes.files || [],
        audit: auditRes.audit || []
      })
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) get().logout()
      throw err
    } finally {
      set({ loading: false })
    }
  },

  saveSettings: async (patch) => {
    const settings = await adminApi.updateSettings(patch)
    set({ settings })
  },

  addOwner: async (qq, note) => {
    const res = await adminApi.addOwner(qq, note)
    set({ owners: res.owners || [], controlQQ: res.control_qq })
  },

  deleteOwner: async (qq) => {
    const res = await adminApi.deleteOwner(qq)
    set({ owners: res.owners || [], controlQQ: res.control_qq })
  },

  saveBotUser: async (qq, role, note) => {
    const res = await adminApi.upsertBotUser(qq, role, note)
    set({ botUsers: res.users || [], controlQQ: res.control_qq })
  },

  deleteBotUser: async (qq) => {
    const res = await adminApi.deleteBotUser(qq)
    set({ botUsers: res.users || [], controlQQ: res.control_qq })
  },

  testLLM: async () => {
    const res = await adminApi.testLLM()
    return res.reply
  },

  resendDoc: async (id) => {
    await adminApi.resendDoc(id)
  }
}))

useAdminStore.getState().hydrate()
