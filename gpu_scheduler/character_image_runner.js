const fs = require('fs');
const path = require('path');
const aiService = require('../ai_service');
const comfyClient = require('../comfy_client');
const imagePrompt = require('../image_prompt');
const chatImageConfig = require('../chat_image_config');
const visionPhase = require('../vision_phase');

async function runCharacterImageJob(payload, { charactersFile, chatImagesDir }) {
    const started = Date.now();
    const {
        characterId,
        replySnippet,
        messageId,
        visual: visualFromChat,
        previousVisual,
        userMessage,
        provider,
        model,
        apiKey,
        baseUrl,
        checkpointName: checkpointNameFromClient,
        workflowSettings: workflowSettingsFromClient
    } = payload || {};

    if (!characterId) {
        throw new Error('characterId is required');
    }

    let characters;
    try {
        characters = JSON.parse(fs.readFileSync(charactersFile, 'utf8') || '[]');
    } catch (e) {
        throw new Error('Failed to load characters');
    }
    const character = characters.find((c) => c.id === characterId);
    if (!character) {
        throw new Error(`Character not found: ${characterId}`);
    }

    const vision = visionPhase.describeVisionState(character);
    let visual = visualFromChat || null;
    const skipLlmFallback = Boolean(payload.skipLlmFallback) || provider === 'ollama';
    if (!imagePrompt.isScenePromptUsable(visual) && replySnippet && !skipLlmFallback) {
        try {
            const generated = await aiService.generateSceneTags({
                reply: replySnippet,
                userMessage: userMessage || '',
                provider: provider || 'deepseek',
                model,
                apiKey,
                baseUrl,
                previousVisual: previousVisual || null
            });
            if (imagePrompt.isScenePromptUsable(generated) || imagePrompt.tagsFromVisual(generated)) {
                visual = generated;
            }
        } catch (error) {
            console.error('Scene tag generation error:', error.message);
        }
    }

    const skipOutfit = Boolean(visual && imagePrompt.tagsFromVisual(visual));
    const basePrompt = imagePrompt.buildBasePrompt(character, { skipOutfit });
    const turnPrompt = imagePrompt.buildTurnPrompt({ visual });
    const positive = [basePrompt, turnPrompt].filter(Boolean).join('\n');
    const defaults = comfyClient.workflowDefaults();
    const workflowSettings = {
        ...defaults,
        ...(workflowSettingsFromClient && typeof workflowSettingsFromClient === 'object' ? workflowSettingsFromClient : {}),
        checkpointName:
            (workflowSettingsFromClient && workflowSettingsFromClient.checkpointName)
            || checkpointNameFromClient
            || defaults.checkpointName
    };
    const negative = workflowSettings.negativePrompt || chatImageConfig.negativePrompt;
    const checkpointName = workflowSettings.checkpointName;
    const destName = `${characterId}_${messageId || Date.now()}.png`.replace(/[^\w.-]/g, '_');
    const destPath = path.join(chatImagesDir, destName);

    const result = await comfyClient.generateToFile({
        basePrompt,
        turnPrompt,
        negative,
        ...workflowSettings
    }, destPath);

    return {
        ok: true,
        imageUrl: `/uploads/chat_images/${destName}`,
        promptId: result.promptId,
        seed: result.seed,
        elapsedMs: Date.now() - started,
        prompt: positive,
        turnPrompt,
        visual,
        checkpointName,
        workflowSettings,
        negative,
        vision,
        messageId: messageId || null
    };
}

module.exports = { runCharacterImageJob };
