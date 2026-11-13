# 开发与维护

项目使用 Node.js 24+、TypeScript strict 和 ESM。用户操作见 [README.md](README.md)，服务契约与数据流见 [DESIGN.md](DESIGN.md)。

## 修改入口

先检查 `git status --short`，再从 `src/index.ts` 的装配找到相关模块。修改宿主调用时核对当前安装的 Harness 类型与实现，插件使用的契约集中在 `src/lib/host.ts`。

| 范围 | `src/lib/` 实现 | `test/` 回归 |
|---|---|---|
| 配对、授权、网络边界 | `pairing`、`scope`、`serve`、`network` | `serve`、`collaboration` |
| GUI HTTP 与 WebSocket | `credentials`、`proxy` | `proxy`、`integration` |
| 身份、状态与缓存 | `identity`、`store`、`connect`、`host-facts` | `identity`、`collaboration`、`host-facts` |
| 资料引用与读取 | `references`、`resources`、`evidence` | `resources`、`client`、双实例脚本 |
| 任务与模型 | `tasks`、`outgoing-tasks`、`delegation`、`models` | `tasks`、`host-facts`、`models`、`lan-followup` |
| 所有者入口 | `api`、`commands`、`tool` | `api`、`commands`、`tool`、双实例脚本 |

界面位于 `src/client.tsx` 和 `src/client/`，由 `client.test.ts` 和双实例浏览器流程验证。修改源码后构建 `dist/`，不直接修改生成文件。

## 维护约束

- 当前阶段不维护旧协议、旧状态迁移或旧宿主 API。删除前核对生产写入者、调用路径及测试所保护的行为；无引用搜索只是线索。
- 授权在接收方执行，覆盖 HTTP、WebSocket、状态、正文、资料读取和任务。异步读取返回或提交缓存前再次检查期间的授权变更。
- 委派验证工作区真实路径与执行设备沙箱。不能用界面筛选代替服务端授权。
- 任务先持久化再执行，重试保留请求 id；结果、模型与正文按请求和轮次关联，不能按相同文本去重。
- 状态更新串行提交，写盘成功才发布内存快照。读取或备份失败不能覆盖已有文件。
- 注释解释设计原因、外部限制或非显然约束。发现注释与代码不符时追查行为。
- 真正的失败修实现，保留有独立价值的测试。删除测试要说明相同行为由何处覆盖，或依赖的功能为何已移除。

## 本地检查

首次安装依赖运行 `npm ci`，提交前执行：

```powershell
npm run typecheck
npm test
npm run build
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

结果写入 `.e2e/acceptance.json`，截图和可访问性快照也在 `.e2e/`。交付说明写本次运行范围、结果和未验证项，不把历史通过次数写成当前保证。

配置模型并设置 `E2E_BROWSER=1` 后，`npm run test:e2e -- --lan-followup-only` 可单独复测工作区归属、入站授权展示和原生审批的批准、拒绝流程。此模式缺少模型或浏览器配置时直接报错，不能与 `--protocol-only` 合用。审批使用隔离实例中的验收工具，不执行文件操作。

本地凭据放 `.env`，临时研究记录放 `.agent/`，构建产物放 `dist/`，验收输出放 `.e2e/`，这些路径均由 Git 忽略。共享操作和契约维护在仓库文档中。
