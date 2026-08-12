# CommandCode 1.9.0 模型信息表

本报告完全基于官方 `command-code@1.9.0` 本地安装包的静态代码分析，不依赖线上捕获或伪服务。分析对象：`official/command-code-1.9.0/dist/cli.mjs`（2,328,102 bytes，SHA-256 `1C34AB47E5B945F00CE502F5D93AC2BA18FD5829DB964C8A6568C640C04B55F9`）。

## 1. 模型目录数据来源

模型目录硬编码在 CLI bundle 中，不是运行时从 API 拉取。核心数据表：

| 常量 | 说明                                              | bundle 位置       |
| ---- | ------------------------------------------------- | ----------------- |
| `MI` | 模型信息表（53 个模型对象）                       | offset ~1,750,601 |
| `hI` | provider: `"anthropic"`                           | offset ~1,746,821 |
| `fI` | provider: `"openai"`                              | offset ~1,746,836 |
| `yI` | provider: `"baseten"`                             | offset ~1,746,848 |
| `SI` | provider: `"vercel-ai-gateway"`                   | offset ~1,746,861 |
| `wI` | provider: `"cloudflare-ai-gateway"`               | offset ~1,746,877 |
| `kI` | provider: `"cmd-ai"`                              | offset ~1,746,884 |
| `vI` | provider: `"openrouter"`                          | offset ~1,746,923 |
| `CI` | `SI` 的别名（开源模型走 Vercel Gateway）          | offset ~1,746,939 |
| `EI` | spec: `"chatComplete"`                            | offset ~1,750,537 |
| `TI` | spec: `"responses"`                               | offset ~1,750,555 |
| `PI` | `"MiniMaxAI/MiniMax-M3-Free"`                     | offset ~1,750,570 |
| `tr` | 推理档位支持表（Map）                             | offset ~1,237,255 |
| `nr` | 已知模型 ID 集合（Set）                           | offset ~1,237,865 |
| `rr` | 旧模型→新模型替换表                               | offset ~1,238,905 |
| `xI` | provider 别名表（canonicalId → 各 provider slug） | offset ~1,763,900 |
| `II` | 网关模型定价表（含多 provider 备选）              | offset ~1,766,926 |
| `AI` | OpenRouter 模型定价表                             | offset ~1,775,439 |
| `bI` | 直连 provider 定价表                              | offset ~1,746,945 |
| `KA` | 展示定价覆盖表                                    | offset ~1,817,736 |
| `LI` | provider → 分组标签                               | offset ~1,776,678 |
| `DI` | 分组显示顺序                                      | offset ~1,776,700 |
| `RI` | 模型 ID → 替换为当前目录 ID                       | offset ~1,776,686 |
| `qn` | 默认模型 `"deepseek/deepseek-v4-flash"`           | offset ~1,236,901 |
| `OI` | 默认模型 ID（同 `qn`）                            | offset ~1,776,690 |

## 2. 模型字段说明

每个模型对象包含以下字段（非全部模型都有所有字段）：

| 字段               | 说明                                                         |
| ------------------ | ------------------------------------------------------------ |
| `id`               | 模型唯一 ID（命令行 `--model` 传入的值）                     |
| `name` / `label`   | 展示名称                                                     |
| `provider`         | provider 常量（anthropic/openai/vercel-ai-gateway/openrouter 等） |
| `vendorLabel`      | 可选的厂商标签（如 OpenAI、Google、Sakana、Meta、xAI）       |
| `spec`             | API 规格：`chatComplete` 或 `responses`                      |
| `inputModalities`  | 支持的输入模态：`["text"]` 或 `["text","image"]`             |
| `contextWindow`    | 上下文窗口 token 数                                          |
| `maxOutputTokens`  | 最大输出 token 数（仅部分模型标注）                          |
| `reasoning`        | 是否支持推理（布尔）                                         |
| `reasoningEfforts` | 支持的推理档位数组（low/medium/high/xhigh/max）              |
| `badge`            | 徽标：`"free"`（免费模型）                                   |
| `hidden`           | 是否在模型列表中隐藏（`--list-models` 不显示）               |
| `description`      | 一句话描述                                                   |

## 3. 模型信息总表（53 个）

### Anthropic（7 个）

