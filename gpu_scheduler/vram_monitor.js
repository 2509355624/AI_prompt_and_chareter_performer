const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const MIN_FREE_VRAM_MB = Number(process.env.IMAGE_MIN_VRAM_MB) || 9216;
const POLL_MS = Number(process.env.VRAM_POLL_INTERVAL_MS) || 800;
const TIMEOUT_MS = Number(process.env.VRAM_WAIT_TIMEOUT_MS) || 120000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreeVramMb() {
    try {
        const { stdout } = await execFileAsync(
            'nvidia-smi',
            ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
            { timeout: 8000, windowsHide: true }
        );
        const line = stdout.trim().split(/\r?\n/)[0]?.trim();
        const mb = parseInt(line, 10);
        return Number.isFinite(mb) ? mb : null;
    } catch (e) {
        console.warn('[VRAM] nvidia-smi unavailable:', e.message);
        return null;
    }
}

async function waitForVram(minMb = MIN_FREE_VRAM_MB, onTick) {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        const freeMb = await getFreeVramMb();
        if (typeof onTick === 'function') {
            onTick(freeMb);
        }
        if (freeMb === null) {
            return { ok: true, skipped: true, freeMb: null };
        }
        if (freeMb >= minMb) {
            return { ok: true, freeMb, requiredMb: minMb };
        }
        await sleep(POLL_MS);
    }
    const freeMb = await getFreeVramMb();
    return {
        ok: false,
        freeMb,
        requiredMb: minMb,
        error: `等待显存超时：需要 ≥${minMb}MB 空闲，当前 ${freeMb ?? '?'}MB`
    };
}

module.exports = {
    MIN_FREE_VRAM_MB,
    POLL_MS,
    TIMEOUT_MS,
    getFreeVramMb,
    waitForVram
};
