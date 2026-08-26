const crypto = require('crypto');

class ChatTurnStore {
    constructor() {
        this.turns = new Map();
        this.subscribers = new Map();
    }

    createTurn(payload) {
        const id = `turn_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const turn = {
            id,
            status: 'queued',
            phase: 'queued',
            payload,
            thinkingText: '',
            replyText: '',
            result: null,
            error: null,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        this.turns.set(id, turn);
        return turn;
    }

    getTurn(id) {
        return this.turns.get(id) || null;
    }

    updateTurn(id, patch) {
        const turn = this.turns.get(id);
        if (!turn) return null;
        Object.assign(turn, patch, { updatedAt: Date.now() });
        return turn;
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

        const turn = this.getTurn(id);
        if (turn) {
            this._write(res, 'snapshot', this.publicView(turn));
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

    publicView(turn) {
        if (!turn) return null;
        return {
            id: turn.id,
            status: turn.status,
            phase: turn.phase,
            thinkingText: turn.thinkingText,
            replyText: turn.replyText,
            error: turn.error,
            result: turn.result,
            updatedAt: turn.updatedAt
        };
    }
}

module.exports = ChatTurnStore;
