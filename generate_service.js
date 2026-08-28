/**
 * ComfyUI generate page helpers:
 * - clothing/action prompt expansion via LLM (.env keys)
 * - independent generate presets (not shared with roleplay)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const aiService = require('./ai_service');
const comfyClient = require('./comfy_client');
const chatImageConfig = require('./chat_image_config');

const DATA_DIR = path.join(__dirname, 'data');
const PRESETS_FILE = path.join(DATA_DIR, 'comfy_generate_presets.json');
const OUTPUT_DIR = path.join(__dirname, 'public', 'uploads', 'generate');

const CLOTHING_EXPAND_SYSTEM = `#角色
服饰和动作扩展专家，我给你我的初始需求，你直接输出服饰和动作和氛围，严格按照示例输出

#禁止事项
禁止增加角色特征


#输出示例

white frilly bikini, thin strings, mid-jump, spinning, dynamic side view, soft natural lighting, bright airy atmosphere, dreamy lighting, pale skin glowing, subtle pink tones, innocent, charming, cute little sister, gentle, pure, wholesome summer, gentle freckled beauty
---
navy blue school swimsuit, white trim, standing, pool edge, three-quarter front view, warm afternoon sunlight, water reflections, ripples, clear blue sky, breeze, refreshing, energetic, youthful summer, bright crisp colors, clean minimal composition
---
floral summer sundress, thin spaghetti straps, sitting, park bench, front view, dappled sunlight, tree leaves, golden hour glow, gentle shadows, peaceful, nostalgic, romantic countryside, warm earthy tones, soft greens, soft pinks`;

function ensureDirs() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function defaultPresetShape() {
    const defaults = comfyClient.workflowDefaults();
    return {
        id: '',
        name: '未命名预设',
        basePrompt: '',
        negativePrompt: defaults.negativePrompt || chatImageConfig.negativePrompt || '',
        checkpointName: defaults.checkpointName || chatImageConfig.checkpointName || '',
        loras: JSON.parse(JSON.stringify(defaults.loras || chatImageConfig.loras || [])),
        // Rabbit-batch friendly defaults (roleplay bust uses smaller size)
        width: 1024,
        height: 1536,
        steps: 45,
        cfg: 6,
        sampler: defaults.sampler || 'dpmpp_2m',
        scheduler: defaults.scheduler || 'karras',
        denoise: defaults.denoise ?? 1,
        seed: -1,
        enableHires: false,
        hiresWidth: defaults.hiresWidth || 1080,
        hiresHeight: defaults.hiresHeight || 1920,
        hiresDenoise: defaults.hiresDenoise ?? 0.4,
        hiresSteps: defaults.hiresSteps || 20,
        enableUpscale: true,
        upscaleModel: '2x_Ani4Kv2_G6i2_Compact_107500.pth',
        samplerOptions: defaults.samplerOptions || [],
        schedulerOptions: defaults.schedulerOptions || [],
        updatedAt: Date.now()
    };
}

function readPresets() {
    ensureDirs();
    try {
        const raw = fs.readFileSync(PRESETS_FILE, 'utf8');
        const parsed = JSON.parse(raw || '{}');
        const list = Array.isArray(parsed.presets)
            ? parsed.presets
            : (Array.isArray(parsed) ? parsed : []);
        return {
            presets: list,
            activePresetId: parsed.activePresetId || (list[0] && list[0].id) || ''
        };
    } catch (e) {
        return { presets: [], activePresetId: '' };
    }
}

function writePresets(state) {
    ensureDirs();
    const normalized = {
        activePresetId: state.activePresetId || '',
        presets: Array.isArray(state.presets) ? state.presets : []
    };
    fs.writeFileSync(PRESETS_FILE, JSON.stringify(normalized, null, 2), 'utf8');
    return normalized;
}

function upsertPreset(input = {}) {
    const state = readPresets();
    const now = Date.now();
    const base = defaultPresetShape();
    let preset = null;

    if (input.id) {
        const idx = state.presets.findIndex((p) => p.id === input.id);
        if (idx >= 0) {
            preset = {
                ...base,
                ...state.presets[idx],
                ...input,
                id: state.presets[idx].id,
                updatedAt: now
            };
            state.presets[idx] = preset;
        }
    }

    if (!preset) {
        preset = {
            ...base,
            ...input,
            id: input.id || `gp_${crypto.randomBytes(6).toString('hex')}`,
            updatedAt: now
        };
        state.presets.push(preset);
    }

    if (!state.activePresetId) state.activePresetId = preset.id;
    writePresets(state);
    return { state: readPresets(), preset };
}

function deletePreset(id) {
    const state = readPresets();
    state.presets = state.presets.filter((p) => p.id !== id);
    if (state.activePresetId === id) {
        state.activePresetId = state.presets[0]?.id || '';
    }
    return writePresets(state);
}

function setActivePreset(id) {
    const state = readPresets();
    if (!state.presets.some((p) => p.id === id)) {
        throw new Error('预设不存在');
    }
    state.activePresetId = id;
    return writePresets(state);
}

function splitManualPrompts(text) {
    return String(text || '')
        .split(/\n\s*---\s*\n|\n---\n|---/)
        .map((s) => s.replace(/^\[Prompt\s*\d+\]\s*/i, '').trim())
        .filter(Boolean);
}

