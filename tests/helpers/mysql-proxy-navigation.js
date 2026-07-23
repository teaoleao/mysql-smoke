const path = require('path');
const fs = require('fs');
const { chromium, expect } = require('@playwright/test');

async function openDatabaseProxyPage(stepTimeout) {
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
  console.log('已点击“联通云”Logo。');

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
    await page.waitForLoadState('domcontentloaded');
  }
  console.log(`联通云门户页面：${page.url()}`);

  const productsEntry = page.getByText('产品', { exact: true })
    .filter({ visible: true })
    .first();
  await expect(productsEntry).toBeVisible({ timeout: stepTimeout });
  await productsEntry.click();
  console.log('已点击“产品”。');

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
  console.log('已点击“云数据库 CUDB for MySQL”。');

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
  console.log('已点击“登录控制台”。');

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
        instanceRow.locator('a').filter({ visible: true }).first(),
      );
    await expect(instanceName).toBeVisible({ timeout: stepTimeout });
  }

  await expect(instanceRow).toContainText(/mysql\s*5\.7/i, {
    timeout: stepTimeout,
  });

  const selectedName = (await instanceName.textContent())?.trim();
  await instanceName.click();
  console.log(`已进入目标实例：${selectedName || target?.instanceName || '名称未知'}`);

  const readOnlySummary = page.getByText(/只读实例\s*[：:]?\s*\d+/)
    .filter({ visible: true })
    .first();
  await expect(readOnlySummary).toBeVisible({ timeout: stepTimeout });
  const readOnlyText = (await readOnlySummary.textContent()) || '';
  const readOnlyCount = Number(readOnlyText.match(/\d+/)?.[0] || 0);
  if (readOnlyCount <= 0) {
    throw new Error('目标 mysql 5.7 实例没有只读节点，不能操作数据库代理');
  }

  const databaseProxy = page.getByText('数据库代理', { exact: true })
    .filter({ visible: true })
    .first();
  await expect(databaseProxy).toBeVisible({ timeout: stepTimeout });
  await databaseProxy.click();
  console.log('已点击“数据库代理”。');

  return {
    context,
    page,
    instanceName: selectedName || target?.instanceName || null,
  };
}

module.exports = {
  openDatabaseProxyPage,
};
