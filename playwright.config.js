const { defineConfig } = require('@playwright/test');
require('dotenv').config();

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 1,

  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],

  use: {
    // 指定使用本机 Microsoft Edge
    channel: 'msedge',

    // 显示实际浏览器窗口，方便你手动登录
    headless: false,

    // 从 .env 读取登录页地址
    baseURL: process.env.BASE_URL,
    // 测试失败时自动保留证据
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
});