| 模型 ID                     | 名称              | 模态       | context | 推理 | 推理档位                  |
| --------------------------- | ----------------- | ---------- | ------- | ---- | ------------------------- |
| `claude-sonnet-5`           | Claude Sonnet 5   | text+image | 1M      | ✓    | low/medium/high/xhigh/max |
| `claude-sonnet-4-6`         | Claude Sonnet 4.6 | text+image | 1M      | –    | low/medium/high/xhigh/max |
| `claude-fable-5`            | Claude Fable 5    | text+image | 1M      | ✓    | low/medium/high/xhigh/max |
| `claude-opus-5`             | Claude Opus 5     | text+image | 1M      | ✓    | low/medium/high/xhigh/max |
| `claude-opus-4-8`           | Claude Opus 4.8   | text+image | 1M      | ✓    | low/medium/high/xhigh/max |
| `claude-opus-4-7`           | Claude Opus 4.7   | text+image | 1M      | ✓    | low/medium/high/xhigh/max |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5  | text+image | 200K    | –    | –                         |

### OpenAI（7 个，spec: responses）

| 模型 ID         | 名称          | 模态       | context | 推理 | 推理档位                  |
| --------------- | ------------- | ---------- | ------- | ---- | ------------------------- |
| `gpt-5.6-sol`   | GPT-5.6 Sol   | text+image | 1.05M   | ✓    | low/medium/high/xhigh/max |
| `gpt-5.6-terra` | GPT-5.6 Terra | text+image | 1.05M   | ✓    | low/medium/high/xhigh/max |
| `gpt-5.6-luna`  | GPT-5.6 Luna  | text+image | 1.05M   | ✓    | low/medium/high/xhigh/max |
| `gpt-5.5`       | GPT-5.5       | text+image | –       | ✓    | low/medium/high/xhigh     |
| `gpt-5.4`       | GPT-5.4       | text+image | 400K    | ✓    | low/medium/high/xhigh     |
| `gpt-5.3-codex` | GPT-5.3 Codex | text+image | 400K    | ✓    | low/medium/high/xhigh     |
| `gpt-5.4-mini`  | GPT-5.4 Mini  | text+image | 400K    | ✓    | low/medium/high           |

### 开源模型（Vercel Gateway，spec: chatComplete）

| 模型 ID                               | 名称                     | 模态       | context | 推理 | 推理档位         | 备注                                           |
| ------------------------------------- | ------------------------ | ---------- | ------- | ---- | ---------------- | ---------------------------------------------- |
| `MiniMaxAI/MiniMax-M3-Free`           | MiniMax M3 (Free)        | text+image | 1M      | ✓    | –                | free, hidden                                   |
| `deepseek/deepseek-v4-pro`            | DeepSeek V4 Pro          | text       | 1M      | ✓    | high/max         |                                                |
| `deepseek/deepseek-v4-flash`          | DeepSeek V4 Flash        | text       | 1M      | ✓    | high/max         | **默认模型**                                   |
| `moonshotai/Kimi-K3`                  | Kimi K3                  | text+image | 1M      | ✓    | –                |                                                |
| `moonshotai/Kimi-K2.7-Code`           | Kimi K2.7 Code           | text+image | 256K    | ✓    | –                |                                                |
| `moonshotai/Kimi-K2.7-Code-Highspeed` | Kimi K2.7 Code HighSpeed | text+image | 262K    | ✓    | –                |                                                |
| `moonshotai/Kimi-K2.6`                | Kimi K2.6                | text+image | 256K    | –    | –                |                                                |
| `moonshotai/Kimi-K2.5`                | Kimi K2.5                | text+image | 256K    | –    | –                |                                                |
| `zai-org/GLM-5.2`                     | GLM-5.2                  | text       | 1M      | ✓    | high/max         |                                                |
| `zai-org/GLM-5.2-Fast`                | GLM-5.2 Fast             | text       | 1M      | –    | –                |                                                |
| `zai-org/GLM-5.1`                     | GLM-5.1                  | text       | –       | –    | –                |                                                |
| `zai-org/GLM-5`                       | GLM-5                    | text       | 200K    | –    | –                |                                                |
| `MiniMaxAI/MiniMax-M3`                | MiniMax M3               | text+image | 1M      | ✓    | –                |                                                |
| `MiniMaxAI/MiniMax-M2.7`              | MiniMax M2.7             | text       | –       | –    | –                |                                                |
| `MiniMaxAI/MiniMax-M2.5`              | MiniMax M2.5             | text       | 200K    | –    | –                |                                                |
| `xiaomi/mimo-v2.5-pro`                | MiMo V2.5 Pro            | text       | 1M      | –    | –                |                                                |
| `xiaomi/mimo-v2.5`                    | MiMo V2.5                | text+image | 1M      | –    | –                |                                                |
| `Qwen/Qwen3.6-Max-Preview`            | Qwen 3.6 Max Preview     | text       | –       | ✓    | –                |                                                |
| `Qwen/Qwen3.6-Plus`                   | Qwen 3.6 Plus            | text+image | –       | ✓    | –                |                                                |
| `Qwen/Qwen3.7-Max`                    | Qwen 3.7 Max             | text       | 1M      | ✓    | –                |                                                |
| `Qwen/Qwen3.7-Plus`                   | Qwen 3.7 Plus            | text+image | 1M      | ✓    | –                |                                                |
| `Qwen/Qwen3.7-Flash`                  | Qwen 3.7 Flash           | text+image | 1M      | ✓    | –                |                                                |
| `Qwen/Qwen3.8-Max`                    | Qwen 3.8 Max             | text+image | 1M      | ✓    | low/medium/xhigh |                                                |
| `stepfun/Step-3.7-Flash`              | Step 3.7 Flash           | text+image | 256K    | ✓    | –                |                                                |
| `stepfun/Step-3.5-Flash`              | Step 3.5 Flash           | text       | 1M      | ✓    | –                |                                                |
| `tencent/Hy3`                         | Tencent Hy3 (Free)       | text       | 262K    | ✓    | –                | free, hidden                                   |
| `tencent/hy3-paid`                    | Tencent Hy3              | text       | 262K    | ✓    | –                |                                                |
| `nvidia/nemotron-3-ultra-550b-a55b`   | Nemotron 3 Ultra         | text       | 1M      | ✓    | –                |                                                |
| `thinkingmachines/inkling`            | Inkling                  | text+image | 256K    | ✓    | –                |                                                |
| `thinkingmachines/inkling-small`      | Inkling Small            | text+image | 1M      | ✓    | –                |                                                |
| `poolside/laguna-s-2.1-free`          | Laguna S 2.1             | text       | 256K    | ✓    | –                | free, maxOutput 32K                            |
| `inclusionai/ling-3.0-flash-free`     | Ling 3.0 Flash           | text       | 256K    | ✓    | –                | free, hidden, maxOutput 32K, 2026-08-03 后隐藏 |

