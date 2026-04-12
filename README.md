# metapi2ccload

把 metapi 备份转换成 ccload CSV。

这个工具不是字段直拷，而是按 metapi 的路由语义导出 ccload 渠道。

---

## 核心概念

### logical model

metapi 里的逻辑入口模型名。

例如：

- `deepseek-v3.2`
- `glm-5`
- `claude-opus-4.6`

对于 `explicit_group`，这就是 group route 的 `modelPattern`。

### source entry

一个真实来源渠道。

最少细化到：

```text
site + account + token-or-fallback-secret + concrete-route + raw-source-model
```

一句话理解：

**一个 source entry = 一条真实上游通道。**

### canonical request model

最终写进 ccload `models` 列的请求模型名。

一句话理解：

**用户向 ccload 请求的模型名。**

---

## 三条关键规则

### 1. `explicit_group` 一定拆成多条真实渠道

如果一个 logical model 展开到多个真实来源，导出后仍然是多条 row。

不会把多个真实来源压成一条 ccload 渠道。

例如 `deepseek-v3.2` 如果展开到：

- source A → `DeepSeek-V3.2`
- source A → `deepseek-ai/deepseek-v3.2`
- source B → `deepseek-ai/deepseek-v3.2`

那么导出后应该还是 **3 条 row**。

### 2. 不做全局字符串猜测

不会因为名字长得像就自动视为同义。

默认不会做：

- 全局转小写
- 全局点横线互转
- 仅凭大小写不同就自动合并
- 仅凭名字相似就自动合并

例如：

- `GLM-5`
- `glm-5`

默认不会互相映射。只有 metapi 自己通过 `explicit_group`、binding 链或 `modelMapping` 明确表达关系时，才会共享 canonical request model。

### 3. `model_redirects` 必须能把请求名打到真实 source model

如果某条 row：

- `models=glm-5`
- 但真实 source model 是 `GLM-5`

那么这条 row 会写出：

```json
{"glm-5":"GLM-5"}
```

同理，如果：

- `models=deepseek-v3.1`
- 真实 source model 是 `deepseek-ai/deepseek-v3.1`

则会写出：

```json
{"deepseek-v3.1":"deepseek-ai/deepseek-v3.1"}
```

这样 ccload 才能用统一后的请求模型名，真正打到这条 row 的上游模型。

---

## 当前支持的两种主要导出模式

### 模式 A：`logical-bundle + canonical-merge`

用途：

- 导出单个或全部 `explicit_group`
- 保留多 source 分流
- 让同一个 logical group 的多条 row 共享同一个 canonical request model

特点：

- 每个 source entry 仍然单独成 row
- 不做同渠多模型合并

### 模式 B：`shared-credential + merge`

用途：

- 在同一个真实渠道上，安全合并多个 logical models
- 当前最典型的例子是：
  - `gpt-5.4`
  - `gpt-5.3-codex`

特点：

- 只在同一个 shared credential 下尝试合并
- 只允许**显式允许的一组模型**合并
- 只要某个 logical model 在该真实渠道上是多值能力，就拒绝合并并给 warning
- 不会把其他 explicit_group 顺带吞进同一条多模型 row

---

## 典型场景

### 场景 1：`glm-5` / `GLM-5`

如果 metapi 明确把它们放在同一个 `explicit_group`：

- `models` 会统一成 `glm-5`
- source row 仍然拆开
- 如果某条 row 的真实 source model 是 `GLM-5`，则会写：

```json
{"glm-5":"GLM-5"}
```

### 场景 2：`deepseek-v3.1`

如果某条 row 的真实 source model 是 `deepseek-ai/deepseek-v3.1`，导出后会是：

- `models=deepseek-v3.1`
- `model_redirects={"deepseek-v3.1":"deepseek-ai/deepseek-v3.1"}`

### 场景 3：`gpt-5.4` + `gpt-5.3-codex`

如果它们在同一个真实渠道上都是单值能力，那么允许导出成一条多模型 row：

