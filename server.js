const express = require('express');
const bodyParser = require('body-parser');
const aiService = require('./ai_service');
const comfyClient = require('./comfy_client');
const imagePrompt = require('./image_prompt');
const chatImageConfig = require('./chat_image_config');
const AsyncQueue = require('./gpu_scheduler/async_queue');
const ImageJobStore = require('./gpu_scheduler/image_job_store');
const ChatTurnStore = require('./gpu_scheduler/chat_turn_store');
const { startImageWorker } = require('./gpu_scheduler/image_worker');
const { processChatTurn } = require('./gpu_scheduler/chat_turn_runner');
const { runCharacterImageJob } = require('./gpu_scheduler/character_image_runner');
const ollamaGuard = require('./gpu_scheduler/ollama_guard');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
const chatImagesDir = path.join(uploadsDir, 'chat_images');
if (!fs.existsSync(chatImagesDir)) {
    fs.mkdirSync(chatImagesDir, { recursive: true });
}

// Middleware
app.use(bodyParser.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
app.use(express.urlencoded({ extended: true }));
app.use(express.raw({ type: 'multipart/form-data', limit: '10mb' }));

// Presets Management
const PRESETS_FILE = path.join(dataDir, 'presets.json');
const CHARACTERS_FILE = path.join(dataDir, 'characters.json');
const CHAT_HISTORY_FILE = path.join(dataDir, 'chat_history.json');
const EMOTION_HISTORY_FILE = path.join(dataDir, 'emotion_history.json');

const imageQueue = new AsyncQueue();
const imageJobStore = new ImageJobStore();
const chatTurnStore = new ChatTurnStore();

startImageWorker({
    queue: imageQueue,
    jobStore: imageJobStore,
    runCharacterImageJob: (payload) => runCharacterImageJob(payload, {
        charactersFile: CHARACTERS_FILE,
        chatImagesDir
    })
}).catch((err) => console.error('[ImageWorker] fatal:', err));

// Ensure data files exist
if (!fs.existsSync(PRESETS_FILE)) {
    fs.writeFileSync(PRESETS_FILE, '[]', 'utf8');
}
if (!fs.existsSync(CHARACTERS_FILE)) {
    fs.writeFileSync(CHARACTERS_FILE, '[]', 'utf8');
}
if (!fs.existsSync(CHAT_HISTORY_FILE)) {
    fs.writeFileSync(CHAT_HISTORY_FILE, '{}', 'utf8');
}
if (!fs.existsSync(EMOTION_HISTORY_FILE)) {
    fs.writeFileSync(EMOTION_HISTORY_FILE, '{}', 'utf8');
}

app.get('/api/presets', (req, res) => {
    try {
        const data = fs.readFileSync(PRESETS_FILE, 'utf8');
        res.json(JSON.parse(data || '[]'));
    } catch (e) {
        res.status(500).json({ error: 'Failed to load presets' });
    }
});

app.post('/api/presets', (req, res) => {
    try {
        const { id, name, content } = req.body;
        const data = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8') || '[]');
        
        const newPreset = {
            id: id || Date.now().toString(),
            name: name || '未命名',
            content: content
        };

        // If ID exists, update; else add
        const existingIndex = data.findIndex(p => p.id === newPreset.id);
        if (existingIndex >= 0) {
            data[existingIndex] = newPreset;
        } else {
            data.push(newPreset);
        }

        fs.writeFileSync(PRESETS_FILE, JSON.stringify(data, null, 2));
        res.json(newPreset);
    } catch (e) {
        res.status(500).json({ error: 'Failed to save preset' });
    }
});

app.delete('/api/presets/:id', (req, res) => {
    try {
        const { id } = req.params;
        let data = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8') || '[]');
        data = data.filter(p => p.id !== id);
        fs.writeFileSync(PRESETS_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete preset' });
    }
});

// Characters Management
app.get('/api/characters', (req, res) => {
    try {
        let data = JSON.parse(fs.readFileSync(CHARACTERS_FILE, 'utf8') || '[]');
        // If empty, initialize with default characters
        if (data.length === 0) {
            data = [
                {
                    id: 'izumi_sagiri',
                    name: '和泉纱雾',
                    description: '《埃罗芒阿老师》女主角，害羞的插画师',
                    avatar: '👩‍🎨',
                    personality: '害羞、内向、温柔、有点傲娇',
                    appearancePrompt: imagePrompt.DEFAULT_APPEARANCE.izumi_sagiri,
                    outfitPrompt: '',
                    referenceImage: '',
                    systemPrompt: '你是一个名叫和泉纱雾的女孩，你是《埃罗芒阿老师》的女主角。你是一个害羞内向的初中女生，同时也是一位天才插画师。你平时很怕生，但在熟悉的人面前会展现出温柔可爱的一面。说话时带着少女的羞涩感，偶尔会有一点傲娇。你喜欢画画，经常待在家里工作。请用符合纱雾性格的语气和用户交流，保持可爱、害羞但又温柔的特点。',
                    createdAt: Date.now()
                },
                {
                    id: 'rem',
                    name: '雷姆',
                    description: '《Re:从零开始的异世界生活》中的鬼族女仆',
                    avatar: '👻',
                    personality: '忠诚、温柔、坚强、 devoted',
                    appearancePrompt: imagePrompt.DEFAULT_APPEARANCE.rem,
                    outfitPrompt: '',
                    referenceImage: '',
                    systemPrompt: '你是雷姆，来自《Re:从零开始的异世界生活》的鬼族女仆。你对主人绝对忠诚，说话温柔有礼，但内心坚强勇敢。你称呼对方为「昴君」或「主人」，总是以谦逊的态度服务他人。你喜欢甜食，擅长家务和战斗。请用雷姆特有的温柔、忠诚、谦逊的语气交流，展现出女仆的优雅和鬼族的力量。',
                    createdAt: Date.now()
                },
                {
                    id: 'asuna',
                    name: '亚丝娜',
                    description: '《刀剑神域》女主角，闪光的亚丝娜',
                    avatar: '⚔️',
                    personality: '温柔、坚强、善良、有领导力',
                    appearancePrompt: imagePrompt.DEFAULT_APPEARANCE.asuna,
                    outfitPrompt: '',
                    referenceImage: '',
                    systemPrompt: '你是亚丝娜，来自《刀剑神域》的女主角，被称为「闪光」的剑士。你性格温柔善良，但面对战斗时坚强勇敢。你擅长烹饪，关心朋友，对爱人专一深情。说话时语气优雅但不失亲和力。请用符合亚丝娜性格的方式交流，展现出温柔坚强的大小姐气质。',
                    createdAt: Date.now()
                },
                {
                    id: 'mikasa',
                    name: '三笠·阿克曼',
                    description: '《进击的巨人》女主角，强大的战士',
                    avatar: '🗡️',
                    personality: '冷静、强大、忠诚、外冷内热',
                    appearancePrompt: imagePrompt.DEFAULT_APPEARANCE.mikasa,
                    outfitPrompt: '',
                    referenceImage: '',
                    systemPrompt: '你是三笠·阿克曼，来自《进击的巨人》。你是人类最强的士兵之一，性格冷静沉着，平时话不多但内心充满感情。你非常重视重要的人，尤其是艾伦。你外表看起来有些冷淡，但实际上非常关心他人。请用符合三笠性格的语气交流，保持冷静、简洁但充满关怀的特点。',
                    createdAt: Date.now()
                },
                {
                    id: 'saber',
                    name: 'Saber',
                    description: '《Fate》系列中的骑士王',
                    avatar: '👑',
                    personality: '正直、高贵、认真、有骑士精神',
                    appearancePrompt: imagePrompt.DEFAULT_APPEARANCE.saber,
                    outfitPrompt: '',
                    referenceImage: '',
                    systemPrompt: '你是 Saber，来自《Fate》系列的骑士王阿尔托莉雅·潘德拉贡。你是一位高贵正直的骑士王，性格认真严谨，有着强烈的荣誉感和骑士精神。你说话时语气庄重优雅，保持着王者的风范。你喜欢美食，尤其是日式料理。请用符合 Saber 身份和性格的语气交流，展现出骑士王的高贵与威严。',
                    createdAt: Date.now()
                }
            ];
            fs.writeFileSync(CHARACTERS_FILE, JSON.stringify(data, null, 2));
        }
        let changed = false;
        data = data.map((c) => {
            if (c.appearancePrompt && c.outfitPrompt !== undefined && c.referenceImage !== undefined) return c;
            changed = true;
            return {
                ...c,
                appearancePrompt: c.appearancePrompt || imagePrompt.DEFAULT_APPEARANCE[c.id] || '',
                outfitPrompt: c.outfitPrompt || '',
                referenceImage: c.referenceImage || '',
            };
        });
        if (changed) {
            fs.writeFileSync(CHARACTERS_FILE, JSON.stringify(data, null, 2));
        }
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Failed to load characters' });
    }
});

app.post('/api/characters', (req, res) => {
    try {
        const { id, name, description, avatar, personality, systemPrompt, appearancePrompt, outfitPrompt, referenceImage } = req.body;
        let data = JSON.parse(fs.readFileSync(CHARACTERS_FILE, 'utf8') || '[]');
        const existingIndex = id ? data.findIndex(c => c.id === id) : -1;
        const existing = existingIndex >= 0 ? data[existingIndex] : {};

        const newCharacter = {
            id: id || Date.now().toString(),
            name: name || existing.name || '未命名角色',
            description: description !== undefined ? description : (existing.description || ''),
            avatar: avatar || existing.avatar || '👤',
            personality: personality !== undefined ? personality : (existing.personality || ''),
            systemPrompt: systemPrompt !== undefined ? systemPrompt : (existing.systemPrompt || ''),
            appearancePrompt: appearancePrompt !== undefined ? appearancePrompt : (existing.appearancePrompt || imagePrompt.DEFAULT_APPEARANCE[id] || ''),
            outfitPrompt: outfitPrompt !== undefined ? outfitPrompt : (existing.outfitPrompt || ''),
            referenceImage: referenceImage !== undefined ? referenceImage : (existing.referenceImage || ''),
            createdAt: existing.createdAt || Date.now()
        };

        if (existingIndex >= 0) {
            data[existingIndex] = newCharacter;
        } else {
            data.push(newCharacter);
        }

        fs.writeFileSync(CHARACTERS_FILE, JSON.stringify(data, null, 2));
        res.json(newCharacter);
    } catch (e) {
        res.status(500).json({ error: 'Failed to save character' });
    }
});

app.delete('/api/characters/:id', (req, res) => {
    try {
        const { id } = req.params;
        let data = JSON.parse(fs.readFileSync(CHARACTERS_FILE, 'utf8') || '[]');
        data = data.filter(c => c.id !== id);
        fs.writeFileSync(CHARACTERS_FILE, JSON.stringify(data, null, 2));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete character' });
    }
});

// Chat History Management
app.get('/api/chat-history/:characterId', (req, res) => {
    try {
        const { characterId } = req.params;
        const chatData = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8') || '{}');
        const emotionData = JSON.parse(fs.readFileSync(EMOTION_HISTORY_FILE, 'utf8') || '{}');
        
        res.json({
            messages: Array.isArray(chatData[characterId]) ? chatData[characterId] : (chatData[characterId]?.messages || []),
            summary: chatData[characterId]?.summary || '',
            emotionHistory: emotionData[characterId] || []
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load chat history' });
    }
});

app.post('/api/chat-history/:characterId', (req, res) => {
    try {
        const { characterId } = req.params;
        const { messages, emotionHistory, summary } = req.body;
        
        // 保存干净的对话历史 + 摘要到 chat_history.json
        const chatData = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8') || '{}');
        const cleanMessages = messages.map(m => ({
            id: m.id,
            role: m.role,
            content: m.content,
            imageUrl: m.imageUrl || '',
            imageStatus: m.imageStatus || '',
            imageError: m.imageError || '',
            emotionAnalysis: m.emotionAnalysis,
            visual: m.visual || null,
            visualRefForAi: m.visualRefForAi || null,
            visualRefEdited: Boolean(m.visualRefEdited),
            imagePrompt: m.imagePrompt || '',
            imageTurnPrompt: m.imageTurnPrompt || '',
            imageNegative: m.imageNegative || '',
            checkpointName: m.checkpointName || '',
            timing: m.timing,
            debugInfo: m.debugInfo || null,
            imageJobId: m.imageJobId || ''
        }));
        // 兼容旧数据格式（纯数组）
        if (Array.isArray(chatData[characterId])) {
            delete chatData[characterId];
        }
        chatData[characterId] = {
            messages: cleanMessages,
            summary: summary || ''
        };
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chatData, null, 2));
        
        // 保存情感历史到 emotion_history.json
        if (emotionHistory) {
            const emotionData = JSON.parse(fs.readFileSync(EMOTION_HISTORY_FILE, 'utf8') || '{}');
            emotionData[characterId] = emotionHistory;
            fs.writeFileSync(EMOTION_HISTORY_FILE, JSON.stringify(emotionData, null, 2));
        }
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save chat history' });
    }
});

app.delete('/api/chat-history/:characterId', (req, res) => {
    try {
        const { characterId } = req.params;
        
        const chatData = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8') || '{}');
        delete chatData[characterId];
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chatData, null, 2));
        
        const emotionData = JSON.parse(fs.readFileSync(EMOTION_HISTORY_FILE, 'utf8') || '{}');
        delete emotionData[characterId];
        fs.writeFileSync(EMOTION_HISTORY_FILE, JSON.stringify(emotionData, null, 2));
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to clear chat history' });
    }
});

