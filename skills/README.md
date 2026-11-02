# Skills

挂载说明：index.js `createSession()` 会把本目录软链到每个用户工作区（`skills/`）。
agent 的 system prompt（session/system-prompt.md，或替换后的 AGENTS.md）中约定：遇到对应任务先读 `skills/<name>/SKILL.md`。

## 当前技能

- `feishu-reply` — 飞书回复格式规范（长度路由、卡片限制、中文口径）
- `attachment-handling` — 图片/文件附件处理流程（Read → URL → analyze_image）
- `community-guide` — 群规则与撤回/踢出原因的问答口径

## 新增技能

1. 新建 `skills/<name>/SKILL.md`，YAML frontmatter 写 `name` 和 `description`（触发时机）。
2. 在 system prompt 的"技能"一节登记触发条件。
3. 安全审查：技能内容会进入所有用户共享的工作区，不要放凭证或隐私数据。
