process.env.MYSQL_SMOKE_CHAIN_IMPORT = '1';

const { test, expect } = require('@playwright/test');
const { createMysqlRuntime } = require('../helpers/mysql-runtime');
const log = require('../helpers/workflow-logger');
const { runCreateEntity } = require('../mysql-smoke.createEntity.test');
const { runCreate57Entity } = require('../mysql-smoke.create57Entity.test');
const { runCreateOnlyReadEntity } = require('../mysql-smoke.createOnlyReadEntity.test');
const { runCreateProxy } = require('../mysql-smoke.createProxy.test');
const { runUpdateProxyAccount } = require('../mysql-smoke.updateProxyAccount.test');
const { runDeleteProxy } = require('../mysql-smoke.deleteProxy.test');
const { runBackupRestore } = require('../mysql-smoke.backupRestore.test');
const { runDownloadBackup } = require('../mysql-smoke.downloadBackup.test');
const { runDeleteBackup } = require('../mysql-smoke.deleteBackup.test');
const { runUpdateSecurityGroup } = require('../mysql-smoke.updateSecurityGroup.test');
const { runUnsubscribeInstance } = require('../mysql-smoke.unsubscribeInstance.test');

const TOTAL_SCENARIOS = 11;

test.describe.configure({ mode: 'serial', retries: 0 });

async function keepSingleWorkingPage(runtime) {
  const pages = runtime.context.pages().filter((page) => !page.isClosed());
  if (!pages.length) {
    throw new Error('唯一的 Edge 页面已被关闭，无法继续复用本次登录状态。');
  }

  const workingPage = (
    runtime.page && !runtime.page.isClosed()
      ? runtime.page
      : pages[pages.length - 1]
  );
  runtime.setPage(workingPage);

  for (const page of pages) {
    if (page !== workingPage && !page.isClosed()) {
      await page.close().catch(() => {});
    }
  }

  await workingPage.bringToFront();
  return workingPage;
}