- 通道 A → `models=gpt-5.3-codex,gpt-5.4`
- 通道 B 只支持 `gpt-5.4` → `models=gpt-5.4`

但如果某个模型在该真实渠道上其实展开成多 source，就会跳过 merge 并给 warning。

---

## 参数速查

### `--models`

手工指定要导出的 logical models。

### `--explicit-groups-only`

自动从备份里选出全部 `explicit_group` 的 logical models。

### `--channel-types`

手工指定要导出的 `channel_type`。

如果不指定，默认使用 `auto`：

- `gpt*` → `openai,codex`
- `claude*` → `anthropic`
- 其他模型 → `openai`

### `--entry-mode`

常用值：

- `logical-bundle`
- `shared-credential`

### `--model-pack-mode`

常用值：

- `canonical-merge`
- `merge`

### `--compat-policy`

常用值：

- `metapi-inferred`
- `bundle-or-metapi-inferred`

### `--model-mode`

旧兼容参数，仍然保留，但不建议再用它理解当前规则。

---

## 最常用命令

### 导出全部 explicit_group，保留多 source 分流

```bash
bun scripts/metapi-to-ccload.ts \
  --input "./path/to/metapi-backup.json" \
  --explicit-groups-only \
  --channel-types codex \
  --entry-mode logical-bundle \
  --model-pack-mode canonical-merge \
  --compat-policy metapi-inferred \
  --preview --yes
```

### 导出全部 explicit_group，并同时允许 GPT pair 同渠安全合并

```bash
bun scripts/metapi-to-ccload.ts \
  --input "./path/to/metapi-backup.json" \
  --explicit-groups-only \
  --channel-types openai,codex \
  --entry-mode shared-credential \
  --model-pack-mode merge \
  --compat-policy bundle-or-metapi-inferred \
  --yes
```

### 只测试 `gpt-5.4` / `gpt-5.3-codex` 同渠合并

```bash
bun scripts/metapi-to-ccload.ts \
  --input "./path/to/metapi-backup.json" \
  --models gpt-5.4,gpt-5.3-codex \
  --channel-types codex \
  --entry-mode shared-credential \
  --model-pack-mode merge \
  --compat-policy bundle-only \
  --preview --yes
```

---

## 推荐用法

如果你的目标是：

- 导出所有 `explicit_group`
- 保留多真实来源分流
- 尽量统一请求模型名
- 同时让 `gpt-5.4,gpt-5.3-codex` 在安全时合并

推荐直接用：

```text
--explicit-groups-only
--entry-mode shared-credential
--model-pack-mode merge
--compat-policy bundle-or-metapi-inferred
```

---

## FAQ

### 为什么同一个模型会导出成多条 row？

因为一条 row 代表一个真实 source entry，而不是一个逻辑模型本身。

如果一个 logical model 下面挂了多个真实来源，那么导出后就会有多条 row。

这不是重复，而是保留分流能力。

### 为什么有些 row 的 `model_redirects` 是 `{}`？

因为这条 row 的请求模型名已经和真实 source model 一致了，不需要再做改写。

只有当：

- `models` 写的是统一后的 logical canonical
- 但真实 source model 是另一个名字

才需要写 `model_redirects`。

例如：

- `models=glm-5`
- 真实 source model = `GLM-5`

这时才会出现：

```json
{"glm-5":"GLM-5"}
```

### 为什么 `gpt-5.4,gpt-5.3-codex` 可以合并，但 `deepseek-v3.2` 不一定能？

因为 `gpt-5.4` 和 `gpt-5.3-codex` 是显式允许的 merge group，并且只有在同一个真实渠道上都是单值能力时才会合并。

而 `deepseek-v3.2` 在某些真实渠道上会展开成多个 source model，这种情况下会被判定为多值 logical model，系统会拒绝合并并给 warning。

一句话理解：

- GPT 这组是“安全时可合并”
- DeepSeek 这组是“只要多值就必须拆条”
