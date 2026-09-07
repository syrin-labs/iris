import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { reticle } from '@reticlehq/vite-plugin'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [
      vue(),
      // @ts-expect-error: electron-vite and standard vite Plugin types mismatch in monorepo
      reticle()
    ]
  }
})
