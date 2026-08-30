const crypto = require('crypto');

class ImageJobStore {
    constructor() {
        this.jobs = new Map();
        this.subscribers = new Map();
    }

    createJob(payload) {
        const id = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const job = {
            id,
            status: 'queued',
            payload,
            result: null,
            error: null,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        this.jobs.set(id, job);
        return job;
    }

    getJob(id) {
        return this.jobs.get(id) || null;
    }

    /** Active (queued/running) image jobs for a character, newest first. */
    findActiveByCharacter(characterId) {
        if (!characterId) return [];
        return [...this.jobs.values()]
            .filter((job) =>
                job.payload?.characterId === characterId
                && (job.status === 'queued' || job.status === 'running')
            )
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    /** Match an in-flight or finished job by chat message id. */
    findByMessageId(messageId) {
        if (!messageId) return null;
        let best = null;
        for (const job of this.jobs.values()) {
            if (job.payload?.messageId !== messageId) continue;
            if (!best || job.createdAt > best.createdAt) best = job;
        }
        return best;
    }

    updateJob(id, patch) {
        const job = this.jobs.get(id);
        if (!job) return null;
        Object.assign(job, patch, { updatedAt: Date.now() });
        return job;
    }

    resetForRetry(id) {
        const job = this.jobs.get(id);
        if (!job) return null;
        job.status = 'queued';
        job.error = null;
        job.result = null;
        job.updatedAt = Date.now();
        return job;
    }

    subscribe(id, res) {
        if (!this.subscribers.has(id)) {
            this.subscribers.set(id, new Set());
        }
        this.subscribers.get(id).add(res);
        res.on('close', () => {
            const set = this.subscribers.get(id);
            if (set) {
                set.delete(res);
                if (!set.size) this.subscribers.delete(id);
            }
        });

        const job = this.getJob(id);
        if (job) {
            this._write(res, 'snapshot', this.publicView(job));
        }
    }

    emit(id, event, data) {
        const set = this.subscribers.get(id);
        if (!set || !set.size) return;
        for (const res of set) {
            this._write(res, event, data);
        }
    }

    /** 出图结束（成功/失败）后关掉该 job 的 SSE */
    close(id) {
        const set = this.subscribers.get(id);
        if (!set) return;
        for (const res of [...set]) {
            try {
                if (!res.writableEnded) res.end();
            } catch (_) {}
        }
        this.subscribers.delete(id);
    }

    _write(res, event, data) {
        if (res.writableEnded) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    publicView(job) {
        if (!job) return null;
        return {
            id: job.id,
            status: job.status,
            error: job.error,
            result: job.result,
            updatedAt: job.updatedAt
        };
    }
}

module.exports = ImageJobStore;
