export default defineAppConfig({
  pages: [
    'pages/login/index',
    'pages/bind/index',
    'pages/schedule/index',
    'pages/calendar/index',
    'pages/alerts/index',
    'pages/detail/index',
    'pages/settings/index',
    // admin 页面已从客户端路由表移除，防止 CTF 选手扫描到；
    // 后续通过独立域名 / IP 白名单 / secret header 方式接入。
    // 'pages/admin/index',
    'pages/feedback/index'
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#f2f2f7',
    navigationBarTitleText: 'Autonotice',
    navigationBarTextStyle: 'black',
    // 使用自定义导航栏，换取完全可控的 Apple-like 视觉
    navigationStyle: 'custom'
  }
})
