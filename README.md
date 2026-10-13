# refwright-mcp

**中文** | [English](./README.en.md)

> 让 AI Agent **又快又准**地操作浏览器的 MCP 服务器：基于 Playwright 与 ARIA 无障碍快照，提供 ref 精确定位、智能等待和增量快照。

---

## 为什么需要它

让 AI 操作浏览器时，真正决定"快不快"的往往不是浏览器本身，而是 **AI 要来回多少轮、每轮要读多少内容**。一轮模型推理通常要好几秒，而一次点击只要几十毫秒。常见方案在这两点上都有明显短板：

| 常见做法 | 问题 | refwright-mcp 的做法 |
|---|---|---|
| 把整页 HTML 交给模型 | 几万 token 的 DOM、SVG、内联样式，又贵又干扰判断 | 输出精简的 **ARIA 语义树**：只有角色、可访问名称、状态等关键信息 |
| 截图 + 视觉模型点坐标 | 慢、贵，小字看不清，坐标容易点偏 | 语义定位为主；只有 Canvas、小游戏这类场景才用坐标 |
| 按 role + name 去"猜"元素 | 一页里有十个「删除」按钮时，只能点第一个，容易误操作 | 快照里每个元素都带 **`[ref=e12]`**，按 ref 点击，精确命中那一个 |
| 操作后固定 sleep | 等短了拿到旧页面，AI 误以为没生效而重试；等长了白白浪费时间 | **智能等待**：只等这次操作真正触发的跳转、请求和 DOM 变化，最多 1.5 秒 |
| 每步都返回整页快照 | 页面一大，几步就把上下文撑满，模型越读越慢 | **增量快照**：只返回变化的部分，再附上被删除的节点 |

一句话：**少走回合、少读 token、不点错**。这三点决定了 Agent 操作浏览器的实际速度。

### 实测（本地测试页面）

| 场景 | 耗时 | 返回内容 |
|---|---|---|
| 页面没有变化的普通点击 | ~130 ms | `(no changes since the previous snapshot)` |
| 点击后接口 400 ms 才返回 | ~550 ms | 快照里已经包含接口返回的数据 |
| 页面上有每 50 ms 跳动一次的计时器 | ~140 ms | 不会因为页面持续变化而等满上限 |
| 删除列表中的一行 | ~140 ms | 4 行增量结果，并注明删除的是哪一行 |

### 增量快照长什么样

首次打开页面时返回完整快照，每个元素都带 ref：

```yaml
- generic [ref=e1]:
  - list [ref=e3]:
    - listitem [ref=e4]:
      - text: Alice
      - button "删除" [ref=e5]
    - listitem [ref=e6]:
      - text: Bob
      - button "删除" [ref=e7]
  - button "Load data" [ref=e8]
```

调用 `browser_click({ ref: "e7" })` 之后，只返回变化的部分：

```yaml
- generic [ref=e1]:
  - list [ref=e3]:

Removed:
- listitem [ref=e6]: Bob | button "删除" [ref=e7]
```

没有出现在增量结果里的节点都没有变化，它们的 ref 依然有效。

---

## 核心特性

- 🔖 **ref 精确定位**：快照里的 `[ref=eN]` 可以直接传给 click / fill / select / check / hover。iframe 内的元素同样支持。ref 失效时会立即报错，并提示改用最新快照里的 ref，不会卡到超时。
- ⏱ **智能等待**：动作执行后依次等待：它触发的页面跳转完成、它发出的 fetch/XHR 请求全部返回、DOM 连续 100 ms 没有结构性变化。纯文本变化和 style 动画（时钟、行情、轮播）不会拖慢等待。
- ✂️ **增量快照**：动作类工具只返回变化的节点、它们的上级节点，以及被删除的节点。页面跳转后，或者增量结果不比完整快照小多少时，自动改回返回完整快照。
- ⚡ **脚本批处理**：`browser_run_script` 可以把多步确定的操作放进一次调用完成，省掉多轮往返。
- 🎯 **语义定位 + 坐标定位**：普通页面按语义或 ref 操作，Canvas、小游戏、滑块验证等场景支持坐标点击和拖拽。
- 🧭 **自带使用策略**：服务端通过 MCP `instructions` 告诉接入的 Agent 如何高效使用这些工具，任何 MCP 客户端都会收到。
- 🚀 **复用本机 Chrome**：依赖 `playwright-core`，自动检测本机安装的 Chrome，不需要额外下载浏览器；自动读取系统代理。
- 📑 **多标签页**：自动接管弹出的新标签页并切换过去，支持列出、切换、关闭标签页。

---

## 快速开始

需要 **Node.js ≥ 20**，以及本机安装的 Google Chrome 或 Chromium。

```bash
git clone https://github.com/DBAAZzz/refwright-mcp.git
cd refwright-mcp
pnpm install
pnpm run build
```

构建产物在 `dist/index.js`。下面配置里的 `/absolute/path/to/refwright-mcp` 请替换为你本地的实际路径。

### Claude Code

