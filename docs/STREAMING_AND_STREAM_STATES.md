# 流式输出与对话流状态设计

适用：`desktop/` 的卡片壳 + `src/pi-chat.mjs` 的只读 Pi 会话。
状态：设计稿（未实现）。实现时以本文为验收口径。

## 1. 目标与非目标

**要做**

- 模型回答逐字出现，首字到达时间（TTFT）可见，而不是等整段结束才刷出来。
- 流式过程中能**停下**：停止后保留已输出的部分，并明确标「已停止」。
- 失败可分辨：没模型、没额度、超时、工具出错，各自给不同的下一步。
- 一个会话同时只有一轮在跑；切到别的会话不丢这一轮。

**不做**

- 不做多路并发回答（同一会话同时只跑一轮）。
- 不做「边流边写库」（见 §6 的持久化取舍）。
- 不做 token 级打字机动画；文字到达即渲染。
- 不改 `pi-chat.mjs` 的工具面与只读约束。

## 2. 现状与缺口

```text
现在   send() → await companion.chat.ask() → 整段返回 → 落库 → 重绘
问题   模型跑 20 秒，界面 20 秒内只有「自己那句话」；没有停止入口；失败与超时同一个样子
```

Pi SDK 已经提供了需要的原语（`@earendil-works/pi-coding-agent`）：

```text
session.subscribe(listener)      订阅 AgentSessionEvent
  message_update                 流式更新，带 assistantMessageEvent
    text_delta     { delta, contentIndex }
    thinking_delta { delta }     （默认不显示，可折叠）
    toolcall_delta { delta }     （工具参数片段，不直接展示）
  tool_execution_start/update/end  工具活动
session.abort()                  中止当前轮
session.isStreaming              是否在跑
```

## 3. 传输协议

### 3.1 方向与通道

```text
renderer → main    companion:chat-ask   { turnId, projectId, question }
                   companion:chat-abort { turnId }
main → renderer    companion:chat-event { turnId, seq, ...payload }   （webContents.send）
```

`turnId` 由**渲染层生成**（`crypto.randomUUID()`）。所有事件必须原样带回 `turnId`；
渲染层只接受「当前 turnId 且 seq 单调递增」的事件，其余丢弃。
这样切会话、重试、快速连发都不会把旧事件写进新消息。

### 3.2 事件类型（main → renderer）

| type | 字段 | 含义 |
| --- | --- | --- |
| `turn-start` | `turnId, model, startedAt` | 已建/复用会话，开始一轮 |
| `delta` | `text` | 正文增量，**已按 40–60ms 合并**，不是逐 token |
| `thinking` | `text` | 思考增量（默认折叠，只显示「思考中…」） |
| `tool` | `phase: start/end, name, summary` | 「读取 src/a.ts」这类活动 |
| `turn-done` | `text, citations, missingCitations, usage, durationMs` | 正常结束，`text` 是权威全文 |
| `turn-error` | `category, message, retryable` | 失败，`category` 见 §7 |
| `turn-aborted` | `text` | 用户停止，`text` 是已产出的部分 |

**`turn-done.text` 永远以服务端全文为准**。渲染层在收到 done 时用全文覆盖累积的增量，
避免丢字/重字（增量合并与网络抖动都可能造成偏差）。

### 3.3 背压

- main 侧按 50ms 合并 `text_delta`（或累计 ≥ 80 字立即发），单个事件 ≤ 4KB。
- renderer 侧用 `requestAnimationFrame` 合并重绘：一帧最多渲染一次。
- 事件总量上限：正文 8k 字（与 `MAX_ANSWER` 一致），超出后只累计不渲染，done 时以全文收尾。

## 4. 对话流状态机

状态分两层：**一轮（turn）** 与 **一条消息（message）**。

### 4.1 一轮的生命周期

```text
idle ──send──▶ sending ──turn-start──▶ streaming ──turn-done──▶ done
                  │                        │
                  │                        ├──turn-aborted──▶ aborted
                  │                        └──turn-error────▶ error
                  └──本地校验失败（无会话/空文本）──▶ idle（不建 turn）

done / aborted / error ──再次 send──▶ sending（新 turnId）
error ──重试──▶ sending（沿用原问题，新 turnId）
```

| 状态 | 界面 | 可发送 | 停止按钮 |
| --- | --- | --- | --- |
| `idle` | 正常输入框 | 是 | 否 |
| `sending` | 助手气泡先出现「思考中…」+ 已用秒数 | 否 | 是 |
| `streaming` | 增量文字 + 光标块 | 否 | 是 |
| `done` | 完整回答 + 引用块 | 是 | 否 |
| `aborted` | 已产出部分 + 「已停止」+ 「重试」 | 是 | 否 |
| `error` | 错误文案 + 下一步按钮 | 是 | 否 |

`sending` 与 `streaming` 的区别只在于**有没有收到第一个 delta**：
两者都算「一轮在跑」，输入框锁定、发送变停止。

### 4.2 消息的状态

| 状态 | 存储 | 渲染 |
| --- | --- | --- |
| `pending` | 不落库 | 「思考中…」占位气泡，无正文 |
| `streaming` | 不落库 | 累积正文 + 光标；`aria-live="polite"` |
| `final` | 已落库 | 正常气泡；`blocks` 带引用 |
| `aborted` | 已落库 | 正文 + 「已停止」徽章 |
| `error` | 已落库 | 错误说明 + 「重试」 |