async function expandClothingPrompts({ scene, count }) {
    const n = Math.max(1, Math.min(30, Math.round(Number(count) || 1)));
    const userContent = `用户的需求为：${String(scene || '').trim()}\n\n请生成 ${n} 个图片变体，每个变体只写服饰、动作、构图、光影与氛围（英文 tag），用 --- 分隔。不要输出角色外貌特征，不要编号标题。`;
    const messages = [
        { role: 'system', content: CLOTHING_EXPAND_SYSTEM },
        { role: 'user', content: userContent }
    ];
    const provider = process.env.GENERATE_LLM_PROVIDER || 'deepseek';
    const model = process.env.GENERATE_LLM_MODEL || process.env.DEEPSEEK_MODEL || '';
    const raw = await aiService.completeText(messages, provider, model);
    const parts = splitManualPrompts(raw);
    if (!parts.length) {
        throw new Error('AI 扩写未返回有效 prompt，请重试或改用手动 Prompt');
    }
    return { prompts: parts.slice(0, n), raw };
}

function presetToComfyOptions(preset, overrides = {}) {
    const p = { ...defaultPresetShape(), ...(preset || {}), ...overrides };
    return {
        checkpointName: p.checkpointName,
        basePrompt: p.basePrompt,
        negative: p.negativePrompt,
        loras: p.loras,
        width: p.width,
        height: p.height,
        steps: p.steps,
        cfg: p.cfg,
        sampler: p.sampler,
        scheduler: p.scheduler,
        denoise: p.denoise,
        seed: p.seed,
        enableHires: Boolean(p.enableHires),
        hiresWidth: p.hiresWidth,
        hiresHeight: p.hiresHeight,
        hiresDenoise: p.hiresDenoise,
        hiresSteps: p.hiresSteps,
        enableUpscale: p.enableUpscale !== false,
        upscaleModel: p.upscaleModel,
        randomSeedPerPrompt: true,
        filenamePrefix: 'comfy_generate'
    };
}

async function runGenerateJob({
    presetId,
    mode = 'ai',
    scene = '',
    count = 1,
    overrides = {}
}) {
    ensureDirs();
    const state = readPresets();
    const preset = state.presets.find((p) => p.id === (presetId || state.activePresetId));
    if (!preset) {
        throw new Error('请先创建并选择一个角色预设（含底模）');
    }
    if (!String(preset.basePrompt || '').trim()) {
        throw new Error('当前预设缺少底模 basePrompt，请在右侧配置中填写');
    }

    let clothingPrompts;
    let expandRaw = '';
    if (mode === 'manual') {
        clothingPrompts = splitManualPrompts(scene);
        if (!clothingPrompts.length) {
            throw new Error('手动 Prompt 为空，请用 --- 分隔多条服饰动作提示词');
        }
    } else {
        if (!String(scene || '').trim()) {
            throw new Error('请先填写场景描述');
        }
        const expanded = await expandClothingPrompts({ scene, count });
        clothingPrompts = expanded.prompts;
        expandRaw = expanded.raw;
    }

    const batchId = `gen_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const destDir = path.join(OUTPUT_DIR, batchId);
    fs.mkdirSync(destDir, { recursive: true });

    const comfyOptions = presetToComfyOptions(preset, overrides);
    const result = await comfyClient.generateBatchToDir({
        ...comfyOptions,
        multiPrompts: clothingPrompts,
        turnPrompt: clothingPrompts
    }, destDir);

    const images = (result.files || []).map((f, i) => ({
        index: i + 1,
        name: f.name,
        url: `/uploads/generate/${batchId}/${f.name}`,
        prompt: clothingPrompts[i] || ''
    }));

    return {
        ok: true,
        batchId,
        presetId: preset.id,
        presetName: preset.name,
        mode,
        promptId: result.promptId,
        seed: result.seed,
        clothingPrompts,
        expandRaw,
        images
    };
}

module.exports = {
    CLOTHING_EXPAND_SYSTEM,
    ensureDirs,
    defaultPresetShape,
    readPresets,
    writePresets,
    upsertPreset,
    deletePreset,
    setActivePreset,
    splitManualPrompts,
    expandClothingPrompts,
    runGenerateJob,
    PRESETS_FILE,
    OUTPUT_DIR
};
