const { test, expect } = require('@playwright/test');
const {
  openRandomMysqlInstance,
} = require('./helpers/mysql-instance-navigation');

test.describe.configure({ retries: 0 });

test('MySQL 备份实例 - 删除保存时间最长的可删除备份', async () => {
  test.setTimeout(0);
  const stepTimeout = 10 * 60 * 1000;

  const {
    context,
    page,
    instanceName,
  } = await openRandomMysqlInstance(stepTimeout);

  const checkedInstances = new Set();
  if (instanceName) checkedInstances.add(instanceName);

  try {
    let selectedInstanceName = instanceName;
    let deleteBackup = null;

    while (!deleteBackup) {
      // 1. 进入当前实例的“备份恢复”页面。
      const backupRestore = page.getByText('备份恢复', { exact: true })
        .filter({ visible: true })
        .first();
      await expect(backupRestore).toBeVisible({ timeout: stepTimeout });
      await backupRestore.click();

      await expect(
        page.getByText('数据备份', { exact: true })
          .filter({ visible: true })
          .first(),
      ).toBeVisible({ timeout: stepTimeout });

      // 2. “删除”只出现在允许人工删除的备份上。
      const deleteActions = page.getByText('删除', { exact: true })
        .filter({ visible: true });
      await page.waitForTimeout(3 * 1000);
      const deleteCount = await deleteActions.count();

      if (deleteCount > 0) {
        // 页面由新到旧排列，最后一个“删除”对应保存时间最长的可删除备份。
        deleteBackup = deleteActions.last();
        break;
      }

      console.log(
        `实例 ${selectedInstanceName || '名称未知'} 没有可删除备份，返回实例列表继续查找。`,
      );

      // 3. 当前实例没有备份，返回列表并选择一个尚未检查的实例。
      const backToInstances = page.getByText('返回实例列表', { exact: true })
        .filter({ visible: true })
        .first();
      await expect(backToInstances).toBeVisible({ timeout: stepTimeout });
      await backToInstances.click();

      const instanceLinks = page.getByText(/^mysql_[a-z0-9_-]+$/i)
        .filter({ visible: true });
      await expect(instanceLinks.first()).toBeVisible({ timeout: stepTimeout });

      const availableNames = [];
      const instanceCount = await instanceLinks.count();
      for (let index = 0; index < instanceCount; index += 1) {
        const name = (await instanceLinks.nth(index).textContent())?.trim();
        if (name && !checkedInstances.has(name)) availableNames.push(name);
      }

      if (!availableNames.length) {
        console.log('所有 MySQL 实例均已检查，没有找到可删除的备份。');
        return;
      }

      const nextIndex = Math.floor(Math.random() * availableNames.length);
      selectedInstanceName = availableNames[nextIndex];
      checkedInstances.add(selectedInstanceName);

      const nextInstance = page.getByText(selectedInstanceName, { exact: true })
        .filter({ visible: true })
        .first();
      await expect(nextInstance).toBeVisible({ timeout: stepTimeout });
      await nextInstance.click();
      console.log(`继续检查实例：${selectedInstanceName}`);
    }

    // 4. 点击页面最下面一条可删除备份的“删除”。
    await expect(deleteBackup).toBeVisible({ timeout: stepTimeout });
    await deleteBackup.scrollIntoViewIfNeeded();
    await deleteBackup.click();

    // 5. 确认删除。
    const confirmDialog = page.locator('.ant-modal-content:visible').last();
    await expect(confirmDialog).toBeVisible({ timeout: stepTimeout });
    const confirmDelete = confirmDialog.getByRole('button', {
      name: /确\s*(定|认)/,
    }).last();
    await expect(confirmDelete).toBeVisible({ timeout: stepTimeout });
    await confirmDelete.click();

    console.log(
      `已删除实例 ${selectedInstanceName || '名称未知'} 中保存时间最长的可删除备份。`,
    );
    console.log('页面保持打开，检查完成后请手动关闭。');
    await page.waitForEvent('close', { timeout: 0 });
  } finally {
    await context.close();
  }
});
