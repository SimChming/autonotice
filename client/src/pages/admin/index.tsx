import { useEffect, useRef, useState } from 'react'
import { Input, Switch, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'

import { PageHeader } from '../../components/PageHeader'
import { errorMessage } from '../../services/api'
import { useAdminStore } from '../../store/admin'
import { useAuthStore } from '../../store/auth'
import type { AdminDocFile, AdminSettings, BotRole, Capabilities, CapabilityKey } from '../../types'
import './index.scss'

const ROLE_OPTIONS: Array<{ key: BotRole; label: string; desc: string }> = [
  { key: 'owner', label: '主人', desc: '全部权限：shell、系统偏好、任意账号操作' },
  { key: 'admin', label: '管理员', desc: '可驱动系统能力，但不能执行 shell' },
  { key: 'member', label: '成员', desc: '正常聊天 + 调用系统能力' },
  { key: 'guest', label: '访客', desc: '只能聊天，系统能力全部关闭' }
]

function roleLabel(role: BotRole): string {
  return ROLE_OPTIONS.find((r) => r.key === role)?.label || role
}

const CAP_LABELS: Array<{ key: CapabilityKey; label: string; desc: string }> = [
  { key: 'image', label: '图片', desc: '发送 / 上传图片' },
  { key: 'sticker', label: '表情包', desc: '表情、商城表情、戳一戳' },
  { key: 'voice', label: '语音', desc: '语音、录音' },
  { key: 'video', label: '视频', desc: '视频与短视频' },
  { key: 'file', label: '文件', desc: '群文件 / 私聊文件上传' },
  { key: 'recall', label: '撤回', desc: '撤回已发送消息' },
  { key: 'at_all', label: '全体成员', desc: '@全体成员' }
]

const MODEL_PRESETS: Array<{ model: string; label: string }> = [
  { model: 'qwen3.8-flash', label: '通义闪速 · 推荐' },
  { model: 'qwen-plus', label: '通义 Plus' },
  { model: 'qwen-max', label: '通义 Max' },
  { model: 'deepseek-chat', label: 'DeepSeek Chat' },
  { model: 'deepseek-reasoner', label: 'DeepSeek 思考' }
]

interface FormState {
  apiKey: string
  baseURL: string
  model: string
  thinking: boolean
  caps: Capabilities
  autoEnabled: boolean
  targets: string
  minDelay: string
  maxDelay: string
  maxSegments: string
  startIndex: string
  babbleEnabled: boolean
  babbleWindows: string
  babbleMax: string
  babbleProb: string
  babbleQuiet: string
  babbleRecent: string
  quota: string
}

function fmtTime(value?: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function fmtSize(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function chatLabel(key: string): string {
  if (key.startsWith('group:')) return `群 ${key.slice(6)}`
  if (key.startsWith('private:')) return `私聊 ${key.slice(8)}`
  return key || '—'
}

function buildForm(s: AdminSettings): FormState {
  return {
    apiKey: '',
    baseURL: s.deepseek.base_url,
    model: s.deepseek.model,
    thinking: s.deepseek.enable_thinking !== false,
    caps: { ...s.capabilities },
    autoEnabled: s.auto_segment.enabled,
    targets: (s.auto_segment.targets || ['owner']).join(', '),
    minDelay: String(s.auto_segment.min_delay_ms),
    maxDelay: String(s.auto_segment.max_delay_ms),
    maxSegments: String(s.auto_segment.max_segments),
    startIndex: String(s.auto_segment.start_index),
    babbleEnabled: s.babble?.enabled ?? true,
    babbleWindows: (s.babble?.windows || ['06:00-08:00', '11:00-13:00', '16:00-24:00']).join(', '),
    babbleMax: String(s.babble?.max_per_day ?? 3),
    babbleProb: String(s.babble?.probability ?? 12),
    babbleQuiet: String(s.babble?.quiet_minutes ?? 45),
    babbleRecent: String(s.babble?.recent_minutes ?? 30),
    quota: String(s.docs.quota_per_day)
  }
}

export default function AdminPage() {
  const token = useAdminStore((s) => s.token)
  const admin = useAdminStore((s) => s.admin)
  const settings = useAdminStore((s) => s.settings)
  const status = useAdminStore((s) => s.status)
  const owners = useAdminStore((s) => s.owners)
  const botUsers = useAdminStore((s) => s.botUsers)
  const controlQQ = useAdminStore((s) => s.controlQQ)
  const docs = useAdminStore((s) => s.docs)
  const audit = useAdminStore((s) => s.audit)
  const loading = useAdminStore((s) => s.loading)

  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const isOwner = useAuthStore((s) => s.privileges.isOwner)
  const ssoTried = useRef(false)

  // 主人账号已绑定主人 QQ：直接免密换取后台 token，不再要求输入密码
  useEffect(() => {
    if (token || ssoTried.current) return
    if (!isOwner) {
      void useAuthStore.getState().loadPrivileges()
      return
    }
    ssoTried.current = true
    useAdminStore.getState().loginWithOwner().catch(() => undefined)
  }, [token, isOwner])

  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [newQQ, setNewQQ] = useState('')
  const [newNote, setNewNote] = useState('')
  const [newRole, setNewRole] = useState<BotRole>('member')
  const [ownerBusy, setOwnerBusy] = useState(false)
  const [resending, setResending] = useState('')

  useEffect(() => {
    if (token) {
      void useAdminStore.getState().refresh().catch((err) => {
        Taro.showToast({ title: errorMessage(err), icon: 'none' })
      })
    }
  }, [token])

  useEffect(() => {
    if (settings) setForm(buildForm(settings))
  }, [settings])

  async function doLogin() {
    if (!username.trim() || !password) {
      Taro.showToast({ title: '请输入账号和密码', icon: 'none' })
      return
    }
    setAuthBusy(true)
    try {
      await useAdminStore.getState().login(username.trim(), password)
      setPassword('')
      Taro.showToast({ title: '登录成功', icon: 'success' })
    } catch (err) {
      Taro.showToast({ title: errorMessage(err), icon: 'none' })
    } finally {
      setAuthBusy(false)
    }
  }

  function logout() {
    useAdminStore.getState().logout()
    setForm(null)
    setPassword('')
  }

  function patchForm(p: Partial<FormState>) {
    setForm((prev) => (prev ? { ...prev, ...p } : prev))
  }

  function toggleCap(key: CapabilityKey, value: boolean) {
    setForm((prev) => (prev ? { ...prev, caps: { ...prev.caps, [key]: value } } : prev))
  }

  async function save() {
    if (!form) return
    setSaving(true)
    try {
      const targets = form.targets
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      await useAdminStore.getState().saveSettings({
        deepseek: {
          api_key: form.apiKey.trim(),
          base_url: form.baseURL.trim(),
          model: form.model.trim(),
          enable_thinking: form.thinking
        },
        capabilities: form.caps,
        auto_segment: {
          enabled: form.autoEnabled,
          targets: targets.length ? targets : ['owner'],
          min_delay_ms: Number(form.minDelay) || 0,
          max_delay_ms: Number(form.maxDelay) || 0,
          max_segments: Number(form.maxSegments) || 3,
          start_index: Number(form.startIndex) || 2
        },
        babble: {
          enabled: form.babbleEnabled,
          windows: form.babbleWindows
            .split(',')
            .map((w) => w.trim())
            .filter(Boolean),
          max_per_day: Number(form.babbleMax) || 3,
          probability: Number(form.babbleProb) || 12,
          quiet_minutes: Number(form.babbleQuiet) || 45,
          recent_minutes: Number(form.babbleRecent) || 30
        },
        docs: { quota_per_day: Number(form.quota) || 2 }
      })
      Taro.showToast({ title: '已保存并生效', icon: 'success' })
      patchForm({ apiKey: '' })
    } catch (err) {
      Taro.showToast({ title: errorMessage(err), icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  async function testLLM() {
    setTesting(true)
    try {
      const reply = await useAdminStore.getState().testLLM()
      Taro.showModal({ title: '连接正常', content: `模型回复：${reply || 'OK'}`, showCancel: false })
    } catch (err) {
      Taro.showModal({ title: '连接失败', content: errorMessage(err), showCancel: false })
    } finally {
      setTesting(false)
    }
  }

  async function saveBotUser() {
    if (!/^\d{5,15}$/.test(newQQ.trim())) {
      Taro.showToast({ title: '请输入正确的 QQ 号', icon: 'none' })
      return
    }
    setOwnerBusy(true)
    try {
      await useAdminStore.getState().saveBotUser(newQQ.trim(), newRole, newNote.trim())
      setNewQQ('')
      setNewNote('')
      Taro.showToast({ title: '已保存', icon: 'success' })
    } catch (err) {
      Taro.showToast({ title: errorMessage(err), icon: 'none' })
    } finally {
      setOwnerBusy(false)
    }
  }

  async function removeBotUser(qq: string) {
    const r = await Taro.showModal({ title: '移除用户', content: `确定移除 QQ ${qq} 的权限配置？` })
    if (!r.confirm) return
    setOwnerBusy(true)
    try {
      await useAdminStore.getState().deleteBotUser(qq)
      Taro.showToast({ title: '已移除', icon: 'success' })
    } catch (err) {
      Taro.showToast({ title: errorMessage(err), icon: 'none' })
    } finally {
      setOwnerBusy(false)
    }
  }

  function editBotUser(qq: string, role: BotRole, note: string) {
    setNewQQ(qq)
    setNewRole(role)
    setNewNote(note)
  }

  async function resend(file: AdminDocFile) {
    setResending(file.id)
    try {
      await useAdminStore.getState().resendDoc(file.id)
      Taro.showToast({ title: '已重新发送', icon: 'success' })
    } catch (err) {
      Taro.showToast({ title: errorMessage(err), icon: 'none' })
    } finally {
      setResending('')
    }
  }

  if (!token) {
    return (
      <View className='page-root admin'>
        <PageHeader title='管理后台' subtitle='仅限主人登录' back />
        <View className='page-scroll admin__scroll'>
          <Text className='section-title'>管理员登录</Text>
          <View className='admin__card card'>
            <View className='admin__field'>
              <Text className='admin__label'>账号</Text>
              <Input
                className='admin__input'
                value={username}
                placeholder='管理员账号'
                onInput={(e) => setUsername(e.detail.value)}
              />
            </View>
            <View className='admin__field'>
              <Text className='admin__label'>密码</Text>
              <Input
                className='admin__input'
                value={password}
                password
                placeholder='管理员密码'
                onInput={(e) => setPassword(e.detail.value)}
              />
            </View>
            <Text className='admin__hint'>
              {isOwner
                ? '检测到当前账号已绑定主人 QQ，正在自动登录后台…若没有跳转，请手动输入管理员密码。'
                : '后台使用独立管理员账号，与普通用户账号完全隔离。首次部署时由服务端环境变量 ADMIN_PASSWORD 初始化。'}
            </Text>
            <View className='admin__actions'>
              <View
                className={`admin__btn is-primary pressable${authBusy ? ' is-busy' : ''}`}
                onClick={() => void doLogin()}
              >
                <Text className='admin__btn-text is-primary'>{authBusy ? '登录中…' : '登录'}</Text>
              </View>
            </View>
          </View>
        </View>
      </View>
    )
  }

  return (
    <View className='page-root admin'>
      <PageHeader title='管理后台' subtitle={admin ? `管理员 ${admin.username}` : '主人专属'} back />
      <View className='page-scroll admin__scroll'>
        {/* ---------- 运行状态 ---------- */}
        <Text className='section-title'>运行状态</Text>
        <View className='admin__card card'>
          <View className='admin__row'>
            <Text className='admin__label'>NapCat 连接</Text>
            <Text className={`admin__value${status?.onebot_connected ? ' is-ok' : ' is-warn'}`}>
              {status?.onebot_connected
                ? `在线${status.onebot_nickname ? ` · ${status.onebot_nickname}` : ''}${
                    status.onebot_self_id ? ` (${status.onebot_self_id})` : ''
                  }`
                : '未连接'}
            </Text>
          </View>
          {status?.onebot_error && !status.onebot_connected ? (
            <Text className='admin__hint'>{status.onebot_error}</Text>
          ) : null}
          <View className='divider' />
          <View className='admin__row'>
            <Text className='admin__label'>模型</Text>
            <Text className={`admin__value${status?.llm_configured ? ' is-ok' : ' is-warn'}`}>
              {status?.llm_configured ? status.llm_model : '未配置 API Key'}
            </Text>
          </View>
          <View className='divider' />
          <View className='admin__row'>
            <Text className='admin__label'>今日文档 / PDF 字体</Text>
            <Text className={`admin__value${status?.pdf_font_ready ? '' : ' is-warn'}`}>
              {status?.docs_today ?? 0} 个 · {status?.pdf_font_ready ? '就绪' : '缺失（PDF 将降级为 Word）'}
            </Text>
          </View>
          <View className='divider' />
          <View className='admin__row'>
            <Text className='admin__label'>版本 / 运行时长</Text>
            <Text className='admin__value'>
              v{status?.version || '—'} · {status?.uptime || '—'}
            </Text>
          </View>
          <View className='admin__actions'>
            <View
              className={`admin__btn pressable${loading ? ' is-busy' : ''}`}
              onClick={() => {
                void useAdminStore.getState().refresh().catch((err) => {
                  Taro.showToast({ title: errorMessage(err), icon: 'none' })
                })
              }}
            >
              <Text className='admin__btn-text'>{loading ? '刷新中…' : '刷新状态'}</Text>
            </View>
            <View className='admin__btn pressable' onClick={logout}>
              <Text className='admin__btn-text is-danger'>退出后台</Text>
            </View>
          </View>
        </View>

        {/* ---------- 模型配置 ---------- */}
        <Text className='section-title'>模型配置</Text>
        <View className='admin__card card'>
          <View className='admin__field'>
            <Text className='admin__label'>API Key</Text>
            <Input
              className='admin__input'
              value={form?.apiKey ?? ''}
              placeholder={
                settings?.deepseek.api_key_set ? `已配置 ${settings.deepseek.api_key}（留空不修改）` : '尚未配置'
              }
              onInput={(e) => patchForm({ apiKey: e.detail.value })}
            />
          </View>
          <View className='admin__field'>
            <Text className='admin__label'>Base URL</Text>
            <Input
              className='admin__input'
              value={form?.baseURL ?? ''}
              placeholder='https://dashscope.aliyuncs.com/compatible-mode/v1'
              onInput={(e) => patchForm({ baseURL: e.detail.value })}
            />
          </View>
          <View className='admin__field'>
            <Text className='admin__label'>模型名称</Text>
            <View className='admin__model-presets'>
              {MODEL_PRESETS.map((p) => (
                <View
                  key={p.model}
                  className={`admin__preset-btn pressable${form?.model === p.model ? ' is-active' : ''}`}
                  onClick={() => patchForm({ model: p.model })}
                >
                  <Text>{p.label}</Text>
                </View>
              ))}
            </View>
            <Input
              className='admin__input'
              value={form?.model ?? ''}
              placeholder='或直接填写其他模型 ID'
              onInput={(e) => patchForm({ model: e.detail.value })}
            />
          </View>
          <View className='admin__row'>
            <Text className='admin__label'>思考链（推理模式）</Text>
            <Switch
              checked={form?.thinking ?? true}
              color='#0a84ff'
              onChange={(e) => patchForm({ thinking: e.detail.value })}
            />
          </View>
          <Text className='admin__hint'>保存后立即生效，无需重启服务；留空 API Key 表示沿用当前密钥。</Text>
          <View className='admin__actions'>
            <View
              className='admin__btn pressable'
              onClick={() => void testLLM()}
            >
              <Text className='admin__btn-text'>{testing ? '测试中…' : '测试连接'}</Text>
            </View>
          </View>
        </View>

        {/* ---------- 能力开关 ---------- */}
        <Text className='section-title'>多媒介能力（NapCat 接口开关）</Text>
        <View className='admin__card card'>
          {CAP_LABELS.map((cap, idx) => (
            <View key={cap.key}>
              {idx > 0 ? <View className='divider' /> : null}
              <View className='admin__row'>
                <View className='admin__row-main'>
                  <Text className='admin__label'>{cap.label}</Text>
                  <Text className='admin__sub'>{cap.desc}</Text>
                </View>
                <Switch
                  checked={form?.caps[cap.key] ?? true}
                  color='#0a84ff'
                  onChange={(e) => toggleCap(cap.key, e.detail.value)}
                />
              </View>
            </View>
          ))}
          <Text className='admin__hint'>
            关闭后，模型将无法调用对应接口，纯文本回复里的相关 CQ 码也会被清洗。
          </Text>
        </View>

        {/* ---------- 自主分段发送 ---------- */}
        <Text className='section-title'>自主分段发送</Text>
        <View className='admin__card card'>
          <View className='admin__row'>
            <Text className='admin__label'>启用补发</Text>
            <Switch
              checked={form?.autoEnabled ?? false}
              color='#0a84ff'
              onChange={(e) => patchForm({ autoEnabled: e.detail.value })}
            />
          </View>
          <View className='divider' />
          <View className='admin__field'>
            <Text className='admin__label'>允许对象</Text>
            <Input
              className='admin__input'
              value={form?.targets ?? ''}
              placeholder='owner 或 QQ 号，多个用逗号分隔'
              onInput={(e) => patchForm({ targets: e.detail.value })}
            />
          </View>
          <View className='admin__grid'>
            <View className='admin__grid-item'>
              <Text className='admin__label'>最小延时 (ms)</Text>
              <Input
                className='admin__input'
                type='number'
                value={form?.minDelay ?? ''}
                onInput={(e) => patchForm({ minDelay: e.detail.value })}
              />
            </View>
            <View className='admin__grid-item'>
              <Text className='admin__label'>最大延时 (ms)</Text>
              <Input
                className='admin__input'
                type='number'
                value={form?.maxDelay ?? ''}
                onInput={(e) => patchForm({ maxDelay: e.detail.value })}
              />
            </View>
          </View>
          <View className='admin__grid'>
            <View className='admin__grid-item'>
              <Text className='admin__label'>最多补发条数</Text>
              <Input
                className='admin__input'
                type='number'
                value={form?.maxSegments ?? ''}
                onInput={(e) => patchForm({ maxSegments: e.detail.value })}
              />
            </View>
            <View className='admin__grid-item'>
              <Text className='admin__label'>从第几条开始</Text>
              <Input
                className='admin__input'
                type='number'
                value={form?.startIndex ?? ''}
                onInput={(e) => patchForm({ startIndex: e.detail.value })}
              />
            </View>
          </View>
          <Text className='admin__hint'>
            仅对「主人」或白名单 QQ 的对话生效：主回复发出后，按随机延时自动补发模型给出的第 2..N 段内容。
          </Text>
        </View>

        {/* ---------- 群内冒泡 ---------- */}
        <Text className='section-title'>群内随机冒泡</Text>
        <View className='admin__card card'>
          <View className='admin__row'>
            <Text className='admin__label'>启用冒泡</Text>
            <Switch
              checked={form?.babbleEnabled ?? false}
              color='#0a84ff'
              onChange={(e) => patchForm({ babbleEnabled: e.detail.value })}
            />
          </View>
          <View className='divider' />
          <View className='admin__field'>
            <Text className='admin__label'>活跃时段</Text>
            <Input
              className='admin__input'
              value={form?.babbleWindows ?? ''}
              placeholder='06:00-08:00, 11:00-13:00, 16:00-24:00'
              onInput={(e) => patchForm({ babbleWindows: e.detail.value })}
            />
          </View>
          <View className='admin__grid'>
            <View className='admin__grid-item'>
              <Text className='admin__label'>每天最多条数</Text>
              <Input
                className='admin__input'
                type='number'
                value={form?.babbleMax ?? ''}
                onInput={(e) => patchForm({ babbleMax: e.detail.value })}
              />
            </View>
            <View className='admin__grid-item'>
              <Text className='admin__label'>每小时概率 (%)</Text>
              <Input
                className='admin__input'
                type='number'
                value={form?.babbleProb ?? ''}
                onInput={(e) => patchForm({ babbleProb: e.detail.value })}
              />
            </View>
          </View>
          <View className='admin__grid'>
            <View className='admin__grid-item'>
              <Text className='admin__label'>同群静默 (分钟)</Text>
              <Input
                className='admin__input'
                type='number'
                value={form?.babbleQuiet ?? ''}
                onInput={(e) => patchForm({ babbleQuiet: e.detail.value })}
              />
            </View>
            <View className='admin__grid-item'>
              <Text className='admin__label'>最近消息窗口 (分钟)</Text>
              <Input
                className='admin__input'
                type='number'
                value={form?.babbleRecent ?? ''}
                onInput={(e) => patchForm({ babbleRecent: e.detail.value })}
              />
            </View>
          </View>
          <Text className='admin__hint'>
            只在上述时段、且群里最近有人在聊天时，以很低概率插一句不带 @ 的闲聊；每天总量受上限约束。
          </Text>
        </View>

        {/* ---------- 文档配额 ---------- */}
        <Text className='section-title'>文档能力</Text>
        <View className='admin__card card'>
          <View className='admin__row'>
            <Text className='admin__label'>每人每日文件配额</Text>
            <Input
              className='admin__input admin__input--short'
              type='number'
              value={form?.quota ?? ''}
              onInput={(e) => patchForm({ quota: e.detail.value })}
            />
          </View>
          <Text className='admin__hint'>
            支持 PDF / Word / Excel 本地生成并发送；信息不足时机器人会多轮追问。PDF 字体就绪：
            {settings?.pdf_font_ready ? '是' : '否'}。
          </Text>
        </View>

        {/* ---------- QQ 用户与权限 ---------- */}
        <Text className='section-title'>QQ 用户与权限</Text>
        <View className='admin__card card'>
          <View className='admin__row'>
            <Text className='admin__label'>内置主人（不可删除 / 降级）</Text>
            <Text className='admin__value'>{controlQQ || '—'}</Text>
          </View>
          {botUsers
            .filter((u) => u.qq !== controlQQ)
            .map((u) => (
              <View key={u.qq}>
                <View className='divider' />
                <View className='admin__row'>
                  <View className='admin__row-main'>
                    <Text className='admin__label'>
                      QQ {u.qq} · {roleLabel(u.role)}
                      {u.enabled ? '' : '（已停用）'}
                    </Text>
                    <Text className='admin__sub'>
                      {u.note || '无备注'} · {fmtTime(u.updated_at)}
                    </Text>
                  </View>
                  <View
                    className='admin__small-btn pressable'
                    onClick={() => editBotUser(u.qq, u.role, u.note)}
                  >
                    <Text className='admin__small-btn-text is-neutral'>修改</Text>
                  </View>
                  <View
                    className={`admin__small-btn pressable${ownerBusy ? ' is-busy' : ''}`}
                    onClick={() => void removeBotUser(u.qq)}
                  >
                    <Text className='admin__small-btn-text'>移除</Text>
                  </View>
                </View>
              </View>
            ))}
          <View className='divider' />
          <View className='admin__field'>
            <Text className='admin__label'>QQ 号（新增或覆盖）</Text>
            <Input
              className='admin__input'
              type='number'
              value={newQQ}
              placeholder='QQ 号'
              onInput={(e) => setNewQQ(e.detail.value)}
            />
          </View>
          <View className='admin__field'>
            <Text className='admin__label'>角色</Text>
            <View className='admin__role-row'>
              {ROLE_OPTIONS.map((r) => (
                <View
                  key={r.key}
                  className={`admin__role-chip pressable${newRole === r.key ? ' is-active' : ''}`}
                  onClick={() => setNewRole(r.key)}
                >
                  <Text className={`admin__role-chip-text${newRole === r.key ? ' is-active' : ''}`}>
                    {r.label}
                  </Text>
                </View>
              ))}
            </View>
            <Text className='admin__sub'>{ROLE_OPTIONS.find((r) => r.key === newRole)?.desc}</Text>
          </View>
          <View className='admin__field'>
            <Text className='admin__label'>备注</Text>
            <Input
              className='admin__input'
              value={newNote}
              placeholder='例如：小号 / 室友'
              onInput={(e) => setNewNote(e.detail.value)}
            />
          </View>
          <View className='admin__actions'>
            <View
              className={`admin__btn pressable${ownerBusy ? ' is-busy' : ''}`}
              onClick={() => void saveBotUser()}
            >
              <Text className='admin__btn-text'>保存用户</Text>
            </View>
          </View>
          <Text className='admin__hint'>
            主人 = 全部权限（shell、系统偏好、任意账号）；管理员 = 可驱动系统能力但不能进 shell；成员 =
            正常使用；访客 = 只能聊天。权限变更约 30 秒内生效。
          </Text>
          {owners.length > 0 ? (
            <Text className='admin__hint'>旧主人名单仍有 {owners.length} 个 QQ，作为兼容保留。</Text>
          ) : null}
        </View>

        {/* ---------- 保存 ---------- */}
        <View className='admin__save'>
          <View
            className={`admin__btn is-primary pressable${saving ? ' is-busy' : ''}`}
            onClick={() => void save()}
          >
            <Text className='admin__btn-text is-primary'>{saving ? '保存中…' : '保存全部配置'}</Text>
          </View>
        </View>

        {/* ---------- 最近文档 ---------- */}
        <Text className='section-title'>最近生成的文档</Text>
        <View className='admin__card card'>
          {docs.length === 0 ? <Text className='admin__hint'>暂无文档</Text> : null}
          {docs.map((f) => (
            <View key={f.id}>
              <View className='admin__row'>
                <View className='admin__row-main'>
                  <Text className='admin__label'>{f.filename}</Text>
                  <Text className='admin__sub'>
                    {f.type.toUpperCase()} · {fmtSize(f.size_bytes)} · {chatLabel(f.chat_key)} · QQ {f.user_qq} ·{' '}
                    {fmtTime(f.created_at)}
                  </Text>
                </View>
                <View
                  className={`admin__small-btn pressable${resending === f.id ? ' is-busy' : ''}`}
                  onClick={() => void resend(f)}
                >
                  <Text className='admin__small-btn-text'>重发</Text>
                </View>
              </View>
              <View className='divider' />
            </View>
          ))}
        </View>

        {/* ---------- 审计 ---------- */}
        <Text className='section-title'>最近操作</Text>
        <View className='admin__card card'>
          {audit.length === 0 ? <Text className='admin__hint'>暂无记录</Text> : null}
          {audit.map((a) => (
            <View key={a.id}>
              <View className='admin__row'>
                <View className='admin__row-main'>
                  <Text className='admin__label'>{a.action}</Text>
                  <Text className='admin__sub'>
                    {a.detail || '—'} · {a.username || '未知管理员'} · {fmtTime(a.created_at)}
                  </Text>
                </View>
              </View>
              <View className='divider' />
            </View>
          ))}
        </View>

        <Text className='admin__about'>
          后台配置存储于服务端 SQLite，保存即热更新；所有写操作都会记录审计日志。
        </Text>
      </View>
    </View>
  )
}
