const path = require('path');
const fs = require('fs');
const { chromium, test, expect } = require('@playwright/test');
const {
  keepOnlyOneStartupPage,
} = require('./helpers/browser-pages');

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

  let page = await keepOnlyOneStartupPage(context);

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

    const readProxyTableSnapshot = async ({ diagnostic = true } = {}) => {
      let proxyTable = null;
      const tableDiagnostics = [];
      let proxyFrameUrl = '';

      for (const frame of page.frames()) {
        const visibleTables = frame.locator('div.ant-table:visible');
        const visibleTableCount = await visibleTables.count();
        if (!visibleTableCount) {
          tableDiagnostics.push(
            `frame="${frame.url()}"{visibleTable=0}`,
          );
          continue;
        }

        for (let index = 0; index < visibleTableCount; index += 1) {
          const table = visibleTables.nth(index);
          const hasProxyStatusHeader = await table.getByText(
            '数据库代理状态',
            { exact: true },
          ).count() > 0;
          const dataRowCount = await table.locator(
            'tbody.ant-table-tbody > tr.ant-table-row[data-row-key]',
          ).count();
          tableDiagnostics.push(
            `frame="${frame.url()}" table#${index}`
            + `{代理状态表头=${hasProxyStatusHeader}, dataRow=${dataRowCount}}`,
          );
          if (hasProxyStatusHeader) {
            proxyTable = table;
            proxyFrameUrl = frame.url();
            break;
          }
        }
        if (proxyTable) break;
      }

      if (diagnostic) {
        console.log(
          '[创建代理表格诊断] '
          + (tableDiagnostics.join('；') || '所有 frame 均未发现可见表格'),
        );
      }
      if (!proxyTable) return { count: 0, rows: [] };
      if (diagnostic) {
        console.log(`[创建代理表格诊断] 已选中 frame="${proxyFrameUrl}"。`);
      }

      const rowLocator = proxyTable.locator(
        'tbody.ant-table-tbody > tr.ant-table-row[data-row-key]',
      );
      const rows = [];
      for (let index = 0; index < await rowLocator.count(); index += 1) {
        const row = rowLocator.nth(index);
        if (!await row.isVisible().catch(() => false)) continue;

        const text = ((await row.innerText().catch(() => '')) || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!text || /暂无数据/.test(text)) continue;

        const identity = ((await row.locator('td').first().innerText()
          .catch(() => '')) || '')
          .replace(/\s+/g, ' ')
          .trim();
        const statusCell = row.locator('td').nth(1);
        const statusText = ((await statusCell.innerText().catch(() => '')) || '')
          .replace(/\s+/g, ' ')
          .trim();
        const hasRunningStatusClass = await statusCell.locator(
          'p.mysql-mysqlList-runningStatus-icon-one1',
        ).count() > 0;
        rows.push({
          identity,
          text,
          status: /运行中/.test(statusText) || hasRunningStatusClass
            ? '运行中'
            : (/创建中/.test(statusText) ? '创建中' : '未知'),
        });
      }

      return { count: rows.length, rows };
    };

    // 4. 收集全部 MySQL 5.7 实例；状态文件中的实例优先，其余实例依次作为容量回退。
    const instanceListUrl = page.url();
    const mysql57Rows = page.getByText(/^mysql\s*5\.7$/i)
      .filter({ visible: true });
    await expect(mysql57Rows.first()).toBeVisible({ timeout: stepTimeout });

    const candidateNames = [];
    for (let index = 0; index < await mysql57Rows.count(); index += 1) {
      const row = mysql57Rows.nth(index).locator('xpath=ancestor::tr[1]');
      const name = ((await row.getByText(/^mysql_[a-z0-9_-]+$/i)
        .filter({ visible: true })
        .first()
        .textContent()
        .catch(() => '')) || '').trim();
      if (name && !candidateNames.includes(name)) candidateNames.push(name);
    }

    if (
      target?.instanceName
      && candidateNames.includes(target.instanceName)
    ) {
      candidateNames.splice(candidateNames.indexOf(target.instanceName), 1);
      candidateNames.unshift(target.instanceName);
    }

    if (!candidateNames.length) {
      throw new Error('实例列表中没有可用于创建代理的 MySQL 5.7 实例');
    }
    console.log(
      `[代理容量回退] 共发现 ${candidateNames.length} 个 MySQL 5.7 候选实例：`
      + candidateNames.join('、'),
    );

    let selectedName = '';
    let initialProxySnapshot = null;
    let passwordInput = null;
    let proxyInteractionRoot = page;

    for (const candidateName of candidateNames) {
      if (page.url() !== instanceListUrl) {
        await page.goto(instanceListUrl, { waitUntil: 'domcontentloaded' });
      }

      const instanceName = page.getByText(candidateName, { exact: true })
        .filter({ visible: true })
        .first();
      await expect(instanceName).toBeVisible({ timeout: stepTimeout });
      const instanceRow = instanceName.locator('xpath=ancestor::tr[1]');
      await expect(instanceRow).toContainText(/mysql\s*5\.7/i, {
        timeout: stepTimeout,
      });

      await instanceName.click();
      console.log(`[代理容量回退] 正在检查实例：${candidateName}`);

      // 5. 代理测试只使用已经含有只读节点的实例。
      const readOnlySummary = page.getByText(/只读实例\s*[：:]?\s*\d+/)
        .filter({ visible: true })
        .first();
      await expect(readOnlySummary).toBeVisible({ timeout: stepTimeout });
      const readOnlyText = (await readOnlySummary.textContent()) || '';
      const readOnlyCount = Number(readOnlyText.match(/\d+/)?.[0] || 0);
      if (readOnlyCount <= 0) {
        console.log(
          `[代理容量回退] 跳过实例 ${candidateName}：只读实例数量为 0。`,
        );
        continue;
      }
      console.log(`已验证实例 ${candidateName} 包含 ${readOnlyCount} 个只读节点。`);

      // 6. 点击左侧栏“数据库代理”。
      const databaseProxy = page.getByText('数据库代理', { exact: true })
        .filter({ visible: true })
        .first();
      await expect(databaseProxy).toBeVisible({ timeout: stepTimeout });
      await databaseProxy.click();

      const currentInitialSnapshot = await readProxyTableSnapshot();
      console.log(
        `[创建代理校验] 实例 ${candidateName} 创建前代理数据行数：`
        + `${currentInitialSnapshot.count}。`,
      );

      // 7. 根据当前代理状态选择入口。
      let enableProxy = null;
      let addProxyNode = null;
      let interactionRoot = null;
      await expect.poll(async () => {
        for (const frame of page.frames()) {
          const enableCandidate = frame.getByRole('button', {
            name: '开启数据库代理',
            exact: true,
          }).or(
            frame.locator('button').filter({
              hasText: /^\s*开启数据库代理\s*$/,
              visible: true,
            }),
          ).filter({ visible: true }).first();
          if (await enableCandidate.isVisible().catch(() => false)) {
            enableProxy = enableCandidate;
            interactionRoot = frame;
            return true;
          }

          const addCandidate = frame.getByText(
            '添加代理节点',
            { exact: true },
          ).filter({ visible: true }).first();
          if (await addCandidate.isVisible().catch(() => false)) {
            addProxyNode = addCandidate;
            interactionRoot = frame;
            return true;
          }
        }
        return false;
      }, {
        timeout: stepTimeout,
        message: '等待“开启数据库代理”或“添加代理节点”入口出现',
      }).toBe(true);

      console.log(
        `[代理入口诊断] 实例 ${candidateName} 在 frame="${interactionRoot.url()}"`
        + ` 找到${enableProxy ? '“开启数据库代理”' : '“添加代理节点”'}。`,
      );
      const isAddingProxyNode = !enableProxy;
      if (!isAddingProxyNode) {
        await enableProxy.scrollIntoViewIfNeeded();
        await enableProxy.click();
        console.log(`实例 ${candidateName} 没有代理记录，已点击“开启数据库代理”。`);
      } else {
        await addProxyNode.scrollIntoViewIfNeeded();
        await addProxyNode.click();
        console.log(`实例 ${candidateName} 已有代理记录，已点击“添加代理节点”。`);
      }

      const currentPasswordInput = interactionRoot.locator(
        'input[type="password"]',
      )
        .filter({ visible: true })
        .first();

      const readAvailableProxyCount = async () => {
        const dialog = interactionRoot.locator(
          '[role="dialog"]:visible, .ant-modal:visible',
        ).last();
        const scope = await dialog.count() ? dialog : interactionRoot;
        const rawText = ((await scope.innerText().catch(() => '')) || '')
          .replace(/\u00a0/g, ' ');
        // 页面可能使用 Unicode 负号/破折号，先统一为普通减号再解析。
        const text = rawText.replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, '-');
        const match = text.match(
          /还\s*可\s*新增\s*([+-]?\s*\d+)\s*个/,
        );
        if (!match) return null;

        return {
          count: Number(match[1].replace(/\s+/g, '')),
          message: match[0].replace(/\s+/g, ' ').trim(),
          rawMessage: (
            rawText.match(/还\s*可\s*新增[^\r\n]*/)?.[0] || match[0]
          ).trim(),
        };
      };

      if (isAddingProxyNode) {
        let capacity = null;
        await expect.poll(async () => {
          capacity = await readAvailableProxyCount();
          return capacity !== null;
        }, {
          timeout: 30 * 1000,
          intervals: [500],
          message: `等待实例 ${candidateName} 显示“还可新增 X 个”`,
        }).toBe(true);

        console.log(
          `[代理容量判断] 实例 ${candidateName}：`
          + `页面原文“${capacity.rawMessage}”，`
          + `标准化文本“${capacity.message}”，`
          + `解析可新增数量=${capacity.count}。`,
        );

        if (capacity.count <= 0) {
          console.log(
            `[代理容量回退] 实例 ${candidateName} 可新增数量不为正数，`
            + '先点击“取消”，再改用下一个实例。',
          );

          const visibleDialog = interactionRoot.locator(
            '[role="dialog"]:visible, .ant-modal:visible',
          ).last();
          const cancelScope = await visibleDialog.count()
            ? visibleDialog
            : interactionRoot;
          const cancelButton = cancelScope.getByRole('button', {
            name: /^取\s*消$/,
          }).or(
            cancelScope.getByText(/^取\s*消$/, { exact: true }),
          ).filter({ visible: true }).last();

          await expect(cancelButton).toBeVisible({ timeout: stepTimeout });
          await cancelButton.click({ force: true });
          if (await visibleDialog.count()) {
            await expect(visibleDialog).toBeHidden({ timeout: stepTimeout });
          }
          console.log(
            `[代理容量回退] 已取消实例 ${candidateName} 的代理配置，`
            + '准备返回实例列表。',
          );
          continue;
        }
      } else {
        console.log(
          `[代理容量判断] 实例 ${candidateName} 为首次开启代理，`
          + '该弹窗不显示“还可新增 X 个”，直接进入密码确认流程。',
        );
      }

      await expect(currentPasswordInput).toBeVisible({ timeout: stepTimeout });
      selectedName = candidateName;
      initialProxySnapshot = currentInitialSnapshot;
      passwordInput = currentPasswordInput;
      proxyInteractionRoot = interactionRoot;
      console.log(`[代理容量回退] 实例 ${candidateName} 容量可用，继续创建代理。`);
      break;
    }

    if (!selectedName || !initialProxySnapshot || !passwordInput) {
      throw new Error(
        '所有符合条件的 MySQL 5.7 实例均无可用代理容量，无法继续创建代理',
      );
    }

    // 8. 两个入口后续使用相同流程：等待人工输入账号和密码。
    await expect(passwordInput).toBeVisible({ timeout: stepTimeout });
    console.log(`请在实例 ${selectedName} 的代理配置页面中手动输入账号和密码。`);

    await expect.poll(async () => {
      const value = await passwordInput.inputValue();
      return value.trim().length > 0;
    }, {
      timeout: stepTimeout,
      message: '等待代理配置密码填写完成',
    }).toBe(true);

    console.log('已检测到密码框非空，10 秒后点击确认按钮。');
    await page.waitForTimeout(10 * 1000);

    // 9. 在当前弹窗中精确点击提交按钮。
    const visibleDialog = proxyInteractionRoot.locator(
      '[role="dialog"]:visible, .ant-modal:visible',
    ).last();
    await expect(visibleDialog).toBeVisible({ timeout: stepTimeout });

    let confirmAction = visibleDialog.locator(
      'button[type="submit"].buttonConfirm',
    ).filter({ visible: true }).last();
    const exactConfirmCount = await visibleDialog.locator(
      'button[type="submit"].buttonConfirm',
    ).filter({ visible: true }).count();
    console.log(
      `[代理确认诊断] 精确 selector 匹配到 ${exactConfirmCount} 个可见按钮。`,
    );
    if (!await confirmAction.count()) {
      console.log(
        '[代理确认诊断] 精确 selector 未匹配，回退到弹窗内文字“确定”。',
      );
      confirmAction = visibleDialog.getByRole('button', {
        name: /^确\s*定$/,
      }).filter({ visible: true }).last();
    }

    await expect(confirmAction).toBeVisible({ timeout: stepTimeout });
    await expect(confirmAction).toBeEnabled({ timeout: stepTimeout });
    const confirmText = ((await confirmAction.innerText()) || '')
      .replace(/\s+/g, ' ')
      .trim();
    const confirmClass = await confirmAction.getAttribute('class');
    const confirmType = await confirmAction.getAttribute('type');
    const confirmDisabled = await confirmAction.isDisabled();
    const confirmBox = await confirmAction.boundingBox();
    console.log(
      `[代理确认诊断] 点击前：文字="${confirmText}"，`
      + `class="${confirmClass}"，type="${confirmType}"，`
      + `disabled=${confirmDisabled}，`
      + `box=${JSON.stringify(confirmBox)}。`,
    );

    console.log('[代理确认诊断] 即将执行 confirmAction.click({ force: true })。');
    await confirmAction.click({ force: true, timeout: stepTimeout });
    console.log('[代理确认诊断] Playwright click() 已返回，开始检查弹窗是否关闭。');

    const dialogClosed = await visibleDialog.waitFor({
      state: 'hidden',
      timeout: 15 * 1000,
    }).then(() => true).catch(() => false);
    if (!dialogClosed) {
      const buttonStillVisible = await confirmAction.isVisible()
        .catch(() => false);
      const buttonDisabled = await confirmAction.isDisabled()
        .catch(() => false);
      throw new Error(
        '已点击代理配置“确定”按钮，但 15 秒内弹窗未关闭。'
        + `按钮仍可见=${buttonStillVisible}，按钮禁用=${buttonDisabled}`,
      );
    }
    console.log('密码非空并等待 10 秒后，已精确点击代理配置“确定”按钮，弹窗已关闭。');
    await page.waitForTimeout(3 * 1000);

    // 10. 每分钟刷新一次，最多轮询 5 次。
    //     只要代理数据行出现“运行中”文字或绿色状态点即判定成功。
    let proxyVerified = false;
    let lastProxySnapshot = null;

    console.log(
      '[创建代理校验] 准备进入轮询：proxyVerified=false，'
      + '最多5轮，每轮间隔1分钟。',
    );
    proxyPollingLoop:
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      console.log(
        `[创建代理校验][${attempt}/5] 本轮开始：`
        + `proxyVerified=${proxyVerified}。`,
      );
      console.log(`[创建代理校验][${attempt}/5] 等待 1 分钟后刷新页面。`);
      await page.waitForTimeout(60 * 1000);
      console.log(`[创建代理校验][${attempt}/5] 等待结束，开始 reload。`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      console.log(
        `[创建代理校验][${attempt}/5] reload 完成：`
        + `pageURL="${page.url()}"，frame数量=${page.frames().length}。`,
      );

      await expect(
        page.getByText('数据库代理', { exact: true })
          .filter({ visible: true })
          .first(),
      ).toBeVisible({ timeout: stepTimeout });
      console.log(
        `[创建代理校验][${attempt}/5] 已确认“数据库代理”菜单可见，`
        + '开始直接扫描“运行中”状态标签。',
      );

      let renderedSnapshot = null;
      for (let renderAttempt = 1; renderAttempt <= 30; renderAttempt += 1) {
        let runningStatusTag = null;
        for (const frame of page.frames()) {
          const statusTags = frame.locator(
            'p[class*="mysql-mysqlList-runningStatus-icon"]',
          );
          const tagCount = await statusTags.count();
          for (let tagIndex = 0; tagIndex < tagCount; tagIndex += 1) {
            const tag = statusTags.nth(tagIndex);
            if (!await tag.isVisible().catch(() => false)) continue;

            const parentText = ((await tag.locator('xpath=..').innerText()
              .catch(() => '')) || '')
              .replace(/\s+/g, ' ')
              .trim();
            runningStatusTag = {
              frameUrl: frame.url(),
              className: await tag.getAttribute('class').catch(() => ''),
              parentText,
            };
            break;
          }
          if (runningStatusTag) break;
        }

        console.log(
          `[创建代理状态标签][${attempt}/5][${renderAttempt}/30] `
          + `是否找到可见运行中标签=${Boolean(runningStatusTag)}；`
          + `详情=${runningStatusTag ? JSON.stringify(runningStatusTag) : 'null'}。`,
        );

        if (runningStatusTag) {
          proxyVerified = true;
          console.log(
            `[创建代理校验] 第 ${attempt} 次轮询成功：`
            + '已直接定位到 p[class*="mysql-mysqlList-runningStatus-icon"]；'
            + '该标签即代表数据库代理状态“运行中”。',
          );
          console.log(
            `[创建代理校验][${attempt}/5] 立即退出全部轮询，`
            + '不会再执行下一次刷新。',
          );
          break proxyPollingLoop;
        }

        const snapshot = await readProxyTableSnapshot({ diagnostic: false });
        if (snapshot.count > 0) renderedSnapshot = snapshot;

        console.log(
          `[创建代理渲染等待][${attempt}/5][${renderAttempt}/30] `
          + `真实表格快照行数=${snapshot.count}；`
          + `状态=${snapshot.rows.map(({ status }) => status).join('、') || '无'}。`,
        );
        if (renderedSnapshot) break;
        await page.waitForTimeout(1000);
      }

      if (!renderedSnapshot) {
        console.log(
          `[创建代理渲染等待][${attempt}/5] 等待30秒后仍没有代理数据行，`
          + '本轮记录为页面尚未完成渲染。',
        );
      } else {
        console.log(
          `[创建代理渲染等待][${attempt}/5] 代理表格已渲染 `
          + `${renderedSnapshot.count} 行，状态=`
          + `${renderedSnapshot.rows.map(({ status }) => status).join('、')}，`
          + '开始扫描运行状态。',
        );
      }

      const currentSnapshot = renderedSnapshot
        || await readProxyTableSnapshot();
      lastProxySnapshot = currentSnapshot;
      console.log(
        `[创建代理校验][${attempt}/5] 实际读取到 ${currentSnapshot.count} 行：`
        + (
          currentSnapshot.rows.length
            ? currentSnapshot.rows.map(
              ({ identity, status, text }, index) => (
                `第${index + 1}行{地址="${identity}", 状态="${status}", `
                + `内容="${text}"}`
              ),
            ).join('；')
            : '无数据行'
        ),
      );

      const runningRow = currentSnapshot.rows.find(
        ({ status, text }) => (
          status === '运行中' || text.includes('运行中')
        ),
      );
      console.log(
        `[创建代理校验][${attempt}/5] 表格状态判断：`
        + `是否读取到“运行中”=${Boolean(runningRow)}；`
        + `runningRow=${runningRow ? JSON.stringify(runningRow) : 'null'}。`,
      );
      if (runningRow) {
        console.log(
          `[创建代理校验][${attempt}/5] 表格状态探测成功，`
          + '即将把 proxyVerified 设置为 true。',
        );
        proxyVerified = true;
        console.log(
          `[创建代理校验] 第 ${attempt} 次轮询成功：`
          + `表格快照已读取到状态“运行中”，`
          + `代理地址="${runningRow.identity}"。`,
        );
        console.log(
          `[创建代理校验][${attempt}/5] 即将执行 break proxyPollingLoop；`
          + '后续轮次不应再出现。',
        );
        break proxyPollingLoop;
      }

      console.log(
        `[创建代理校验][${attempt}/5] 当前读取代理行数=`
        + `${currentSnapshot.count}；本轮未识别到代理行状态“运行中”。`,
      );
      console.log(
        `[创建代理校验][${attempt}/5] 本轮结束且未成功，`
        + `${attempt < 5 ? '将进入下一轮等待。' : '已到最后一轮。'}`,
      );
    }

    console.log(
      `[创建代理校验] 已离开轮询循环：proxyVerified=${proxyVerified}；`
      + `${proxyVerified ? '不会执行失败分支，也不会继续刷新。' : '准备执行失败分支。'}`,
    );
    if (!proxyVerified) {
      const finalCount = lastProxySnapshot?.count ?? 0;
      const finalRows = lastProxySnapshot?.rows
        .map(({ text }) => text)
        .join(' || ') || '无数据行';
      throw new Error(
        '创建代理校验失败：5 次轮询后仍未识别到'
        + '代理表格中的“运行中”文字或绿色状态点。'
        + `最终行数=${finalCount}，最终表格=${finalRows}`,
      );
    }

    await page.screenshot({
      path: 'test-results/mysql57-proxy-running.png',
      fullPage: true,
    });

    console.log('代理配置页面保持打开，检查完成后请手动关闭。');
    await page.waitForEvent('close', { timeout: 0 });
  } catch (error) {
    console.error(`创建代理测试失败：${error.message}`);
    console.log('发生错误后浏览器不会自动关闭，请检查页面后手动关闭。');
    await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
});
