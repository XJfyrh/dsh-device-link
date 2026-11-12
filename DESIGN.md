# 实现与协议

`src/index.ts` 装配存储、配对、设备监听器、GUI 代理、连接器和双端任务服务，再注册界面 API、命令和模型工具。每个实例同时可以作为连接方和执行方。设备协议是 `v2`，状态结构版本是 `2`。

## 入口与授权

所有者 API 挂载于 Harness 的 `/device-link/api/`，逐次调用 `connection.requestRejection()`。设备 API 使用插件的独立 IPv4 监听器，位于 `/dl/`。内置监听器使用 HTTP，绑定一个具体地址；完整界面的代理目标来自本机 `webServer.getOrigin()`。

A 配对 B 时，B 将账号关系和范围绑定到一次性配对码。领取后，B 保存 `trusted[A]` 中的令牌 SHA-256 哈希和授权；A 保存 `peers[B]` 中的访问令牌。账号关系是所有者确认值，用于预填范围，不是账号验证协议。

| `Scope` 字段 | 行为 |
|---|---|
| `workspaces` | `all` 或绝对目录列表，目录包含子目录 |
| `allowDelegate` | 是否允许发起任务 |
| `allowUi` | 是否请求完整界面能力 |
| `sessionSync` | `none`、`metadata` 或 `content` |
| `sessionIds` | 工作区内全部会话，或会话 id 列表 |

会话和智能体同时满足工作区、会话 id 和同步级别。GUI 代理使用宿主所有者身份，因此只有 `allowUi=true`、全部工作区、全部会话和正文同步同时满足时才能开放。

任务路径须为绝对目录，经平台路径规范化与 `realpath` 校验。受限授权应用 `workspace-write`，再检查宿主解析出的沙箱模式和工作区根目录。服务缺失或策略不符会使任务失败。

范围变更、撤销和关闭接入会关闭关联 socket、清除待兑换访问码并取消活动任务。状态和正文读取在异步调用结束后再次检查授权，避免返回已经撤销的数据。

## 完整界面代理

1. A 携设备令牌请求 B 的 `/dl/access`，获得单次访问码。
2. 浏览器访问 `/dl/enter?ac=...`，B 再次验证授权，设置 `dl_session` Cookie，并重定向到 `/`。
3. 后续 HTTP 和 WebSocket 请求均验证设备令牌及完整界面范围。
4. B 调用 `connection.authenticatedUrl(origin)`，用同源完整 URL 兑换所有者 Cookie，只用于代理发往本机 GUI 的请求。

代理重写 Host、Origin、Referer 和 Cookie，过滤双向逐跳头及 `Connection` 指名的头。HTTP 响应和 WebSocket 握手均过滤 `Set-Cookie`。普通 HTTP GET/HEAD 遇到上游 401/403 时刷新凭据并重试一次；非幂等请求不自动重放。

WebSocket 握手由 Node HTTP 客户端解析，成功后转发两端已读取的 head 字节，再连接双向流。代理关闭或设备授权变化会销毁关联连接。

## 持久化任务

浏览器、命令和工具统一调用 `outgoing-tasks.ts`；执行方由 `tasks.ts` 接收请求，`delegation.ts` 调用 Harness。

1. 浏览器先保存提交身份，连接方保存任务 id、设备、工作区、正文、选择和来源。工具调用以来源会话和工具调用 id 派生稳定 id。
2. 执行方验证授权和路径，先写 `queued` 再运行。同一授权最多 4 个活动任务，同一会话只能有一个活动委派。
3. 新建或恢复会话，检查空闲状态及工作区，应用权限和模型选择。
4. 以来源设备和任务 id 派生的 `promptRequestId` 提交，通过 `user/message.source.rpcId` 找到本轮，按本轮读取文本、实际模型和 `turn/end`。
5. 回执丢失时先按同一 id 查询，确定不存在后再提交。相同 id 携带不同工作区、正文、会话或模型会被拒绝。

远端状态为 `queued`、`running`、`stopping`、`completed`、`error`、`stopped`、`interrupted`。连接方另存提交状态和连接错误，网络问题不会直接改变远端执行状态。

取消先保存意图，再沿同一身份发送。执行方支持提交前的取消记录，防止迟到提交重新运行。重启时按持久化结束事件恢复 `completed` 或 `error`，未找到结束事件的任务标为 `interrupted`。页面关闭和工具等待结束不等于取消。

模型目录来自 `sessionController.modelCatalog()`。新会话采用设备默认值，活动会话从宿主读取自身选择，归档会话从事件恢复显式选择。宿主公开的 `selectModel()` 会修改全局默认值，因此适配器在控制器的串行入口内调用会话级 `selectForNextRequest()`。宿主升级时需重新核对此约束。

## 会话与缓存

`host-facts.ts` 读取工作区注册表、活动会话和智能体，通过 `sessionQuery` 补充归档。工作区路径和标题可能由 getter 提供，输出时显式投影为普通 JSON 对象。

目录按活动时间排序，经授权过滤后最多 200 条。按 id 读取正文直接获取目标，核对会话记录中的工作区和会话授权，不受目录条数限制，也不恢复智能体。