// Avatar Upload API
app.post('/api/upload-avatar', (req, res) => {
    try {
        // Simple file upload handling
        const boundary = req.headers['content-type'].split('boundary=')[1];
        const body = req.body.toString();
        
        // Extract file data
        const parts = body.split(`--${boundary}`);
        let fileData = null;
        let fileName = null;
        let characterId = null;
        
        parts.forEach(part => {
            if (part.includes('Content-Disposition: form-data')) {
                if (part.includes('name="avatar"')) {
                    // File part
                    const lines = part.split('\r\n');
                    const filenameLine = lines.find(line => line.includes('filename='));
                    if (filenameLine) {
                        fileName = filenameLine.split('"')[1];
                    }
                    // Find the start of file data
                    const dataStart = part.indexOf('\r\n\r\n') + 4;
                    fileData = part.substring(dataStart, part.length - 2); // Remove trailing \r\n
                } else if (part.includes('name="characterId"')) {
                    // Character ID part
                    const dataStart = part.indexOf('\r\n\r\n') + 4;
                    characterId = part.substring(dataStart, part.length - 2).trim();
                }
            }
        });
        
        if (!fileData || !fileName) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        // Generate filename
        const ext = path.extname(fileName);
        const finalFileName = `avatar_${characterId || Date.now()}${ext}`;
        const filePath = path.join(uploadsDir, finalFileName);
        
        // Write file
        fs.writeFileSync(filePath, fileData, 'binary');
        
        const avatarUrl = `/uploads/${finalFileName}`;
        res.json({ success: true, avatarUrl });
        
    } catch (e) {
        console.error('Avatar upload error:', e);
        res.status(500).json({ error: 'Failed to upload avatar' });
    }
});

