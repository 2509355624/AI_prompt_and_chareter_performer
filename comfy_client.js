const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const config = require('./chat_image_config');

const COMFY_CLIENT_ID = 'picture-prompt-produce';
let comfyWs = null;

function comfyWsUrl() {
    return `${config.comfyUrl.replace(/^http/i, 'ws')}/ws?clientId=${encodeURIComponent(COMFY_CLIENT_ID)}`;
}

function ensureComfySocket() {
    return new Promise((resolve) => {
        if (typeof WebSocket === 'undefined') return resolve();
        if (comfyWs && comfyWs.readyState === 1) return resolve();
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        try {
            comfyWs = new WebSocket(comfyWsUrl());
            comfyWs.addEventListener('open', done);
            comfyWs.addEventListener('error', () => {
                comfyWs = null;
                done();
            });
            comfyWs.addEventListener('close', () => {
                comfyWs = null;
            });
            setTimeout(done, 1500);
        } catch (e) {
            comfyWs = null;
            done();
        }
    });
}

let queueTail = Promise.resolve();
const WORKFLOW_PATH = path.join(__dirname, 'workflows', 'character_bust.json');

function enqueue(task) {
    const run = queueTail.then(() => task(), () => task());
    queueTail = run.then(() => undefined, () => undefined);
    return run;
}

function loadWorkflowTemplate() {
    return JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
}

function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function applyLoraSlot(graph, nodeId, lora, fallbackName) {
    if (!graph[nodeId] || !graph[nodeId].inputs) return;
    const inputs = graph[nodeId].inputs;
    const name = String(lora?.name || '').trim();
    if (!name || name === '(none)') {
        inputs.lora_name = fallbackName;
        inputs.strength_model = 0;
        inputs.strength_clip = 0;
        return;
    }
    inputs.lora_name = name;
    inputs.strength_model = num(lora.strengthModel, 0);
    inputs.strength_clip = num(lora.strengthClip, 1);
}

function buildPromptGraph(options = {}) {
    const graph = loadWorkflowTemplate();
    const gen = graph['53'] && graph['53'].inputs;
    if (!gen) {
        throw new Error('character_bust.json is missing BatchPromptImageGenerator node 53');
    }

    const checkpointName = options.checkpointName || config.checkpointName;
    if (graph['4'] && graph['4'].inputs) {
        graph['4'].inputs.ckpt_name = checkpointName;
    }

    const defaultLoras = config.loras || [];
    const loras = Array.isArray(options.loras) && options.loras.length ? options.loras : defaultLoras;
    applyLoraSlot(graph, '25', loras[0], defaultLoras[0]?.name || 'add_contrast_XL.safetensors');
    applyLoraSlot(graph, '24', loras[1], defaultLoras[1]?.name || 'add_saturation_XL.safetensors');
    applyLoraSlot(graph, '19', loras[2], defaultLoras[2]?.name || 'loras\\anima-masterpieces-nlmix2-e41.safetensors');

    gen.base_prompt = options.basePrompt || options.positive || '';
    gen.multi_prompts = options.turnPrompt || config.testPromptTurn;
    gen.width = Math.max(64, Math.round(num(options.width, config.width)));
    gen.height = Math.max(64, Math.round(num(options.height, config.height)));
    gen.steps = Math.max(1, Math.round(num(options.steps, config.steps)));
    gen.cfg = num(options.cfg, config.cfg);
    gen.sampler_name = options.sampler || config.sampler;
    gen.scheduler = options.scheduler || config.scheduler;
    gen.denoise = num(options.denoise, config.denoise);
    gen.enable_hires = Boolean(options.enableHires ?? config.enableHires);
    gen.hires_width = Math.max(64, Math.round(num(options.hiresWidth, config.hiresWidth)));
    gen.hires_height = Math.max(64, Math.round(num(options.hiresHeight, config.hiresHeight)));
    gen.hires_denoise = num(options.hiresDenoise, config.hiresDenoise);
    gen.hires_steps = Math.max(1, Math.round(num(options.hiresSteps, config.hiresSteps)));
    if (options.randomSeedPerPrompt !== undefined) {
        gen.random_seed_per_prompt = Boolean(options.randomSeedPerPrompt);
    }

    const seedOpt = num(options.seed, config.seed);
    gen.seed = seedOpt >= 0 ? Math.floor(seedOpt) : crypto.randomInt(1, 2 ** 48);

    if (graph['7'] && graph['7'].inputs) {
        graph['7'].inputs.text = options.negative || config.negativePrompt;
    }
    if (graph['9'] && graph['9'].inputs) {
        graph['9'].inputs.filename_prefix = options.filenamePrefix || 'character_chat';
    }

    // Optional 2x model upscale (rabbit batch workflow style)
    if (options.enableUpscale) {
        const upscaleModel = String(options.upscaleModel || '2x_Ani4Kv2_G6i2_Compact_107500.pth').trim();
        graph['60'] = {
            class_type: 'UpscaleModelLoader',
            inputs: { model_name: upscaleModel }
        };
        graph['61'] = {
            class_type: 'ImageUpscaleWithModel',
            inputs: {
                upscale_model: ['60', 0],
                image: ['53', 0]
            }
        };
        if (graph['9'] && graph['9'].inputs) {
            graph['9'].inputs.images = ['61', 0];
        }
    }

    return graph;
}

