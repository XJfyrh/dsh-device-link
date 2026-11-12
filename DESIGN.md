# 设备连接的实现与协议

本文说明 `dsh-device-link` 如何保存配对关系、检查授权、在对方设备执行任务，以及在本地保留可离线读取的会话。当前实现使用设备协议 `v2` 和版本号为 `2` 的状态结构。

## 两端各自负责什么

每个插件实例同时具备连接方和接收方能力。以 A 连接 B 为例，A 保存 B 的地址与访问令牌，B 保存授予 A 的范围与令牌哈希。A 向 B 发起委派后，会话、模型调用和工具操作都由 B 的 Harness 执行。

插件提供两个 HTTP 入口。`/device-link/api/` 挂载在本机 Harness Web 服务上，供所有者的客户端界面使用，每次请求交给 `connection.requestRejection()` 检查。`/dl/` 位于插件自己的 IPv4 监听器上，处理设备发现、配对、状态查询和委派。

内置设备监听器使用 HTTP，绑定一个本机地址。GUI 代理的目标是 `webServer.getOrigin()` 返回的回环地址。部署和地址选择方法见 [README.md](README.md#配置监听与连接诊断)。

## 配对建立单向授权

1. B 的所有者选择账号关系和范围，调用 `openPairing()`。插件保存这些值，并生成 8 位配对码和过期时间。
2. A 向 B 的 `/dl/pair/claim` 提交配对码、本机设备 id 和名称。
3. B 检查接入开关、来源地址的失败次数、设备 id 和配对码。成功后消费配对码，生成 32 字节随机令牌，将授权及令牌的 SHA-256 哈希写入 `trusted[A]`。
4. B 将令牌与自身身份返回 A。A 校验协议、身份字段和令牌格式后，将连接信息写入 `peers[B]`。

`same-account`、`different-account` 和 `unknown` 表示接收方确认的账号关系。当前关系判断来自接收方操作，范围由生成配对码时的配置确定。同账号预填完整授权，其余两种关系预填空工作区并关闭操作与同步权限。自动验证账号关系需要后续接入可验证的跨设备凭证。

配对码默认有效 120 秒。相同来源地址达到失败阈值后，会触发配对码失效或来源地址限流。默认阈值为 8 次，计数窗口为 10 分钟。所有者重新生成配对码时重置计数。

## 授权如何生效

### 范围字段

`Scope` 由五个字段组成，定义位于 `src/lib/types.ts`。

| 字段 | 取值 | 含义 |
|---|---|---|
| `workspaces` | `'all'` 或绝对路径数组 | 可查看和选择的工作区范围，数组中的目录包含其子目录 |
| `allowUi` | 布尔值 | 是否可打开完整 Harness 界面 |
| `allowDelegate` | 布尔值 | 是否可发起设备任务 |
| `sessionSync` | `'none'`、`'metadata'`、`'content'` | 关闭同步、同步目录、同步目录与正文 |
| `sessionIds` | `'all'` 或会话 id 数组 | 工作区范围内可同步的会话 |

会话必须同时满足工作区范围、会话 id 范围和同步级别。智能体列表沿用对应会话的过滤条件，因此关闭会话同步也会隐藏该设备可见的智能体列表。

完整 GUI 请求和 WebSocket 升级要求 `allowUi=true`、`workspaces='all'`、`sessionSync='content'`、`sessionIds='all'` 同时成立。GUI 代理使用 Harness 所有者凭据，具备跨工作区操作能力，因此范围受限的设备通过插件的状态、会话和委派接口访问已授权内容。

### 工作区与宿主沙箱

委派路径必须是执行设备上的绝对目录。`scope.ts` 先按执行设备的路径规则解析目录与 `..`，再比较路径边界。执行前读取目标和授权目录的真实路径，检查符号链接目标仍位于授权目录内。

当 `workspaces` 为路径数组时，委派运行器在创建会话后调用 `permissionPresets.set(session, 'workspace-write')`。随后读取 `sandboxPolicy.resolve({ session })`，确认模式为 `workspace-write`，工作区根目录与验证后的任务路径一致，再提交任务。缺少这些宿主服务或策略校验失败时，返回委派错误。文件操作的具体执行与审批仍由 Harness 的服务实现负责。

### 撤销与范围变更

授权保存成功后，接收方关闭关联设备的代理 socket，删除该设备尚未兑换的访问码，并停止该授权下的活动委派任务。关闭接入开关会对所有已授权设备执行这些动作。

会话和状态读取包含异步宿主调用。返回读取结果前，接收方再次检查接入开关、令牌哈希及范围，发现期间已变更时返回 HTTP 403。

## 完整界面的访问流程

1. A 携带设备 Bearer 令牌请求 B 的 `/dl/access`。B 检查完整界面权限，创建默认有效 60 秒的单次访问码。
2. 浏览器访问返回的 `/dl/enter?ac=...`。B 消费访问码，再次检查授权，设置 `dl_session` Cookie 并重定向到 `/`。Cookie 带有 `HttpOnly`、`SameSite=Strict` 和 `Path=/`。
3. 浏览器后续请求由 B 的设备监听器鉴权。每次 HTTP 请求与 WebSocket 升级都检查完整界面范围。
4. 代理通过 `connection.authenticatedUrl()` 向 B 的本机 GUI 换取所有者 Cookie，然后重写目标 Host、Origin 和 Cookie，将请求交给 B 的 Harness。

生成的访问 URL 使用实际监听地址。连接方校验返回 URL 的来源与 `/dl/enter` 路径，出站 JSON 请求使用禁止重定向的 fetch 选项。GUI HTTP 响应过滤 `Set-Cookie`，使 Harness 的所有者 Cookie 留在代理端。遇到 GUI 的 401 或 403 时，GET 和 HEAD 请求会重新换取凭据并重试一次。

## 持久化委派任务

`outgoing-tasks.ts` 保存连接方的提交记录，`tasks.ts` 保存执行方状态，`delegation.ts` 调用 Harness。客户端、模型工具和命令共享这条执行路径。

1. 浏览器先保存提交身份，连接方再持久化请求 id、设备、工作区、任务正文、模型选择及来源会话。模型工具使用来源会话与工具调用 id 生成稳定请求 id。
2. 接收方验证令牌、工作区真实路径和委派权限，保存 `queued` 记录后开始执行。同一授权最多同时运行 4 个任务，同一会话最多接受一个活动委派。
3. 运行器创建会话或通过 `sessionController.resolveAgent()` 恢复指定会话。续写要求会话空闲且工作区一致。受限授权仍应用 `workspace-write` 沙箱。
4. 任务通过 `requestId` 提交。执行端的 `requestId` 由来源设备与任务 id 共同派生。运行器匹配 `user/message.source.rpcId` 与所属轮次，读取该轮的助手文本和 `turn/end`，将进展保存到任务记录。
5. 连接方按请求 id 查询。提交响应丢失时先查询，确定不存在后用相同 id 重试，防止重复创建会话。

任务状态包括 `queued`、`running`、`stopping`、`completed`、`error`、`stopped` 和 `interrupted`。连接错误单独保存在连接方记录中。停止请求保存取消标记，调用执行设备的取消接口，并等待确认。取消先于提交抵达时，执行方保存取消记录，后续同 id 提交被拒绝。

HTTP 请求结束和页面刷新后，持久化任务继续运行。模型工具默认等待 300 秒，最多 600 秒，超出等待期后返回当前状态和 `taskId`，可通过 `device_task` 跟进。授权收紧、撤销、关闭接入和插件停止会中止关联的活动任务。

执行端启动时检查此前未结束的任务。有匹配的持久化轮次结果时恢复结果，其余标记 `interrupted`，用户通过设备会话检查实际状态。恢复过程保留原请求身份。

### 执行模型选择

`/dl/execution` 按委派权限、工作区和续写会话范围返回模型目录、当前选择与忙碌状态。目录来自执行设备的 `sessionController.modelCatalog()`，传输字段限定为模型和提供方的名称、标识及思考强度，不包含凭据。新会话采用设备默认值；已有会话读取会话级模型选择及持久化 `model/selection`、`request/header` 事件。

`selection` 随任务保存并参与幂等一致性校验。发送前验证目录中仍有该模型与思考强度，再调用执行设备的模型解析服务。Harness `0.2.1-rc.2` 的公开 `selectModel()` 会同时更新全局默认模型，因此适配器使用该控制器已有的 `agents.selectForNextRequest()` 与串行选择入口，只修改目标会话。接口契约集中在 `host.ts`，接入点在 `models.ts`。

运行记录从本轮的 `request/header` 读取实际模型，历史轮次不随后续选择改变。恢复会话和发送前检查忙碌状态；模型不可用或选择失效时返回错误，由用户重新选择。

`/dl/delegate` 与所有者 `delegate` 端点仍提供单次等待接口，用于协议验收。它们返回 `completed`、`error` 或 `timeout`，等待超时后会话继续运行。

## 会话读取与本地缓存

### 数据来源与范围

`host-facts.ts` 从 `workspaceRegistry` 读取工作区，从 `sessions` 读取活跃会话，从 `agents` 读取智能体，并通过 `sessionQuery.listSessions()` 补充历史会话目录。读取历史正文时使用 `sessionQuery.readSession()`，该操作直接读取历史日志。

宿主工作区对象通过属性访问器提供路径和标题。插件显式读取 `id`、`path`、`title`，构造普通对象后再传输，使 JSON 响应包含这三个字段。

正文统一从来源为 `user` 的 `user/message` 和 `assistant/message` 持久化事件中提取。活跃会话使用 `snapshotEvents()`，历史会话使用 `sessionQuery`，使正文对应可见对话内容。

会话标题优先取最新 `session/title` 事件，缺少标题时取第一条用户消息，空会话显示“新会话”。活动时间取创建时间、可用的宿主更新时间与用户或助手消息时间的最大值。目录按活动时间降序排列，经过范围过滤后最多保留 200 项。连接方自动同步其中前 20 项的正文，并保留仍在授权目录内的旧缓存。预览可按需读取其他已授权正文。

正文提取用户和助手的文本块。每个快照最多保留最后 100 条消息，文本总长度最多为 64,000 个 UTF-16 代码单元，超出时从末尾保留并设置 `truncated=true`。

消息携带事件序号、轮次及用户请求标识，任务回执携带对应 `promptRequestId`。详情按请求身份合并历史与任务结果，不按文本相似度去重。缺少事件身份的旧缓存先单独提供阅读入口，联网更新后再合并。未获正文同步权限时，详情显示本机任务记录与返回结果。

### 同步与离线读取

启用模型工具时，插件启动后同步一次，并每 20 秒尝试刷新。客户端读取 `state` 也会调用同步。连接器会复用 15 秒内的普通同步结果，并让同一设备的并发调用共用正在进行的请求。显式 `sync` 操作跳过时间缓存。

同步成功后，连接方原子保存设备状态、目录及正文。整个快照的 `syncedAt` 表示设备同步时间，每个正文的 `cachedAt` 表示该正文读取成功的时间。某个正文暂时读取失败时，如果它仍出现在本次会话目录中且工作区路径相同，可以保留旧正文及原缓存时间。

| 同步结果 | 本地缓存的处理 |
|---|---|
| 状态与正文读取成功 | 保存本次范围内的快照 |
| 正文返回 404 | 删除该正文快照 |
| 同步过程返回 401 或 403 | 清除该设备的完整缓存 |
| 网络失败或其他读取错误 | 保留可用旧缓存，在设备状态中记录读取错误 |
| 本地断开连接 | 删除该设备的配对记录与缓存 |

因此，对方设备关闭接入开关后返回的 403 也会清空缓存。离线读取在网络失败时使用最后保存的快照。

预览正在展示正文时，也会检查更新后的 `cachedSessionIds`。该会话被移出缓存后，页面清除已展开的正文。

### `@` 引用与模型工具

客户端向 `inputTriggers.registerSource()` 注册 `@` 候选源。候选从本机 `/device-link/api/references` 读取已保存状态，包含工作区和已缓存正文的会话。选中候选后插入 Harness 原生引用标签。标签保留设备 URI，点击可打开右侧预览。发送时 codec 将会话标签转换为带设备来源、缓存时间和正文的资料，工作区标签转换为设备 URI 与可读来源信息。序列化内容置于 `device-link-reference` 标记中，用户文本规则将完整标记渲染为标签。会话标签预览读取消息内的固定快照。该过程读取本地缓存，失败会阻止发送。

以下为引用格式，设备 id、工作区路径和会话 id 由候选内容生成。

```text
@device://<deviceId>/workspace?path=<encodedPath>
@device://<deviceId>/session?id=<encodedSessionId>
```

`device_delegate` 接收 `device`、`workspace`、`task` 和可选的 `sessionId`、`timeoutSeconds`。`device_task` 按 `taskId` 查询或停止任务。`device_sessions` 接收 `device`，可用 `sessionId` 读取正文，或用 `sync=true` 先尝试刷新。系统提示向智能体说明这些工具与引用的对应关系，缓存内容作为历史参考交给本地任务。

## 状态文件与写入规则

状态路径为 `$DSH_HOME/device-link/devices-v2.json`，未设置 `DSH_HOME` 时使用用户主目录下的 `.dsh`。新状态生成独立设备 id。

| 字段 | 内容 |
|---|---|
| `version` | 当前为 `2` |
| `identity` | 本机设备 id、显示名称和创建时间 |
| `serve` | 监听信息与持久化接入开关 |
| `trusted` | 按连接方设备 id 保存的授权、账号关系和令牌哈希 |
| `peers` | 按接收方设备 id 保存的地址、访问令牌及缓存 |
| `favorites` | 收藏的设备工作区 |
| `incomingTasks` | 执行方任务，按来源设备和请求 id 索引 |
| `outgoingTasks` | 连接方提交、来源会话及缓存结果 |
| `taskCancellations` | 按设备、请求 id 和令牌哈希绑定的取消记录 |

`trusted.lastSeenAt` 当前在配对时写入，`peers.lastSeenAt` 在设备状态同步成功时更新。

存储器将同一实例的更新串行执行。每次更新先复制当前状态，对副本运行修改函数，再写入临时文件并原子重命名，最后发布新的内存状态。读取接口返回副本。修改函数或写入失败时，内存继续保留上一次已提交状态。状态文件读取或结构检查失败时，尝试将原文件重命名为 `.corrupt-<时间戳>` 备份，再创建新状态。

## API 参考

### 所有者 API

以下路径均以 `/device-link/api/` 为前缀，通过本机 Harness 的所有者鉴权。POST 请求使用 JSON 对象。

| 方法 | 路径 | 输入或结果 |
|---|---|---|
| GET | `state` | 返回本机身份、监听、配对状态、授权和对方设备快照，可触发同步 |
| GET | `references` | 从本机缓存返回 `peers` 候选数据 |
| POST | `allow` | 接收 `{ relationship, scope }`，返回配对码、过期时间与地址 |
| POST | `close-pairing` | 关闭当前配对码 |
| POST | `pair` | 接收 `{ address, code }`，保存连接并返回设备摘要 |
| POST | `diagnose` | 接收 `{ address }`，返回 `diagnostic` 及检查阶段 |
| POST | `toggle` | 接收 `{ allowIncoming }`，返回实际接入状态 |
| POST | `scope` | 接收 `{ deviceId, scope }`，保存指定连接方的范围 |
| POST | `open` | 接收 `{ deviceId }`，返回单次访问 URL |
| POST | `sync` | 接收 `{ deviceId }`，刷新该设备缓存并返回 `peer` |
| POST | `session` | 接收 `{ deviceId, sessionId, refresh? }`，返回正文、来源和缓存时间，`refresh=true` 尝试在线更新 |
| GET | `tasks` | 返回本地持久化任务列表 |
| POST | `execution` | `{ deviceId, workspacePath, sessionId? }`，读取执行设备模型目录、会话选择与忙碌状态 |
| POST | `task-start` | `{ id, deviceId, workspacePath, task, sessionId?, selection? }`，创建或续写设备任务 |
| POST | `task-refresh` | `{ id }`，刷新任务状态 |
| POST | `task-cancel` | `{ id }`，请求停止 |
| POST | `favorite` | `{ deviceId, path, enabled }`，增删收藏 |
| POST | `delegate` | 接收 `{ deviceId, workspacePath, task, timeoutMs }`，返回委派状态 |
| POST | `revoke` | 接收 `{ deviceId, side }`，`side='trusted'` 撤销入站授权，`side='peer'` 删除出站连接并请求对端撤销 |

### 设备 API

令牌鉴权接受 `Authorization: Bearer <token>` 或 `dl_session` Cookie。两个值同时出现时优先使用 Bearer。接入开关和令牌检查通过后，具体操作继续检查授权范围。

| 方法 | 路径 | 输入与授权条件 |
|---|---|---|
| GET | `/dl/info` | 公开设备身份、协议版本和配对开放状态 |
| POST | `/dl/pair/claim` | `{ code, deviceId, name }`，使用有效配对码 |
| POST | `/dl/pair/revoke` | `{ deviceId }`，请求设备撤销自身授权 |
| GET | `/dl/status` | 有效设备令牌，返回按范围过滤的状态 |
| GET | `/dl/sessions` | 有效设备令牌，返回可同步的会话目录 |
| GET | `/dl/session?id=...` | 有效设备令牌、正文同步权限及会话范围 |
| POST | `/dl/execution` | `{ workspacePath, sessionId? }`，委派授权及工作区、续写会话范围校验 |
| POST | `/dl/tasks` | `{ requestId, workspacePath, task, sessionId?, selection? }`，验证工作区及续写会话访问范围后提交 |
| GET | `/dl/tasks/<id>` | 查询本授权下的任务 |
| POST | `/dl/tasks/<id>/cancel` | 停止本授权下的任务，或预先取消此请求 id |
| POST | `/dl/delegate` | `{ workspacePath, task, timeoutMs }`，有效令牌、委派权限和工作区校验 |
| POST | `/dl/access` | 有效设备令牌与完整界面授权 |
| GET | `/dl/enter?ac=...` | 有效单次访问码及兑换时仍有效的完整界面授权 |
| HTTP / WebSocket | GUI 路径 | 有效设备令牌与完整界面授权 |

普通成功响应包含 `ok=true`。委派结果还需读取 `status`，其值决定模型任务是否完成。诊断结果还需读取 `diagnostic.ok` 和 `diagnostic.stage`。请求失败通常返回 HTTP 错误码及 `ok=false`、`error`，设备接口还可能返回 `reason`。

JSON 请求体上限为 64 KiB，连接方读取响应上限为 2 MiB。浏览器请求携带 Origin 时，Origin 需要与设备监听来源相同。收到跨站请求标记时返回 403。

## 代码与交付资产

| 文件或目录 | 维护内容 |
|---|---|
| `src/index.ts` | 插件装配、启动、停止和注册清理 |
| `src/lib/types.ts`、`host.ts` | 插件数据结构和实际使用的 Harness 服务契约 |
| `src/lib/config.ts`、`network.ts` | 配置、网卡选择、地址诊断、两端插件版本比较 |
| `src/lib/store.ts`、`pairing.ts`、`scope.ts` | 状态事务、配对凭据和授权检查 |
| `src/lib/serve.ts`、`connect.ts` | 接收方路由和连接方请求及缓存 |
| `src/lib/proxy.ts`、`credentials.ts` | GUI 转发和所有者 Cookie 交换 |
| `src/lib/host-facts.ts`、`delegation.ts` | 宿主状态、会话读取和设备任务执行 |
| `src/lib/models.ts`、`presentation.ts` | 执行模型目录与会话级选择、可读标题和时间 |
| `src/lib/api.ts`、`commands.ts`、`tool.ts` | 所有者 API、`/device` 命令和模型工具 |
| `src/client.tsx`、`src/client/` | 插槽注册、侧栏、设备面板、右侧预览、引用标签、任务卡片和设置 |
| `src/lib/tasks.ts`、`outgoing-tasks.ts` | 双端任务持久化、幂等提交、取消和结果跟进 |
| `test/` | 配对、代理、授权、缓存、宿主调用与候选生成的回归测试 |
| `scripts/e2e-two-instance.ts` | 两个隔离 Harness 实例的协议、模型、文件任务及可选浏览器协作验证 |
| `scripts/demo.ps1` | 依赖预建 `dl-a` profile 的本机演示辅助脚本 |
| `cordis.patch.yml`、`locale/`、`icon.svg` | 插件安装配置、清单文案和图标 |
| `package.json`、`tsconfig.json`、`package-lock.json` | 包入口、构建脚本、严格类型检查和依赖锁定 |

源码编译到 `dist/`，服务端包入口为 `dist/index.js`，客户端入口为 `dist/client.js`。`npm pack` 在打包前构建，分发包包含构建产物、插件清单资产、README 和设计说明。

当前设备更新状态通过比较对方设备与本机的插件版本得出。读取到高于本机的三段式版本时标记 `remote-newer`，低于本机时标记 `remote-older`，相同标记 `current`，其他版本格式标记 `unknown`。

## 客户端布局与字体

`sidebar.footer.action` 提供设备入口，展开侧栏时显示图标、名称和在线数，收起后显示图标。收藏列表位于设备面板。宿主通过带 `data-slot` 的 `display: contents` 元素包装扩展入口，插件用包含自身入口的插槽锚点定位外层操作条，设置纵向排列、宽度上限和间距。样式随插件卸载而移除。

客户端使用 `--dsw-font-family` 和 `--dsw-font-*` 字体变量。普通控件为 `s-14`，面板标题为 `s-strong-14`，分组提示为 `xs-13`，来源、时间和状态为 `xxs-12`。预览正文使用 `markdown-base`，跟随 Harness 的内容字号设置。

工作区概览位于右侧资源页签，中央面板负责任务总览和连续对话。工作区最近会话、总览任务卡片及本地工具卡片进入同一详情，任务入口可定位到具体轮次。详情复用宿主 `MarkdownText`；底部输入区固定在正文滚动区域外。

浏览器以本机设备身份隔离本地存储，分别保存每个工作区的新任务草稿、每个设备会话的续写草稿、模型选择、详情目标、来源返回信息与阅读位置。提交前先保存稳定请求身份；响应丢失后查询服务端记录，未确认送达的请求继续沿用同一身份。服务端任务状态仍保存在 `devices-v2.json`，独立于浏览器的打开或关闭。
