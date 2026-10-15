---
name: ask-a1
description: 读取钉钉 A1 录音卡的「AI 听记」（云端转写全文 + AI 摘要 + 关键词），按需返回原始转写记录或提炼后的纪要总结。当用户提及 钉钉A1 / A1 / 录音 / 听记 / 纪要 / 纪要总结 / 会议记录 / 转写 / 语音笔记 等词，或要求回顾、总结、导出某段录音内容时使用。
user-invocable: true
argument-hint: "[原始 | 总结] [条数/时间/关键词]"
---

# ask-a1 · 钉钉 A1 听记取数与总结

把**钉钉 A1 录音卡**在钉钉云端生成的「AI 听记」拉到本地，按需交付 **原始记录** 或 **总结**。
底层是本技能目录 `scripts/index.js`——单文件、零依赖（仅用 Node 内置 fetch/WebSocket），CLI + HTTP 合一。

## 何时激活

用户提到 **钉钉A1 / A1 / 录音 / 听记 / 纪要 / 纪要总结 / 会议记录 / 转写 / 语音笔记**，
或说「A1 里刚才说了啥」「帮我总结一下今天那段录音」「把最近一次听记原文给我」——即激活本技能。

## 交付形态（先判断用户要哪种）

| 用户意图 | 交付内容 | 数据来源 |
| --- | --- | --- |
| **原始记录** | 逐段转写全文（保留说话人分隔），附标题 / 起止时间 / 时长 | `transcript` |
| **总结** | 结构化纪要：主题 → 要点 → 结论/待办 → 关键词 | `summary` + `keywords` + `transcript` |
| 未指明 | 先给 `summary` + 关键词，再问是否展开全文 | — |

> 若只有一条听记且用户说「总结」，请读完 `transcript` 再总结，不要只转述一句 AI 摘要。

## 前置条件

- **Node.js v22+**——脚本零 npm 依赖，仅用 Node 内置 `fetch` / `WebSocket`
- **Google Chrome 或 Microsoft Edge**——保持钉钉登录态；首次/续期取 token 时需扫码

## 脚本定位

```bash
SCRIPT="<skill目录>/scripts/index.js"    # 常规安装点：~/.claude/skills/ask-a1/scripts/index.js
[ -f "$SCRIPT" ] || \
  SCRIPT="$(find "$HOME/.claude" -name index.js -path '*ask-a1*' 2>/dev/null | head -1)"
node "$SCRIPT" --help                     # 自检
```

- 下文命令一律写成 `node "$SCRIPT" <cmd>`。
- **首次运行会自动生成** `config.json` 与 `data/`（位于 `<skill目录>` 根，即脚本上一级），无需手动初始化。
- **退出码非 0 即失败**：读 stderr 并向用户如实说明，不要臆造结果。

## 取数流程

### ① 探活

```bash
node "$SCRIPT" doctor                   # 看「运行模式 / 登录态 / 存储」
```

- 显示 **`WS 直连（无浏览器）✅`** → 直接进入 ③。
- 显示 **`CDP（浏览器）`**，或提示 token 缺失 / 已过期 → 先执行 ②。

### ② 取 token（约每 30 天一次，**需要用户配合**）

```bash
node "$SCRIPT" fetch-token              # 自动开浏览器 → 用户扫码 → 存 token → 自动关浏览器
```

- **交互步骤**：会打开钉钉登录页并**等待手机扫码**（最长 3 分钟；已登录则自动完成）。
- **执行前必须先告知用户**「请用手机钉钉扫码登录 AI 听记」，不要闷头跑。
- token 存入 `config.json`，有效期约 30 天；之后可完全关闭浏览器。
- 备选（坚持用浏览器模式）：`node "$SCRIPT" up`——拉起 Chrome 调试实例并启动常驻 HTTP 服务。

### ③ 同步 + 取数

```bash
node "$SCRIPT" sync                     # 增量拉取新听记入库（失败自动刷新页面重试一次）
node "$SCRIPT" list --json              # 待处理列表（默认不含转写全文）
node "$SCRIPT" list --full --json       # 待处理列表（含转写全文）
node "$SCRIPT" get <id> --json          # 单条完整详情（含转写全文）
node "$SCRIPT" refresh                  # 回填已有条目的摘要 / 关键词
node "$SCRIPT" consume <id>             # 处理完标记「已消费」
```

