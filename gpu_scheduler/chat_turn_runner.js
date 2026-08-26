const ollamaGuard = require('./ollama_guard');

async function processChatTurn({ turnId, turnStore, aiService, payload }) {
    const turn = turnStore.getTurn(turnId);
    if (!turn) return;

    turnStore.updateTurn(turnId, { status: 'running', phase: 'starting' });

    const emit = (event, data) => {
        if (event === 'thinking_delta') {
            turnStore.updateTurn(turnId, {
                phase: 'reply_generating',
                thinkingText: data.accumulated || ''
            });
        } else if (event === 'reply_delta') {
            turnStore.updateTurn(turnId, {
                phase: 'reply_generating',
                replyText: data.accumulated || ''
            });
        } else if (event === 'phase') {
            turnStore.updateTurn(turnId, { phase: data.phase });
        }
        turnStore.emit(turnId, event, data);
    };

    try {
        const result = await aiService.runChatTurn(payload, emit);
        turnStore.updateTurn(turnId, {
            status: 'completed',
            phase: 'done',
            result,
            error: null
        });
        turnStore.emit(turnId, 'turn_done', { turnId, ...result });

        if (payload.provider === 'ollama') {
            try {
                await ollamaGuard.unloadAll(payload.baseUrl);
            } catch (e) {
                console.warn('[ChatTurn] post-turn ollama unload failed:', e.message);
            }
        }
    } catch (error) {
        const message = error.message || '对话生成失败';
        console.error('[ChatTurn] failed:', turnId, message);
        turnStore.updateTurn(turnId, {
            status: 'failed',
            phase: 'error',
            error: message
        });
        turnStore.emit(turnId, 'turn_error', { turnId, error: message });
    }
}

module.exports = { processChatTurn };
