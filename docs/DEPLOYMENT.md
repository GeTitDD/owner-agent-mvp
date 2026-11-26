# 安装与部署

## 结论先说

| 形态 | 推荐方式 | 容器化 |
| --- | --- | --- |
| 桌面客户端（主产品） | Windows 便携版 exe | **不推荐**，见下文 |
| 本地 Workbench（历史 Web 控制台） | 源码运行 `npm run workbench` | 可以，但不在支持范围 |

## 桌面客户端

### 用户：下载便携版

发布页会提供 `OwnerCompanion-<version>-portable.exe` 与 `SHA256SUMS.txt`。
双击即用，不需要安装；数据写在 `%APPDATA%\owner-agent-mvp`。

首次启动后按 README 的「快速开始」配置项目与模型。
Windows SmartScreen 可能提示「未知发布者」——当前没有代码签名证书，校验 SHA256 后再运行。

### 自己打包

```powershell
npm ci
npm run desktop:pack
```

产物在 `dist-companion/`：

```text
OwnerCompanion-1.0.0-portable.exe     便携版
win-unpacked/                          未压缩目录（调试用）
```

`npm run desktop:dir` 只生成 `win-unpacked/`，适合本地排查打包问题。

### 发布

打 tag 即可触发 `.github/workflows/release.yml`：

```powershell
git tag v1.0.0
git push origin v1.0.0
```

工作流会构建 portable、生成 SHA256、创建 GitHub Release 并上传两个文件。

### 升级与迁移

- 覆盖 exe 即可；数据在 `%APPDATA%`，不随 exe 走。
- 备份就是复制 `%APPDATA%\owner-agent-mvp` 整个目录（`owner.sqlite`、`knowledge.sqlite`、`companion.json`）。
- 换机器：复制该目录，注意 `companion.json` 里的路径需要按新机器调整，或重新跑 `/setup`。

## 为什么不把客户端容器化

Electron 客户端不是「一个服务」，容器化会同时失去三件它依赖的东西：

1. **窗口与托盘**：无边框窗口、`alwaysOnTop`、托盘菜单、桌宠都需要一个真实的桌面会话；
   容器里要额外跑 X/Wayland 或 VNC，使用体验比直接装 exe 差。
2. **本地路径语义**：写入判定以「自有目录 / 被观察项目目录」为界，全部是本机绝对路径；
   容器里必须把宿主机目录挂进来，边界从「这个项目」退化成「挂载了什么」，等于把安全模型交给 `docker run` 的参数。
3. **密钥与登录态**：Pi 的 `~/.pi`、系统环境变量、审批令牌都在宿主机；
   容器要额外注入，反而增加密钥扩散面。

如果以后要做「一台机器常驻、多端访问」，正确形态是拆出一个**无 GUI 的 sidecar 服务**（显式 API、显式存储卷、显式认证），再让客户端连它。
那是一个新产品的边界，不是给现在的 Electron 客户端套个 Dockerfile。

## 可选：Workbench 容器（实验性，不在支持范围）

仓库里仍有 `bin/workbench.mjs`（v0.4 的本地 Web 控制台）。它只绑定 loopback，读取 `owner.sqlite`。
理论上的容器跑法：

```powershell
docker run --rm -p 127.0.0.1:4317:4317 `
  -v "${env:APPDATA}\owner-agent-mvp:/data:ro" `
  -e OWNER_AGENT_DB=/data/owner.sqlite `
  node:22-alpine `
  sh -c "cd /app && npm ci --omit=dev && node bin/workbench.mjs"
```

需要自己把仓库挂进 `/app`，且没有官方镜像。**不建议**把它当部署方案：

- 它不参与卡片客户端的主流程；
- 没有任何认证，只适合本机；
- 路径与数据布局可能随版本变化。

需要远程访问时，优先用 SSH 隧道或你自己的 VPN，不要把端口暴露到公网。

## 运行要求

- Windows 10/11（客户端）；Workbench 可在 Linux/macOS 源码运行
- Node.js ≥ 22.13（源码运行与打包）
- 可选：Pi 凭据（`~/.pi/agent/auth.json` 或 provider 环境变量）
- 磁盘：客户端约 200 MB（含 Electron 与 Monty 运行时），数据随项目数量增长
