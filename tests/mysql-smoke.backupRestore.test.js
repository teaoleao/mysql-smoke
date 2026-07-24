const { test, expect } = require('@playwright/test');
const {
  openRandomMysqlInstance,
} = require('./helpers/mysql-instance-navigation');

test.describe.configure({ retries: 0 });

test('MySQL 备份恢复 - 创建数据备份', async () => {
  test.setTimeout(0);
  const stepTimeout = 10 * 60 * 1000;

  const {
    context,
    page,
    instanceName,
  } = await openRandomMysqlInstance(stepTimeout);

  try {
    // 1. 点击实例详情页左侧“备份恢复”。
    const backupRestore = page.getByText('备份恢复', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(backupRestore).toBeVisible({ timeout: stepTimeout });
    await backupRestore.click();

    // 2. 默认页签应为“数据备份”。
    const dataBackup = page.getByText('数据备份', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(dataBackup).toBeVisible({ timeout: stepTimeout });

    // 3. 点击“备份实例”，本次停在后续弹窗或页面。
    const backupInstance = page.getByRole('button', {
      name: '备份实例',
      exact: true,
    }).or(
      page.getByText('备份实例', { exact: true }),
    ).filter({ visible: true }).first();
    await expect(backupInstance).toBeVisible({ timeout: stepTimeout });
    await backupInstance.click();

    // 4. 在“备份实例”确认弹窗中点击“确定”。
    await page.getByRole('button', { name: /确\s*定/ }).last().click();

    // 5. 备份可能仍在配置中：每隔 30 秒刷新并重试“恢复”。
    let restoreDialogOpened = false;
    while (!restoreDialogOpened) {
      await page.waitForTimeout(30 * 1000);
      await page.reload({ waitUntil: 'domcontentloaded' });

      const firstRestore = page.getByText('恢复', { exact: true })
        .filter({ visible: true })
        .first();
      try {
        await expect(firstRestore).toBeVisible({ timeout: 25 * 1000 });
        await firstRestore.click();
      } catch {
        continue;
      }
      await page.waitForTimeout(2 * 1000);
      restoreDialogOpened = await page.getByText('恢复备份', { exact: true })
        .filter({ visible: true })
        .isVisible()
        .catch(() => false);
    }

    // 7. 恢复弹窗的按钮文字是“确认”，不是“确定”。
    const restorePagePromise = page.waitForEvent('popup', { timeout: 10_000 })
      .catch(() => null);
    await page.getByRole('button', { name: /确\s*认/ }).last().click();
    const restorePage = await restorePagePromise || page;
    await restorePage.waitForLoadState('domcontentloaded');

    // 8. 用约 10 秒匀速向下浏览恢复配置页面。
    await restorePage.bringToFront();
    for (let index = 0; index < 40; index += 1) {
      await restorePage.mouse.wheel(0, 300);
      await restorePage.waitForTimeout(250);
    }

    // 9. 点击右下角“下一步：确认配置”。
    await restorePage.getByRole('button', {
      name: /下一步\s*[:：]\s*确认配置/,
    }).last().click();

    // 10. 勾选“我已阅读并同意”前面的复选框。
    const agreementText = restorePage.getByText(/我已阅读并同意/)
      .filter({ visible: true })
      .first();
    await expect(agreementText).toBeVisible({ timeout: stepTimeout });
    await agreementText.scrollIntoViewIfNeeded();

    const agreementControl = agreementText.locator(
      'xpath=ancestor::div[contains(@class,"ant-legacy-form-item-control")][1]',
    );
    const agreementCheckbox = agreementControl.locator('input[type="checkbox"]')
      .first();
    if (await agreementCheckbox.count()) {
      if (!await agreementCheckbox.isChecked()) {
        await agreementCheckbox.check({ force: true });
      }
    } else {
      await agreementControl.locator('.ant-checkbox').first().click();
    }

    // 11. 勾选后等待 2 秒，再点击“下一步：立即开通”。
    await restorePage.waitForTimeout(2 * 1000);
    await restorePage.getByRole('button', {
      name: /下一步\s*[:：]\s*立即开通/,
    }).last().click();

    await restorePage.screenshot({
      path: 'test-results/mysql-backup-restored.png',
      fullPage: true,
    });

    console.log(`已对实例 ${instanceName || '名称未知'} 创建备份并确认恢复。`);
    console.log('后续页面保持打开，检查完成后请手动关闭。');
    await page.waitForEvent('close', { timeout: 0 });
  } finally {
    await context.close();
  }
});
