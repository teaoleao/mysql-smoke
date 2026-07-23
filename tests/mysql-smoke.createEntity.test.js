const path = require('path');
const { chromium, test, expect } = require('@playwright/test');

// 这是需要人工登录的交互用例，失败后不能自动重开一个 Edge 窗口。
test.describe.configure({ retries: 0 });

test('MySQL 购买实例入口冒烟测试', async () => {
  // 最终页面需要保持打开，直到人工关闭，因此测试不设置总超时。
  test.setTimeout(0);

  const stepTimeout = 5 * 60 * 1000;
  const buyNowText = '立即购买';

  // 使用项目专属的持久化 Edge 用户目录。
  // 站点的安全校验 Cookie 和登录状态会在后续运行中保留。
  const userDataDir = path.resolve('.playwright/edge-profile');
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
    // 1. 打开登录页，并确认主文档本身访问正常
    const response = await page.goto(process.env.BASE_URL, {
      waitUntil: 'domcontentloaded',
    });

    if (!response || !response.ok()) {
      throw new Error(`登录页访问失败：HTTP ${response?.status() ?? '无响应'}`);
    }

    console.log('Edge 已打开，请你在该浏览器窗口中手动登录。');

    // 2. 登录成功后会进入控制台概览页，不会直接出现“产品”文字
    await page.waitForURL(/\/console\/home\/overview(?:[/?#]|$)/, {
      timeout: stepTimeout,
    });
    await expect(page.getByText('概览', { exact: true }).first()).toBeVisible({
      timeout: stepTimeout,
    });

    // 3. “联通云”Logo 的实际 DOM 是 <div class="logo">，并绑定了点击事件。
    const cloudLogo = page.locator('div.logo').first();
    await expect(cloudLogo).toBeVisible({ timeout: stepTimeout });
    await cloudLogo.click();
    console.log('已点击“联通云”Logo（div.logo）。');

    // 4. 点击“联通云”后进入门户页，继续点击顶部导航中的“产品”。
    const productsEntry = page.getByText('产品', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(productsEntry).toBeVisible({
      timeout: stepTimeout,
    });
    await productsEntry.click();
    console.log('已点击顶部导航“产品”。');

    // 5. 在展开的产品列表中点击 MySQL 产品。
    console.log('“产品”面板已打开，开始点击云数据库 CUDB for MySQL。');

    const mysqlName = /云数据库\s*CUDB\s*for\s*MySQL/i;
    const findDeadline = Date.now() + stepTimeout;
    let mysqlProduct = null;

    while (!mysqlProduct && Date.now() < findDeadline) {
      for (const frame of page.frames()) {
        const matches = frame.getByText(mysqlName)
          .filter({ visible: true });
        const count = await matches.count();

        if (count > 0) {
          // 同名入口都能进入 MySQL；优先点击产品列表中的最后一个。
          mysqlProduct = matches.nth(count - 1);
          console.log(`已识别到 ${count} 个 MySQL 入口，准备点击。`);
          break;
        }
      }

      if (!mysqlProduct) {
        await page.waitForTimeout(500);
      }
    }

    if (!mysqlProduct) {
      throw new Error('产品面板已打开，但主页面和 iframe 中均未识别到云数据库 CUDB for MySQL');
    }

    // 产品入口可能在当前页跳转，也可能通过 window.open 打开新标签页。
    const newPagePromise = context.waitForEvent('page', { timeout: 10 * 1000 })
      .catch(() => null);

    await mysqlProduct.click({ force: true });
    console.log('已执行云数据库 CUDB for MySQL 点击。');

    const openedPage = await newPagePromise;
    if (openedPage) {
      page = openedPage;
      await page.waitForLoadState('domcontentloaded');
    }

    console.log(`MySQL 产品入口点击完成，后续操作页面：${page.url()}`);

    // 6. 产品介绍页的真实入口是 span.long-solid-button，文字为“立即购买”。
    const buyNow = page.locator('span.long-solid-button')
      .filter({ hasText: buyNowText, visible: true })
      .first();
    await expect(buyNow).toBeVisible({ timeout: stepTimeout });

    // “立即购买”会打开新的购买页面，点击前先监听新页面事件。
    const purchasePagePromise = context.waitForEvent('page', { timeout: stepTimeout })
      .catch(() => null);
    await buyNow.click();

    const purchasePage = await purchasePagePromise;
    if (purchasePage) {
      page = purchasePage;
      await page.waitForLoadState('domcontentloaded');
    }
    console.log(`已点击“立即购买”，购买页面：${page.url()}`);

    // 7. 保持购买页面默认云区域“廊坊二区”，直接进入网络配置。
    console.log('保持默认云区域“廊坊二区”，开始选择网络配置。');

    // 8. 依次选择 VPC、子网和安全组；为空时每隔 5 秒重试。
    const selectFirstAvailableOption = async (placeholder) => {
      const placeholderElement = page
        .locator('span.ant-select-selection-placeholder')
        .filter({ hasText: placeholder, visible: true })
        .first();
      await expect(placeholderElement).toBeVisible({ timeout: stepTimeout });

      const select = placeholderElement.locator(
        'xpath=ancestor::*[contains(@class,"ant-select")][1]',
      );
      await expect(select).toBeVisible({ timeout: stepTimeout });
      await select.scrollIntoViewIfNeeded();

      const deadline = Date.now() + stepTimeout;
      let selected = false;

      while (!selected && Date.now() < deadline) {
        // 按下拉框实际尺寸点击右侧箭头区域：右边缘向左 20px、垂直居中。
        const selectBox = await select.boundingBox();
        if (!selectBox) {
          throw new Error(`${placeholder} 已找到，但无法取得下拉框坐标`);
        }
        const arrowX = selectBox.x + selectBox.width - 20;
        const arrowY = selectBox.y + selectBox.height / 2;
        console.log(`点击 ${placeholder} 箭头坐标：(${arrowX}, ${arrowY})`);
        await page.mouse.click(arrowX, arrowY);
        await page.waitForTimeout(1000);

        const options = page.locator(
          '.ant-select-dropdown:visible .ant-select-item-option:not(.ant-select-item-option-disabled), '
          + '[role="listbox"]:visible [role="option"]',
        ).filter({ visible: true });

        if (await options.count()) {
          await options.first().click();
          selected = true;
          break;
        }

        console.log(`${placeholder} 当前没有可用选项，5 秒后重新选择。`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(5 * 1000);
      }

      if (!selected) {
        throw new Error(`${placeholder} 在等待时间内始终没有可用选项`);
      }

      // 占位文字消失才说明第一项真正选中。
      await expect(placeholderElement).toBeHidden({ timeout: stepTimeout });
      console.log(`${placeholder} 已选择第一项。`);

      // VPC、子网和安全组之间存在异步联动，需要等待接口和界面稳定。
      await page.waitForTimeout(5 * 1000);
    };

    const vpcSection = page.getByText('专有网络VPC', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(vpcSection).toBeVisible({ timeout: stepTimeout });

    // 用约 4 秒逐帧缓慢滚动到 VPC 区域，便于观察页面移动过程。
    await vpcSection.evaluate((element) => new Promise((resolve) => {
      const startY = window.scrollY;
      const targetY = startY
        + element.getBoundingClientRect().top
        - window.innerHeight / 3;
      const duration = 4000;
      const startTime = performance.now();

      const scrollStep = (currentTime) => {
        const progress = Math.min((currentTime - startTime) / duration, 1);
        const eased = progress < 0.5
          ? 2 * progress * progress
          : 1 - ((-2 * progress + 2) ** 2) / 2;
        window.scrollTo(0, startY + (targetY - startY) * eased);

        if (progress < 1) {
          requestAnimationFrame(scrollStep);
        } else {
          resolve();
        }
      };

      requestAnimationFrame(scrollStep);
    }));

    await selectFirstAvailableOption('请选择专有网络VPC');
    await selectFirstAvailableOption('请选择子网');
    await selectFirstAvailableOption('请选择安全组');

    await page.screenshot({
      path: 'test-results/mysql-network-selected.png',
      fullPage: true,
    });

    // 9. 等待人工填写管理员密码和确认密码，不读取或记录密码内容。
    const passwordInputs = page.locator('input[type="password"]')
      .filter({ visible: true });

    await expect(passwordInputs).toHaveCount(2, { timeout: stepTimeout });
    console.log('请手动填写管理员密码和确认密码。');

    await expect.poll(async () => {
      const filled = await passwordInputs.evaluateAll((inputs) =>
        inputs.slice(0, 2).every((input) => input.value.trim().length > 0),
      );
      return filled;
    }, {
      timeout: stepTimeout,
      message: '等待管理员密码和确认密码均填写完成',
    }).toBe(true);

    console.log('已检测到两个密码框均非空，10 秒后点击“下一步：确认配置”。');
    await page.waitForTimeout(10 * 1000);

    // 10. 页面真实按钮完整文字是“下一步：确认配置”。
    const confirmConfig = page.getByRole('button', {
      name: /下一步\s*[：:]\s*确认配置/,
    }).or(
      page.getByText(/下一步\s*[：:]\s*确认配置/, { exact: true }),
    ).filter({ visible: true }).first();

    await expect(confirmConfig).toBeVisible({ timeout: stepTimeout });
    await confirmConfig.scrollIntoViewIfNeeded();

    const previousUrl = page.url();
    await confirmConfig.click();

    // 支持 URL 跳转或同一 URL 内切换到下一步两种实现。
    await Promise.race([
      page.waitForURL((url) => url.toString() !== previousUrl, {
        timeout: stepTimeout,
      }),
      expect(confirmConfig).toBeHidden({ timeout: stepTimeout }),
    ]);

    // 11. 保存进入确认页的截图。
    await page.screenshot({
      path: 'test-results/mysql-confirm-config-next-page.png',
      fullPage: true,
    });

    console.log('已点击“下一步：确认配置”并进入确认页。');

    // 12. 勾选“我已阅读并同意”前面的复选框。
    const agreementText = page.getByText(/我已阅读并同意/)
      .filter({ visible: true })
      .first();
    await expect(agreementText).toBeVisible({ timeout: stepTimeout });
    await agreementText.scrollIntoViewIfNeeded();

    const agreementControl = agreementText.locator(
      'xpath=ancestor::div[contains(@class,"ant-legacy-form-item-control")][1]',
    );
    const agreementCheckbox = agreementControl.locator('input[type="checkbox"]')
      .first();

    if (await agreementCheckbox.count()) {
      if (!await agreementCheckbox.isChecked()) {
        await agreementCheckbox.check({ force: true });
      }
      await expect(agreementCheckbox).toBeChecked();
    } else {
      const checkboxVisual = agreementControl.locator('.ant-checkbox')
        .filter({ visible: true })
        .first();
      await expect(checkboxVisual).toBeVisible({ timeout: stepTimeout });
      await checkboxVisual.click();
    }
    console.log('已勾选“我已阅读并同意”。');

    // 勾选协议后等待页面状态更新，再执行立即开通。
    await page.waitForTimeout(2 * 1000);

    // 13. 点击“下一步：立即开通”。该动作可能真实创建计费资源。
    const activateNow = page.getByRole('button', {
      name: /下一步\s*[：:]\s*立即开通/,
    }).or(
      page.getByText(/下一步\s*[：:]\s*立即开通/, { exact: true }),
    ).filter({ visible: true }).first();

    await expect(activateNow).toBeVisible({ timeout: stepTimeout });
    await activateNow.scrollIntoViewIfNeeded();

    const activationUrl = page.url();
    const activationPagePromise = context.waitForEvent('page', {
      timeout: 10 * 1000,
    }).catch(() => null);
    await activateNow.click();

    const activationPage = await activationPagePromise;
    if (activationPage) {
      page = activationPage;
      await page.waitForLoadState('domcontentloaded');
    } else {
      await Promise.race([
        page.waitForURL((url) => url.toString() !== activationUrl, {
          timeout: stepTimeout,
        }),
        expect(activateNow).toBeHidden({ timeout: stepTimeout }),
      ]);
    }

    await page.screenshot({
      path: 'test-results/mysql-activated-result.png',
      fullPage: true,
    });

    console.log('已点击“下一步：立即开通”。');
    console.log('浏览器将保持打开；检查完成后请手动关闭该页面。');

    // 不自动关闭最终页面，等待人工检查并关闭。
    await page.waitForEvent('close', { timeout: 0 });
  } finally {
    await context.close();
  }
});
