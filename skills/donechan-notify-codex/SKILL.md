---
name: donechan-notify-codex
description: Codex 专用 DoneChan 输出适配：使用不可见 Markdown 链接承载完成通知
---

# Codex DoneChan 通知协议

这是 Codex 专用的完整 skill。它独立于其他 Agent 的 `donechan-notify` skill，避免
Codex 同时看到两种互相冲突的输出格式。

当本轮完成用户明确交办的重要任务时，只在回复最后一行追加下面的隐藏链接；纯问答、
等待输入或任务未完成时不要追加。

通知 JSON 字段与其他 Agent 相同：`title`（必填）、`desp`（Markdown 正文）、`short`
和 `tags`（可选）。不要在通知中放密钥或 token。

Codex 会把 HTML 注释显示出来，因此不要输出 `<!--donechan: {...}-->`，也不要输出
反斜杠转义的 HTML 注释。将通知 JSON 编码为 base64url，作为最终回复最后一行的空
Markdown 链接：

`[](donechan://<base64url(JSON)>)`

链接在 Codex 界面中不可见。纯问答、等待输入或任务未完成时不要输出通知。
