# 命令、配置与数据

日常连接和操作见 [README](../README.md)。

## 命令与模型工具

配对与授权可通过设备面板完成，也可使用命令：

| 命令 | 作用 |
|---|---|
| `/device` 或 `/device status` | 本机身份和监听状态 |
| `/device list`、`/device trusted` | 已连接设备、已授权设备 |
| `/device diagnose 地址` | 检查地址、网络和协议 |
| `/device pair 地址 配对码` | 连接设备 |
| `/device open 设备`、`/device sync 设备` | 打开完整界面、刷新缓存 |
| `/device session 设备 会话id` | 读取缓存正文 |
| `/device delegate 设备 \| 工作区绝对路径 \| 任务` | 创建持久化任务 |
| `/device tasks`、`/device task 任务id`、`/device cancel 任务id` | 列表、刷新、停止任务 |
| `/device revoke 设备`、`/device untrust 设备` | 断开出站连接、撤销入站授权 |

`/device allow` 使用“待确认”的空授权生成配对码；要委派或打开完整界面，请在面板选择相应范围。重名设备使用设备 id 操作。

智能体用 `device_inspect` 查看引用范围，`device_search` 查找线索，`device_read` 按定位信息和版本读取原文；用 `device_delegate` 创建或续写设备任务，`device_task` 查询或停止。委派工具默认等待 300 秒，最多 600 秒；遇到人工处理请求会提前返回等待状态，任务保留。等待结束后仍可用任务 id 跟进。

## 配置与诊断

在“设备 → 连接设置”或“允许连接本机”中修改“本机名称”并保存，立即生效，重启后保留。已连接设备会在下一次同步时更新名称；离线期间保留最近同步的名称。改名不改变连接授权。

配置位于 Harness profile 的插件配置项中：

| 字段 | 默认值 | 用途 |
|---|---|---|
| `allowIncoming` | `true` | 配置级接入开关 |
| `listenPort` | `47654` | `0` 自动分配；占用时回退到空闲端口 |
| `bindAddress` | `auto` | 选择私有局域网 IPv4；也可指定本机私网地址或 `127.0.0.1` |
| `deviceName` | 主机名 | 首次创建设备身份时的名称；之后在界面修改 |
| `pairingTtlMs` | `120000` | 配对码有效期，毫秒 |
| `accessTtlMs` | `60000` | 完整界面访问码有效期，毫秒 |
| `proxyRequestTimeoutMs` | `30000` | GUI HTTP 请求超时，毫秒 |
| `toolsEnabled` | `true` | 注册模型工具和后台同步 |
| `maxPairFailures` | `8` | 配对失败阈值 |
| `failureWindowMs` | `600000` | 失败计数窗口，毫秒 |

`DSH_DEVICE_LINK_PORT`、`DSH_DEVICE_LINK_BIND`、`DSH_DEVICE_LINK_ALLOW` 覆盖相应配置。配置级关闭接入时，需要先修改配置并重启，才能使用界面开关。

连接地址接受私有 IPv4、回环 IPv4 和 `localhost`，省略端口时使用 `47654`。不要填写路径或账号密码。诊断停在 `address` 时修正输入；停在 `tcp` 时检查网卡、防火墙和实际端口；停在 `protocol` 时检查插件端口及两端构建。

若监听地址显示 `127.0.0.1`，其他电脑不能接入。将 `bindAddress` 改为本机私有局域网地址后重启。每次连接以页面显示的实际端口为准。

## 本地数据

状态文件是 `$DSH_HOME/device-link/devices-v2.json`；未设置 `DSH_HOME` 时位于用户主目录的 `.dsh` 下，包含配对关系、令牌、收藏、任务和缓存。读取器要求完整的当前顶层结构，不补齐旧格式。解析或结构错误先保存 `.corrupt-时间戳` 备份，再创建新的设备身份，需要重新配对；文件访问或备份失败则报错并保留原文件。

资源入口和读取记录保存在同目录的 `references.json`。在面板或命令中断开设备都会删除该设备的入口和记录。