async function enterMysqlPurchasePage(runtime) {
  const page = await keepSingleWorkingPage(runtime);
  const stepTimeout = 5 * 60 * 1000;
  const purchaseButton = page.locator(
    'button.mysql-listTop-btn, button.ant-btn-primary',
  ).filter({ hasText: '购买实例', visible: true }).first();

  await purchaseButton.waitFor({
    state: 'visible',
    timeout: stepTimeout,
  });

  const newPagePromise = runtime.context.waitForEvent('page', {
    timeout: 15 * 1000,
  }).catch(() => null);
  await purchaseButton.click();
  const newPage = await newPagePromise;
  const purchasePage = newPage || page;

  await purchasePage.waitForURL(/\/console\/mysql\/buy(?:[/?#]|$)/, {
    timeout: stepTimeout,
  });
  await purchasePage.waitForLoadState('domcontentloaded');
  await purchasePage.getByText(/^(?:MySQL\s*)?5\.7$/i)
    .filter({ visible: true })
    .last()
    .waitFor({ state: 'visible', timeout: stepTimeout });

  runtime.setPage(purchasePage);
  runtime.state.nextScenario = {
    name: '创建 MySQL 5.7 实例',
    startAtBuyPage: true,
    source: '创建 MySQL 8.0 实例校验完成后的购买实例按钮',
  };
  console.log(
    `[串联衔接成功] 已点击“购买实例”并进入购买页：${purchasePage.url()}。`,
  );
  console.log('[串联衔接成功] 第二项将直接从选择 MySQL 5.7 开始。');
}

async function enterMysql57DetailForReadOnly(runtime) {
  let page = await keepSingleWorkingPage(runtime);
  const stepTimeout = 5 * 60 * 1000;
  const instanceListUrl = page.url();
  const preferredName = runtime.state.create57?.instanceName || '';

  await page.getByText(/^mysql\s*5\.7$/i)
    .filter({ visible: true })
    .first()
    .waitFor({ state: 'visible', timeout: stepTimeout });

  const rows = page.locator('tbody.ant-table-tbody > tr.ant-table-row')
    .filter({ visible: true });
  const candidates = [];

  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const rowText = (await row.innerText()).replace(/\s+/g, ' ').trim();
    if (!/mysql\s*5\.7/i.test(rowText)) continue;
    if (!/运行中/.test(rowText)) {
      console.log(`[2->3衔接] 跳过非运行中 5.7 实例：${rowText}`);
      continue;
    }
    if (/创建中|创建失败/.test(rowText)) {
      console.log(`[2->3衔接] 跳过创建中或创建失败实例：${rowText}`);
      continue;
    }

    const link = row.getByText(/^mysql_[a-z0-9_-]+$/i)
      .filter({ visible: true })
      .first()
      .or(row.locator('a').filter({ visible: true }).first());
    if (!await link.count()) continue;

    const name = ((await link.textContent()) || '').trim();
    if (!name) continue;
    const instanceId = rowText.match(/\d{8,}/)?.[0] || null;
    candidates.push({
      name,
      instanceId,
      link,
      preferred: name === preferredName,
    });
  }

  candidates.sort((left, right) => Number(right.preferred) - Number(left.preferred));
  if (!candidates.length) {
    throw new Error('实例列表中没有可点击且状态为“运行中”的 MySQL 5.7 实例');
  }

  console.log(
    `[2->3衔接] 共找到 ${candidates.length} 个可用的运行中 MySQL 5.7 实例：`
    + `${candidates.map((item) => item.name).join('、')}。`,
  );
  if (preferredName) {
    console.log(`[2->3衔接] 优先尝试第二项刚创建的实例：${preferredName}。`);
  }

  let lastError = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      console.log(
        `[2->3衔接][${index + 1}/${candidates.length}] `
        + `尝试点击实例 ${candidate.name}。`,
      );
      await candidate.link.click({ timeout: 30 * 1000 });
      await page.waitForLoadState('domcontentloaded');

      const readOnlySummary = page.getByText(/只读实例\s*[：:]?\s*\d+/)
        .filter({ visible: true })
        .first();
      await readOnlySummary.waitFor({
        state: 'visible',
        timeout: 30 * 1000,
      });
      const summaryText = (await readOnlySummary.innerText()).trim();
      const initialReadOnlyCount = Number(
        summaryText.match(/只读实例\s*[：:]?\s*(\d+)/)?.[1],
      );
      if (!Number.isInteger(initialReadOnlyCount)) {
        throw new Error(`无法解析只读实例数量：${summaryText}`);
      }

      runtime.setPage(page);
      runtime.state.nextScenario = {
        name: '创建只读实例',
        startAtInstanceDetail: true,
        instanceName: candidate.name,
        instanceId: candidate.instanceId,
        initialReadOnlyCount,
        source: '创建 MySQL 5.7 实例校验完成后的实例列表',
      };
      console.log(
        `[2->3衔接成功] 已进入 ${candidate.name} 详情页，`
        + `当前只读实例数量=${initialReadOnlyCount}。`,
      );
      console.log('[2->3衔接成功] 第三项将直接从点击“添加”开始。');
      return;
    } catch (error) {
      lastError = error;
      console.error(
        `${log.YELLOW}[2->3衔接] 实例 ${candidate.name} 无法进入可创建`
        + `只读实例的详情页：${error.message}；继续尝试下一个。${log.RESET}`,
      );
      if (!/\/console\/mysql\/main\/instancemanage/.test(page.url())) {
        await page.goto(instanceListUrl, { waitUntil: 'domcontentloaded' });
        await page.getByText(/^mysql\s*5\.7$/i)
          .filter({ visible: true })
          .first()
          .waitFor({ state: 'visible', timeout: stepTimeout });
      }
    }
  }

  throw new Error(
    `所有运行中的 MySQL 5.7 实例均无法进入只读实例详情页：`
    + `${lastError?.message || '未知原因'}`,
  );
}

async function continueFromCreatedProxyToAccountUpdate(runtime) {
  const page = await keepSingleWorkingPage(runtime);
  const stepTimeout = 5 * 60 * 1000;
  const databaseAgentUrl = /\/console\/mysql\/mysqldetail\/databaseagent(?:[/?#]|$)/;

  if (!databaseAgentUrl.test(page.url())) {
    throw new Error(
      `第四项结束后未停留在数据库代理页面：${page.url()}`,
    );
  }

  let updateProxyAccount = null;
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      const candidate = frame.getByText('更新代理账号', { exact: true })
        .filter({ visible: true })
        .first();
      if (await candidate.isVisible().catch(() => false)) {
        updateProxyAccount = candidate;
        return true;
      }
    }
    return false;
  }, {
    timeout: stepTimeout,
    intervals: [500, 1000, 2000],
    message: '等待第四项创建完成后的“更新代理账号”入口',
  }).toBe(true);

  const instanceName = runtime.state.proxy?.instanceName || '名称未知';
  runtime.state.nextScenario = {
    name: '更新代理账号',
    startAtDatabaseProxyPage: true,
    instanceName,
    source: '第四项创建数据库代理成功后保留的同一实例代理页面',
  };
  runtime.setPage(page);

  console.log(
    `[4->5衔接成功] 实例 ${instanceName} 的数据库代理已创建完成，`
    + `当前页面=${page.url()}。`,
  );
  console.log(
    '[4->5衔接成功] 已确认“更新代理账号”入口可见；'
    + '第五项将跳过登录、实例选择、详情页和“数据库代理”菜单，'
    + '直接从点击“更新代理账号”继续。',
  );
}

