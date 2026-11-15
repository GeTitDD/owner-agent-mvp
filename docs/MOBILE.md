# 手机端（Cindy）

从 v0.2 起，Owner Companion 不再自带独立手机客户端，手机端直接使用 **Cindy 的手机 App**：

- 桌面端安装 Owner 插件并登记项目；
- 手机与电脑登录同一 Cindy 账号、连接同一台电脑；
- 打开 Owner 插件，即可看到 `mainView` 的移动投影（项目、画像、想法、知识、依赖图）。

## 为什么不再自己做 App

Cindy 已经解决了设备互联、账号、权限、推送与手机 WebView 的宿主能力。
插件只需声明 `mobile` 投影：

```json
"mobile": {
  "channels": ["owner-companion"],
  "mainView": "main-view.html",
  "settings": "settings.html"
}
```

手机页面通过宿主声明的 BroadcastChannel 与电脑上的插件通信，业务逻辑仍在电脑的
Node worker 里执行，数据也保存在电脑上。

## 数据与权限

- 手机端只能看项目、画像、想法、知识与依赖图；
- 写操作限于插件自己的 JSON（想法、知识笔记），不写项目文件；
- 审批与改代码仍由 Cindy 的 Agent / 权限模型处理。

## 迁移说明

旧的 Expo 客户端（`mobile/`）已移除。它的功能（项目、想法、知识、只读聊天）已经
被插件主视图 + Cindy Agent 覆盖；手机端的聊天直接使用 Cindy 原生会话。

## 已知限制

- 手机页面需要触屏适配与 Light/Dark 双模式，目前复用桌面 HTML，后续按真机反馈调整；
- 依赖图在手机上只展示摘要与版本，Mermaid 请在桌面端或 Cindy 聊天里查看；
- 未做推送与未读计数（等宿主提供统一能力后再接）。
