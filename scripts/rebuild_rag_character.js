/**
 * Rebuild one character's RAG memories from chat_history with current summarizer.
 * Usage: node scripts/rebuild_rag_character.js izumi_sagiri
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const aiService = require('../ai_service');
const ragService = require('../rag_service');

const characterId = process.argv[2] || 'izumi_sagiri';
const every = ragService.getIngestEvery();
const chatFile = path.join(__dirname, '..', 'data', 'chat_history.json');

async function main() {
    const chatData = JSON.parse(fs.readFileSync(chatFile, 'utf8') || '{}');
    const entry = chatData[characterId];
    const messages = Array.isArray(entry) ? entry : (entry?.messages || []);
    if (!messages.length) {
        throw new Error(`no chat history for ${characterId}`);
    }

    const provider = process.env.DEFAULT_CHAT_PROVIDER || 'doubao';
    const model = process.env.VOLC_CHAT_MODEL || process.env.DEEPSEEK_MODEL;
    const apiKey = provider === 'doubao'
        ? process.env.VOLC_API_KEY
        : process.env.DEEPSEEK_API_KEY;
    const baseUrl = provider === 'doubao'
        ? process.env.VOLC_BASE_URL
        : process.env.DEEPSEEK_BASE_URL;

    console.log('Rebuild RAG for', characterId, 'messages=', messages.length, 'every=', every);
    await ragService.start();
    await ragService.deleteCharacter(characterId);

    const pairs = ragService.pairMessages(messages);
    let written = 0;
    for (let end = every; end <= pairs.length; end += every) {
        const start = end - every + 1;
        const batchMessages = ragService.extractBatchMessages(messages, start, end);
        const cleaned = batchMessages.map((m) => ({
            role: m.role,
            content: m.role === 'assistant'
                ? aiService.stripVisualBlocksFromReply(m.content)
                : m.content
        }));
        console.log(`Summarizing assistant ${start}-${end}...`);
        const summary = await aiService.summarizeMemoryBatch({
            messages: cleaned,
            assistantRange: [start, end],
            provider,
            model,
            apiKey,
            baseUrl
        });
        if (summary.skip || !summary.entries?.length) {
            console.log('  skip');
            continue;
        }
        const entries = summary.entries.map((e, idx) => ({
            id: `${characterId}_${start}_${end}_${idx}`,
            content: e.content,
            metadata: {
                characterId,
                about: e.about || 'user',
                assistantStart: start,
                assistantEnd: end,
                topics: (e.topics || []).join(','),
                primaryEmotion: e.primaryEmotion || '',
                openThreads: (e.openThreads || []).join(','),
                source: 'batch_summary_v2'
            }
        }));
        for (const e of entries) {
            console.log(`  [${e.metadata.about}] ${e.content}`);
        }
        const count = await ragService.ingest(characterId, entries);
        written += count;
        ragService.updateCharacterIngestState(characterId, end);
    }

    const remainder = pairs.length % every;
    if (remainder === 0) {
        ragService.updateCharacterIngestState(characterId, pairs.length);
    } else {
        // keep watermark at last full batch so remaining turns wait for next threshold
        const lastFull = pairs.length - remainder;
        ragService.updateCharacterIngestState(characterId, lastFull);
        console.log(`Remainder ${remainder} turns not ingested yet (wait until next full batch)`);
    }

    console.log('Done. ingested entries=', written, 'watermark=', ragService.getCharacterIngestState(characterId));
    process.exit(0);
}

main().catch((err) => {
    console.error('Rebuild failed:', err.message);
    process.exit(1);
});
