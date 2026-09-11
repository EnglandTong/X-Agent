import { defineConfig } from '@playwright/test'

const port = process.env.PORT ?? '3001'
const baseURL = process.env.BASE_URL ?? `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL,
    headless: true,
    locale: 'zh-CN',
  },
  webServer: process.env.SKIP_WEB_SERVER
    ? undefined
    : {
        command: 'npm run serve',
        url: `${baseURL}/api/health`,
        reuseExistingServer: true,
        timeout: 120_000,
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
          PORT: port,
        },
      },
})
