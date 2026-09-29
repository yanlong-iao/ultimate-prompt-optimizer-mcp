# 自定义优化模板

把 `.md` 文件放在这个文件夹里，就会出现在 `list_templates` 中，并可以用作 `optimize_prompt_via_api` 的 `template` 参数。
同 id 会覆盖内置模板；修改后 5 秒内生效，不用重启。

```markdown
---
id: my-house-style
type: optimize-system        # optimize-system | optimize-user | iterate
name: 我的风格
description: 这个模板适合什么场景
---
# Role: Prompt Engineer
（这里写你的优化指令）
待优化的提示词会以 JSON 形式给到模型（字段 originalPrompt；iterate 模板还有 lastOptimizedPrompt、requirements）。
要求：只输出优化后的提示词。
```

也支持 `.json` / `.yaml`：`{ id, type, name, description, messages: [{role, content}] }`，
content 里可用 `{{evidence}}`、`{{originalPrompt}}`、`{{lastOptimizedPrompt}}`、`{{requirements}}`。
