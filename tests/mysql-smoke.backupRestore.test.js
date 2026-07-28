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

    // 5. 备份提交后每隔 1 分钟刷新，最多 3 次；第一条备份状态成功后再恢复。
    let newestBackupName = '';
    let newestBackupRow = null;
    let backupVerified = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      console.log(`[备份校验][${attempt}/3] 等待 1 分钟后刷新备份列表。`);
      await page.waitForTimeout(60 * 1000);
      await page.reload({ waitUntil: 'domcontentloaded' });

      const backupRows = page.locator(
        'tbody.ant-table-tbody > tr.ant-table-row',
      ).filter({ visible: true });
      await expect(backupRows.first()).toBeVisible({ timeout: stepTimeout });
      newestBackupRow = backupRows.first();
      const rowText = ((await newestBackupRow.innerText().catch(() => '')) || '')
        .replace(/\s+/g, ' ')
        .trim();
      newestBackupName = (
        (await newestBackupRow.locator('td').first().innerText()
          .catch(() => '')) || ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      const backupSucceeded = /成\s*功/.test(rowText);
      console.log(
        `[备份校验][${attempt}/3] 第一条备份="${newestBackupName}"；`
        + `行内容="${rowText}"；是否成功=${backupSucceeded}。`,
      );

      if (backupSucceeded) {
        backupVerified = true;
        console.log(
          `[备份校验成功] 备份 ${newestBackupName} 状态为“成功”，`
          + '停止刷新并进入恢复流程。',
        );
        break;
      }
    }

    if (!backupVerified) {
      throw new Error(
        `备份校验失败：刷新 3 次后第一条备份 ${newestBackupName || '名称未知'}`
        + '仍未显示“成功”',
      );
    }

    const firstRestore = newestBackupRow.getByText('恢复', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(firstRestore).toBeVisible({ timeout: stepTimeout });
    await firstRestore.click();
    await expect(
      page.getByText('恢复备份', { exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible({ timeout: stepTimeout });

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

    // 12. 恢复提交后进入管理控制台，记录第一条“刷新中/创建中”实例的名称和 ID。
    const manageConsole = restorePage.getByRole('button', {
      name: /管理控制台/,
    }).or(
      restorePage.getByText('管理控制台', { exact: true }),
    ).filter({ visible: true }).first();
    await expect(manageConsole).toBeVisible({ timeout: stepTimeout });

    await manageConsole.click();
    let instanceListPage = null;
    await expect.poll(async () => {
      for (const candidatePage of context.pages()) {
        if (candidatePage.isClosed()) continue;
        if (!/\/console\/mysql\/main\/instancemanage(?:[/?#]|$)/i.test(
          candidatePage.url(),
        )) {
          continue;
        }
        const instanceHeader = candidatePage.getByText(/实例名称\/ID/)
          .filter({ visible: true })
          .first();
        if (await instanceHeader.isVisible().catch(() => false)) {
          instanceListPage = candidatePage;
          return true;
        }
      }
      return false;
    }, {
      timeout: stepTimeout,
      intervals: [500, 1000, 2000],
      message: '等待真正的 MySQL 实例管理列表页面出现',
    }).toBe(true);
    await instanceListPage.bringToFront();
    console.log(
      `[恢复校验] 已锁定实例列表页面，URL="${instanceListPage.url()}"；`
      + `当前所有标签页=${JSON.stringify(context.pages().map((item) => item.url()))}。`,
    );

    const firstInstanceRow = instanceListPage.locator(
      'tbody.ant-table-tbody > tr.ant-table-row',
    ).filter({ visible: true }).first();
    await expect(firstInstanceRow).toBeVisible({ timeout: stepTimeout });

    const instanceNameContainer = firstInstanceRow.locator(
      '.mysql-mysqlList-instanceName',
    ).first();
    const restoredNameIdText = (
      (await instanceNameContainer.innerText().catch(() => '')) || ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    const restoredInstanceName = restoredNameIdText
      .match(/mysql_[a-z0-9_-]+/i)?.[0] || '';
    const restoredInstanceId = (
      (await firstInstanceRow.getAttribute('data-row-key').catch(() => ''))
      || restoredNameIdText.match(/\d{10,}/)?.[0]
      || ''
    ).trim();
    const initialFirstRowText = (
      (await firstInstanceRow.innerText().catch(() => '')) || ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    const initialRestoreStatus = /刷\s*新\s*中/.test(initialFirstRowText)
      ? '刷新中'
      : (/创\s*建\s*中/.test(initialFirstRowText) ? '创建中' : '状态未知');
    console.log(
      `[恢复校验基线] 第一行="${initialFirstRowText}"；`
      + `状态=${initialRestoreStatus}；`
      + `名称=${restoredInstanceName || '灰色名称未解析，仅按第一行校验'}；`
      + `ID=${restoredInstanceId || '未解析，仅按第一行校验'}。`,
    );

    // 13. 每隔 1 分钟刷新，最多 6 次；每次重新读取列表第一行。
    let restoreVerified = false;
    let finalRestoreRowText = '';
    for (let restoreAttempt = 1; restoreAttempt <= 6; restoreAttempt += 1) {
      console.log(
        `[恢复校验][${restoreAttempt}/6] 等待 1 分钟后刷新实例列表；`
        + `记录名称=${restoredInstanceName || '未解析'}；`
        + `记录ID=${restoredInstanceId || '未解析'}；`
        + '成功标准=刷新后第一行状态为“运行中”。',
      );
      await instanceListPage.waitForTimeout(60 * 1000);
      const instanceHeaderBeforeReload = instanceListPage.getByText(
        /实例名称\/ID/,
      ).filter({ visible: true }).first();
      const isInstanceListUrl = /\/console\/mysql\/main\/instancemanage(?:[/?#]|$)/i
        .test(instanceListPage.url());
      if (
        !isInstanceListUrl
        || !await instanceHeaderBeforeReload.isVisible().catch(() => false)
      ) {
        throw new Error(
          '刷新保护触发：当前页面已经不是 MySQL 实例列表，'
          + `拒绝刷新错误页面。URL="${instanceListPage.url()}"`,
        );
      }
      console.log(
        `[恢复校验][${restoreAttempt}/6] 已确认当前是实例列表，`
        + `执行唯一一次 reload；URL="${instanceListPage.url()}"。`,
      );
      await instanceListPage.reload({ waitUntil: 'domcontentloaded' });

      // ID 只用于输出，不参与成功条件；刷新后始终重新读取当前表格第一行。
      const refreshedFirstRow = instanceListPage.locator(
        'tbody.ant-table-tbody tr[data-row-key]',
      ).first();
      const firstRowVisible = await refreshedFirstRow.waitFor({
        state: 'visible',
        timeout: 30 * 1000,
      }).then(() => true).catch(() => false);
      if (!firstRowVisible) {
        console.log(
          `[恢复校验][${restoreAttempt}/6] 刷新后等待 30 秒仍未渲染`
          + '实例列表第一行；'
          + `${restoreAttempt < 6 ? '继续下一轮。' : '已到最后一轮。'}`,
        );
        continue;
      }

      finalRestoreRowText = (
        (await refreshedFirstRow.innerText().catch(() => '')) || ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      const runningStatusTag = refreshedFirstRow.locator(
        'p.mysql-mysqlList-runningStatus-icon-one1',
      ).first();
      const runningTagVisible = await runningStatusTag.isVisible()
        .catch(() => false);
      const runningTagClass = runningTagVisible
        ? await runningStatusTag.getAttribute('class').catch(() => '')
        : '';
      const runningTagText = runningTagVisible
        ? ((await runningStatusTag.innerText().catch(() => '')) || '')
          .replace(/\s+/g, '')
          .trim()
        : '';
      const runningTextMatched = /运\s*行\s*中/.test(finalRestoreRowText);
      const runningTagMatched = runningTagVisible
        && /运行中/.test(runningTagText);
      const isRunning = runningTagMatched || runningTextMatched;
      console.log(
        `[恢复校验][${restoreAttempt}/6] 刷新后目标行="${finalRestoreRowText}"；`
        + `可见运行状态p标签=${runningTagVisible}；`
        + `p.class="${runningTagClass}"；`
        + `p.text="${runningTagText}"；`
        + `p标签匹配运行中=${runningTagMatched}；`
        + `文字匹配运行中=${runningTextMatched}；`
        + `最终状态为运行中=${isRunning}。`,
      );

      if (isRunning) {
        restoreVerified = true;
        console.log(
          `[恢复校验成功] ${restoredInstanceName || '第一行实例'}`
          + `${restoredInstanceId ? `（ID：${restoredInstanceId}）` : ''}`
          + ` 已从“${initialRestoreStatus}”变为“运行中”；`
          + `${restoredInstanceName || '该实例'} 备份恢复成功。`,
        );
        console.log(
          `[恢复校验] 已在第 ${restoreAttempt}/6 轮识别到“运行中”，`
          + '立即终止后续等待和刷新。',
        );
        break;
      }
    }

    if (!restoreVerified) {
      throw new Error(
        '恢复校验失败：每隔 1 分钟刷新，共 6 次后，'
        + '实例列表第一行仍未变为“运行中”。'
        + `记录名称=${restoredInstanceName || '未解析'}；`
        + `记录ID=${restoredInstanceId || '未解析'}；`
        + `最终读取行="${finalRestoreRowText || '未找到目标实例'}"`,
      );
    }

    await restorePage.screenshot({
      path: 'test-results/mysql-backup-restored.png',
      fullPage: true,
    });

    console.log(
      `已对实例 ${instanceName || '名称未知'} 创建备份并完成恢复校验。`,
    );
    console.log('后续页面保持打开，检查完成后请手动关闭。');
    const openPage = context.pages().find((candidate) => !candidate.isClosed());
    if (openPage) await openPage.waitForEvent('close', { timeout: 0 });
  } catch (error) {
    console.error(`[备份恢复测试失败] ${error.message}`);
    console.log('发生错误后浏览器不会自动关闭，请检查页面后手动关闭。');
    const openPage = context.pages().find((candidate) => !candidate.isClosed());
    if (openPage) await openPage.waitForEvent('close', { timeout: 0 });
  } finally {
    await context.close();
  }
});
