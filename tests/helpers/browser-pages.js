async function keepOnlyOneStartupPage(context) {
  const restoredPages = context.pages().filter((page) => !page.isClosed());
  const page = restoredPages[0] || await context.newPage();
  const extraPages = restoredPages.slice(1);

  for (const extraPage of extraPages) {
    await extraPage.close({ runBeforeUnload: false }).catch(() => {});
  }

  await page.bringToFront();
  console.log(
    `[浏览器启动清理] 恢复标签页=${restoredPages.length}，`
    + `已关闭=${extraPages.length}，当前保留=${context.pages().length}。`,
  );
  return page;
}

module.exports = {
  keepOnlyOneStartupPage,
};
