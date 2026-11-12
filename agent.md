# 项目开发指南

本项目使用 TypeScript strict、ESM 和 Node.js 24 或更新版本，为 DeepSeek Harness 提供局域网设备连接与跨设备协作。开始修改前，按任务阅读用户操作、协议机制和对应模块，验证时覆盖实际调用入口。

安装、配对与当前验证记录见 [README.md](README.md)，授权、缓存、委派流程及 API 参考见 [DESIGN.md](DESIGN.md)。

## 开始修改

1. 检查 `git status --short`，确认工作区现有改动及其来源。
2. 从 `src/index.ts` 找到相关服务的装配位置，再查看调用方、类型与回归测试。
3. 涉及 Harness 服务时，核对本机安装版本的类型声明与实现。插件使用的结构契约集中在 `src/lib/host.ts`。
4. 将改动放入 `src/`，通过构建更新 `dist/`。协议或数据结构调整时同步维护类型、调用入口、测试和文档。

本机的计划、调试记录和临时笔记放在 `.agent/`。该目录由根目录 `.gitignore` 排除。共享的操作说明维护在 README，共享的实现说明维护在 DESIGN。

## 按功能定位代码

| 修改内容 | 主要文件 | 相关验证 |
|---|---|---|
| 配对、令牌和接入开关 | `pairing.ts`、`serve.ts` | `test/serve.test.ts`、`test/collaboration.test.ts` |
| 工作区或会话授权 | `scope.ts`、`serve.ts`、`host-facts.ts` | `test/collaboration.test.ts`、`test/host-facts.test.ts` |
| 设备界面与 WebSocket | `proxy.ts`、`credentials.ts`、`serve.ts` | `test/proxy.test.ts`、`test/integration.test.ts` |
| 会话同步、离线读取和存储 | `connect.ts`、`store.ts`、`host-facts.ts` | `test/collaboration.test.ts`、`test/host-facts.test.ts` |
| 任务委派与宿主服务 | `delegation.ts`、`tasks.ts`、`outgoing-tasks.ts`、`host.ts` | `test/host-facts.test.ts`、双实例测试 |
| 会话模型、标题与对话合并 | `models.ts`、`host-facts.ts`、`client/conversation.ts` | `test/models.test.ts`、真实双实例模型切换 |
| 侧栏、设备面板、预览、命令和模型工具 | `client.tsx`、`client/`、`api.ts`、`commands.ts`、`tool.ts` | `test/client.test.ts`、双实例 API 与浏览器交互验证 |

表中的后端文件位于 `src/lib/`，`client.tsx` 位于 `src/`。修改时优先复用已有的路径、授权、HTTP 和存储逻辑，使各入口遵循同一套行为。

## 保持实现条件一致

- 授权检查由接收方执行，覆盖 HTTP、WebSocket、状态、会话读取和委派入口。异步读取结束时再次检查期间的授权变更。
- 委派到受限工作区前，校验绝对目录与真实路径，再应用并验证执行设备的 `workspace-write` 策略。模型及工具使用执行设备的配置。
- 修改范围、撤销授权和关闭接入时，处理已建立的代理连接、待兑换访问码和仍在等待结果的委派请求。
- 状态更新按实例串行执行，持久化成功后发布内存状态。读者获得状态副本，失败更新保留此前已提交状态。
- 缓存保留设备来源、正文缓存时间和截断标记。同步范围收紧或鉴权失败时按协议清理缓存，网络失败时保留可用快照。
- 任务先持久化再执行，重试沿用请求 id。停止请求等待执行端确认，重启从持久化轮次结果恢复状态。回归测试覆盖重试、取消、续写与授权变更。
- 模型选择限定于执行会话，不能改写设备默认模型；修改宿主适配器后用真实实例核对。历史正文与任务结果按请求身份合并，不能靠相同文本判断重复。
- 模型工具返回值必须满足 Harness 的 lossless JSON 要求，字段使用 JSON 值。新增工具同时验证正常结果与缺少可选字段的结果。

## 验证改动

以下命令在项目根目录执行。首次准备依赖时运行 `npm ci`。

```powershell
npm run typecheck
npm test
npm run build
```

`typecheck` 检查 `src/` 下的严格类型，`test` 运行 `test/*.test.ts`，`build` 编译服务端、生成类型声明并打包客户端。回归测试会使用临时目录和本机回环 HTTP/WebSocket，成功时进程退出码为 0。

### 运行真实双实例

修改配对协议、授权或 Harness 服务集成后，使用 `npm run test:e2e` 验证两个真实实例之间的调用。脚本创建独立临时 home，通过 Harness 的工作区服务注册测试目录，动态分配回环端口，并在结束时清理实例与本次目录。浏览器首次使用的文档目录也指向各自的临时 home。

