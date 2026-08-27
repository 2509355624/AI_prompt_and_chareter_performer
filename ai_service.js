const axios = require('axios');

/** Recent verbatim rounds sent in messages; older context via turnMemory briefs */
const RECENT_FULL_ROUNDS = 4;
const TURN_MEMORY_STORE_MAX = 20;
const TURN_MEMORY_PROMPT_MAX = 10;
const EMOTION_CONTEXT_ROUNDS = 4;

class AIService {
    constructor() {
        // Enforce JSON format in system prompt
        this.systemPrompt = `你是一个专业的AI绘图提示词生成器。
你的任务是根据用户的主题，生成详细、高质量、画面感极强的英文AI绘图提示词（Prompts）。

**核心要求：**
1. **理解与美化**：深入理解用户输入的意图，在不偏离核心主题的前提下，进行艺术化的润色和细节补充（如光影、构图、材质、氛围）。
2. **多样性**：根据用户要求的数量，生成不同风格、视角、神态、背景或时间段的提示词。确保每一个提示词都能描绘出一幅独特的画面。
3. **格式严格**：必须输出严格的JSON字符串数组。例如：["Detailed Prompt 1...", "Detailed Prompt 2..."]。
4. **语言**：无论用户输入什么语言，最终生成的提示词必须是英文，适用于Midjourney/Stable Diffusion。
5. **纯净输出**：严禁输出Markdown代码块、解释或前言，只返回JSON数组。
`;

        // 阶段1：纯情感分析（不含服饰/出图）
        this.emotionAnalysisPrompt = `你是一个专业的情感分析师，请分析以下对话中的用户情感状态。

【对话历史】
{chat_history}

【当前用户消息】
{user_message}

【分析要求】
1. 识别用户当前的核心情绪、强度、趋势
2. 识别导致情绪变化的关键事件
3. 给出角色对白语气建议（tone / keyPoints）

【输出格式】
{
  "analysisVersion": "1.0",
  "emotionAnalysis": {
    "primaryEmotion": "主情绪标签",
    "secondaryEmotions": ["次要情绪1"],
    "intensity": 0-10,
    "trend": "上升/下降/稳定",
    "confidence": 0-100
  },
  "contextAnalysis": {
    "keyEvents": ["事件1"],
    "relationshipTendency": "亲密/疏远/稳定",
    "topicFocus": "当前话题"
  },
  "responseSuggestion": {
    "tone": "建议语气",
    "keyPoints": ["要点1"]
  }
}

【注意】只分析情绪与对白语气；不要输出服饰、动作、场景或任何 SD 出图 tags。只输出 JSON。`;

        // 阶段2：服饰 + 分镜（以【当前已出图状态】为权威基准）
        this.outfitVisualAnalysisPrompt = `你是 SD1.5 服饰与分镜策划。根据【当前已出图状态】与【当前用户消息】决定本轮 outfitPlan 与 visualPlan。

【对话历史（语境参考；旧服装描述不得覆盖已出图状态）】
{chat_history}

【当前用户消息（唯一可触发换装/脱衣/换场景的指令来源）】
{user_message}

【当前已出图状态 — 最高优先级基准】
{current_visual_state}

【输出格式】
{
  "analysisVersion": "1.0",
  "outfitPlan": {
    "changeOutfit": false,
    "outfitTags": "nude",
    "note": "一句话说明（中文）"
  },
  "visualPlan": {
    "action": "arms_outstretched, shy_pose",
    "expression": "blush, averted_eyes, embarrassed",
    "scene": "indoors, art_studio, desk, window",
    "atmosphere": "soft_morning_light, calm, cozy",
    "camera": "full_body_shot, from_front, eye_level"
  }
}

【连续性 — 最重要】
1. 默认延续【当前已出图状态】：changeOutfit=false 时 outfitTags 逐 tag 复制上方服饰；未换场景时 scene/atmosphere 逐 tag 复制上方分镜。
2. 对话历史中的水手服、短裙等，若与【当前已出图状态】冲突，以已出图状态为准。
3. 仅【当前用户消息】明确要求换装/脱衣/指定穿着/换场景，才可 changeOutfit=true 或重写 scene。
4. 当前消息只是姿势/展示要求（如「张开双手」「我看看」）→ 不得改 outfit，只更新 action/expression/camera。

【outfitPlan】
SD1.5 英文逗号 tags；指定穿着写对应 tags；脱光/不要衣服 → 仅 nude；只脱上衣则保留下装 tags。

【visualPlan】
英文 tags；不写外貌；不含 outfit。用户说「不要拿东西/空手」→ 全部字段删除 holding_*、carrying_*，改用 arms_outstretched 等空手 pose。

【粉色大象】
用户说「不要 X」→ 从全部字段直接删除 X 相关 tag；禁止 no_X、without_X。

【注意】只输出 JSON。`;
    }

    // 解析火山引擎模型别名
    resolveDoubaoModel(model) {
        if (model === '1.6') return process.env.VOLC_MODEL_1_6;
        if (model === '2.0') return process.env.VOLC_MODEL_2_0;
        if (model === '1.8') return process.env.VOLC_MODEL_1_8 || process.env.VOLC_MODEL;
        return model || process.env.VOLC_MODEL_1_8 || process.env.VOLC_MODEL || 'deepseek-v4-flash-ga-260731';
    }

    async getOllamaModels(baseUrl) {
        const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
        try {
            const response = await axios.get(`${url}/api/tags`, { timeout: 600000 });
            if (response.data && response.data.models) {
                return response.data.models.map(m => m.name);
            }
            return [];
        } catch (error) {
            console.error('Failed to fetch Ollama models:', error.message);
            throw new Error('无法连接到 Ollama，请确保它已在运行。');
        }
    }

