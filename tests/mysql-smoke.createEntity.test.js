const path = require('path');
const { chromium, test, expect } = require('@playwright/test');
const {
  keepOnlyOneStartupPage,
} = require('./helpers/browser-pages');
const createConfig = require('../config/mysql-create-entity.json');

// 这是需要人工登录的交互用例，失败后不能自动重开一个 Edge 窗口。
test.describe.configure({ retries: 0 });

const compactText = (value) => String(value ?? '').replace(/\s+/g, '').trim();

const randomItem = (items) => items[Math.floor(Math.random() * items.length)];

const formatTimestamp = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
};

async function chooseRandomEnabledText(page, names, description, timeout) {
  const available = [];
  for (const name of names) {
    const matches = page.getByText(name, { exact: true }).filter({ visible: true });
    for (let index = 0; index < await matches.count(); index += 1) {
      const candidate = matches.nth(index);
      const control = candidate.locator(
        'xpath=ancestor-or-self::*[self::button or @role="button" or contains(@class,"ant-radio-wrapper") or contains(@class,"ant-btn")][1]',
      );
      const target = await control.count() ? control : candidate;
      const disabled = await target.evaluate((element) => (
        element.matches(':disabled')
        || element.getAttribute('aria-disabled') === 'true'
        || /disabled/.test(element.className || '')
      )).catch(() => true);
      if (!disabled) available.push({ name, target });
    }
  }
  if (!available.length) {
    throw new Error(`${description}没有可点击选项：${names.join('、')}`);
  }
  const selected = randomItem(available);
  await selected.target.scrollIntoViewIfNeeded();
  await selected.target.click();
  console.log(`[随机配置] ${description}：从 ${available.map((item) => item.name).join('、')} 中选择 ${selected.name}。`);
  await page.waitForTimeout(Math.min(timeout, 1500));
  return selected.name;
}

async function selectAntOption({
  page,
  select,
  desiredText,
  description,
  timeout,
  fallbackToFirst = true,
}) {
  await expect(select).toBeVisible({ timeout });
  await select.scrollIntoViewIfNeeded();
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    await select.click({ force: true });
    await page.waitForTimeout(800);
    const dropdown = page.locator(
      '.ant-select-dropdown:visible, [role="listbox"]:visible',
    ).last();
    const options = dropdown.locator(
      '.ant-select-item-option:not(.ant-select-item-option-disabled), [role="option"]:not([aria-disabled="true"])',
    ).filter({ visible: true });
    const count = await options.count();
    if (!count) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(2000);
      continue;
    }

    let chosen = null;
    if (desiredText) {
      for (let index = 0; index < count; index += 1) {
        const option = options.nth(index);
        if (compactText(await option.innerText()) === compactText(desiredText)) {
          chosen = option;
          break;
        }
      }
    }
    // 云区域等长列表采用虚拟滚动，目标项可能尚未挂载到 DOM。
    if (!chosen && desiredText) {
      const scrollContainer = dropdown.locator(
        '.rc-virtual-list-holder, .ant-select-dropdown-content',
      ).first();
      if (await scrollContainer.count()) {
        await scrollContainer.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          element.dispatchEvent(new Event('scroll', { bubbles: true }));
        });
        await page.waitForTimeout(800);
        const scrolledOptions = dropdown.locator(
          '.ant-select-item-option:not(.ant-select-item-option-disabled), [role="option"]:not([aria-disabled="true"])',
        ).filter({ visible: true });
        for (let index = 0; index < await scrolledOptions.count(); index += 1) {
          const option = scrolledOptions.nth(index);
          if (compactText(await option.innerText()) === compactText(desiredText)) {
            chosen = option;
            break;
          }
        }
      }
    }
    if (!chosen && !fallbackToFirst) {
      await page.keyboard.press('Escape');
      throw new Error(`${description}未找到配置项“${desiredText}”`);
    }
    if (!chosen) {
      chosen = options.first();
      console.warn(`[配置回退] ${description}未找到“${desiredText ?? ''}”，选择首个可用项“${compactText(await chosen.innerText())}”。`);
    }
    const selectedText = compactText(await chosen.innerText());
    await chosen.click();
    console.log(`[配置选择] ${description}：${selectedText}。`);
    return selectedText;
  }
  throw new Error(`${description}在等待时间内始终没有可用选项`);
}

