const config = require('./chat_image_config');

const EMOTION_TO_VISUAL = {
    '开心': 'smile, cheerful, relaxed pose, sitting, casual indoor clothes, bright indoor room',
    '兴奋': 'excited, wide eyes, waving, energetic pose, standing, lively room',
    '感谢': 'gentle smile, slight bow, holding hands together, modest clothes, indoor',
    '满意': 'content smile, sitting, casual clothes, cozy indoor',
    '期待': 'hopeful eyes, leaning forward, waiting pose, indoor doorway',
    '好奇': 'curious, head tilt, looking to the side, indoor',
    '生气': 'angry, frown, clenched fists, standing, dramatic indoor',
    '难过': 'sad, looking down, sitting, holding own arms, dim indoor',
    '沮丧': 'depressed, slumped shoulders, sitting on bed, dim room',
    '失望': 'disappointed, quiet frown, standing, indoor',
    '焦虑': 'worried, fidgeting, holding sleeves, indoor',
    '委屈': 'teary eyes, pouting, hugging own arms, bedroom',
    '平静': 'calm, soft eyes, sitting, talking, indoor',
    '疑惑': 'confused, raised eyebrow, head tilt, indoor',
    '惊讶': 'surprised, wide eyes, open mouth, stepping back, indoor',
    '害羞': 'blush, looking away, holding sleeves, shy pose, bedroom',
    '犹豫': 'hesitant, fidgeting fingers, standing still, indoor',
};

const DEFAULT_APPEARANCE = {
    izumi_sagiri: '1girl, solo, Izumi Sagiri (Eromanga Sensei), silver hair, long hair, waist-length hair, twin tails, pink hair ribbons, blue eyes, pale skin, petite, small breasts, loli, fragile appearance',
    rem: '1girl, solo, blue hair, maid headdress, oni horn, heterochromia',
    asuna: '1girl, solo, long chestnut hair, green eyes',
    mikasa: '1girl, solo, short black hair, red scarf',
    saber: '1girl, solo, blonde hair tied back, green eyes',
};

function mapEmotion(primaryEmotion, intensity) {
    const key = String(primaryEmotion || '平静').trim();
    const base = EMOTION_TO_VISUAL[key] || EMOTION_TO_VISUAL['平静'];
    const n = Number(intensity);
    if (Number.isFinite(n) && n >= 8) {
        return `${base}, strong emotion, dynamic pose`;
    }
    if (Number.isFinite(n) && n <= 3) {
        return `${base}, subtle emotion`;
    }
    return base;
}

function appearanceFor(character) {
    if (character?.appearancePrompt && String(character.appearancePrompt).trim()) {
        return String(character.appearancePrompt).trim();
    }
    return DEFAULT_APPEARANCE[character?.id] || `1girl, solo, ${character?.name || 'anime girl'}`;
}

function outfitFor(character) {
    if (character?.outfitPrompt && String(character.outfitPrompt).trim()) {
        return String(character.outfitPrompt).trim();
    }
    return '';
}

function buildBasePrompt(character, options = {}) {
    const parts = [appearanceFor(character)];
    if (!options.skipOutfit) {
        parts.push(outfitFor(character));
    }
    return parts.filter(Boolean).join('\n\n');
}

function stripChineseFromTags(text) {
    return String(text || '')
        .split(/[\n,;，；]+/)
        .map((part) => part.trim())
        .filter((part) => part && !/[\u3400-\u9fff]/.test(part))
        .join(', ');
}

function tagsFromVisual(visual) {
    if (!visual || typeof visual !== 'object') return '';
    if (visual.prompt) return stripChineseFromTags(visual.prompt);
    // outfit first — SD/Comfy weights earlier tokens more; keeps clothing continuity stable
    const turnTagOrder = ['outfit', 'action', 'expression', 'scene', 'atmosphere', 'camera'];
    return stripChineseFromTags(
        turnTagOrder
            .map((key) => String(visual[key] || '').trim())
            .filter(Boolean)
            .join(', ')
    );
}

function isScenePromptUsable(visual) {
    const tags = tagsFromVisual(visual);
    if (!tags) return false;
    const parts = tags.split(',').map((part) => part.trim()).filter(Boolean);
    return parts.length >= 5;
}

function buildTurnPrompt({ visual }) {
    const fromAi = tagsFromVisual(visual);
    if (fromAi) {
        const outfit = stripChineseFromTags(String(visual?.outfit || '').trim());
        const restOrder = ['action', 'expression', 'scene', 'atmosphere', 'camera'];
        const rest = stripChineseFromTags(
            restOrder.map((key) => String(visual?.[key] || '').trim()).filter(Boolean).join(', ')
        );
        if (outfit && rest) return `${outfit}\n${rest}`;
        return fromAi;
    }
    return 'standing, from_front, soft_light, cozy, indoors';
}

function buildPositivePrompt(args) {
    const skipOutfit = Boolean(args.visual && tagsFromVisual(args.visual));
    const base = buildBasePrompt(args.character, { skipOutfit });
    const turn = buildTurnPrompt(args);
    return [base, turn].filter(Boolean).join('\n');
}

module.exports = {
    EMOTION_TO_VISUAL,
    DEFAULT_APPEARANCE,
    mapEmotion,
    appearanceFor,
    outfitFor,
    tagsFromVisual,
    isScenePromptUsable,
    buildBasePrompt,
    buildTurnPrompt,
    buildPositivePrompt,
};
