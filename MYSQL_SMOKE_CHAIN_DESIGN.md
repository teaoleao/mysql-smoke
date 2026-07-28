# MySQL 冒烟测试单浏览器串联方案

## 一、必须满足的前提

本次串联方案必须同时满足：

1. 总流程只启动一次 Microsoft Edge。
2. 操作人员只登录一次。
3. 11 个冒烟测试共享同一个 `BrowserContext` 和当前 `Page`。
4. 某个冒烟操作或校验失败时：
   - 当前步骤标记失败；
   - 控制台用红色输出错误原因、页面和定位信息；
   - 浏览器不关闭；
   - 总流程继续执行下一个冒烟测试。
5. 每个步骤之间必须有明显的日志分隔。
6. 最后统一输出通过、失败、跳过数量及每个失败步骤的原因。
7. 现有 11 个测试仍能单独运行。
8. 不复制一套新的业务代码，单独运行和串联运行共用同一场景实现。

## 二、推荐执行顺序

```text
01. 创建 MySQL 8.0 实例
02. 创建 MySQL 5.7 实例
03. 创建只读实例
04. 创建数据库代理
05. 更新代理账号
06. 删除数据库代理
07. 备份与恢复
08. 下载备份
09. 删除备份
10. 更换安全组
11. 退订实例
```

退订实例属于破坏性操作，必须放在最后。

## 三、统一控制台输出

### 步骤开始

```text
================================================================================
▶ [03/11] 开始：创建只读实例
  实例：mysql_xxxx
  开始时间：2026-07-28 15:30:00
================================================================================
```

### 步骤成功

使用绿色输出：

```text
--------------------------------------------------------------------------------
✓ [03/11] 通过：创建只读实例
  校验：只读实例数量从 1 增加到 2
  耗时：2分18秒
--------------------------------------------------------------------------------
```

### 步骤失败

使用红色输出：

```text
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
✗ [03/11] 失败：创建只读实例
  阶段：刷新后的结果校验
  原因：只读实例数量没有增加
  期望：2
  实际：1
  实例：mysql_xxxx
  URL：https://console.cucloud.cn/...
  处理：记录失败，继续执行第 04 个冒烟测试
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
```

Node 控制台颜色：

```js
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
```

Dashboard 需要保留 ANSI 颜色，或把日志级别转换成对应 HTML 样式。

## 四、失败后继续的规则

每个场景独立捕获错误，不能直接让整个工作流抛出结束：

```js
for (const scenario of scenarios) {
  try {
    const result = await scenario.run(runtime);
    reportPassed(scenario, result);
  } catch (error) {
    reportFailed(scenario, error, runtime);
  }
}
```

总流程结束后：

- 全部通过：进程退出码为 `0`。
- 存在任意失败：所有步骤仍执行完毕，但最终退出码为 `1`。
- 浏览器保持打开，人工检查后关闭。

### 依赖步骤失败时

失败不能导致后续测试完全停止，因此后续场景采用以下顺序寻找资源：

1. 优先使用本轮工作流已经记录的资源。
2. 本轮资源不存在时，从控制台选择满足条件的已有资源。
3. 找不到任何可操作资源时，该步骤标记为“跳过”，红色输出具体原因，然后继续下一步。

例如：

- 创建只读失败，创建代理可以寻找其他“已有只读实例的 MySQL 5.7 主实例”。
- 创建代理失败，更新代理可以寻找其他“已有运行中代理的实例”。
- 创建备份失败，下载备份可以寻找其他已有成功备份。

这样既能继续执行，又不会把“没有测试条件”错误地标记为成功。

## 五、方案一：单一 Playwright 工作流测试

新增：

```text
tests/workflows/mysql-smoke-chain.test.js
```

该文件只包含一个 Playwright `test()`：

```js
test('MySQL 完整冒烟测试', async () => {
  const runtime = await createMysqlRuntime();

  await runAllScenarios(runtime);

  await runtime.page.waitForEvent('close', { timeout: 0 });
});
```

### 浏览器生命周期

```text
启动一次 persistent Edge
        ↓
关闭历史恢复标签页
        ↓
打开登录 URL
        ↓
人工登录一次
        ↓
进入 MySQL 控制台
        ↓
在同一个 context/page 中依次执行 11 个场景
        ↓
输出总报告
        ↓
保持最终页面打开
```

### 页面切换

场景不能自行启动浏览器，只能使用：

```js
runtime.context
runtime.page
```

出现新标签页时：

1. 把新页面设置为 `runtime.page`。
2. 确认旧页面不再需要后将其关闭。
3. 保证正常情况下始终只有一个业务标签页。

### 优点

