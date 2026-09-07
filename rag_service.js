const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function resolveRagDataDir() {
    const raw = String(process.env.RAG_DATA_DIR || '').trim();
    if (!raw) return path.join(ROOT, 'data', 'rag');
    return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

const RAG_DATA_DIR = resolveRagDataDir();
const INGEST_STATE_FILE = path.join(RAG_DATA_DIR, 'ingest_state.json');
const DAEMON_SCRIPT = path.join(ROOT, 'rag', 'rag_daemon.py');

// RAG 默认关闭：需在 .env 显式 RAG_ENABLED=1 才会启用（因为要额外下载/配置向量模型）。
const RAG_ENABLED = String(process.env.RAG_ENABLED || '0') !== '0';
const INGEST_EVERY_ASSISTANT_REPLIES = Math.max(
    1,
    parseInt(process.env.RAG_INGEST_EVERY_ASSISTANT_REPLIES || '5', 10)
);
const RETRIEVE_K = Math.max(1, parseInt(process.env.RAG_RETRIEVE_K || '4', 10));
const DAEMON_TIMEOUT_MS = Math.max(30000, parseInt(process.env.RAG_DAEMON_TIMEOUT_MS || '180000', 10));

class RagService {
    constructor() {
        this.proc = null;
        this.buffer = '';
        this.pending = new Map();
        this.reqId = 0;
        this.ready = false;
        this.startPromise = null;
        this.fatalDisabled = false;
    }

    isEnabled() {
        return RAG_ENABLED && !this.fatalDisabled;
    }

    getIngestEvery() {
        return INGEST_EVERY_ASSISTANT_REPLIES;
    }

    ensureDataDir() {
        if (!fs.existsSync(RAG_DATA_DIR)) {
            fs.mkdirSync(RAG_DATA_DIR, { recursive: true });
        }
    }

    loadIngestState() {
        this.ensureDataDir();
        try {
            return JSON.parse(fs.readFileSync(INGEST_STATE_FILE, 'utf8') || '{}');
        } catch (_) {
            return {};
        }
    }

    saveIngestState(state) {
        this.ensureDataDir();
        fs.writeFileSync(INGEST_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    }

    getCharacterIngestState(characterId) {
        const all = this.loadIngestState();
        return all[characterId] || { lastIngestedAssistantCount: 0 };
    }

    updateCharacterIngestState(characterId, lastIngestedAssistantCount) {
        const all = this.loadIngestState();
        all[characterId] = {
            lastIngestedAssistantCount,
            updatedAt: Date.now()
        };
        this.saveIngestState(all);
    }

    async start() {
        if (!RAG_ENABLED) {
            console.log('[RAG] disabled (RAG_ENABLED=0)');
            return false;
        }
        if (this.fatalDisabled) {
            console.log('[RAG] disabled (vector model missing)');
            return false;
        }
        if (this.startPromise) return this.startPromise;
        this.startPromise = this._startDaemon();
        return this.startPromise;
    }

    async _startDaemon() {
        this.ensureDataDir();
        const python = process.env.RAG_PYTHON || 'python';
        const env = { ...process.env };
        env.PYTHONIOENCODING = 'utf-8';
        env.PYTHONUNBUFFERED = '1';
        // 强制传绝对路径，避免 daemon cwd=rag/ 时把 ./data/rag 解析到 rag/data/rag
        env.RAG_DATA_DIR = RAG_DATA_DIR;
        console.log('[RAG] data_dir:', RAG_DATA_DIR);

        this.proc = spawn(python, [DAEMON_SCRIPT], {
            cwd: path.join(ROOT, 'rag'),
            env,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        this.proc.stderr.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text) console.error('[RAG daemon]', text);
        });

        this.proc.stdout.on('data', (chunk) => {
            this.buffer += chunk.toString();
            let idx;
            while ((idx = this.buffer.indexOf('\n')) >= 0) {
                const line = this.buffer.slice(0, idx).trim();
                this.buffer = this.buffer.slice(idx + 1);
                if (!line) continue;
                let msg;
                try {
                    msg = JSON.parse(line);
                } catch (e) {
                    console.warn('[RAG] bad daemon line:', line.slice(0, 200));
                    continue;
                }
                if (msg.event === 'model_missing') {
                    this.fatalDisabled = true;
                    console.error('[RAG] ' + (msg.hint || msg.error || `vector model not found (${msg.model || ''})`));
                    continue;
                }
                if (msg.event === 'ready' && msg.ok) {
                    this.ready = true;
                    continue;
                }
                const id = msg.id;
                const pending = this.pending.get(String(id));
                if (!pending) continue;
                this.pending.delete(String(id));
                if (msg.ok) pending.resolve(msg);
                else pending.reject(new Error(msg.error || 'RAG daemon error'));
            }
        });

        this.proc.on('exit', (code) => {
            console.error('[RAG] daemon exited:', code);
            this.ready = false;
            this.proc = null;
            this.startPromise = null;
            for (const [, pending] of this.pending.entries()) {
                pending.reject(new Error('RAG daemon exited'));
            }
            this.pending.clear();
        });

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('RAG daemon startup timeout')), 120000);
            const check = setInterval(() => {
                if (this.ready) {
                    clearInterval(check);
                    clearTimeout(timer);
                    resolve();
                }
            }, 100);
        });

        console.log('[RAG] daemon ready (local BGE-M3)');
        return true;
    }

    request(payload, timeoutMs = DAEMON_TIMEOUT_MS) {
        if (!this.proc || !this.ready) {
            return Promise.reject(new Error('RAG daemon not ready'));
        }
        const id = String(++this.reqId);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`RAG request timeout (${payload.cmd})`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (msg) => {
                    clearTimeout(timer);
                    resolve(msg);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                }
            });
            this.proc.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
        });
    }

    async retrieve(characterId, query) {
        if (!RAG_ENABLED || !characterId || !String(query || '').trim()) return [];
        try {
            await this.start();
            const resp = await this.request({
                cmd: 'retrieve',
                characterId,
                query: String(query).trim(),
                k: RETRIEVE_K
            }, 60000);
            return Array.isArray(resp.docs) ? resp.docs : [];
        } catch (e) {
            console.warn('[RAG] retrieve failed:', e.message);
            return [];
        }
    }

    async ingest(characterId, entries) {
        if (!RAG_ENABLED || !characterId || !entries?.length) return 0;
        await this.start();
        const resp = await this.request({
            cmd: 'ingest',
            characterId,
            entries
        }, DAEMON_TIMEOUT_MS);
        return resp.count || 0;
    }

    async deleteCharacter(characterId) {
        if (!RAG_ENABLED || !characterId) return false;
        try {
            await this.start();
            const resp = await this.request({
                cmd: 'delete_character',
                characterId
            }, 30000);
            const all = this.loadIngestState();
            delete all[characterId];
            this.saveIngestState(all);
            return Boolean(resp.deleted);
        } catch (e) {
            console.warn('[RAG] delete_character failed:', e.message);
            return false;
        }
    }

    countAssistantReplies(messages) {
        if (!Array.isArray(messages)) return 0;
        return messages.filter((m) => m && m.role === 'assistant').length;
    }

    pairMessages(messages) {
        const pairs = [];
        let i = 0;
        while (i < messages.length) {
            const m = messages[i];
            if (m?.role === 'user') {
                const next = messages[i + 1];
                if (next?.role === 'assistant') {
                    pairs.push({ user: m, assistant: next });
                    i += 2;
                } else {
                    i += 1;
                }
            } else {
                i += 1;
            }
        }
        return pairs;
    }

    extractBatchMessages(allMessages, fromAssistantIndex, toAssistantIndex) {
        const pairs = this.pairMessages(allMessages);
        const slice = pairs.slice(fromAssistantIndex - 1, toAssistantIndex);
        const out = [];
        for (const pair of slice) {
            out.push({ role: 'user', content: String(pair.user.content || '') });
            out.push({ role: 'assistant', content: String(pair.assistant.content || '') });
        }
        return out;
    }

    maybeScheduleIngest({ ragQueue, characterId, allMessages, provider, model, apiKey, baseUrl, stripVisualFn }) {
        if (!RAG_ENABLED || !ragQueue || !characterId) return null;

        const assistantCount = this.countAssistantReplies(allMessages);
        const state = this.getCharacterIngestState(characterId);
        const last = state.lastIngestedAssistantCount || 0;
        const delta = assistantCount - last;
        if (delta < INGEST_EVERY_ASSISTANT_REPLIES) return null;

        const pairEnd = assistantCount;
        const pairStart = last + 1;
        const batchMessages = this.extractBatchMessages(allMessages, pairStart, pairEnd);
        if (!batchMessages.length) return null;

        const job = {
            characterId,
            batchMessages,
            assistantRange: [pairStart, pairEnd],
            provider,
            model,
            apiKey,
            baseUrl,
            stripVisualFn
        };
        ragQueue.push(job);
        console.log(
            '[RAG] ingest scheduled',
            characterId,
            `assistant ${pairStart}-${pairEnd}`,
            'queue size:',
            ragQueue.size + 1
        );
        return job;
    }
}

module.exports = new RagService();
