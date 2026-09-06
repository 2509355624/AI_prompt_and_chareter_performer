/**
 * One-shot RAG smoke test: start daemon → ingest → retrieve
 * Usage: node scripts/test_rag.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const ragService = require('../rag_service');

async function main() {
    const characterId = 'rag_smoke_test';
    console.log('RAG_PYTHON:', process.env.RAG_PYTHON);
    console.log('Starting daemon...');
    await ragService.start();

    console.log('Ingesting test memory...');
    const count = await ragService.ingest(characterId, [{
        id: `${characterId}_1_5_0`,
        content: '用户在咖啡厅分享了童年在海边玩耍的回忆，情绪偏怀旧。角色温柔回应，并承诺下次带用户去同一座海边。',
        metadata: {
            characterId,
            assistantStart: 1,
            assistantEnd: 5,
            topics: '童年,海边,承诺',
            source: 'smoke_test'
        }
    }]);
    console.log('Ingested entries:', count);

    console.log('Retrieving with query: 之前说的海边...');
    const docs = await ragService.retrieve(characterId, '之前说的海边和童年');
    console.log('Retrieved', docs.length, 'doc(s):');
    for (const doc of docs) {
        console.log('---');
        console.log('id:', doc.id);
        console.log('distance:', doc.distance);
        console.log('content:', doc.content);
    }

    console.log('Cleaning up test collection...');
    await ragService.deleteCharacter(characterId);
    console.log('RAG smoke test OK');
}

main().catch((err) => {
    console.error('RAG smoke test FAILED:', err.message);
    process.exit(1);
});