正文来自用户来源的 `user/message` 和 `assistant/message` 持久化事件。标题优先最新 `session/title`，其次第一条用户消息，空会话显示“新会话”。消息带事件序号、请求 id 和轮次；详情据此合并正文与回执，保留文字相同但身份不同的消息。

每份正文最多保留最后 100 条消息、64,000 个 UTF-16 代码单元，截断时设置 `truncated`。同步自动读取目录前 20 条正文，其余已授权正文可按需获取。已缓存但不在最近目录中的会话会重新读取，以区分目录截断、会话删除和授权变化；路径范围按执行设备的平台规则检查。

启用工具后，启动时及每 20 秒尝试刷新。所有者 `state` 也会同步；普通同步复用 15 秒内结果，同一设备并发调用共用请求，显式刷新跳过时间缓存。

| 结果 | 缓存处理 |
|---|---|
| 成功 | 保存当前范围内的状态与正文 |
| 正文 404 | 删除该正文 |
| 401/403 | 清空该设备缓存 |
| 网络或其他读取失败 | 保留仍获授权的可用快照和原正文缓存时间 |
| 本地断开 | 删除配对及缓存 |

`syncedAt` 是设备同步时间，`cachedAt` 是正文实际读取成功的时间。正文移出授权目录时清理缓存，界面随更新清除已展开正文。

`@` 候选从本地 `/references` 读取工作区与已缓存会话。发送时将来源、时间和正文固定为消息快照；读取失败阻止发送。已发送标签读取自己的快照，不替换成后来同步的内容。

## 状态与客户端

状态位于 `$DSH_HOME/device-link/devices-v2.json`，未设置 home 时使用 `~/.dsh`。

| 字段 | 内容 |
|---|---|
| `identity`、`serve` | 身份、监听和接入开关 |
| `trusted`、`peers` | 入站授权，出站令牌及缓存 |
| `favorites` | 收藏工作区 |
| `incomingTasks`、`outgoingTasks` | 双端任务状态 |
| `taskCancellations` | 绑定设备、请求 id 和令牌哈希的取消记录 |

更新串行执行：复制状态，修改副本，写临时文件并原子重命名，成功后发布内存。读取返回副本。加载检查当前顶层结构，不补齐旧格式；解析或结构错误先备份再新建，读盘与备份失败报错并保留原文件。

客户端使用宿主字体变量、菜单、Markdown 和引用标签。宿主 `sidebar.footer.action` 包装是 `display: contents`，插件按自身 slot 锚点定位外层布局，卸载时移除样式。

浏览器按本机身份和目标保存草稿、模型选择、提交身份、返回位置和阅读位置。轮询已确认的任务结果优先于迟到的初始提交响应。

## 接口索引

所有者 API 以 `/device-link/api/` 为前缀，除列出的 GET 外均为 JSON POST。

| 路径 | 输入或作用 |
|---|---|
| GET `state`、`references`、`tasks` | 同步状态、缓存候选、任务列表 |
| `allow`、`close-pairing` | `{ relationship, scope }` 开放配对，或关闭 |
| `pair`、`diagnose` | `{ address, code }` 配对，或 `{ address }` 诊断 |
| `toggle`、`scope` | `{ allowIncoming }`，或 `{ deviceId, scope }` |
| `open`、`sync` | `{ deviceId }` |
| `session` | `{ deviceId, sessionId, refresh? }` |
| `execution` | `{ deviceId, workspacePath, sessionId? }` |
| `task-start` | `{ id, deviceId, workspacePath, task, sessionId?, selection?, originSessionId? }` |
| `task-refresh`、`task-cancel` | `{ id }` |
| `favorite` | `{ deviceId, path, enabled }` |
| `revoke` | `{ deviceId, side }`：`trusted` 撤销入站，`peer` 断开出站 |

设备令牌使用 Bearer 或 `dl_session` Cookie，同时存在时优先 Bearer。

| 方法与路径 | 作用 |
|---|---|
| GET `/dl/info` | 公开身份、协议和配对状态 |
| POST `/dl/pair/claim` | `{ code, deviceId, name }` 领取配对 |
| POST `/dl/pair/revoke` | `{ deviceId }` 撤销自身授权 |
| GET `/dl/status` | 按范围返回工作区、会话、智能体 |
| GET `/dl/session?id=...` | 已授权正文 |
| POST `/dl/execution` | `{ workspacePath, sessionId? }` 执行上下文 |
| POST `/dl/tasks` | `{ requestId, workspacePath, task, sessionId?, selection? }` |
| GET `/dl/tasks/<id>` | 查询本授权任务 |
| POST `/dl/tasks/<id>/cancel` | 停止或预先取消 |
| POST `/dl/access`、GET `/dl/enter?ac=...` | 创建与兑换完整界面访问码 |

成功响应含 `ok=true`。任务另读提交状态和远端 `status`，诊断另读 `diagnostic.ok/stage`。请求体上限 64 KiB，连接方响应上限 2 MiB；JSON 请求不跟随重定向，跨站请求被拒绝。字段以 `api.ts`、`serve.ts` 和 `types.ts` 为准。
