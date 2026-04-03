# metapi2ccload

把 metapi 备份文件转换成 ccload 渠道 CSV 的工具。

这个仓库不是做“字段直拷”，而是把 metapi 的关系化配置：

- `sites`
- `accounts`
- `accountTokens`
- `tokenRoutes`
- `routeChannels`
- `routeGroupSources`

解析成 ccload 能直接消费的渠道列表，同时尽量保留 metapi 原本的路由语义。

项目主脚本：

- `scripts/metapi-to-ccload.ts`

## 这次重构解决了什么

这次导出逻辑重点修复了两个核心问题：

- `GLM-5` 和 `glm-5` 不会再因为同站点、同账号、同 token 被错误并到同一条导出行
- `explicit_group` 不会再被揉成一条混合记录，而是会按真实 source route 拆成多条 ccload row

重构后的目标是让 ccload 的导出语义尽量贴近 metapi：

- metapi 里的一个逻辑模型入口，可以对应多个真实上游来源
- 导出到 ccload 后，仍然可以保留“一个请求模型名，多个真实通道分流”的能力
- 不会因为大小写、命名接近、点横线差异就做粗暴归一化

## 核心语义

### 四层模型名

导出流程里现在明确区分四层模型名：

1. `requestedModel`
   - profile 里要求导出的模型名

2. `logicalModel`
   - 逻辑路由的 `modelPattern`
   - 对 `explicit_group` 来说，这是逻辑入口模型

3. `rawSourceModel`
   - 真实上游模型名
   - 优先来自 `routeChannel.sourceModel`
   - 如果没有，再回退到 concrete route 的 `modelPattern`

4. `canonicalModel`
   - 最终写进 ccload `models` 列的统一请求模型名
   - 只会在明确属于同一个逻辑组时做保守归一

### 新的导出粒度

旧实现会先按下面这把 key 折叠：

```text
site + account + token-or-fallback-secret
```

这会导致不同 concrete route、不同真实 source model 被过早合并。

现在真正的中间导出实体是 `source entry`，最少细化到：

```text
site + account + token-or-fallback-secret + concrete-route + raw-source-model
```

也就是说：

- 同一个 token 下的不同真实上游，不再自动并到一条
- 同一个逻辑模型展开出的多个 source route，会分别导出
- merge/split 只影响同一个 source entry 的模型列写法，不再跨 source entry 合并

## explicit_group 的导出规则

### 解析行为

脚本会先精确匹配：

```text
route.modelPattern === requested model
```

如果命中的是 `explicit_group`，则：

- 把 group route 视为逻辑路由
- 递归展开到全部 concrete route
- 为每个 concrete route 保留一条绑定关系

绑定关系内部会记录：

- `requestedModel`
- `logicalRouteId`
- `logicalModel`
- `concreteRouteId`
- `concreteModel`

这样导出阶段不会再丢失“逻辑入口 -> 真实来源”的关系。

### 导出行为

对于一个 `explicit_group`：

- 会先展开到全部真实 source route
- 每条 source route 对应一条 ccload row
- 多条 row 可以共享同一个 `canonicalModel`

这意味着最终效果是：

- 逻辑上，一个请求模型名
- 物理上，多条真实通道分流

### Claude Opus 示例

如果 metapi 里一个逻辑模型组展开为两个真实来源：

- `claude-opus-4-6`
- `anthropic:claude-opus-4-6`

导出后会变成两条 row，例如：

```text
https://code.claudex.us.ci|3|acct-19|account-secret|claude-opus-4-6|src-claude-opus-4-6|codex
https://code.claudex.us.ci|3|acct-19|account-secret|claude-opus-4-6|src-anthropic-claude-opus-4-6|codex
```

它们的共同特点是：

- `models` 都是 `claude-opus-4-6`
- 名称里保留不同的 `src-*` 后缀
- ccload 可以用一个模型名把流量打到两条真实通道

## canonical model 规则

canonical model 的处理是保守的，不做全局归一。

### 会做的事

对于同一个 `explicit_group` 内的多个真实来源：

- 优先选择无供应商前缀的模型名作为 `canonicalModel`
- 例如 `claude-opus-4-6` 会优先于 `anthropic:claude-opus-4-6`
- 在展开 `explicit_group` 时，只接受和逻辑模型显式兼容的真实模型
- 兼容规则只允许：完全相同、去掉供应商前缀后相同、或点/下划线与横线差异

