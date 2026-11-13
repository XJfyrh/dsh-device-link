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
| `allowReadFiles` | 允许搜索和读取授权工作区文件；未开启时拒绝 |
| `sessionTools` | 正文授权下共享工具调用与结果；默认关闭 |

所有字段均为必填；配对和范围修改拒绝缺字段或类型错误的授权，连接方也检查状态响应中的完整授权结构。

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

模型目录来自 `sessionController.modelCatalog()`。新会话采用设备默认值，活动会话从 `agent.model.current()` 读取自身选择，归档会话从事件恢复显式选择。宿主公开的 `selectModel()` 会修改全局默认值，因此适配器在控制器的串行入口内调用 `agent.model.select()`，只修改目标会话。当前契约按桌面宿主 0.2.2-rc.3 核对。

## 会话与缓存

`host-facts.ts` 读取工作区注册表、活动会话和智能体，通过 `sessionQuery` 补充归档。工作区路径和标题可能由 getter 提供，输出时显式投影为普通 JSON 对象。

目录按活动时间排序，经授权过滤后最多 200 条。按 id 读取正文直接获取目标，核对会话记录中的工作区和会话授权，不受目录条数限制，也不恢复智能体。

正文来自用户来源的 `user/message` 和 `assistant/message` 持久化事件。标题优先最新 `session/title`，其次第一条用户消息，空会话显示“新会话”。消息带事件序号、请求 id 和轮次；详情据此合并正文与回执，保留文字相同但身份不同的消息。

每份正文最多保留最后 100 条消息、64,000 个 UTF-16 代码单元，截断时设置 `truncated`。同步自动读取目录前 20 条正文，其余已授权正文可按需获取。已缓存但不在最近目录中的会话会重新读取，以区分目录截断、会话删除和授权变化；路径范围按执行设备的平台规则检查。

会话目录使用宿主 `sessionController.list()` 的持久化摘要，不逐个读取历史正文。启用工具后，启动时及每 20 秒尝试刷新；所有者 `state` 返回本机设置和最近连接状态，同时触发后台检查。初次检查显示“检查中”，不以“离线”代替未知状态。普通同步复用 15 秒内结果，同一设备并发调用共用请求，显式刷新跳过时间缓存。

连接探测成功后立即发布状态，正文同步使用最多 3 个并发读取。任务进度每 2.5 秒独立轮询，不等待设备目录和正文。按需读取正文后保留已确认的在线状态。

| 结果 | 缓存处理 |
|---|---|
| 成功 | 保存当前范围内的状态与正文 |
| 正文 404 | 删除该正文 |
| 401/403 | 清空该设备缓存 |
| 网络或其他读取失败 | 保留仍获授权的可用快照和原正文缓存时间 |
| 本地断开 | 删除配对及缓存 |

`syncedAt` 是设备同步时间，`cachedAt` 是正文实际读取成功的时间。正文移出授权目录时清理缓存，界面随更新清除已展开正文。

失败任务可能尚未产生会话消息。会话快照的 `tasks` 单独提供该授权方提交的任务、状态和错误，不把它们伪装成消息或事件序号；最多 10 条，每条保留 4,000 字符请求、4,000 字符错误和最后 8,000 字符输出，截断时标记。界面区分“已缓存正文”“任务记录可读”和“暂无正文”。

`@` 候选从本地 `/references` 读取工作区与已缓存会话。发送时调用 `reference-prepare`，得到不含正文的资源描述和 `referenceId`；发送失败时不会添加不可用入口。选中文字作为显式短引文附在消息中。

## 按需读取

`references.ts` 保存资源入口及读取记录。入口绑定设备连接凭据的哈希、资源种类、工作区和会话，工具参数不能替换目标。每次查询检查本机已知授权，设备端 `/dl/resource` 再验证授权；异步读取结束后重新检查连接与范围。401/403 清空缓存，不能降级读取旧缓存；网络不可达时，只有会话查询可使用仍保留的本机缓存。

引用描述使用 `referenceCreatedAt` 表示入口创建时间，`sessionUpdatedAt` 表示会话更新时间。资源返回的 `emptyReason` 区分空目录、没有可读文件、没有命中和没有事件；`truncated` 与 `coverage` 限定结论范围。任务工具用 `errorOrigin: execution-device` 标明执行设备返回的错误。

