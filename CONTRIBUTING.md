# 开发与验证

需要 Node.js 24+ 和 npm。项目使用 TypeScript strict 与 ESM，服务端依赖 Node.js 内置模块，浏览器入口由 esbuild 打包。

## 从源码运行

目标宿主是 **0.2.2-rc.3**。先运行所用入口的 `--version`，确认 CLI 与桌面内置宿主的版本。安装到桌面版前，先启动一次桌面版以创建 `desktop` profile，再完全退出使用该 profile 的实例。

在准备存放源码的目录执行：

```powershell
git clone https://github.com/XJfyrh/dsh-device-link.git
cd dsh-device-link
npm ci
npm run build
dsh plugin --profile desktop add .
```

安装完成后重启 Harness，侧栏底部应出现 **设备**。源码安装使用目录链接，开发改动后重新构建并重启即可加载。向另一台设备分发时运行 `npm pack`，安装生成的 `.tgz`。

## 代码入口

| 目录或文件 | 内容 |
|---|---|
| `src/index.ts`、`src/lib/` | 插件装配、授权、存储、代理、资料与任务服务 |
| `src/client.tsx`、`src/client/` | 设备面板、任务对话与引用预览 |
| `locale/`、`cordis.patch.yml` | 插件展示信息与宿主注册 |
| `test/` | 回归测试 |
| `scripts/` | 构建清理与双实例验证 |
| `DESIGN.md` | 宿主契约、协议与数据流 |
| `AGENTS.md` | 修改入口与维护约束 |

根目录 README 展示在 DSH 插件详情中，面向使用者；开发细节放在本文和设计文档。提交反馈或 PR 时说明操作步骤、两端宿主与插件版本、实际结果及验证范围；日志和截图中隐藏凭据与私人内容。

## 本地检查

在仓库根目录执行以下检查；新拉取源码后先运行 `npm ci`：

```powershell
npm run typecheck
npm test
npm run build
npm pack --dry-run
git diff --check
```

`typecheck` 使用 `tsconfig.check.json` 检查源码、测试和验收脚本；构建使用 `tsconfig.json`，只输出源码。回归测试需要本机回环 HTTP/WebSocket 连接权限。新增测试优先覆盖可观察行为、竞态和失败恢复。

## 双实例验证

`scripts/e2e-two-instance.ts` 创建两个临时 Harness home、profile 和工作区，动态分配端口。结束时关闭本次启动的进程，校验路径后删除本次临时目录。

```powershell
npm run test:e2e:protocol
```

此模式从临时 home 启动，指定空的测试凭据名和回环模型地址，验证缺少凭据时的持久化错误结果及协议流程。它不加载项目 `.env`，也不复制模型配置。默认 Harness 入口为 `%LOCALAPPDATA%/npm/node_modules/@deepseek-ai/dsh/lib/bin.js`，其他安装位置设置 `DSH_CLI`。

验收前执行目标入口的 `--version`。本插件目标宿主是 0.2.2-rc.3；全局 npm CLI 与桌面版内置宿主可能不同，不能用旧 CLI 的通过结果代替桌面版验收。设置 `DSH_CLI` 为与桌面版相同版本的完整入口路径。

真实模型验证：将 `.env.example` 复制为 `.env`，填写 `DEEPSEEK_API_KEY` 后执行 `npm run test:e2e`。脚本检查回复标识、受限工作区读写、越界拒绝、正文与工具结果读取、任务重试、续写和停止。也可设置 `E2E_MODEL_HOME`，从指定隔离模板复制 `.credentials.yaml` 和 `settings.json`。

浏览器检查：

```powershell
npx playwright install chromium
$env:E2E_BROWSER = '1'
npm run test:e2e
```

已有 Chromium 可设置 `PLAYWRIGHT_EXECUTABLE_PATH`。浏览器覆盖设备面板、配对、收藏、引用、任务卡片、草稿恢复和窄屏；配置模型时继续验证模型切换、真实委派、按需文件和事件读取、离线引用。

执行结束后检查 `.e2e/acceptance.json` 中的场景结果；浏览器截图和可访问性快照也保存在 `.e2e/`。提交说明中记录本次运行的宿主版本、验证范围、结果和未验证项。

配置模型并设置 `E2E_BROWSER=1` 后，`npm run test:e2e -- --lan-followup-only` 可单独复测工作区归属、入站授权展示和原生审批的批准、拒绝流程。此模式缺少模型或浏览器配置时直接报错，不能与 `--protocol-only` 合用。审批使用隔离实例中的验收工具，不执行文件操作。

本地凭据放 `.env`，临时研究记录放 `.agent/`，构建产物放 `dist/`，验收输出放 `.e2e/`，这些路径均由 Git 忽略。共享操作和契约维护在仓库文档中。

发布流程见 [docs/releasing.md](docs/releasing.md)。
