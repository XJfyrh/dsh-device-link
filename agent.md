# 项目开发说明

## 项目目标

为 DeepSeek Harness 提供局域网设备配对、授权工作区访问、跨设备任务委派和离线会话引用。模型、终端、浏览器与文件工具由执行设备管理。

功能盘点、安装和验证状态见 [README.md](README.md)，模块职责和协议见 [DESIGN.md](DESIGN.md)。按当前协议与状态结构直接演进，结构调整时同步类型、调用入口和相关文档。

## 工程结构

- `src/index.ts` 装配插件并管理生命周期。
- `src/client.tsx` 实现设备连接设置页和原生 `@` 候选源。
- `src/lib/types.ts` 定义协议、授权、设备状态与缓存类型。
- `src/lib/host.ts` 定义实际使用的 Harness 服务契约。
- `src/lib/serve.ts` 与 `connect.ts` 实现接收方和连接方。
- `src/lib/scope.ts` 负责授权与工作区路径校验。
- `src/lib/host-facts.ts` 与 `delegation.ts` 读取会话并调用 Harness 委派入口。
- `test/` 保存回归测试，`scripts/e2e-two-instance.ts` 验证真实双实例。
- `.agent/` 存放本机开发笔记、临时计划与调试记录，由 Git 忽略规则排除。

## 实现约定

- 使用 TypeScript strict 和 ESM，运行环境为 Node.js 24 或更新版本。
- 源码位于 `src/`，通过构建生成 `dist/`。包的服务端和客户端入口均指向构建产物。
- 复用现有模块与 Harness 服务。涉及宿主 API 时核对本机安装版本的声明和实现。
- 授权在接收方执行，覆盖 HTTP、WebSocket、会话读取与任务委派入口。
- 工作区执行前验证绝对路径、目录存在性与真实路径，应用并检查执行设备的工作区沙箱策略。
- 范围变更和撤销同步处理现有连接、待兑换访问码及正在等待的委派请求。
- 状态更新保持串行事务与原子写入，持久化成功后发布内存状态。
- 离线会话引用携带设备来源、缓存时间和截断标记。授权收紧后同步清理超出范围的缓存。
- 凭据写入本地 `.env`，共享配置示例使用 `.env.example`。日志和测试输出使用脱敏信息。

## 开发与验证

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

根据改动覆盖相关回归场景。修改协议、权限或 Harness 集成后运行双实例测试。

```powershell
Copy-Item .env.example .env
# 填入 DEEPSEEK_API_KEY 后运行
npm run test:e2e
```

存在 API Key 时，双实例测试要求远端模型返回 `DEVICE_LINK_OK`。提交前检查 `git diff --check` 和暂存文件列表，确认本地配置与临时目录的忽略规则生效。

## 待完成验收

- 配置 API Key 后验证远端模型的真实回复。
- 完成设置页全部操作和原生 `@` 菜单的浏览器交互验收。
- 当前首次配对账号关系由接收方所有者确认，自动验证需要接入可验证的跨设备账号凭证。
