const path = require('path');
const { chromium } = require('@playwright/test');
const { keepOnlyOneStartupPage } = require('./browser-pages');

async function createMysqlRuntime() {
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

  const page = await keepOnlyOneStartupPage(context);
  const runtime = {
    context,
    page,
    state: {
      runId: new Date().toISOString().replace(/[:.]/g, '-'),
      results: [],
    },
    setPage(nextPage) {
      if (nextPage && !nextPage.isClosed()) this.page = nextPage;
      return this.page;
    },
    async useLatestPage() {
      const pages = context.pages().filter((item) => !item.isClosed());
      if (pages.length) this.page = pages[pages.length - 1];
      await this.page.bringToFront();
      return this.page;
    },
  };

  return runtime;
}

module.exports = {
  createMysqlRuntime,
};
