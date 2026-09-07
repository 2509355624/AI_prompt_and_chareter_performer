# Mnemosyne · AI 角色扮演引擎

> 基于 RAG 长期记忆的 AI 角色扮演系统：角色定制 · 情感分析 · 自动生图 · 记忆检索与冲突裁决
>
> Local-first：本地部署，局域网访问，手机/平板同 Wi-Fi 直连。

---

## 架构总览

```
用户消息
  │
  ├──→ RAG 检索（BGE-M3 + ChromaDB + MMR）
  │         检索 top-4 长期记忆，注入情感分析 + 对白生成
  │
  ├──→ ① 情感 AI ── 分析用户情绪，给出语气/回复要点建议
  ├──→ ② 对白 AI ── 角色 systemPrompt + 情绪 + 记忆 → 生成回复
  └──→ ③ 生图 AI ── 对白 + continuity → 服饰/分镜 tags → ComfyUI 出图
                                          ↓
              每 5 轮 AI 回复 ──→ 情节提取 LLM ──→ 向量化入库
```

**核心设计**：对话超过上下文窗口后，靠 RAG 检索早期用户自述事实，而非把全部历史塞进上下文。

---

## 技术栈

| 层 | 技术 |
|----|------|
| **RAG 记忆** | BGE-M3 向量化 · ChromaDB 持久化 · MMR 多样性去重 · 记忆冲突裁决 |
| **LLM** | 火山豆包 / DeepSeek / Ollama（多 Provider 运行时切换） |
| **出图** | ComfyUI + GPU 队列调度 + 显存门槛 + SSE 实时进度 |
| **后端** | Node.js + Express + SSE 流式推送 |
| **前端** | 原生 Web（贴纸手帐风）+ Flutter 客户端（移动端） |
| **RAG daemon** | Python（sentence-transformers + chromadb + torch） |

---

## 功能模块

### 🎭 角色扮演（核心）

- 自定义角色：性格 systemPrompt + 外观 appearancePrompt + 服饰 outfitPrompt
- 多轮对话 + 情感分析 + 自动出图（对白先生成，再据内容出图，避免错位）
- 上下文窗口 6 轮（12 条消息），与 RAG ingest 间隔（5 轮）对齐，消除失忆区
- 记忆冲突裁决：长期自述事实 vs 近期对话话题，事实询问以长期为准
- MMR 检索：从候选池 20 条中按多样性选 top-4，避免小记忆库重复命中
- A/B 开关：`ragRuling=legacy|fixed`，请求级切换无需重启
- 调试日志：查询日志可查看 RAG 检索语句、命中结果、发送给 AI 的完整 messages

### 🖼️ ComfyUI 图片生成

- 对话内自动出图 + 独立批量生图
- 固定工作流拓扑：1 Checkpoint + 3 LoRA 槽位 + BatchPromptImageGenerator
- 可配置采样参数、高清修复、负向提示词
- GPU 队列异步执行，Ollama 占显存时自动等待

### 🔧 辅助工具

- 图片边框：批量加小红书贴纸框，底部文案可改
- 图片切分：左右对半切，分屏素材制作
- 提示词生成：主题 → 英文 SD/MJ 提示词批量输出

---

## 快速开始

```bash
npm install
cp .env.example .env   # 填入 API Key、ComfyUI 地址等
npm start
```

**Windows 一键启动**：双击 `启动项目.bat`（清理旧进程 + 启动服务）。ComfyUI（8188）需另行启动。

浏览器打开：

- 本机：<http://localhost:3000>
- 角色扮演：<http://localhost:3000/character.html>

启动后控制台打印局域网地址（监听 `0.0.0.0`），手机同 Wi-Fi 可访问。防火墙需放行入站 TCP 3000。

---

## RAG 长期记忆

角色对话超过上下文窗口后，模型会忘记早期你亲口说过的偏好与约定。RAG 系统把历史对话**每 5 次 AI 回复提炼为结构化记忆**（区分 user/character/shared 发言归属 + 主题标签），本地向量化入库；每轮对话按当前用户消息检索最相关的 4 条记忆，同时注入情感分析与对白生成两个阶段。