**同一时刻只有一条 `pending/streaming` 消息**（当前会话）。

### 4.3 会话级状态

| 字段 | 取值 | 用途 |
| --- | --- | --- |
| `activity` | `idle / streaming / error` | 会话列表里的小圆点；切走再回来能看出还在跑 |
| `unread` | `bool` | 流在后台结束、用户不在这个会话时标一个点 |
| `lastError` | `category + at` | 会话行 tooltip，不与当前轮混淆 |

切会话不中止流：流继续跑，`done` 时写进它所属的会话（不是「当前会话」）。
**写库用的 sessionId 必须在发起时固定**，不能用 `currentId()`。

## 5. 交互细节

- **停止**：`send` 变 `停止`；点击 → `chat.abort` → 期望 `turn-aborted`。
  200ms 内没有收到事件也先把 UI 置为 `aborted`（本地先停视觉，服务端事件迟到就丢）。
- **重试**：沿用原问题，生成新 `turnId`；旧消息保留（不覆盖、不删除）。
- **自动滚动**：仅当用户在底部 24px 内才跟随；用户上滚即停止跟随，并显示「回到底部」。
- **代码块**：围栏未闭合时不语法高亮；闭合后（或 done 时）整体高亮一次，避免闪烁。
- **复制**：流式中复制按钮禁用，done 后可用（沿用 `shell-copy`）。
- **空回答**：`done` 但正文为空 → 按 `error`（`empty-answer`）处理，不显示空气泡。
- **长回答**：超过 8k 字截断并注明「已截断」，与 `MAX_ANSWER` 一致。

## 6. 持久化取舍

```text
用户消息   发送时立即落库（现有行为）
助手消息   只在 turn-done / turn-aborted / turn-error 时落一次
```

理由：现有存储没有「更新一条消息」的接口，流式中反复写会产生半截消息与重复。
代价：流式中崩溃 → 这一段丢失；用户消息还在，重试即可。
如果要「崩溃保留部分」，需要给 `owner_chat_messages` 加 `status` 与 update API，
那是另一张票，不在本设计内。

## 7. 失败分类与文案

| category | 触发 | 文案要点 | 下一步 |
| --- | --- | --- | --- |
| `no-model` | `config.model` 为空 | 「还没选模型」 | 打开配置箱 · 模型接口 |
| `quota` | 429 / 额度用尽 | 「额度用尽（429）」 | 换模型 |
| `timeout` | 超过 120s 无新事件 | 「这条回答超时了」 | 重试 |
| `tool-error` | 工具连续失败 | 「读文件失败」+ 路径 | 重试 / 换问法 |
| `empty-answer` | done 且正文为空 | 「这次没有结论」 | 重试 |
| `session-error` | 其余异常 | 原始 message（脱敏后） | 重试 |

所有错误都保留问题文本；**错误也是一条普通消息**，可复制、可导出。

## 8. 与现有代码的接口

```text
src/pi-chat.mjs
  createChatSessionFactory().create() 返回值新增：
    subscribe(listener)    转发 session.subscribe
    isStreaming()          session.isStreaming
  PiChatService.askStream({ project, question, model, onEvent }) → Promise<result>
    - 内部订阅 message_update / tool_execution_*，转成 §3.2 的事件
    - 结束返回与 ask() 相同的形状（answer / citations / status / durationMs）

desktop/main.cjs
  companion:chat-ask   → 建 turnId 映射，调用 askStream，事件 webContents.send
  companion:chat-abort → 按 turnId 找会话并 abort

desktop/preload.cjs
  chat.ask(input) / chat.abort(turnId) / chat.onEvent(cb) → unsubscribe

desktop/shell-compose.cjs
  askModel() 改为：生成 turnId → 订阅 → 渲染 pending/streaming → done 落库
desktop/shell-stream.cjs
  渲染 pending/streaming 气泡、光标、停止/重试按钮、「已停止」徽章
```

`ask()`（非流式）保留：Playbook、补丁、图谱仍用它，避免一次改所有调用方。

## 9. 验收

**单元（注入假 stream）**

- 事件顺序：`turn-start → delta* → turn-done`；乱序/未知类型被忽略。
- 重复 `turnId` 的迟到事件被丢弃；`abort` 后只接受 `turn-aborted`。
- 增量合并：40–60ms 合并、单事件 ≤ 4KB；`done.text` 覆盖累积值。
- 空回答 → `empty-answer`；超 8k → 截断标记。

**端到端（`OWNER_AGENT_CHAT_FAKE_STREAM=1`，假流不调真模型）**

- 首字在 500ms 内可见；发送按钮在流式中变「停止」。
- 点停止 → 气泡保留已输出部分 + 「已停止」+ 重试可再次发送。
- 429 / no-model → 各自的文案与按钮；错误消息可复制。
- 流式中切到另一个会话 → 原会话出现活动点；回来后内容完整；落库在正确的会话。
- 流式中重启窗口 → 没有半截助手消息（用户消息还在）。

## 10. 实施顺序

1. `PiChatService.askStream` + 假流注入 + 单元测试（不改界面）。
2. main/preload 的事件通道与 `abort`。
3. `shell-stream` 的 pending/streaming 渲染与停止按钮。
4. 错误分类与重试。
5. e2e 假流验收；再用手动真模型跑一次（不写真实库）。
