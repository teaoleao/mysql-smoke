const { test, expect } = require('@playwright/test');
const {
  openDatabaseProxyPage,
} = require('./helpers/mysql-proxy-navigation');

test.describe.configure({ retries: 0 });

test('更新 MySQL 5.7 数据库代理账号', async () => {
  test.setTimeout(0);
  const stepTimeout = 10 * 60 * 1000;

  const { context, page } = await openDatabaseProxyPage(stepTimeout);

  try {
    const updateProxyAccount = page.getByText('更新代理账号', {
      exact: true,
    }).filter({ visible: true }).first();
    await expect(updateProxyAccount).toBeVisible({ timeout: stepTimeout });
    await updateProxyAccount.click();

    const passwordInput = page.locator('input[type="password"]')
      .filter({ visible: true })
      .first();
    await expect(passwordInput).toBeVisible({ timeout: stepTimeout });
    console.log('请手动输入数据库密码。');

    await expect.poll(async () => {
      const value = await passwordInput.inputValue();
      return value.trim().length > 0;
    }, {
      timeout: stepTimeout,
      message: '等待更新代理账号密码填写完成',
    }).toBe(true);

    console.log('已检测到密码非空，10 秒后点击“确定”。');
    await page.waitForTimeout(10 * 1000);

    const dialog = page.locator(
      '[role="dialog"]:visible, .ant-modal:visible',
    ).last();
    const scope = await dialog.count() ? dialog : page;
    const confirmButton = scope.getByRole('button', {
      name: /^确\s*定$/,
    }).or(
      scope.getByText(/^确\s*定$/, { exact: true }),
    ).filter({ visible: true }).last();

    await expect(confirmButton).toBeVisible({ timeout: stepTimeout });
    await confirmButton.click();
    if (await dialog.count()) {
      await expect(dialog).toBeHidden({ timeout: stepTimeout });
    }

    await page.screenshot({
      path: 'test-results/mysql57-proxy-account-updated.png',
      fullPage: true,
    });

    console.log('代理账号更新操作已完成，页面保持打开。');
    await page.waitForEvent('close', { timeout: 0 });
  } finally {
    await context.close();
  }
});
