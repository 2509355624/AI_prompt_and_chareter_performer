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
const jobStore = require('./generate_job_store');

const DATA_DIR = path.join(__dirname, 'data');
const PRESETS_FILE = path.join(DATA_DIR, 'comfy_generate_presets.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'comfy_generate_settings.json');
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

/** Krea2 / natural-language expand (not SDXL tag soup). */
const KREA2_EXPAND_SYSTEM = `#角色
你为 Krea2 文生图写提示词。Krea2 需要自然语言描述，不要 SD/anime tag 列表。

#要求
- 用完整英文句子描写本轮画面：服饰、姿势动作、场景、光影、氛围、构图
- 不要逗号堆砌的 tag（禁止 masterpiece, 1girl, solo 这类词表）
- 不要写角色外貌底模（发色脸型身材等由用户 basePrompt 负责）
- 输出若干变体，只用 --- 分隔，不要编号或标题

#示例
A close-up of a girl in a white lace dress sitting sideways on a wooden park bench at dusk, cool cyan color grading, soft overexposed light on her face, shallow depth of field, quiet melancholic mood.
---
She stands at a rainy bus stop in a navy wool coat, looking down at her shoes, neon reflections on wet pavement, cinematic side lighting, muted teal and amber tones.`;

const KREA2_EXPAND_USER =
    '用户需求：{scene}\n\n请生成 {count} 段英文自然语言画面描述（服饰/动作/场景/光影），用 --- 分隔。不要 tag 列表，不要角色外貌底模，不要编号标题。';

function ensureDirs() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    jobStore.ensureJobsDir();
}

/** In-flight generate jobs in this Node process (disk may still say running after crash). */
const liveJobIds = new Set();
const cancelFlags = new Set();

function isJobLive(jobId) {
    return Boolean(jobId && liveJobIds.has(jobId));
}

function requestCancelJob(jobId, reason = '用户取消生成') {
    if (jobId) cancelFlags.add(jobId);
    const job = jobId
        ? jobStore.cancelJob(jobId, reason)
        : null;
    // Also clear any other orphaned running rows
    if (!jobId) {
        jobStore.abandonRunningJobs(reason);
    }
    Promise.resolve(comfyClient.interruptComfy()).catch(() => {});
    return job;
}

function requestCancelAll(reason = '用户取消全部生成') {
    for (const id of [...liveJobIds]) cancelFlags.add(id);
    const n = jobStore.abandonRunningJobs(reason);
    Promise.resolve(comfyClient.interruptComfy()).catch(() => {});
    return n;
}

function getLiveActiveJob() {
    const active = jobStore.findActiveJob();
    if (!active) return null;
    if (isJobLive(active.id)) return active;
    // Disk says running but this process is not executing it → ghost after kill/restart
    jobStore.cancelJob(
        active.id,
        '服务端已无此任务（进程曾中断），已自动解除队列占用'
    );
    return null;
}

function defaultSettings() {
    return {
        clothingExpandSystem: CLOTHING_EXPAND_SYSTEM,
        clothingExpandUserTemplate:
            '用户的需求为：{scene}\n\n请生成 {count} 个图片变体，每个变体只写服饰、动作、构图、光影与氛围（英文 tag），用 --- 分隔。不要输出角色外貌特征，不要编号标题。'
    };
}

function readSettings() {
    ensureDirs();
    const defaults = defaultSettings();
    try {
        const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8') || '{}');
        return {
            clothingExpandSystem: String(parsed.clothingExpandSystem || defaults.clothingExpandSystem),
            clothingExpandUserTemplate: String(
                parsed.clothingExpandUserTemplate || defaults.clothingExpandUserTemplate
            )
        };
    } catch (_) {
        return defaults;
    }
}

