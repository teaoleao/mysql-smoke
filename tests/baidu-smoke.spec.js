const { test, expect } = require('@playwright/test');

test('百度首页冒烟测试', async ({ page }) => {
  await page.goto('https://www.baidu.com/', {
    waitUntil: 'domcontentloaded',
  });

  // 验证当前页面确实是百度
  await expect(page).toHaveURL(/baidu\.com/);

  // 验证百度页面已完成基础渲染
  await expect(page).toHaveTitle(/百度一下/);
  await expect(page.locator('body')).toBeVisible();

  // 截图留证
  await page.screenshot({
    path: 'test-results/baidu-home.png',
    fullPage: true,
  });

  console.log('百度首页加载正常，冒烟测试通过。');
});