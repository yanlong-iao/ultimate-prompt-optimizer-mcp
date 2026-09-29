# 与 LangGPT / prompt-optimizer / promptfoo / DSPy 的对比（v0.2.0）

> 对比基于各项目当前源码与文档（2026-09）：linshenkx/prompt-optimizer `develop`、langgptai/LangGPT、promptfoo/promptfoo、stanfordnlp/dspy。
> 本项目只借鉴方法，所有模板与代码均为独立编写（prompt-optimizer 为 AGPL-3.0，未复制其文本）。

## 1. prompt-optimizer（提示词优化）

| 能力 | 原版 | v0.1 | v0.2（现在） |
|---|---|---|---|
| 优化模板 | 系统：通用 / 带输出格式 / 深度分析；用户：基础 / 专业 / 分步规划；迭代模板 | 1 套 | ✅ 8 个内置模板：`langgpt-strict`、`general`、`output-format`、`analytical`、`user-basic`、`user-professional`、`user-planning`、`iterate` |
| 把待优化提示词包成 JSON "证据"，防止模型直接执行/回答它 | ✅ | ❌ | ✅ 所有模板统一的"数据≠任务"规则 |
| 迭代时同时参考原稿 + 上一版 + 需求，附正反例 | ✅（实际 MCP 里把同一段传两次） | 部分 | ✅ 真正传入 original / lastOptimized / requirements |
| `{{变量}}` 保护 | ✅ 提示模型自检 | ❌ | ✅ 提示 + **代码校验**，丢了自动修复 |
| 自定义模板 | ✅ 网页里编辑 | ❌ | ✅ `custom-templates/*.md`，同 id 覆盖内置，热加载 |
| 提示词设计评分（不运行） | ✅ 5 维 + patchPlan | ❌ | ✅ `analyze_prompt`：5 维评分、问题、建议、精确补丁（可自动应用）、按分析重写 |
| 结果评估 / 对比评估 | ✅ 单结果 4 维、A/B 成对判断 | 部分 | ✅ `prompt-compliance` 评分器（4 维 + 违规清单）、成对判断（交换位置消除偏差） |
| 历史版本 | ✅ 浏览器本地 | ❌ | ✅ `prompt_history`，每次运行所有版本存 JSON |
| 图片提示词、多轮上下文模式、网页 UI、浏览器插件 | ✅ | ❌ | ❌ 不做（MCP 场景用不上） |

## 2. LangGPT（结构规范）

| 能力 | 原版 | v0.1 | v0.2 |
|---|---|---|---|
| 新版 Goal（Outcome / Done Criteria / Non-Goals） | ✅ | ❌ 旧版 Goals 列表 | ✅ 默认 `style: v2` |
| Skill-1/Skill-2 子章节、Rules | ✅ | ❌ | ✅（`classic` 风格仍可选） |
| Commands（/help 等）、Reminder、Examples | ✅ | 只有 Examples | ✅ 可选开启 |
| `<Role>` `<Rules>` 等引用一致性 | 规范要求 | ❌ | ✅ 检查"引用了不存在的章节"并自动修复 |
| 弱模型简化 | 建议 | ❌ | ✅ `targetModel: weak` |
| 结构严格性 | 靠人/模型自觉 | ✅ JSON→渲染 | ✅ 同上 + 中英文章节别名识别 |

## 3. promptfoo（评测）

| 能力 | 原版 | v0.1 | v0.2 |
|---|---|---|---|
| 断言数量 | 60+ | 9 | ✅ 24 种常用：equals、contains、icontains、contains-any/all、icontains-any/all、starts-with、regex、is-json/contains-json（JSON Schema）、javascript、levenshtein、latency、cost、min/max-length、is-refusal、llm-rubric、g-eval、factuality、answer-relevance、prompt-compliance、assert-set |
| `not-` 取反、weight、metric、transform、threshold、assert-set | ✅ | ❌ | ✅ |
| YAML 配置（prompts / providers / tests / defaultTest）、`file://`、CSV `__expected` | ✅ | ❌ | ✅ 常用子集，见 `examples/` |
| 变量数组 → 笛卡尔积矩阵 | ✅ | ❌ | ✅ |
| 多提示词 × 多模型 × repeat（一致性） | ✅ | 只有 A/B | ✅ 最多 6 个版本 × 4 个模型 × 5 次重复 |
| 结果缓存 | ✅ | ❌ | ✅ 磁盘缓存，重复评测 0 花费 |
| 延迟 / token / 成本统计 | ✅ | 部分 | ✅ 含 p95、预估花费 |
| HTML / JSON 报告 | ✅（网页 viewer） | ❌ | ✅ 自包含 HTML（深浅色）+ JSON |
| 运行前估算调用次数并设上限 | ❌ | ❌ | ✅ 本项目额外做的（超预算直接拒绝，不花钱） |
| 红队攻防、similar（向量相似度）、python/ruby 断言、网页 viewer、CI 集成 | ✅ | ❌ | ❌ 不做：DeepSeek 无 embedding 接口；其余对个人使用价值低 |

## 4. DSPy（用分数驱动优化）

| 能力 | 原版 | v0.1 | v0.2 |
|---|---|---|---|
| 以指标驱动优化，而不是一次性改写 | ✅ 核心理念 | ❌ | ✅ `auto_optimize_prompt` |
| 训练集 / 验证集划分，防过拟合 | ✅ | ❌ | ✅ 候选必须在 dev 集上提升才被接受 |
| 反思失败样例 → 定向修改（GEPA） | ✅ | ❌ | ✅ `reflect` 策略 |
| 生成多条指令候选并搜索（MIPROv2） | ✅ 贝叶斯优化 | ❌ | ✅ 简化版：多策略模板候选 + 束搜索（不做贝叶斯代理模型） |
| 自动挑选好样例做 few-shot（BootstrapFewShot） | ✅ | ❌ | ✅ `fewshot` 策略（0 次额外调用） |
| 无标注数据时自动造测试集 | 需自备 | ❌ | ✅ 自动生成用例 + 每题判分标准 |
| 预算控制 | 手动配置 | ❌ | ✅ 自动缩小搜索以适配 maxCalls，超时/超预算返回当前最优 |
| 多模块程序、模型微调（BootstrapFinetune）、Ensemble | ✅ | ❌ | ❌ 不做：面向的是单个提示词，不是 LLM 程序 |

## 结论
- **单提示词场景**下，常用能力已覆盖到原版水平；缺的主要是 UI、红队、微调、向量相似度这些对个人使用价值低或 DeepSeek 不支持的部分。
- **诚实的差距**：模板质量需要在真实模型上持续验证（离线测试只能验证流程）；MIPRO 的贝叶斯搜索、promptfoo 的大量小众断言没有照搬。
