# Device Link v2

## 模块与职责

| 模块 | 职责 |
|---|---|
| `src/index.ts` | 插件装配与生命周期 |
| `src/lib/types.ts` | 设备、授权、状态、缓存与协议数据结构 |
| `src/lib/host.ts` | 插件实际使用的 Harness 服务结构契约 |
| `src/lib/config.ts` | 配置、环境变量与监听网卡 |
| `src/lib/store.ts` | v2 状态、串行更新与原子写入 |
| `src/lib/pairing.ts` | 配对码、令牌生成和哈希验证 |
| `src/lib/scope.ts` | 授权解析、路径与会话范围检查 |
| `src/lib/network.ts` | 地址验证、诊断、插件版本比较 |
| `src/lib/serve.ts` | LAN HTTP 路由、鉴权、代理连接与撤销 |
| `src/lib/proxy.ts`、`credentials.ts` | 本机 GUI HTTP/WebSocket 代理及 owner Cookie 交换 |
| `src/lib/connect.ts` | 连接方请求、配对、缓存同步、离线读取 |
| `src/lib/host-facts.ts` | 活跃与历史会话、智能体、受限正文投影 |
| `src/lib/delegation.ts` | sessionController 创建、发送、等待完成与取消 |
| `src/lib/api.ts`、`commands.ts`、`tool.ts` | 所有者 API、命令、模型工具 |
| `src/client.tsx` | 设置页与原生输入框 @ 候选源 |

## 授权结构

```ts
interface Scope {
  workspaces: 'all' | string[]
  allowUi: boolean
  allowDelegate: boolean
  sessionSync: 'none' | 'metadata' | 'content'
  sessionIds: 'all' | string[]
}
```

接收方生成配对码时指定 `same-account`、`different-account` 或 `unknown`，同时绑定完整 Scope。claim 使用接收方配置的范围。全部授权字段都显式校验，完整 GUI 代理要求全工作区、全会话内容授权。

委派前使用执行设备的路径规则处理 `..`、大小写与目录边界，并通过 `realpath` 验证符号链接目标。受限委派使用 Harness `workspace-write` 权限预设并验证生效的工作区根目录。模型与浏览器均归执行设备所有。

## 所有者 API

以下路径位于 `/device-link/api/`，每次请求由 `connection.requestRejection` 检查。

| 方法 | 路径 | 输入或用途 |
|---|---|---|
| GET | `state` | 身份、监听、授权、远端快照、缓存状态 |
| GET | `references` | 读取本地候选快照，避免输入框等待远端网络 |
| POST | `allow` | `{ relationship, scope }` 生成绑定授权的配对码 |
| POST | `close-pairing` | 关闭当前配对码 |
| POST | `pair` | `{ address, code }` |
| POST | `diagnose` | `{ address }` |
| POST | `toggle` | `{ allowIncoming }` |
| POST | `scope` | `{ deviceId, scope }` |
| POST | `open` | `{ deviceId }` 获取一次性 URL |
| POST | `sync` | `{ deviceId }` 刷新缓存 |
| POST | `session` | `{ deviceId, sessionId }` 读取缓存正文 |
| POST | `delegate` | `{ deviceId, workspacePath, task, timeoutMs }` |
| POST | `revoke` | `{ deviceId, side: 'peer' \| 'trusted' }` |

## LAN API

| 方法 | 路径 | 授权 |
|---|---|---|
| GET | `/dl/info` | 可达性与协议发现 |
| POST | `/dl/pair/claim` | 一次性配对码 |
| POST | `/dl/pair/revoke` | 设备令牌，设备只能撤销自身 |
| GET | `/dl/status` | 设备令牌，按工作区与会话范围投影 |
| GET | `/dl/sessions` | 设备令牌，受限会话目录 |
| GET | `/dl/session?id=...` | 设备令牌，正文同步授权 |
| POST | `/dl/delegate` | 设备令牌、委派授权与真实路径校验 |
| POST | `/dl/access` | 设备令牌与完整界面授权 |
| GET | `/dl/enter?ac=...` | 单次访问码，兑换前再次校验授权 |
| HTTP / WebSocket | GUI 路径 | Cookie 或 Bearer，完整界面授权 |

请求体上限为 64 KiB，连接方响应上限为 2 MiB。对外访问 URL 使用实际监听地址构造。连接方请求禁用重定向，代理目标限定本机回环地址。跨站 Origin 请求被拒绝。

## 会话与委派

活跃会话使用 `sessions`，历史目录和正文使用 `sessionQuery`。正文缓存保存用户与助手文本、设备来源和同步时间。

委派使用 `sessionController.create()` 和 `sessionController.prompt()`，由 Harness 应用模型选择、agent preset 和消息构造流程。等待发送前序号之后的 `turn/end`，读取对应会话回复，并将失败原因返回连接方。超时返回会话 id，任务继续在远端运行。正在等待的请求被中止或撤销时调用 `sessionController.cancel()`。

缓存按设备持久化。收到已知撤销或授权拒绝时清除缓存，正常同步只保留当前范围内的会话。断网保留最后一次快照。输入框候选和离线会话工具读取本地缓存。

## 本轮后续验收

- 在 `.env` 中配置 `DEEPSEEK_API_KEY` 后执行真实模型回复断言。
- 完成设置页全部操作与原生 `@` 菜单的浏览器交互验收。
- 接入可验证的跨设备账号关系凭证，替换所有者手动确认关系的步骤。
- 设备更新状态当前比较已连接设备与本机插件版本，发布源版本查询可在后续加入。
