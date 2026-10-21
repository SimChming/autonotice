import { defineConfig, type UserConfigExport } from '@tarojs/cli'

import devConfig from './dev'
import prodConfig from './prod'

/**
 * Taro 4 构建配置。
 *
 * 客户端只产出 H5（唯一核心）。iOS/Android 用 Capacitor 壳、Windows 用 Tauri 壳，
 * 两者都通过 `file://` 或自定义协议加载 `dist/index.html`，因此：
 *   - 路由必须是 hash 模式（否则 file:// 下深链 404）
 *   - publicPath 使用相对路径 `./`
 */
export default defineConfig<'webpack5'>(async (merge) => {
  const baseConfig: UserConfigExport<'webpack5'> = {
    projectName: 'qq-schedule-assistant',
    date: '2026-10-19',
    designWidth: 750,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2
    },
    sourceRoot: 'src',
    outputRoot: 'dist',
    plugins: [],
    defineConstants: {
      // 运行时注入服务端基地址（默认 localhost，打包时可通过环境变量覆盖）
      'process.env.TARO_APP_API_BASE': JSON.stringify(process.env.TARO_APP_API_BASE || '')
    },
    copy: {
      patterns: [
        // 站点图标：打包时把 src/favicon.ico 复制到 dist 根目录，供 index.html 引用
        { from: 'src/favicon.ico', to: 'dist/favicon.ico' }
      ],
      options: {}
    },
    framework: 'react',
    compiler: {
      type: 'webpack5',
      prebundle: { enable: false }
    },
    cache: { enable: false },
    sass: {
      resource: ['src/styles/variables.scss']
    },
    mini: {
      postcss: {
        pxtransform: { enable: true, config: {} },
        cssModules: { enable: false }
      }
    },
    h5: {
      publicPath: './',
      staticDirectory: 'static',
      router: {
        mode: 'hash'
      },
      esnextModules: [],
      miniCssExtractPluginOption: {
        ignoreOrder: true
      },
      output: {
        filename: 'js/[name].[hash:8].js',
        chunkFilename: 'js/[name].[chunkhash:8].js'
      },
      postcss: {
        autoprefixer: { enable: true, config: {} },
        cssModules: { enable: false }
      }
    }
  }

  if (process.env.NODE_ENV === 'development') {
    return merge({}, baseConfig, devConfig)
  }
  return merge({}, baseConfig, prodConfig)
})