> 本质是"检索"而不是"记住"：不把全部历史塞进上下文，而是需要时把相关旧信息捞回来当依据。

**默认关闭**。开启需要向量模型（BGE-M3）就绪。

### 开启步骤

1. `.env` 设 `RAG_ENABLED=1`
2. 准备向量模型（三选一）：
   - 自动下载：`RAG_AUTO_DOWNLOAD=1`，首次启动自动下载 BGE-M3
   - 手动下载：`python -c "from modelscope import snapshot_download; snapshot_download('BAAI/bge-m3')"`
   - 本地目录：`LOCAL_EMBEDDING_MODEL` 指向模型绝对路径
3. 重启服务，日志出现 `[RAG] daemon ready (local BGE-M3)` 即成功
4. 为已有角色重建记忆：`node scripts/rebuild_rag_character.js <characterId>`

**页面开关**：角色扮演页右上角「🧠 RAG」按钮可在前端开关。

环境要求：Python + `rag/requirements.txt`（sentence-transformers、chromadb、modelscope、torch）。

---

## 环境变量（.env）

| 变量 | 说明 |
|------|------|
| `PORT` | 服务端口，默认 `3000` |
| `COMFYUI_URL` | ComfyUI 地址，默认 `http://127.0.0.1:8188` |
| `COMFYUI_TIMEOUT_MS` | 单次出图超时（毫秒） |
| `COMFYUI_CHECKPOINT` | 默认 Checkpoint 文件名 |
| `IMAGE_MIN_VRAM_MB` | Ollama 场景下出图前最小空闲显存（MB） |
| `VOLC_*` | 火山引擎 / Doubao |
| `DEEPSEEK_*` | DeepSeek |
| `RAG_ENABLED` | RAG 总开关，默认 `0` |
| `RAG_AUTO_DOWNLOAD` | `1` 时允许自动下载向量模型 |
| `LOCAL_EMBEDDING_MODEL` | 嵌入模型路径 |
| `RAG_EMBED_DEVICE` / `RAG_DATA_DIR` | 嵌入设备（cuda/cpu）与向量库目录 |
| `RAG_INGEST_EVERY_ASSISTANT_REPLIES` | ingest 间隔轮次，默认 `5` |
| `SKIP_TURN_BRIEF` | 是否跳过轮次摘要，默认 `1`（跳过） |

**勿将 `.env`、API Key、本地对话历史提交到 git。**

---

## 主要 API

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
| GET | `/api/comfy/workflow-options` | Checkpoint / LoRA 列表 |
| GET | `/api/comfy/health` | ComfyUI 连通性 |

---

## 项目结构

```text
server.js              Express 入口，LAN 0.0.0.0
ai_service.js          情感 / 对白 / 生图三阶段 + RAG 检索 + 冲突裁决
comfy_client.js        加载工作流模板并注入参数
chat_image_config.js    Comfy 默认采样与 LoRA
rag/
  store.py              ChromaDB 持久化 + MMR 检索
  rag_daemon.py         BGE-M3 向量化 daemon
  rag_service.js        Node↔Python 桥接 + ingest 调度
workflows/
  character_bust.json   角色出图 API 工作流模板
public/
  character.html        角色扮演 UI
  index.html            首页导航
  styles/               贴纸手帐风样式
data/
  characters.json       角色模板
  chat_history.json     本地对话（gitignore）
  rag/                  ChromaDB + ingest 水位
gpu_scheduler/          出图队列、显存等待、SSE
```

---

## 常见问题

**Q：手机打不开局域网地址？**
同一 Wi-Fi、防火墙放行 3000、用控制台打印的 `http://192.168.x.x:3000/character.html`。

**Q：有回复但没有图？**
检查 ComfyUI 是否运行、`COMFYUI_URL` 是否正确、BatchPromptImageGenerator 是否安装、Checkpoint/LoRA 文件名是否一致。

**Q：RAG 开了但记忆不准？**
检查查询日志（对话页"查询日志"按钮）里的 RAG 检索结果，确认检索语句和命中记忆是否相关。记忆库小时结果会重复，随对话累积会改善。

---

## License

Private / local use.
