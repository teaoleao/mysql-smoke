const path = require('path');
const { chromium, expect } = require('@playwright/test');
const {
  keepOnlyOneStartupPage,
  returnToMysqlInstanceList,
} = require('./browser-pages');

async function openRandomMysqlInstance(stepTimeout, options = {}) {
  const runtime = options.runtime || null;
  const userDataDir = path.resolve('.playwright/edge-profile');
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

  if (runtime) {
    page = await returnToMysqlInstanceList(page, stepTimeout);
    runtime.setPage(page);
    console.log(
      `[串联导航复用] 已在同一 Edge 中回到 MySQL 实例列表：${page.url()}；`
      + '未打开联通云门户、产品页或新的控制台标签。',
    );
  } else {
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

  const cloudLogo = page.locator('div.logo').first();
  await expect(cloudLogo).toBeVisible({ timeout: stepTimeout });

  const portalPagePromise = context.waitForEvent('page', {
    timeout: 10 * 1000,
  }).catch(() => null);
  await cloudLogo.click();

  const portalPage = await portalPagePromise;
  if (portalPage) {
    page = portalPage;
    await page.waitForLoadState('domcontentloaded');
  } else if (page.isClosed()) {
    const availablePages = context.pages().filter((candidate) =>
      !candidate.isClosed(),
    );
    if (!availablePages.length) {
      throw new Error('点击联通云 Logo 后未找到可用页面');
    }
    page = availablePages[availablePages.length - 1];
  }

  const productsEntry = page.getByText('产品', { exact: true })
    .filter({ visible: true })
    .first();
  await expect(productsEntry).toBeVisible({ timeout: stepTimeout });
  await productsEntry.click();

  const mysqlName = /云数据库\s*CUDB\s*for\s*MySQL/i;
  const deadline = Date.now() + stepTimeout;
  let mysqlProduct = null;

  while (!mysqlProduct && Date.now() < deadline) {
    for (const frame of page.frames()) {
      const matches = frame.getByText(mysqlName).filter({ visible: true });
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
  }

  const instanceNames = page.getByText(/^mysql_[a-z0-9_-]+$/i)
    .filter({ visible: true });
  await expect(instanceNames.first()).toBeVisible({ timeout: stepTimeout });

  const instanceCount = await instanceNames.count();
  if (!instanceCount) {
    throw new Error('MySQL 实例列表中没有可选择的实例');
  }

  const candidateIndexes = [];
  const withReadOnlyIndexes = [];
  const withoutReadOnlyIndexes = [];
  for (let index = 0; index < instanceCount; index += 1) {
    const instance = instanceNames.nth(index);
    const currentInstanceName = (await instance.textContent())?.trim()
      || `第 ${index + 1} 行`;
    const instanceRow = instance.locator('xpath=ancestor::tr[1]');
    const readOnlyExpandButton = instanceRow.locator(
      'button[aria-label="展开行"], '
      + 'button.ant-table-row-expand-icon-collapsed',
    );
    const hasReadOnlyExpandIcon = await readOnlyExpandButton.count() > 0
      && await readOnlyExpandButton.first().isVisible().catch(() => false);

    if (hasReadOnlyExpandIcon) {
      withReadOnlyIndexes.push(index);
    } else {
      withoutReadOnlyIndexes.push(index);
    }

    if (options.excludeReadOnly && hasReadOnlyExpandIcon) {
      console.log(
        `跳过实例 ${currentInstanceName}：检测到“+”展开按钮，含有只读实例。`,
      );
      continue;
    }

    candidateIndexes.push(index);
    if (options.excludeReadOnly) {
      console.log(
        `实例 ${currentInstanceName}：没有“+”展开按钮，可作为退订候选。`,
      );
    }
  }

  if (!candidateIndexes.length) {
    throw new Error('实例列表中没有符合条件的主实例');
  }

  let selectionPool = candidateIndexes;
  let selectedCategory = '全部实例';
  if (options.balanceReadOnly) {
    const preferWithReadOnly = Math.random() < 0.5;
    if (preferWithReadOnly && withReadOnlyIndexes.length) {
      selectionPool = withReadOnlyIndexes;
      selectedCategory = '含只读实例';
    } else if (!preferWithReadOnly && withoutReadOnlyIndexes.length) {
      selectionPool = withoutReadOnlyIndexes;
      selectedCategory = '不含只读实例';
    } else if (withReadOnlyIndexes.length) {
      selectionPool = withReadOnlyIndexes;
      selectedCategory = '含只读实例（另一组为空，自动回退）';
    } else {
      selectionPool = withoutReadOnlyIndexes;
      selectedCategory = '不含只读实例（另一组为空，自动回退）';
    }
    console.log(
      `50/50 随机结果：选择“${selectedCategory}”组；`
      + `含只读 ${withReadOnlyIndexes.length} 个，`
      + `不含只读 ${withoutReadOnlyIndexes.length} 个。`,
    );
  }

  const selectedCandidateIndex = Math.floor(
    Math.random() * selectionPool.length,
  );
  const randomIndex = selectionPool[selectedCandidateIndex];
  const selectedInstance = instanceNames.nth(randomIndex);
  const instanceName = (await selectedInstance.textContent())?.trim();
  if (options.openDetails === false) {
    console.log(
      `已在 ${candidateIndexes.length} 个符合条件的实例中随机锁定：`
      + `${instanceName || '名称未知'}`
      + `${options.excludeReadOnly ? '（不含只读实例）' : ''}`,
    );
  } else {
    await selectedInstance.click();
    console.log(
      `已随机选择第 ${randomIndex + 1}/${instanceCount} 个实例：`
      + `${instanceName || '名称未知'}`,
    );
  }

  return {
    context,
    page,
    instanceName: instanceName || null,
    ownsContext: !runtime,
  };
}

module.exports = {
  openRandomMysqlInstance,
};
