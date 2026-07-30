const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const WIDE_LINE = '='.repeat(80);
const THIN_LINE = '-'.repeat(80);

function elapsedText(startedAt) {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

function startScenario(index, total, name) {
  console.log(CYAN + WIDE_LINE);
  console.log(`▶ [${String(index).padStart(2, '0')}/${total}] 开始：${name}`);
  console.log(`  开始时间：${new Date().toLocaleString('zh-CN')}`);
  console.log(WIDE_LINE + RESET);
}

function passScenario(index, total, name, startedAt, detail = '') {
  console.log(GREEN + THIN_LINE);
  console.log(`✓ [${String(index).padStart(2, '0')}/${total}] 通过：${name}`);
  if (detail) console.log(`  结果：${detail}`);
  console.log(`  耗时：${elapsedText(startedAt)}`);
  console.log(THIN_LINE + RESET);
}

function failScenario(index, total, name, startedAt, error, page) {
  console.error(RED + '!'.repeat(80));
  console.error(`✗ [${String(index).padStart(2, '0')}/${total}] 失败：${name}`);
  console.error(`  原因：${error?.message || String(error)}`);
  console.error(`  URL：${page && !page.isClosed() ? page.url() : '页面不可用'}`);
  console.error(`  耗时：${elapsedText(startedAt)}`);
  console.error('  处理：记录失败，继续执行下一个冒烟测试。');
  console.error('!'.repeat(80) + RESET);
}

function skipScenario(index, total, name, reason) {
  console.error(YELLOW + THIN_LINE);
  console.error(`→ [${String(index).padStart(2, '0')}/${total}] 跳过：${name}`);
  console.error(`  原因：${reason}`);
  console.error(THIN_LINE + RESET);
}

module.exports = {
  RED,
  GREEN,
  CYAN,
  YELLOW,
  RESET,
  WIDE_LINE,
  startScenario,
  passScenario,
  failScenario,
  skipScenario,
};
