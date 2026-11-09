# dsh-device-link

DeepSeek Harness 的局域网设备连接插件。通过 8 位配对码授权设备，访问远端工作区、委派任务、查看智能体，并在本地任务中引用离线会话缓存。

## 项目盘点

| 资产或功能 | 原有实现 | 当前实现 |
|---|---|---|
| 工程 | JavaScript ESM，缺少构建与类型检查 | TypeScript strict，TSX 设置页，类型声明与打包脚本 |
| 配对 | 8 位一次性码、有效期、错误次数限制 | 配对码绑定接收方确认的账号关系与首次授权范围 |
| 远端界面 | HTTP 与 WebSocket 代理、owner Cookie 交换 | 每次代理入口检查授权，范围变更与撤销关闭已有连接 |
| 工作区范围 | 路径前缀判断 | 规范化路径、真实路径与目录校验，阻止跳转和符号链接越界 |
| 会话 | 活跃会话目录 | 活跃与历史会话、同步级别、会话选择、持久化正文缓存 |
| 委派 | 直接创建 agent，旧文档记录模型传输失败 | 使用 Harness 界面相同的 sessionController 创建与发送流程 |
| 本地引用 | 文本形式的 @ 约定 | 注册原生 @ 候选源，提供设备工作区与已缓存会话 |
| 状态 | 平台、插件版本、会话目录 | 增加智能体状态、模型路由、缓存时间、双端插件版本比较 |
| 诊断 | 网卡枚举 | 地址、TCP、设备协议三个阶段的诊断 |
| 验证 | 4 个测试文件和双实例脚本 | TypeScript 回归测试、真实隔离 Harness 双实例、可选浏览器冒烟测试 |

源代码位于 `src/`，测试位于 `test/`。`scripts/demo.ps1` 保留本机演示入口，`locale/`、`icon.svg` 和 `cordis.patch.yml` 是插件清单资产。根目录原有 `dsh-device-link-0.1.0.tgz` 为旧构建产物，Git 忽略所有 tgz 文件。

## 开发与安装

需要 Node.js 24 或更新版本。

```powershell
npm ci
npm run typecheck
npm test
npm run build
dsh plugin --profile desktop add E:/dsh-device-link
```

两台设备安装后重启 Harness。打包分发使用 `npm pack`，生成 `dsh-device-link-0.2.0.tgz`。包入口为 `dist/index.js` 与 `dist/client.js`。

## 配对与授权

1. 在接收方打开 **设置 → 设备连接**，启用接入。
2. 选择账号关系、工作区、会话同步级别和允许的操作，再生成配对码。
3. 在连接方填写接收方的局域网 IPv4 与 8 位码。
4. 在已连接设备中同步会话、查看缓存或委派任务。

账号关系由接收方所有者确认。确认同账号时预填全量授权，不同账号与待确认关系预填空工作区、关闭委派及会话同步。接收方可编辑这些范围，再生成绑定该范围的配对码。自动验证跨设备账号身份尚待接入可验证的账号凭证协议。

完整远端界面需要全部工作区、全部会话内容和 `allowUi` 授权。该入口可使用执行设备的终端、浏览器和文件功能。限定工作区时使用委派入口，插件将任务目录校验到真实路径，并应用 Harness 的 `workspace-write` 权限预设。实际文件读取、网络访问及提权审批由执行设备的 Harness 沙箱与权限服务执行。

授权改变会关闭对应设备的已有代理连接，清除待兑换的访问码，并取消正在等待结果的委派请求。超时返回的任务保留在远端会话中，后续可继续查看。

## 跨设备任务与离线引用

在会话输入框输入 `@`，选择设备工作区或已缓存会话。插入的引用使用设备 id，包含空格的工作区路径会编码保存。

```text
@device://设备id/workspace?path=编码后的绝对路径 检查测试失败项
@device://设备id/session?id=会话id 根据这段历史继续分析
```

