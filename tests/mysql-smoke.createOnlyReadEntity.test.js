const path = require('path');
const fs = require('fs');
const { chromium, test, expect } = require('@playwright/test');
const {
  keepOnlyOneStartupPage,
} = require('./helpers/browser-pages');

test.describe.configure({ retries: 0 });

async function runCreateOnlyReadEntity(runtime = null) {
  // 最终实例详情页保持打开，直到人工关闭。
  test.setTimeout(0);

  const stepTimeout = 10 * 60 * 1000;
  const userDataDir = path.resolve('.playwright/edge-profile');
  const stateDir = path.resolve('.playwright/state');
  const statePath = path.join(stateDir, 'mysql-smoke-target.json');
  let targetState = null;

  const context = runtime?.context
    || await chromium.launchPersistentContext(userDataDir, {
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

  let page = runtime?.page && !runtime.page.isClosed()
    ? runtime.page
    : await keepOnlyOneStartupPage(context);

  try {
    let selectedName = null;
    let instanceId = null;
    const startAtInstanceDetail = Boolean(
      runtime?.state?.nextScenario?.startAtInstanceDetail,
    );

    if (startAtInstanceDetail) {
      selectedName = runtime.state.nextScenario.instanceName || null;
      instanceId = runtime.state.nextScenario.instanceId || null;
      targetState = {
        instanceName: selectedName,
        instanceId,
        databaseVersion: 'mysql 5.7',
        readOnlyCreated: false,
        selectedAt: new Date().toISOString(),
      };
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify(targetState, null, 2),
        'utf8',
      );
      console.log(
        `[创建只读串联入口] 已复用实例 ${selectedName || '名称未知'} `
        + '的详情页，跳过登录、产品导航、控制台入口和实例选择。',
      );
      runtime.state.nextScenario = null;
    } else {
    // 1. 打开控制台。登录状态有效时会自动进入概览页；
    //    登录失效时等待人工完成登录。
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
    console.log('已进入联通云控制台概览页。');

    // 2. 点击已确认 DOM 为 div.logo 的联通云 Logo。
    const cloudLogo = page.locator('div.logo').first();
    await expect(cloudLogo).toBeVisible({ timeout: stepTimeout });
    await cloudLogo.click();

    // 3. 点击门户顶部的“产品”。
    const productsEntry = page.getByText('产品', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(productsEntry).toBeVisible({ timeout: stepTimeout });
    await productsEntry.click();

    // 4. 点击“云数据库 CUDB for MySQL”。
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
    console.log(`已进入 MySQL 产品页：${page.url()}`);

    // 5. 本用例不购买新实例，点击“登录控制台”。
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
    console.log(`已进入 MySQL 控制台：${page.url()}`);

    // 6. 等待实例列表中出现数据库类型为 mysql 5.7 的记录。
    const mysql57Type = page.getByText(/^mysql\s*5\.7$/i)
      .filter({ visible: true })
      .first();
    await expect(mysql57Type).toBeVisible({ timeout: stepTimeout });

    const instanceRow = mysql57Type.locator('xpath=ancestor::tr[1]');
    await expect(instanceRow).toBeVisible({ timeout: stepTimeout });

    // 7. 点击同一行中蓝色的实例名称。
    const instanceName = instanceRow.getByText(/^mysql_[a-z0-9_-]+$/i)
      .filter({ visible: true })
      .first()
      .or(
        instanceRow.locator('a')
          .filter({ visible: true })
          .first(),
      );
    await expect(instanceName).toBeVisible({ timeout: stepTimeout });

    selectedName = (await instanceName.textContent())?.trim();
    if (!selectedName) {
      throw new Error('已找到 MySQL 5.7 实例行，但无法读取实例名称');
    }
    const instanceRowText = await instanceRow.innerText();
    instanceId = instanceRowText.match(/\d{8,}/)?.[0] || null;

    targetState = {
      instanceName: selectedName || null,
      instanceId,
      databaseVersion: 'mysql 5.7',
      readOnlyCreated: false,
      selectedAt: new Date().toISOString(),
    };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(targetState, null, 2), 'utf8');
    console.log(`已记录目标实例：${selectedName || '名称未知'} / ${instanceId || 'ID未知'}`);

    await instanceName.click();
    console.log(`已点击 MySQL 5.7 实例：${selectedName || '未读取到名称'}`);
    }

    // 8. 等待实例详情页出现“只读实例：数字”。
    //    无论当前是 0 还是正数，本用例都继续点击“添加”创建新的只读实例。
    await page.waitForLoadState('domcontentloaded');
    const readOnlySummary = page.getByText(/只读实例\s*[：:]?\s*\d+/)
      .filter({ visible: true })
      .first();
    await expect(readOnlySummary).toBeVisible({ timeout: stepTimeout });
    const initialReadOnlyText = await readOnlySummary.innerText();
    const initialReadOnlyMatch = initialReadOnlyText.match(
      /只读实例\s*[：:]?\s*(\d+)/,
    );
    if (!initialReadOnlyMatch) {
      throw new Error(
        `无法从详情页读取创建前只读实例数量：${initialReadOnlyText}`,
      );
    }
    const initialReadOnlyCount = Number(initialReadOnlyMatch[1]);
    targetState.initialReadOnlyCount = initialReadOnlyCount;
    fs.writeFileSync(statePath, JSON.stringify(targetState, null, 2), 'utf8');
    console.log(
      `[创建只读校验] 主实例=${selectedName || '名称未知'}，`
      + `创建前只读实例数量=${initialReadOnlyCount}。`,
    );

    await page.screenshot({
      path: 'test-results/mysql57-instance-detail.png',
      fullPage: true,
    });

    // 9. 当前页面只有一个“添加”，点击它进入只读实例配置页。
    const addReadOnly = page.getByText('添加', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(addReadOnly).toBeVisible({ timeout: stepTimeout });

    const readOnlyPagePromise = context.waitForEvent('page', {
      timeout: 10 * 1000,
    }).catch(() => null);
    await addReadOnly.click();

    const readOnlyPage = await readOnlyPagePromise;
    if (readOnlyPage) {
      page = readOnlyPage;
      await page.waitForLoadState('domcontentloaded');
    }
    console.log(`已点击“添加”，只读实例配置页：${page.url()}`);

    // 某些入口会先进入只读产品页，需要再点击“创建数据库只读实例”
    // 才会真正进入配置页面。
    const createReadOnlyButton = page.getByRole('button', {
      name: '创建数据库只读实例',
      exact: true,
    }).or(
      page.getByText('创建数据库只读实例', { exact: true }),
    ).filter({ visible: true }).first();
    const needsSecondEntryClick = await createReadOnlyButton.waitFor({
      state: 'visible',
      timeout: 15 * 1000,
    }).then(() => true).catch(() => false);

    if (needsSecondEntryClick) {
      const configPagePromise = context.waitForEvent('page', {
        timeout: 10 * 1000,
      }).catch(() => null);
      await createReadOnlyButton.click({ force: true });
      const configPage = await configPagePromise;
      if (configPage) {
        page = configPage;
        await page.waitForLoadState('domcontentloaded');
      }
      console.log(
        `已自动点击“创建数据库只读实例”，当前配置页：${page.url()}`,
      );
    } else {
      console.log(
        '未出现“创建数据库只读实例”中间按钮，当前页面已直接进入配置流程。',
      );
    }

    // 10. 等待页面渲染后，从顶部开始自然浏览配置。
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3 * 1000);
    await page.keyboard.press('Home');
    await page.waitForTimeout(1000);

    // 平滑向下浏览并停留阅读，每 5 次向上回看一小段，直到真正到达底部。
    for (let index = 0; index < 50; index += 1) {
      const reachedBottom = await page.evaluate(() => {
        const scrollingElement = document.scrollingElement;
        if (!scrollingElement) return false;
        return scrollingElement.scrollTop + window.innerHeight
          >= scrollingElement.scrollHeight - 5;
      });

      if (reachedBottom) {
        break;
      }

      const scrollDistance = index > 0 && index % 5 === 0 ? -140 : 280;
      await page.evaluate((distance) => {
        window.scrollBy({
          top: distance,
          behavior: 'smooth',
        });
      }, scrollDistance);

      // 下滑后停留阅读，上滑回看时停留稍短。
      await page.waitForTimeout(scrollDistance > 0 ? 1100 : 700);
    }

    // 11. 点击底部“下一步：确认配置”。
    const confirmReadOnlyConfig = page.getByRole('button', {
      name: /下一步\s*[：:]\s*确认配置/,
    }).or(
      page.getByText(/下一步\s*[：:]\s*确认配置/, { exact: true }),
    ).filter({ visible: true }).first();
    await expect(confirmReadOnlyConfig).toBeVisible({ timeout: stepTimeout });

    const configUrl = page.url();
    await confirmReadOnlyConfig.click();
    await Promise.race([
      page.waitForURL((url) => url.toString() !== configUrl, {
        timeout: stepTimeout,
      }),
      expect(confirmReadOnlyConfig).toBeHidden({ timeout: stepTimeout }),
    ]);

    await page.screenshot({
      path: 'test-results/mysql57-readonly-confirm-page.png',
      fullPage: true,
    });

    console.log('已点击只读实例的“下一步：确认配置”。');

    // 12. 在确认页至少用 12 秒匀速向下浏览完整配置，再操作服务协议。
    await page.waitForLoadState('domcontentloaded');
    await page.keyboard.press('Home');
    await page.waitForTimeout(1000);
    await page.evaluate(() => new Promise((resolve) => {
      const scrollingElement = document.scrollingElement;
      if (!scrollingElement) {
        resolve();
        return;
      }

      const startY = scrollingElement.scrollTop;
      const targetY = Math.max(
        scrollingElement.scrollHeight - window.innerHeight,
        startY,
      );
      const duration = 12 * 1000;
      const startTime = performance.now();

      const scrollStep = (currentTime) => {
        const progress = Math.min((currentTime - startTime) / duration, 1);
        scrollingElement.scrollTop = startY + (targetY - startY) * progress;

        if (progress < 1) {
          requestAnimationFrame(scrollStep);
        } else {
          resolve();
        }
      };

      requestAnimationFrame(scrollStep);
    }));
    console.log('确认页已完成 12 秒匀速向下浏览。');

    // 13. 在最新确认页勾选“服务协议”右侧的正方形复选框。
    const serviceAgreement = page.getByText(/服务协议/)
      .filter({ visible: true })
      .last();
    await expect(serviceAgreement).toBeVisible({ timeout: stepTimeout });
    await serviceAgreement.scrollIntoViewIfNeeded();

    const serviceArea = serviceAgreement.locator(
      'xpath=ancestor::*[contains(@class,"ant-legacy-form-item-control") or contains(@class,"form-item")][1]',
    );
    let serviceCheckbox = serviceArea.locator('input[type="checkbox"]')
      .filter({ visible: true })
      .first();

    if (!await serviceCheckbox.count()) {
      serviceCheckbox = page.locator('input[type="checkbox"]')
        .filter({ visible: true })
        .last();
    }

    await expect(serviceCheckbox).toBeVisible({ timeout: stepTimeout });
    if (!await serviceCheckbox.isChecked()) {
      await serviceCheckbox.check({ force: true });
    }
    await expect(serviceCheckbox).toBeChecked();
    console.log('已勾选服务协议。');

    // 勾选协议后间隔 2 秒，再点击“下一步：立即开通”。
    await page.waitForTimeout(2 * 1000);
    const activateReadOnly = page.getByRole('button', {
      name: /下一步\s*[：:]\s*立即开通/,
    }).or(
      page.getByText(/下一步\s*[：:]\s*立即开通/, { exact: true }),
    ).filter({ visible: true }).first();
    await expect(activateReadOnly).toBeVisible({ timeout: stepTimeout });

    await activateReadOnly.click();

    // 15. “立即开通”会弹出支付确认框，必须继续点击“确认支付”。
    const confirmPayment = page.getByRole('button', {
      name: /确认支付/,
    }).or(
      page.getByText('确认支付', { exact: true }),
    ).filter({ visible: true }).first();
    await expect(confirmPayment).toBeVisible({ timeout: stepTimeout });
    await page.waitForTimeout(2 * 1000);

    const paymentUrl = page.url();
    const paymentPagePromise = context.waitForEvent('page', {
      timeout: 10 * 1000,
    }).catch(() => null);
    await confirmPayment.click();
    console.log('已点击“确认支付”。');

    const paymentPage = await paymentPagePromise;
    if (paymentPage) {
      page = paymentPage;
      await page.waitForLoadState('domcontentloaded');
    } else {
      await Promise.race([
        page.waitForURL((url) => url.toString() !== paymentUrl, {
          timeout: stepTimeout,
        }),
        expect(confirmPayment).toBeHidden({ timeout: stepTimeout }),
      ]);
    }

    targetState.readOnlyCreated = true;
    targetState.readOnlyCreatedAt = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify(targetState, null, 2), 'utf8');
    console.log(`只读实例创建状态已保存：${statePath}`);

    await page.screenshot({
      path: 'test-results/mysql57-readonly-activated.png',
      fullPage: true,
    });

    console.log('已完成“下一步：立即开通”和“确认支付”。');

    const managementConsoleButton = page.getByText(
      '管理控制台',
      { exact: true },
    ).filter({ visible: true }).last();
    await expect(managementConsoleButton).toBeVisible({
      timeout: stepTimeout,
    });

    const managementPagePromise = context.waitForEvent('page', {
      timeout: 10 * 1000,
    }).catch(() => null);
    await managementConsoleButton.click();
    const openedManagementPage = await managementPagePromise;
    const managementPage = openedManagementPage || page;
    await managementPage.waitForLoadState('domcontentloaded');
    const instanceListUrl = managementPage.url();
    console.log(
      `[创建只读校验] 已点击“管理控制台”，`
      + `15秒后刷新并重新检查主实例 ${selectedName || '名称未知'}。`,
    );

    await managementPage.waitForTimeout(15 * 1000);
    await managementPage.reload({ waitUntil: 'domcontentloaded' });
    console.log('[创建只读校验] 15秒等待结束，实例列表已刷新。');

    const verificationInstance = managementPage.getByText(
      selectedName,
      { exact: true },
    ).filter({ visible: true }).first();
    await expect(verificationInstance).toBeVisible({
      timeout: stepTimeout,
    });
    await verificationInstance.click();
    await managementPage.waitForLoadState('domcontentloaded');
    console.log(
      `[创建只读校验] 已重新进入主实例 ${selectedName || '名称未知'}。`,
    );

    const refreshedReadOnlySummary = managementPage.getByText(
      /只读实例\s*[：:]?\s*\d+/,
    ).filter({ visible: true }).first();
    await expect(refreshedReadOnlySummary).toBeVisible({
      timeout: stepTimeout,
    });
    const refreshedReadOnlyText = await refreshedReadOnlySummary.innerText();
    const refreshedReadOnlyMatch = refreshedReadOnlyText.match(
      /只读实例\s*[：:]?\s*(\d+)/,
    );
    if (!refreshedReadOnlyMatch) {
      throw new Error(
        `无法从刷新后的详情页读取只读实例数量：${refreshedReadOnlyText}`,
      );
    }

    const refreshedReadOnlyCount = Number(refreshedReadOnlyMatch[1]);
    const expectedReadOnlyCount = initialReadOnlyCount + 1;
    const countIncreasedByOne = refreshedReadOnlyCount
      === expectedReadOnlyCount;
    console.log(
      `[创建只读校验] 主实例=${selectedName || '名称未知'}，`
      + `创建前=${initialReadOnlyCount}，刷新后=${refreshedReadOnlyCount}，`
      + `预期=${expectedReadOnlyCount}，`
      + `是否增加1=${countIncreasedByOne}。`,
    );
    if (!countIncreasedByOne) {
      throw new Error(
        `[创建只读校验失败] 主实例 ${selectedName || '名称未知'} `
        + `创建前只读数量=${initialReadOnlyCount}，`
        + `15秒后数量=${refreshedReadOnlyCount}，`
        + `预期=${expectedReadOnlyCount}`,
      );
    }

    targetState.verifiedReadOnlyCount = refreshedReadOnlyCount;
    targetState.readOnlyVerifiedAt = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify(targetState, null, 2), 'utf8');
    console.log(
      `[创建只读校验成功] 主实例 ${selectedName || '名称未知'} `
      + `的只读实例数量已从 ${initialReadOnlyCount} 增加到 `
      + `${refreshedReadOnlyCount}。`,
    );

    if (runtime) {
      console.log(
        `[3->4衔接] 只读实例校验完成，正在返回同一 Edge 中的实例列表：`
        + `${instanceListUrl}。`,
      );
      await managementPage.goto(instanceListUrl, {
        waitUntil: 'domcontentloaded',
        timeout: stepTimeout,
      });
      await managementPage.getByText(/^mysql\s*5\.7$/i)
        .filter({ visible: true })
        .first()
        .waitFor({ state: 'visible', timeout: stepTimeout });
      console.log(
        `[3->4衔接成功] 已回到实例列表；第四项将优先使用主实例 `
        + `${selectedName || '名称未知'} 创建数据库代理。`,
      );
    }

    console.log('最终页面将保持打开。');
    console.log('检查完成后请手动关闭该页面。');

    if (runtime) {
      runtime.setPage(managementPage);
      runtime.state.readonly = {
        instanceName: selectedName,
        countBefore: initialReadOnlyCount,
        countAfter: refreshedReadOnlyCount,
      };
      runtime.state.nextScenario = {
        name: '创建数据库代理',
        startAtInstanceList: true,
        instanceName: selectedName,
        instanceListUrl,
        source: '创建只读实例成功页的“管理控制台”',
      };
      return {
        page: managementPage,
        detail: `${selectedName} 只读实例数 ${initialReadOnlyCount} → ${refreshedReadOnlyCount}`,
      };
    }
    await managementPage.waitForEvent('close', { timeout: 0 });
  } finally {
    if (!runtime) await context.close();
  }
}

if (process.env.MYSQL_SMOKE_CHAIN_IMPORT !== '1') {
  test('MySQL 5.7 创建只读实例冒烟测试', async () => {
    await runCreateOnlyReadEntity();
  });
}

module.exports = {
  runCreateOnlyReadEntity,
};