脚本默认从 Windows 的 `%LOCALAPPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js` 启动 Harness。安装位置不同的环境通过 `DSH_CLI` 指向实际的 `lib/bin.js`。

```powershell
npm run test:e2e
```

保留空模型凭据时，脚本验证 8 个协议与会话流程，并打印委派返回的 `model outcome`。该运行可证明会话创建与错误传递是否正常。真实模型回复的验证需要下一步配置凭据。

### 验证真实模型回复

首次将 `.env.example` 复制为 `.env`，在其中填写 `DEEPSEEK_API_KEY`，然后运行双实例测试。

```powershell
Copy-Item .env.example .env
# 编辑 .env 中的 DEEPSEEK_API_KEY
npm run test:e2e
```

脚本将 Key 传入两个临时实例，要求简单委派在 30 秒等待期内返回 `completed`，并在回复中包含 `DEVICE_LINK_OK`。随后在受限目录中放置随机文本，要求执行模型读取并写回文件，校验落盘内容、回复和同步正文，再验证越界请求被拒绝。文件任务的等待期为 120 秒。模型错误或超时会使对应检查失败，成功汇总应为 `12 passed, 0 failed`，其中包含持久化任务的幂等提交、续写和停止。

测试入口由 Node.js 读取项目根目录 `.env`。测试结束后实例和临时 home 被清理，项目内的 `.env` 由 Git 忽略规则排除。日常使用插件时，模型凭据来自执行设备的 Harness 配置。

### 可选测试环境变量

| 变量 | 用途 |
|---|---|
| `DSH_CLI` | 指定 Harness 的 `lib/bin.js` 路径 |
| `DEEPSEEK_API_KEY` | 启用真实模型回复断言，并将 Key 传入隔离实例 |
| `E2E_MODEL_HOME` | 从指定 home 复制 `.credentials.yaml` 和 `settings.json` 到两个临时 home，并启用模型回复断言 |
| `E2E_BROWSER` | 设为 `1` 时增加设备面板、右侧预览、任务卡片和原生 `@` 协作验收 |
| `PLAYWRIGHT_EXECUTABLE_PATH` | 使用已有 Chromium 时指定可执行文件路径 |

启用浏览器检查前准备好 Chromium。使用项目安装的 Playwright 浏览器可执行以下命令。

```powershell
npx playwright install chromium
$env:E2E_BROWSER = '1'
npm run test:e2e
```

带 Key 的浏览器验收启动无界面 Chromium，操作设备面板和连接设置，额外注册三个底部扩展入口，并比较原生与插件的字体计算值。验证纵向排列、侧栏收起与窄屏，以及地址诊断、双向配对、收藏持久化、右侧预览、引用标签、设备界面、任务卡片、续写、接入开关、授权调整和撤销。通过原生 `@` 调用一次设备任务后，停止执行设备，由本地智能体从缓存中找出随机标识，再重启对方设备确认重连。模型交互等待最多 120 秒。

完整成功汇总为 `13 passed, 0 failed`。结果保存在 `.e2e/acceptance.json`，截图和可访问性快照保存在同一目录。`workspace-preview-reference.png`、`workspace-mention-result.png`、`persistent-task-cards.png` 和 `offline-session-reference.png` 分别记录预览引用、会话内委派、持久化任务和离线引用。

0.4.0 的浏览器流程还会切换执行设备上的模型，核对任务实际模型及设备默认模型不变，在同一设备会话连续发送两轮，并检查刷新后的草稿、模型选择和正文去重。测试通过拦截一次已处理提交的回执，验证恢复后不重复创建任务；从宿主折叠的工具卡片打开详情后，再返回并核对本地草稿。`conversation-narrow.png` 记录窄窗口中的对话与输入区。

## 更新文档与交付

文档按读者的操作顺序解释前提、动作和结果。参数名、默认值、目录、接口字段和界面文案以代码为依据，示例注明替换项。描述验证结果时写明运行环境、测试范围和仍待验证的操作。

提交前检查改动和暂存内容。

```powershell
git diff --check
git diff --cached --check
git status --short
git diff --cached --stat
```

共享提交包含源码、测试、配置模板和文档。本地模型凭据放在 `.env`，开发记录放在 `.agent/`，构建产物放在 `dist/`，测试截图放在 `.e2e/`，这些路径均按仓库忽略规则处理。说明与日志中的凭据使用脱敏值。

当前验收进度集中记录在 [README 的验证记录](README.md#存储与验证记录)。完成真实模型或浏览器交互验收后，在那里补充结果与条件。
