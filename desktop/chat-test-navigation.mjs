export async function openInitialTestChat(page) {
  const button = await page.waitForFunction(() => {
    const owner = document.querySelector('.main-shell')?.dataset.ownerId;
    return owner && document.querySelector(`.chat-server-group[data-server-id="${CSS.escape(owner)}"] button[data-task-id]:not(:disabled)`);
  });
  // Test setup must not reveal, focus, or pin the sidebar to open fixture history.
  await button.evaluate(node => node.click());
  await button.dispose();
  await page.locator('.task-unified .conversation').waitFor();
}
