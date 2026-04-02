# metapi2ccload

把 metapi 备份文件转换成 ccload 渠道 CSV 的小工具。

这个项目的目标不是做“字段直拷”，而是把 metapi 里的关系化路由配置：

- `sites`
- `accounts`
- `accountTokens`
- `tokenRoutes`
- `routeChannels`
- `routeGroupSources`

展平成 ccload 可以直接消费的渠道列表。

目前脚本已经支持：

- 按模型列表筛选需要导出的路由
- 支持多个转换配置（profile）
- 支持模型合并导出或拆分导出
- 支持一个通道组扇出成多个 `channel_type`
- 支持预览模式，不落盘
- 支持单文件输出或按 profile 分文件输出
- 支持对完全重复的输出行做去重

项目当前主脚本：

- `scripts/metapi-to-ccload.ts`

## 适用场景

适合这类需求：

- 从 metapi 备份中提取某一批模型对应的上游通道
- 把同一个 metapi 通道组导出成多个 ccload 渠道类型
- 为不同模型/渠道策略生成多套 ccload 配置
- 在真正写入 CSV 之前先做预览确认

例如：

- `gpt-5.4,gpt-5.3-codex + merge + codex,openai`
- `gpt-5.4,gpt-5.3-codex + split + codex`
- `gpt-5.4,gpt-5.3-codex + split + codex,openai`

## 当前支持的渠道类型

项目按你们当前的 ccload 约定，把 `channel_type` 视为渠道的“协议类型/使用类型标签”。

目前约定的 4 类包括：

- `openai`
- `codex`
- `anthropic`
- `gemini`

脚本本身不会强行限制只能使用这四个值，但推荐按这四类来配置。

## 运行环境

推荐使用：

- `bun`

本项目脚本是一个零依赖 TypeScript CLI，默认使用 Bun 直接运行。

## 输入与输出

### 输入

输入文件是 metapi 备份 JSON，例如：

```bash
metapi-backup-2026-04-02.json
```

### 输出

输出文件是 ccload CSV，例如：

```bash
metapi-backup-2026-04-02.ccload.csv
```

或按 profile 分文件输出：

```bash
metapi-backup-2026-04-02.ccload.gpt-merge.csv
metapi-backup-2026-04-02.ccload.gpt-split.csv
```

## 核心转换思路

### 1. metapi 的 `tokenRoute` 不是最终渠道

脚本不会把 `tokenRoutes` 直接当成 ccload 行。

原因是：

- `tokenRoute` 表示模型路由规则
- ccload 需要的是“最终可用的上游渠道”

### 2. 真正的导出粒度是“通道组”

脚本会先把 metapi 数据展平为一个逻辑通道组：

```text
site + account + token-or-fallback-secret
```

也就是：

- 一个站点
- 一个账号
- 一个 token；如果没有 token，则回退到账号密钥

这个“通道组”才对应 ccload 里的一条上游渠道基底。

### 3. 一个通道组可以扇出成多条 ccload 行

扇出数量由两个配置决定：

- 模型模式：`merge` / `split`
- 渠道类型列表：一个或多个

例如：

- 模型：`gpt-5.4,gpt-5.3-codex`
- 模型模式：`split`
- 渠道类型：`codex,openai`

如果某个通道组同时支持这两个模型，最终会导出四条：

- `gpt-5.4 + codex`
- `gpt-5.4 + openai`
- `gpt-5.3-codex + codex`
- `gpt-5.3-codex + openai`

### 4. 自动处理 `explicit_group`

metapi 里有些模型路由会通过 `explicit_group` 指向真正的 source route。

脚本会自动：

- 识别逻辑路由
- 展开到 concrete route
- 避免把 group route 和 source route 重复导出

## 渠道命名规则

当前默认名称格式为：

```text
site.url|label|acct-<id>|account-secret|models|channel_type
```

例如：

```text
https://ai.dogaltman.us.ci|metapi|acct-31|account-secret|gpt-5.4,gpt-5.3-codex|codex
```

其中：

- 第 1 段：站点 URL
- 第 2 段：优先使用 token 名，其次使用账号名，再次使用站点名
- 第 3 段：账号 ID
- 第 4 段：固定保留为 `account-secret`，便于统一识别
- 第 5 段：模型列表或单模型
- 第 6 段：渠道类型

如果开启“在渠道名后追加 profile 名”，还会在最后多一段：

```text
|profile-name
```

## 使用方式

### 交互模式

最推荐的方式：

```bash
bun scripts/metapi-to-ccload.ts
```

脚本会自动：

- 查找当前目录下最新的 `metapi-backup-*.json`
- 让你输入 profile 数量
- 逐个输入：
  - profile 名称
  - 模型列表
  - 模型模式 `merge/split`
  - 渠道类型列表