- 实现结构直观。
- 只启动一次 Edge、只登录一次。
- 可以用 `test.step()` 在 Playwright 报告中显示 11 个步骤。
- 失败捕获、日志分隔和最终汇总容易实现。
- 适合由 Dashboard 直接执行。

### 缺点

- 整个链属于一个 Playwright 测试，HTML 报告顶层只显示一个总测试。
- 需要把当前业务代码逐步提取成场景函数。

## 六、方案二：独立 Node 工作流运行器

新增：

```text
scripts/run-mysql-smoke-workflow.js
```

不再连续执行 11 次 `npx playwright test`，而是由 Node 直接：

1. 启动一个 Playwright persistent context。
2. 登录一次。
3. 依次调用 11 个场景函数。
4. 自己生成控制台汇总和 JSON 报告。

启动方式：

```powershell
node scripts/run-mysql-smoke-workflow.js
```

### 优点

- 浏览器生命周期完全由工作流控制。
- 日志、颜色、继续执行和最终退出码最灵活。
- 不受 Playwright Test 单测试失败语义影响。

### 缺点

- 不能直接获得标准 Playwright HTML 测试步骤报告。
- 需要自行处理截图、trace 和附件归档。
- Dashboard 需要增加一种新的 Node 命令类型。

## 七、两个方案都采用的代码结构

```text
tests/
  helpers/
    browser-pages.js
    mysql-runtime.js
    mysql-workflow-state.js
    workflow-logger.js
  scenarios/
    create-80-entity.js
    create-57-entity.js
    create-readonly.js
    create-proxy.js
    update-proxy-account.js
    delete-proxy.js
    backup-restore.js
    download-backup.js
    delete-backup.js
    update-security-group.js
    unsubscribe-instance.js
  workflows/
    mysql-smoke-chain.test.js
```

### Runtime

```js
{
  context,
  page,
  state,
  logger,
  setPage(nextPage),
  goToInstanceList(),
  goToMysqlConsole()
}
```

### State

```js
{
  runId,
  create80: {
    instanceName,
    instanceId
  },
  create57: {
    instanceName,
    instanceId,
    initialReadonlyCount
  },
  readonly: {
    instanceName,
    countBefore,
    countAfter
  },
  proxy: {
    address,
    status
  },
  backup: {
    name,
    id,
    status,
    downloadUrl
  },
  securityGroup: {
    before,
    after
  },
  results: []
}
```

状态优先保存在内存中，每一步结束后写入：

```text
.playwright/state/runs/<runId>.json
```

JSON 是故障检查点，不是正常步骤间传递的主要方式。

## 八、推荐方案

推荐 **方案一：单一 Playwright 工作流测试**。

原因：

1. 完全满足只启动一次 Edge、只登录一次。
2. 保留 Playwright HTML 报告、截图和 trace 能力。
3. Dashboard 仍然执行熟悉的 `npx playwright test` 命令。
4. `test.step()` 可以清晰呈现 11 个业务步骤。
5. 每个场景内部捕获失败，红色输出后继续，最后统一决定总结果。
6. 后续维护定位器时，单独测试和总流程共用同一个场景函数，只修改一处。

总流程命令：

```powershell
npx playwright test tests/workflows/mysql-smoke-chain.test.js --headed
```

## 九、推荐实施顺序

### 第一阶段：搭建框架

- 新增 `mysql-runtime.js`。
- 新增 `workflow-logger.js`。
- 新增工作流状态与结果汇总。
- 确保一次 Edge、一次登录、一个活动业务页面。

### 第二阶段：提取场景

按依赖顺序逐个提取：

1. 创建 8.0。
2. 创建 5.7。
3. 创建只读。
4. 创建代理。
5. 更新代理。
6. 删除代理。
7. 备份恢复。
8. 下载备份。
9. 删除备份。
10. 更换安全组。
11. 退订。

每提取一个场景，都同时验证：

- 原测试文件仍能单独执行。
- 总流程可以调用。
- 失败后可以进入下一步。

### 第三阶段：接入 Dashboard

增加“执行全部冒烟测试”按钮，并显示：

- 总进度，例如 `5/11`。
- 当前步骤。
- 每步耗时。
- 绿色成功日志。
- 红色失败日志。
- 最终通过、失败和跳过汇总。

## 十、最终汇总示例

```text
================================================================================
MySQL 冒烟测试执行完毕
总数：11
通过：8
失败：2
跳过：1
总耗时：48分32秒

失败：
1. 创建数据库代理：5 次轮询后状态仍为“创建中”
2. 更换安全组：期望 testconf01，实际 secg_test01

跳过：
1. 更新代理账号：没有找到运行中的代理

浏览器将保持打开，请人工检查后关闭。
================================================================================
```
