# 手机端（iOS / Android）

手机端是一个 Expo（React Native + TypeScript）客户端，通过局域网连接桌面端 Owner Companion。
它面向“随时看一眼项目、顺手记想法”的场景，不承担审批与写文件。

## 架构

```text
iPhone / Android (Expo)
        │  HTTP + 设备令牌
        ▼
桌面端 mobile bridge（src/mobile-server.mjs，默认端口 47831）
        │
        ├─ 概览：项目、画像、下一步、知识计数、图谱版本
        ├─ 聊天：复用桌面端的只读分诊（大仓库走本地摘要）
        └─ 想法：新增 / 采纳 / 搁置 / 重开 / 删除
```

安全边界：

- 配对码 6 位、10 分钟有效、只能使用一次；设备令牌 32 字节，服务端只保存 SHA-256；
- 手机端**没有**审批、写文件、执行 Job 的接口；
- 聊天里的写请求只会在桌面端生成待审批项，必须在电脑上批准；
- 桥默认监听 `0.0.0.0:47831`，仅建议在可信局域网使用；公网暴露请自行加 TLS 与反向代理。

## 启动桌面端

1. 打开 Owner Companion → 设置 →「手机连接」；
2. 记下形如 `http://192.168.31.43:47831` 的地址和 6 位配对码；
3. 端口被占用时桌面端会自动尝试 47832–47835，可在设置里看到实际地址；
4. Windows 首次监听会弹防火墙提示，选「允许专用网络」；手机连不上时检查 47831 的入站规则。

## 启动手机端

```powershell
cd mobile
npm install
npx expo start
```

- iPhone：App Store 安装 **Expo Go**，扫描终端二维码；
- Android：Expo Go 扫码；
- 首次打开填写地址 + 配对码即可，令牌存进系统 Keychain / Keystore（expo-secure-store）。

也可以直接导出 iOS 包验证：

```powershell
npx expo export --platform ios
```

## 接口（v1）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/m/health` | 健康检查（无需令牌） |
| POST | `/m/pair` | `{ code, deviceName }` → 设备令牌 |
| GET | `/m/overview?projectId=` | 项目列表 + 当前项目概览 |
| POST | `/m/chat` | `{ projectId, text }`，只读分析 |
| POST | `/m/ideas` | `{ projectId, title }` |
| PATCH | `/m/ideas/:id` | `{ status: todo/doing/blocked/done }` |
| DELETE | `/m/ideas/:id` | 删除想法 |
| GET | `/m/ping` | 令牌有效性检查 |

所有非健康检查接口都需要 `Authorization: Bearer <deviceToken>`。

## 已实现 / 未实现

已实现：

- 配对与设备令牌、断线重连提示；
- 项目列表、项目画像、下一步建议、知识计数、图谱版本；
- 想法池：新增、采纳、搁置、重开、删除、带上下文发起讨论；
- 聊天：进度问答、改进意见讨论，自动显示“分析中… Ns”。

未实现（后续可加）：

- 推送通知、后台轮询；
- 离线缓存与本地历史；
- 图谱 SVG 预览（当前只显示版本与类型）；
- 知识审核（审核仍在桌面 Workbench）；
- App Store 打包与签名（需要 Apple 开发者账号）。

## Cindy 插件（同一套桥）

`plugins/owner-companion/` 是按 Cindy `ghost.json`（schemaVersion 3）写的插件：

- 安装包：`plugins/dist/owner-companion-0.1.0.cindy`（zip 根目录即 `ghost.json`）；
- 主视图 / 面板：项目画像、想法池、知识计数、图谱版本、只读聊天；
- 设置页：填 `http://127.0.0.1:47831` + 6 位配对码，插件只保存设备令牌；
- 权限：只声明 Node worker，页面与 `main.js` 不直连网络；没有审批/写文件/执行 Job；
- worker 契约测试：`tests/owner-companion-plugin.test.mjs`。

插件源码结构见 `plugins/owner-companion/README.zh-CN.md`。