### Google / Sakana / Meta / xAI（vendorLabel 厂商标注）

| 模型 ID                        | 名称                  | 模态       | context | 推理 | 推理档位        |
| ------------------------------ | --------------------- | ---------- | ------- | ---- | --------------- |
| `google/gemini-3.6-flash`      | Gemini 3.6 Flash      | text+image | 1M      | ✓    | low/medium/high |
| `google/gemini-3.5-flash`      | Gemini 3.5 Flash      | text+image | 1M      | ✓    | low/medium/high |
| `google/gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | text+image | 1M      | ✓    | low/medium/high |
| `google/gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | text+image | 1M      | ✓    | low/medium/high |
| `sakana/fugu-ultra`            | Fugu Ultra            | text+image | 1M      | ✓    | high/xhigh      |
| `meta/muse-spark-1.1`          | Muse Spark 1.1        | text+image | 1M      | ✓    | –               |
| `xai/grok-4.5`                 | Grok 4.5              | text+image | 500K    | ✓    | low/medium/high |

## 4. 分组与显示

- 分组顺序（`DI`）：**Open Source → Anthropic → OpenAI → Google**，其他厂商（Sakana/Meta/xAI）按出现顺序追加。
- 隐藏模型（`hidden: true`）不进入 `--list-models` 输出：`MiniMaxAI/MiniMax-M3-Free`、`tencent/Hy3`、`inclusionai/ling-3.0-flash-free`。
- `inclusionai/ling-3.0-flash-free` 的 `hidden` 由 `isLingFlashFreeEnded()` 决定：当前时间 ≥ `2026-08-03T13:00:00Z` 即隐藏（即 2026-08-11 起已隐藏）。
- 展示时默认模型（`deepseek/deepseek-v4-flash`）标注 `(default)`，免费模型标注 `FREE`。

## 5. 模型解析逻辑

```text
用户输入 --model X
  → canonicalizeModelId(X)
      ├── 去掉前缀 "workers-ai/@cf/"
      ├── 去掉日期后缀 /[-@]\d{8}$/
      ├── 查 rr（旧模型替换表）
      └── 查 xI（provider 别名表）
  → resolveKnownModelId → findModelById（查 MI）
  → 未知则 suggestModelInput（编辑距离提示）或报错
```

