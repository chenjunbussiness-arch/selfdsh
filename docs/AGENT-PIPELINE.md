# 多家 agent 串起来干活：流水线和按 token 分额度

日期：2026-11-27。状态：**已实现**，在真 DSH 上跑通（见第 11 节）。依赖已经合进 main 的统一阶段、时间线、问答、审计、指标和超时（协议第 12 节），以及本机 MCP 桥（插件 README 第 8.1 节，PR #18）。

你定下的四条（2026-11-27）：

1. git 提交和推送只给本机 dsh worker；Gemini / Antigravity 只能改代码、跑测试。
2. 测试不过或验收退回，最多自动退回 2 次，用完问你。
3. 额度按 token 算（每家报用量），报不了的按任务数和时长兜底。
4. `agy-mydesk` 从 `coder` 放宽成 `code` + `test`，你在 DSH 里重新批准一次。

## 0. 分工

| 段 | 谁做（按 `can` 派，不写死厂商） | 交出什么 |
|---|---|---|
| 调度 | 云端 DSH。小活它自己做（`tiny` 模板） | 任务和流水线 |
| 方案 `plan` | 能 `plan` 的：Claude Code | `plan.md`、`acceptance.md` |
| 干活 `code` | 能 `code` 的：Antigravity / Gemini（或别人） | `changes.patch`（桥从工作区用 git 生成） |
| 测试 `test` | 能 `test` 的，谁先领到谁跑：本机 dsh worker 或 Gemini | `test.log`，summary 第一行"通过 / 不通过" |
| 提交 `commit` | 能 `git` 的：本机 dsh worker | 分支 `pipeline/<任务号>-r<轮>`，推送，不合并 |
| 验收 `review` | 能 `review` 的，且这条流水线里没写过代码 | `review.md`，第一行"通过 / 退回" |
| 通知 | hub → 发布任务的那台 DSH | 作战室：每段一行，最后一条汇总 |

加一家（Codex、opencode……）只写配置和注册，不改 hub 和插件的代码。

## 1. 能力授权 `can`

- 可选值：`plan`、`code`、`test`、`git`、`cmd`、`review`。任务的 `needs` 必须全部落在领活人的 `can` 里，否则领不到，派单时直接说为什么。
- 老的 `role` 还在，当预设：`coder` = `[code]`，`tester` = `[test]`，`worker` = `plan, code, test, git, cmd`（不含 `review`），`dispatcher` / `observer` 不领活。没写 `can` 的 agent 行为不变。
- 写在 `agents/<id>.json`：`"can": ["code", "test"]`，注册时带上；DSH 批准时 `agent_approve` 可以再收窄（`can` 参数）。
- 已批准的 agent 要改：`agent_client.py regrant --agent <id> --can code,test`。收窄立刻生效；放宽要 DSH 批准（`agent_requests` 里是一条 `change` 请求，`agent_approve` 批）。
- 桥在 `next_task` 里按 `can` 把规矩写给 agent（`task.local.rules`）。

## 2. 流水线模板

内置三条，`hub.json` 的 `pipelines` 可以按名字加或覆盖：

```json
"pipelines": {
  "feature": [
    "plan",
    { "stage": "code", "prefer": ["agy-mydesk"] },
    { "stage": "test", "prefer": ["online"] },
    { "stage": "commit", "prefer": ["dsh-mydesk"] },
    { "stage": "review", "prefer": ["cc-mydesk"] }
  ]
}
```

- 内置：`feature` = plan → code → test → commit → review；`small` = code → test → commit → review；`tiny` = self（DSH 自己做）。
- 一段可以只写名字（用内置含义），也可以写对象：`needs`、`prefer`（agent id 的先后，或 `online`）、`required`（必须交的文件）、`verdict`（`test` / `review`）、`bounceTo`、`maxBounces`、`excludeAuthors`、`label`、`guide`（额外说明）。
- 派活：DSH 的 `task_dispatch` 带 `pipeline: "feature"`，可选 `verify`（测试命令，例如 `python3 -m unittest -q`）和 `max_bounces`（0..10，默认 2）。不带 `pipeline` 就是原来的单个任务。
- hub 建一个父任务（不派给任何人），每段到了才建子任务（`<父>.plan`、`<父>.code-r2`……），上一段的产出自动当下一段的输入。调度台和作战室里父任务显示成 `方案 ✓ → 干活 ✱ → 测试 ○ …`，第二轮起带"（第 N 轮）"。

## 3. 段和段之间

| 段 | 必须交 | 结论怎么写 |
|---|---|---|
| plan | `plan.md`、`acceptance.md` | |
| code | `changes.patch` | |
| test | `test.log` | summary 第一行：`通过` / `不通过`（可跟失败条数） |
| commit | （分支名写在 summary） | |
| review | `review.md` | 第一行：`通过` / `退回`，后面逐条意见 |