- 再选择：
  - 输出模式
  - 是否去重
  - 是否追加 profile 名
  - 是否仅预览

### 单 profile 命令行模式

适合脚本化调用：

```bash
bun scripts/metapi-to-ccload.ts \
  --input metapi-backup-2026-04-02.json \
  --models gpt-5.4,gpt-5.3-codex \
  --channel-types codex,openai \
  --model-mode merge \
  --output /tmp/metapi-merge.csv \
  --yes
```

### 仅预览，不写入文件

```bash
bun scripts/metapi-to-ccload.ts \
  --input metapi-backup-2026-04-02.json \
  --models gpt-5.4,gpt-5.3-codex \
  --channel-types codex,openai \
  --model-mode split \
  --preview \
  --yes
```

### 按 profile 分文件输出

```bash
bun scripts/metapi-to-ccload.ts --output-mode per-profile
```

## 常用参数

```bash
-i, --input <file>           metapi 备份 JSON 路径
-o, --output <file>          输出 ccload CSV 路径或基础路径
-m, --models <list>          单个 profile 的模型列表，逗号分隔
-t, --channel-types <list>   单个 profile 的渠道类型列表，逗号分隔
    --model-mode <mode>      merge | split
    --profile-name <name>    单 profile 模式下自定义 profile 名称
    --append-profile-name    在渠道名后追加 profile 名
    --dedupe                 去除完全重复的输出行
    --output-mode <mode>     single | per-profile
    --preview                仅预览，不写入文件
-y, --yes                    跳过最终确认
-h, --help                   查看帮助
```

## profile 配置示例

### 示例 1：多模型合并 + 多渠道

- 模型：`gpt-5.4,gpt-5.3-codex`
- 模型模式：`merge`
- 渠道类型：`codex,openai`

效果：

- 每个通道组最多导出 2 条

### 示例 2：多模型拆分 + 单渠道

- 模型：`gpt-5.4,gpt-5.3-codex`
- 模型模式：`split`
- 渠道类型：`codex`

效果：

- 每个通道组最多导出 2 条

### 示例 3：多模型拆分 + 多渠道

- 模型：`gpt-5.4,gpt-5.3-codex`
- 模型模式：`split`
- 渠道类型：`codex,openai`

效果：

- 每个通道组最多导出 4 条

## 输出模式

### `single`

把所有 profile 的结果合并到一个 CSV。

适合：

- 最终要交给 ccload 的统一配置文件

### `per-profile`

每个 profile 输出一个独立 CSV。

适合：

- 想分别检查不同 profile 的结果
- 想把不同策略交给不同环境使用

## 去重规则

开启 `--dedupe` 后，脚本会按“完整行内容”去重。

注意：

- 去重发生在最终输出阶段
- `id` 会在去重后重新分配
- 如果两个 profile 最终产出完全相同的一行，可以用这个选项去掉重复

## 预览模式

开启 `--preview` 后：

- 会正常完成解析与转换
- 会打印转换摘要
- 会打印每个输出文件前几条预览行
- 不会写入任何 CSV 文件

适合：

- 调试 profile
- 快速检查命名是否符合预期
- 先确认扇出条数再正式导出

## 风险与注意事项

### 1. 这是“转换器”，不是“协议探测器”

脚本会按配置生成指定的 `channel_type`，例如：

- `openai`
- `codex`
- `anthropic`
- `gemini`

但脚本不会自动保证某个站点一定真实兼容该类型。

也就是说：

- 脚本负责“按你的规则导出”
- 协议兼容性仍然需要你自己确认

### 2. 某些平台属于激进转换

例如：

- `anyrouter`
- `claude`

如果把这些平台直接导出成 `openai/codex/gemini` 等类型，脚本会给出警告。

### 3. 密钥是敏感信息

metapi 备份里通常包含：

- token
- apiToken
- accessToken

请不要把真实备份文件、真实导出结果直接提交到 GitHub。

建议：

- `.gitignore` 排除备份文件与导出 CSV
- 分享示例时先脱敏

## 建议的 `.gitignore`

```gitignore
metapi-backup-*.json
*.ccload.csv
*.ccload.*.csv
channels-*.csv
```

## 开发说明

脚本尽量保持：

- 零依赖
- 类型清晰
- 注释明确
- 便于后续按业务规则继续扩展

如果后续要扩展，比较自然的方向包括：

- 与现有 ccload CSV 做 diff / 去重
- 对 `channel_type` 增加白名单校验
- 支持自定义命名模板
- 支持只导出启用中的渠道
- 支持导出前预览统计更详细的报告