// Exercise the same navigation links as the desktop UI; never touch live IPC.
export async function openSettings(page, { server = 'legacy', tab = 'general', page: destination = 'server' } = {}) {
  const setup = page.getByRole('dialog', { name: 'Server setup', exact: true });
  if (await setup.isVisible()) await setup.getByRole('button', { name: 'Close server setup', exact: true }).click();
  await page.locator(page.viewportSize().width <= 780 ? '.app-shell.sidebar-overlay' : '.app-shell.sidebar-push').waitFor();
  if (await page.locator('.web-sidebar').getAttribute('aria-hidden') === 'true') {
    await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  }
  await page.locator('#app-sidebar[data-motion="open"]').waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-link-list a[href="#settings/servers"]').waitFor();
  if (destination === 'home') return;
  if (destination === 'appearance') {
    await page.locator('.settings-link-list a[href="#settings/appearance"]').click();
    await page.getByRole('heading', { name: 'Appearance', level: 1, exact: true }).waitFor();
    return;
  }
  await page.locator('.settings-link-list a[href="#settings/servers"]').click();
  await page.locator('.server-settings-list').waitFor();
  if (destination === 'servers') return;
  if (destination === 'add') {
    await page.getByRole('link', { name: 'Add server', exact: true }).click();
    await page.getByRole('heading', { name: 'Add server', level: 1, exact: true }).waitFor();
    await setup.getByRole('button', { name: 'Connect with a URL', exact: true }).click();
    return;
  }
  await page.locator(`.server-settings-list a[data-server-id="${server}"]`).click();
  await page.locator('.server-settings-tabs').waitFor();
  if (tab !== 'general') await serverTab(page, tab);
}
export async function serverTab(page, tab) {
  await page.locator(`.server-settings-tabs a[href$="/${tab}"]`).click();
  await page.locator(`.server-settings-tabs a[aria-current="page"][href$="/${tab}"]`).waitFor();
}
