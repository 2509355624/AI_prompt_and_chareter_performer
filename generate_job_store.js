/**
 * Disk-backed generate jobs so the UI can leave and resume.
 * Cost: ~1 small JSON per job under data/comfy_generate_jobs/ (images stay in uploads/).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const JOBS_DIR = path.join(DATA_DIR, 'comfy_generate_jobs');
const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_JOBS = 40;

function ensureJobsDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });
}

function jobPath(id) {
    return path.join(JOBS_DIR, `${id}.json`);
}

function publicJob(job) {
    if (!job) return null;
    return {
        id: job.id,
        status: job.status,
        phase: job.phase,
        message: job.message || '',
        presetId: job.presetId || '',
        presetName: job.presetName || '',
        mode: job.mode || 'ai',
        scene: job.scene || '',
        count: job.count || 0,
        batchId: job.batchId || null,
        promptId: job.promptId || null,
        images: Array.isArray(job.images) ? job.images : [],
        clothingPrompts: Array.isArray(job.clothingPrompts) ? job.clothingPrompts : [],
        error: job.error || null,
        source: job.source || null,
        elapsedMs: job.elapsedMs || 0,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt || null
    };
}

function writeJob(job) {
    ensureJobsDir();
    const copy = { ...job, updatedAt: Date.now() };
    fs.writeFileSync(jobPath(copy.id), JSON.stringify(copy, null, 2), 'utf8');
    return copy;
}

function readJob(id) {
    if (!id) return null;
    try {
        const raw = fs.readFileSync(jobPath(id), 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function listJobFiles() {
    ensureJobsDir();
    try {
        return fs.readdirSync(JOBS_DIR)
            .filter((n) => n.endsWith('.json'))
            .map((n) => {
                const full = path.join(JOBS_DIR, n);
                let mtime = 0;
                try {
                    mtime = fs.statSync(full).mtimeMs;
                } catch (_) {}
                return { name: n, id: n.replace(/\.json$/, ''), full, mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);
    } catch (_) {
        return [];
    }
}

function pruneJobs() {
    const files = listJobFiles();
    const now = Date.now();
    for (const f of files) {
        if (now - f.mtime > JOB_TTL_MS) {
            try {
                fs.unlinkSync(f.full);
            } catch (_) {}
        }
    }
    const remain = listJobFiles();
    for (let i = MAX_JOBS; i < remain.length; i++) {
        try {
            fs.unlinkSync(remain[i].full);
        } catch (_) {}
    }
}

function createJob(meta = {}) {
    ensureJobsDir();
    pruneJobs();
    const id = `job_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const now = Date.now();
    const job = {
        id,
        status: 'running',
        phase: 'starting',
        message: '任务已创建…',
        presetId: meta.presetId || '',
        presetName: meta.presetName || '',
        mode: meta.mode === 'manual' ? 'manual' : 'ai',
        scene: String(meta.scene || ''),
        count: Number(meta.count) || 1,
        batchId: null,
        promptId: null,
        images: [],
        clothingPrompts: [],
        error: null,
        source: null,
        elapsedMs: 0,
        createdAt: now,
        updatedAt: now,
        finishedAt: null
    };
    return writeJob(job);
}

function updateJob(id, patch = {}) {
    const job = readJob(id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: Date.now() });
    return writeJob(job);
}

function listRecentJobs(limit = 10) {
    const n = Math.max(1, Math.min(50, Number(limit) || 10));
    return listJobFiles()
        .slice(0, n)
        .map((f) => publicJob(readJob(f.id)))
        .filter(Boolean);
}

function findActiveJob() {
    for (const f of listJobFiles()) {
        const job = readJob(f.id);
        if (job && job.status === 'running') return publicJob(job);
    }
    return null;
}

/** Mark all disk "running" jobs as failed (e.g. after server restart). */
function abandonRunningJobs(reason = '任务已中断') {
    const msg = String(reason || '任务已中断');
    let n = 0;
    for (const f of listJobFiles()) {
        const job = readJob(f.id);
        if (!job || job.status !== 'running') continue;
        updateJob(job.id, {
            status: 'error',
            phase: 'abandoned',
            message: msg,
            error: msg,
            finishedAt: Date.now()
        });
        n += 1;
    }
    return n;
}

function cancelJob(id, reason = '用户取消') {
    const job = readJob(id);
    if (!job) return null;
    if (job.status !== 'running') return publicJob(job);
    const msg = String(reason || '用户取消');
    return publicJob(updateJob(id, {
        status: 'error',
        phase: 'cancelled',
        message: msg,
        error: msg,
        finishedAt: Date.now()
    }));
}

module.exports = {
    JOBS_DIR,
    ensureJobsDir,
    createJob,
    readJob,
    updateJob,
    publicJob,
    listRecentJobs,
    findActiveJob,
    abandonRunningJobs,
    cancelJob,
    pruneJobs
};