const KREA2_WORKFLOW_PATH = path.join(__dirname, 'workflows', 'krea2_q4_retroanime.json');

function loadKrea2Template() {
    return JSON.parse(fs.readFileSync(KREA2_WORKFLOW_PATH, 'utf8'));
}

/**
 * API graph for Krea2 Q4 GGUF + retroanime LoRA (from ComfyUI user workflow).
 * checkpointName maps to UnetLoaderGGUF unet_name.
 */
function buildKrea2PromptGraph(options = {}) {
    const graph = loadKrea2Template();
    const unetName = String(options.unetName || options.checkpointName || 'krea2_turbo-Q4_K_M.gguf').trim();
    graph['1'].inputs.unet_name = unetName;

    if (options.clipName) {
        graph['2'].inputs.clip_name = String(options.clipName).trim();
    }
    if (options.clipType) {
        graph['2'].inputs.type = String(options.clipType).trim();
    }
    if (options.vaeName) {
        graph['3'].inputs.vae_name = String(options.vaeName).trim();
    }

    const lora = Array.isArray(options.loras) && options.loras[0] ? options.loras[0] : null;
    const loraName = String(lora?.name || '').trim();
    const loraStrength = num(lora?.strengthModel, 1);
    if (!loraName || loraName === '(none)' || loraStrength === 0) {
        delete graph['14'];
        graph['7'].inputs.model = ['1', 0];
    } else {
        graph['14'].inputs.lora_name = loraName;
        graph['14'].inputs.strength_model = loraStrength;
    }

    graph['4'].inputs.text = String(options.positive || options.basePrompt || '').trim();
    graph['5'].inputs.text = String(options.negative || '').trim();
    graph['6'].inputs.width = Math.max(64, Math.round(num(options.width, 1024)));
    graph['6'].inputs.height = Math.max(64, Math.round(num(options.height, 1536)));
    graph['6'].inputs.batch_size = 1;

    const seedOpt = num(options.seed, -1);
    graph['7'].inputs.seed = seedOpt >= 0 ? Math.floor(seedOpt) : crypto.randomInt(1, 2 ** 48);
    graph['7'].inputs.steps = Math.max(1, Math.round(num(options.steps, 8)));
    graph['7'].inputs.cfg = num(options.cfg, 1);
    graph['7'].inputs.sampler_name = options.sampler || 'euler';
    graph['7'].inputs.scheduler = options.scheduler || 'simple';
    graph['7'].inputs.denoise = num(options.denoise, 1);

    if (graph['9'] && graph['9'].inputs) {
        graph['9'].inputs.filename_prefix = options.filenamePrefix || 'Krea2_q4_retroanime';
    }

    // Optional 2× model upscale (same nodes as SDXL generate path)
    if (options.enableUpscale) {
        const upscaleModel = String(options.upscaleModel || '2x_Ani4Kv2_G6i2_Compact_107500.pth').trim();
        graph['60'] = {
            class_type: 'UpscaleModelLoader',
            inputs: { model_name: upscaleModel }
        };
        graph['61'] = {
            class_type: 'ImageUpscaleWithModel',
            inputs: {
                upscale_model: ['60', 0],
                image: ['8', 0]
            }
        };
        if (graph['9'] && graph['9'].inputs) {
            graph['9'].inputs.images = ['61', 0];
        }
    }

    return graph;
}

