const { test, expect } = require('@playwright/test');
const {
  openRandomMysqlInstance,
} = require('./helpers/mysql-instance-navigation');

test.describe.configure({ retries: 0 });

test('MySQL 更换安全组 - 随机主实例', async () => {
  test.setTimeout(0);
  const stepTimeout = 10 * 60 * 1000;

  const {
    context,
    page,
    instanceName,
  } = await openRandomMysqlInstance(stepTimeout);

  try {
    // 进入实例后读取真实的只读实例数量，不再依赖列表中的展开图标。
    const readonlyLabel = page.getByText(/只读实例/)
      .filter({ visible: true });
    await expect(readonlyLabel.first()).toBeVisible({ timeout: stepTimeout });

    const pageText = await page.locator('body').innerText();
    const readonlyMatch = pageText.match(/只读实例\s*[:：]?\s*(\d+)/);
    if (!readonlyMatch) {
      throw new Error('进入实例后未识别到“只读实例”数量');
    }

    const readonlyCount = Number(readonlyMatch[1]);
    const targetDescription = readonlyCount > 0
      ? '含有只读实例'
      : '不含只读实例';
    console.log(
      `本次安全组更新目标：${targetDescription}的主实例`
      + ` ${instanceName || '名称未知'}，只读实例数量：${readonlyCount}。`,
    );

    // 进入“连接管理”。
    const connectionManagement = page.getByText('连接管理', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(connectionManagement).toBeVisible({ timeout: stepTimeout });
    await connectionManagement.click();

    // 编辑图标的事件直接绑定在 span 上。当前页面实测图标中心约位于
    // 安全组名称文字尾部右侧 15 CSS px；先点击 15，再逐像素尝试 10-20。
    let editClicked = false;
    let interactionFrame = page.mainFrame();
    let changeDialogTitle = null;
    let originalSecurityGroup = '';
    const baseEditOffset = 15;
    const editOffsets = [
      baseEditOffset,
      ...Array.from(
        { length: 11 },
        (_, index) => baseEditOffset - 5 + index,
      ).filter((offset) => offset !== baseEditOffset),
    ];
    const editDeadline = Date.now() + 30 * 1000;
    while (!editClicked && Date.now() < editDeadline) {
      for (const frame of page.frames()) {
        const securityGroupNames = frame.locator(
          '.mysql-link-guide-top-title > a',
        );
        const securityGroupNameCount = await securityGroupNames.count();

        for (let index = 0; index < securityGroupNameCount; index += 1) {
          const securityGroupName = securityGroupNames.nth(index);
          if (!await securityGroupName.isVisible().catch(() => false)) continue;

          await securityGroupName.scrollIntoViewIfNeeded();
          await page.waitForTimeout(500);

          // 必须在滚动结束后重新获取坐标，否则会点击滚动前的旧位置。
          const securityGroupLabel = securityGroupName.locator(
            'xpath=preceding-sibling::span[1]',
          );
          const labelBox = await securityGroupLabel.boundingBox();
          const nameBox = await securityGroupName.boundingBox();
          if (!labelBox || !nameBox) continue;

          console.log(
            `frame ${frame.url()} 找到安全组名称 `
            + `${JSON.stringify((await securityGroupName.innerText()).trim())}，`
            + `尺寸=${nameBox.width.toFixed(1)}×${nameBox.height.toFixed(1)}px。`,
          );
          originalSecurityGroup = (
            await securityGroupName.innerText()
          ).trim();
          console.log(
            `[安全组名称记录] 提交更换前从连接管理页面读取到原安全组：`
            + `${JSON.stringify(originalSecurityGroup)}。`,
          );
          const editCenterY = nameBox.y + nameBox.height / 2;
          const labelEndX = labelBox.x + labelBox.width;
          const labelEndY = labelBox.y + labelBox.height / 2;
          const nameEndX = nameBox.x + nameBox.width;
          const nameEndY = nameBox.y + nameBox.height / 2;
          console.log(
            `“安全组名称：”末尾坐标：`
            + `(${labelEndX.toFixed(1)}, ${labelEndY.toFixed(1)})；`
            + `具体安全组名称末尾坐标：`
            + `(${nameEndX.toFixed(1)}, ${nameEndY.toFixed(1)})。`,
          );

          for (const offset of editOffsets) {
            const editCenterX = nameEndX + offset;
            console.log(
              `[安全组编辑入口] 尝试偏移=${offset}px，`
              + `点击坐标=(${editCenterX.toFixed(1)}, `
              + `${editCenterY.toFixed(1)})。`,
            );
            await page.mouse.click(editCenterX, editCenterY);

            const modalDeadline = Date.now() + 1200;
            while (!changeDialogTitle && Date.now() < modalDeadline) {
              for (const candidateFrame of page.frames()) {
                const title = candidateFrame.getByText(/更换安全组/)
                  .filter({ visible: true })
                  .first();
                if (await title.isVisible().catch(() => false)) {
                  changeDialogTitle = title;
                  interactionFrame = candidateFrame;
                  break;
                }
              }
              if (!changeDialogTitle) await page.waitForTimeout(150);
            }

            if (changeDialogTitle) {
              editClicked = true;
              console.log(
                `[安全组编辑入口] 偏移=${offset}px 点击成功，`
                + '已检测到“更换安全组”弹窗。',
              );
              break;
            }
          }
          break;
        }
        if (editClicked) break;
      }
      if (!editClicked) await page.waitForTimeout(500);
    }

    if (!editClicked) {
      throw new Error(
        '所有 frame 中均未找到可见的 span[role="img"][aria-label="edit"]',
      );
    }

    if (!changeDialogTitle) {
      throw new Error(
        '已逐像素尝试安全组名称尾部右侧 10-20px，'
        + '但均未出现“更换安全组”弹窗',
      );
    }

    const changeDialog = changeDialogTitle.locator(
      'xpath=ancestor::div[contains(@class,"ant-modal-content")][1]',
    );
    await expect(changeDialog).toBeVisible({ timeout: stepTimeout });

    // 打开安全组下拉框。
    const securityGroupSelect = changeDialog.locator(
      '.ant-select-selector:visible',
    ).first();
    await expect(securityGroupSelect).toBeVisible({ timeout: stepTimeout });
    const currentSecurityGroup = (
      await securityGroupSelect.innerText()
    ).trim();
    if (!originalSecurityGroup && currentSecurityGroup) {
      originalSecurityGroup = currentSecurityGroup;
      console.log(
        `[安全组名称记录] 编辑前页面未读取到原安全组，`
        + `已使用弹窗当前值作为第 2 级兜底：`
        + `${JSON.stringify(originalSecurityGroup)}。`,
      );
    }
    await securityGroupSelect.click();

    // 等待下拉选项异步加载；未出现时等待后重新打开下拉框。
    const availableOptions = interactionFrame.locator(
      '.ant-select-dropdown:visible '
      + '.ant-select-item-option:not(.ant-select-item-option-disabled)'
      + ':not(.ant-select-item-option-selected)',
    );

    let optionCount = 0;
    for (let attempt = 0; attempt < 10 && optionCount === 0; attempt += 1) {
      await page.waitForTimeout(3 * 1000);
      optionCount = await availableOptions.count();
      if (optionCount === 0) {
        await securityGroupSelect.click();
      }
    }

    if (!optionCount) {
      throw new Error('安全组下拉框中没有其他可切换的安全组');
    }

    // 随机选择一个不同于当前值的安全组。
    const selectedOption = availableOptions.nth(
      Math.floor(Math.random() * optionCount),
    );
    const newSecurityGroup = (await selectedOption.innerText()).trim();
    await selectedOption.click();

    if (newSecurityGroup === currentSecurityGroup) {
      throw new Error('随机选择的安全组与当前安全组相同，已停止提交');
    }

    // 确认更换。
    const confirmChange = changeDialog.getByRole('button', {
      name: /确\s*定/,
    }).last();
    await expect(confirmChange).toBeVisible({ timeout: stepTimeout });
    await expect(confirmChange).toBeEnabled({ timeout: stepTimeout });
    await confirmChange.click();
    await expect(changeDialog).toBeHidden({ timeout: 30 * 1000 });

    console.log(
      `${targetDescription}的主实例 ${instanceName || '名称未知'} 已将安全组`
      + `从 ${originalSecurityGroup || currentSecurityGroup || '原安全组'} `
      + '提交切换为 '
      + `${newSecurityGroup}；开始刷新校验。`,
    );

    const normalizeSecurityGroup = (value) => (
      String(value || '').replace(/\s+/g, '').trim()
    );
    const expectedSecurityGroup = normalizeSecurityGroup(newSecurityGroup);
    let verified = false;
    let lastActualSecurityGroup = '';

    const readDisplayedSecurityGroup = async () => {
      const diagnostics = [];
      const isRealSecurityGroupName = (value) => {
        const normalized = normalizeSecurityGroup(value);
        return Boolean(normalized)
          && normalized !== '-'
          && normalized !== '--'
          && normalized !== '加载中'
          && normalized !== '暂无数据';
      };
      for (const frame of page.frames()) {
        // 已知本次选择的新名称时，优先在“安全组名称”区域精确等待它。
        const expectedAnchor = frame.locator(
          '.mysql-link-guide-top-title a',
        ).filter({
          hasText: new RegExp(
            `^\\s*${newSecurityGroup.replace(
              /[.*+?^${}()|[\]\\]/g,
              '\\$&',
            )}\\s*$`,
          ),
        }).first();
        if (await expectedAnchor.isVisible().catch(() => false)) {
          const expectedText = normalizeSecurityGroup(
            await expectedAnchor.textContent().catch(() => ''),
          );
          if (isRealSecurityGroupName(expectedText)) {
            console.log(
              `[安全组名称期望值定位成功] frame=${JSON.stringify(
                frame.url(),
              )}；在安全组名称区域直接读取到期望值=`
              + `${JSON.stringify(expectedText)}。`,
            );
            return {
              name: expectedText,
              frameUrl: frame.url(),
              diagnostics,
            };
          }
        }

        // 精确对应实际 DOM：
        // <a>testconf01</a>
        // <span role="img" aria-label="edit">...</span>
        const editIcons = frame.locator(
          'span[role="img"][aria-label="edit"]'
          + '.mysql-detail-baseinfo-count-col-edit-icon',
        );
        const namesBeforeEdit = editIcons.locator(
          'xpath=preceding-sibling::a[1]',
        );
        const iconCount = await editIcons.count().catch(() => 0);
        const nameCount = await namesBeforeEdit.count().catch(() => 0);
        const frameDiagnostic = {
          frameUrl: frame.url(),
          editIconCount: iconCount,
          precedingAnchorCount: nameCount,
          anchors: [],
        };

        for (let index = 0; index < nameCount; index += 1) {
          const anchor = namesBeforeEdit.nth(index);
          const text = normalizeSecurityGroup(
            await anchor.textContent().catch(() => ''),
          );
          const visible = await anchor.isVisible().catch(() => false);
          frameDiagnostic.anchors.push({
            index,
            text,
            visible,
          });
          console.log(
            `[安全组名称精确定位] frame=${JSON.stringify(frame.url())}；`
            + `编辑图标=${iconCount}；前置a=${nameCount}；`
            + `第${index + 1}个a文字=${JSON.stringify(text)}；`
            + `可见=${visible}。`,
          );
          if (isRealSecurityGroupName(text)) {
            diagnostics.push(frameDiagnostic);
            console.log(
              `[安全组名称精确定位成功] 已从编辑图标紧邻左侧a读取：`
              + `${JSON.stringify(text)}。`,
            );
            return {
              name: text,
              frameUrl: frame.url(),
              diagnostics,
            };
          }
        }

        // 仅作为 DOM 尚未挂载编辑图标时的后备定位。
        const fallbackNames = frame.locator(
          '.mysql-link-guide-top-title a',
        );
        const fallbackCount = await fallbackNames.count().catch(() => 0);
        frameDiagnostic.fallbackAnchorCount = fallbackCount;
        for (let index = 0; index < fallbackCount; index += 1) {
          const text = normalizeSecurityGroup(
            await fallbackNames.nth(index).textContent().catch(() => ''),
          );
          if (isRealSecurityGroupName(text)) {
            frameDiagnostic.fallbackText = text;
            diagnostics.push(frameDiagnostic);
            console.log(
              `[安全组名称后备定位成功] frame=${JSON.stringify(
                frame.url(),
              )}；读取到=${JSON.stringify(text)}。`,
            );
            return {
              name: text,
              frameUrl: frame.url(),
              diagnostics,
            };
          }
        }

        diagnostics.push(frameDiagnostic);
        console.log(
          `[安全组名称定位失败] frame=${JSON.stringify(frame.url())}；`
          + `编辑图标=${iconCount}；前置a=${nameCount}；`
          + `后备a=${fallbackCount}；`
          + '空值或“--”仅代表页面仍在渲染，将继续等待。',
        );
      }
      return {
        name: '',
        frameUrl: '',
        diagnostics,
      };
    };

    // 第 3 级兜底：只有编辑前页面和弹窗当前值均未读到原安全组时，
    // 才在提交后、首次刷新前读取。此时页面仍显示原安全组。
    if (!originalSecurityGroup) {
      const preRefreshResult = await readDisplayedSecurityGroup();
      if (preRefreshResult.name) {
        originalSecurityGroup = preRefreshResult.name;
        console.log(
          `[安全组名称记录] 前两种方式均未读取到原安全组；`
          + `提交后、刷新前使用第 3 级兜底读取成功：`
          + `${JSON.stringify(originalSecurityGroup)}；`
          + `frame=${JSON.stringify(preRefreshResult.frameUrl)}。`,
        );
      } else {
        console.log(
          `[安全组名称记录] 三种方式均未读取到原安全组；`
          + `第 3 级兜底DOM诊断=`
          + `${JSON.stringify(preRefreshResult.diagnostics)}。`,
        );
      }
    }

    for (let round = 1; round <= 2; round += 1) {
      console.log(
        `[安全组更新校验][${round}/2] 等待 1 分钟后刷新页面；`
        + `实例=${instanceName || '名称未知'}；`
        + `原安全组=${originalSecurityGroup || currentSecurityGroup || '未知'}；`
        + `期望新安全组=${newSecurityGroup}。`,
      );
      await page.waitForTimeout(60 * 1000);
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: stepTimeout,
      });

      let displayedSecurityGroup = null;
      const renderDeadline = Date.now() + 60 * 1000;
      while (
        (!displayedSecurityGroup || !displayedSecurityGroup.name)
        && Date.now() < renderDeadline
      ) {
        displayedSecurityGroup = await readDisplayedSecurityGroup();
        if (!displayedSecurityGroup.name) {
          await page.waitForTimeout(500);
        }
      }

      if (!displayedSecurityGroup || !displayedSecurityGroup.name) {
        console.log(
          `[安全组更新校验][${round}/2] 刷新后 60 秒内未找到`
          + '“安全组名称”蓝色文字，本轮校验未通过；DOM诊断='
          + `${JSON.stringify(
            displayedSecurityGroup
              ? displayedSecurityGroup.diagnostics
              : [],
          )}。`,
        );
        continue;
      }

      lastActualSecurityGroup = displayedSecurityGroup.name;
      const actualNormalized = normalizeSecurityGroup(
        lastActualSecurityGroup,
      );
      verified = actualNormalized === expectedSecurityGroup;
      console.log(
        `[安全组更新校验][${round}/2] frame=${JSON.stringify(
          displayedSecurityGroup.frameUrl,
        )}；页面实际安全组=${JSON.stringify(lastActualSecurityGroup)}；`
        + `期望安全组=${JSON.stringify(newSecurityGroup)}；`
        + `标准化后实际=${JSON.stringify(actualNormalized)}；`
        + `标准化后期望=${JSON.stringify(expectedSecurityGroup)}；`
        + `名称匹配=${verified ? '是' : '否'}。`,
      );

      if (verified) {
        console.log(
          `[安全组更新校验成功] 实例 ${instanceName || '名称未知'} `
          + `的安全组已从 ${
            originalSecurityGroup || currentSecurityGroup || '未知'
          } `
          + `更新为 ${newSecurityGroup}；停止继续刷新。`,
        );
        break;
      }
    }

    if (!verified) {
      throw new Error(
        '安全组更新校验失败：最多刷新 2 次后名称仍不匹配；'
        + `实例=${instanceName || '名称未知'}；`
        + `期望=${newSecurityGroup}；`
        + `最终读取=${lastActualSecurityGroup || '未读取到'}。`,
      );
    }

    console.log('页面保持打开，检查完成后请手动关闭。');
    await page.waitForEvent('close', { timeout: 0 });
  } catch (error) {
    console.error(`安全组更新失败：${error.message}`);
    console.log('发生错误后浏览器不会自动关闭，请在页面中检查后手动关闭。');
    if (!page.isClosed()) {
      await page.waitForEvent('close', { timeout: 0 });
    }
    throw error;
  } finally {
    await context.close();
  }
});
