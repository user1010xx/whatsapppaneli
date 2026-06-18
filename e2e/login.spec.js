const { test, expect } = require('@playwright/test');

test('giriş ekranı ve admin oturumu', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.login-brand h1')).toContainText('WhatsApp Personel Paneli');
  await expect(page.locator('.login-card h2')).toContainText('Oturum aç');
  await page.fill('input[name="username"]', 'admin');
  await page.fill('input[name="password"]', 'admin123');
  await page.click('#loginForm button[type="submit"]');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#me')).toContainText('Sistem Admini');
});