旧模型自动替换（`rr`）：

| 旧 ID                        | 新 ID                       |
| ---------------------------- | --------------------------- |
| `claude-sonnet-4-20250514`   | `claude-sonnet-4-6`         |
| `claude-sonnet-4-5-20250929` | `claude-sonnet-4-6`         |
| `claude-opus-4-5-20251101`   | `claude-opus-4-7`           |
| `claude-opus-4-6`            | `claude-opus-4-7`           |
| `claude-haiku-4-5`           | `claude-haiku-4-5-20251001` |
| `tencent/HY3`                | `tencent/Hy3`               |

## 6. 推理档位支持（tr 表）

| 模型                                                 | 支持档位                      |
| ---------------------------------------------------- | ----------------------------- |
| Claude Sonnet 5 / 4.6 / Fable 5 / Opus 5 / 4.8 / 4.7 | low, medium, high, xhigh, max |
| GPT-5.6 Sol / Terra / Luna                           | low, medium, high, xhigh, max |
| GPT-5.5 / 5.4 / 5.3-codex                            | low, medium, high, xhigh      |
| GPT-5.4-mini                                         | low, medium, high             |
| DeepSeek V4 Pro / Flash                              | high, max                     |
| GLM-5.2                                              | high, max                     |
| Qwen 3.8 Max                                         | low, medium, xhigh            |
| Gemini 3.6 / 3.5 / 3.5-lite / 3.1-lite               | low, medium, high             |
| Fugu Ultra                                           | high, xhigh                   |
| Grok 4.5                                             | low, medium, high             |

## 7. 定价表（每百万 token，USD）

### 直连 provider 定价（`bI`，按 provider 分组）

| 模型                                | provider  | prompt | completion | cache write 5m | cache write 1h | cache hit |
| ----------------------------------- | --------- | ------ | ---------- | -------------- | -------------- | --------- |
| anthropic:claude-sonnet-5           | Anthropic | 2      | 10         | 2.5            | 4              | 0.2       |
| anthropic:claude-sonnet-4-6         | Anthropic | 3      | 15         | 3.75           | 6              | 0.3       |
| anthropic:claude-fable-5            | Anthropic | 10     | 50         | 12.5           | 20             | 1         |
| anthropic:claude-opus-5             | Anthropic | 5      | 25         | 6.25           | 10             | 0.5       |
| anthropic:claude-opus-4-8           | Anthropic | 5      | 25         | 6.25           | 10             | 0.5       |
| anthropic:claude-opus-4-7           | Anthropic | 5      | 25         | 6.25           | 10             | 0.5       |
| anthropic:claude-opus-4-6           | Anthropic | 5      | 25         | 6.25           | 10             | 0.5       |
| anthropic:claude-haiku-4-5-20251001 | Anthropic | 1      | 5          | 1.25           | 2              | 0.1       |
| openai:gpt-5.6-sol                  | OpenAI    | 5      | 30         | 6.25           | 0              | 0.5       |
| openai:gpt-5.6-terra                | OpenAI    | 2      | 12         | 2.5            | 0              | 0.2       |
| openai:gpt-5.6-luna                 | OpenAI    | 0.2    | 1.2        | 0.25           | 0              | 0.02      |
| openai:gpt-5.5                      | OpenAI    | 5      | 30         | 0              | 0              | 0.5       |
| openai:gpt-5.4                      | OpenAI    | 2.5    | 15         | 0              | 0              | 0.25      |
| openai:gpt-5.3-codex                | OpenAI    | 2      | 8          | 0              | 0              | 0.5       |
| openai:gpt-5.4-mini                 | OpenAI    | 0.75   | 4.5        | 0              | 0              | 0.075     |
| baseten:zai-org/GLM-5               | Baseten   | 0.95   | 3.15       | 0              | 0              | 0         |
| baseten:moonshotai/Kimi-K2.5        | Baseten   | 0.6    | 3          | 0              | 0              | 0         |
| baseten:moonshotai/Kimi-K2.6        | Baseten   | 0.95   | 4          | 0              | 0              | 0.16      |
| baseten:MiniMaxAI/MiniMax-M2.5      | Baseten   | 0.5    | 2          | 0              | 0              | 0         |

### 网关定价（`II`，取 order[0] 主上游）