在线概览和搜索从 `sessionQuery.readSession` 取得一次快照，读取单个事件使用 `readEvent` 返回的会话位置和事件。两条路径均核对工作区，再投影为用户文本、助手回复和显式授权的工具调用/结果，不共享请求头、系统上下文或思考内容。在线与缓存搜索使用同一文本投影进行字面匹配，定位信息和版本来自这份投影。

离线证据最多保留最近 120 个可共享事件，总计 256,000 个 UTF-16 代码单元，单事件最多 64,000；不足或截断均标记。在线与离线结果使用同一事件定位和文本版本。单次事件读取返回最多 12,000 字符并提供 `nextOffset`，文件读取最多 120 行、16,000 字符并提供 `nextLine`。历史工具记录不是历史文件归档。

文件访问使用真实工作区路径、逐级符号链接检查和只读文件句柄，禁止绝对文件路径与目录穿越。搜索返回 SHA-256 内容版本，读取不匹配时返回 409。扫描上限 1,500 个条目、20 项命中，跳过超大、二进制、不支持编码及排除目录，结果说明覆盖范围；子目录路径可缩小搜索范围。

所有者 `reference-preview` 供用户查看，不写入工具读取记录。`device_inspect`、`device_search`、`device_read` 将结果连同来源本地会话和工具调用身份持久化，卡片展示当次取得的内容。读取记录保留原结果；引用的可用状态和能力则按当前连接重新计算。

引用与读取记录位于 `$DSH_HOME/device-link/references.json`，使用串行原子写入。每个引用保留最近 80 次调用。本地断开连接时删除对应记录；连接凭据或授权变化后禁止访问原记录。工作区文件不自动做离线缓存。

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

设备名称由 `identity.name` 持久化；`deviceName` 配置只用于首次创建身份。所有者通过 `rename` 修改名称，设备标识和授权保持不变。同步时，连接方从 `/dl/status` 更新 `peers.name`，并通过 URL 编码的 `X-Device-Link-Name` 请求头携带本机名称，接收方验证令牌后更新对应的入站授权名称。离线保留最近同步的名称。

客户端使用宿主字体变量、菜单、Markdown 和引用标签。宿主 `sidebar.footer.action` 包装是 `display: contents`，插件按自身 slot 锚点定位外层布局，卸载时移除样式。

浏览器按本机身份和目标保存草稿、模型选择、提交身份、返回位置和阅读位置。轮询已确认的任务结果优先于迟到的初始提交响应。

## 接口索引

所有者 API 以 `/device-link/api/` 为前缀，除列出的 GET 外均为 JSON POST。

| 路径 | 输入或作用 |
|---|---|
| GET `state`、`references`、`tasks` | 同步状态、缓存候选、任务列表 |
| `rename` | `{ name }` 修改本机名称，去除首尾空白，长度为 1–64 个 UTF-16 代码单元，不接受控制字符或孤立代理项 |
| `allow`、`close-pairing` | `{ relationship, scope }` 开放配对，或关闭 |
| `pair`、`diagnose` | `{ address, code }` 配对，或 `{ address }` 诊断 |
| `toggle`、`scope` | `{ allowIncoming }`，或 `{ deviceId, scope }` |
| `open`、`sync` | `{ deviceId }` |
| `session` | `{ deviceId, sessionId, refresh? }` |
| `reference-prepare` | `{ deviceId, workspacePath? , sessionId? }`，创建资源入口 |
| `reference-detail`、`reference-call` | 按引用及本地会话读取记录，或按工具调用身份定位记录 |
| `reference-preview` | `{ referenceId, action, query?, path?, seq?, revision?, startLine?, offset? }`，用户预览，不计入 agent 读取 |
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
| POST `/dl/resource` | 授权资源的 `inspect`、`search`、`read` |
| POST `/dl/execution` | `{ workspacePath, sessionId? }` 执行上下文 |
| POST `/dl/tasks` | `{ requestId, workspacePath, task, sessionId?, selection? }` |
| GET `/dl/tasks/<id>` | 查询本授权任务 |
| POST `/dl/tasks/<id>/cancel` | 停止或预先取消 |
| POST `/dl/access`、GET `/dl/enter?ac=...` | 创建与兑换完整界面访问码 |

成功响应含 `ok=true`。任务另读提交状态和远端 `status`，诊断另读 `diagnostic.ok/stage`。请求体上限 64 KiB，连接方响应上限 2 MiB；JSON 请求不跟随重定向，跨站请求被拒绝。字段以 `api.ts`、`serve.ts` 和 `types.ts` 为准。
