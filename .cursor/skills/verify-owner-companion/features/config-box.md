# 配置箱

## Sub-features

- 顶栏齿轮打开全窗口覆盖层；七个分区：模型接口 / 目录 / 分享 / 技能 / 写入范围 / 监控 / 同步
- 每行「标签 + 值 + 一句后果 + 来源（探测 / 手改）」
- 模型行：输入框 + 「已装模型」下拉（来自 Pi 目录），选一项写进输入框
- 密钥行：只显示环境变量名与「已检测到 / 未配置」，**没有输入框**
- `/setup` 探测入口；保存写回 `companion.json`；取消不写文件

## How to get to it (user POV)

1. 点顶栏最右侧齿轮。
2. 覆盖层铺满窗口，上下滚动能看到七个分区。
3. 改主模型：在下拉里选一个，输入框跟着变；点「保存」。
4. 点「取消」或 Esc：配置箱收起，文件不变。

## Driving it with CDP

```js
document.getElementById('configToggle').click();
await waitFor(panel, "document.getElementById('configBox').hidden === false", 5000);

const sections = await panel.evaluate(
  "[...document.querySelectorAll('.cfg-group')].map((n) => n.dataset.section)"
);
// ['model','paths','share','skills','write','watch','sync']

const picks = await panel.evaluate(`(() => {
  const pick = document.querySelector('[data-pick-for="model"]');
  return { disabled: pick.disabled, options: [...pick.options].map((o) => o.value).filter(Boolean) };
})()`);
// 隔离实例的假 Pi 目录：['demo-provider/fast-model']

// 取消：不产生写入
document.getElementById('configCancel').click();
```

断言点：七个分区顺序、每行都有 `标签 + 效果`、密钥行没有 `input`、
`companion.json` 在取消前后字节一致（`fs.readFileSync` 比长度/内容）。

## Gotchas

- 隔离实例把 `OWNER_AGENT_PI_HOME` 指向假 Pi 目录，所以下拉里只有 `demo-provider/fast-model`；
  不要拿真实机器上的模型名做断言。
- 密钥状态来自环境变量；验证实例没有设置真实密钥，显示「未配置」是正常的。
- 打开配置箱会先读配置再读模型目录，两件事都失败时箱子仍然要能打开（降级）。
- 保存会写到临时 userData 的 `companion.json`，不是仓库或真实 `%APPDATA%`。
- 探测按钮（`#configProbeEntry`）走 `/setup` 同一条路：会先落一条用户消息再探测，属于正常行为。
