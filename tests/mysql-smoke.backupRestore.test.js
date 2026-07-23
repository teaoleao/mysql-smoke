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
    const confirmDialog = page.locator('.ant-modal-content:visible').last();
    await expect(confirmDialog).toBeVisible({ timeout: stepTimeout });
    const confirmButton = confirmDialog.locator('button:visible')
      .filter({ hasText: /^确定$/ })
      .last();
    await expect(confirmButton).toBeEnabled({ timeout: stepTimeout });
    await confirmButton.click();

    await page.screenshot({
      path: 'test-results/mysql-backup-instance-confirmed.png',
      fullPage: true,
    });

    console.log(`已对实例 ${instanceName || '名称未知'} 确认创建备份。`);
    console.log('后续页面保持打开，检查完成后请手动关闭。');
    await page.waitForEvent('close', { timeout: 0 });
  } finally {
    await context.close();
  }
});
