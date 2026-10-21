export default defineAppConfig({
  pages: [
    'pages/login/index',
    'pages/bind/index',
    'pages/schedule/index',
    'pages/calendar/index',
    'pages/alerts/index',
    'pages/detail/index',
    'pages/settings/index',
    'pages/admin/index'
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
