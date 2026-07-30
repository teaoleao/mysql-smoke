const groups = document.querySelector('#testGroups');
const terminal = document.querySelector('#terminal');
const commandText = document.querySelector('#commandText');
const stopButton = document.querySelector('#stopRun');
const globalStatus = document.querySelector('#globalStatus');
const statusDetail = document.querySelector('#statusDetail');
const toast = document.querySelector('#toast');
let tests = [];
let activeId = null;

const symbols = {
  database: 'DB',
  layers: '57',
  copy: 'RO',
  network: 'PX',
  key: 'ID',
  trash: '×',
  refresh: '↻',
  download: '↓',
  shield: 'SG',
  power: '⏻',
};
const colors = ['#16a89a', '#5c8ff7', '#7a77df', '#2bb78c', '#d69b43', '#de6875', '#408fc8'];

function notify(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2400);
}

function appendLog(text, stream = 'stdout') {
  if (terminal.querySelector('.muted')) terminal.textContent = '';
  const node = document.createTextNode(text);
  terminal.append(node);
  if (stream === 'stderr') terminal.style.setProperty('--last-stream', 'stderr');
  terminal.scrollTop = terminal.scrollHeight;
}

function setState(testId, state) {
  document.querySelectorAll('.test-card').forEach((card) => {
    if (card.dataset.id === testId) {
      card.classList.remove('is-running', 'is-passed', 'is-failed');
      if (state !== 'ready') card.classList.add(`is-${state}`);
      card.querySelector('.state').textContent = ({ running: '运行中', passed: '已通过', failed: '未通过', stopped: '已停止' })[state] || '就绪';
    }
  });
}

function updateControls(running) {
  document.querySelectorAll('.run-button').forEach((button) => { button.disabled = running; });
  stopButton.disabled = !running;
}

async function runTest(id) {
  const test = tests.find((item) => item.id === id);
  const response = await fetch(`/api/run/${encodeURIComponent(id)}`, { method: 'POST' });
  const result = await response.json();
  if (!response.ok) return notify(result.error || '启动失败');
  activeId = id;
  terminal.textContent = '';
  commandText.textContent = `npx playwright test ${test.file} --headed`;
  globalStatus.textContent = '运行中';
  statusDetail.textContent = test.name;
  setState(id, 'running');
  updateControls(true);
}

function render() {
  const grouped = tests.reduce((result, test) => {
    if (!result.has(test.group)) result.set(test.group, []);
    result.get(test.group).push(test);
    return result;
  }, new Map());
  groups.innerHTML = [...grouped.entries()].map(([group, items]) => `
    <section class="group">
      <h3 class="group-title">${group}</h3>
      <div class="cards">
        ${items.map((test) => {
          const index = tests.indexOf(test);
          return `<article class="test-card" data-id="${test.id}" style="--card-color:${colors[index % colors.length]}">
            <div class="card-top"><span class="test-icon">${symbols[test.icon] || '▶'}</span><span class="state">${test.exists ? '就绪' : '文件缺失'}</span></div>
            <h3>${test.name}</h3>
            <code>${test.file}</code>
            <button class="run-button" data-run="${test.id}" ${test.exists ? '' : 'disabled'}>运行测试 →</button>
          </article>`;
        }).join('')}
      </div>
    </section>`).join('');
  groups.querySelectorAll('[data-run]').forEach((button) => button.addEventListener('click', () => runTest(button.dataset.run)));
}

async function initialize() {
  const response = await fetch('/api/tests');
  const data = await response.json();
  tests = data.tests;
  document.querySelector('#testCount').textContent = tests.length;
  render();
  if (data.active) {
    activeId = data.active.testId;
    setState(activeId, 'running');
    updateControls(true);
    globalStatus.textContent = '运行中';
    statusDetail.textContent = tests.find((test) => test.id === activeId)?.name || '测试执行中';
  }
}

const events = new EventSource('/api/events');
events.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === 'started') {
    appendLog(`$ ${event.command}\n\n`);
  } else if (event.type === 'log') {
    appendLog(event.text, event.stream);
  } else if (event.type === 'finished') {
    const state = event.status === 'passed' ? 'passed' : event.status === 'stopped' ? 'stopped' : 'failed';
    setState(event.testId, state);
    appendLog(`\n[${event.status.toUpperCase()}] 进程结束，退出码：${event.code ?? '—'}\n`);
    globalStatus.textContent = event.status === 'passed' ? '通过' : event.status === 'stopped' ? '已停止' : '失败';
    statusDetail.textContent = '可以继续选择其他测试';
    activeId = null;
    updateControls(false);
  }
};

document.querySelector('#clearLog').addEventListener('click', () => { terminal.innerHTML = '<span class="muted">日志已清空。</span>'; });
stopButton.addEventListener('click', async () => {
  stopButton.disabled = true;
  notify('正在停止测试及其浏览器进程');
  try {
    const response = await fetch('/api/stop', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '停止测试失败');
  } catch (error) {
    notify(error.message);
    stopButton.disabled = false;
  }
});
document.querySelector('#themeToggle').addEventListener('click', () => document.body.classList.toggle('compact'));
initialize().catch((error) => notify(error.message));