- 缺了必须交的文件，或测试、验收没写结论，hub 不收（400，错误里说缺什么），agent 补交。
- 用本机桥的 agent，`changes.patch` 由桥从工作区用 git 生成，开头写着 base 提交；agent 自己手写了一份也会被换成工作区的真改动（工作区没改动时才留它自己的）。
- 测试段先在 base 上 `git apply` 补丁再跑 `verify`；提交段从 base 开分支，提交一次，推送，不合并。

## 4. 退回和上限

- 测试"不通过"或验收"退回"：从 code 段起新开一轮，上一轮的 `test.log` / `review.md` 和补丁一起当输入。
- 最多退回 `max_bounces` 次（默认 2）。用完父任务进"需要你回答"，作战室里直接回答（`task_answer`）：
  - `再来一轮`：再给一轮；
  - `换人`：重做这一段，排除上次做的人；
  - `跳过这一段` / `重做这一段`：用于某段卡住时；
  - `到此为止`：停下，没做完的段取消；
  - 别的话：当成修改意见，带给下一轮干活的人。
- 某段没人能接（都不在线、都超额度、都被排除），父任务同样停下来问你。

## 5. 验收不能自己审自己

- hub 记下这条流水线里每个 code 段的执行人，review 段把他们排除（`declined`）。
- 同一个 Claude Code 可以出方案又验收，只要代码不是它写的。如果它顶上写了代码，这一轮验收换人；没人能验收就问你，兜底给 DSH 时也一样排除。

## 6. 额度：按 token

```json
"quota": {
  "utcOffsetMinutes": 480,
  "warnAt": 0.8,
  "agents": {
    "agy-mydesk": { "tokensPerDay": 3000000, "costPerDay": 5 },
    "cc-mydesk":  { "tokensPerDay": 2000000, "tasksPerDay": 30, "minutesPerDay": 480 },
    "dsh-mydesk": { "tasksPerDay": 100 }
  }
}
```

- 每个 agent 每天一份，"一天"从 `utcOffsetMinutes` 所在时区的零点算（480 = 北京时间）。四种上限可以任意组合：`tokensPerDay`、`costPerDay`（美元）、`tasksPerDay`、`minutesPerDay`。
- token = 输入 + 输出 + 写缓存；读缓存单独记，不算进额度（便宜）。报了 `total_tokens` 就用它。
- 到 `warnAt`（默认 80%）作战室提醒一次；用满再提醒一次，从那一刻起它不再领新活（`next_task` 拿不到、runner 不启动），它能做的段换下一个能做的人，没人就问你。
- 调度台 `agent_list` 每个 agent 带 `usage_today`（tokens、cost、tasks、minutes、`usage_reported`）和 `quota`；`task_metrics` 带 `usage_today`；每个任务带自己的 `usage`。

### 哪些 agent 能报 token

| agent / 运行方式 | 能报吗 | 从哪里来 |
|---|---|---|
| Claude Code，runner 跑 `claude -p --output-format json` | **能，已实测** | 结果 JSON 的 `usage` 和 `total_cost_usd`，runner 读出后报给 hub（`POST /v1/usage`） |
| Antigravity / Gemini CLI，runner 跑 `--output-format json` | 应该能，**未实测** | Gemini CLI 的 `stats.models.*.tokens`（runner 已能解析）；`agy` 的 JSON 据说带 `usage`，到你机器上第一次跑时看 `usage_reported` |
| Codex，runner 跑 `codex exec --json` | 应该能，**未实测** | `turn.completed` 事件里的 `usage`（runner 已能解析，会把多条加起来） |
| opencode | 未知 | 有 JSON 输出就能接；没有就按下一行处理 |
| 任何 agent 自己在 `submit_result` 里带 `usage` | 能 | 交结果时附上 |
| 在 IDE 里由人叫起来的 agent（交互模式） | **不能** | IDE 不把用量给出来 |
| 本机 dsh worker（`agent_client.py run`） | 不报 | 它自己不花模型 token |

报不了的 agent：token 和花费那两条上限对它不起作用（因为一直是 0），只有 `tasksPerDay` / `minutesPerDay` 能管住它；它的 `usage_today.usage_reported` 是 `false`，你一眼能看出来。所以给它配额度时请写任务数或时长。

## 7. 接入方式

| 接法 | 适合 | 状态 |
|---|---|---|
| 本机 MCP 桥 `mcp_bridge.py` | 有 MCP 的 agent：Antigravity、Claude Code、Codex、opencode | 已做（PR #18） |
| 无界面 runner `agent_runner.py` | 同一批 agent 的命令行版，无人值守，能报 token | 已做 |
| 常驻客户端 `agent_client.py run` | 本机 DSH worker | 已有 |

**runner**：`agents/<id>.json` 加一段：

```json
"runner": {
  "every": 120,
  "timeout": 3600,
  "command": ["claude", "-p", "{prompt}", "--output-format", "json",
              "--mcp-config", "/path/to/mcp.json", "--permission-mode", "acceptEdits",
              "--allowedTools", "mcp__dsh-hub,Read,Glob,Grep,Edit,Write"],
  "cwd": "{workspace_path}"
}
```