async function findControlAfterLabel(page, labelText, controlSelector) {
  const label = page.getByText(labelText, { exact: true })
    .filter({ visible: true })
    .first();
  await expect(label).toBeVisible();
  const control = label.locator(`xpath=following::*[${controlSelector}][1]`);
  await expect(control).toBeVisible();
  return control;
}

async function chooseRandomDynamicButton(page, pattern, description, timeout) {
  const matches = page.getByText(pattern, { exact: true }).filter({ visible: true });
  const available = [];
  for (let index = 0; index < await matches.count(); index += 1) {
    const text = compactText(await matches.nth(index).innerText());
    const control = matches.nth(index).locator(
      'xpath=ancestor-or-self::*[self::button or @role="button" or contains(@class,"ant-radio-wrapper") or contains(@class,"ant-btn")][1]',
    );
    const target = await control.count() ? control : matches.nth(index);
    const disabled = await target.evaluate((element) => (
      element.matches(':disabled')
      || element.getAttribute('aria-disabled') === 'true'
      || /disabled/.test(element.className || '')
    )).catch(() => true);
    if (!disabled) available.push({ text, target });
  }
  if (!available.length) throw new Error(`${description}没有可点击选项`);
  const selected = randomItem(available);
  await selected.target.scrollIntoViewIfNeeded();
  await selected.target.click();
  console.log(
    `[随机配置] ${description}：从 ${available.map(({ text }) => text).join('、')} 中选择 ${selected.text}。`,
  );
  await page.waitForTimeout(Math.min(timeout, 1500));
  return selected.text;
}

