// Taro 4 使用 babel-preset-taro 处理 React / TypeScript / 平台差异
module.exports = {
  presets: [
    [
      'taro',
      {
        framework: 'react',
        ts: true,
        compiler: 'webpack5'
      }
    ]
  ]
}
