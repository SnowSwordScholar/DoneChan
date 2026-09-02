<div align="center">

# DoneChan

**让 AI 亲手告诉你：任务做完了。**
**The AI tells you itself: the task is done.**

通过 Server酱³ 把任务完成通知推到手机，通知内容由 AI 自己定义。
Push task-done notifications to your phone via ServerChan³ — with content
defined by the AI itself.

支持 / Works with: **ZCode · Codex · Claude Code**

[![CI](https://github.com/SnowSwordScholar/DoneChan/actions/workflows/ci.yml/badge.svg)](https://github.com/SnowSwordScholar/DoneChan/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)](package.json)

</div>

---

## 为什么是 DoneChan / Why DoneChan

现有的 agent 通知工具只会喊"任务完成了"，至于做完了**什么**、有没有风险，你得回电脑
自己看。DoneChan 反过来：AI 完成任务时，在回复末尾用一条隐藏标记写下它想告诉你的话，
DoneChan 把这句话推到你手机上。不调第二次 LLM、不要额外的 API Key。

Existing notifier tools can only say "task finished" — what was *done* and
whether anything needs attention still requires walking back to the computer.
DoneChan flips it: when the AI finishes a task it writes a hidden marker into
its final reply saying what it wants you to know, and DoneChan pushes that to
your phone. No second LLM call, no extra API key.

> 社区项目，与 ZCode / OpenAI / Anthropic 官方无关。
> Community project, not affiliated with ZCode, OpenAI, or Anthropic.

## 工作原理 / How it works

```
AI 回复最后一行 …            … last line of the AI reply
<!--donechan: {"title": "✅ 登录模块完成", "desp": "测试全绿"}-->
        │ agent 的 Stop 钩子触发              │ agent fires its Stop hook
        ▼                                     ▼
donechan hook  ──解析标记──►  Server酱³  ──►  📱 手机 / phone
（stdin/argv 自动识别 agent）  (no marker? 模板兜底 fallback template)
```

三层内容策略 / Three-layer content strategy:

1. **标记协议** / **Marker protocol** — AI 用 `<!--donechan:{...}-->` 定义标题和正文（首发卖点）。
2. **模板兜底** / **Template fallback** — AI 忘了写标记时，取回复首行生成通知，保证永远有通知。
3. **LLM 摘要** / **LLM summary** — 远期可选，用额外 API Key 生成摘要。

## 安装 / Install

```bash
npm install -g donechan      # 或 / or: git clone + npm i + npm run build
```

配置 SendKey（在 [sc3.ft07.com/sendkey](https://sc3.ft07.com/sendkey) 获取）/
Configure your SendKey:

```bash
donechan login sctp12345tXXXXXXXXXXXXXXXX
donechan send "hello"        # 手机收到即成功 / you should receive it now
```

> 也支持旧版 Server酱 Turbo（`SCT` 开头的 Key），自动路由。
> Legacy ServerChan Turbo keys (`SCT…`) are auto-routed too.

## 接入 agent / Wire up your agent

**最省事：让 AI 帮你装 / Easiest: let your AI agent install it**
（面向 agent 的仓库设计 / this repo is designed to be agent-readable）：

```text
克隆 https://github.com/SnowSwordScholar/DoneChan，按它的 README 把 donechan
接入你的 Stop 钩子，再把 skills/donechan-notify 装成技能。
```

**手动 / Manual** — `donechan install <agent>` 会打印含绝对路径的现成配置：

| Agent | 做什么 / What to do |
|---|---|
| ZCode | 把输出合并进 `~/.zcode/cli/config.json`；或直接用 `adapters/zcode/plugin/` 插件（钩子自动启用） |
| Codex | 把输出写入 `~/.codex/hooks.json`（首次加载需信任确认）；老版本用 `adapters/codex/notify.toml` |
| Claude Code | 把输出合并进 `~/.claude/settings.json` |

接入标记协议 / Teach the AI the marker protocol — 把
[`skills/donechan-notify/SKILL.md`](skills/donechan-notify/SKILL.md)
装为 agent 技能，或把其中内容贴进 `AGENTS.md`。从此 AI 完成任务时自动定制通知。

## 让 AI 定义通知 / Let the AI define the notification

AI 在回复末尾追加（DoneChan 会把这条注释隐藏掉、内容原样推送）/ The AI appends:

```html
<!--donechan: {"title": "✅ 支付回调 bug 已修复", "desp": "**修复**：加幂等校验\n**回归**：12/12 通过\n**风险**：沙箱再验一次", "short": "掉单已修复", "tags": "后端|bugfix"}-->
```

字段 / fields: `title`（必填）· `desp` Markdown 正文 · `short` 卡片摘要 · `tags` 竖线分隔标签。

## CLI / Commands

```
donechan hook              hook 统一入口（stdin 或 argv JSON），fire-and-forget
donechan send [标题]       发送测试通知（-b 正文）
donechan check             校验配置
donechan install <agent>   打印 zcode|codex|claude 接入配置
donechan login <sendkey>   把 SendKey 写入 ~/.donechan/config.json
```

## 配置 / Configuration

| 优先级 / Precedence | 来源 / Source | 说明 / Notes |
|---|---|---|
| 1 | `DONECHAN_SENDKEY` 环境变量 | 临时使用、CI |
| 2 | `<repo>/.donechan/config.json` | 团队共享（勿提交真实 Key）/ team-shared, no real keys |
| 3 | `~/.donechan/config.json` | 个人默认 / personal default |

```json
{ "sendkey": "sctp12345t...", "title_prefix": "[DoneChan]", "tags": "dev" }
```

## 故障排查 / Troubleshooting

| 症状 / Symptom | 处理 / Fix |
|---|---|
| 收不到推送 / no push | `donechan check` + `donechan send t`；确认 Key 以 `sctp` 或 `SCT` 开头 / key must start with `sctp` or `SCT` |
| ZCode 里不触发 / not firing in ZCode | 配置文件钩子必须 `"enabled": true`（插件形态自动启用）/ config-file hooks need `enabled: true` |
| Codex 提示信任 / Codex trust prompt | 预期行为，确认前读一眼命令 / expected; review the command before trusting |
| AI 忘写标记 / AI forgets the marker | 模板兜底仍会推送；把 skill 装上提高命中率 / fallback still notifies; install the skill |

## 参与贡献 / Contributing

欢迎 PR！先读 [CONTRIBUTING.md](CONTRIBUTING.md)（含架构说明与三条铁律：
不阻塞 agent、不泄露 Key、适配器只放配置）。
PRs welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) first (ground rules:
never block the agent, never leak the key, adapters are config-only).

## License

[MIT](LICENSE) © DoneChan contributors

## 致谢 / Acknowledgements

- [Server酱³](https://sc3.ft07.com) — 推送服务 / push service
- 灵感来自 Claude Code / ZCode 生态的 hooks 通知工具 / inspired by hooks
  notifiers in the Claude Code & ZCode ecosystems
