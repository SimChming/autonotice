# Checklist：机器人人格/shell 控制 + 客户端体验增强

## 需求覆盖
- [ ] R1 自动登录：勾选记住密码后重启自动进入日程页；token 失效可静默重登（代码已就绪，待运行验证）
- [x] R2 群头像 + 群名：卡片（ItemCard）与来源卡（SourceCard）均用 GroupChip 显示头像与群名
- [ ] R3 群内 @：授权 QQ 人格回复；带前缀可执行 root shell；非授权仅调皮回绝（代码已就绪，待扫码登录后验证）
- [x] R4 登录输入框文字垂直居中（`display:block;width:100%;box-sizing:border-box;line-height=height`）；整体 UI 已微调
- [x] R5 ≥700px 宽屏：根字号 27PX→30PX、`.page-root` 居中限宽、日程列表双列 grid（编译产物确认 PX 未被转 rem）
- [ ] R6 私聊 shell 仅 3874095145 可用，其余回绝（代码已就绪，待扫码登录后验证）
- [x] R7 备注栏 `font-family:inherit` + `line-height:1.65`；`normalizeNotes` 用于初值与保存

## 安全
- [x] shell 仅前缀触发；未授权只固定文案回绝，不调用 DeepSeek
- [x] 忽略 `ev.UserID == ev.SelfID` 防止自我回环
- [x] `bot.enabled` 可一键关闭；`control_qq` 可从配置覆盖
- [ ] 交付说明中明确「root shell 经 QQ 暴露」的风险与关闭方法（见最终回复）

## 构建与部署
- [x] `go build ./...` 与 `go vet ./...` 无错误
- [x] 前端 `npm run build:h5` 成功，服务端内嵌资源已更新
- [ ] 远端健康检查 `/healthz` 返回 ok（阻塞：SSH 认证失败，待用户提供凭据）
- [x] exe / apk 产物到位并复制到桌面发布目录
- [ ] 提醒用户：需先扫码登录小号 3754609823 才能验证 bot 功能（见最终回复）

## 回归
- [ ] 原有日程同步 / 一键排程 / 绑定流程未受影响（CORS、ETag、离线队列）（待部署后验证）
- [ ] 桌面端与 apk 端网络请求不出现跨域/明文流量拦截（待部署后验证）
