const ragService = require('../rag_service');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForImageQueueDrain(getImageQueueSize, maxWaitMs = 300000) {
    const start = Date.now();
    while (getImageQueueSize() > 0) {
        if (Date.now() - start > maxWaitMs) {
            throw new Error('Timed out waiting for image queue before RAG ingest');
        }
        await sleep(2000);
    }
}

async function startRagWorker({ queue, aiService, getImageQueueSize }) {
    console.log('[RagWorker] started (single consumer)');
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const job = await queue.take();
        const {
            characterId,
            batchMessages,
            assistantRange,
            provider,
            model,
            apiKey,
            baseUrl,
            stripVisualFn
        } = job || {};

        if (!characterId || !Array.isArray(batchMessages) || !batchMessages.length) {
            console.warn('[RagWorker] skip invalid job');
            continue;
        }

        const [pairStart, pairEnd] = assistantRange || [];
        console.log('[RagWorker] processing', characterId, `assistant ${pairStart}-${pairEnd}`);

        try {
            await waitForImageQueueDrain(getImageQueueSize);

            const cleaned = batchMessages.map((m) => {
                if (m.role !== 'assistant') return m;
                const strip = typeof stripVisualFn === 'function' ? stripVisualFn : (t) => t;
                return { role: 'assistant', content: strip(m.content) };
            });

            const summary = await aiService.summarizeMemoryBatch({
                messages: cleaned,
                assistantRange: [pairStart, pairEnd],
                provider,
                model,
                apiKey,
                baseUrl
            });

            if (summary.skip || !summary.entries?.length) {
                console.log('[RagWorker] nothing to ingest (skip or empty)');
                ragService.updateCharacterIngestState(characterId, pairEnd);
                continue;
            }

            const entries = summary.entries.map((entry, idx) => ({
                id: `${characterId}_${pairStart}_${pairEnd}_${idx}`,
                content: entry.content,
                metadata: {
                    characterId,
                    about: entry.about || 'user',
                    assistantStart: pairStart,
                    assistantEnd: pairEnd,
                    topics: (entry.topics || []).join(','),
                    primaryEmotion: entry.primaryEmotion || '',
                    openThreads: (entry.openThreads || []).join(','),
                    source: 'batch_summary_v2'
                }
            }));

            const count = await ragService.ingest(characterId, entries);
            ragService.updateCharacterIngestState(characterId, pairEnd);
            console.log('[RagWorker] ingested', count, 'entries for', characterId);
        } catch (error) {
            console.error('[RagWorker] failed:', characterId, error.message);
        }

        await sleep(200);
    }
}

module.exports = { startRagWorker };