### 不会做的事

脚本不会做这些危险归一：

- 不会全局转小写
- 不会全局把 `.` 自动变成 `-`
- 不会因为名字看起来接近就自动判定为同一个模型
- 不会因为只有大小写不同就把两个模型视为同义

### GLM 大小写示例

下面这些不会被自动视为同义：

- `GLM-5`
- `glm-5`

只有 metapi 里明确通过同一个逻辑 group/source 关系表达它们属于同一个入口时，才会共享请求模型名；否则会各自独立导出。

这能避免出现这种假象：

```text
一个 default key 同时被标成支持 glm-5,GLM-5
```

## merge / split 的新语义

### split

`split` 模式下：

- 一个 source entry
- 一个 canonical model
- 一条 ccload row

也就是说，source entry 会完整拆开。

### merge

`merge` 模式下：

- 只允许在同一个 source entry 内合并多个 canonical model
- 不允许跨 `rawSourceModel`
- 不允许跨 concrete route

这是为了确保“模型列的合并”不会重新变成“真实来源的合并”。

## 渠道命名规则

当前默认名称格式为：

```text
site.url|label|acct-<id>|account-secret|models|src-<source>|channel_type
```

例如：

```text
https://code.claudex.us.ci|3|acct-19|account-secret|claude-opus-4-6|src-anthropic-claude-opus-4-6|codex
```

字段含义：

- 第 1 段：站点 URL
- 第 2 段：优先使用 token 名，其次使用账号名，再次使用站点名
- 第 3 段：账号 ID
- 第 4 段：固定保留为 `account-secret`
- 第 5 段：`models` 列里实际写入的模型名或模型列表
- 第 6 段：真实来源后缀 `src-*`，用于区分不同 source row
- 第 7 段：`channel_type`

补充说明：

- `src-*` 后缀只用于名称区分，不参与 canonical model 归一
- 这里会保留大小写差异，避免 `GLM-5` 和 `glm-5` 在名称后缀里再次撞名

如果开启“在渠道名后追加 profile 名”，则会在最后再追加：

```text
|profile-name
```

## model_redirects 的行为

导出时会综合两类信息：

- 原始 `route.modelMapping`
- 当前 source entry 内部的 alias 关系

alias 候选包括：

- `requestedModel`
- `logicalModel`
- `concreteModel`
- `rawSourceModel`

如果这些名字和 `canonicalModel` 不同，就会尽量写入 `model_redirects`。

对于只有一个 canonical model 的 source entry，这能让逻辑别名继续指向统一请求模型名。

## 当前支持的渠道类型

项目按当前 ccload 约定，把 `channel_type` 视为渠道的“协议类型/使用类型标签”。

常见值包括：

- `openai`
- `codex`
- `anthropic`
- `gemini`

脚本不会强行限制只能使用这几个值。

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

或者按 profile 分文件输出：

```bash
metapi-backup-2026-04-02.ccload.gpt-merge.csv
metapi-backup-2026-04-02.ccload.gpt-split.csv
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
  --input "metapi-backup-2026-04-03 (3).json" \
  --models claude-opus-4.6,glm-5,GLM-5 \
  --channel-types codex \
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

## 验收关注点

重构后的导出结果应满足：

- `explicit_group` 导出后是多条 row，而不是一条混合 row
- 多条 row 可以共享同一个 `canonicalModel`
- row 名称能区分不同 source
- `GLM-5` / `glm-5` 不再错误合并
- 导出逻辑里明确保留 logical model 和 concrete/source model 的区别
- merge/split 只影响同一个真实 source entry 的模型列写法，不再跨 source entry 合并

## 风险与注意事项

### 1. 这是转换器，不是协议探测器

脚本会按配置生成指定的 `channel_type`，例如：

- `openai`
- `codex`
- `anthropic`
- `gemini`

但脚本不会自动保证某个站点一定真实兼容该类型。

### 2. accessToken 仍然只是兜底

如果 token 和 `apiToken` 都缺失，脚本会回退使用 `accessToken`。

这只是保守兜底，并不保证目标站点一定接受它作为 ccload `api_key`。

### 3. model_redirects 不是万能别名系统

只有在当前 source entry 语义明确时，alias 才会被写入 redirect。

脚本不会为跨 source entry 的模糊别名关系做强行归一。
