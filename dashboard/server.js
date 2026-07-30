const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.SMOKE_DASHBOARD_PORT || 4173);

const TESTS = [
  { id: 'create-80', group: '实例创建', name: '创建 MySQL 8.0 实例', file: 'tests/mysql-smoke.createEntity.test.js', icon: 'database' },
  { id: 'create-57', group: '实例创建', name: '创建 MySQL 5.7 实例', file: 'tests/mysql-smoke.create57Entity.test.js', icon: 'layers' },
  { id: 'readonly', group: '只读实例', name: '创建只读实例', file: 'tests/mysql-smoke.createOnlyReadEntity.test.js', icon: 'copy' },
  { id: 'proxy-create', group: '数据库代理', name: '创建代理节点', file: 'tests/mysql-smoke.createProxy.test.js', icon: 'network' },
  { id: 'proxy-update', group: '数据库代理', name: '更新代理账号', file: 'tests/mysql-smoke.updateProxyAccount.test.js', icon: 'key' },
  { id: 'proxy-delete', group: '数据库代理', name: '删除代理服务', file: 'tests/mysql-smoke.deleteProxy.test.js', icon: 'trash' },
  { id: 'backup', group: '备份与恢复', name: '备份与恢复', file: 'tests/mysql-smoke.backupRestore.test.js', icon: 'refresh' },
  { id: 'backup-download', group: '备份与恢复', name: '下载备份', file: 'tests/mysql-smoke.downloadBackup.test.js', icon: 'download' },
  { id: 'backup-delete', group: '备份与恢复', name: '删除备份', file: 'tests/mysql-smoke.deleteBackup.test.js', icon: 'trash' },
  { id: 'security-group-update', group: '连接与安全', name: '更换实例安全组', file: 'tests/mysql-smoke.updateSecurityGroup.test.js', icon: 'shield' },
  { id: 'instance-unsubscribe', group: '实例生命周期', name: '退订实例', file: 'tests/mysql-smoke.unsubscribeInstance.test.js', icon: 'power' },
];

let activeRun = null;
let runSequence = 0;
const listeners = new Set();

function emit(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const response of listeners) response.write(payload);
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

function serveStatic(request, response) {
  const requestPath = request.url === '/' ? '/index.html' : request.url;
  const cleanPath = requestPath.split('?')[0].replace(/^[/\\]+/, '');
  const filePath = path.resolve(PUBLIC_DIR, cleanPath);
  const insidePublic = filePath === PUBLIC_DIR
    || filePath.startsWith(`${PUBLIC_DIR}${path.sep}`);
  if (!insidePublic || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  const extension = path.extname(filePath);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
  };
  response.writeHead(200, {
    'Content-Type': types[extension] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(response);
}

function startTest(test) {
  const runId = ++runSequence;
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = ['playwright', 'test', test.file, '--headed'];
  const startedAt = new Date().toISOString();

  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '0' },
    windowsHide: true,
  });

  activeRun = {
    runId,
    test,
    child,
    startedAt,
    status: 'running',
    stopRequested: false,
  };
  emit({ type: 'started', runId, testId: test.id, command: `npx ${args.join(' ')}`, startedAt });

  const forward = (stream, chunk) => {
    emit({ type: 'log', runId, stream, text: chunk.toString() });
  };
  child.stdout.on('data', (chunk) => forward('stdout', chunk));
  child.stderr.on('data', (chunk) => forward('stderr', chunk));
  child.on('error', (error) => forward('stderr', `${error.message}\n`));
  child.on('close', (code, signal) => {
    const status = activeRun?.runId === runId && activeRun.stopRequested
      ? 'stopped'
      : code === 0
        ? 'passed'
        : signal
          ? 'stopped'
          : 'failed';
    emit({ type: 'finished', runId, testId: test.id, status, code, signal, finishedAt: new Date().toISOString() });
    if (activeRun?.runId === runId) activeRun = null;
  });
}

function stopActiveRun() {
  if (!activeRun) return Promise.resolve(false);

  const run = activeRun;
  run.stopRequested = true;
  run.status = 'stopping';
  emit({
    type: 'log',
    runId: run.runId,
    stream: 'stderr',
    text: `\n[STOP] 正在终止 Playwright 进程树（PID ${run.child.pid}）...\n`,
  });

  if (process.platform === 'win32') {
    return new Promise((resolve, reject) => {
      const killer = spawn(
        'taskkill.exe',
        ['/PID', String(run.child.pid), '/T', '/F'],
        { windowsHide: true },
      );
      let errorText = '';
      killer.stderr.on('data', (chunk) => {
        errorText += chunk.toString();
      });
      killer.on('error', reject);
      killer.on('close', (code) => {
        if (code !== 0 && run.child.exitCode === null) {
          reject(new Error(errorText.trim() || `taskkill 退出码 ${code}`));
          return;
        }
        resolve(true);
      });
    });
  }

  run.child.kill('SIGINT');
  const forceTimer = setTimeout(() => {
    if (run.child.exitCode === null) run.child.kill('SIGKILL');
  }, 5000);
  forceTimer.unref();
  return Promise.resolve(true);
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/api/tests') {
    sendJson(response, 200, {
      tests: TESTS.map((test) => ({ ...test, exists: fs.existsSync(path.join(ROOT, test.file)) })),
      active: activeRun ? {
        runId: activeRun.runId,
        testId: activeRun.test.id,
        startedAt: activeRun.startedAt,
        status: activeRun.status,
      } : null,
    });
    return;
  }

  if (request.method === 'GET' && request.url === '/api/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.write(': connected\n\n');
    listeners.add(response);
    request.on('close', () => listeners.delete(response));
    return;
  }

  const runMatch = request.method === 'POST' && request.url.match(/^\/api\/run\/([^/]+)$/);
  if (runMatch) {
    const test = TESTS.find((item) => item.id === decodeURIComponent(runMatch[1]));
    if (!test) return sendJson(response, 404, { error: '测试不存在' });
    if (activeRun) return sendJson(response, 409, { error: '已有测试正在运行，请先等待或停止当前测试' });
    if (!fs.existsSync(path.join(ROOT, test.file))) return sendJson(response, 404, { error: '测试文件不存在' });
    startTest(test);
    sendJson(response, 202, { ok: true });
    return;
  }

  if (request.method === 'POST' && request.url === '/api/stop') {
    if (!activeRun) return sendJson(response, 200, { ok: true, message: '当前没有运行中的测试' });
    stopActiveRun()
      .then(() => sendJson(response, 202, { ok: true }))
      .catch((error) => {
        if (activeRun) {
          activeRun.stopRequested = false;
          activeRun.status = 'running';
        }
        sendJson(response, 500, {
          ok: false,
          error: `停止测试失败：${error.message}`,
        });
      });
    return;
  }

  if (request.method === 'GET') return serveStatic(request, response);
  response.writeHead(405);
  response.end('Method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MySQL Smoke Console: http://127.0.0.1:${PORT}`);
});
