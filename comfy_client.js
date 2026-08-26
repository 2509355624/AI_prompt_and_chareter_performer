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

    const seedOpt = num(options.seed, config.seed);
    gen.seed = seedOpt >= 0 ? Math.floor(seedOpt) : crypto.randomInt(1, 2 ** 48);

    if (graph['7'] && graph['7'].inputs) {
        graph['7'].inputs.text = options.negative || config.negativePrompt;
    }
    if (graph['9'] && graph['9'].inputs) {
        graph['9'].inputs.filename_prefix = 'character_chat';
    }
    return graph;
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
        negativePrompt: config.negativePrompt,
        loras: JSON.parse(JSON.stringify(config.loras || [])),
        samplerOptions: config.samplerOptions || [],
        schedulerOptions: config.schedulerOptions || []
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstSavedImage(historyEntry) {
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
    return found.find((img) => img.type === 'output') || found[0] || null;
}

async function waitForHistory(promptId) {
    const started = Date.now();
    while (Date.now() - started < config.timeoutMs) {
        const { data } = await axios.get(`${config.comfyUrl}/history/${promptId}`, { timeout: 10000 });
        const entry = data?.[promptId];
        if (entry) {
            if (entry.status?.status_str === 'error') {
                const msgs = (entry.status.messages || []).map((m) => JSON.stringify(m)).join('; ');
                throw new Error(`ComfyUI job failed: ${msgs || 'unknown error'}`);
            }
            if (firstSavedImage(entry) || entry.status?.completed) {
                const saved = firstSavedImage(entry);
                if (!saved) {
                    throw new Error('ComfyUI finished but produced no image');
                }
                return entry;
            }
        }
        await sleep(config.pollMs);
    }
    throw new Error(`ComfyUI timed out after ${config.timeoutMs}ms (prompt_id=${promptId})`);
}

async function downloadView(imageMeta, destPath) {
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
        const detail = err.response?.data?.error || err.response?.data || err.message;
        throw new Error(`ComfyUI reject: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }

    const promptId = submit.data?.prompt_id;
    if (!promptId) {
        throw new Error(`ComfyUI did not return prompt_id: ${JSON.stringify(submit.data)}`);
    }

    const history = await waitForHistory(promptId);
    const saved = firstSavedImage(history);
    if (!saved) {
        throw new Error('ComfyUI finished but produced no image');
    }
    const seed = graph['53']?.inputs?.seed ?? graph['7']?.inputs?.seed;
    return { promptId, saved, seed };
}

async function generateToFile(options, destPath) {
    return enqueue(async () => {
        const result = await generateOnce(options);
        await downloadView(result.saved, destPath);
        return result;
    });
}

module.exports = {
    ping,
    listCheckpoints,
    listLoras,
    workflowDefaults,
    enqueue,
    generateOnce,
    generateToFile,
    buildPromptGraph,
};