function writeSettings(input = {}) {
    ensureDirs();
    const defaults = defaultSettings();
    const next = {
        clothingExpandSystem: String(input.clothingExpandSystem || '').trim() || defaults.clothingExpandSystem,
        clothingExpandUserTemplate:
            String(input.clothingExpandUserTemplate || '').trim() || defaults.clothingExpandUserTemplate
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
    return next;
}

function defaultPresetShape() {
    const defaults = comfyClient.workflowDefaults();
    return {
        id: '',
        name: '未命名预设',
        workflowEngine: 'sdxl',
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

const KREA2_DEFAULTS = {
    workflowEngine: 'krea2',
    checkpointName: 'krea2_turbo-Q4_K_M.gguf',
    unetName: 'krea2_turbo-Q4_K_M.gguf',
    clipName: 'qwen3vl_4b_fp8_scaled.safetensors',
    clipType: 'krea2',
    vaeName: 'qwen_image_vae.safetensors',
    steps: 8,
    cfg: 1,
    sampler: 'euler',
    scheduler: 'simple',
    enableHires: false,
    enableUpscale: false
};

function looksLikeKrea2Preset(preset = {}) {
    if (String(preset.workflowEngine || '').toLowerCase() === 'krea2') return true;
    const ckpt = String(preset.checkpointName || preset.unetName || '');
    if (/\.gguf$/i.test(ckpt)) return true;
    if (/krea2/i.test(ckpt)) return true;
    if (/krea2/i.test(String(preset.name || ''))) return true;
    return false;
}

/** Ensure GGUF / krea2 presets keep the right engine metadata after UI saves. */
function normalizePreset(preset) {
    if (!preset || typeof preset !== 'object') return preset;
    const next = { ...preset };
    if (looksLikeKrea2Preset(next)) {
        next.workflowEngine = 'krea2';
        next.unetName = next.unetName || next.checkpointName || KREA2_DEFAULTS.unetName;
        next.checkpointName = next.checkpointName || next.unetName || KREA2_DEFAULTS.checkpointName;
        next.clipName = next.clipName || KREA2_DEFAULTS.clipName;
        next.clipType = next.clipType || KREA2_DEFAULTS.clipType;
        next.vaeName = next.vaeName || KREA2_DEFAULTS.vaeName;
        // Krea2 graph has no hires-fix pass; 2× upscale is optional and real when enabled
        next.enableHires = false;
        if (next.enableUpscale === undefined) next.enableUpscale = false;
    } else if (!next.workflowEngine) {
        next.workflowEngine = 'sdxl';
    }
    return next;
}

function readPresets() {
    ensureDirs();
    try {
        const raw = fs.readFileSync(PRESETS_FILE, 'utf8');
        const parsed = JSON.parse(raw || '{}');
        const list = Array.isArray(parsed.presets)
            ? parsed.presets
            : (Array.isArray(parsed) ? parsed : []);
        const presets = list.map((p) => normalizePreset(p));
        return {
            presets,
            activePresetId: parsed.activePresetId || (presets[0] && presets[0].id) || ''
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
            preset = normalizePreset({
                ...base,
                ...state.presets[idx],
                ...input,
                id: state.presets[idx].id,
                updatedAt: now
            });
            state.presets[idx] = preset;
        }
    }

    if (!preset) {
        preset = normalizePreset({
            ...base,
            ...input,
            id: input.id || `gp_${crypto.randomBytes(6).toString('hex')}`,
            updatedAt: now
        });
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

async function expandClothingPrompts({ scene, count, naturalLanguage = false }) {
    const n = Math.max(1, Math.min(30, Math.round(Number(count) || 1)));
    const settings = readSettings();
    const useNl = Boolean(naturalLanguage);
    const system = useNl
        ? KREA2_EXPAND_SYSTEM
        : (settings.clothingExpandSystem || CLOTHING_EXPAND_SYSTEM);
    const userTemplate = useNl
        ? KREA2_EXPAND_USER
        : (settings.clothingExpandUserTemplate || defaultSettings().clothingExpandUserTemplate);
    const userContent = String(userTemplate)
        .replace(/\{scene\}/g, String(scene || '').trim())
        .replace(/\{count\}/g, String(n));
    const messages = [
        { role: 'system', content: system },
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
    const p = normalizePreset({ ...defaultPresetShape(), ...(preset || {}), ...overrides });
    const isKrea2 = looksLikeKrea2Preset(p);
    return {
        workflowEngine: isKrea2 ? 'krea2' : (p.workflowEngine || 'sdxl'),
        checkpointName: p.checkpointName,
        unetName: p.unetName || p.checkpointName,
        clipName: p.clipName || (isKrea2 ? KREA2_DEFAULTS.clipName : ''),
        clipType: p.clipType || (isKrea2 ? KREA2_DEFAULTS.clipType : ''),
        vaeName: p.vaeName || (isKrea2 ? KREA2_DEFAULTS.vaeName : ''),
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
        enableHires: isKrea2 ? false : Boolean(p.enableHires),
        hiresWidth: p.hiresWidth,
        hiresHeight: p.hiresHeight,
        hiresDenoise: p.hiresDenoise,
        hiresSteps: p.hiresSteps,
        // SDXL 默认开 2×；Krea2 默认关，勾选才接入 Upscale 节点
        enableUpscale: isKrea2 ? Boolean(p.enableUpscale) : p.enableUpscale !== false,
        upscaleModel: p.upscaleModel,
        randomSeedPerPrompt: true,
        filenamePrefix: isKrea2 ? 'Krea2_q4_retroanime' : 'comfy_generate'
    };
}

async function runGenerateJob({
    presetId,
    mode = 'ai',
    scene = '',
    count = 1,
    overrides = {},
    onProgress = null,
    jobId = null
}) {
    const startedAt = Date.now();
    ensureDirs();

    const state = readPresets();
    const preset = state.presets.find((p) => p.id === (presetId || state.activePresetId));
    if (!preset) {
        throw new Error('请先创建并选择一个角色预设（含底模）');
    }
    const isKrea2 = looksLikeKrea2Preset(preset);
    if (!String(preset.basePrompt || '').trim() && !isKrea2) {
        throw new Error('当前预设缺少底模 basePrompt，请在右侧配置中填写');
    }

    let job = jobId ? jobStore.readJob(jobId) : null;
    if (!job) {
        job = jobStore.createJob({
            presetId: preset.id,
            presetName: preset.name,
            mode: mode === 'manual' ? 'manual' : 'ai',
            scene,
            count
        });
    } else {
        job = jobStore.updateJob(job.id, {
            status: 'running',
            phase: 'starting',
            message: '任务继续…',
            presetId: preset.id,
            presetName: preset.name,
            mode: mode === 'manual' ? 'manual' : 'ai',
            scene,
            count,
            error: null,
            finishedAt: null
        }) || job;
    }

    const progress = (payload) => {
        const patch = {
            phase: payload.phase || job.phase,
            message: payload.message || '',
            elapsedMs: Date.now() - startedAt
        };
        if (payload.batchId) patch.batchId = payload.batchId;
        if (payload.promptId) patch.promptId = payload.promptId;
        if (Array.isArray(payload.images)) patch.images = payload.images;
        if (Array.isArray(payload.clothingPrompts)) patch.clothingPrompts = payload.clothingPrompts;
        if (payload.source) patch.source = payload.source;
        jobStore.updateJob(job.id, patch);
        if (typeof onProgress === 'function') {
            onProgress({ ...payload, jobId: job.id, elapsedMs: patch.elapsedMs });
        }
    };

    progress({ phase: 'job', jobId: job.id, message: '任务已登记，可离开页面稍后回来查看' });

    liveJobIds.add(job.id);
    cancelFlags.delete(job.id);
    const isCancelled = () => cancelFlags.has(job.id);

    try {
        let clothingPrompts;
        let expandRaw = '';
        if (mode === 'manual') {
            clothingPrompts = splitManualPrompts(scene);
            if (!clothingPrompts.length) {
                throw new Error('手动 Prompt 为空，请用 --- 分隔多条服饰动作提示词');
            }
            progress({ phase: 'manual', message: `手动 Prompt：${clothingPrompts.length} 条`, clothingPrompts });
        } else {
            if (!String(scene || '').trim()) {
                throw new Error('请先填写场景描述');
            }
            progress({ phase: 'expanding', message: 'AI 扩写服饰动作中…' });
            const expanded = await expandClothingPrompts({
                scene,
                count: isKrea2 ? Math.min(Number(count) || 1, 4) : count,
                naturalLanguage: isKrea2
            });
            if (isCancelled()) throw new Error('用户取消生成');
            clothingPrompts = expanded.prompts;
            expandRaw = expanded.raw;
            progress({
                phase: 'expanded',
                message: `AI 扩写完成：${clothingPrompts.length} 条，准备提交 Comfy…`,
                clothingCount: clothingPrompts.length,
                clothingPrompts
            });
        }

        const batchId = `gen_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const destDir = path.join(OUTPUT_DIR, batchId);
        fs.mkdirSync(destDir, { recursive: true });
        jobStore.updateJob(job.id, { batchId });
        progress({ phase: 'queued', message: '提交 Comfy 生成…', batchId });

        const comfyOptions = {
            ...presetToComfyOptions(preset, overrides),
            isCancelled,
            onProgress: progress
        };
        const result = isKrea2
            ? await comfyClient.generateKrea2BatchToDir({
                ...comfyOptions,
                multiPrompts: clothingPrompts,
                turnPrompt: clothingPrompts
            }, destDir)
            : await comfyClient.generateBatchToDir({
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

        const elapsedMs = Date.now() - startedAt;
        jobStore.updateJob(job.id, {
            status: 'done',
            phase: 'done',
            message: `完成 ${images.length} 张`,
            batchId,
            promptId: result.promptId || null,
            images,
            clothingPrompts,
            source: result.source || null,
            elapsedMs,
            finishedAt: Date.now(),
            error: null
        });

        progress({
            phase: 'done',
            message: `完成 ${images.length} 张`,
            imageCount: images.length,
            images,
            clothingPrompts,
            batchId,
            promptId: result.promptId,
            source: result.source
        });

        return {
            ok: true,
            jobId: job.id,
            batchId,
            presetId: preset.id,
            presetName: preset.name,
            mode,
            promptId: result.promptId,
            seed: result.seed,
            source: result.source,
            clothingPrompts,
            expandRaw,
            images,
            elapsedMs
        };
    } catch (e) {
        const elapsedMs = Date.now() - startedAt;
        const cancelled = cancelFlags.has(job.id) || /取消/.test(String(e.message || ''));
        jobStore.updateJob(job.id, {
            status: 'error',
            phase: cancelled ? 'cancelled' : 'error',
            message: e.message || '生成失败',
            error: e.message || '生成失败',
            elapsedMs,
            finishedAt: Date.now()
        });
        if (typeof onProgress === 'function') {
            onProgress({
                phase: 'error',
                ok: false,
                jobId: job.id,
                error: e.message || '生成失败',
                elapsedMs
            });
        }
        const err = e instanceof Error ? e : new Error(String(e));
        err.jobId = job.id;
        throw err;
    } finally {
        liveJobIds.delete(job.id);
        cancelFlags.delete(job.id);
    }
}

function importImageBuffer(buf, originalName = 'import.png') {
    ensureDirs();
    const dir = path.join(OUTPUT_DIR, 'imported');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = (path.extname(String(originalName || '')) || '.png').toLowerCase();
    const safeExt = /\.(png|jpe?g|webp)$/i.test(ext) ? ext : '.png';
    const name = `imp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}${safeExt}`;
    const full = path.join(dir, name);
    fs.writeFileSync(full, buf);
    return {
        name,
        url: `/uploads/generate/imported/${name}`,
        bytes: buf.length
    };
}

function importFromComfyOutput(filename) {
    const full = comfyClient.resolveOutputImagePath(filename);
    if (!full) throw new Error('找不到该 output 图片，或文件名不合法');
    const buf = fs.readFileSync(full);
    return importImageBuffer(buf, path.basename(full));
}

function importFromBase64(data, name) {
    const raw = String(data || '');
    const m = raw.match(/^data:[^;]+;base64,(.+)$/);
    const b64 = m ? m[1] : raw;
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new Error('图片数据为空');
    return importImageBuffer(buf, name || 'import.png');
}

module.exports = {
    CLOTHING_EXPAND_SYSTEM,
    KREA2_EXPAND_SYSTEM,
    ensureDirs,
    defaultPresetShape,
    defaultSettings,
    readSettings,
    writeSettings,
    readPresets,
    writePresets,
    upsertPreset,
    deletePreset,
    setActivePreset,
    splitManualPrompts,
    expandClothingPrompts,
    runGenerateJob,
    importImageBuffer,
    importFromComfyOutput,
    importFromBase64,
    isJobLive,
    getLiveActiveJob,
    requestCancelJob,
    requestCancelAll,
    PRESETS_FILE,
    SETTINGS_FILE,
    OUTPUT_DIR,
    jobStore
};
