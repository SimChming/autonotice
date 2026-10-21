import { useState } from 'react'
import { Text, Textarea, View } from '@tarojs/components'
import Taro from '@tarojs/taro'

import { Icon } from '../../components/Icon'
import { PageHeader } from '../../components/PageHeader'
import { api } from '../../services/api'
import { useAuthGuard } from '../../utils/useAuthGuard'
import './index.scss'

export default function FeedbackPage() {
  useAuthGuard()

  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [contact, setContact] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    if (!body.trim()) {
      Taro.showToast({ title: '请输入反馈内容', icon: 'none' })
      return
    }
    if (body.trim().length < 5) {
      Taro.showToast({ title: '反馈内容太少啦', icon: 'none' })
      return
    }
    setSubmitting(true)
    try {
      await api.postFeedback({
        subject: subject.trim(),
        body: body.trim(),
        contact: contact.trim()
      })
      Taro.showToast({ title: '已提交，感谢反馈！', icon: 'success' })
      setTimeout(() => Taro.navigateBack(), 900)
    } catch (e: any) {
      Taro.showToast({ title: e?.message || '提交失败，请稍后再试', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <View className='page-root feedback'>
      <PageHeader title='联系我们' subtitle='遇到问题？想加新功能？告诉我们吧' />

      <View className='feedback__form card'>
        <View className='feedback__field'>
          <Text className='feedback__label'>主题（可选）</Text>
          <View className='feedback__input-wrap'>
            <input
              className='feedback__input'
              value={subject}
              placeholder='一句话概括问题'
              maxLength={80}
              onInput={(e: any) => setSubject(e.detail.value || '')}
            />
          </View>
        </View>

        <View className='feedback__field'>
          <Text className='feedback__label'>详细描述</Text>
          <Textarea
            className='feedback__textarea'
            value={body}
            placeholder='请描述你遇到的问题、复现步骤、期望行为...（5 ~ 5000 字）'
            maxlength={5000}
            autoHeight
            onInput={(e: any) => setBody(e.detail.value || '')}
          />
          <Text className='feedback__counter'>{body.length} / 5000</Text>
        </View>

        <View className='feedback__field'>
          <Text className='feedback__label'>联系方式（可选）</Text>
          <View className='feedback__input-wrap'>
            <input
              className='feedback__input'
              value={contact}
              placeholder='QQ / 邮箱 / 微信，方便我们回复你'
              maxLength={80}
              onInput={(e: any) => setContact(e.detail.value || '')}
            />
          </View>
        </View>

        <View className='feedback__actions'>
          <View
            className={`feedback__submit pressable${submitting ? ' is-disabled' : ''}`}
            onClick={() => void submit()}
          >
            <Icon name='sparkle' className='feedback__submit-icon' strokeWidth={2} />
            <Text className='feedback__submit-text'>{submitting ? '提交中...' : '提交反馈'}</Text>
          </View>
        </View>
      </View>

      <View className='feedback__tips'>
        <Text className='feedback__tips-title'>💡 也可以直接联系我</Text>
        <Text className='feedback__tips-line'>• QQ / 邮箱 / 微信在上方「联系方式」填就行</Text>
        <Text className='feedback__tips-line'>• 服务器日志和你绑定的 QQ 会自动关联，方便定位</Text>
      </View>
    </View>
  )
}