function combineKrea2Positive(basePrompt, clothingPrompt) {
    const base = String(basePrompt || '').trim();
    const clothing = String(clothingPrompt || '').trim();
    if (base && clothing) return `${base}, ${clothing}`;
    return base || clothing;
}

/** Join clothing/action prompts with --- for BatchPromptImageGenerator */
function joinMultiPrompts(prompts) {
    if (Array.isArray(prompts)) {
        return prompts.map((p) => String(p || '').trim()).filter(Boolean).join('\n---\n');
    }
    return String(prompts || '').trim();
}

function formatComfyReject(err) {
    const data = err?.response?.data;
    if (!data) return err.message || String(err);
    const parts = [];
    const top = data.error;
    if (top) {
        parts.push(typeof top === 'string' ? top : (top.message || JSON.stringify(top)));
        if (top.details) parts.push(String(top.details));
    }
    const nodeErrors = data.node_errors || {};
    for (const [nodeId, info] of Object.entries(nodeErrors)) {
        const errs = Array.isArray(info?.errors) ? info.errors : [];
        for (const e of errs) {
            const bit = [e.message, e.details].filter(Boolean).join(' — ');
            parts.push(`node ${nodeId} (${info.class_type || '?'}): ${bit}`);
        }
    }
    if (!parts.length) parts.push(typeof data === 'string' ? data : JSON.stringify(data));
    return parts.join(' | ');
}

async function ping() {
    const { data } = await axios.get(`${config.comfyUrl}/system_stats`, { timeout: 4000 });
    return data;
}

async function listCheckpoints() {
    try {
        const { data } = await axios.get(`${config.comfyUrl}/object_info/CheckpointLoaderSimple`, { timeout: 8000 });
        const names = data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
        if (Array.isArray(names) && names.length) {
            return names;
        }
    } catch (e) {
        // ComfyUI 没开时仍给出本机已知默认
    }
    return [config.checkpointName, 'unholyDesireMixSinister_v50.safetensors'].filter(Boolean);
}

async function listLoras() {
    try {
        const { data } = await axios.get(`${config.comfyUrl}/object_info/LoraLoader`, { timeout: 8000 });
        const names = data?.LoraLoader?.input?.required?.lora_name?.[0];
        if (Array.isArray(names) && names.length) {
            return names;
        }
    } catch (e) {
        // ignore
    }
    return (config.loras || []).map((l) => l.name).filter(Boolean);
}

function workflowDefaults() {
    return {
        checkpointName: config.checkpointName,
        width: config.width,
        height: config.height,
        steps: config.steps,
        cfg: config.cfg,
        sampler: config.sampler,
        scheduler: config.scheduler,
        denoise: config.denoise,
        seed: config.seed,
        enableHires: config.enableHires,
        hiresWidth: config.hiresWidth,
        hiresHeight: config.hiresHeight,
        hiresDenoise: config.hiresDenoise,
        hiresSteps: config.hiresSteps,
        enableUpscale: Boolean(config.enableUpscale),
        upscaleModel: config.upscaleModel || '2x_Ani4Kv2_G6i2_Compact_107500.pth',
        negativePrompt: config.negativePrompt,
        loras: JSON.parse(JSON.stringify(config.loras || [])),
        samplerOptions: config.samplerOptions || [],
        schedulerOptions: config.schedulerOptions || []
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveComfyOutputDir() {
    const fromEnv = String(process.env.COMFYUI_OUTPUT_DIR || '').trim();
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    const candidates = [
        path.join(__dirname, '..', 'ComfyUI-master', 'ComfyUI', 'output'),
        path.join('D:', 'AI', 'ComfyUI-master', 'ComfyUI', 'output'),
        path.join(process.cwd(), '..', 'ComfyUI-master', 'ComfyUI', 'output')
    ];
    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) return c;
        } catch (_) {}
    }
    return fromEnv || '';
}

function safeOutputBasename(name) {
    const base = path.basename(String(name || '').trim());
    if (!base || base === '.' || base === '..') return '';
    if (!/\.(png|jpe?g|webp)$/i.test(base)) return '';
    if (/[\\/]/.test(String(name || ''))) return '';
    return base;
}

