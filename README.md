# Ultimate Prompt Optimizer — MCP Server（v0.2.0）

一个本地运行的 MCP 服务器，把 **LangGPT 结构 + prompt-optimizer 模板优化 + promptfoo 评测 + DSPy 分数驱动优化** 做进 Claude Desktop / Claude Code。
默认只调用你自己的 OpenAI 兼容模型（如 DeepSeek），不依赖任何外部部署。和原项目的逐项对比见 [COMPARISON.md](COMPARISON.md)。

## 工具一览

| 工具 | 做什么 | API 调用 |
|---|---|---|
| `generate_langgpt_structure` | 一句话想法 → 严格 LangGPT 提示词（新版 Goal/Skill-N/Rules，可选 Commands/Reminder） | 1（template 模式 0） |
| `analyze_prompt` | 不运行，给 5 维评分 + 问题 + 精确补丁；可自动打补丁 / 按分析重写 | 1（重写 +1） |
| `optimize_prompt_via_api` | 用模板库多轮改写：优化 → 按需求迭代；自动修复 LangGPT 结构和 `{{变量}}` | 每轮 1 |
| `evaluate_prompt_preview` | promptfoo 式评测：多版本 × 多模型 × 用例 × 重复，24 种断言、成对判断、HTML 报告 | 运行前估算，超预算拒绝 |
| `auto_optimize_prompt` | DSPy 式：自动造测试集 → 反思/换模板/few-shot 生成候选 → 训练集筛选 → 验证集确认 → 只保留真正变好的 | light 约 40–60 |
| `list_templates` | 查看内置 + 自定义模板 | 0 |
| `prompt_history` | 查看每次运行保存的所有版本 | 0 |
| `optimizer_connection_status` | 检查配置 | 0 |

**省钱机制**：相同请求走磁盘缓存（重复评测免费）；每次工具调用有调用上限（`UPO_MAX_CALLS`，默认 80）；评测会先估算次数，超了直接拒绝。

## 常用说法（在 Claude 里直接说）

- 「用 analyze_prompt 分析我这个提示词，并自动打补丁：……」
- 「用 optimize_prompt_via_api 优化，模板用 output-format，要求：输出必须是 Markdown 表格」
- 「用 evaluate_prompt_preview 对比原稿(A)和优化版(B)，开 pairwise，rubric：是否只出一道题并等待作答」
- 「用 auto_optimize_prompt 自动优化这个提示词，目标：回答简短、先判定对错，预算 light」
- 「用 evaluate_prompt_preview 跑 examples/promptfooconfig.yaml」

## 安装 / 更新

```bash
cd ultimate-prompt-optimizer-mcp
npm install && npm run build      # 更新代码后只需要这一步，然后 Cmd+Q 重启 Claude Desktop
npm run smoke                     # 可选：离线端到端测试（17 组），不花钱
```
首次安装可用 `bash setup.sh`（交互式写 `.env` 并注册到 Claude Desktop / Claude Code）。

## 配置（`.env`）

| 变量 | 说明 |
|---|---|
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 例如 `https://api.deepseek.com` / `sk-…` / `deepseek-flash` |
| `EVAL_MODEL` / `JUDGE_MODEL` | 被测模型 / 评分模型，默认同 `LLM_MODEL`（可让更强的模型当裁判） |
| `LLM_PRICE_INPUT_PER_M` / `LLM_PRICE_OUTPUT_PER_M` | 每百万 token 美元价格，仅用于显示预估花费 |
| `UPO_MAX_CALLS` / `UPO_CONCURRENCY` / `UPO_CACHE` | 调用上限 / 并发 / 缓存开关 |
| `UPO_DATA_DIR` / `UPO_TEMPLATES_DIR` | 历史、报告、缓存目录 / 自定义模板目录 |
| `PO_BASE_URL` / `PO_BACKEND` | 可选：自建 prompt-optimizer（Docker）作为优化后端；留空 + `local` 即可 |

## 文件夹

```
src/
  templates/   内置模板库、自定义模板加载、变量保护
  langgpt/     LangGPT v2/classic 渲染、结构与引用校验、生成器
  analysis/    设计评分 + 补丁、结果评分、成对判断、按分析重写
  eval/        断言引擎、YAML/CSV 配置、矩阵运行器、HTML/JSON 报告
  optimize/    迭代流水线、DSPy 式自动优化
  clients/     LLM 客户端（缓存/计量/预算）、可选 prompt-optimizer 客户端
  tools/       8 个 MCP 工具
examples/      promptfoo 风格配置 + CSV 用例示例
custom-templates/  放你自己的优化模板
history/ reports/ .cache/   运行后自动生成
```

## 安全说明
- `javascript` 断言和 `transform` 在 Node 的 `vm` 中执行，它**不是安全沙箱**——只运行你自己写的测试配置。
- `.env` 含 API Key，不要分享或提交到 git（已在 `.gitignore` 中）。
