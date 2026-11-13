# 发布

npm 包名为 `dsh-device-link`，GitHub 仓库为 [XJfyrh/dsh-device-link](https://github.com/XJfyrh/dsh-device-link)。根目录 README 同时展示在 GitHub、npm 和 DSH 插件详情中，优先保留用户操作说明。

## 准备版本

1. 更新包版本。`package.json`、`package-lock.json` 顶层及 `packages[""]` 中的版本必须一致；同步修改 `src/lib/types.ts` 的 `APP_VERSION`。
2. 更新 README 中的宿主兼容版本和相关操作说明。更改宿主契约时同步维护 `DESIGN.md`。
3. 在仓库根目录执行检查并查看包内文件：

```powershell
npm ci
npm run check
git diff --check
npm pack --dry-run
npm pack
```

`prepack` 会清理并重新构建 `dist/`。包中保留服务端、浏览器入口、类型声明、语言文件、图标、README 和许可文件；源码、测试、开发文档、凭据与本地验收资料留在包外。文件清单由 `package.json#files` 控制，检查方式见 [npm pack 文档](https://docs.npmjs.com/cli/v11/commands/npm-pack/)。

使用生成的安装包在目标 Harness 中验证安装、设备入口和基本连接。协议、真实模型和浏览器验证方法见 [CONTRIBUTING.md](../CONTRIBUTING.md#双实例验证)。记录本次实际宿主版本、测试范围和结果。

## 发布 npm

先确认登录账号和已发布版本。尚未登录时，运行 `npm login --registry=https://registry.npmjs.org/` 完成登录。

```powershell
npm whoami --registry=https://registry.npmjs.org/
npm view dsh-device-link versions --json --registry=https://registry.npmjs.org/
```

包名尚未发布时，版本查询返回 404。若已经存在本次版本，需更换版本号并重新构建；npm 不能覆盖已发布的版本。

将下例版本替换为本次版本，发布刚刚验证过的同一份安装包：

```powershell
npm publish ./dsh-device-link-0.5.2.tgz --access public --registry=https://registry.npmjs.org/
npm view dsh-device-link@0.5.2 version dist.integrity --registry=https://registry.npmjs.org/
```

发布命令执行时，按 npm 提示完成账号验证。发布后查询应返回本次版本及包的完整性摘要。发布参数与包文件规则见 [npm publish 文档](https://docs.npmjs.com/cli/v11/commands/npm-publish/)。

## 发布 GitHub 版本

npm 发布成功后，在对应提交上创建与包版本相同的 `v版本号` 标签并推送。然后创建 GitHub Release，附上本次验证过的 `.tgz`，说明主要变化、目标 Harness 版本和安装方式。

GitHub CI 在 Windows、Linux 和 macOS 上运行类型检查、回归测试、构建和打包预览，不使用模型凭据。它不代替真实宿主或双机验证，也不会自动发布 npm。
