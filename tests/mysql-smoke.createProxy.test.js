const path = require('path');
const fs = require('fs');
const { chromium, test, expect } = require('@playwright/test');

test.describe.configure({ retries: 0 });

test('为刚创建只读节点的 MySQL 5.7 实例开启数据库代理', async () => {
  test.setTimeout(0);

  const stepTimeout = 10 * 60 * 1000;
  const userDataDir = path.resolve('.playwright/edge-profile');
  const statePath = path.resolve('.playwright/state/mysql-smoke-target.json');
  const target = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : null;

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'msedge',
    headless: false,
    locale: 'zh-CN',
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ],
  });

  const pages = context.pages();
  let page = pages[0] || await context.newPage();

  try {
    // 1. 复用持久化登录状态；失效时等待人工重新登录。
    await page.goto(process.env.BASE_URL, {
      waitUntil: 'domcontentloaded',
    });

    if (!/\/console\/home\/overview(?:[/?#]|$)/.test(page.url())) {
      console.log('登录状态已失效，请在 Edge 中手动登录。');
    }

    await page.waitForURL(/\/console\/home\/overview(?:[/?#]|$)/, {
      timeout: stepTimeout,
    });
    await expect(
      page.getByText('概览', { exact: true }).first(),
    ).toBeVisible({ timeout: stepTimeout });

    // 2. 联通云 Logo -> 产品 -> 云数据库 CUDB for MySQL。
    const cloudLogo = page.locator('div.logo').first();
    await expect(cloudLogo).toBeVisible({ timeout: stepTimeout });
    await cloudLogo.click();

    const productsEntry = page.getByText('产品', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(productsEntry).toBeVisible({ timeout: stepTimeout });
    await productsEntry.click();

    const mysqlName = /云数据库\s*CUDB\s*for\s*MySQL/i;
    const mysqlDeadline = Date.now() + stepTimeout;
    let mysqlProduct = null;

    while (!mysqlProduct && Date.now() < mysqlDeadline) {
      for (const frame of page.frames()) {
        const matches = frame.getByText(mysqlName)
          .filter({ visible: true });
        const count = await matches.count();
        if (count > 0) {
          mysqlProduct = matches.nth(count - 1);
          break;
        }
      }

      if (!mysqlProduct) {
        await page.waitForTimeout(500);
      }
    }

    if (!mysqlProduct) {
      throw new Error('未识别到“云数据库 CUDB for MySQL”产品入口');
    }

    const productPagePromise = context.waitForEvent('page', {
      timeout: 10 * 1000,
    }).catch(() => null);
    await mysqlProduct.click({ force: true });

    const productPage = await productPagePromise;
    if (productPage) {
      page = productPage;
      await page.waitForLoadState('domcontentloaded');
    }

    // 3. 点击“登录控制台”。
    const loginConsole = page.locator('span.long-hollow-button')
      .filter({ hasText: '登录控制台', visible: true })
      .first()
      .or(
        page.getByText('登录控制台', { exact: true })
          .filter({ visible: true })
          .first(),
      );
    await expect(loginConsole).toBeVisible({ timeout: stepTimeout });

    const consolePagePromise = context.waitForEvent('page', {
      timeout: stepTimeout,
    }).catch(() => null);
    await loginConsole.click();

    const consolePage = await consolePagePromise;
    if (consolePage) {
      page = consolePage;
      await page.waitForLoadState('domcontentloaded');
    }

    // 4. 有状态记录时优先定位记录的实例；否则选择第一个 mysql 5.7 实例。
    let instanceName;
    let instanceRow;
    const useRecordedTarget = Boolean(
      target?.instanceName && target?.readOnlyCreated === true,
    );

    if (useRecordedTarget) {
      instanceName = page.getByText(target.instanceName, { exact: true })
        .filter({ visible: true })
        .first();
      await expect(instanceName).toBeVisible({ timeout: stepTimeout });
      instanceRow = instanceName.locator('xpath=ancestor::tr[1]');
      console.log(`使用状态文件中的实例：${target.instanceName}`);
    } else {
      const mysql57Type = page.getByText(/^mysql\s*5\.7$/i)
        .filter({ visible: true })
        .first();
      await expect(mysql57Type).toBeVisible({ timeout: stepTimeout });
      instanceRow = mysql57Type.locator('xpath=ancestor::tr[1]');
      instanceName = instanceRow.getByText(/^mysql_[a-z0-9_-]+$/i)
        .filter({ visible: true })
        .first()
        .or(
          instanceRow.locator('a')
            .filter({ visible: true })
            .first(),
        );
      await expect(instanceName).toBeVisible({ timeout: stepTimeout });
      console.log('没有可用状态记录，选择列表中第一个 mysql 5.7 实例。');
    }

    await expect(instanceRow).toContainText(/mysql\s*5\.7/i, {
      timeout: stepTimeout,
    });

    if (useRecordedTarget && target?.instanceId) {
      const rowText = await instanceRow.innerText();
      const visibleId = rowText.match(/\d{8,}/)?.[0];
      if (visibleId && !target.instanceId.startsWith(visibleId)) {
        throw new Error(
          `实例ID不一致，期望 ${target.instanceId}，页面显示 ${visibleId}`,
        );
      }
    }

    const selectedName = (await instanceName.textContent())?.trim();
    await instanceName.click();
    console.log(`已进入目标实例：${selectedName || target?.instanceName || '名称未知'}`);

    // 5. 独立验证该实例确实已有只读节点，数量必须大于 0。
    const readOnlySummary = page.getByText(/只读实例\s*[：:]?\s*\d+/)
      .filter({ visible: true })
      .first();
    await expect(readOnlySummary).toBeVisible({ timeout: stepTimeout });

    const readOnlyText = (await readOnlySummary.textContent()) || '';
    const readOnlyCount = Number(readOnlyText.match(/\d+/)?.[0] || 0);
    if (readOnlyCount <= 0) {
      throw new Error('目标 mysql 5.7 实例没有只读节点，不能执行数据库代理冒烟测试');
    }
    console.log(`已验证目标实例包含 ${readOnlyCount} 个只读节点。`);

    // 6. 点击左侧栏“数据库代理”。
    const databaseProxy = page.getByText('数据库代理', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(databaseProxy).toBeVisible({ timeout: stepTimeout });
    await databaseProxy.click();

    // 7. 根据当前代理状态选择入口：
    //    没有代理记录时点击“开启数据库代理”；
    //    已有代理记录时点击“添加代理节点”。
    const enableProxy = page.getByRole('button', {
      name: '开启数据库代理',
      exact: true,
    }).or(
      page.getByText('开启数据库代理', { exact: true }),
    ).filter({ visible: true }).first();

    const addProxyNode = page.getByText('添加代理节点', { exact: true })
      .filter({ visible: true })
      .first();

    await expect.poll(async () => {
      return await enableProxy.isVisible().catch(() => false)
        || await addProxyNode.isVisible().catch(() => false);
    }, {
      timeout: stepTimeout,
      message: '等待“开启数据库代理”或“添加代理节点”入口出现',
    }).toBe(true);

    if (await enableProxy.isVisible().catch(() => false)) {
      await enableProxy.scrollIntoViewIfNeeded();
      await enableProxy.click();
      console.log('当前没有代理记录，已点击“开启数据库代理”。');
    } else {
      await addProxyNode.scrollIntoViewIfNeeded();
      await addProxyNode.click();
      console.log('当前已有代理记录，已点击“添加代理节点”。');
    }

    // 8. 两个入口后续使用相同流程：等待人工输入账号和密码。
    const passwordInput = page.locator('input[type="password"]')
      .filter({ visible: true })
      .first();
    await expect(passwordInput).toBeVisible({ timeout: stepTimeout });
    console.log('请在代理配置页面中手动输入账号和密码。');

    await expect.poll(async () => {
      const value = await passwordInput.inputValue();
      return value.trim().length > 0;
    }, {
      timeout: stepTimeout,
      message: '等待代理配置密码填写完成',
    }).toBe(true);

    console.log('已检测到密码框非空，10 秒后点击确认按钮。');
    await page.waitForTimeout(10 * 1000);

    // 9. 在当前弹窗中点击“确定”；兼容无 dialog role 的 Ant Design 弹窗。
    const visibleDialog = page.locator(
      '[role="dialog"]:visible, .ant-modal:visible',
    ).last();
    const actionScope = await visibleDialog.count() ? visibleDialog : page;
    let confirmAction = actionScope.getByRole('button', {
      name: /^(?:确\s*定|确认|确认开启|提交)$/,
    }).or(
      actionScope.getByText(/^(?:确\s*定|确认|确认开启|提交)$/, {
        exact: true,
      }),
    ).filter({ visible: true }).last();

    // 某些弹窗按钮没有可访问名称，退回到弹窗中最后一个主按钮。
    if (!await confirmAction.count()) {
      confirmAction = actionScope.locator(
        'button.ant-btn-primary, button.ant-btn-dangerous, button',
      ).filter({ visible: true }).last();
    }

    await expect(confirmAction).toBeVisible({ timeout: stepTimeout });
    const confirmBox = await confirmAction.boundingBox();
    if (!confirmBox) {
      throw new Error('已找到代理配置“确定”按钮，但无法取得点击位置');
    }
    await page.mouse.click(
      confirmBox.x + confirmBox.width / 2,
      confirmBox.y + confirmBox.height / 2,
    );

    if (await visibleDialog.count()) {
      await expect(visibleDialog).toBeHidden({ timeout: stepTimeout });
    }
    console.log('密码非空并等待 10 秒后，已点击代理配置“确定”按钮。');
    await page.waitForTimeout(3 * 1000);

    // 10. 确认后等待 20 秒，再点击“备份实例”右侧的刷新图标。
    console.log('等待 20 秒后刷新代理节点状态。');
    await page.waitForTimeout(20 * 1000);

    const backupInstance = page.getByText('备份实例', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(backupInstance).toBeVisible({ timeout: stepTimeout });
    await backupInstance.scrollIntoViewIfNeeded();

    const backupBox = await backupInstance.boundingBox();
    if (!backupBox) {
      throw new Error('已找到“备份实例”，但无法取得其页面位置');
    }

    const refreshCandidates = page.locator(
      'button, [role="button"], [title*="刷新"], [aria-label*="刷新"], '
      + '.anticon-reload, .anticon-sync, svg',
    ).filter({ visible: true });

    let refreshControl = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    const backupRight = backupBox.x + backupBox.width;
    const backupCenterY = backupBox.y + backupBox.height / 2;

    for (let index = 0; index < await refreshCandidates.count(); index += 1) {
      const candidate = refreshCandidates.nth(index);
      const box = await candidate.boundingBox();
      if (!box) continue;

      const candidateCenterY = box.y + box.height / 2;
      const horizontalDistance = box.x - backupRight;
      const verticalDistance = Math.abs(candidateCenterY - backupCenterY);

      if (
        horizontalDistance >= 0
        && horizontalDistance <= 250
        && verticalDistance <= 60
        && horizontalDistance < nearestDistance
      ) {
        refreshControl = candidate;
        nearestDistance = horizontalDistance;
      }
    }

    if (!refreshControl) {
      throw new Error('未找到“备份实例”右侧的刷新图标');
    }

    await refreshControl.click({ force: true });
    console.log('已点击“备份实例”右侧的刷新图标。');
    await page.waitForTimeout(3 * 1000);

    await page.screenshot({
      path: 'test-results/mysql57-proxy-refreshed.png',
      fullPage: true,
    });

    console.log('代理配置页面保持打开，检查完成后请手动关闭。');
    await page.waitForEvent('close', { timeout: 0 });
  } finally {
    await context.close();
  }
});
