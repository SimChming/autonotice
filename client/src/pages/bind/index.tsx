import { useEffect, useRef, useState } from 'react'
import { Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'

import { Empty } from '../../components/Empty'
import { PageHeader } from '../../components/PageHeader'
import { api, errorMessage } from '../../services/api'
import { reschedule } from '../../services/notify/scheduler'
import { copyText } from '../../utils/storage'
import { useAuthStore } from '../../store/auth'
import { fmtTime, toMs } from '../../utils/date'
import './index.scss'

const POLL_INTERVAL_MS = 5000

export default function BindPage() {
  const bindings = useAuthStore((s) => s.bindings)

  const [qqUid, setQqUid] = useState('')
  const [groupId, setGroupId] = useState('')
  const [code, setCode] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [phase, setPhase] = useState<'form' | 'waiting' | 'done'>('form')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => stopPolling, [])

  // 每秒刷新倒计时显示
  useEffect(() => {
    if (phase !== 'waiting') return undefined
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [phase])

  const remainText = (() => {
    void tick
    const ms = toMs(expiresAt)
    if (ms === null) return ''
    const left = ms - Date.now()
    if (left <= 0) return '已过期'
    const min = Math.floor(left / 60000)
    const sec = Math.floor((left % 60000) / 1000)
    return `剩余 ${min}:${sec < 10 ? `0${sec}` : sec}`
  })()

  async function refreshBindings() {
    try {
      const res = await api.listBindings()
      useAuthStore.getState().setBindings(res.bindings || [])
    } catch {
      /* 忽略 */
    }
  }

  async function initiate() {
    setError('')
    if (!/^\d{5,12}$/.test(qqUid.trim())) return setError('请输入正确的 QQ 号')
    if (!/^\d{5,12}$/.test(groupId.trim())) return setError('请输入正确的群号')
    setLoading(true)
    try {
      const res = await api.initiateBinding(qqUid.trim(), groupId.trim())
      setCode(res.code)
      setExpiresAt(res.expires_at)
      setPhase('waiting')
      startPolling()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  function startPolling() {
    stopPolling()
    timerRef.current = setInterval(async () => {
      try {
        const res = await api.confirmBinding(qqUid.trim(), groupId.trim())
        if (res.binding?.verified) {
          stopPolling()
          setPhase('done')
          await refreshBindings()
          void reschedule({ force: true, includeAlerts: true }).catch(() => undefined)
          Taro.showToast({ title: '绑定成功', icon: 'success' })
        }
      } catch (err) {
        const ms = toMs(expiresAt)
        if (ms !== null && ms - Date.now() <= 0) {
          stopPolling()
          setPhase('form')
          setError('验证码已过期，请重新生成')
        } else if (!(err instanceof Error)) {
          /* 网络抖动继续轮询 */
        }
      }
    }, POLL_INTERVAL_MS)
  }

  async function removeBinding(uid: string) {
    const confirmRes = await Taro.showModal({
      title: '解绑',
      content: `确定解绑 QQ ${uid}？解绑后该号将不再参与 AI 日程总结。`
    })
    if (!confirmRes.confirm) return
    try {
      await api.deleteBinding(uid)
      await refreshBindings()
      Taro.showToast({ title: '已解绑', icon: 'none' })
    } catch (err) {
      Taro.showToast({ title: errorMessage(err), icon: 'none' })
    }
  }

  return (
    <View className='page-root bind'>
      <PageHeader
        title='绑定 QQ'
        subtitle='在群里发一条验证消息，证明你拥有这个 QQ 号'
        back={bindings.length > 0}
      />

      <View className='page-scroll bind__scroll'>
        {phase !== 'done' ? (
          <View className='bind__card card'>
            <View className='bind__row'>
              <Text className='bind__label'>QQ 号</Text>
              <Input
                className='bind__input'
                type='number'
                value={qqUid}
                placeholder='你的 QQ 号'
                disabled={phase === 'waiting'}
                onInput={(e) => setQqUid(e.detail.value)}
              />
            </View>
            <View className='bind__row'>
              <Text className='bind__label'>目标群号</Text>
              <Input
                className='bind__input'
                type='number'
                value={groupId}
                placeholder='机器人所在的群'
                disabled={phase === 'waiting'}
                onInput={(e) => setGroupId(e.detail.value)}
              />
            </View>

            {phase === 'form' ? (
              <>
                {error ? <Text className='bind__error'>{error}</Text> : null}
                <View
                  className={`bind__submit pressable${loading ? ' is-loading' : ''}`}
                  onClick={() => {
                    if (!loading) void initiate()
                  }}
                >
                  <Text className='bind__submit-text'>生成绑定码</Text>
                </View>
              </>
            ) : (
              <View className='bind__waiting'>
                <Text className='bind__waiting-title'>请在群里发送这条消息</Text>
                <View className='bind__code-box pressable' onClick={() => copyText(`#bind ${code}`)}>
                  <Text className='bind__code'>{`#bind ${code}`}</Text>
                  <Text className='bind__code-copy'>点击复制 · {remainText}</Text>
                </View>
                <View className='bind__steps'>
                  <Text className='bind__step'>1. 打开 QQ，进入群 {groupId}</Text>
                  <Text className='bind__step'>2. 用 QQ {qqUid} 在群里原样发送上面的消息</Text>
                  <Text className='bind__step'>3. 机器人校验通过后本页会自动完成</Text>
                </View>
                <View className='bind__polling'>
                  <View className='spinner bind__spinner' />
                  <Text className='bind__polling-text'>
                    正在等待群内验证 {fmtTime(Date.now())}
                  </Text>
                </View>
                <Text
                  className='bind__restart'
                  onClick={() => {
                    stopPolling()
                    setPhase('form')
                    setError('')
                  }}
                >
                  重新生成绑定码
                </Text>
              </View>
            )}
          </View>
        ) : (
          <View className='bind__done card'>
            <View className='bind__done-ring'>
              <Text className='bind__done-check'>✓</Text>
            </View>
            <Text className='bind__done-title'>绑定成功</Text>
            <Text className='bind__done-hint'>
              QQ {qqUid} 已通过验证，之后服务端会为它生成专属日程。
            </Text>
            <View
              className='bind__submit pressable'
              onClick={() => Taro.reLaunch({ url: '/pages/schedule/index' }).catch(() => undefined)}
            >
              <Text className='bind__submit-text'>进入日程</Text>
            </View>
          </View>
        )}

        <View className='bind__list-block'>
          <Text className='section-title'>已绑定</Text>
          {bindings.length ? (
            bindings.map((b) => (
              <View key={b.qq_uid} className='bind__item card'>
                <View className='bind__item-main'>
                  <Text className='bind__item-qq'>QQ {b.qq_uid}</Text>
                  <Text className='bind__item-group'>群 {b.group_id}</Text>
                </View>
                <Text className={`bind__item-state${b.verified ? ' is-ok' : ''}`}>
                  {b.verified ? '已验证' : '待验证'}
                </Text>
                <Text className='bind__item-unbind' onClick={() => void removeBinding(b.qq_uid)}>
                  解绑
                </Text>
              </View>
            ))
          ) : (
            <Empty title='还没有绑定' hint='绑定后 AI 才会从群里为你挑出相关日程' />
          )}
        </View>
      </View>
    </View>
  )
}
