const { test, expect } = require('@playwright/test');

async function loginAsAdmin(page) {
  await page.goto('/');
  await page.fill('input[name="username"]', 'admin');
  await page.fill('input[name="password"]', 'admin123');
  await page.click('#loginForm button[type="submit"]');
  await expect(page.locator('#app')).toBeVisible();
}

test('admin tüm ana sayfalara geçiş yapabilir', async ({ page }) => {
  await loginAsAdmin(page);

  const views = [
    { nav: 'dashboard', section: '#dashboard', title: 'Operasyon Merkezi', heading: '#dashboard .page-hero h1' },
    { nav: 'chat', section: '#chat', title: 'Canlı Sohbet', heading: '#chat .panel h3' },
    { nav: 'personnel', section: '#personnel', title: 'Personeller', heading: '#personnel .page-header h3' },
    { nav: 'users', section: '#users', title: 'Kullanıcı Yönetimi', heading: '#users .page-header h3' },
    { nav: 'departments', section: '#departments', title: 'Departmanlar', heading: '#departments .page-header h3' },
    { nav: 'templates', section: '#templates', title: 'Şablonlar', heading: '#templates .page-header h3' },
    { nav: 'accounts', section: '#accounts', title: 'WhatsApp Hesapları', heading: '#accounts .page-header h3' },
    { nav: 'staffAudit', section: '#staffAudit', title: 'Personel Denetim', heading: '#staffAudit .page-header h3' },
    { nav: 'auditLogs', section: '#auditLogs', title: 'Denetim Günlüğü', heading: '#auditLogs .page-header h3' },
    { nav: 'cloudApi', section: '#cloudApi', title: 'Cloud API Ayarları', heading: '#cloudApi .page-header h3' }
  ];

  for (const view of views) {
    await page.click(`nav button[data-view="${view.nav}"]`);
    await expect(page.locator(view.section)).toBeVisible();
    await expect(page.locator('#viewTitle')).toHaveText(view.title);
    await expect(page.locator(view.heading)).toBeVisible();
  }
});

test('dashboard metrik kartları yüklenir', async ({ page }) => {
  await loginAsAdmin(page);
  await expect(page.locator('#reportCards .card').first()).toBeVisible({ timeout: 10000 });
});