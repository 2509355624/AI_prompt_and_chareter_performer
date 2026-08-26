const axios = require('axios');

async function listLoadedModels(baseUrl) {
    const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    try {
        const { data } = await axios.get(`${url}/api/ps`, { timeout: 8000 });
        return Array.isArray(data?.models) ? data.models : [];
    } catch (e) {
        return [];
    }
}

async function unloadModel(baseUrl, model) {
    if (!model) return;
    const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    try {
        await axios.post(`${url}/api/generate`, {
            model,
            keep_alive: 0
        }, { timeout: 15000 });
        console.log('[Ollama] unload keep_alive=0:', model);
    } catch (e) {
        try {
            await axios.delete(`${url}/api/generate`, {
                data: { model },
                timeout: 15000
            });
            console.log('[Ollama] unload DELETE:', model);
        } catch (e2) {
            console.warn('[Ollama] unload failed:', model, e2.message);
        }
    }
}

async function unloadAll(baseUrl) {
    const models = await listLoadedModels(baseUrl);
    for (const item of models) {
        const name = item.name || item.model;
        await unloadModel(baseUrl, name);
    }
    return models.length;
}

module.exports = {
    listLoadedModels,
    unloadModel,
    unloadAll
};