async function transitionToNextScenario(runtime, completedName, nextName) {
  console.log(log.CYAN + '-'.repeat(80));
  console.log(`[串联衔接] ${completedName} -> ${nextName}`);
  console.log('[串联衔接] 当前默认动作：保留同一 Edge 和登录状态，关闭额外标签页。');
  console.log('[串联衔接] 后续可在此处加入该两项测试之间的专用页面交互。');
  console.log('-'.repeat(80) + log.RESET);
  try {
    await keepSingleWorkingPage(runtime);
    if (
      completedName === '创建 MySQL 8.0 实例'
      && nextName === '创建 MySQL 5.7 实例'
    ) {
      await enterMysqlPurchasePage(runtime);
    }
    if (
      completedName === '创建 MySQL 5.7 实例'
      && nextName === '创建只读实例'
    ) {
      await enterMysql57DetailForReadOnly(runtime);
    }
    if (
      completedName === '创建只读实例'
      && nextName === '创建数据库代理'
    ) {
      const nextScenario = runtime.state.nextScenario;
      if (
        nextScenario?.name !== '创建数据库代理'
        || !nextScenario?.startAtInstanceList
      ) {
        throw new Error('第三项未提供可复用的 MySQL 实例列表状态');
      }
      console.log(
        `[3->4衔接确认] 当前已位于实例列表，第四项将优先操作 `
        + `${nextScenario.instanceName || '刚创建只读实例的主实例'}。`,
      );
    }
    if (
      completedName === '创建数据库代理'
      && nextName === '更新代理账号'
    ) {
      await continueFromCreatedProxyToAccountUpdate(runtime);
    }
  } catch (error) {
    runtime.state.nextScenario = null;
    console.error(
      `${log.RED}[串联衔接失败] ${error.message}；`
      + `下一项“${nextName}”将回退到原有完整导航流程。${log.RESET}`,
    );
  }
}

async function executeScenario(runtime, sequence, name, runner) {
  const startedAt = Date.now();
  log.startScenario(sequence, TOTAL_SCENARIOS, name);

  try {
    await keepSingleWorkingPage(runtime);
    const result = await test.step(name, () => runner(runtime));
    if (result?.page && !result.page.isClosed()) runtime.setPage(result.page);

    const record = {
      index: sequence,
      name,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      detail: result?.detail || '',
    };
    runtime.state.results.push(record);
    log.passScenario(
      sequence,
      TOTAL_SCENARIOS,
      name,
      startedAt,
      record.detail,
    );
    return record;
  } catch (error) {
    const pages = runtime.context.pages().filter((page) => !page.isClosed());
    if (pages.length) runtime.setPage(pages[pages.length - 1]);

    const record = {
      index: sequence,
      name,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: error?.stack || error?.message || String(error),
    };
    runtime.state.results.push(record);
    log.failScenario(
      sequence,
      TOTAL_SCENARIOS,
      name,
      startedAt,
      error,
      runtime.page,
    );
    return record;
  }
}

function printSummary(runtime) {
  const passed = runtime.state.results.filter((item) => item.status === 'passed');
  const failed = runtime.state.results.filter((item) => item.status === 'failed');

  console.log(log.CYAN + log.WIDE_LINE);
  console.log(`串联执行完成：通过 ${passed.length} 项，失败 ${failed.length} 项。`);
  for (const result of runtime.state.results) {
    const color = result.status === 'passed' ? log.GREEN : log.RED;
    console.log(
      `${color}${result.status === 'passed' ? '✓' : '✗'} `
      + `${String(result.index).padStart(2, '0')}. ${result.name}${log.RESET}`,
    );
    if (result.status === 'failed') {
      console.error(`${log.RED}   ${result.error}${log.RESET}`);
    }
  }
  console.log('浏览器保持打开；检查完页面后请手动关闭 Edge。');
  console.log(log.WIDE_LINE + log.RESET);

  return { passed, failed };
}