    async chatWithAI(messages, provider, model, apiKey, baseUrl) {
        // General Chat function supporting multiple providers
        const systemMessage = {
            role: 'system',
            content: '你是一个乐于助人的AI助手，专门帮助用户构思绘画创意和角色设定。请用中文回答。'
        };

        const chatMessages = [systemMessage, ...messages];

        if (provider === 'ollama') {
            const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
            try {
                const response = await axios.post(`${url}/api/chat`, {
                    model: model,
                    messages: chatMessages,
                    stream: false,
                    keep_alive: 0
                }, { timeout: 600000 });
                return response.data?.message?.content || '无回复';
            } catch (e) {
                throw new Error(`Ollama Chat Error: ${e.message}`);
            }
        } else if (provider === 'doubao') {
             // Reuse Doubao logic but for chat
             const key = process.env.VOLC_API_KEY;
             const url = (process.env.VOLC_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
             
             // Use OpenAI compatible endpoint for chat
             const endpoint = url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
             
             // Determine model
            const targetModel = this.resolveDoubaoModel(model);
            
            try {
                const response = await axios.post(endpoint, {
                    model: targetModel,
                    messages: chatMessages,
                    stream: false
                }, {
                    headers: { 
                        'Authorization': `Bearer ${key}`,
                        'Content-Type': 'application/json'
                    }
                });
                return response.data?.choices?.[0]?.message?.content || '无回复';
             } catch (e) {
                 const msg = e.response?.data?.error?.message || e.message;
                 throw new Error(`Doubao Chat Error: ${msg}`);
             }
        } else if (provider === 'deepseek') {
            const key = process.env.DEEPSEEK_API_KEY;
            const url = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
            try {
                const response = await axios.post(`${url}/chat/completions`, {
                    model: model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash-ga-260731',
                    messages: chatMessages,
                    stream: false
                }, {
                    headers: { 
                        'Authorization': `Bearer ${key}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 600000
                });
                return response.data?.choices?.[0]?.message?.content || '无回复';
            } catch (e) {
                throw new Error(`DeepSeek Chat Error: ${e.message}`);
            }
        } else {
            // OpenAI compatible
            const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
            try {
                const response = await axios.post(`${url}/chat/completions`, {
                    model: model,
                    messages: chatMessages
                }, {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });
                return response.data?.choices?.[0]?.message?.content || '无回复';
            } catch (e) {
                 throw new Error(`API Chat Error: ${e.message}`);
            }
        }
    }

    async completeText(messages, provider, model, apiKey, baseUrl) {
        if (provider === 'ollama') {
            const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
            const response = await axios.post(`${url}/api/chat`, {
                model,
                messages,
                stream: false,
                keep_alive: 0
            }, { timeout: 600000 });
            return response.data?.message?.content || '';
        }
        if (provider === 'doubao') {
            const key = process.env.VOLC_API_KEY;
            const url = (process.env.VOLC_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
            const endpoint = url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
            const response = await axios.post(endpoint, {
                model: this.resolveDoubaoModel(model),
                messages,
                stream: false
            }, {
                headers: {
                    Authorization: `Bearer ${key}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60000
            });
            return response.data?.choices?.[0]?.message?.content || '';
        }
        const isDeepseek = provider === 'deepseek' || !provider;
        const key = isDeepseek ? process.env.DEEPSEEK_API_KEY : apiKey;
        const url = (isDeepseek
            ? (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com')
            : (baseUrl || 'https://api.openai.com/v1')
        ).replace(/\/$/, '');
        const endpoint = url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
        const response = await axios.post(endpoint, {
            model: model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash-ga-260731',
            messages,
            stream: false
        }, {
            headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json'
            },
            timeout: 60000
        });
        return response.data?.choices?.[0]?.message?.content || '';
    }

    /** 统一 JSON 分析调用（情感 / 服饰分镜） */
    async callJsonAnalysis(prompt, provider, model, apiKey, baseUrl) {
        const messages = [{ role: 'user', content: prompt }];
        if (provider === 'ollama') {
            const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
            const response = await axios.post(`${url}/api/chat`, {
                model,
                messages,
                stream: false,
                format: 'json',
                keep_alive: 0
            }, { timeout: 600000 });
            return response.data?.message?.content || '';
        }
        if (provider === 'doubao') {
            const key = process.env.VOLC_API_KEY;
            const url = (process.env.VOLC_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
            const endpoint = url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
            const response = await axios.post(endpoint, {
                model: this.resolveDoubaoModel(model),
                messages,
                stream: false,
                response_format: { type: 'json_object' }
            }, {
                headers: {
                    Authorization: `Bearer ${key}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60000
            });
            return response.data?.choices?.[0]?.message?.content || '';
        }
        const isDeepseek = provider === 'deepseek';
        const key = isDeepseek ? process.env.DEEPSEEK_API_KEY : apiKey;
        const url = (isDeepseek
            ? (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com')
            : (baseUrl || 'https://api.openai.com/v1')
        ).replace(/\/$/, '');
        const endpoint = url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
        const body = {
            model: model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash-ga-260731',
            messages,
            stream: false
        };
        if (isDeepseek) body.response_format = { type: 'json_object' };
        const response = await axios.post(endpoint, body, {
            headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json'
            },
            timeout: 600000
        });
        return response.data?.choices?.[0]?.message?.content || '';
    }

    formatCurrentVisualStateBlock(previousVisual) {
        const outfit = this.formatPreviousOutfitTags(previousVisual);
        const structured = this.formatPreviousVisualStructured(previousVisual, {}, { skipOutfit: true });
        if (!structured && outfit === '（无，首轮）') {
            return '（首轮，无上一张出图）';
        }
        const lines = [];
        if (outfit && outfit !== '（无，首轮）') lines.push(`- 服饰：${outfit}`);
        if (structured) lines.push(structured.replace(/^/gm, '').trim());
        return lines.length ? lines.join('\n') : '（无上一张出图）';
    }

    mergeVisualAnalysis(emotionResult, outfitVisualResult) {
        return {
            ...emotionResult,
            outfitPlan: outfitVisualResult?.outfitPlan || { changeOutfit: false, outfitTags: '', note: '' },
            visualPlan: outfitVisualResult?.visualPlan || {}
        };
    }

    sceneTagExpertPrompt() {
        return `#分镜 tags（SD 1.5 / Danbooru）
按当前对白与用户动作，输出六个字段。每个字段：英文短 tags，逗号分隔，多词用下划线（如 medium_shot, looking_away）。
只写本轮可见内容；不要写角色固定外貌（底模已有）。

#字段（outfit 由情绪分析阶段单独决定，此处不要写 outfit 行）
1. action — 姿势/动作/互动：standing, pointing, holding
2. expression — 表情眼神：blush, smile, averted_eyes
3. scene — 此刻所在地点 + 4～6 个可见物件：indoors, clothing_store, clothes_rack, mannequin, mirror
4. atmosphere — 光影氛围：warm_lighting, soft_glow, cozy
5. camera — 景别机位：medium_shot, from_front, upper_body

#场景
- scene = 相机拍到的空间，不是对白话题
- 判定换场景 → 整套重写 scene/atmosphere；未换 → 逐 tag 复制上一张

#示例（5 行，无 outfit）
###
action: standing, leaning_forward, pointing, shy_pose
expression: blush, shy_smile, curious
scene: indoors, cake_shop, display_case, cake, wooden_table, pendant_light
atmosphere: warm_lighting, soft_glow, cozy, bokeh
camera: medium_shot, from_front, upper_body
###`;
    }

    /** Previous outfit tags for emotion analysis prompt */
    formatPreviousOutfitTags(previousVisual) {
        if (!previousVisual) return '（无，首轮）';
        if (typeof previousVisual === 'object') {
            const o = String(previousVisual.outfit || '').trim();
            if (o) return o;
            if (previousVisual.prompt) {
                const m = String(previousVisual.prompt).match(/^(.*?)(?:,\s*standing|, standing)/i);
                return m ? m[1].slice(0, 200) : '';
            }
        }
        return String(previousVisual).trim() || '（无）';
    }

    /** Tag is a negation-style prompt (pink elephant — mentions what user does not want) */
    isNegationTag(tag) {
        const t = String(tag || '').trim();
        if (!t) return true;
        return /^(?:no|not|without|dont|never|avoid)[-_]?/i.test(t)
            || /^(?:no|not|without)\s/i.test(t);
    }

    /** Clothing / wearable-related tag fragments to purge when outfit is nude */
    clothingTagPattern() {
        return /(?:sailor_uniform|school_uniform|pleated_skirt|miniskirt|skirt|dress|gown|hoodie|sweatpants|sweater|cardigan|shirt|blouse|top|jacket|coat|pants|trousers|jeans|shorts|uniform|stockings|thighhighs|pantyhose|legwear|socks|kneehighs|bra|panties|underwear|lingerie|swimsuit|bikini|maid|apron|kimono|yukata|cosplay|costume|scarf|gloves|boots|shoes|sandals|hat|cap|headdress|ribbon|necktie|tie|clothes|clothing|outfit|garment|wear|wardrobe|closet|hanger|clothes_rack|clothing_store|mannequin|skindentation|zettai_ryouiki|clutching_skirt|skirt_hem|holding_skirt|adjusting_clothes|changing_clothes|undressing|towel|bath_towel|holding_towel|wrapped_in_towel|bathrobe|robe)/i;
    }

    stripClothingTags(raw) {
        return String(raw || '')
            .split(/[\n,;，；]+/)
            .map((part) => part.trim())
            .filter((part) => part && !this.isNegationTag(part) && !this.clothingTagPattern().test(part))
            .join(', ');
    }

    stripNegationTags(raw) {
        return String(raw || '')
            .split(/[\n,;，；]+/)
            .map((part) => part.trim())
            .filter((part) => part && !this.isNegationTag(part))
            .join(', ');
    }

    /** User wants no clothes — outfit becomes nude; purge clothing from all visual fields */
    detectRemoveClothingIntent(userText) {
        const text = String(userText || '').trim();
        if (!text) return false;
        const narrations = this.extractNarrationFragments(text);
        const combined = [text, ...narrations].join('\n');

        if (/(?:换成|穿上|换上|试穿|试下|试一下).{0,24}(?:水手|短裙|泳装|比基尼|制服|连衣裙|校服|和服|裤袜|丝袜|uniform|skirt|bikini|dress|stockings|thighhighs)/i.test(combined)) {
            return false;
        }

        return /不需要.{0,10}(?:衣服|衣物|服饰|服装|穿)|不要.{0,10}(?:衣服|衣物|服饰|服装)|不穿衣服|不用穿|没穿衣服|脱(?:掉|了|光|下)?(?:衣服|光)?|去掉(?:所有)?(?:衣服|服饰|服装)|全裸|裸体|赤裸|\bnude\b|\bnaked\b|把衣服换掉|换掉衣服|衣服换掉|脱掉/i.test(combined);
    }

    shouldStripClothing(emotionResult, lastUserMsg) {
        if (this.detectRemoveClothingIntent(lastUserMsg)) return true;
        const tags = String(emotionResult?.outfitPlan?.outfitTags || '').trim().toLowerCase();
        return tags === 'nude' || tags === 'naked' || /^nude(?:,|$)/.test(tags);
    }

    stripClothingFromVisualPlan(visualPlan) {
        if (!visualPlan || typeof visualPlan !== 'object') return;
        for (const key of ['action', 'expression', 'scene', 'atmosphere', 'camera']) {
            visualPlan[key] = this.stripClothingTags(visualPlan[key]);
        }
    }

    stripClothingFromVisual(visual) {
        if (!visual || typeof visual !== 'object') return visual;
        const result = { ...visual };
        for (const key of ['action', 'expression', 'scene', 'atmosphere', 'camera']) {
            result[key] = this.stripClothingTags(this.stripNegationTags(result[key]));
        }
        if (String(result.prompt || '').trim()) {
            result.prompt = this.assembleVisualPrompt(result);
        }
        return result;
    }

    resolveChangeIntent(lastUserMsg, emotionResult, previousVisual) {
        const fromRegex = this.detectVisualChangeIntent(lastUserMsg);
        const removeClothing = this.detectRemoveClothingIntent(lastUserMsg);
        const outfitChange = fromRegex.outfitChange || removeClothing;

        return {
            outfitChange,
            sceneChange: fromRegex.sceneChange,
            sceneTargetHint: fromRegex.sceneTargetHint
        };
    }

    /** 对话系统提示：仅角色 + 情绪 + 记忆，不含任何出图指令 */
    buildDialogueSystemPrompt(characterSystemPrompt, emotionResult, turnMemory, conversationSummary) {
        const memoryText = this.buildMemoryContextBlock(turnMemory, conversationSummary);
        const ea = emotionResult?.emotionAnalysis || {};
        const rs = emotionResult?.responseSuggestion || {};
        const emotionInfo = `
【用户情绪状态】
- 主情绪：${ea.primaryEmotion || '平静'}（强度：${ea.intensity ?? 3}/10）
- 情绪趋势：${ea.trend || '稳定'}
- 建议语气：${rs.tone || '温柔'}
- 回复要点：${Array.isArray(rs.keyPoints) ? rs.keyPoints.join('；') : '无'}
`.trim();
        return `${characterSystemPrompt}\n\n${emotionInfo}${memoryText}`.trim();
    }

    formatPreviousVisualForEmotionAnalysis(previousVisual, userMessage = '') {
        const changeIntent = this.detectVisualChangeIntent(userMessage);
        const structured = this.formatPreviousVisualStructured(previousVisual, changeIntent, { skipOutfit: true });
        if (structured) {
            return `\n【上一张图分镜 tags（未换场景时 visualPlan.scene/atmosphere 必须逐 tag 复制）】\n${structured}\n`;
        }
        return '';
    }

    applyOutfitPlanToVisual(visual, emotionResult, previousVisual, changeIntent) {
        const merged = visual && typeof visual === 'object' ? { ...visual } : {};
        const plan = emotionResult?.outfitPlan;
        const planned = String(plan?.outfitTags || '').trim();
        const enforced = [];

        if (planned) {
            merged.outfit = this.sanitizeEnglishTags(planned) || planned;
            enforced.push('outfit_from_plan');
        } else if (!changeIntent.outfitChange && previousVisual?.outfit) {
            merged.outfit = String(previousVisual.outfit).trim();
            enforced.push('outfit_copy');
        }

        const normalized = this.normalizeVisual(merged);
        const result = normalized || merged;
        if (String(result.outfit || '').trim()) {
            result.prompt = this.assembleVisualPrompt(result);
        } else if (planned) {
            result.outfit = planned;
            result.prompt = this.assembleVisualPrompt(result);
        }
        return { visual: result, outfitEnforced: enforced };
    }

    detectRemoveHeldPropIntent(userText) {
        const text = String(userText || '').trim();
        if (!text) return false;
        return /不要拿|别拿|不要持|空手|不要东西|别拿东西|不要拿东西|张开双手|伸出手|展开双手/i.test(text);
    }

    heldPropTagPattern() {
        return /(?:holding|carrying|clutching|gripping|hugging_object|holding_object|holding_clothes|holding_towel|holding_item)/i;
    }

    stripHeldPropTags(raw) {
        return String(raw || '')
            .split(/[\n,;，；]+/)
            .map((part) => part.trim())
            .filter((part) => part && !this.heldPropTagPattern().test(part))
            .join(', ');
    }

    ensureOutfitPlan(visualResult, previousVisual, lastUserMsg) {
        if (!visualResult) return;
        if (!visualResult.outfitPlan || typeof visualResult.outfitPlan !== 'object') {
            visualResult.outfitPlan = { changeOutfit: false, outfitTags: '', note: '' };
        }
        const plan = visualResult.outfitPlan;
        const intent = this.detectVisualChangeIntent(lastUserMsg);

        if (this.detectRemoveClothingIntent(lastUserMsg)) {
            plan.changeOutfit = true;
            plan.outfitTags = 'nude';
            plan.note = plan.note || '用户要求去除全部服饰';
            return;
        }

        if (!intent.outfitChange) {
            const prev = this.formatPreviousOutfitTags(previousVisual);
            if (prev && prev !== '（无，首轮）' && prev !== '（无）') {
                plan.changeOutfit = false;
                plan.outfitTags = prev;
                plan.note = '沿用上一张已出图服饰';
                return;
            }
        }

        if (String(plan.outfitTags || '').trim()) return;

        const prev = this.formatPreviousOutfitTags(previousVisual);
        if (prev && prev !== '（无，首轮）' && prev !== '（无）') {
            plan.changeOutfit = false;
            plan.outfitTags = prev;
            plan.note = plan.note || '沿用上一张服饰';
        }
    }

    ensureVisualPlan(visualResult, previousVisual, lastUserMsg) {
        if (!visualResult) return;
        if (!visualResult.visualPlan || typeof visualResult.visualPlan !== 'object') {
            visualResult.visualPlan = {};
        }
        const plan = visualResult.visualPlan;
        const changeIntent = this.resolveChangeIntent(lastUserMsg, visualResult, previousVisual);
        const prev = previousVisual && typeof previousVisual === 'object' ? previousVisual : {};

        for (const key of ['action', 'expression', 'camera']) {
            if (!String(plan[key] || '').trim() && prev[key]) {
                plan[key] = String(prev[key]).trim();
            }
        }
        if (!changeIntent.sceneChange) {
            for (const key of ['scene', 'atmosphere']) {
                if (!String(plan[key] || '').trim() && prev[key]) {
                    plan[key] = String(prev[key]).trim();
                }
            }
        }

        for (const key of ['action', 'expression', 'scene', 'atmosphere', 'camera']) {
            plan[key] = this.stripNegationTags(plan[key]);
        }
        if (this.detectRemoveHeldPropIntent(lastUserMsg)) {
            for (const key of ['action', 'expression', 'scene', 'atmosphere', 'camera']) {
                plan[key] = this.stripHeldPropTags(plan[key]);
            }
            if (!String(plan.action || '').trim()) {
                plan.action = 'arms_outstretched, shy_pose';
            }
        }
        if (this.shouldStripClothing(visualResult, lastUserMsg)) {
            this.stripClothingFromVisualPlan(plan);
        }
    }

    buildVisualFromEmotionPlan(emotionResult, previousVisual, changeIntent, lastUserMsg = '') {
        const vp = emotionResult?.visualPlan || {};
        const merged = {
            action: this.stripNegationTags(this.sanitizeEnglishTags(vp.action) || String(vp.action || '').trim()),
            outfit: '',
            expression: this.stripNegationTags(this.sanitizeEnglishTags(vp.expression) || String(vp.expression || '').trim()),
            scene: this.stripNegationTags(this.sanitizeEnglishTags(vp.scene) || String(vp.scene || '').trim()),
            atmosphere: this.stripNegationTags(this.sanitizeEnglishTags(vp.atmosphere) || String(vp.atmosphere || '').trim()),
            camera: this.stripNegationTags(this.sanitizeEnglishTags(vp.camera) || String(vp.camera || '').trim())
        };
        const { visual: afterContinuity, enforced } = this.enforceVisualContinuity(
            merged, previousVisual, changeIntent, { skipOutfit: true }
        );
        const { visual: withOutfit, outfitEnforced } = this.applyOutfitPlanToVisual(
            afterContinuity, emotionResult, previousVisual, changeIntent
        );
        let visual = withOutfit;
        const clothingEnforced = [];
        if (this.shouldStripClothing(emotionResult, lastUserMsg)) {
            visual = this.stripClothingFromVisual(visual);
            clothingEnforced.push('clothing_purge_all_fields');
        }
        return {
            visual,
            enforced: [...enforced, ...outfitEnforced, ...clothingEnforced],
            visualFromPlan: { ...vp }
        };
    }

    stripVisualBlocksFromReply(raw) {
        const { displayReply } = this.splitReplyAndVisual(raw);
        return displayReply || String(raw || '').trim();
    }

    /** Extract recent user/assistant messages for model context */
    extractRecentTurns(cleanMessages, maxRounds = RECENT_FULL_ROUNDS) {
        const recentTurns = [];
        let hasOlderHistory = false;
        let i = cleanMessages.length - 1;
        if (i >= 0 && cleanMessages[i].role === 'user') {
            recentTurns.unshift(cleanMessages[i]);
            i--;
        }
        let turnsCollected = 0;
        while (i >= 0 && turnsCollected < maxRounds) {
            if (cleanMessages[i].role === 'assistant' && i - 1 >= 0 && cleanMessages[i - 1].role === 'user') {
                recentTurns.unshift(cleanMessages[i]);
                recentTurns.unshift(cleanMessages[i - 1]);
                turnsCollected++;
                i -= 2;
            } else {
                i--;
            }
        }
        hasOlderHistory = i >= 0;
        return { recentTurns, hasOlderHistory, fullRoundsIncluded: turnsCollected };
    }

    /** Format stored turn briefs for system prompt (exclude rounds already in full messages) */
    formatTurnMemoryForPrompt(turnMemory, fullRoundCount = RECENT_FULL_ROUNDS, promptMax = TURN_MEMORY_PROMPT_MAX) {
        if (!Array.isArray(turnMemory) || !turnMemory.length) return '';
        const excludeCount = Math.min(fullRoundCount, turnMemory.length);
        const older = turnMemory.slice(0, turnMemory.length - excludeCount);
        if (!older.length) return '';
        const capped = older.slice(-promptMax);
        const lines = capped.map((entry, idx) => {
            const baseIndex = turnMemory.length - excludeCount - capped.length + idx;
            const n = entry.turnIndex ?? baseIndex + 1;
            const userB = String(entry.userBrief || '').trim() || '…';
            const aiB = String(entry.assistantBrief || '').trim() || '…';
            const emo = entry.emotion?.primaryEmotion
                || entry.emotionAnalysis?.emotionAnalysis?.primaryEmotion
                || '';
            const intensity = entry.emotion?.intensity ?? entry.emotionAnalysis?.emotionAnalysis?.intensity;
            const emoPart = emo
                ? `｜情绪：${emo}${Number.isFinite(intensity) ? `(强度${intensity})` : ''}`
                : '';
            return `- 第${n}轮 用户：${userB}｜角色：${aiB}${emoPart}`;
        });
        return `\n\n【情节记忆（较早轮次摘要；最近 ${fullRoundCount} 轮完整对白在 messages 中，以 messages 为准）】\n${lines.join('\n')}`;
    }

    buildMemoryContextBlock(turnMemory, conversationSummary) {
        const fromTurnMemory = this.formatTurnMemoryForPrompt(turnMemory);
        if (fromTurnMemory) return fromTurnMemory;
        if (conversationSummary) {
            return `\n\n【对话历史摘要（旧版）】\n${conversationSummary}`;
        }
        return '';
    }

    truncateBrief(text, maxLen = 40) {
        const s = String(text || '').replace(/\s+/g, ' ').trim();
        if (!s) return '';
        return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}…`;
    }

    parseTurnBriefResponse(raw, lastUserMessage, lastReply) {
        const text = String(raw || '').trim();
        const userMatch = text.match(/用户\s*[:：]\s*(.+)/i);
        const assistantMatch = text.match(/角色\s*[:：]\s*(.+)/i);
        return {
            userBrief: this.truncateBrief(userMatch?.[1] || lastUserMessage),
            assistantBrief: this.truncateBrief(assistantMatch?.[1] || lastReply)
        };
    }

    async generateTurnBrief(lastUserMessage, lastReply, provider, model, apiKey, baseUrl) {
        const fallback = {
            userBrief: this.truncateBrief(lastUserMessage),
            assistantBrief: this.truncateBrief(lastReply)
        };
        if (!lastUserMessage && !lastReply) return fallback;

        const briefPrompt = `请用极简中文概括本轮对话，供长对话记忆使用。每行不超过40字。

用户消息：${lastUserMessage || '无'}
角色回复：${lastReply || '无'}

严格按以下两行格式输出，不要其它内容：
用户：（概括用户说了什么）
角色：（概括角色回复了什么）`;

        try {
            let raw = '';
            if (provider === 'ollama') {
                const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
                const response = await axios.post(`${url}/api/chat`, {
                    model,
                    messages: [{ role: 'user', content: briefPrompt }],
                    stream: false,
                    keep_alive: 0
                }, { timeout: 120000 });
                raw = response.data?.message?.content?.trim() || '';
            } else {
                const key = provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : apiKey;
                const url = (baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
                const response = await axios.post(`${url}/chat/completions`, {
                    model: model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash-ga-260731',
                    messages: [{ role: 'user', content: briefPrompt }],
                    stream: false
                }, {
                    headers: {
                        Authorization: `Bearer ${key}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 120000
                });
                raw = response.data?.choices?.[0]?.message?.content?.trim() || '';
            }
            return this.parseTurnBriefResponse(raw, lastUserMessage, lastReply);
        } catch (e) {
            console.warn('[TurnMemory] brief generation failed, using truncate fallback:', e.message);
            return fallback;
        }
    }

    appendTurnMemoryEntry(turnMemory, entry) {
        const list = Array.isArray(turnMemory) ? [...turnMemory] : [];
        if (entry) list.push(entry);
        if (list.length > TURN_MEMORY_STORE_MAX) {
            return list.slice(-TURN_MEMORY_STORE_MAX);
        }
        return list;
    }

    /** Extract a short place hint from user text for scene-change prompts */
    extractSceneTargetHint(userText) {
        const text = String(userText || '').trim();
        if (!text) return '';
        const patterns = [
            /(?:到了|来到|已在|现在在|我们在)\s*[「"']?([^，。！？\n*「」"']{2,16})/i,
            /(?:去|来到|进入|走进|回到|前往|设在|切换(?:到|成|为)|换(?:到|成))\s*[「"']?([^，。！？\n*「」"']{2,16})/i,
            /\*[^*]*(?:去|来到|进入|走进|回到|前往)([^*，。！？]{2,16})/i
        ];
        for (const re of patterns) {
            const m = text.match(re);
            if (m?.[1]) {
                return m[1]
                    .replace(/^了+/, '')
                    .replace(/[吧呢啊哦嘛了]+$/, '')
                    .trim();
            }
        }
        return '';
    }

    /** Collect roleplay / narration fragments (*...*, （...）) */
    extractNarrationFragments(userText) {
        const text = String(userText || '');
        const parts = [];
        const re = /\*[^*]+\*|[（(][^）)]+[）)]/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            parts.push(m[0].replace(/^[*（(]|[*）)]$/g, ''));
        }
        return parts;
    }

    /** Detect whether the latest user message asks to change scene or outfit. */
    detectVisualChangeIntent(userText) {
        const text = String(userText || '').trim();
        if (!text) {
            return { outfitChange: false, sceneChange: false, sceneTargetHint: '' };
        }

        const narrations = this.extractNarrationFragments(text);
        const combined = [text, ...narrations].join('\n');

        const outfitChange = /换衣服|换装|穿上|脱下|换上|脱掉|另换|另一套|换身|换件|试穿|试一下|试下|穿戴|佩戴|换成|换下|泳装|比基尼|校服|水手服|连衣裙|短裙|裤袜|过膝|勒肉|丝袜|和服|cos|sailor|uniform|skirt|stockings|thighhighs|zettai_ryouiki|skindentation/i.test(combined);

        const outfitRequestedInContext = /(?:已经|正在|准备|打算|愿意|可以|让我|给我).{0,12}(?:换|穿|试)|(?:穿|戴|换).{0,8}(?:水手|短裙|裤袜|制服|泳装|连衣裙)/i.test(combined);

        const explicitRelocate = /换(?:个|到|成|为)?(?:地方|场景|地点|房间|背景|设定)|(?:切换|改换|更换)(?:到|成|为)?(?:场景|地点|背景)?|离开(?:这里|这儿|这|那|店|家|房间)?|出门(?:了)?|去(?:外面|户外)|转移(?:到|地点)|移步/i.test(combined);

        const arriveAtPlace = /(?:到了|来到|已在|现在在|我们在|坐在|站在|躺在|身在)(?:了)?/i.test(combined);

        const relocateVerb = /(?:我们|咱们|一起|带你?|跟我|要|先|快)?(?:去|往|到|来到|走进|进入|进去|换到|移到|带到|回|直奔|前往|溜进|钻进)/i;

        const placeTarget = /(?:服装|蛋糕|甜品|咖啡|书|便利|百货|宠物|花|理发|美容|奶茶|面包|超市|药)?店|餐厅|饭店|食堂|酒馆|酒吧|浴室|卫生间|厕所|淋浴|洗手间|厨房|客厅|卧室|房间|学校|教室|走廊|楼道|泳池|游泳池|公园|商场|地铁|办公室|工作室|画桌|海边|沙滩|森林|阳台|天台|家|家里|家中|卧室|旅馆|酒店|宾馆|医院|图书馆|游乐园|电影院|车站|机场|便利店|clothing store|restaurant|bathroom|bedroom|kitchen|living room|pool|park|school|outdoor|shower|beach|mall|cafe|office|home|hotel|hospital|library|cinema|station|airport|supermarket|convenience store/i.test(combined);

        const goEatOut = /去.*(?:吃饭|用餐|吃点|吃夜宵|吃午饭|吃晚饭|吃早餐)|(?:一起|去)吃(?:个|点)?(?:饭|餐|蛋糕|东西|夜宵)/i.test(combined);

        const goToPlace = /(?:^|[，。！？\s])去(?:了)?\s*\S/i.test(text);

        const narrationMove = narrations.some((n) =>
            /(?:去|来到|进入|走进|离开|前往|带到|回到|移步|奔向)/.test(n)
            && /(?:店|家|room|室|园|馆|厅|场|海|公园|school|bathroom|kitchen|bedroom|沙滩|商场|咖啡|浴室|厨房|客厅|卧室|学校|教室|office|home|beach|mall)/i.test(n)
        );

        const inviteGo = /(?:要不|不如|我们|咱们).{0,8}(?:去|到|来)/i.test(combined) && placeTarget;

        const sceneChange = explicitRelocate
            || (relocateVerb.test(combined) && (placeTarget || goEatOut))
            || goToPlace
            || (arriveAtPlace && placeTarget)
            || narrationMove
            || inviteGo;

        const sceneTargetHint = sceneChange ? this.extractSceneTargetHint(combined) : '';

        return { outfitChange: outfitChange || outfitRequestedInContext, sceneChange, sceneTargetHint };
    }

    visualChangeHint(changeIntent, userMessage) {
        if (!userMessage) return '';
        const lines = ['#本轮意图'];
        if (changeIntent.sceneChange) {
            lines.push(`- 换场景${changeIntent.sceneTargetHint ? ` → ${changeIntent.sceneTargetHint}` : ''}：重写 scene + atmosphere`);
        } else {
            lines.push('- 场景不变：复制上一张 scene/atmosphere');
        }
        if (changeIntent.outfitChange) {
            lines.push('- 换装：重写 outfit');
        } else {
            lines.push('- 服装不变：复制上一张 outfit');
        }
        lines.push('- 更新 action / expression / camera');
        lines.push(`- 用户原话：${userMessage.slice(0, 200)}`);
        return lines.join('\n');
    }

    formatPreviousVisual(previousVisual) {
        if (!previousVisual) return '';
        if (typeof previousVisual === 'string') return previousVisual.trim();
        const structured = this.formatPreviousVisualStructured(previousVisual);
        if (structured) return structured;
        if (previousVisual.prompt) return String(previousVisual.prompt).trim();
        return ['action', 'outfit', 'expression', 'scene', 'atmosphere', 'camera']
            .map((key) => String(previousVisual[key] || '').trim())
            .filter(Boolean)
            .join(', ');
    }

    formatPreviousVisualStructured(previousVisual, changeIntent = {}, options = {}) {
        if (!previousVisual || typeof previousVisual !== 'object') return '';
        const skipScene = Boolean(changeIntent.sceneChange);
        const skipOutfit = Boolean(options.skipOutfit);
        const fields = [
            ['action', '动作'],
            ...(skipOutfit ? [] : [['outfit', '服饰']]),
            ['expression', '表情'],
            ...(skipScene ? [] : [['scene', '场景'], ['atmosphere', '氛围']]),
            ['camera', '机位']
        ];
        const lines = fields
            .map(([key, label]) => {
                const val = String(previousVisual[key] || '').trim();
                return val ? `- ${label}：${val}` : '';
            })
            .filter(Boolean);
        return lines.length ? lines.join('\n') : '';
    }

    continuityInstruction(previousVisual, changeIntent = {}, options = {}) {
        const prevStructured = this.formatPreviousVisualStructured(previousVisual, changeIntent, options);
        const prevFlat = !prevStructured && previousVisual
            ? (typeof previousVisual === 'string' ? previousVisual.trim() : String(previousVisual.prompt || '').trim())
            : '';
        const prev = prevStructured || prevFlat;
        if (!prev) return '';

        const sceneRule = changeIntent.sceneChange
            ? `2. 【换场景】${changeIntent.sceneTargetHint ? `目标：${changeIntent.sceneTargetHint}。` : ''}重写 scene + atmosphere，勿沿用上一张。`
            : '2. 【保场景】逐 tag 复制上一张 scene + atmosphere。';

        const outfitRule = options.skipOutfit
            ? '1. 【服饰】已由分析阶段注入，### 块勿写 outfit。'
            : (changeIntent.outfitChange
                ? '1. 【换装】重写 outfit。'
                : '1. 【保服饰】逐 tag 复制上一张 outfit（可追加 wet/clinging 等状态）。');

        const header = changeIntent.sceneChange
            ? `#连续性（换场景）`
            : `#连续性`;

        return `
${header}
上一张图${changeIntent.sceneChange ? '（不含 scene/atmosphere）' : ''}${options.skipOutfit ? '（不含 outfit）' : ''}：
${prev}

${outfitRule}
${sceneRule}
3. 更新 action / expression / camera，贴合本轮对白。
4. tags 用 SD1.5 英文逗号分隔（如 medium_shot）。`;
    }

    buildVisualInstruction(previousVisual = null, changeIntent = {}, userMessage = '') {
        const changeHint = this.visualChangeHint(changeIntent, userMessage);
        return `${this.continuityInstruction(previousVisual, changeIntent, { skipOutfit: true })}
${changeHint}

${this.sceneTagExpertPrompt()}

#输出
先写角色对白，再 ### 包裹五行：action, expression, scene, atmosphere, camera（不要 outfit）。`;
    }

    visualFieldOrder() {
        return ['action', 'outfit', 'expression', 'scene', 'atmosphere', 'camera'];
    }

    /** Comfy/SD tag order — outfit first for stronger clothing continuity */
    comfyTagFieldOrder() {
        return ['outfit', 'action', 'expression', 'scene', 'atmosphere', 'camera'];
    }

    assembleVisualPrompt(visual) {
        if (!visual || typeof visual !== 'object') return '';
        return this.comfyTagFieldOrder()
            .map((key) => String(visual[key] || '').trim())
            .filter(Boolean)
            .join(', ');
    }

    normalizeVisual(visual) {
        if (!visual || typeof visual !== 'object') return null;
        const normalized = {};
        for (const key of this.visualFieldOrder()) {
            normalized[key] = String(visual[key] || '').trim();
        }
        normalized.prompt = this.assembleVisualPrompt(normalized);
        if (!normalized.prompt) return null;
        return normalized;
    }

    async generateSceneTags({
        reply,
        userMessage = '',
        provider,
        model,
        apiKey,
        baseUrl,
        previousVisual = null
    }) {
        const changeIntent = this.detectVisualChangeIntent(userMessage);
        const messages = [
            {
                role: 'system',
                content: `${this.sceneTagExpertPrompt()}
${this.continuityInstruction(previousVisual, changeIntent)}
${this.visualChangeHint(changeIntent, userMessage)}

只输出 ### 分镜块，不要对白。`
            },
            {
                role: 'user',
                content: `用户最新消息：\n${userMessage || '(无)'}\n\n角色本轮对白：\n${reply}`
            }
        ];
        const raw = await this.completeText(messages, provider, model, apiKey, baseUrl);
        const split = this.splitReplyAndVisual(raw);
        const parsed = split.visual || this.visualFromTagBlock(raw);
        const { visual } = this.enforceVisualContinuity(parsed, previousVisual, changeIntent);
        return visual;
    }

    async generateWithOllama(model, topic, count, baseUrl) {
        const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
        const prompt = `Generate ${count} distinct, high-quality image prompts for the topic: "${topic}".`;

        try {
            const response = await axios.post(`${url}/api/chat`, {
                model: model,
                messages: [
                    { role: 'system', content: this.systemPrompt },
                    { role: 'user', content: prompt }
                ],
                stream: false,
                format: 'json',
                keep_alive: 0
            }, {
                timeout: 600000, // 10 minutes timeout
                headers: {
                    'Connection': 'close' // Ensure new connection for each request
                }
            });

            if (response.data && response.data.message) {
                return this.parseResponse(response.data.message.content);
            } else {
                throw new Error('Unexpected response format from Ollama');
            }
        } catch (error) {
            console.error('Ollama Error:', error.message);
            throw new Error(`Ollama generation failed: ${error.message}`);
        }
    }

    async generateWithApiKey(apiKey, baseUrl, model, topic, count) {
        const prompt = `Generate ${count} distinct, high-quality image prompts for the topic: "${topic}".`;
        
        if (!baseUrl) throw new Error('Base URL is required for API calls');
        const url = baseUrl.replace(/\/$/, '');
        const endpoint = url.endsWith('/v1') ? `${url}/chat/completions` : `${url}/v1/chat/completions`;

        try {
            const response = await axios.post(endpoint, {
                model: model,
                messages: [
                    { role: 'system', content: this.systemPrompt },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.7
            }, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.data && response.data.choices && response.data.choices.length > 0) {
                return this.parseResponse(response.data.choices[0].message.content);
            } else {
                throw new Error('Unexpected response format from API');
            }
        } catch (error) {
            const msg = error.response?.data?.error?.message || error.message;
            console.error('API Error:', msg);
            throw new Error(`API generation failed: ${msg}`);
        }
    }

    async generateWithDoubao(topic, count, imageUrl = null, modelAlias = '1.8') {
        const apiKey = process.env.VOLC_API_KEY;
        const model = this.resolveDoubaoModel(modelAlias);

        const baseUrl = process.env.VOLC_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';

        if (!apiKey || !model) {
            throw new Error('后端未配置 Volcengine (Doubao) 的 API Key 或 Model ID。请检查 .env 文件。');
        }

        const url = baseUrl.replace(/\/$/, '');
        const endpoint = url.endsWith('/responses') ? url : `${url}/responses`;
        
        let contentInput = [];
        
        if (imageUrl) {
            contentInput.push({
                type: 'input_image',
                image_url: imageUrl
            });
            const prompt = `Based on this image and the topic "${topic}", generate ${count} distinct, high-quality, and detailed English AI art prompts (JSON array format).`;
            contentInput.push({
                type: 'input_text',
                text: `${this.systemPrompt}\n\n${prompt}`
            });
        } else {
            const prompt = `Generate ${count} distinct, high-quality image prompts for the topic: "${topic}".`;
            contentInput.push({
                type: 'input_text',
                text: `${this.systemPrompt}\n\n${prompt}`
            });
        }

        try {
            const response = await axios.post(endpoint, {
                model: model,
                input: [
                    {
                        role: 'user',
                        content: contentInput
                    }
                ]
            }, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            const output = response.data?.output;
            let text = '';

            if (Array.isArray(output) && output.length > 0) {
                // Iterate through output items to find the message content
                for (const item of output) {
                    if (item.content && Array.isArray(item.content)) {
                        const itemText = item.content
                            .map(c => c.text)
                            .filter(Boolean)
                            .join('');
                        if (itemText) {
                            text += itemText;
                        }
                    }
                }
            }

            if (!text && response.data?.output_text) {
                text = response.data.output_text;
            }

            if (!text) {
                throw new Error('Unexpected response format from Doubao');
            }

            return this.parseResponse(text);
        } catch (error) {
            const msg = error.response?.data?.error?.message || error.message;
            console.error('Doubao Error:', msg);
            throw new Error(`Doubao generation failed: ${msg}`);
        }
    }

    parseResponse(content) {
        console.log('Raw AI Response:', content);
        
        try {
            const cleanContent = content.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanContent);
            
            if (Array.isArray(parsed)) {
                return parsed;
            }
            if (parsed.prompts && Array.isArray(parsed.prompts)) {
                return parsed.prompts;
            }
            const arrayValue = Object.values(parsed).find(v => Array.isArray(v));
            if (arrayValue) return arrayValue;

            // Handle flat object with string values (e.g. {"prompt1": "...", "prompt2": "..."})
            const stringValues = Object.values(parsed).filter(v => typeof v === 'string');
            if (stringValues.length > 0) {
                return stringValues;
            }
        } catch (e) {
            console.warn('JSON parsing failed, attempting fallback parsing.');
        }

        return content.split('\n')
            .map(line => line.trim())
            .filter(line => {
                if (line.length < 5) return false;
                if (line.startsWith('[') || line.startsWith(']')) return false;
                if (line.startsWith('{') || line.startsWith('}')) return false;
                return true;
            })
            .map(line => line.replace(/^\d+[\.\)]\s*/, '').replace(/^-\s*/, ''));
    }

    // 解析情感分析响应
    parseEmotionResponse(content) {
        try {
            const cleanContent = content.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanContent);
            if (parsed.emotionAnalysis && parsed.responseSuggestion) {
                return {
                    analysisVersion: parsed.analysisVersion || '1.0',
                    emotionAnalysis: parsed.emotionAnalysis,
                    contextAnalysis: parsed.contextAnalysis || {},
                    responseSuggestion: parsed.responseSuggestion
                };
            }
        } catch (e) {
            console.warn('Emotion JSON parsing failed:', e.message);
        }
        return {
            analysisVersion: '1.0',
            emotionAnalysis: {
                primaryEmotion: '平静',
                secondaryEmotions: [],
                intensity: 3,
                trend: '稳定',
                confidence: 50
            },
            contextAnalysis: {
                keyEvents: [],
                relationshipTendency: '稳定',
                topicFocus: '未知'
            },
            responseSuggestion: {
                tone: '温柔',
                keyPoints: []
            }
        };
    }

    parseOutfitVisualResponse(content) {
        try {
            const cleanContent = content.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanContent);
            if (parsed.outfitPlan || parsed.visualPlan) {
                return {
                    analysisVersion: parsed.analysisVersion || '1.0',
                    outfitPlan: parsed.outfitPlan || { changeOutfit: false, outfitTags: '', note: '' },
                    visualPlan: parsed.visualPlan || {}
                };
            }
        } catch (e) {
            console.warn('Outfit/Visual JSON parsing failed:', e.message);
        }
        return {
            analysisVersion: '1.0',
            outfitPlan: { changeOutfit: false, outfitTags: '', note: '' },
            visualPlan: {}
        };
    }

    parseVisualMarkdownBlock(raw) {
        let body = String(raw || '').trim();
        if (!body) return null;

        const fenced = body.match(/###\s*([\s\S]*?)\s*###/);
        if (fenced) {
            body = fenced[1].trim();
        } else if (/^#{3}\s*/.test(body)) {
            body = body.replace(/^#{3}\s*/, '').trim();
        }

        const visual = {};
        for (const key of this.visualFieldOrder()) {
            const re = new RegExp(`^${key}\\s*[:：]\\s*(.+)$`, 'im');
            const match = body.match(re);
            if (match) {
                visual[key] = match[1].trim().replace(/\*\*/g, '').trim();
            }
        }

        const hasCore = visual.action || visual.outfit || visual.expression || visual.scene;
        if (!hasCore) return null;
        return this.normalizeVisual(visual);
    }

    parseVisualJson(raw) {
        try {
            let cleaned = String(raw || '')
                .replace(/```json/gi, '')
                .replace(/```/g, '')
                .trim();
            const start = cleaned.indexOf('{');
            const end = cleaned.lastIndexOf('}');
            if (start >= 0 && end > start) {
                cleaned = cleaned.slice(start, end + 1);
            }
            const parsed = JSON.parse(cleaned);
            if (!parsed || typeof parsed !== 'object') return null;
            const visual = this.normalizeVisual(parsed);
            if (!visual) return null;
            const hasCore = visual.action || visual.outfit || visual.expression || visual.scene;
            return hasCore ? visual : null;
        } catch (e) {
            return null;
        }
    }

    sanitizeEnglishTags(raw) {
        let text = String(raw || '')
            .replace(/```(?:json|prompt|text)?/gi, '')
            .replace(/```/g, '')
            .trim();
        const asMarkdown = this.parseVisualMarkdownBlock(text);
        if (asMarkdown?.prompt) return asMarkdown.prompt;
        const asJson = this.parseVisualJson(text);
        if (asJson?.prompt) return asJson.prompt;
        const heading = /^(prompt|image\s*prompt|tags|visual|绘图提示词|出图提示词)\s*[:：-]?\s*/i;
        const parts = text
            .split(/[\n,;，；]+/)
            .map((part) => part.replace(heading, '').replace(/^[-*•]\s*/, '').trim())
            .filter((part) => part && !/[\u3400-\u9fff]/.test(part) && !/^#{1,6}$/.test(part) && !this.isNegationTag(part));
        return parts.join(', ');
    }

    visualFromTagBlock(raw) {
        const asMarkdown = this.parseVisualMarkdownBlock(raw);
        if (asMarkdown) return asMarkdown;
        const asJson = this.parseVisualJson(raw);
        if (asJson) return asJson;
        const pick = (key) => {
            const match = String(raw || '').match(new RegExp(`${key}\\s*[:：]\\s*([^\\n]+)`, 'i'));
            return match ? this.sanitizeEnglishTags(match[1]) : '';
        };
        const prompt = this.sanitizeEnglishTags(raw);
        if (!prompt) return null;
        const visual = {
            action: pick('action'),
            outfit: pick('outfit'),
            expression: pick('expression'),
            scene: pick('scene'),
            atmosphere: pick('atmosphere'),
            camera: pick('camera'),
            prompt
        };
        return this.normalizeVisual(visual) || visual;
    }

    splitReplyAndVisual(raw) {
        const text = String(raw || '').replace(/\r\n/g, '\n');

        const fencedMatch = text.match(/###\s*([\s\S]*?)\s*###/);
        if (fencedMatch) {
            const displayReply = text.slice(0, fencedMatch.index).trim();
            const visual = this.parseVisualMarkdownBlock(fencedMatch[0]);
            if (visual) {
                return { displayReply, visual };
            }
        }

        const headingMatches = [...text.matchAll(/(^|\n)(#{3}[^\n]*)/g)];
        if (headingMatches.length) {
            const last = headingMatches[headingMatches.length - 1];
            const displayReply = text.slice(0, last.index).trim();
            const headingLine = last[2].replace(/^#{3}\s*/, '').trim();
            const after = text.slice(last.index + last[0].length).replace(/^\n/, '').trim();
            const headingIsLabel = /^(prompt|image\s*prompt|tags|visual|绘图提示词|出图提示词)?$/i.test(headingLine);
            const tagSource = headingIsLabel ? after : [headingLine, after].filter(Boolean).join('\n');
            const visual = this.visualFromTagBlock(tagSource);
            if (visual) {
                return { displayReply, visual };
            }
            return { displayReply, visual: null };
        }

        const block = text.match(/<<<VISUAL>>>\s*([\s\S]*?)\s*<<<END>>>/i);
        if (block) {
            const displayReply = (text.slice(0, block.index) + text.slice(block.index + block[0].length)).trim();
            return {
                displayReply,
                visual: this.visualFromTagBlock(block[1])
            };
        }
        const jsonMatch = text.match(/\{[\s\S]*"(expression|action|scene|outfit|atmosphere|camera)"[\s\S]*\}\s*$/);
        if (jsonMatch) {
            const visual = this.parseVisualJson(jsonMatch[0]);
            if (visual) {
                return {
                    displayReply: text.slice(0, jsonMatch.index).trim(),
                    visual
                };
            }
        }
        return { displayReply: text.trim(), visual: null };
    }

    /**
     * When the user did not request outfit/scene change, forcibly copy from previousVisual.
     * LLMs often ignore continuity instructions and revert to primed examples (e.g. bathroom).
     */
    enforceVisualContinuity(visual, previousVisual, changeIntent = {}, options = {}) {
        if (!visual || !previousVisual || typeof previousVisual !== 'object') {
            return { visual, enforced: [] };
        }
        const merged = { ...visual };
        const enforced = [];

        if (!options.skipOutfit && !changeIntent.outfitChange && previousVisual.outfit) {
            const prev = String(previousVisual.outfit).trim();
            const cur = String(merged.outfit || '').trim();
            if (prev && cur !== prev) {
                merged.outfit = prev;
                enforced.push('outfit');
            }
        }
        if (!changeIntent.sceneChange) {
            if (previousVisual.scene) {
                const prev = String(previousVisual.scene).trim();
                const cur = String(merged.scene || '').trim();
                if (prev && cur !== prev) {
                    merged.scene = prev;
                    enforced.push('scene');
                }
            }
            if (previousVisual.atmosphere) {
                const prev = String(previousVisual.atmosphere).trim();
                const cur = String(merged.atmosphere || '').trim();
                if (prev && cur !== prev) {
                    merged.atmosphere = prev;
                    enforced.push('atmosphere');
                }
            }
        }

        if (enforced.length) {
            console.log('[continuity] enforced fields from previousVisual:', enforced.join(', '));
        }
        const normalized = this.normalizeVisual(merged) || merged;
        return { visual: normalized, enforced };
    }

    async finalizeChatReply({
        replyContent,
        conversationSummary,
        turnMemory = [],
        hasOlderHistory,
        recentTurns,
        provider,
        model,
        apiKey,
        baseUrl,
        emotionResult,
        emotionDebugInfo,
        outfitVisualDebugInfo,
        fullSystemPrompt,
        chatMessages,
        emotionTimeMs,
        outfitVisualTimeMs = 0,
        replyStartTime,
        totalStartTime,
        previousVisual = null
    }) {
        const displayReply = this.stripVisualBlocksFromReply(replyContent);
        const lastUserMsg = [...recentTurns].reverse().find((m) => m.role === 'user')?.content || '';
        const changeIntent = this.resolveChangeIntent(lastUserMsg, emotionResult, previousVisual);
        const { visual, enforced: allEnforced, visualFromPlan } = this.buildVisualFromEmotionPlan(
            emotionResult, previousVisual, changeIntent, lastUserMsg
        );
        const replyTimeMs = Date.now() - replyStartTime;
        const totalTimeMs = Date.now() - totalStartTime;

        let newTurnMemoryEntry = null;
        if (displayReply && displayReply !== '无回复') {
            const { userBrief, assistantBrief } = await this.generateTurnBrief(
                lastUserMsg, displayReply, provider, model, apiKey, baseUrl
            );
            newTurnMemoryEntry = {
                turnIndex: (Array.isArray(turnMemory) ? turnMemory.length : 0) + 1,
                timestamp: Date.now(),
                userBrief,
                assistantBrief,
                emotion: emotionResult?.emotionAnalysis ? {
                    primaryEmotion: emotionResult.emotionAnalysis.primaryEmotion,
                    intensity: emotionResult.emotionAnalysis.intensity,
                    trend: emotionResult.emotionAnalysis.trend
                } : null
            };
        }

        console.log('   回复生成完成，VISUAL:', visual ? JSON.stringify(visual) : '(未解析到)');
        if (newTurnMemoryEntry) {
            console.log('   本轮情节记忆:', newTurnMemoryEntry.userBrief, '|', newTurnMemoryEntry.assistantBrief);
        }
        return {
            reply: displayReply,
            visual,
            newTurnMemoryEntry,
            newSummary: '',
            emotionAnalysis: emotionResult,
            timing: {
                emotionTimeMs,
                outfitVisualTimeMs,
                replyTimeMs,
                totalTimeMs
            },
            debugInfo: {
                emotionPrompt: emotionDebugInfo?.emotionPrompt || '',
                emotionMessages: emotionDebugInfo?.emotionMessages || [],
                outfitVisualPrompt: outfitVisualDebugInfo?.outfitVisualPrompt || '',
                outfitVisualMessages: outfitVisualDebugInfo?.outfitVisualMessages || [],
                sentPrompt: fullSystemPrompt,
                sentMessages: chatMessages,
                rawResponse: replyContent,
                visual,
                visualBeforeEnforce: allEnforced.length ? visualFromPlan : null,
                continuityEnforced: allEnforced.length ? allEnforced : null,
                outfitPlan: emotionResult?.outfitPlan || null,
                visualPlan: emotionResult?.visualPlan || null,
                changeIntent,
                previousVisual: previousVisual || null,
                previousVisualText: this.formatPreviousVisual(previousVisual) || '',
                turnMemoryEntry: newTurnMemoryEntry
            }
        };
    }

    buildRoleInfoBlock(characterSystemPrompt) {
        let characterName = '';
        let forcePrompt = '';
        if (characterSystemPrompt) {
            const nameMatch = characterSystemPrompt.match(/你是(?:一个名叫)?([^，。！？]+)(?:的女孩|的角色)?/);
            if (nameMatch) characterName = nameMatch[1].trim();
            const forceMarker = '**强制提示词**：';
            const forceIndex = characterSystemPrompt.indexOf(forceMarker);
            if (forceIndex >= 0) {
                forcePrompt = characterSystemPrompt.substring(forceIndex + forceMarker.length).trim();
            }
        }
        if (!characterName && !forcePrompt) return '';
        let roleInfo = '【角色信息】\n';
        if (characterName) roleInfo += `角色名称：${characterName}\n`;
        if (forcePrompt) roleInfo += `强制提示词：${forcePrompt}\n`;
        return `${roleInfo}\n`;
    }

    // 阶段1：情感分析
    async analyzeEmotion(messages, provider, model, apiKey, baseUrl, characterSystemPrompt = '') {
        const cleanMessages = Array.isArray(messages)
            ? messages.filter(m => m && typeof m === 'object').map(m => ({ role: m.role, content: m.content }))
            : [];
        const { recentTurns: recentMessages } = this.extractRecentTurns(cleanMessages, EMOTION_CONTEXT_ROUNDS);
        const chatHistory = recentMessages.map(m =>
            `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`
        ).join('\n');
        const userMessage = messages.length > 0 && messages[messages.length - 1].role === 'user'
            ? messages[messages.length - 1].content
            : '';

        let prompt = this.emotionAnalysisPrompt
            .replace('{chat_history}', chatHistory)
            .replace('{user_message}', userMessage);
        prompt = `${this.buildRoleInfoBlock(characterSystemPrompt)}${prompt}`;

        const debugInfo = {
            emotionPrompt: prompt,
            emotionMessages: [{ role: 'user', content: prompt }]
        };

        try {
            const raw = await this.callJsonAnalysis(prompt, provider, model, apiKey, baseUrl);
            if (raw) return { ...this.parseEmotionResponse(raw), debugInfo };
        } catch (e) {
            console.error('Emotion Analysis Error:', e.message);
        }
        return { ...this.parseEmotionResponse(''), debugInfo };
    }

    // 阶段2：服饰 + 分镜分析
    async analyzeOutfitVisual(messages, provider, model, apiKey, baseUrl, characterSystemPrompt = '', previousVisual = null) {
        const cleanMessages = Array.isArray(messages)
            ? messages.filter(m => m && typeof m === 'object').map(m => ({ role: m.role, content: m.content }))
            : [];
        const { recentTurns: recentMessages } = this.extractRecentTurns(cleanMessages, EMOTION_CONTEXT_ROUNDS);
        const chatHistory = recentMessages.map(m =>
            `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`
        ).join('\n');
        const userMessage = messages.length > 0 && messages[messages.length - 1].role === 'user'
            ? messages[messages.length - 1].content
            : '';
        const currentState = this.formatCurrentVisualStateBlock(previousVisual);

        let prompt = this.outfitVisualAnalysisPrompt
            .replace('{chat_history}', chatHistory)
            .replace('{user_message}', userMessage)
            .replace('{current_visual_state}', currentState);
        prompt = `${this.buildRoleInfoBlock(characterSystemPrompt)}${prompt}`;

        const debugInfo = {
            outfitVisualPrompt: prompt,
            outfitVisualMessages: [{ role: 'user', content: prompt }]
        };

        try {
            const raw = await this.callJsonAnalysis(prompt, provider, model, apiKey, baseUrl);
            if (raw) return { ...this.parseOutfitVisualResponse(raw), debugInfo };
        } catch (e) {
            console.error('Outfit/Visual Analysis Error:', e.message);
        }
        return { ...this.parseOutfitVisualResponse(''), debugInfo };
    }

    // 生成对话摘要
    async generateConversationSummary(oldSummary, lastUserMessage, lastReply, provider, model, apiKey, baseUrl) {
        const summaryPrompt = `请对以下对话内容生成一个简洁的摘要（50字以内），保留关键信息。

之前的摘要：${oldSummary || '无'}
用户最新消息：${lastUserMessage || '无'}
你的回复：${lastReply || '无'}

请只输出摘要内容，不要有多余文字：`;

        if (provider === 'ollama') {
            const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
            try {
                const response = await axios.post(`${url}/api/chat`, {
                    model: model,
                    messages: [{ role: 'user', content: summaryPrompt }],
                    stream: false,
                    keep_alive: 0
                }, { timeout: 600000 });
                const summary = response.data?.message?.content?.trim() || '';
                return summary.substring(0, 200);
            } catch (e) {
                console.error('Summary generation error:', e.message);
                return oldSummary || '';
            }
        } else {
            // OpenAI-compatible (DeepSeek, OpenAI, etc.)
             const key = provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : apiKey;
             const url = (baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
             try {
                 const response = await axios.post(`${url}/chat/completions`, {
                     model: model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash-ga-260731',
                    messages: [{ role: 'user', content: summaryPrompt }],
                    stream: false
                }, {
                    headers: { 
                        'Authorization': `Bearer ${key}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 600000
                });
                const summary = response.data?.choices?.[0]?.message?.content?.trim() || '';
                return summary.substring(0, 200);
            } catch (e) {
                console.error('Summary generation error:', e.message);
                return oldSummary || '';
            }
        }
    }

    /** 阶段1+2：情感分析 + 服饰分镜分析 */
    async prepareThreePhaseAnalysis(cleanMessages, characterSystemPrompt, provider, model, apiKey, baseUrl, previousVisual, emit) {
        const emitFn = typeof emit === 'function' ? emit : () => {};

        emitFn('phase', { phase: 'emotion_analyzing' });
        const emotionStartTime = Date.now();
        const emotionResultWithDebug = await this.analyzeEmotion(
            cleanMessages, provider, model, apiKey, baseUrl, characterSystemPrompt
        );
        const emotionTimeMs = Date.now() - emotionStartTime;
        const { debugInfo: emotionDebugInfo, ...emotionResultRaw } = emotionResultWithDebug || {};
        const emotionOnly = emotionResultRaw?.emotionAnalysis && emotionResultRaw?.responseSuggestion
            ? emotionResultRaw
            : this.parseEmotionResponse('');

        emitFn('emotion_done', { emotionAnalysis: emotionOnly, emotionTimeMs });

        emitFn('phase', { phase: 'outfit_analyzing' });
        const outfitStartTime = Date.now();
        const outfitResultWithDebug = await this.analyzeOutfitVisual(
            cleanMessages, provider, model, apiKey, baseUrl, characterSystemPrompt, previousVisual
        );
        const outfitVisualTimeMs = Date.now() - outfitStartTime;
        const { debugInfo: outfitVisualDebugInfo, ...outfitResultRaw } = outfitResultWithDebug || {};
        const outfitOnly = outfitResultRaw?.outfitPlan
            ? outfitResultRaw
            : this.parseOutfitVisualResponse('');

        emitFn('outfit_visual_done', {
            outfitPlan: outfitOnly.outfitPlan,
            visualPlan: outfitOnly.visualPlan,
            outfitVisualTimeMs
        });

        const { recentTurns, hasOlderHistory } = this.extractRecentTurns(cleanMessages, RECENT_FULL_ROUNDS);
        const lastUserMsg = [...recentTurns].reverse().find((m) => m.role === 'user')?.content || '';

        this.ensureOutfitPlan(outfitOnly, previousVisual, lastUserMsg);
        this.ensureVisualPlan(outfitOnly, previousVisual, lastUserMsg);
        const turnAnalysis = this.mergeVisualAnalysis(emotionOnly, outfitOnly);

        const changeIntent = this.resolveChangeIntent(lastUserMsg, turnAnalysis, previousVisual);
        if (changeIntent.sceneChange) {
            console.log('[scene] user requested scene change', changeIntent.sceneTargetHint || '(no hint)');
        }
        console.log('[outfit] plan:', turnAnalysis.outfitPlan?.outfitTags || '(沿用)');

        return {
            emotionOnly,
            outfitOnly,
            turnAnalysis,
            emotionDebugInfo,
            outfitVisualDebugInfo,
            emotionTimeMs,
            outfitVisualTimeMs,
            recentTurns,
            hasOlderHistory,
            lastUserMsg
        };
    }

    // 带情感分析的三阶段对话（情感 → 服饰分镜 → 对白）
    async chatWithEmotion(messages, characterSystemPrompt, provider, model, apiKey, baseUrl, conversationSummary, appearancePrompt = '', outfitPrompt = '', previousVisual = null, turnMemory = []) {
        console.log('=== 开始三阶段 AI 调用 ===');
        const totalStartTime = Date.now();

        const cleanMessages = Array.isArray(messages)
            ? messages
                .filter(m => m && typeof m === 'object')
                .map(m => ({ role: m.role, content: m.content }))
            : {};

        console.log('1. 情感分析');
        const prep = await this.prepareThreePhaseAnalysis(
            cleanMessages, characterSystemPrompt, provider, model, apiKey, baseUrl, previousVisual
        );
        const {
            turnAnalysis: emotionResult,
            emotionDebugInfo,
            outfitVisualDebugInfo,
            emotionTimeMs,
            outfitVisualTimeMs,
            recentTurns,
            hasOlderHistory
        } = prep;

        console.log('   情感分析完成，主情绪:', emotionResult.emotionAnalysis?.primaryEmotion || '未知');
        console.log('2. 服饰分镜已完成');
        console.log('3. 生成对白');

        const enhancedSystemPrompt = this.buildDialogueSystemPrompt(
            characterSystemPrompt, emotionResult, turnMemory, conversationSummary
        );
        const chatMessages = [{ role: 'system', content: enhancedSystemPrompt }, ...recentTurns];
        const fullSystemPrompt = enhancedSystemPrompt;
        const replyStartTime = Date.now();

        if (provider === 'ollama') {
            const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
            try {
                const response = await axios.post(`${url}/api/chat`, {
                    model: model,
                    messages: chatMessages,
                    stream: false,
                    keep_alive: 0
                }, { timeout: 600000 });
                const replyContent = response.data?.message?.content || response.data?.message?.thinking || '无回复';
                return await this.finalizeChatReply({
                    replyContent,
                    conversationSummary,
                    turnMemory,
                    hasOlderHistory,
                    recentTurns,
                    provider,
                    model,
                    apiKey,
                    baseUrl,
                    emotionResult,
                    emotionDebugInfo,
                    outfitVisualDebugInfo,
                    fullSystemPrompt,
                    chatMessages,
                    emotionTimeMs,
                    outfitVisualTimeMs,
                    replyStartTime,
                    totalStartTime,
                    previousVisual
                });
            } catch (e) {
                throw new Error(`Ollama Chat Error: ${e.message}`);
            }
        } else if (provider === 'doubao') {
            const key = process.env.VOLC_API_KEY;
            const url = (process.env.VOLC_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
            const endpoint = url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
            
            const targetModel = this.resolveDoubaoModel(model);
            
            try {
                const response = await axios.post(endpoint, {
                    model: targetModel,
                    messages: chatMessages,
                    stream: false
                }, {
                    headers: { 
                        'Authorization': `Bearer ${key}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000
                });
                const replyContent = response.data?.choices?.[0]?.message?.content || '无回复';
                return await this.finalizeChatReply({
                    replyContent,
                    conversationSummary,
                    turnMemory,
                    hasOlderHistory,
                    recentTurns,
                    provider,
                    model,
                    apiKey,
                    baseUrl,
                    emotionResult,
                    emotionDebugInfo,
                    outfitVisualDebugInfo,
                    fullSystemPrompt,
                    chatMessages,
                    emotionTimeMs,
                    outfitVisualTimeMs,
                    replyStartTime,
                    totalStartTime,
                    previousVisual
                });
            } catch (e) {
                const msg = e.response?.data?.error?.message || e.message;
                throw new Error(`Doubao Chat Error: ${msg}`);
            }
        } else if (provider === 'deepseek') {
            const key = process.env.DEEPSEEK_API_KEY;
            const url = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
            try {
                const response = await axios.post(`${url}/chat/completions`, {
                    model: model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash-ga-260731',
                    messages: chatMessages,
                    stream: false
                }, {
                    headers: { 
                        'Authorization': `Bearer ${key}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 600000
                });
                const replyContent = response.data?.choices?.[0]?.message?.content || '无回复';
                return await this.finalizeChatReply({
                    replyContent,
                    conversationSummary,
                    turnMemory,
                    hasOlderHistory,
                    recentTurns,
                    provider,
                    model,
                    apiKey,
                    baseUrl,
                    emotionResult,
                    emotionDebugInfo,
                    outfitVisualDebugInfo,
                    fullSystemPrompt,
                    chatMessages,
                    emotionTimeMs,
                    outfitVisualTimeMs,
                    replyStartTime,
                    totalStartTime,
                    previousVisual
                });
            } catch (e) {
                throw new Error(`DeepSeek Chat Error: ${e.message}`);
            }
        } else {
            const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
            try {
                const response = await axios.post(`${url}/chat/completions`, {
                    model: model,
                    messages: chatMessages
                }, {
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                    timeout: 60000
                });
                const replyContent = response.data?.choices?.[0]?.message?.content || '无回复';
                return await this.finalizeChatReply({
                    replyContent,
                    conversationSummary,
                    turnMemory,
                    hasOlderHistory,
                    recentTurns,
                    provider,
                    model,
                    apiKey,
                    baseUrl,
                    emotionResult,
                    emotionDebugInfo,
                    outfitVisualDebugInfo,
                    fullSystemPrompt,
                    chatMessages,
                    emotionTimeMs,
                    outfitVisualTimeMs,
                    replyStartTime,
                    totalStartTime,
                    previousVisual
                });
            } catch (e) {
                throw new Error(`API Chat Error: ${e.message}`);
            }
        }
    }

    visibleReplyDuringStream(raw) {
        const text = String(raw || '');
        const marker = text.indexOf('###');
        if (marker >= 0) {
            return text.slice(0, marker).trim();
        }
        return text.replace(/\n#+\s*$/, '').replace(/#+\s*$/, '').trimEnd();
    }

    async streamOllamaChat({ url, model, messages, onThinkingDelta, onContentDelta }) {
        const response = await axios.post(`${url}/api/chat`, {
            model,
            messages,
            stream: true,
            keep_alive: 0
        }, {
            responseType: 'stream',
            timeout: 600000
        });

        let thinkingAcc = '';
        let contentAcc = '';
        let buffer = '';

        return new Promise((resolve, reject) => {
            const finish = (err) => {
                if (err) reject(err);
                else resolve(contentAcc || thinkingAcc);
            };

            response.data.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const json = JSON.parse(trimmed);
                        if (json.message?.thinking) {
                            thinkingAcc += json.message.thinking;
                            onThinkingDelta?.(json.message.thinking, thinkingAcc);
                        }
                        if (json.message?.content) {
                            contentAcc += json.message.content;
                            onContentDelta?.(json.message.content, contentAcc);
                        }
                        if (json.done) {
                            finish();
                        }
                    } catch (e) {
                        // ignore malformed line
                    }
                }
            });
            response.data.on('error', finish);
            response.data.on('end', () => finish());
        });
    }

    async generateReplySync(provider, model, apiKey, baseUrl, chatMessages) {
        if (provider === 'ollama') {
            throw new Error('generateReplySync should not be used for ollama');
        }
        if (provider === 'doubao') {
            const key = process.env.VOLC_API_KEY;
            const url = (process.env.VOLC_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
            const endpoint = url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
            const response = await axios.post(endpoint, {
                model: this.resolveDoubaoModel(model),
                messages: chatMessages,
                stream: false
            }, {
                headers: {
                    Authorization: `Bearer ${key}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60000
            });
            return response.data?.choices?.[0]?.message?.content || '无回复';
        }
        if (provider === 'deepseek') {
            const key = process.env.DEEPSEEK_API_KEY;
            const url = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
            const response = await axios.post(`${url}/chat/completions`, {
                model: model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash-ga-260731',
                messages: chatMessages,
                stream: false
            }, {
                headers: {
                    Authorization: `Bearer ${key}`,
                    'Content-Type': 'application/json'
                },
                timeout: 600000
            });
            return response.data?.choices?.[0]?.message?.content || '无回复';
        }
        const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
        const response = await axios.post(`${url}/chat/completions`, {
            model,
            messages: chatMessages
        }, {
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: 60000
        });
        return response.data?.choices?.[0]?.message?.content || '无回复';
    }

    async runChatTurn(payload, emit) {
        const {
            messages,
            systemPrompt: characterSystemPrompt,
            provider,
            model,
            apiKey,
            baseUrl,
            conversationSummary,
            turnMemory = [],
            previousVisual
        } = payload;

        const totalStartTime = Date.now();
        const cleanMessages = Array.isArray(messages)
            ? messages.filter(m => m && typeof m === 'object').map(m => ({ role: m.role, content: m.content }))
            : [];

        const prep = await this.prepareThreePhaseAnalysis(
            cleanMessages, characterSystemPrompt, provider, model, apiKey, baseUrl, previousVisual, emit
        );
        const {
            turnAnalysis: emotionResult,
            emotionDebugInfo,
            outfitVisualDebugInfo,
            emotionTimeMs,
            outfitVisualTimeMs,
            recentTurns,
            hasOlderHistory
        } = prep;

        const enhancedSystemPrompt = this.buildDialogueSystemPrompt(
            characterSystemPrompt, emotionResult, turnMemory, conversationSummary
        );
        const chatMessages = [{ role: 'system', content: enhancedSystemPrompt }, ...recentTurns];
        const fullSystemPrompt = enhancedSystemPrompt;

        emit('phase', { phase: 'reply_generating' });
        const replyStartTime = Date.now();
        let replyContent = '';
        let lastVisible = '';

        if (provider === 'ollama') {
            const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
            replyContent = await this.streamOllamaChat({
                url,
                model,
                messages: chatMessages,
                onThinkingDelta: (delta, accumulated) => {
                    emit('thinking_delta', { delta, accumulated });
                },
                onContentDelta: (delta, accumulated) => {
                    const visible = this.visibleReplyDuringStream(accumulated);
                    if (visible !== lastVisible) {
                        lastVisible = visible;
                        emit('reply_delta', { delta, accumulated: visible });
                    }
                }
            });
        } else {
            replyContent = await this.generateReplySync(provider, model, apiKey, baseUrl, chatMessages);
            const visible = this.visibleReplyDuringStream(replyContent);
            emit('reply_delta', { delta: visible, accumulated: visible });
        }

        emit('phase', { phase: 'parsing_visual' });

        return this.finalizeChatReply({
            replyContent,
            conversationSummary,
            turnMemory,
            hasOlderHistory,
            recentTurns,
            provider,
            model,
            apiKey,
            baseUrl,
            emotionResult,
            emotionDebugInfo,
            outfitVisualDebugInfo,
            fullSystemPrompt,
            chatMessages,
            emotionTimeMs,
            outfitVisualTimeMs,
            replyStartTime,
            totalStartTime,
            previousVisual: previousVisual || null
        });
    }
}

module.exports = new AIService();