/** Recent images in ComfyUI output/ (newest first). */
function listRecentOutputImages(limit = 48) {
    const outputDir = resolveComfyOutputDir();
    const max = Math.max(1, Math.min(120, Number(limit) || 48));
    if (!outputDir || !fs.existsSync(outputDir)) {
        return { outputDir: outputDir || '', images: [] };
    }
    let names = [];
    try {
        names = fs.readdirSync(outputDir);
    } catch (_) {
        return { outputDir, images: [] };
    }
    const images = names
        .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
        .map((name) => {
            const full = path.join(outputDir, name);
            let st;
            try {
                st = fs.statSync(full);
            } catch (_) {
                return null;
            }
            if (!st.isFile()) return null;
            return {
                name,
                full,
                mtimeMs: st.mtimeMs,
                size: st.size
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, max)
        .map(({ name, mtimeMs, size }) => ({
            name,
            mtimeMs,
            size,
            previewUrl: `/api/comfy/output-images/file?name=${encodeURIComponent(name)}`
        }));
    return { outputDir, images };
}

function resolveOutputImagePath(name) {
    const base = safeOutputBasename(name);
    if (!base) return null;
    const outputDir = resolveComfyOutputDir();
    if (!outputDir) return null;
    const resolvedDir = path.resolve(outputDir);
    const full = path.resolve(resolvedDir, base);
    const rel = path.relative(resolvedDir, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(full)) return null;
    return full;
}

function batchTimeoutMs() {
    const n = Number(process.env.COMFYUI_BATCH_TIMEOUT_MS);
    if (Number.isFinite(n) && n > 0) return n;
    return 45 * 60 * 1000;
}

function listOutputFilesByPrefix(outputDir, prefix, sinceMs) {
    if (!outputDir || !fs.existsSync(outputDir)) return [];
    const pref = String(prefix || 'comfy_generate');
    let names = [];
    try {
        names = fs.readdirSync(outputDir);
    } catch (_) {
        return [];
    }
    return names
        .filter((name) => name.toLowerCase().startsWith(pref.toLowerCase()) && /\.(png|jpe?g|webp)$/i.test(name))
        .map((name) => {
            const full = path.join(outputDir, name);
            let mtimeMs = 0;
            try { mtimeMs = fs.statSync(full).mtimeMs; } catch (_) {}
            return { name, full, mtimeMs };
        })
        .filter((f) => !sinceMs || f.mtimeMs >= sinceMs - 2000)
        .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
}

function allSavedImages(historyEntry) {
    const outputs = historyEntry?.outputs || {};
    const found = [];
    for (const nodeId of Object.keys(outputs)) {
        const images = outputs[nodeId]?.images;
        if (Array.isArray(images)) {
            for (const img of images) {
                if (img && img.filename) found.push(img);
            }
        }
    }
    const outputsOnly = found.filter((img) => img.type === 'output');
    return outputsOnly.length ? outputsOnly : found;
}

function firstSavedImage(historyEntry) {
    const all = allSavedImages(historyEntry);
    return all[0] || null;
}

async function waitForHistory(promptId, opts = {}) {
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : config.timeoutMs;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : null;
    const filenamePrefix = opts.filenamePrefix || '';
    const expectedCount = Math.max(0, Number(opts.expectedCount) || 0);
    const outputDir = opts.outputDir || resolveComfyOutputDir();
    const started = Date.now();
    const sinceMs = opts.sinceMs || started;
    let lastMsgAt = 0;

    while (Date.now() - started < timeoutMs) {
        if (isCancelled && isCancelled()) {
            throw new Error('用户取消生成');
        }
        try {
            const { data } = await axios.get(`${config.comfyUrl}/history/${promptId}`, { timeout: 10000 });
            const entry = data?.[promptId];
            if (entry) {
                if (entry.status?.status_str === 'error') {
                    const msgs = (entry.status.messages || []).map((m) => JSON.stringify(m)).join('; ');
                    throw new Error(`ComfyUI job failed: ${msgs || 'unknown error'}`);
                }
                const images = allSavedImages(entry);
                const done = Boolean(entry.status?.completed) || (
                    images.length > 0 && (!expectedCount || images.length >= expectedCount)
                );
                if (done && images.length) {
                    return { entry, images, source: 'history' };
                }
                if (onProgress && Date.now() - lastMsgAt > 1000) {
                    lastMsgAt = Date.now();
                    onProgress({
                        phase: 'generating',
                        message: `Comfy 生成中… 已等 ${Math.round((Date.now() - started) / 1000)}s` +
                            (images.length ? `（history 已有 ${images.length} 张）` : ''),
                        promptId,
                        elapsedMs: Date.now() - started,
                        imageCount: images.length
                    });
                }
            } else if (onProgress && Date.now() - lastMsgAt > 1000) {
                lastMsgAt = Date.now();
                onProgress({
                    phase: 'queued',
                    message: `Comfy 队列中… 已等 ${Math.round((Date.now() - started) / 1000)}s`,
                    promptId,
                    elapsedMs: Date.now() - started
                });
            }
        } catch (e) {
            if (e.message && (e.message.startsWith('ComfyUI job failed') || e.message.includes('取消'))) throw e;
        }

        if (filenamePrefix && outputDir) {
            const files = listOutputFilesByPrefix(outputDir, filenamePrefix, sinceMs);
            if (expectedCount > 0 && files.length >= expectedCount) {
                return {
                    entry: null,
                    images: files.map((f) => ({
                        filename: f.name,
                        subfolder: '',
                        type: 'output',
                        _localPath: f.full
                    })),
                    source: 'output_dir'
                };
            }
            if (onProgress && files.length && Date.now() - lastMsgAt > 2000) {
                lastMsgAt = Date.now();
                onProgress({
                    phase: 'generating',
                    message: `Comfy 输出目录已出现 ${files.length} 张…`,
                    promptId,
                    elapsedMs: Date.now() - started,
                    imageCount: files.length
                });
            }
        }

        await sleep(config.pollMs);
    }

    try {
        const { data } = await axios.get(`${config.comfyUrl}/history/${promptId}`, { timeout: 10000 });
        const entry = data?.[promptId];
        const images = entry ? allSavedImages(entry) : [];
        if (images.length) {
            return { entry, images, source: 'history_after_timeout' };
        }
    } catch (_) {}

    if (filenamePrefix && outputDir) {
        const files = listOutputFilesByPrefix(outputDir, filenamePrefix, sinceMs);
        if (files.length) {
            return {
                entry: null,
                images: files.map((f) => ({
                    filename: f.name,
                    subfolder: '',
                    type: 'output',
                    _localPath: f.full
                })),
                source: 'output_dir_after_timeout'
            };
        }
    }

    throw new Error(
        `ComfyUI timed out after ${timeoutMs}ms (prompt_id=${promptId})` +
        (outputDir ? `；也未在 output 目录找到前缀 ${filenamePrefix || '(none)'} 的新图` : '')
    );
}

async function downloadView(imageMeta, destPath) {
    if (imageMeta && imageMeta._localPath && fs.existsSync(imageMeta._localPath)) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(imageMeta._localPath, destPath);
        return;
    }
    const params = new URLSearchParams({
        filename: imageMeta.filename,
        subfolder: imageMeta.subfolder || '',
        type: imageMeta.type || 'output',
    });
    const res = await axios.get(`${config.comfyUrl}/view?${params.toString()}`, {
        responseType: 'arraybuffer',
        timeout: 30000,
    });
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, Buffer.from(res.data));
}