```bash
claude mcp add refwright -- node /absolute/path/to/refwright-mcp/dist/index.js
```

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "refwright": {
      "command": "node",
      "args": ["/absolute/path/to/refwright-mcp/dist/index.js"]
    }
  }
}
```

### Cursor / Windsurf / Antigravity 等

在对应客户端的 MCP 配置中加入相同的 `command` 和 `args`。例如 Antigravity 的配置文件是 `~/.gemini/antigravity/mcp_config.json`，格式同上。

---

## 工具列表

| 工具 | 主要参数 | 说明 |
|---|---|---|
| `browser_open` | `url`、`new_tab` | 打开网址，返回完整快照。同源页面会复用已有标签页 |
| `browser_snapshot` | — | 获取当前页面的完整快照（带 ref）和标签页信息 |
| `browser_click` | `ref`、`role`、`name`、`text`、`label`、`selector`、`testId`、`exact`、`x`、`y`、`double_click`、`skip_snapshot` | 点击元素或坐标 |
| `browser_fill` | `value`、`ref`、`role`、`name`、`label`、`placeholder`、`selector`、`press_enter`、`skip_snapshot` | 填写输入框，可选填写后按回车 |
| `browser_select` | `value`、`ref`、`name`、`label`、`selector`、`testId`、`skip_snapshot` | 选择下拉框选项 |
| `browser_check` | `checked`、`ref`、`name`、`label`、`selector`、`testId`、`skip_snapshot` | 勾选或取消勾选复选框、单选框 |
| `browser_hover` | `ref`、`role`、`name`、`text`、`selector`、`testId`、`x`、`y`、`skip_snapshot` | 悬停，用于触发下拉菜单、提示框 |
| `browser_press` | `key`、`skip_snapshot` | 按键，如 `Enter`、`Escape`、`Tab`、`ArrowDown` |
| `browser_scroll` | `direction`（`up`/`down`/`top`/`bottom`）、`amount`、`skip_snapshot` | 滚动页面 |
| `browser_drag` | `start_x`、`start_y`、`end_x`、`end_y`、`steps`、`skip_snapshot` | 按坐标拖拽，用于滑块、拼图、Canvas |
| `browser_set_viewport` | `width`、`height` | 设置视口尺寸（320–3840 × 320–2160） |
| `browser_screenshot` | `full_page`、`save_path` | 截图（PNG），可选保存到本地 |
| `browser_evaluate` | `script` | 在页面上下文中执行 JavaScript |
| `browser_run_script` | `script` | 在 Node 端执行 Playwright 脚本，一次调用完成多步操作。可用变量：`page`、`context`、`browser`、`tabId`、`getSnapshot`、`getByRef`、`getByRole`、`getByText`、`getByTestId`、`locator`、`click`、`fill`、`evaluate`、`delay`、`screenshot` |
| `browser_tabs` | `action`（`list`/`switch`/`close`）、`tab_id` | 管理标签页 |

**定位优先级**：`ref` > `selector` > `testId` > `role`+`name`/`text` > `label` > `placeholder` > `text` > `role`。

**`skip_snapshot: true`**：动作执行完立即返回，跳过等待和快照。适合不需要看结果的中间步骤。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BROWSER_HEADLESS` | `false` | 默认显示浏览器窗口，方便观察 Agent 操作；设为 `"true"` 使用无头模式 |
| `CHROME_PATH` | 自动检测 | 指定 Chrome / Chromium 可执行文件路径 |
| `BROWSER_PROXY` | 自动检测 | 指定代理；未设置时依次读取 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY` 和 macOS 系统代理 |
| `ARIA_SETTLE_MAX_MS` | `1500` | 动作执行后最多等待多久 |
| `ARIA_SETTLE_QUIET_MS` | `100` | DOM 连续多久没有结构性变化才算稳定 |
| `ARIA_NAV_SETTLE_MAX_MS` | `3000` | `browser_open` 在 DOMContentLoaded 之后最多再等待多久 |

---

## 安全提示

这个服务器面向**本地、受信任**的 Agent 使用，请了解以下行为：

- `browser_run_script` 会在 **Node 宿主进程**中执行任意代码，权限等同于运行 MCP 的本机用户。
- `browser_screenshot` 的 `save_path` 可以写入任意路径。
- 页面弹出的 `alert` / `confirm` / `prompt` 对话框会被**自动确认**，结果会显示在下一次快照中。

如果 Agent 会浏览不受信任的网站，请注意网页内容可能对 Agent 进行提示注入，诱导它调用上面这些能力。

---

## 开发

```bash
pnpm run build   # 编译 TypeScript 到 dist/
pnpm test        # 编译并运行测试（端到端测试需要本机 Chrome）
```

项目结构：

```
src/
├── index.ts      # MCP 服务入口：注册工具、下发使用策略
├── tools.ts      # 工具定义（zod schema）与分发
├── browser.ts    # 浏览器与标签页管理、定位、快照
├── settle.ts     # 智能等待：跳转 / 请求 / DOM 稳定性检测
└── snapshot.ts   # 增量快照对比
test/
├── snapshot.test.mjs  # 增量对比单元测试
└── e2e.test.mjs       # 真实浏览器端到端测试
```

## License

[MIT](./LICENSE)
