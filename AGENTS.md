# 开发与维护

项目使用 Node.js 24+、TypeScript strict 和 ESM。用户操作见 [README.md](README.md)，服务契约与数据流见 [DESIGN.md](DESIGN.md)，开发、安装和双实例验证见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 修改入口

先检查 `git status --short`，再沿 `src/index.ts` 的装配关系找到相关模块。修改宿主调用时核对当前安装的 Harness 类型与实现，插件使用的契约集中在 `src/lib/host.ts`。

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

- 当前阶段不维护旧协议、旧状态迁移或旧宿主 API。删除代码前，核对运行时谁写入数据、哪些入口调用它，以及测试保护的行为；搜索不到引用不能单独作为删除依据。
- 授权在接收方执行，覆盖 HTTP、WebSocket、状态、正文、资料读取和任务。异步读取完成后，在返回数据或保存缓存前再次检查授权是否变化。
- 执行委派任务前，验证工作区真实路径与执行设备的沙箱配置。不能用界面筛选代替服务端授权。
- 任务先持久化再执行，重试保留请求 id；结果、模型与正文按请求和轮次关联，不能按相同文本去重。
- 状态更新串行提交，写盘成功才发布内存快照。读取或备份失败不能覆盖已有文件。
- 注释解释设计原因、外部限制或非显然约束。发现注释与代码不符时追查行为。
- 测试暴露实现缺陷时修复实现，保留能独立检验行为的测试。删除测试要说明相同行为由何处覆盖，或依赖的功能为何已移除。

## 提交前检查

`npm run check` 执行类型检查、回归测试和构建；随后执行 `npm pack --dry-run` 与 `git diff --check`。涉及宿主契约、授权、任务或界面行为时，按 [双实例验证](CONTRIBUTING.md#双实例验证) 运行相应场景。

根目录 README 会在 DSH 插件详情中展示，优先保留用户操作；开发和发布内容分别维护在 `CONTRIBUTING.md` 与 `docs/releasing.md`。本地凭据、研究记录和验收输出不提交。
