const path = require('path');
const fs = require('fs');
const { chromium, expect } = require('@playwright/test');
const {
  keepOnlyOneStartupPage,
  returnToMysqlInstanceList,
} = require('./browser-pages');

async function openDatabaseProxyPage(stepTimeout, options = {}) {
  const runtime = options.runtime || null;
  const userDataDir = path.resolve('.playwright/edge-profile');
  const statePath = path.resolve('.playwright/state/mysql-smoke-target.json');
  const target = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : null;

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

  if (
    runtime
    && /\/console\/mysql\/mysqldetail\/databaseagent(?:[/?#]|$)/.test(page.url())
  ) {
    console.log(
      `[串联导航复用] 当前已在数据库代理页：${page.url()}；`
      + '未重复执行首页、联通云、产品和登录控制台导航。',
    );
    return {
      context,
      page,
      instanceName: runtime.state.proxy?.instanceName
        || runtime.state.readonly?.instanceName
        || target?.instanceName
        || null,
      ownsContext: false,
    };
  }

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
  }

  const normalizeText = (text) => (text || '').replace(/\s+/g, ' ').trim();
  const triedInstanceNames = new Set();
  const recordedInstanceName = target?.readOnlyCreated === true
    ? target?.instanceName
    : null;

  for (let attempt = 1; attempt <= 12; attempt += 1) {
    let instanceNameLocator = null;
    let candidateName = null;

    if (attempt === 1 && recordedInstanceName) {
      const recordedLocator = page.getByText(recordedInstanceName, { exact: true })
        .filter({ visible: true })
        .first();
      if (await recordedLocator.isVisible({ timeout: 5000 }).catch(() => false)) {
        instanceNameLocator = recordedLocator;
        candidateName = recordedInstanceName;
        triedInstanceNames.add(candidateName);
        console.log(`[代理前序] 优先尝试记录实例：${candidateName}。`);
      } else {
        triedInstanceNames.add(recordedInstanceName);
        console.log(
          `[代理前序] 记录实例 ${recordedInstanceName} 当前列表不可见，`
          + '改为遍历当前运行中的 MySQL 5.7 实例。',
        );
      }
    }

    if (!instanceNameLocator) {
      const mysql57Types = page.getByText(/^mysql\s*5\.7$/i)
        .filter({ visible: true });
      await expect(mysql57Types.first()).toBeVisible({ timeout: stepTimeout });

      const mysql57Count = await mysql57Types.count();
      console.log(`[代理前序] 当前实例列表发现 ${mysql57Count} 个 MySQL 5.7 候选。`);

      for (let index = 0; index < mysql57Count; index += 1) {
        const row = mysql57Types.nth(index).locator('xpath=ancestor::tr[1]');
        const rowText = normalizeText(await row.textContent().catch(() => ''));
        const nameInRow = row.getByText(/^mysql_[a-z0-9_-]+$/i)
          .filter({ visible: true })
          .first()
          .or(row.locator('a').filter({ visible: true }).first());
        const nameText = normalizeText(await nameInRow.textContent().catch(() => ''));

        if (!nameText) {
          console.log(`[代理前序] 跳过第 ${index + 1} 个 MySQL 5.7：未读取到实例名称。`);
          continue;
        }
        if (triedInstanceNames.has(nameText)) {
          console.log(`[代理前序] 跳过实例 ${nameText}：本轮已经尝试过。`);
          continue;
        }

        triedInstanceNames.add(nameText);

        if (!/运行中/.test(rowText) || /创建中|创建失败/.test(rowText)) {
          console.log(
            `[代理前序] 跳过实例 ${nameText}：当前不可操作，行内容="${rowText}"。`,
          );
          continue;
        }

        instanceNameLocator = nameInRow;
        candidateName = nameText;
        break;
      }
    }

    if (!instanceNameLocator || !candidateName) {
      throw new Error(
        `未找到可进入数据库代理的 MySQL 5.7 运行中实例；已尝试：${
          [...triedInstanceNames].join('、') || '无'
        }`,
      );
    }

    console.log(`[代理前序] 尝试进入实例 ${candidateName}（第 ${attempt}/12 次）。`);
    await instanceNameLocator.click({ force: true });

    const detailReady = await expect.poll(async () => {
      const hasBasicInfo = await page
        .getByText('基本信息', { exact: true })
        .filter({ visible: true })
        .first()
        .isVisible()
        .catch(() => false);
      const hasDatabaseProxyMenu = await page
        .getByText('数据库代理', { exact: true })
        .filter({ visible: true })
        .first()
        .isVisible()
        .catch(() => false);
      return hasBasicInfo || hasDatabaseProxyMenu;
    }, {
      timeout: 30 * 1000,
      intervals: [1000],
      message: `等待实例 ${candidateName} 详情页渲染`,
    }).toBe(true).then(() => true).catch(() => false);

    if (!detailReady) {
      console.log(`[代理前序] 实例 ${candidateName} 点击后详情页未渲染，返回列表换下一个。`);
      page = await returnToMysqlInstanceList(page, stepTimeout);
      if (runtime) runtime.setPage(page);
      continue;
    }

    const databaseProxy = page.getByText('数据库代理', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(databaseProxy).toBeVisible({ timeout: stepTimeout });
    await databaseProxy.click();
    console.log(`[代理前序] 已点击实例 ${candidateName} 的“数据库代理”。`);

    const proxyPageState = await expect.poll(async () => {
      const hasUpdateProxyAccount = await page
        .getByText('更新代理账号', { exact: true })
        .filter({ visible: true })
        .first()
        .isVisible()
        .catch(() => false);
      const hasEnableProxy = await page
        .getByText('开启数据库代理', { exact: true })
        .filter({ visible: true })
        .first()
        .isVisible()
        .catch(() => false);
      const hasAddReadOnly = await page
        .getByText('创建只读实例', { exact: true })
        .filter({ visible: true })
        .first()
        .isVisible()
        .catch(() => false);
      const hasAddProxyNode = await page
        .getByText('添加代理节点', { exact: true })
        .filter({ visible: true })
        .first()
        .isVisible()
        .catch(() => false);
      const hasProxyTableHeader = await page
        .getByText('数据库代理状态', { exact: true })
        .filter({ visible: true })
        .first()
        .isVisible()
        .catch(() => false);

      if (hasUpdateProxyAccount) return 'update';
      if (hasEnableProxy) return 'enable';
      if (hasAddProxyNode || hasProxyTableHeader) return 'table';
      if (hasAddReadOnly) return 'need-readonly';
      return 'waiting';
    }, {
      timeout: 20 * 1000,
      intervals: [1000],
      message: `等待实例 ${candidateName} 的数据库代理页状态`,
    }).not.toBe('waiting').then(async () => {
      const hasUpdateProxyAccount = await page
        .getByText('更新代理账号', { exact: true })
        .filter({ visible: true })
        .first()
        .isVisible()
        .catch(() => false);
      const hasEnableProxy = await page
        .getByText('开启数据库代理', { exact: true })
        .filter({ visible: true })
        .first()
        .isVisible()
        .catch(() => false);
      const hasAddReadOnly = await page
        .getByText('创建只读实例', { exact: true })
        .filter({ visible: true })
        .first()
        .isVisible()
        .catch(() => false);
      const hasAddProxyNode = await page
        .getByText('添加代理节点', { exact: true })
        .filter({ visible: true })
        .first()
        .isVisible()
        .catch(() => false);
      const hasProxyTableHeader = await page
        .getByText('数据库代理状态', { exact: true })
        .filter({ visible: true })
        .first()
        .isVisible()
        .catch(() => false);

      return {
        hasUpdateProxyAccount,
        hasEnableProxy,
        hasAddReadOnly,
        hasAddProxyNode,
        hasProxyTableHeader,
      };
    }).catch(() => ({
      hasUpdateProxyAccount: false,
      hasEnableProxy: false,
      hasAddReadOnly: false,
      hasAddProxyNode: false,
      hasProxyTableHeader: false,
    }));

    if (
      proxyPageState.hasAddReadOnly
      && !proxyPageState.hasUpdateProxyAccount
      && !proxyPageState.hasEnableProxy
      && !proxyPageState.hasAddProxyNode
      && !proxyPageState.hasProxyTableHeader
    ) {
      console.log(`[代理前序] 实例 ${candidateName} 的代理页提示尚未创建只读实例，返回列表换下一个。`);
      page = await returnToMysqlInstanceList(page, stepTimeout);
      if (runtime) runtime.setPage(page);
      continue;
    }

    console.log(
      `[代理前序] 实例 ${candidateName} 已进入可操作数据库代理页：`
      + `更新代理账号=${proxyPageState.hasUpdateProxyAccount}，`
      + `开启数据库代理=${proxyPageState.hasEnableProxy}，`
      + `添加代理节点=${proxyPageState.hasAddProxyNode}，`
      + `代理表格=${proxyPageState.hasProxyTableHeader}。`,
    );

    return {
      context,
      page,
      instanceName: candidateName,
      ownsContext: !runtime,
    };
  }

  throw new Error(
    `连续尝试 12 次后，仍未找到可操作数据库代理的 MySQL 5.7 且含只读节点实例；已尝试：${
      [...triedInstanceNames].join('、') || '无'
    }`,
  );
}

module.exports = {
  openDatabaseProxyPage,
};
