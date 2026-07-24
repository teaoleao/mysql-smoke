# MySQL Smoke Lab

基于 Playwright 和 Microsoft Edge 的联通云 CUDB for MySQL 前端冒烟测试项目。

项目提供两种执行方式：

- 在命令行中单独运行某个测试文件。
- 使用本地可视化控制台选择测试，并实时查看执行日志。

测试运行时会打开真实 Edge 窗口。登录、密码及其他敏感内容由操作人员直接在浏览器页面中输入，项目不会在前端控制台中读取或保存这些信息。

## 环境要求

- Windows 10/11
- Node.js 18 或更高版本
- npm
- Microsoft Edge
- 可访问联通云控制台的网络环境

## 安装

克隆项目后进入项目目录：

```powershell
cd D:\cs\722
npm install
```

项目使用本机 Microsoft Edge，不需要额外下载 Playwright Chromium。

## 环境变量

在项目根目录创建 `.env`：

```dotenv
BASE_URL=https://console.cucloud.cn/console/home/overview
POST_LOGIN_SUCCESS_TEXT=控制台
RUN_PURCHASE_FLOW=false
```

变量说明：

| 变量 | 说明 |
| --- | --- |
| `BASE_URL` | 联通云控制台入口 |
| `POST_LOGIN_SUCCESS_TEXT` | 用于判断登录成功的页面文字 |
| `RUN_PURCHASE_FLOW` | 是否允许执行涉及购买流程的测试控制项 |

`.env` 已加入 `.gitignore`，不要将账号、密码、Cookie 或其他敏感信息提交到 Git。

## 启动可视化控制台

执行：

```powershell
npm run dashboard
```

浏览器访问：

```text
http://127.0.0.1:4173
```

控制台提供：

- 按业务类别展示 MySQL 冒烟测试。
- 点击按钮执行对应的 Playwright 测试。
- 自动以 `--headed` 模式打开 Edge。
- 实时显示标准输出、错误日志和执行结果。
- 显示运行中、通过、失败及停止状态。
- 支持停止当前测试和清空日志。

例如点击“备份与恢复”后，后台实际执行：

```powershell
npx playwright test tests/mysql-smoke.backupRestore.test.js --headed
```

控制台仅监听本机地址 `127.0.0.1`。同一时间只允许运行一个测试，避免多个脚本同时占用相同的 Edge 登录配置。

## 命令行执行测试

运行单个测试：

```powershell
npx playwright test tests/mysql-smoke.backupRestore.test.js --headed
```

运行全部测试：

```powershell
npx playwright test --headed
```

列出测试但不执行：

```powershell
npx playwright test --list
```

查看上一次 HTML 报告：

```powershell
npx playwright show-report
```

## 当前测试场景

| 分类 | 测试文件 | 说明 |
| --- | --- | --- |
| 实例创建 | `mysql-smoke.createEntity.test.js` | 创建 MySQL 8.0 实例 |
| 实例创建 | `mysql-smoke.create57Entity.test.js` | 创建 MySQL 5.7 实例 |
| 只读实例 | `mysql-smoke.createOnlyReadEntity.test.js` | 为 MySQL 5.7 实例创建只读实例 |
| 数据库代理 | `mysql-smoke.createProxy.test.js` | 创建或添加代理节点 |
| 数据库代理 | `mysql-smoke.updateProxyAccount.test.js` | 更新代理账号 |
| 数据库代理 | `mysql-smoke.deleteProxy.test.js` | 删除代理服务 |
| 备份与恢复 | `mysql-smoke.backupRestore.test.js` | 创建备份并执行恢复流程 |

## 测试执行方式

典型测试流程如下：

1. 脚本打开 Edge。
2. 如果登录状态失效，等待操作人员完成登录。
3. 脚本点击联通云、产品和 CUDB for MySQL。
4. 进入对应实例或购买页面。
5. 遇到密码等敏感字段时，等待操作人员输入。
6. 检测到输入完成后继续执行自动化步骤。
7. 最终页面保持打开，供操作人员确认结果。

项目使用持久化 Edge 登录目录：

```text
.playwright/edge-profile
```

该目录包含浏览器登录状态，已被 Git 忽略。不要复制或上传该目录。

## 项目结构

```text
722/
├─ dashboard/
│  ├─ server.js               # 本地控制台服务和测试进程管理
│  └─ public/
│     ├─ index.html           # 控制台页面
│     ├─ styles.css           # 页面视觉样式
│     └─ app.js               # 测试按钮、日志和状态交互
├─ tests/
│  ├─ helpers/                # 公共页面导航逻辑
│  └─ mysql-smoke.*.test.js   # MySQL 冒烟测试
├─ playwright.config.js
├─ package.json
└─ .env
```

## 测试产物

Playwright 可能生成以下目录：

- `test-results/`：截图、视频、Trace 和错误上下文。
- `playwright-report/`：HTML 测试报告。
- `.playwright/`：浏览器登录状态和测试状态记录。

这些运行产物默认不会提交到 Git。

## 常见问题

### 点击控制台按钮后没有打开 Edge

确认：

- 运行控制台的终端窗口仍然开启。
- 当前没有其他测试正在运行。
- Microsoft Edge 已正确安装。
- 测试文件没有被移动或重命名。

也可以直接在命令行执行对应命令查看完整错误：

```powershell
npx playwright test tests/mysql-smoke.backupRestore.test.js --headed
```

### 每次运行都要求重新登录

确认 `.playwright/edge-profile` 没有被删除，并避免同时运行多个使用相同浏览器配置的测试。

### VS Code 提示文件内容较新

说明磁盘上的文件已被其他进程更新。先选择比较内容，不要直接用编辑器中的旧版本覆盖磁盘文件。

### 页面控件未被点击

通过以下方式查看失败证据：

```powershell
npx playwright show-report
```

同时检查：

- `test-results/` 下的失败截图。
- `error-context.md`。
- Trace 和视频文件。

页面可能异步渲染，定位器应等待目标元素可见后再操作，避免仅依赖固定坐标。

## 使用注意

部分测试会创建、恢复、更新或删除真实云资源，并可能产生费用。执行前确认：

- 当前账号和区域正确。
- 测试目标实例正确。
- 已了解资源创建或删除的影响。
- 不要在不确定的情况下运行删除和购买类测试。