智能体通过 `device_delegate` 委派任务，通过 `device_sessions` 读取缓存。远端任务使用执行设备的模型、工具和浏览器环境。

启用工具后每 20 秒刷新设备缓存。每台设备缓存最多 20 个会话正文，每个正文保留最近 100 条用户与助手文本，最多 64,000 个 UTF-16 代码单元。截断结果包含 `truncated` 标记。会话目录最多返回 200 项。

离线时可继续引用已有缓存，并显示缓存时间。再次联网发现撤销授权时清除该设备缓存，收紧同步范围时删除超出范围的缓存。连接方主动断开会删除本地配对与缓存，对端无法响应撤销时会显示结果，接收方仍可在自己的已授权列表中撤销。

```text
/device status
/device allow
/device pair 192.168.1.5:47654 12345678
/device diagnose 192.168.1.5:47654
/device list
/device sync 设备名
/device open 设备名
/device delegate 设备名 | E:\project | 运行测试并返回失败摘要
/device session 设备名 会话id
/device revoke 设备名
/device untrust 设备名
```

`/device allow` 使用待确认关系的空范围。首次授权范围通过设置页配置。

## 配置与存储

| 配置 | 默认值 | 行为 |
|---|---|---|
| `allowIncoming` | `true` | 配置级接入开关 |
| `listenPort` | `47654` | 设为 0 时分配端口，占用时回退到空闲端口 |
| `bindAddress` | `auto` | 自动选择私有局域网 IPv4，也可指定本机地址 |
| `deviceName` | 主机名 | 向其他设备展示的名称 |
| `pairingTtlMs` | `120000` | 配对码有效期 |
| `accessTtlMs` | `60000` | 一次性界面访问码有效期 |
| `proxyRequestTimeoutMs` | `30000` | GUI HTTP 上游请求空闲超时 |
| `toolsEnabled` | `true` | 注册模型工具与后台缓存刷新 |

`DSH_DEVICE_LINK_PORT`、`DSH_DEVICE_LINK_BIND`、`DSH_DEVICE_LINK_ALLOW` 可覆盖配置。地址输入支持 RFC1918 私有 IPv4 与用于同机测试的回环地址，默认端口为 47654。输入中的账号密码、路径、查询参数、片段、公网地址及重定向会被拒绝。

协议为 `v2`，状态存储为 `$DSH_HOME/device-link/devices-v2.json`。更新后重新配对。状态文件采用串行事务和原子重命名，写入成功后发布内存状态。接收方保存令牌哈希，连接方保存访问令牌和缓存正文。

内置监听器使用 HTTP，适用于可信局域网。Windows 防火墙需要允许对应端口的专用网络入站访问。

## 测试与 API Key

```powershell
Copy-Item .env.example .env
# 在 .env 中填入 DEEPSEEK_API_KEY
npm run test:e2e
```

`test:e2e` 自动加载 `.env` 并将 Key 传入两个临时 Harness 实例。存在 Key 时会要求远端模型返回 `DEVICE_LINK_OK`，错误或超时使测试失败。`.env` 已加入 Git 忽略规则，提交中包含 `.env.example`。

`DSH_CLI` 可指定 Harness 的 `lib/bin.js`。脚本默认使用 Windows 本机 npm 安装位置。测试结束会停止实例并清理本次临时目录。

可选浏览器冒烟测试使用 `E2E_BROWSER=1`。安装 Playwright Chromium 后可运行，也可通过 `PLAYWRIGHT_EXECUTABLE_PATH` 指定已有浏览器。浏览器截图保存在已忽略的 `.e2e/`。

当前已验证真实双实例的配对、HTTP/WebSocket 代理、授权收紧、接入开关、撤销和委派会话创建。隔离实例缺少 API Key，真实模型回复待填入 Key 后验证。浏览器已验证 Harness 页面加载，设置页完整交互及原生 `@` 菜单视觉验收仍待完成，`@` 候选生成与插入逻辑已有自动化回归测试。