- 每 `every` 秒：心跳，然后问 hub 有没有它能领的活（`GET /v1/peek`，不领活、不花模型额度）。没有就什么都不启动；超额度也不启动。
- 有活才启动 CLI，提示词固定（让它调 `next_task`、按 `task.local.rules` 做、交 `submit_result`）。占位符：`{prompt}`、`{workspace_path}`、`{agent_id}`、`{tasklog}`。
- 跑完从 CLI 的 JSON 输出里读 token，报给 hub，记到这次领的任务上（桥把领到的任务号写进 `DSH_BRIDGE_TASKLOG`）。
- 心跳里声明 `pull_every_seconds`，hub 就知道它是"按时来领"的，不会把它算成离线。
- 换一家只改 `command`：Antigravity 换成 `agy -p {prompt} --output-format json …`，Codex 换成 `codex exec --json {prompt} …`。
- 运行：`python3 agent_runner.py --agent cc-mydesk`（一直跑），`--once` 只跑一次。

**接入合同**（每家一样）：注册自己的身份并声明 `can`；只用那五个 MCP 工具；做完交本段必须交的文件；做不了 `release_task`；拿不准 `submit_result` 的 `partial` + `needs_input` 问人。

## 8. 新接口

| 接口 | 谁调 | 做什么 |
|---|---|---|
| `GET /v1/peek` | worker | 现在有几个它能领的活（只看不领），是否超额度 |
| `POST /v1/usage` | worker | 报一次运行的用量：`{ usage: {input_tokens, output_tokens, …, cost_usd}, task_ids }` |
| `POST /v1/regrant` | worker | 要改自己的 `can` / `role`：收窄立刻生效，放宽等 DSH 批准 |
| `submit_result` 的 `usage` | worker（MCP / HTTP） | 交结果时一起报用量 |

## 9. 你要做的（装到自己机器上）

1. 合并 #18，再合并这个 PR；拉 main，重启 hub 和每台 DSH。
2. `hub.json` 加 `quota`（和需要时的 `pipelines`），重启 hub。
3. 每个 agent 的 `agents/<id>.json` 写上 `can`：`agy-mydesk` 写 `["code", "test"]`，`cc-mydesk` 写 `["plan", "review", "code"]`，`dsh-mydesk` 不用写（worker 预设）。已批准的跑一次 `agent_client.py regrant --agent agy-mydesk --can code,test`，然后在 DSH 里 `agent_approve` 批这条 `change`。
4. 想无人值守就给 agent 加 `runner` 段，跑 `agent_runner.py --agent <id>`（用 systemd 或计划任务常驻）。CLI 要先交互登录一次，headless 下要放行 dsh-hub 的 MCP 工具。

## 10. 还没做的

- 调度台把父任务画成可点开的段落条（现在是一行文字 `方案 ✓ → 干活 ✱ …`，每段的产出在子任务里看）。
- `agy`、`codex`、opencode 的 token 解析只按文档写了，没在真机上跑过。

## 11. 真机测试（2026-11-27）

一台 hub（TLS）、一台真 DSH（插件从仓库加载）、三个 agent：`cc-mydesk`（真 claude，runner）、`agy-mydesk`（用 claude 扮演，走同一个桥和 runner，`can: [code, test]`）、`dsh-mydesk`（本机 worker，真跑 unittest 和 git）。演示仓库有一个本地 bare 远端。

1. **feature 跑通**：DSH 派 `pipeline: feature`。cc 出方案（20,715 token，$0.24）→ agy 改代码（17,431 token）→ dsh 跑测试"通过" → dsh 开 `pipeline/pf1-r1` 提交并推送 → cc 验收"通过"。父任务完成，五个产出都挂在父任务上，作战室每段一行，最后一条汇总带分支名。
2. **退回和换人**：`small` 流水线，第一轮故意写错（减法写成加法）→ 测试真跑"不通过：1 条失败" → 自动退回第 2 轮。此时 agy 当天 token 超了 20,000 的测试额度：runner 不启动它（`why: quota`），桥里 `next_task` 拿不到，干活段换别人做，测试通过、提交、cc 验收通过（cc 没写过这条流水线的代码）。
3. **到上限问你**：`max_bounces: 0`，测试不过 → 作战室"需要回答：……回答：再来一轮 / 换人 / 到此为止" → 在 DSH 里回答"到此为止" → 流水线停下，没做的段取消。
4. 真测时发现并修了三处：agent 手写的补丁会被留下（改成换成工作区的真 diff）；额度用满的提醒和同一任务的"完成"在一次读取里被合并吞掉（改成额度提醒单独一行）；段摘要第一行以冒号结尾时被截断（接上后面几行）。
5. 单元测试：hub 202 个、DSH 插件 168 个、Python 脚本新增的全过（`worker_executor` 原有的 12 个失败与本次无关）。