| 模型                                | 主上游     | prompt | completion | cache read          |
| ----------------------------------- | ---------- | ------ | ---------- | ------------------- |
| zai-org/GLM-5                       | deepinfra  | 0.8    | 2.56       | 0.16                |
| zai-org/GLM-5.2                     | novita     | 1.4    | 4.4        | 0.26                |
| zai-org/GLM-5.2-Fast                | wafer      | 3      | 10.25      | 0.5                 |
| zai-org/GLM-5.1                     | deepinfra  | 1.4    | 4.4        | 0.26                |
| moonshotai/Kimi-K3                  | moonshotai | 3      | 15         | 0.3                 |
| moonshotai/Kimi-K2.5                | moonshotai | 0.6    | 3          | 0.1                 |
| moonshotai/Kimi-K2.6                | moonshotai | 0.95   | 4          | 0.16                |
| moonshotai/Kimi-K2.7-Code           | moonshotai | 0.95   | 4          | 0.19                |
| moonshotai/Kimi-K2.7-Code-Highspeed | moonshotai | 1.9    | 8          | 0.38                |
| MiniMaxAI/MiniMax-M2.5              | deepinfra  | 0.3    | 1.2        | 0.03                |
| deepseek/deepseek-v4-pro            | deepseek   | 0.435  | 0.87       | 0.003625            |
| deepseek/deepseek-v4-flash          | deepseek   | 0.14   | 0.28       | 0.0028              |
| Qwen/Qwen3.6-Max-Preview            | alibaba    | 1.3    | 7.8        | 0.26 (write 1.63)   |
| Qwen/Qwen3.6-Plus                   | fireworks  | 0.5    | 3          | 0.1                 |
| Qwen/Qwen3.7-Max                    | alibaba    | 2.5    | 7.5        | 0.5 (write 3.13)    |
| Qwen/Qwen3.7-Plus                   | alibaba    | 0.4    | 1.6        | 0.08 (write 0.5)    |
| Qwen/Qwen3.8-Max                    | alibaba    | 2      | 6          | 0.25 (write 2.5)    |
| Qwen/Qwen3.7-Flash                  | alibaba    | 0.03   | 0.13       | 0.006 (write 0.038) |
| MiniMaxAI/MiniMax-M3                | minimax    | 0.3    | 1.2        | 0.06                |
| MiniMaxAI/MiniMax-M2.7              | fireworks  | 0.3    | 1.2        | 0.06                |
| xiaomi/mimo-v2.5-pro                | xiaomi     | 0.435  | 0.87       | 0.0036              |
| xiaomi/mimo-v2.5                    | xiaomi     | 0.14   | 0.28       | 0.0028              |
| stepfun/Step-3.7-Flash              | stepfun    | 0.2    | 1.15       | 0.04                |
| google/gemini-3.6-flash             | vertex     | 1.5    | 7.5        | 0.15                |
| google/gemini-3.5-flash             | vertex     | 1.5    | 9          | 0.15                |
| google/gemini-3.5-flash-lite        | vertex     | 0.3    | 2.5        | 0.03                |
| google/gemini-3.1-flash-lite        | vertex     | 0.25   | 1.5        | 0.03                |
| nvidia/nemotron-3-ultra-550b-a55b   | baseten    | 0.6    | 2.4        | 0.12                |
| thinkingmachines/inkling            | baseten    | 1      | 4.05       | 0.17                |
| thinkingmachines/inkling-small      | baseten    | 0.5    | 1.2        | 0.1                 |
| sakana/fugu-ultra                   | sakana     | 5      | 30         | 0.5                 |
| xai/grok-4.5                        | xai        | 2      | 6          | 0.5                 |
| meta/muse-spark-1.1                 | meta       | 1.25   | 4.25       | 0.15                |
| tencent/hy3-paid                    | novita     | 0.14   | 0.58       | 0.035               |
| poolside/laguna-s-2.1-free          | poolside   | 0      | 0          | 0                   |
| inclusionai/ling-3.0-flash-free     | novita     | 0      | 0          | 0                   |

### OpenRouter 定价（`AI`）

| 模型                   | openrouter slug        | 主上游   | prompt | completion | cache read         |
| ---------------------- | ---------------------- | -------- | ------ | ---------- | ------------------ |
| stepfun/Step-3.5-Flash | stepfun/step-3.5-flash | parasail | 0.1    | 0.3        | 0.02               |
| tencent/Hy3            | tencent/hy3:free       | novita   | 0      | 0          | 0                  |
| gpt-5.6-terra          | openai/gpt-5.6-terra   | openai   | 1      | 6          | 0.1 (write 1.25)   |
| gpt-5.6-luna           | openai/gpt-5.6-luna    | openai   | 0.1    | 0.6        | 0.01 (write 0.125) |

