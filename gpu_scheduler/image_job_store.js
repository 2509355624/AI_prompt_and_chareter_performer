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
