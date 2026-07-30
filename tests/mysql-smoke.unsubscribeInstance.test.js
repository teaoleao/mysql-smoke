const { test, expect } = require('@playwright/test');
const {
  openRandomMysqlInstance,
} = require('./helpers/mysql-instance-navigation');

test.describe.configure({ retries: 0 });

async function runUnsubscribeInstance(runtime = null) {
  test.setTimeout(0);
  const stepTimeout = 10 * 60 * 1000;

  const {
    context,
    page,
    instanceName,
  } = await openRandomMysqlInstance(stepTimeout, {
    openDetails: false,
    runtime,
  });

  try {
    if (!instanceName) {
      throw new Error('未获得待退订实例名称');
    }

    const instanceLink = page.getByText(instanceName, { exact: true })
      .filter({ visible: true })
      .first();
    await expect(instanceLink).toBeVisible({ timeout: stepTimeout });

    let targetRow = instanceLink.locator('xpath=ancestor::tr[1]');
    await expect(targetRow).toBeVisible({ timeout: stepTimeout });

    const expandButton = targetRow.locator(
      'button[aria-label="展开行"], '
      + 'button.ant-table-row-expand-icon-collapsed',
    ).first();
    const hasReadOnlyInstance = await expandButton.count() > 0
      && await expandButton.isVisible().catch(() => false);

    let unsubscribeTargetName = instanceName;
    if (hasReadOnlyInstance) {
      console.log(
        `实例 ${instanceName} 含有只读实例，展开后执行只读实例退订。`,
      );
      await expandButton.click();

      const readOnlyNames = page.getByText(
        /^readonly_[a-z0-9_-]+$/i,
      ).filter({ visible: true });
      await expect(readOnlyNames.first()).toBeVisible({
        timeout: stepTimeout,
      });

      const readOnlyCount = await readOnlyNames.count();
      const readOnlyName = readOnlyNames.nth(
        Math.floor(Math.random() * readOnlyCount),
      );
      unsubscribeTargetName = (
        await readOnlyName.textContent()
      )?.trim() || '只读实例';
      targetRow = readOnlyName.locator('xpath=ancestor::tr[1]');
      await expect(targetRow).toBeVisible({ timeout: stepTimeout });

      const readOnlyCheckbox = targetRow.locator(
        'input[type="checkbox"]',
      ).first();
      await expect(readOnlyCheckbox).toBeAttached({
        timeout: stepTimeout,
      });
      if (await readOnlyCheckbox.isEnabled()) {
        if (!await readOnlyCheckbox.isChecked()) {
          await readOnlyCheckbox.check();
        }
        await expect(readOnlyCheckbox).toBeChecked({
          timeout: stepTimeout,
        });
        console.log(`已勾选只读实例 ${unsubscribeTargetName}。`);
      } else {
        console.log(
          `只读实例 ${unsubscribeTargetName} 的复选框被页面禁用，`
          + '跳过勾选并直接使用该行“更多”执行退订。',
        );
      }
    } else {
      console.log(
        `实例 ${instanceName} 不含只读实例，执行主实例退订。`,
      );
    }

    const moreButton = targetRow.getByText('更多', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(moreButton).toBeVisible({ timeout: stepTimeout });
    await moreButton.click();
    console.log(`已打开实例 ${unsubscribeTargetName} 的“更多”菜单。`);

    const unsubscribeItem = page.getByText('退订', { exact: true })
      .filter({ visible: true })
      .last();
    await expect(unsubscribeItem).toBeVisible({ timeout: stepTimeout });

    const unsubscribePagePromise = context.waitForEvent('page', {
      timeout: 10 * 1000,
    }).catch(() => null);
    await unsubscribeItem.click();
    console.log(`已点击实例 ${unsubscribeTargetName} 的“退订”入口。`);

    const openedPage = await unsubscribePagePromise;
    const unsubscribePage = openedPage || page;
    await unsubscribePage.waitForLoadState('domcontentloaded');

    const submitButton = unsubscribePage.getByText('确定提交', {
      exact: true,
    }).filter({ visible: true }).last();
    await expect(submitButton).toBeVisible({ timeout: stepTimeout });

    const recycleBinText = unsubscribePage.getByText('移入回收站', {
      exact: true,
    }).filter({ visible: true }).first();
    await expect(recycleBinText).toBeVisible({ timeout: stepTimeout });

    // const recycleBinCheckbox = unsubscribePage.locator(
    //   'input[type="checkbox"]',
    // ).first();
    // await expect(recycleBinCheckbox).toBeAttached({ timeout: stepTimeout });
    // if (!await recycleBinCheckbox.isChecked()) {
    //   await recycleBinText.click();
    // }
    // await expect(recycleBinCheckbox).toBeChecked({ timeout: stepTimeout });
    // console.log('已勾选“移入回收站”。');

    console.log('3 秒后点击“确定提交”。');
    await unsubscribePage.waitForTimeout(3 * 1000);
    await submitButton.click();
    console.log(`已提交实例 ${unsubscribeTargetName} 的退订申请。`);

    console.log('退订提交操作已完成，页面保持打开供人工检查。');
    if (runtime) {
      runtime.setPage(unsubscribePage);
      runtime.state.unsubscribe = {
        instanceName,
        targetName: unsubscribeTargetName,
      };
      return {
        page: unsubscribePage,
        detail: `已提交退订：${unsubscribeTargetName}`,
      };
    }
    await new Promise((resolve) => context.once('close', resolve));
  } catch (error) {
    console.error(`实例退订入口测试失败：${error.message}`);
    console.log('发生错误后浏览器不会自动关闭，请检查页面后手动关闭。');
    if (!runtime) {
      await new Promise((resolve) => context.once('close', resolve));
    }
    throw error;
  }
}

if (process.env.MYSQL_SMOKE_CHAIN_IMPORT !== '1') {
  test('MySQL 实例退订入口冒烟测试', async () => {
    await runUnsubscribeInstance();
  });
}

module.exports = {
  runUnsubscribeInstance,
};