async function generateOnce(options) {
    const graph = buildPromptGraph(options);
    await ensureComfySocket();
    let submit;
    try {
        submit = await axios.post(
            `${config.comfyUrl}/prompt`,
            { prompt: graph, client_id: COMFY_CLIENT_ID },
            { timeout: 15000 }
        );
    } catch (err) {
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
            throw new Error(`ComfyUI is not running at ${config.comfyUrl}`);
        }
        throw new Error(`ComfyUI reject: ${formatComfyReject(err)}`);
    }

    const promptId = submit.data?.prompt_id;
    if (!promptId) {
        throw new Error(`ComfyUI did not return prompt_id: ${JSON.stringify(submit.data)}`);
    }

    const waited = await waitForHistory(promptId, {
        timeoutMs: options.timeoutMs,
        onProgress: options.onProgress,
        isCancelled: options.isCancelled,
        filenamePrefix: options.filenamePrefix || 'character_chat',
        expectedCount: 1,
        sinceMs: Date.now()
    });
    const saved = waited.images[0];
    if (!saved) {
        throw new Error('ComfyUI finished but produced no image');
    }
    const seed = graph['53']?.inputs?.seed ?? graph['7']?.inputs?.seed;
    return { promptId, saved, seed, source: waited.source };
}

async function generateToFile(options, destPath) {
    return enqueue(async () => {
        const result = await generateOnce(options);
        await downloadView(result.saved, destPath);
        return result;
    });
}

