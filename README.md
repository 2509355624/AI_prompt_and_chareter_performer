# AI 工具中心 / Picture Prompt Produce

本地 Web 服务：AI 绘图提示词生成 + **ComfyUI 角色扮演**（对话、情感分析、自动出图）。  
适合单人局域网使用：电脑跑服务与 ComfyUI，手机 / iPad 同 Wi‑Fi 访问聊天页。

---

## 功能概览

| 模块 | 页面 | 说明 |
|------|------|------|
| 工具首页 | `/` → `index.html` | 入口导航 |
| 提示词生成 | `prompt.html` | 根据主题批量生成 SD/MJ 英文提示词 |
| 角色扮演 | **`character.html`** | 选角色 → 多轮对话 → ComfyUI 出图 |
| 其他 | `split.html` 等 | 辅助工具 |

本文档重点说明 **角色扮演 + ComfyUI**；提示词生成与首页用法见各页面内说明。

---

## 环境要求

- [Node.js](https://nodejs.org/)（运行本服务）
- 对话 AI：火山引擎 Doubao / DeepSeek / OpenAI 兼容 API / 本地 [Ollama](https://ollama.com/)
- 出图：[ComfyUI](https://github.com/comfyanonymous/ComfyUI) 已启动，且安装自定义节点 **BatchPromptImageGenerator**（工作流 `workflows/character_bust.json` 依赖此节点）
- （可选）NVIDIA GPU；本地 Ollama + Comfy 同时跑时，服务会按显存门槛排队出图

---

## 快速开始

```bash
npm install
cp .env.example .env   # 填入 API Key、ComfyUI 地址等
npm start
```

浏览器打开：

- 本机：<http://localhost:3000>
- 角色扮演：<http://localhost:3000/character.html>

启动后控制台会打印 **局域网地址**（服务监听 `0.0.0.0`），手机在同一 Wi‑Fi 下可访问，例如：

```text
LAN access (same Wi‑Fi):
  http://192.168.x.x:3000/character.html
```

若手机无法访问，请在 Windows 防火墙中放行 **入站 TCP 3000**（专用网络）。

---

## 角色扮演（character.html）

### 界面布局

- **左侧**：角色列表（贴纸卡片），新建 / 编辑角色
- **中间**：与当前角色的对话、配图、调试信息
- **右侧**：配置贴纸 — AI Provider、Comfy 出图参数、强制提示词等

**手机 / 窄屏（≤1100px）**：自动进入「对话优先」布局 — 全屏聊天，👤 打开角色抽屉，⚙️ 打开配置抽屉，··· 为导出 / 编辑等次要操作。底部输入栏固定，不会被长对话顶出屏幕。

桌面宽屏右上角 **📱** 可强制预览手机布局。

### 一轮对话的处理流程

```text
① 情感 AI   → 分析用户情绪，给出对白语气建议（tone / keyPoints）
② 文本 AI   → 仅根据角色设定 + 情绪 + 记忆生成角色回复
③ 生图 AI   → 对白完成后，根据「本轮用户 + 本轮回复 + 上一轮 continuity」生成 SD tags
④ 代码层    → 角色 appearancePrompt（底模）+ 本轮 tags → ComfyUI 出图
```

要点：

- 生图在对白**之后**，避免「还没说站起来，图里已经坐好」的错位
- continuity 快照只继承 **服饰 + 抽象场景/氛围**，不复制上一轮动作或道具 tag（如 tablet、desk）
- 对白系统提示词可带 **当前穿着**（叙事用），与出图 tags 分离

### 角色数据

| 字段 | 用途 |
|------|------|
| `systemPrompt` | 角色性格与对白风格 |
| `appearancePrompt` | Comfy **底模**正向前缀（发色、画风 tag 等，每轮都拼上） |
| `outfitPrompt` | 可选，默认服饰补充 |
| `personality` / `description` | 展示与编辑用 |

角色列表默认：`data/characters.json`（可提交模板角色）。  
本地私有角色可放 `data/characters.local.json`（已在 `.gitignore`，不会进 git）。

对话与配图历史：`data/chat_history.json`（本地运行时写入，默认不提交）。

---

## ComfyUI 出图

### 工作流结构

固定模板：`workflows/character_bust.json`（API 格式，非 UI 拖拽导出）。

| 节点 | 类型 | 作用 |
|------|------|------|
| `4` | CheckpointLoaderSimple | **主模型**（1 个） |
| `25` → `24` → `19` | LoraLoader 串联 | **LoRA 槽位 3 个**（名称 + model/clip 强度） |
| `53` | BatchPromptImageGenerator | `base_prompt` + `multi_prompts`（底模 + 本轮 tags） |
| `7` | CLIPTextEncode | 负向提示词 |
| `9` | SaveImage | 保存出图 |

服务端 `comfy_client.js` 的 `buildPromptGraph()` 在每轮出图时写入上述节点；**不是**通用「拖任意 Comfy 工作流」解析器。

### 右侧配置项（与代码默认值）

与 `chat_image_config.js` / `.env` 一致，可在页面调整并 **存为预设**（浏览器 localStorage）：

- **Checkpoint**：主模型文件名
- **LoRA 1～3**：名称、Model 强度、CLIP 强度（选 `(none)` 或强度 0 即关闭）
- **宽高、Steps、CFG、Sampler、Scheduler、Denoise、Seed**
- **高清修复 Hires**（可选）
- **负向提示词**

默认主模型示例：`unholyDesireMixSinister_v70.safetensors`  
默认 LoRA 示例见 `chat_image_config.js` 中 `loras` 数组。

下拉列表来自 ComfyUI 的 `object_info`（需 Comfy 在线）；离线时使用配置里的默认值。

### 提示词如何拼进 Comfy

```text
base_prompt    ← 角色 appearancePrompt（+ 可选 outfitPrompt / 风格前缀）
multi_prompts  ← 本轮 visual.prompt（服饰、动作、表情、场景、氛围、机位等英文 tags）
negative       ← 右侧负向提示词或 chat_image_config.negativePrompt
```

出图任务经 GPU 队列异步执行；Ollama 占用显存时会等待 VRAM 释放后再跑 Comfy（见 `IMAGE_MIN_VRAM_MB`）。

---

## 环境变量（.env）

复制 `.env.example` 后按需修改：

| 变量 | 说明 |
|------|------|
| `PORT` | 本服务端口，默认 `3000` |
| `COMFYUI_URL` | ComfyUI 地址，默认 `http://127.0.0.1:8188` |
| `COMFYUI_TIMEOUT_MS` | 单次出图超时（毫秒） |
| `COMFYUI_CHECKPOINT` | 默认 Checkpoint 文件名 |
| `IMAGE_MIN_VRAM_MB` | Ollama 场景下出图前要求的最小空闲显存（MB） |
| `VOLC_*` | 火山引擎 / Doubao |
| `DEEPSEEK_*` | DeepSeek |
| Ollama | 页面选 Local Ollama，Base URL 默认 `http://localhost:11434` |

**勿将 `.env`、真实 API Key、本地对话历史提交到 git。**

---

## 主要 API（角色扮演相关）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/characters` | 角色列表 |
| POST | `/api/characters` | 创建/更新角色 |
| GET | `/api/chat-history/:characterId` | 读取对话 |
| POST | `/api/chat-history/:characterId` | 保存对话 |
| POST | `/api/chat-turn` | 发起一轮对话（SSE 流式） |
| GET | `/api/chat-turn/:id/stream` | 订阅流式事件 |
| POST | `/api/character-image` | 提交出图任务 |
| GET | `/api/image-jobs/:id/stream` | 出图进度 |
| GET | `/api/comfy/workflow-options` | Checkpoint / LoRA 列表与默认工作流参数 |
| GET | `/api/comfy/health` | ComfyUI 连通性 |

---

## 项目结构（简要）

```text
server.js              Express 入口，LAN 0.0.0.0
ai_service.js          情感 / 对白 / 生图 tag 三阶段逻辑
comfy_client.js        加载 character_bust.json 并注入参数
chat_image_config.js   Comfy 默认采样与 LoRA
workflows/
  character_bust.json  角色出图 API 工作流模板
public/
  character.html       角色扮演 UI
  styles/              贴纸风样式 + 手机布局
data/
  characters.json      角色模板（可提交）
  chat_history.json    本地对话（gitignore）
gpu_scheduler/         出图队列、显存等待、SSE
```

---

## 提示词生成（首页 / prompt.html）

- 支持 Ollama 或 OpenAI 兼容 API
- 输入主题，输出 JSON 数组形式的英文 SD 提示词
- 与角色扮演独立，不经过 ComfyUI

---

## 常见问题

**Q：手机打不开局域网地址？**  
同一 Wi‑Fi、防火墙放行 3000、用控制台打印的 `http://192.168.x.x:3000/character.html`。

**Q：有回复但没有图？**  
检查 ComfyUI 是否运行、`COMFYUI_URL` 是否正确、是否安装 BatchPromptImageGenerator、Checkpoint/LoRA 文件名是否与 Comfy 的 models 目录一致。

**Q：能否拖自己的 Comfy 工作流 JSON？**  
当前版本 **不支持**；仅使用 `workflows/character_bust.json` 固定拓扑（1 Checkpoint + 3 LoRA）。自定义工作流属于后续规划。

**Q：README 和实际代码不一致？**  
以仓库内 `ai_service.js`、`comfy_client.js`、`character.html` 为准；大改流程后请同步更新本文档。

---

## License

Private / local use. 按你本地约定使用即可。
