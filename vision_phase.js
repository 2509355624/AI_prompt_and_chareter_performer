const config = require('./chat_image_config');

/**
 * Phase 5 hook: reference-image / img2img identity lock.
 * Keep T2I as the only live path until this flag is turned on
 * and an i2i workflow is wired in comfy_client.
 */
function shouldUseReferenceImage(character) {
    return Boolean(config.visionI2iEnabled && character?.referenceImage);
}

function describeVisionState(character) {
    if (!config.visionI2iEnabled) {
        return {
            enabled: false,
            mode: 't2i',
            reason: 'vision i2i is phase 5; set COMFYUI_VISION_I2I=1 after a dedicated img2img workflow exists',
        };
    }
    if (!character?.referenceImage) {
        return {
            enabled: false,
            mode: 't2i',
            reason: 'no referenceImage on this character',
        };
    }
    return {
        enabled: true,
        mode: 'i2i',
        reason: 'flag on, but i2i workflow is not implemented yet; falling back to t2i',
        referenceImage: character.referenceImage,
    };
}

module.exports = {
    shouldUseReferenceImage,
    describeVisionState,
};
