# ZCode 插件形态的 DoneChan

把本目录整个放进 ZCode 的插件市场/本地插件目录即可安装。插件钩子会**自动启用**
ZCode 的 hook 运行器，用户无需手动改 `config.json`。

安装前请先完成：

1. `npm install -g donechan`（或克隆本仓库后 `npm i && npm run build`）
2. `donechan login <你的SendKey>`（写入 `~/.donechan/config.json`）
3. 把 `hooks/hooks.json` 里 `<donechan-entry>` 替换为 `dist/cli.js` 的绝对路径
   （全局安装时通常为 `C:\...\\node_modules\\donechan\\dist\\cli.js`）。

`SKILL.md` 让 ZCode 知道 marker 协议，AI 完成任务时会自动在回复末尾追加
`<!--donechan:{...}-->`，通知内容因此由 AI 定义。
