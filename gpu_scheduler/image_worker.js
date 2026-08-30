const ollamaGuard = require('./ollama_guard');
const vramMonitor = require('./vram_monitor');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startImageWorker({ queue, jobStore, runCharacterImageJob }) {
    console.log('[ImageWorker] started (single consumer)');
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const item = await queue.take();
        const jobId = item?.jobId;
        const job = jobStore.getJob(jobId);
        if (!job) {
            console.warn('[ImageWorker] missing job:', jobId);
            continue;
        }

        const payload = job.payload || {};
        console.log('[ImageWorker] processing job:', jobId, 'messageId:', payload.messageId);

        try {
            jobStore.updateJob(jobId, { status: 'running', error: null });
            jobStore.emit(jobId, 'image_running', { jobId });

            if (payload.provider === 'ollama') {
                jobStore.emit(jobId, 'vram_waiting', { phase: 'ollama_unload' });
                const unloaded = await ollamaGuard.unloadAll(payload.baseUrl);
                console.log('[ImageWorker] ollama models unloaded:', unloaded);

                jobStore.emit(jobId, 'vram_waiting', {
                    phase: 'polling',
                    requiredMb: vramMonitor.MIN_FREE_VRAM_MB
                });

                const vram = await vramMonitor.waitForVram(
                    vramMonitor.MIN_FREE_VRAM_MB,
                    (freeMb) => {
                        jobStore.emit(jobId, 'vram_waiting', {
                            phase: 'polling',
                            freeMb,
                            requiredMb: vramMonitor.MIN_FREE_VRAM_MB
                        });
                    }
                );

                if (!vram.ok) {
                    throw new Error(vram.error || '显存不足，无法开始 ComfyUI 出图');
                }

                jobStore.emit(jobId, 'vram_ready', {
                    freeMb: vram.freeMb,
                    requiredMb: vramMonitor.MIN_FREE_VRAM_MB,
                    skipped: Boolean(vram.skipped)
                });
            }

            const result = await runCharacterImageJob(payload);
            jobStore.updateJob(jobId, { status: 'completed', result, error: null });
            jobStore.emit(jobId, 'image_done', { jobId, ...result });
            jobStore.close(jobId);
            console.log('[ImageWorker] completed job:', jobId);
        } catch (error) {
            const message = error.message || '出图失败';
            console.error('[ImageWorker] failed job:', jobId, message);
            jobStore.updateJob(jobId, { status: 'failed', error: message });
            jobStore.emit(jobId, 'image_failed', { jobId, error: message });
            jobStore.close(jobId);
        }

        await sleep(200);
    }
}

module.exports = { startImageWorker };
