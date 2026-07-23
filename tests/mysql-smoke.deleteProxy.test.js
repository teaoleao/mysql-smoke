const { test, expect } = require('@playwright/test');
const {
  openDatabaseProxyPage,
} = require('./helpers/mysql-proxy-navigation');

test.describe.configure({ retries: 0 });

test('删除 MySQL 5.7 数据库代理服务', async () => {
  test.setTimeout(0);
  const stepTimeout = 10 * 60 * 1000;

  const { context, page } = await openDatabaseProxyPage(stepTimeout);

  try {
    const deleteProxy = page.getByText('删除代理服务', {
      exact: true,
    }).filter({ visible: true }).first();
    await expect(deleteProxy).toBeVisible({ timeout: stepTimeout });
    await deleteProxy.click();

    const dialog = page.locator(
      '[role="dialog"]:visible, .ant-modal:visible',
    ).last();
    await expect(dialog).toBeVisible({ timeout: stepTimeout });

    // 数据库代理节点由人工选择，脚本不自动展开或选择任何节点。
    const proxyNodeSelect = dialog.locator('.ant-select')
      .filter({ visible: true })
      .first();
    await expect(proxyNodeSelect).toBeVisible({ timeout: stepTimeout });
    console.log('请在“数据库代理节点”下拉框中人工选择需要删除的节点。');

    await expect.poll(async () => {
      const selectedItems = proxyNodeSelect.locator(
        '.ant-select-selection-item',
      ).filter({ visible: true });
      if (!await selectedItems.count()) {
        return false;
      }

      const selectedText = (await selectedItems.first().textContent()) || '';
      return selectedText.trim().length > 0;
    }, {
      timeout: stepTimeout,
      message: '等待人工选择要删除的数据库代理节点',
    }).toBe(true);

    console.log('已检测到代理节点选择非空，10 秒后点击“确定”。');
    await page.waitForTimeout(10 * 1000);

    const confirmDelete = dialog.getByRole('button', {
      name: /^确\s*定$/,
    }).or(
      dialog.getByText(/^确\s*定$/, { exact: true }),
    ).filter({ visible: true }).last();
    await expect(confirmDelete).toBeVisible({ timeout: stepTimeout });
    await confirmDelete.click();
    await expect(dialog).toBeHidden({ timeout: stepTimeout });

    await page.screenshot({
      path: 'test-results/mysql57-proxy-deleted.png',
      fullPage: true,
    });

    console.log('代理删除操作已完成，页面保持打开。');
    await page.waitForEvent('close', { timeout: 0 });
  } finally {
    await context.close();
  }
});
