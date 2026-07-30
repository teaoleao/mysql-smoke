const { test, expect } = require('@playwright/test');
const {
  openDatabaseProxyPage,
} = require('./helpers/mysql-proxy-navigation');

test.describe.configure({ retries: 0 });

async function runDeleteProxy(runtime = null) {
  test.setTimeout(0);
  const stepTimeout = 10 * 60 * 1000;

  const {
    context,
    page,
    instanceName: initialInstanceName = '名称未知',
  } = await openDatabaseProxyPage(stepTimeout, { runtime });

  try {
    let currentInstanceName = initialInstanceName;
    const readProxyAddresses = async () => {
      const addresses = new Set();
      for (const frame of page.frames()) {
        const addressTexts = frame.getByText(
          /^\s*(?:\d{1,3}\.){3}\d{1,3}\s*\(代理节点IP\)\s*$/,
        ).filter({ visible: true });
        const count = await addressTexts.count();
        for (let index = 0; index < count; index += 1) {
          const text = ((await addressTexts.nth(index).innerText()
            .catch(() => '')) || '')
            .replace(/\s+/g, ' ')
            .trim();
          const ip = text.match(/(?:\d{1,3}\.){3}\d{1,3}/)?.[0];
          if (ip) addresses.add(ip);
        }
      }
      return Array.from(addresses);
    };

    const findVisibleAcrossFrames = async (text) => {
      for (const frame of page.frames()) {
        const candidate = frame.getByText(text, { exact: true })
          .filter({ visible: true })
          .first();
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
      return null;
    };

    let addressesBeforeDelete = [];
    let deleteProxy = null;
    for (let instanceAttempt = 1; instanceAttempt <= 10; instanceAttempt += 1) {
      addressesBeforeDelete = await readProxyAddresses();
      deleteProxy = await findVisibleAcrossFrames('删除代理服务');
      console.log(
        `[删除代理实例筛选][${instanceAttempt}/10] 实例=${currentInstanceName}；`
        + `读写分离地址=${addressesBeforeDelete.join('、') || '空'}；`
        + `是否存在“删除代理服务”=${Boolean(deleteProxy)}。`,
      );

      if (addressesBeforeDelete.length > 0 && deleteProxy) {
        console.log(
          `[删除代理实例筛选] 已锁定可删除实例 ${currentInstanceName}。`,
        );
        break;
      }

      if (instanceAttempt === 10) break;
      console.log(
        `[删除代理实例筛选] 实例 ${currentInstanceName} 没有可删除代理，`
        + '返回实例列表并切换到下一个 MySQL 5.7 实例。',
      );
      const returnToList = await findVisibleAcrossFrames('返回实例列表');
      if (!returnToList) {
        throw new Error(
          `实例 ${currentInstanceName} 没有可删除代理，且未找到“返回实例列表”`,
        );
      }
      await returnToList.click();

      const mysql57Types = page.getByText(/^mysql\s*5\.7$/i)
        .filter({ visible: true });
      await expect(mysql57Types.first()).toBeVisible({ timeout: stepTimeout });
      const mysql57Count = await mysql57Types.count();
      if (!mysql57Count) {
        throw new Error('实例列表中没有 MySQL 5.7 实例；MySQL 8.0 不参与删除代理测试');
      }

      const candidateIndex = instanceAttempt % mysql57Count;
      const candidateRow = mysql57Types.nth(candidateIndex)
        .locator('xpath=ancestor::tr[1]');
      const candidateLink = candidateRow.getByText(/^mysql_[a-z0-9_-]+$/i)
        .filter({ visible: true })
        .first()
        .or(candidateRow.locator('a').filter({ visible: true }).first());
      await expect(candidateLink).toBeVisible({ timeout: stepTimeout });
      currentInstanceName = (
        (await candidateLink.textContent()) || `第${candidateIndex + 1}个5.7实例`
      ).trim();
      await expect(candidateRow).toContainText(/mysql\s*5\.7/i, {
        timeout: stepTimeout,
      });
      console.log(
        `[删除代理实例筛选] 第 ${instanceAttempt + 1} 次将检查 `
        + `MySQL 5.7 实例 ${currentInstanceName}；已明确排除 MySQL 8.0。`,
      );
      await candidateLink.click();

      let databaseProxy = null;
      await expect.poll(async () => {
        databaseProxy = await findVisibleAcrossFrames('数据库代理');
        return Boolean(databaseProxy);
      }, {
        timeout: stepTimeout,
        intervals: [500, 1000, 2000],
        message: `等待实例 ${currentInstanceName} 的“数据库代理”菜单`,
      }).toBe(true);
      await databaseProxy.click();
      await page.waitForTimeout(1000);
    }

    if (!addressesBeforeDelete.length || !deleteProxy) {
      throw new Error(
        '删除代理实例筛选失败：已检查 10 次 MySQL 5.7 实例，'
        + '仍未找到同时具有读写分离地址和“删除代理服务”的实例',
      );
    }
    console.log(
      `[删除代理校验] 删除前读写分离地址共 ${addressesBeforeDelete.length} 个：`
      + `${addressesBeforeDelete.join('、')}。`,
    );

    await expect(deleteProxy).toBeVisible({ timeout: stepTimeout });
    await deleteProxy.click();

    const dialog = page.locator(
      '[role="dialog"]:visible, .ant-modal:visible',
    ).last();
    await expect(dialog).toBeVisible({ timeout: stepTimeout });

    const proxyNodeSelect = dialog.locator('.ant-select')
      .filter({ visible: true })
      .first();
    await expect(proxyNodeSelect).toBeVisible({ timeout: stepTimeout });
    console.log(
      '[删除代理操作] 请人工打开“数据库代理节点”下拉框并选择要删除的节点。',
    );

    let selectedProxyNodeText = '';
    await expect.poll(async () => {
      const selectedItems = proxyNodeSelect.locator(
        '.ant-select-selection-item, .ant-select-selection-selected-value',
      ).filter({ visible: true });
      if (!await selectedItems.count()) return false;
      selectedProxyNodeText = (
        (await selectedItems.first().innerText().catch(() => '')) || ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      return selectedProxyNodeText.length > 0;
    }, {
      timeout: stepTimeout,
      message: '等待人工选择要删除的数据库代理节点',
    }).toBe(true);

    const selectedProxyIp = selectedProxyNodeText
      .match(/(?:\d{1,3}\.){3}\d{1,3}/)?.[0] || '';
    const targetAddress = addressesBeforeDelete.includes(selectedProxyIp)
      ? selectedProxyIp
      : (addressesBeforeDelete.length === 1 ? addressesBeforeDelete[0] : '');
    console.log(
      `[删除代理操作] 实例=${currentInstanceName}；`
      + `人工选择的代理节点="${selectedProxyNodeText}"；`
      + `将删除的读写分离地址=${targetAddress || '未能唯一映射'}。`,
    );

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

    console.log(
      `[删除代理操作] 已提交删除：实例=${currentInstanceName}；`
      + `代理节点="${selectedProxyNodeText}"；`
      + `目标地址=${targetAddress || '无法唯一映射，将按地址数量减少判断'}。`,
    );

    let deleteVerified = false;
    let finalAddresses = addressesBeforeDelete;
    console.log(
      '[删除代理校验基线] '
      + `实例=${currentInstanceName}；`
      + `本次删除节点="${selectedProxyNodeText}"；`
      + `本次需要确认消失的地址=${targetAddress || '通过地址数量减少判断'}；`
      + `删除前全部地址=[${addressesBeforeDelete.join('、')}]。`,
    );
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      console.log(
        `[删除代理校验][${attempt}/5] 目标=${targetAddress || selectedProxyNodeText}；`
        + '等待 1 分钟后执行 page.reload()。',
      );
      await page.waitForTimeout(60 * 1000);
      await page.reload({ waitUntil: 'domcontentloaded' });
      console.log(
        `[删除代理校验][${attempt}/5] page.reload() 已完成，`
        + '开始重新读取“读写分离地址”。',
      );

      finalAddresses = await readProxyAddresses();
      let noProxyService = false;
      for (const frame of page.frames()) {
        const emptyMessage = frame.getByText(
          '您尚未开启数据库代理服务',
          { exact: true },
        ).filter({ visible: true });
        if (await emptyMessage.count()) {
          noProxyService = true;
          break;
        }
      }

      const targetDisappeared = targetAddress
        ? !finalAddresses.includes(targetAddress)
        : finalAddresses.length < addressesBeforeDelete.length;
      const singleProxyDeleted = addressesBeforeDelete.length === 1
        && (finalAddresses.length === 0 || noProxyService);

      console.log(
        `[删除代理校验][${attempt}/5] 删除对象="${selectedProxyNodeText}"；`
        + `目标地址=${targetAddress || '按数量判断'}；`
        + `刷新前=[${addressesBeforeDelete.join('、')}]；`
        + `刷新后=[${finalAddresses.join('、') || '空'}]；`
        + `空代理页面=${noProxyService}；`
        + `目标地址已消失=${targetDisappeared}；`
        + `单地址已清空=${singleProxyDeleted}。`,
      );

      if (targetDisappeared || singleProxyDeleted) {
        deleteVerified = true;
        console.log(
          `[删除代理校验成功] 第 ${attempt} 次 page.reload() 后确认删除成功：`
          + `实例=${currentInstanceName}；`
          + `删除节点="${selectedProxyNodeText}"；`
          + `${targetAddress ? `地址 ${targetAddress} 已从页面消失` : '读写分离地址数量已减少'}；`
          + `刷新后剩余地址=[${finalAddresses.join('、') || '空'}]。`,
        );
        break;
      }

      console.log(
        `[删除代理校验][${attempt}/5] 目标地址仍存在，`
        + `${attempt < 5 ? '继续下一轮校验。' : '已达到最大轮询次数。'}`,
      );
    }

    if (!deleteVerified) {
      throw new Error(
        '删除代理校验失败：5 次 page.reload() 后目标读写分离地址仍未消失。'
        + `删除节点=${selectedProxyNodeText}；`
        + `删除前=${addressesBeforeDelete.join('、')}；`
        + `最终=${finalAddresses.join('、') || '空'}；`
        + `目标=${targetAddress || '未唯一映射'}`,
      );
    }

    await page.screenshot({
      path: 'test-results/mysql57-proxy-deleted.png',
      fullPage: true,
    });

    console.log('代理删除操作及结果校验均已成功，页面保持打开。');
    if (runtime) {
      runtime.setPage(page);
      runtime.state.proxy = {
        ...(runtime.state.proxy || {}),
        instanceName: currentInstanceName,
        deletedAddress: targetAddress,
        deleted: true,
      };
      return {
        page,
        detail: `实例 ${currentInstanceName} 的代理 ${targetAddress || selectedProxyNodeText} 已删除`,
      };
    }
    await page.waitForEvent('close', { timeout: 0 });
  } catch (error) {
    console.error(`[删除代理测试失败] ${error.message}`);
    console.log('删除代理测试失败，但浏览器不会自动关闭，请检查后手动关闭。');
    if (!runtime && !page.isClosed()) {
      await page.waitForEvent('close', { timeout: 0 });
    }
    throw error;
  } finally {
    if (!runtime) await context.close();
  }
}

if (process.env.MYSQL_SMOKE_CHAIN_IMPORT !== '1') {
  test('删除 MySQL 5.7 数据库代理服务', async () => {
    await runDeleteProxy();
  });
}

module.exports = {
  runDeleteProxy,
};