/**
 * Run one Comfy job that may produce multiple images (--- split prompts).
 * Downloads every saved output into destDir as 001.png, 002.png, ...
 * Also watches Comfy output folder as fallback when history polling times out.
 */
async function generateBatchToDir(options, destDir) {
    return enqueue(async () => {
        const multiPrompts = joinMultiPrompts(options.multiPrompts || options.turnPrompt || '');
        const expectedCount = Array.isArray(options.multiPrompts)
            ? options.multiPrompts.filter(Boolean).length
            : String(multiPrompts).split(/\n\s*---\s*\n|\n---\n|---/).filter((x) => x.trim()).length;
        const filenamePrefix = options.filenamePrefix || 'comfy_generate';
        const graph = buildPromptGraph({
            ...options,
            turnPrompt: multiPrompts,
            filenamePrefix
        });
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
        if (onProgress) onProgress({ phase: 'submitting', message: '正在提交 Comfy 工作流…' });

        const sinceMs = Date.now();
        await ensureComfySocket();
        let submit;
        try {
            submit = await axios.post(
                `${config.comfyUrl}/prompt`,
                { prompt: graph, client_id: COMFY_CLIENT_ID },
                { timeout: 15000 }
            );
        } catch (err) {
            if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
                throw new Error(`ComfyUI is not running at ${config.comfyUrl}`);
            }
            const detail = formatComfyReject(err);
            throw new Error(`ComfyUI reject: ${detail}`);
        }

        const promptId = submit.data?.prompt_id;
        if (!promptId) {
            throw new Error(`ComfyUI did not return prompt_id: ${JSON.stringify(submit.data)}`);
        }
        if (onProgress) {
            onProgress({
                phase: 'queued',
                message: '已提交，等待 Comfy 出图…',
                promptId,
                expectedCount
            });
        }

        const waited = await waitForHistory(promptId, {
            timeoutMs: options.timeoutMs || batchTimeoutMs(),
            onProgress,
            isCancelled: options.isCancelled,
            filenamePrefix,
            expectedCount: expectedCount || 0,
            sinceMs,
            outputDir: options.outputDir || resolveComfyOutputDir()
        });
        const savedList = waited.images || [];
        if (!savedList.length) {
            throw new Error('ComfyUI finished but produced no images');
        }
        if (onProgress) {
            onProgress({
                phase: 'downloading',
                message: `下载结果 ${savedList.length} 张（来源: ${waited.source}）…`,
                promptId,
                imageCount: savedList.length
            });
        }

        fs.mkdirSync(destDir, { recursive: true });
        const files = [];
        for (let i = 0; i < savedList.length; i += 1) {
            const name = `${String(i + 1).padStart(3, '0')}.png`;
            const destPath = path.join(destDir, name);
            await downloadView(savedList[i], destPath);
            files.push({ name, path: destPath, meta: savedList[i] });
        }

        const seed = graph['53']?.inputs?.seed ?? null;
        return { promptId, seed, files, multiPrompts, source: waited.source };
    });
}

/**
 * Krea2 has no BatchPromptImageGenerator — one Comfy job per clothing/action prompt.
 */