test('MySQL 11 项冒烟测试——单 Edge、单次登录串联执行', async () => {
  test.setTimeout(0);

  // 全部场景只创建这一个 runtime：
  // 一个 persistent Edge context、一个工作页面、一份登录状态。
  const runtime = await createMysqlRuntime();

  console.log(log.CYAN + log.WIDE_LINE);
  console.log('MySQL 冒烟测试串联开始：只启动一次 Edge，只需要登录一次。');
  console.log(`运行编号：${runtime.state.runId}`);
  console.log(log.WIDE_LINE + log.RESET);

  // 01. 创建 MySQL 8.0 实例：完整逻辑位于 mysql-smoke.createEntity.test.js
  await executeScenario(runtime, 1, '创建 MySQL 8.0 实例', runCreateEntity);
  await transitionToNextScenario(
    runtime,
    '创建 MySQL 8.0 实例',
    '创建 MySQL 5.7 实例',
  );










  // 02. 创建 MySQL 5.7 实例：完整逻辑位于 mysql-smoke.create57Entity.test.js
  await executeScenario(runtime, 2, '创建 MySQL 5.7 实例', runCreate57Entity);
  await transitionToNextScenario(
    runtime,
    '创建 MySQL 5.7 实例',
    '创建只读实例',
  );










  // 03. 创建只读实例：完整逻辑位于 mysql-smoke.createOnlyReadEntity.test.js
  await executeScenario(runtime, 3, '创建只读实例', runCreateOnlyReadEntity);
  await transitionToNextScenario(
    runtime,
    '创建只读实例',
    '创建数据库代理',
  );










  // 04. 创建数据库代理：完整逻辑位于 mysql-smoke.createProxy.test.js
  await executeScenario(runtime, 4, '创建数据库代理', runCreateProxy);
  await transitionToNextScenario(
    runtime,
    '创建数据库代理',
    '更新代理账号',
  );










  // 05. 更新代理账号：完整逻辑位于 mysql-smoke.updateProxyAccount.test.js
  await executeScenario(runtime, 5, '更新代理账号', runUpdateProxyAccount);
  await transitionToNextScenario(
    runtime,
    '更新代理账号',
    '删除数据库代理',
  );










  // 06. 删除数据库代理：完整逻辑位于 mysql-smoke.deleteProxy.test.js
  await executeScenario(runtime, 6, '删除数据库代理', runDeleteProxy);
  await transitionToNextScenario(
    runtime,
    '删除数据库代理',
    '备份与恢复',
  );










  // 07. 备份与恢复：完整逻辑位于 mysql-smoke.backupRestore.test.js
  await executeScenario(runtime, 7, '备份与恢复', runBackupRestore);
  await transitionToNextScenario(
    runtime,
    '备份与恢复',
    '下载备份',
  );










  // 08. 下载备份：完整逻辑位于 mysql-smoke.downloadBackup.test.js
  await executeScenario(runtime, 8, '下载备份', runDownloadBackup);
  await transitionToNextScenario(
    runtime,
    '下载备份',
    '删除备份',
  );










  // 09. 删除备份：完整逻辑位于 mysql-smoke.deleteBackup.test.js
  await executeScenario(runtime, 9, '删除备份', runDeleteBackup);
  await transitionToNextScenario(
    runtime,
    '删除备份',
    '更换安全组',
  );










  // 10. 更换安全组：完整逻辑位于 mysql-smoke.updateSecurityGroup.test.js
  await executeScenario(runtime, 10, '更换安全组', runUpdateSecurityGroup);
  await transitionToNextScenario(
    runtime,
    '更换安全组',
    '退订实例',
  );










  // 11. 退订实例：完整逻辑位于 mysql-smoke.unsubscribeInstance.test.js
  await executeScenario(runtime, 11, '退订实例', runUnsubscribeInstance);

  const { failed } = printSummary(runtime);

  // 最终页面不自动关闭，人工检查后关闭 Edge，Playwright 才结束。
  await new Promise((resolve) => runtime.context.once('close', resolve));

  if (failed.length) {
    throw new Error(`MySQL 串联冒烟测试存在 ${failed.length} 项失败，请查看上方红色日志。`);
  }
});