- 增量：`list --after <游标> --json`，返回体里的 `after` 即下次游标。
- 默认 `list` 不带全文（省流量）；要全文用 `--full` 或 `get <id>`。

### ④ 交付

- **原始记录**：把 `transcript` 按段落原样呈现（`get <id>` 或 `list --full`），并带上标题 / 时间 / 时长。
- **总结**：读 `transcript` + `summary` + `keywords`，按此结构提炼：

  ```
  主题：一句话概括
  要点：3~6 条
  结论 / 待办：如有
  关键词：...
  ```

- 需要定位某条时，用标题 / 时间 / 关键词在 `list` 结果里匹配出 `id`；有多个相近候选时**先问用户**，不要猜。

## HTTP API（备选，适合常驻服务 / 多次取数）

```bash
node "$SCRIPT" serve --port 8787        # 常驻；启动后按 pollIntervalSec 自动同步
```

```bash
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).apiToken)" "<skill目录>/config.json")
curl -s "http://127.0.0.1:8787/api/ideas?after=0&full=1" -H "Authorization: Bearer $TOKEN"
```

端点：`GET /api/ideas?after=&full=1`、`GET /api/ideas/all`、
`POST /api/ideas/<id>/consume`、`POST /api/sync`、`GET /api/health`（免鉴权）。

## 命令速查

| 命令 | 作用 |
| --- | --- |
| `fetch-token` | 一键登录取/续 token（约 30 天一次，需用户扫码） |
| `doctor` | 环境诊断：模式 / Chrome / 登录 / 存储 |
| `sync [--json]` | 增量同步新听记 |
| `list [--after N] [--limit N] [--json] [--full]` | 列出待处理想法 |
| `get <id> [--json]` | 单条详情（含全文） |
| `consume <id>` | 标记已消费 |
| `refresh [--json]` | 用列表接口回填已有条目的摘要/关键词 |
| `status [--json]` | 状态概览 |
| `serve [--port N]` | 启动 HTTP API 常驻服务 |
| `up [--port N]` | 确保浏览器调试实例在跑（无则拉起）再启动服务 |

## 数据模型（`<skill目录>/data/ideas.json`）

```jsonc
{
  "version": 1,
  "nextId": 2,
  "items": [
    {
      "id": 1,
      "uuid": "…",
      "title": "…",
      "startTime": 1690000000000,      // 毫秒时间戳（Asia/Shanghai 展示）
      "durationMicros": 0,             // 时长，微秒
      "transcript": "逐段转写全文（相邻重复段落已自动合并）",
      "summary": "AI 摘要",
      "keywords": ["…"],
      "status": "pending",             // pending | consumed
      "createdAt": 1690000000000,
      "consumedAt": null
    }
  ]
}
```

兜底：实在取不到数据时，可直接读 `<skill目录>/data/ideas.json`（CLI 与 HTTP 共享同一份）。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| doctor 提示「无 token / 已过期」 | 跑 `fetch-token`（需用户扫码） |
| 连续同步失败 ≥ 3 次告警 | 检查钉钉登录态；CDP 模式下确认浏览器调试窗口还开着 |
| CDP 模式报「未找到 shanji 页面」 | 重跑 `up`（或 `fetch-token`），保持窗口打开 |
| 列表拉取失败 | 已内置「自动刷新页面重试一次」；仍失败则看 `doctor` |
| API 端口冲突 | `serve --port <其它端口>` |
| WS 直连验证失败 | token 已保存，用 `doctor` 排查；必要时重跑 `fetch-token` |

## 边界与注意

- 脚本复用钉钉**网页版内部接口**（非官方公开 API），字段可能随版本变化；已做宽匹配容错。
- 数据**本机私有**（含主人的语音转写内容）；`config.json` 与 `data/` 已被 `.gitignore` 忽略，勿提交或外传。
- `fetch-token` 是**需要用户配合**的交互步骤，务必先提示再执行。
