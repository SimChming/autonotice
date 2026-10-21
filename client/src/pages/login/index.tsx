import { useEffect, useRef, useState } from 'react'
import { Input, Switch, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'

import { PageHeader } from '../../components/PageHeader'
import { api, errorMessage } from '../../services/api'
import {
  clearCredentials,
  loadCredentials,
  saveCredentials,
  useAuthStore
} from '../../store/auth'
import './index.scss'

type Mode = 'login' | 'register'

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('login')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [remember, setRemember] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const autoSubmitted = useRef(false)

  async function submit(override?: { name: string; password: string }) {
    const nameValue = (override?.name ?? name).trim()
    const passwordValue = override?.password ?? password

    setError('')
    if (!nameValue) return setError('请输入用户名')
    if (passwordValue.length < 6) return setError('密码至少 6 位')
    if (mode === 'register' && passwordValue !== confirm) return setError('两次输入的密码不一致')

    setLoading(true)
    try {
      const res =
        mode === 'login'
          ? await api.login(nameValue, passwordValue)
          : await api.register(nameValue, passwordValue)
      useAuthStore.getState().setAuth(res.token, res.user)

      // 记住 / 忘记账号密码
      if (remember) saveCredentials(nameValue, passwordValue)
      else clearCredentials()

      // 拉取绑定，决定落地页：已绑定 → 日程；未绑定 → 绑定 QQ
      let verified = false
      try {
        const bindings = await api.listBindings()
        useAuthStore.getState().setBindings(bindings.bindings || [])
        verified = (bindings.bindings || []).some((b) => b.verified)
      } catch {
        verified = false
      }

      Taro.showToast({ title: mode === 'login' ? '登录成功' : '注册成功', icon: 'success' })
      setTimeout(() => {
        Taro.reLaunch({ url: verified ? '/pages/schedule/index' : '/pages/bind/index' }).catch(
          () => undefined
        )
      }, 350)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  // 挂载时：本地存有账号密码则回填并自动登录一次（仅登录模式）
  useEffect(() => {
    if (autoSubmitted.current) return
    autoSubmitted.current = true
    if (mode !== 'login') return
    const cred = loadCredentials()
    if (!cred) return
    setName(cred.username)
    setPassword(cred.password)
    void submit({ name: cred.username, password: cred.password })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <View className='page-root login'>
      <PageHeader title='日程助手' subtitle='QQ 群消息 → AI 日程 → 本地提醒' />

      <View className='page-scroll login__scroll'>
        <View className='login__card card'>
          <View className='login__segment'>
            <View
              className={`login__segment-item${mode === 'login' ? ' is-active' : ''}`}
              onClick={() => {
                setMode('login')
                setError('')
              }}
            >
              <Text className='login__segment-text'>登录</Text>
            </View>
            <View
              className={`login__segment-item${mode === 'register' ? ' is-active' : ''}`}
              onClick={() => {
                setMode('register')
                setError('')
              }}
            >
              <Text className='login__segment-text'>注册</Text>
            </View>
          </View>

          <View className='login__field'>
            <Text className='login__label'>用户名</Text>
            <Input
              className='login__input'
              value={name}
              placeholder='用于登录的名称'
              onInput={(e) => setName(e.detail.value)}
            />
          </View>

          <View className='login__field'>
            <Text className='login__label'>密码</Text>
            <Input
              className='login__input'
              password
              value={password}
              placeholder='至少 6 位'
              onInput={(e) => setPassword(e.detail.value)}
            />
          </View>

          {mode === 'register' ? (
            <View className='login__field'>
              <Text className='login__label'>确认密码</Text>
              <Input
                className='login__input'
                password
                value={confirm}
                placeholder='再输入一次'
                onInput={(e) => setConfirm(e.detail.value)}
              />
            </View>
          ) : null}

          <View className='login__remember'>
            <Text className='login__remember-label'>记住账号密码</Text>
            <Switch
              className='login__remember-switch'
              checked={remember}
              color='#0a84ff'
              onChange={(e) => setRemember(e.detail.value)}
            />
          </View>

          {error ? <Text className='login__error'>{error}</Text> : null}

          <View
            className={`login__submit pressable${loading ? ' is-loading' : ''}`}
            onClick={() => {
              if (!loading) void submit()
            }}
          >
            {loading ? (
              <View className='spinner login__spinner' />
            ) : (
              <Text className='login__submit-text'>{mode === 'login' ? '登录' : '创建账号'}</Text>
            )}
          </View>

          <Text className='login__hint'>
            登录后需要绑定你的 QQ 号：服务端会在群里校验一条 `#bind` 验证消息，未验证的绑定不会参与 AI 总结。
          </Text>
        </View>

        <Text className='login__endpoint'>服务端：{api.base}</Text>
      </View>
    </View>
  )
}
