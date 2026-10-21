import { useState } from 'react'
import { Input, Switch, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'

import { Icon } from '../../components/Icon'
import { PageHeader } from '../../components/PageHeader'
import { TabBar } from '../../components/TabBar'
import { api } from '../../services/api'
import { getNotifier, notifyBudgetHint } from '../../services/notify/platform'
import { forceReschedule, reschedule } from '../../services/notify/scheduler'
import { clearLocalData, syncAll, syncStatus } from '../../services/sync'
import { useAuthStore } from '../../store/auth'
import { useNotifyStore } from '../../store/notify'
import { useScheduleStore } from '../../store/schedule'
import { detectDeviceKind } from '../../utils/platform'
import { useAuthGuard } from '../../utils/useAuthGuard'
import './index.scss'

const OFFSET_PRESETS: Array<{ minutes: number; label: string }> = [
  { minutes: -24 * 60, label: '提前 1 天' },
  { minutes: -2 * 60, label: '提前 2 小时' },
  { minutes: -15, label: '提前 15 分钟' },
  { minutes: -5, label: '提前 5 分钟' }
]

const OEM_GUIDE = [
  '小米 / 红米：设置 → 应用设置 → 应用管理 → 本应用 → 省电策略「无限制」+ 自启动「允许」',
  '华为 / 荣耀：设置 → 应用启动管理 → 本应用 → 关闭「自动管理」，勾选「自启动 / 关联启动 / 后台活动」',
  'OPPO / 一加：设置 → 电池 → 应用耗电管理 → 本应用 → 允许后台运行；设置 → 应用管理 → 自启动',
  'vivo / iQOO：设置 → 电池 → 后台高耗电 → 允许本应用；i 管家 → 自启动管理',
  '原生 Android：设置 → 应用 → 本应用 → 电池 → 不受限制'
]

export default function SettingsPage() {
  useAuthGuard()

  const user = useAuthStore((s) => s.user)
  const bindings = useAuthStore((s) => s.bindings)
  const permission = useNotifyStore((s) => s.permission)
  const settings = useNotifyStore((s) => s.settings)
  const runtime = useNotifyStore((s) => s.runtime)
  const maxCount = useNotifyStore((s) => s.maxCount)
  const scheduledCount = useNotifyStore((s) => s.scheduledCount)
  const droppedCount = useNotifyStore((s) => s.droppedCount)
  const lastScheduledAt = useNotifyStore((s) => s.lastScheduledAt)

  const revision = useScheduleStore((s) => s.revision)
  const conflicts = useScheduleStore((s) => s.conflicts.length)

  const [customOffset, setCustomOffset] = useState('')
  const [working, setWorking] = useState(false)

  const deviceKind = detectDeviceKind()
  const isAndroid = deviceKind === 'android'
  const status = syncStatus()

  function toggleOffset(minutes: number) {
    const has = settings.offsetsMinutes.includes(minutes)
    const next = has
      ? settings.offsetsMinutes.filter((m) => m !== minutes)
      : [...settings.offsetsMinutes, minutes].sort((a, b) => a - b)
    useNotifyStore.getState().setSettings({ offsetsMinutes: next.length ? next : [-15] })
  }

  async function applyPermission() {
    setWorking(true)
    try {
      const notifier = await getNotifier()
      const state = await notifier.ensurePermission(true)
      useNotifyStore.getState().setPermission(state)
      if (state.granted) {
        Taro.showToast({ title: '通知已开启', icon: 'success' })
        await forceReschedule()
      } else {
        Taro.showToast({ title: state.detail || '仍未获得通知权限', icon: 'none' })
      }
    } finally {
      setWorking(false)
    }
  }

  async function applyExactAlarm() {
    const notifier = await getNotifier()
    const ok = await notifier.requestExactAlarm?.()
    if (ok === undefined) {
      Taro.showToast({ title: '当前平台无需精确定时权限', icon: 'none' })
      return
    }
    useNotifyStore.getState().setPermission({
      ...permission,
      exactAlarmGranted: ok,
      needsSystemSettings: ok ? permission.needsSystemSettings : true,
      detail: ok ? undefined : '未开启「闹钟和提醒」，提醒可能被系统延后'
    })
    Taro.showToast({ title: ok ? '已开启精确定时' : '未开启，已降级为系统调度', icon: 'none' })
  }

  async function rescheduleNow() {
    setWorking(true)
    try {
      const res = await reschedule({ force: true, request: true, includeAlerts: true })
      Taro.showToast({
        title: `已排程 ${res.scheduled} 条${res.dropped ? `（舍弃 ${res.dropped}）` : ''}`,
        icon: 'none'
      })
    } finally {
      setWorking(false)
    }
  }

  async function doSync() {
    setWorking(true)
    try {
      await syncAll()
      await reschedule({ force: true }).catch(() => undefined)
      Taro.showToast({ title: '已同步', icon: 'success' })
    } catch {
      Taro.showToast({ title: '网络不可用', icon: 'none' })
    } finally {
      setWorking(false)
    }
  }

  async function logout() {
    const r = await Taro.showModal({ title: '退出登录', content: '退出后会清空本地缓存的日程与提醒。' })
    if (!r.confirm) return
    const notifier = await getNotifier()
    await notifier.cancelAllForUser()
    clearLocalData()
    useAuthStore.getState().logout()
    Taro.reLaunch({ url: '/pages/login/index' }).catch(() => undefined)
  }

  function addCustomOffset() {
    const n = Number(customOffset)
    if (!Number.isFinite(n) || n === 0) {
      Taro.showToast({ title: '请输入非 0 的分钟数', icon: 'none' })
      return
    }
    // 输入正数也按「提前」处理（提醒早于截止）
    toggleOffset(-Math.abs(n))
    setCustomOffset('')
    void reschedule({ force: true }).catch(() => undefined)
  }

  return (
    <View className='page-root settings'>
      <PageHeader title='设置' subtitle={user ? `账号 ${user.name}` : '通知 · 提醒 · 账号'} />

      <View className='page-scroll settings__scroll'>
        {/* ---------------- 通知 ---------------- */}
        <Text className='section-title'>通知</Text>
        <View className='settings__card card'>
          <View className='settings__row'>
            <Text className='settings__label'>运行环境</Text>
            <Text className='settings__value'>
              {runtime === 'web' ? '浏览器 (H5)' : runtime === 'capacitor' ? '移动端壳' : 'Windows 桌面'}
            </Text>
          </View>
          <View className='divider' />
          <View className='settings__row'>
            <Text className='settings__label'>通知权限</Text>
            <Text className={`settings__value${permission.granted ? ' is-ok' : ' is-warn'}`}>
              {permission.granted ? '已开启' : '未开启'}
            </Text>
          </View>
          {isAndroid ? (
            <>
              <View className='divider' />
              <View className='settings__row'>
                <Text className='settings__label'>精确定时（Android 12+）</Text>
                <Text
                  className={`settings__value${permission.exactAlarmGranted ? ' is-ok' : ' is-warn'}`}
                >
                  {permission.exactAlarmGranted ? '已开启' : '未开启（已降级）'}
                </Text>
              </View>
            </>
          ) : null}
          <View className='divider' />
          <View className='settings__row'>
            <Text className='settings__label'>滚动窗口</Text>
            <Text className='settings__value'>
              已排 {scheduledCount} / 上限 {maxCount}
              {droppedCount ? ` · 舍弃 ${droppedCount}` : ''}
            </Text>
          </View>
          <View className='divider' />
          <View className='settings__row'>
            <Text className='settings__label'>上次排程</Text>
            <Text className='settings__value'>
              {lastScheduledAt
                ? new Date(lastScheduledAt).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                  })
                : '尚未排程'}
            </Text>
          </View>

          {permission.detail ? <Text className='settings__notice'>{permission.detail}</Text> : null}
          <Text className='settings__hint'>{notifyBudgetHint()}</Text>

          <View className='settings__actions'>
            <View
              className={`settings__btn is-primary pressable${working ? ' is-loading' : ''}`}
              onClick={() => void applyPermission()}
            >
              <Text className='settings__btn-text is-primary'>申请通知权限</Text>
            </View>
            {isAndroid && !permission.exactAlarmGranted ? (
              <View
                className='settings__btn pressable'
                onClick={() => void applyExactAlarm()}
              >
                <Text className='settings__btn-text'>开启精确定时</Text>
              </View>
            ) : null}
            <View className='settings__btn pressable' onClick={() => void rescheduleNow()}>
              <Text className='settings__btn-text'>重新排程</Text>
            </View>
          </View>
        </View>

        {/* ---------------- 提醒策略 ---------------- */}
        <Text className='section-title'>提醒策略</Text>
        <View className='settings__card card'>
          <View className='settings__row'>
            <Text className='settings__label'>每日 08:00 简报</Text>
            <Switch
              checked={settings.digestEnabled}
              color='#0a84ff'
              onChange={(e) => {
                useNotifyStore.getState().setSettings({ digestEnabled: e.detail.value })
                void reschedule({ force: true }).catch(() => undefined)
              }}
            />
          </View>
          <View className='divider' />
          <View className='settings__row'>
            <Text className='settings__label'>仅对高优先级项申请精确定时</Text>
            <Switch
              checked={settings.highPriorityOnly}
              color='#0a84ff'
              onChange={(e) => {
                useNotifyStore.getState().setSettings({ highPriorityOnly: e.detail.value })
                void reschedule({ force: true }).catch(() => undefined)
              }}
            />
          </View>

          <Text className='settings__sub-title'>
            没有指定提醒时间时，按以下偏移提醒（可多选）
          </Text>
          <View className='settings__chips'>
            {OFFSET_PRESETS.map((p) => {
              const on = settings.offsetsMinutes.includes(p.minutes)
              return (
                <View
                  key={p.minutes}
                  className={`settings__chip${on ? ' is-on' : ''}`}
                  onClick={() => {
                    toggleOffset(p.minutes)
                    void reschedule({ force: true }).catch(() => undefined)
                  }}
                >
                  <Text className={`settings__chip-text${on ? ' is-on' : ''}`}>{p.label}</Text>
                </View>
              )
            })}
          </View>

          <View className='settings__custom'>
            <Input
              className='settings__input'
              type='number'
              value={customOffset}
              placeholder='自定义提前分钟数'
              onInput={(e) => setCustomOffset(e.detail.value)}
            />
            <View className='settings__btn pressable' onClick={addCustomOffset}>
              <Text className='settings__btn-text'>添加</Text>
            </View>
          </View>

          <Text className='settings__hint'>
            当前生效偏移：
            {settings.offsetsMinutes
              .map((m) => (m >= 0 ? `到期后 ${m} 分钟` : `提前 ${Math.abs(m)} 分钟`))
              .join('、')}
          </Text>
        </View>

        {/* ---------------- 后台保活 ---------------- */}
        <Text className='section-title'>后台保活（厂商系统）</Text>
        <View className='settings__card card'>
          <Text className='settings__hint'>
            部分厂商系统会清理后台进程，导致本地提醒延后或不触发。请按下面对应机型放行本应用。
          </Text>
          {OEM_GUIDE.map((line) => (
            <View key={line} className='settings__guide'>
              <Icon name='shield' className='settings__guide-icon' strokeWidth={1.8} />
              <Text className='settings__guide-text'>{line}</Text>
            </View>
          ))}
          <View className='settings__actions'>
            <View
              className='settings__btn pressable'
              onClick={() => {
                useNotifyStore.getState().setSettings({ bootGuideAcknowledged: true })
                Taro.showToast({ title: '已记录', icon: 'none' })
              }}
            >
              <Text className='settings__btn-text'>
                {settings.bootGuideAcknowledged ? '已确认设置' : '我已按指引设置'}
              </Text>
            </View>
          </View>
        </View>

        {/* ---------------- 账号与同步 ---------------- */}
        <Text className='section-title'>账号与同步</Text>
        <View className='settings__card card'>
          <View
            className='settings__row pressable'
            onClick={() => Taro.navigateTo({ url: '/pages/admin/index' }).catch(() => undefined)}
          >
            <Text className='settings__label'>管理后台</Text>
            <Text className='settings__value'>主人专属 · 模型 / 能力 / 名单</Text>
          </View>
          <View className='divider' />
          <View className='settings__row pressable' onClick={() => Taro.navigateTo({ url: '/pages/bind/index' })}>
            <Text className='settings__label'>QQ 绑定</Text>
            <Text className='settings__value'>
              {bindings.length ? `${bindings.filter((b) => b.verified).length} / ${bindings.length} 已验证` : '未绑定'}
            </Text>
          </View>
          <View className='divider' />
          <View className='settings__row'>
            <Text className='settings__label'>服务端</Text>
            <Text className='settings__value'>{api.base}</Text>
          </View>
          <View className='divider' />
          <View className='settings__row'>
            <Text className='settings__label'>日程版本</Text>
            <Text className='settings__value'>revision {revision}</Text>
          </View>
          <View className='divider' />
          <View className='settings__row'>
            <Text className='settings__label'>待同步改动 / 冲突</Text>
            <Text className={`settings__value${status.pending || conflicts ? ' is-warn' : ''}`}>
              {status.pending} / {conflicts}
            </Text>
          </View>

          <View className='settings__actions'>
            <View className='settings__btn is-primary pressable' onClick={() => void doSync()}>
              <Text className='settings__btn-text is-primary'>立即同步</Text>
            </View>
            <View className='settings__btn pressable' onClick={() => void logout()}>
              <Text className='settings__btn-text is-danger'>退出登录</Text>
            </View>
          </View>
        </View>

        <Text className='settings__about'>
          QQ 群 AI 日程助手 · 客户端 H5 核心（Taro + React），壳打包 iOS / Android / Windows。
          本地提醒采用滚动排程：先取消全部已排通知，再按 remind_at 升序取最近 N 条，简报通知点开触发重排。
        </Text>
      </View>

      <TabBar active='settings' />
    </View>
  )
}