## 8. Provider 别名（xI 表）

同一 canonical 模型在不同 provider 下的 slug：

| canonical ID                        | vercel-ai-gateway                   | baseten                | cloudflare                          |
| ----------------------------------- | ----------------------------------- | ---------------------- | ----------------------------------- |
| zai-org/GLM-5                       | zai/glm-5                           | zai-org/GLM-5          | –                                   |
| zai-org/GLM-5.2                     | zai/glm-5.2                         | –                      | –                                   |
| zai-org/GLM-5.2-Fast                | zai/glm-5.2-fast                    | –                      | –                                   |
| zai-org/GLM-5.1                     | zai/glm-5.1                         | –                      | –                                   |
| moonshotai/Kimi-K3                  | moonshotai/kimi-k3                  | –                      | –                                   |
| moonshotai/Kimi-K2.5                | moonshotai/kimi-k2.5                | moonshotai/Kimi-K2.5   | workers-ai/@cf/moonshotai/kimi-k2.5 |
| moonshotai/Kimi-K2.6                | moonshotai/kimi-k2.6                | moonshotai/Kimi-K2.6   | workers-ai/@cf/moonshotai/kimi-k2.6 |
| moonshotai/Kimi-K2.7-Code           | moonshotai/kimi-k2.7-code           | –                      | –                                   |
| moonshotai/Kimi-K2.7-Code-Highspeed | moonshotai/kimi-k2.7-code-highspeed | –                      | –                                   |
| MiniMaxAI/MiniMax-M2.5              | minimax/minimax-m2.5                | MiniMaxAI/MiniMax-M2.5 | –                                   |
| deepseek/deepseek-v4-pro            | deepseek/deepseek-v4-pro            | –                      | –                                   |
| deepseek/deepseek-v4-flash          | deepseek/deepseek-v4-flash          | –                      | –                                   |
| Qwen/Qwen3.6-Max-Preview            | alibaba/qwen-3.6-max-preview        | –                      | –                                   |
| Qwen/Qwen3.6-Plus                   | alibaba/qwen3.6-plus                | –                      | –                                   |
| Qwen/Qwen3.7-Max                    | alibaba/qwen3.7-max                 | –                      | –                                   |
| Qwen/Qwen3.7-Plus                   | alibaba/qwen3.7-plus                | –                      | –                                   |
| Qwen/Qwen3.7-Flash                  | alibaba/qwen3.7-flash               | –                      | –                                   |
| Qwen/Qwen3.8-Max                    | alibaba/qwen3.8-max                 | –                      | –                                   |
| MiniMaxAI/MiniMax-M3                | minimax/minimax-m3                  | –                      | –                                   |
| MiniMaxAI/MiniMax-M2.7              | minimax/minimax-m2.7                | –                      | –                                   |
| stepfun/Step-3.7-Flash              | stepfun/step-3.7-flash              | –                      | –                                   |
| poolside/laguna-s-2.1-free          | poolside/laguna-s-2.1-free          | –                      | –                                   |
| inclusionai/ling-3.0-flash-free     | inclusionai/ling-3.0-flash-free     | –                      | –                                   |

## 9. 关键结论

1. **模型目录完全硬编码在 CLI 中**（`MI` 常量），共 53 个模型，不随运行时动态拉取。
2. **默认模型是 `deepseek/deepseek-v4-flash`**（`qn`/`OI` 常量），与线上捕获到的路由结果一致。
3. **两种 API 规格并存**：Anthropic 和开源模型走 `chatComplete`，OpenAI 系列走 `responses`。
4. **3 个隐藏模型**：MiniMax M3 Free、Tencent Hy3 (Free)、Ling 3.0 Flash Free（后者的隐藏由日期函数决定，2026-08-03 起生效）。
5. **旧模型 ID 自动替换**：6 个历史 ID（如 `claude-sonnet-4-20250514`）会解析到当前目录中的新 ID。
6. **推理档位是模型级属性**：不是所有模型都支持，且档位集合各不相同（如 DeepSeek 只有 high/max，Gemini 只有 low/medium/high）。
7. **定价分三张表**：直连（`bI`）、网关（`II`，多上游可选按 order 取主）、OpenRouter（`AI`），价格单位均为每百万 token USD。