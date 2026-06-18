const { test, expect } = require('@playwright/test');

async function loginAsAdmin(page) {
  await page.goto('/');
  await page.fill('input[name="username"]', 'admin');
  await page.fill('input[name="password"]', 'admin123');
  await page.click('#loginForm button[type="submit"]');
  await expect(page.locator('#app')).toBeVisible();
}

test('kullanıcı kalıcı silme pasife alma değildir', async ({ page }) => {
  const suffix = Date.now();
  const username = `sil.test.${suffix}`;

  await loginAsAdmin(page);
  await page.click('nav button[data-view="users"]');
  await page.fill('#userForm input[name="username"]', username);
  await page.fill('#userForm input[name="fullName"]', 'Silinecek Test');
  await page.fill('#userForm input[name="password"]', 'Secret12a');
  await page.click('#userForm button.wide-action');
  await expect(page.locator('#status')).toContainText('Kullanıcı eklendi', { timeout: 10000 });

  const userCard = page.locator('.user-card', { hasText: username });
  await expect(userCard).toBeVisible();

  await userCard.locator('[data-user-action="delete"]').click();
  await expect(page.locator('#confirmModal')).toBeVisible();
  await page.click('#confirmModalOk');
  await expect(page.locator('#status')).toContainText('kalıcı', { timeout: 10000 });
  await expect(page.locator('.user-card', { hasText: username })).toHaveCount(0);
});