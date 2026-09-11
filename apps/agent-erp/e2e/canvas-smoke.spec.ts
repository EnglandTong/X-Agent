import { test, expect } from '@playwright/test'

test('画布：输入建单口吻 → 出现确认卡', async ({ page }) => {
  await page.goto('/')
  const input = page.getByTestId('utterance-input')
  await expect(input).toBeVisible({ timeout: 15_000 })
  await input.fill('给张三来120个A-100，下周三要')

  await page.getByTestId('send-button').click()

  const card = page.getByTestId('confirm-card')
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card.getByRole('button', { name: '确认销售订单' })).toBeVisible()
  await expect(card.getByText('张三（C001）').first()).toBeVisible()
})