async function generateKrea2BatchToDir(options, destDir) {
    return enqueue(async () => {
        const clothingList = Array.isArray(options.multiPrompts)
            ? options.multiPrompts.map((p) => String(p || '').trim()).filter(Boolean)
            : String(options.turnPrompt || options.positive || '')
                .split(/\n\s*---\s*\n|\n---\n|---/)
                .map((p) => p.trim())
                .filter(Boolean);
        if (!clothingList.length && !String(options.basePrompt || '').trim()) {
            throw new Error('Krea2 生图需要至少一条 Prompt');
        }
        const prompts = clothingList.length ? clothingList : [''];
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
        const files = [];
        let lastPromptId = null;
        let lastSource = 'history';

        fs.mkdirSync(destDir, { recursive: true });

        for (let i = 0; i < prompts.length; i++) {
            if (typeof options.isCancelled === 'function' && options.isCancelled()) {
                throw new Error('用户取消生成');
            }
            const positive = combineKrea2Positive(options.basePrompt, prompts[i]);
            const filenamePrefix = `${options.filenamePrefix || 'Krea2_q4_retroanime'}_${String(i + 1).padStart(3, '0')}`;
            const graph = buildKrea2PromptGraph({
                ...options,
                positive,
                filenamePrefix,
                seed: options.randomSeedPerPrompt === false && Number(options.seed) >= 0
                    ? options.seed
                    : -1
            });

            if (onProgress) {
                onProgress({
                    phase: 'submitting',
                    message: `Krea2 提交 ${i + 1}/${prompts.length}…`,
                    index: i + 1,
                    total: prompts.length
                });
            }

            const sinceMs = Date.now();
            await ensureComfySocket();
            let submit;
            try {
                submit = await axios.post(
                    `${config.comfyUrl}/prompt`,
                    { prompt: graph, client_id: COMFY_CLIENT_ID },
                    { timeout: 15000 }
                );
            } catch (err) {
                if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
                    throw new Error(`ComfyUI is not running at ${config.comfyUrl}`);
                }
                throw new Error(`ComfyUI reject: ${formatComfyReject(err)}`);
            }

            const promptId = submit.data?.prompt_id;
            if (!promptId) {
                throw new Error(`ComfyUI did not return prompt_id: ${JSON.stringify(submit.data)}`);
            }
            lastPromptId = promptId;

            if (onProgress) {
                onProgress({
                    phase: 'queued',
                    message: `Krea2 出图中 ${i + 1}/${prompts.length}` +
                        (options.enableUpscale ? ' · 含2×放大' : '') + '…',
                    promptId,
                    index: i + 1,
                    total: prompts.length
                });
            }

            const waited = await waitForHistory(promptId, {
                timeoutMs: options.timeoutMs || batchTimeoutMs(),
                onProgress,
                isCancelled: options.isCancelled,
                filenamePrefix,
                expectedCount: 1,
                sinceMs,
                outputDir: options.outputDir || resolveComfyOutputDir()
            });
            const saved = waited.images?.[0];
            if (!saved) {
                throw new Error(`Krea2 第 ${i + 1} 张未产出图片`);
            }
            lastSource = waited.source;

            const name = `${String(i + 1).padStart(3, '0')}.png`;
            const destPath = path.join(destDir, name);
            await downloadView(saved, destPath);
            files.push({ name, path: destPath, meta: saved });
        }

        return {
            promptId: lastPromptId,
            seed: null,
            files,
            multiPrompts: prompts,
            source: lastSource
        };
    });
}

async function listUpscaleModels() {
    try {
        const { data } = await axios.get(`${config.comfyUrl}/object_info/UpscaleModelLoader`, { timeout: 8000 });
        const names = data?.UpscaleModelLoader?.input?.required?.model_name?.[0];
        if (Array.isArray(names) && names.length) return names;
    } catch (e) {
        // ignore
    }
    return ['2x_Ani4Kv2_G6i2_Compact_107500.pth'];
}

async function interruptComfy() {
    const results = { interrupt: false, clearQueue: false };
    try {
        await axios.post(`${config.comfyUrl}/interrupt`, {}, { timeout: 5000 });
        results.interrupt = true;
    } catch (_) {}
    try {
        await axios.post(`${config.comfyUrl}/queue`, { clear: true }, { timeout: 5000 });
        results.clearQueue = true;
    } catch (_) {}
    return results;
}

module.exports = {
    ping,
    listCheckpoints,
    listLoras,
    listUpscaleModels,
    workflowDefaults,
    enqueue,
    generateOnce,
    generateToFile,
    generateBatchToDir,
    generateKrea2BatchToDir,
    buildPromptGraph,
    buildKrea2PromptGraph,
    joinMultiPrompts,
    allSavedImages,
    resolveComfyOutputDir,
    listRecentOutputImages,
    resolveOutputImagePath,
    safeOutputBasename,
    interruptComfy,
    batchTimeoutMs,
};
