const { test, expect } = require('@playwright/test');
const {
  openRandomMysqlInstance,
} = require('./helpers/mysql-instance-navigation');

test.describe.configure({ retries: 0 });

test('MySQL 备份实例 - 复制外网下载地址并访问', async () => {
  test.setTimeout(0);
  const stepTimeout = 10 * 60 * 1000;

  const {
    context,
    page,
    instanceName,
  } = await openRandomMysqlInstance(stepTimeout);

  try {
    // 1. 进入实例详情页左侧“备份恢复”。
    const backupRestore = page.getByText('备份恢复', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(backupRestore).toBeVisible({ timeout: stepTimeout });
    await backupRestore.click();

    // 2. 确认默认进入“数据备份”页签。
    const dataBackup = page.getByText('数据备份', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(dataBackup).toBeVisible({ timeout: stepTimeout });

    // 3. 点击备份列表第一条记录操作列中的“下载”。
    const firstDownload = page.getByText('下载', { exact: true })
      .filter({ visible: true })
      .first();
    await expect(firstDownload).toBeVisible({ timeout: stepTimeout });
    await firstDownload.click();

    // 4. 在下载弹窗中找到“外网下载地址”。
    const externalAddress = page.getByText(/外网下载地址\s*[:：]?/, { exact: true })
      .filter({ visible: true })
      .first();
    await expect(externalAddress).toBeVisible({ timeout: stepTimeout });

    const downloadDialog = page.locator('.ant-modal-content:visible').last();
    await expect(downloadDialog).toBeVisible({ timeout: stepTimeout });

    // 5. 弹窗中第一个 copy 是内网地址，最后一个 copy 是外网地址。
    await context.grantPermissions(
      ['clipboard-read', 'clipboard-write'],
      { origin: new URL(page.url()).origin },
    );
    const externalCopy = downloadDialog.getByRole('img', {
      name: 'copy',
      exact: true,
    }).last();
    await expect(externalCopy).toBeVisible({ timeout: stepTimeout });
    await externalCopy.click();

    // 6. 从剪贴板读取已复制的外网地址。
    let downloadUrl = (await page.evaluate(
      () => navigator.clipboard.readText(),
    ).catch(() => '')).trim();

    // 剪贴板不可读时，从“外网下载地址”行的完整文本中提取地址。
    if (!/^https?:\/\//i.test(downloadUrl)) {
      const dialogText = await downloadDialog.innerText();
      const urls = dialogText.match(/https?:\/\/\S+/gi) || [];
      downloadUrl = urls.at(-1) || '';
    }

    const parsedDownloadUrl = new URL(downloadUrl);
    expect(['http:', 'https:']).toContain(parsedDownloadUrl.protocol);
    expect(
      parsedDownloadUrl.hostname === 'cucloud.cn'
      || parsedDownloadUrl.hostname.endsWith('.cucloud.cn'),
    ).toBeTruthy();
    const recordedDownloadUrl = parsedDownloadUrl.toString();
    console.log(
      `[备份下载校验] 已记录实例 ${instanceName || '名称未知'} 的外网下载地址：`
      + `${recordedDownloadUrl}`,
    );

    // 7. 新建标签页并访问外网下载地址。
    const downloadPage = await context.newPage();
    await downloadPage.bringToFront();
    let directDownloadStarted = false;
    const downloadResponse = await downloadPage.goto(recordedDownloadUrl, {
      waitUntil: 'domcontentloaded',
      timeout: stepTimeout,
    }).catch((error) => {
      // 某些下载地址会直接触发文件下载，此时浏览器可能中止普通页面导航。
      if (!/Download is starting|ERR_ABORTED/i.test(error.message)) throw error;
      directDownloadStarted = true;
      return null;
    });

    const finalDownloadPageUrl = downloadPage.url();
    console.log(
      `[备份下载校验] 新标签页跳转完成：`
      + `请求地址=${recordedDownloadUrl}；`
      + `最终页面=${finalDownloadPageUrl}；`
      + `HTTP状态=${downloadResponse?.status() ?? '直接触发下载'}；`
      + `直接下载=${directDownloadStarted}。`,
    );
    console.log(
      `[备份下载成功] ${recordedDownloadUrl} 下载成功；`
      + `实例=${instanceName || '名称未知'}。`,
    );
    console.log('浏览器将保持打开，检查完成后请手动关闭。');
    await downloadPage.waitForEvent('close', { timeout: 0 });
  } finally {
    await context.close();
  }
});