// Chat API
app.post('/api/chat', async (req, res) => {
    const { messages, provider, apiKey, baseUrl, model } = req.body;
    try {
        const reply = await aiService.chatWithAI(messages, provider, model, apiKey, baseUrl);
        res.json({ reply });
    } catch (error) {
        console.error('Chat Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Emotion Analysis API
app.post('/api/analyze-emotion', async (req, res) => {
    const { messages, provider, apiKey, baseUrl, model } = req.body;
    try {
        const result = await aiService.analyzeEmotion(messages, provider, model, apiKey, baseUrl);
        res.json(result);
    } catch (error) {
        console.error('Emotion Analysis Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Chat with Emotion API (两轮调用 + 摘要)
app.post('/api/chat-with-emotion', async (req, res) => {
    const {
        messages,
        systemPrompt,
        provider,
        apiKey,
        baseUrl,
        model,
        conversationSummary,
        appearancePrompt,
        outfitPrompt,
        previousVisual
    } = req.body;
    try {
        const result = await aiService.chatWithEmotion(
            messages,
            systemPrompt,
            provider,
            model,
            apiKey,
            baseUrl,
            conversationSummary,
            appearancePrompt,
            outfitPrompt,
            previousVisual || null
        );
        if (provider === 'ollama') {
            try {
                await ollamaGuard.unloadAll(baseUrl);
            } catch (e) {
                console.warn('[Ollama] post-chat unload failed:', e.message);
            }
        }
        res.json(result);
    } catch (error) {
        console.error('Chat with Emotion Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/models', async (req, res) => {
    const { baseUrl } = req.query;
    try {
        const models = await aiService.getOllamaModels(baseUrl);
        res.json({ models });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/comfy/checkpoints', async (req, res) => {
    try {
        const checkpoints = await comfyClient.listCheckpoints();
        res.json({
            ok: true,
            checkpoints,
            defaultCheckpoint: chatImageConfig.checkpointName
        });
    } catch (error) {
        res.status(503).json({
            ok: false,
            checkpoints: [chatImageConfig.checkpointName],
            defaultCheckpoint: chatImageConfig.checkpointName,
            error: error.message
        });
    }
});

app.get('/api/comfy/workflow-options', async (req, res) => {
    const defaults = comfyClient.workflowDefaults();
    let checkpoints = [defaults.checkpointName];
    let loras = (defaults.loras || []).map((l) => l.name);
    try {
        checkpoints = await comfyClient.listCheckpoints();
    } catch (e) {}
    try {
        loras = await comfyClient.listLoras();
    } catch (e) {}
    res.json({
        ok: true,
        defaults,
        checkpoints,
        loras
    });
});

app.get('/api/comfy/health', async (req, res) => {
    try {
        const stats = await comfyClient.ping();
        res.json({ ok: true, url: chatImageConfig.comfyUrl, stats });
    } catch (error) {
        res.status(503).json({
            ok: false,
            url: chatImageConfig.comfyUrl,
            error: error.message
        });
    }
});

app.post('/api/comfy/test', async (req, res) => {
    const started = Date.now();
    const turnPrompt = (req.body && req.body.prompt) || chatImageConfig.testPromptTurn;
    const destName = `test_${Date.now()}.png`;
    const destPath = path.join(chatImagesDir, destName);
    try {
        const result = await comfyClient.generateToFile({
            basePrompt: `${chatImageConfig.stylePrefix}\n\n${chatImageConfig.testPromptBase}`,
            turnPrompt,
            negative: chatImageConfig.negativePrompt
        }, destPath);
        res.json({
            ok: true,
            imageUrl: `/uploads/chat_images/${destName}`,
            promptId: result.promptId,
            seed: result.seed,
            elapsedMs: Date.now() - started,
            prompt: `${chatImageConfig.testPromptBase}\n${turnPrompt}`
        });
    } catch (error) {
        console.error('Comfy test error:', error.message);
        res.status(502).json({
            ok: false,
            error: error.message,
            elapsedMs: Date.now() - started
        });
    }
});

app.post('/api/chat-turn', (req, res) => {
    const payload = req.body || {};
    if (!payload.messages || !Array.isArray(payload.messages)) {
        return res.status(400).json({ error: 'messages is required' });
    }
    const turn = chatTurnStore.createTurn(payload);
    processChatTurn({
        turnId: turn.id,
        turnStore: chatTurnStore,
        aiService,
        payload
    }).catch((err) => {
        console.error('[ChatTurn] unhandled:', err.message);
    });
    console.log('[ChatTurn] enqueued', turn.id);
    res.json({ ok: true, turnId: turn.id });
});

app.get('/api/chat-turn/:id/stream', (req, res) => {
    const turn = chatTurnStore.getTurn(req.params.id);
    if (!turn) {
        return res.status(404).json({ error: 'Turn not found' });
    }
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    chatTurnStore.subscribe(req.params.id, res);
});

app.post('/api/image-jobs', (req, res) => {
    const payload = req.body || {};
    if (!payload.characterId) {
        return res.status(400).json({ error: 'characterId is required' });
    }
    const job = imageJobStore.createJob({
        ...payload,
        skipLlmFallback: payload.provider === 'ollama'
    });
    imageQueue.push({ jobId: job.id });
    console.log('[ImageQueue] enqueued', job.id, 'queue size:', imageQueue.size);
    res.json({ ok: true, imageJobId: job.id, status: 'queued' });
});

app.get('/api/image-jobs/:id/stream', (req, res) => {
    const job = imageJobStore.getJob(req.params.id);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    imageJobStore.subscribe(req.params.id, res);
});

app.post('/api/image-jobs/:id/retry', (req, res) => {
    const job = imageJobStore.getJob(req.params.id);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status === 'running' || job.status === 'queued') {
        return res.status(409).json({ error: 'Job already in progress' });
    }
    imageJobStore.resetForRetry(req.params.id);
    imageQueue.push({ jobId: req.params.id });
    res.json({ ok: true, imageJobId: req.params.id, status: 'queued' });
});

app.post('/api/character-image', (req, res) => {
    const payload = req.body || {};
    if (!payload.characterId) {
        return res.status(400).json({ error: 'characterId is required' });
    }
    const job = imageJobStore.createJob({
        ...payload,
        skipLlmFallback: payload.provider === 'ollama'
    });
    imageQueue.push({ jobId: job.id });
    res.json({ ok: true, queued: true, imageJobId: job.id, status: 'queued' });
});

app.post('/api/character-image-sync', async (req, res) => {
    try {
        const result = await runCharacterImageJob(req.body || {}, {
            charactersFile: CHARACTERS_FILE,
            chatImagesDir
        });
        res.json(result);
    } catch (error) {
        console.error('Character image sync error:', error.message);
        res.status(502).json({ ok: false, error: error.message });
    }
});

app.post('/api/export-chat-strips', (req, res) => {
    const { folderPath, files } = req.body || {};
    if (!folderPath || typeof folderPath !== 'string') {
        return res.status(400).json({ error: 'folderPath is required' });
    }
    if (!Array.isArray(files) || !files.length) {
        return res.status(400).json({ error: 'files array is required' });
    }

    const resolved = path.resolve(folderPath.trim());
    try {
        if (!fs.existsSync(resolved)) {
            fs.mkdirSync(resolved, { recursive: true });
        }
    } catch (e) {
        return res.status(400).json({ error: `无法创建文件夹: ${e.message}` });
    }

    const saved = [];
    try {
        for (const file of files) {
            if (!file?.name || !file?.data) continue;
            const safeName = path.basename(String(file.name)).replace(/[^\w.\-]/g, '_');
            if (!safeName.toLowerCase().endsWith('.png')) continue;
            const base64 = String(file.data).replace(/^data:image\/\w+;base64,/, '');
            const buf = Buffer.from(base64, 'base64');
            fs.writeFileSync(path.join(resolved, safeName), buf);
            saved.push(safeName);
        }
    } catch (e) {
        return res.status(500).json({ error: `写入文件失败: ${e.message}` });
    }

    if (!saved.length) {
        return res.status(400).json({ error: '没有成功写入任何文件' });
    }

    console.log('[Export] saved', saved.length, 'strips to', resolved);
    res.json({ ok: true, folderPath: resolved, saved });
});

app.post('/api/generate', async (req, res) => {
    const { 
        provider,
        apiKey,
        baseUrl,
        model,
        topic,
        count = 3,
        imageUrl
    } = req.body;

    if (!topic) {
        return res.status(400).json({ error: 'Topic is required' });
    }

    if (provider !== 'doubao' && !model) {
        return res.status(400).json({ error: 'Model name is required' });
    }

    try {
        let prompts;
        console.log(`Generating prompts for topic: "${topic}" using ${provider}...${imageUrl ? ' (with image)' : ''}`);
        
        if (provider === 'ollama') {
            prompts = await aiService.generateWithOllama(model, topic, count, baseUrl);
        } else if (provider === 'doubao') {
            // model here is expected to be '1.8' or '1.6' from frontend
            prompts = await aiService.generateWithDoubao(topic, count, imageUrl, model);
        } else {
            prompts = await aiService.generateWithApiKey(apiKey, baseUrl, model, topic, count);
        }
        
        res.json({ prompts });
    } catch (error) {
        console.error('Generation Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 404 Handler - Ensure JSON response for API routes
app.use('/api/*', (req, res) => {
    res.status(404).json({ error: `Endpoint not found: ${req.originalUrl}` });
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err.stack);
    if (res.headersSent) {
        return next(err);
    }
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`[ImageWorker] VRAM gate: ${chatImageConfig.imageMinVramMb}MB free required when provider=ollama`);
});
