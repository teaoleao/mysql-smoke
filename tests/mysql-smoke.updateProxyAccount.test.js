const { test, expect } = require('@playwright/test');
const {
  openDatabaseProxyPage,
} = require('./helpers/mysql-proxy-navigation');

test.describe.configure({ retries: 0 });

async function runUpdateProxyAccount(runtime = null) {
  test.setTimeout(0);
  const stepTimeout = 10 * 60 * 1000;

  const {
    context,
    page,
    instanceName: initialInstanceName,
  } = await openDatabaseProxyPage(stepTimeout, { runtime });

  try {
    const attemptedInstances = new Set(
      initialInstanceName ? [initialInstanceName] : [],
    );
    let currentInstanceName = initialInstanceName || '名称未知';
    let updateProxyAccount = null;

    const findVisibleAcrossFrames = async (text) => {
      for (const frame of page.frames()) {
        const candidate = frame.getByText(text, { exact: true })
          .filter({ visible: true })
          .first();
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      }
      return null;
    };

    while (!updateProxyAccount) {
      console.log(
        `[更新代理账号] 开始检查实例 ${currentInstanceName} 的代理状态。`,
      );
      updateProxyAccount = await findVisibleAcrossFrames('更新代理账号');
      if (updateProxyAccount) {
        console.log(
          `[更新代理账号] 实例 ${currentInstanceName} 已有数据库代理，`
          + '找到“更新代理账号”。',
        );
        break;
      }

      const noProxyMessage = await findVisibleAcrossFrames(
        '您尚未开启数据库代理服务',
      );
      const enableProxy = await findVisibleAcrossFrames('开启数据库代理');
      const createReadOnly = await findVisibleAcrossFrames('创建只读实例');
      if (!noProxyMessage && !enableProxy && !createReadOnly) {
        console.log(
          `[更新代理账号] 实例 ${currentInstanceName} 的代理页面仍在渲染，`
          + '等待“更新代理账号”、空代理提示或“创建只读实例”提示出现。',
        );
        await expect.poll(async () => {
          updateProxyAccount = await findVisibleAcrossFrames('更新代理账号');
          return Boolean(updateProxyAccount)
            || Boolean(await findVisibleAcrossFrames('您尚未开启数据库代理服务'))
            || Boolean(await findVisibleAcrossFrames('开启数据库代理'))
            || Boolean(await findVisibleAcrossFrames('创建只读实例'));
        }, {
          timeout: stepTimeout,
          message: '等待数据库代理状态页面渲染完成',
        }).toBe(true);
        if (updateProxyAccount) continue;
      }

      if (createReadOnly || await findVisibleAcrossFrames('创建只读实例')) {
        console.log(
          `[更新代理账号] 实例 ${currentInstanceName} 尚未创建只读实例，`
          + '无法更新代理账号，返回实例列表并更换实例。',
        );
      }

      console.log(
        `[更新代理账号] 实例 ${currentInstanceName} 当前没有数据库代理，`
        + '返回实例列表并更换实例。',
      );

      const returnToList = await findVisibleAcrossFrames('返回实例列表');
      if (!returnToList) {
        throw new Error('当前实例没有数据库代理，但未找到“返回实例列表”入口');
      }
      await returnToList.click();
      console.log(
        `[更新代理账号] 已从实例 ${currentInstanceName} 返回实例列表，`
        + '等待 MySQL 5.7 实例行重新渲染。',
      );

      const mysql57Types = page.getByText(/^mysql\s*5\.7$/i)
        .filter({ visible: true });
      await expect(mysql57Types.first()).toBeVisible({ timeout: stepTimeout });

      let nextInstanceName = '';
      let nextInstanceLink = null;
      for (let index = 0; index < await mysql57Types.count(); index += 1) {
        const row = mysql57Types.nth(index).locator('xpath=ancestor::tr[1]');
        const nameLink = row.getByText(/^mysql_[a-z0-9_-]+$/i)
          .filter({ visible: true })
          .first()
          .or(row.locator('a').filter({ visible: true }).first());
        const name = ((await nameLink.textContent().catch(() => '')) || '')
          .trim();
        if (name && !attemptedInstances.has(name)) {
          nextInstanceName = name;
          nextInstanceLink = nameLink;
          break;
        }
      }

      if (!nextInstanceLink) {
        throw new Error(
          `已尝试实例 ${Array.from(attemptedInstances).join('、')}，`
          + '未找到其他尚未检查的 MySQL 5.7 实例',
        );
      }

      attemptedInstances.add(nextInstanceName);
      currentInstanceName = nextInstanceName;
      console.log(`[更新代理账号] 切换到实例 ${nextInstanceName}。`);
      await nextInstanceLink.click();

      let databaseProxy = null;
      await expect.poll(async () => {
        databaseProxy = await findVisibleAcrossFrames('数据库代理');
        return Boolean(databaseProxy);
      }, {
        timeout: stepTimeout,
        intervals: [500, 1000, 2000],
        message: `等待实例 ${nextInstanceName} 的“数据库代理”菜单完成渲染`,
      }).toBe(true);

      console.log(
        `[更新代理账号] 实例 ${nextInstanceName} 详情页已完成渲染，`
        + '准备点击“数据库代理”。',
      );
      await databaseProxy.click();
      await expect.poll(async () => (
        Boolean(await findVisibleAcrossFrames('更新代理账号'))
        || Boolean(await findVisibleAcrossFrames('您尚未开启数据库代理服务'))
        || Boolean(await findVisibleAcrossFrames('开启数据库代理'))
        || Boolean(await findVisibleAcrossFrames('创建只读实例'))
      ), {
        timeout: stepTimeout,
        intervals: [500, 1000, 2000],
        message: `等待实例 ${nextInstanceName} 的数据库代理页面完成渲染`,
      }).toBe(true);
      console.log(
        `[更新代理账号] 已进入实例 ${nextInstanceName} 的数据库代理页面，`
        + '回到循环重新判断该实例是否已有代理。',
      );
      updateProxyAccount = null;
    }

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

    console.log(
      `[更新代理校验] 实例 ${currentInstanceName} 的代理账号更新已提交，`
      + '等待 5 秒后仅刷新一次数据库代理页面。',
    );
    await page.waitForTimeout(5 * 1000);
    await page.reload({ waitUntil: 'domcontentloaded' });

    let runningStatusTag = null;
    await expect.poll(async () => {
      for (const frame of page.frames()) {
        const statusTags = frame.locator(
          'p[class*="mysql-mysqlList-runningStatus-icon"]',
        );
        const tagCount = await statusTags.count();
        for (let index = 0; index < tagCount; index += 1) {
          const tag = statusTags.nth(index);
          if (!await tag.isVisible().catch(() => false)) continue;

          runningStatusTag = {
            frameUrl: frame.url(),
            className: await tag.getAttribute('class').catch(() => ''),
            parentText: ((await tag.locator('xpath=..').innerText()
              .catch(() => '')) || '')
              .replace(/\s+/g, ' ')
              .trim(),
          };
          return true;
        }
      }
      return false;
    }, {
      timeout: 30 * 1000,
      intervals: [500, 1000, 2000],
      message: `等待实例 ${currentInstanceName} 的数据库代理状态显示为“运行中”`,
    }).toBe(true);

    console.log(
      `[更新代理校验] 已直接识别到数据库代理“运行中”状态标签：`
      + `${JSON.stringify(runningStatusTag)}。`,
    );
    console.log(
      `[更新代理校验成功] 实例 ${currentInstanceName} 的数据库代理状态为运行中，`
      + '更新代理账号冒烟测试成功。',
    );

    await page.screenshot({
      path: 'test-results/mysql57-proxy-account-updated.png',
      fullPage: true,
    });

    console.log('代理账号更新操作已完成，页面保持打开。');
    if (runtime) {
      runtime.setPage(page);
      runtime.state.proxy = {
        ...(runtime.state.proxy || {}),
        instanceName: currentInstanceName,
        status: '运行中',
        accountUpdated: true,
      };
      return {
        page,
        detail: `实例 ${currentInstanceName} 代理账号更新成功`,
      };
    }
    await page.waitForEvent('close', { timeout: 0 });
  } finally {
    if (!runtime) await context.close();
  }
}

if (process.env.MYSQL_SMOKE_CHAIN_IMPORT !== '1') {
  test('更新 MySQL 5.7 数据库代理账号', async () => {
    await runUpdateProxyAccount();
  });
}

module.exports = {
  runUpdateProxyAccount,
};