async function runCreateEntity(runtime = null) {
  // 最终页面需要保持打开，直到人工关闭，因此测试不设置总超时。
  test.setTimeout(0);

  const stepTimeout = 5 * 60 * 1000;
  const buyNowText = '立即购买';

  // 使用项目专属的持久化 Edge 用户目录。
  // 站点的安全校验 Cookie 和登录状态会在后续运行中保留。
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

    // 7. 按配置生成实例名称：系统前缀_OA账号_精确到秒的时间戳。
    const instanceNameLabel = page.getByText('实例名称', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(instanceNameLabel).toBeVisible({ timeout: stepTimeout });
    const instanceNameInput = instanceNameLabel.locator(
      'xpath=following::input[1]',
    );
    await expect(instanceNameInput).toBeVisible({ timeout: stepTimeout });
    const generatedInstanceName = (
      await instanceNameInput.inputValue()
    ).trim();
    if (!generatedInstanceName) {
      throw new Error('实例名称输入框为空，无法记录待验证的实例名称');
    }
    const createdInstanceName = [
      generatedInstanceName,
      createConfig.OA账号,
      formatTimestamp(),
    ].join('_').replace(/[^a-zA-Z0-9_-]/g, '');
    await instanceNameInput.fill(createdInstanceName);
    console.log(
      `[实例配置] 系统名称=${generatedInstanceName}，`
      + `按“系统名称_OA账号_时间戳”生成=${createdInstanceName}。`,
    );

    // 8. 云区域必须执行下拉选择；配置不可用时回退到“西藏/拉萨一区”。
    const configuredZone = createConfig.云区域?.可用区 || '拉萨一区';
    const regionSelect = await findControlAfterLabel(
      page,
      '云区域',
      'contains(@class,"ant-select")',
    );
    const selectedZone = await selectAntOption({
      page,
      select: regionSelect,
      desiredText: configuredZone,
      description: `云区域（${createConfig.云区域?.省份 || '西藏'}）`,
      timeout: stepTimeout,
      fallbackToFirst: false,
    }).catch(async () => {
      console.warn(
        `[配置回退] 云区域未找到配置值“${configuredZone}”，改选西藏/拉萨一区。`,
      );
      return selectAntOption({
        page,
        select: regionSelect,
        desiredText: '拉萨一区',
        description: '云区域（西藏）',
        timeout: stepTimeout,
        fallbackToFirst: false,
      });
    });

    // 数据库版本、存储类型、专区、规格均从当前页面可点击项中随机选择。
    const selectedDatabaseType = await chooseRandomEnabledText(
      page,
      ['MySQL 8.0', 'MySQL 5.7'],
      '数据库类型',
      stepTimeout,
    );
    const selectedStorageType = await chooseRandomEnabledText(
      page,
      ['超高IO数据盘', 'SSD数据盘', '高效数据盘'],
      '存储类型',
      stepTimeout,
    );
    const selectedZoneGroup = await chooseRandomDynamicButton(
      page,
      /^通用专区\d+$/,
      '专区',
      stepTimeout,
    );

    const specificationRows = page.locator('tr:visible');
    const enabledSpecifications = [];
    for (let index = 0; index < await specificationRows.count(); index += 1) {
      const row = specificationRows.nth(index);
      const firstCell = compactText(await row.locator('td').first().innerText().catch(() => ''));
      if (!/^[a-z]\d*\.[a-z]+\d+$/i.test(firstCell)) continue;
      const radio = row.locator('input[type="radio"]').first();
      const disabled = await radio.isDisabled().catch(() => false);
      if (!disabled) enabledSpecifications.push({ name: firstCell, row, radio });
    }
    if (!enabledSpecifications.length) {
      throw new Error('实例规格表中没有识别到可用规格（例如 s2.large4）');
    }
    const selectedSpecification = randomItem(enabledSpecifications);
    await selectedSpecification.row.scrollIntoViewIfNeeded();
    if (await selectedSpecification.radio.count()) {
      await selectedSpecification.radio.check({ force: true });
    } else {
      await selectedSpecification.row.click();
    }
    console.log(
      `[随机配置] 实例规格：从 ${enabledSpecifications.map(({ name }) => name).join('、')} `
      + `中选择 ${selectedSpecification.name}。`,
    );

    const storageInput = await findControlAfterLabel(
      page,
      '存储空间',
      'self::input',
    );
    await storageInput.fill(String(createConfig.存储空间GB));
    console.log(`[配置选择] 存储空间：${createConfig.存储空间GB}GB。`);
    console.log(
      `[购买配置摘要] 云区域=${selectedZone}，数据库=${selectedDatabaseType}，`
      + `存储类型=${selectedStorageType}，专区=${selectedZoneGroup}，`
      + `规格=${selectedSpecification.name}。`,
    );

    // 9. VPC、子网和安全组保持原规则：选择第一项，为空每隔 5 秒重试。
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

    // 密码改为创建后设置。下面保留旧人工输入逻辑作为注释，便于将来恢复。
    const createPasswordLater = page.getByText('创建后设置', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(createPasswordLater).toBeVisible({ timeout: stepTimeout });
    await createPasswordLater.scrollIntoViewIfNeeded();
    await createPasswordLater.click();
    console.log('[配置选择] 管理员密码：创建后设置。');

    const templateSelect = await findControlAfterLabel(
      page,
      '参数模板',
      'contains(@class,"ant-select")',
    );
    const configuredTemplate = createConfig.参数模板?.[selectedDatabaseType];
    const selectedTemplate = await selectAntOption({
      page,
      select: templateSelect,
      desiredText: configuredTemplate,
      description: `${selectedDatabaseType} 参数模板`,
      timeout: stepTimeout,
      fallbackToFirst: true,
    });

    let tableNameCase = '版本默认';
    if (selectedDatabaseType === 'MySQL 8.0') {
      tableNameCase = await chooseRandomEnabledText(
        page,
        ['不区分大小写', '区分大小写'],
        'MySQL 8.0 表名大小写',
        stepTimeout,
      );
    } else {
      console.log('[配置选择] MySQL 5.7 表名大小写：保持页面默认。');
    }

    const resourceGroupSelect = await findControlAfterLabel(
      page,
      '资源组',
      'contains(@class,"ant-select")',
    );
    const selectedResourceGroup = await selectAntOption({
      page,
      select: resourceGroupSelect,
      desiredText: createConfig.资源组,
      description: '资源组',
      timeout: stepTimeout,
      fallbackToFirst: true,
    });
    console.log(
      `[购买配置补充] 参数模板=${selectedTemplate}，`
      + `表名大小写=${tableNameCase}，资源组=${selectedResourceGroup}。`,
    );

    await page.screenshot({
      path: 'test-results/mysql-network-selected.png',
      fullPage: true,
    });

    /*
     * 旧逻辑（需求明确要求保留但注释）：等待人工填写管理员密码和确认密码。
     *
     * const passwordInputs = page.locator('input[type="password"]')
     *   .filter({ visible: true });
     * await expect(passwordInputs).toHaveCount(2, { timeout: stepTimeout });
     * console.log('请手动填写管理员密码和确认密码。');
     * await expect.poll(async () => {
     *   const filled = await passwordInputs.evaluateAll((inputs) =>
     *     inputs.slice(0, 2).every((input) => input.value.trim().length > 0),
     *   );
     *   return filled;
     * }, {
     *   timeout: stepTimeout,
     *   message: '等待管理员密码和确认密码均填写完成',
     * }).toBe(true);
     * console.log('已检测到两个密码框均非空，10 秒后继续。');
     * await page.waitForTimeout(10 * 1000);
     */
    console.log('已选择“创建后设置”，无需等待人工填写密码。');

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
    console.log(
      `[创建实例校验] 已点击“管理控制台”，`
      + `将每隔1分钟刷新，最多8次，校验实例 ${createdInstanceName}。`,
    );

    let isRunning = false;
    let createdInstanceRowText = '尚未找到目标实例';
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      console.log(`[创建实例校验][${attempt}/8] 等待1分钟后刷新实例列表。`);
      await managementPage.waitForTimeout(60 * 1000);
      await managementPage.reload({ waitUntil: 'domcontentloaded' });
      await managementPage.waitForTimeout(2000);

      const createdInstanceLink = managementPage.getByText(
        createdInstanceName,
        { exact: true },
      ).filter({ visible: true }).first();
      if (!await createdInstanceLink.count()) {
        createdInstanceRowText = '尚未找到目标实例';
        console.log(
          `[创建实例校验][${attempt}/8] 未找到实例 ${createdInstanceName}，继续轮询。`,
        );
        continue;
      }
      const createdInstanceRow = createdInstanceLink.locator(
        'xpath=ancestor::tr[1]',
      );
      createdInstanceRowText = (
        await createdInstanceRow.innerText()
      ).replace(/\s+/g, ' ').trim();
      isRunning = /运行\s*中/.test(createdInstanceRowText);
      console.log(
        `[创建实例校验][${attempt}/8] 实例=${createdInstanceName}，`
        + `列表行=${JSON.stringify(createdInstanceRowText)}，`
        + `是否运行中=${isRunning}。`,
      );
      if (isRunning) {
        console.log(
          `[创建实例校验成功] ${selectedDatabaseType} 实例 `
          + `${createdInstanceName} 已进入“运行中”，停止刷新。`,
        );
        break;
      }
    }
    if (!isRunning) {
      throw new Error(
        `[创建实例校验失败] ${selectedDatabaseType} 实例 ${createdInstanceName} `
        + `每分钟刷新、共8次后仍不是“运行中”，最终行内容：${createdInstanceRowText}`,
      );
    }
    console.log('浏览器将保持打开；检查完成后请手动关闭该页面。');

    // 不自动关闭最终页面，等待人工检查并关闭。
    if (runtime) {
      runtime.setPage(managementPage);
      const stateKey = selectedDatabaseType === 'MySQL 8.0'
        ? 'create80'
        : 'create57';
      runtime.state[stateKey] = {
        instanceName: createdInstanceName,
        databaseType: selectedDatabaseType,
        status: '运行中',
      };
      return {
        page: managementPage,
        detail: `${selectedDatabaseType} 实例 ${createdInstanceName} 已运行`,
      };
    }
    await managementPage.waitForEvent('close', { timeout: 0 });
  } finally {
    if (!runtime) await context.close();
  }
}

if (process.env.MYSQL_SMOKE_CHAIN_IMPORT !== '1') {
  test('MySQL 按配置与随机策略创建实例冒烟测试', async () => {
    await runCreateEntity();
  });
}

module.exports = {
  runCreateEntity,
};
