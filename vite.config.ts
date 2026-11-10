import { defineConfig } from 'vite'
import { alphaTab } from '@coderline/alphatab-vite'
export default defineConfig({ plugins: [alphaTab({ assetOutputDir: false, audioWorklets: false })], server: { host: '127.0.0.1', port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/target/**', '**/artifacts/**'] } }, clearScreen: false })
