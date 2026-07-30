async function keepOnlyOneStartupPage(context) {
  const initialPages = context.pages().filter((page) => !page.isClosed());
  const page = initialPages[0] || await context.newPage();
  const seenPages = new Set(initialPages);
  const closedPages = new Set();

  const closeRestoredPage = async (candidate) => {
    if (
      candidate === page
      || candidate.isClosed()
      || closedPages.has(candidate)
    ) {
      return;
    }

    seenPages.add(candidate);
    closedPages.add(candidate);
    await candidate.close({ runBeforeUnload: false }).catch(() => {});
  };

  // Edge 使用持久化用户目录时，旧会话标签可能在 context 创建后异步恢复。
  // 启动阶段同时监听新 page 并主动扫描，避免旧标签躲过一次性清理。
  const pendingClosures = new Set();
  const handleStartupPage = (candidate) => {
    const closing = closeRestoredPage(candidate);
    pendingClosures.add(closing);
    closing.finally(() => pendingClosures.delete(closing));
  };

  context.on('page', handleStartupPage);
  try {
    const cleanupDeadline = Date.now() + 5000;

    while (Date.now() < cleanupDeadline) {
      const pagesBeforeSweep = context.pages().filter(
        (candidate) => !candidate.isClosed(),
      );
      pagesBeforeSweep.forEach((candidate) => seenPages.add(candidate));

      const extras = pagesBeforeSweep.filter((candidate) => candidate !== page);
      await Promise.all(extras.map(closeRestoredPage));
      await Promise.all([...pendingClosures]);

      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    context.off('page', handleStartupPage);
  }

  await page.bringToFront();
  const remainingCount = context.pages().filter(
    (candidate) => !candidate.isClosed(),
  ).length;
  console.log(
    `[浏览器启动清理] 启动阶段发现标签页=${seenPages.size}，`
    + `已关闭旧标签页=${closedPages.size}，当前保留=${remainingCount}。`,
  );

  if (remainingCount !== 1) {
    throw new Error(
      `浏览器启动标签页清理失败：期望保留 1 个，实际保留 ${remainingCount} 个。`,
    );
  }

  return page;
}

async function returnToMysqlInstanceList(page, stepTimeout) {
  if (/\/console\/mysql\/main\/instancemanage(?:[/?#]|$)/.test(page.url())) {
    return page;
  }

  const backToList = page.getByText('返回实例列表', { exact: true })
    .filter({ visible: true })
    .first();
  if (await backToList.isVisible().catch(() => false)) {
    await backToList.click();
    await page.waitForURL(/\/console\/mysql\/main\/instancemanage(?:[/?#]|$)/, {
      timeout: stepTimeout,
    });
    await page.waitForLoadState('domcontentloaded');
    return page;
  }

  const managementConsole = page.getByText('管理控制台', { exact: true })
    .filter({ visible: true })
    .last();
  if (await managementConsole.isVisible().catch(() => false)) {
    await managementConsole.click();
    await page.waitForURL(/\/console\/mysql\/main\/instancemanage(?:[/?#]|$)/, {
      timeout: stepTimeout,
    });
    await page.waitForLoadState('domcontentloaded');
    return page;
  }

  throw new Error(
    `串联模式当前页面无法返回 MySQL 实例列表：${page.url()}；`
    + '为避免重复打开联通云门户，已禁止回退到完整登录导航',
  );
}

module.exports = {
  keepOnlyOneStartupPage,
  returnToMysqlInstanceList,
};
