const axios = require('axios');

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

        // 情感分析提示词
        this.emotionAnalysisPrompt = `你是一个专业的情感分析师，请分析以下对话中的用户情感状态。

【对话历史】
{chat_history}

【当前用户消息】
{user_message}

【分析要求】
1. 识别用户当前的核心情绪
2. 评估情绪强度（0-10分，10分为最强）
3. 分析情绪变化趋势
4. 识别导致情绪变化的关键事件
5. 给出回复建议

【输出格式】
{
  "analysisVersion": "1.0",
  "emotionAnalysis": {
    "primaryEmotion": "主情绪标签",
    "secondaryEmotions": ["次要情绪1", "次要情绪2"],
    "intensity": 0-10,
    "trend": "上升/下降/稳定",
    "confidence": 0-100
  },
  "contextAnalysis": {
    "keyEvents": ["事件1", "事件2"],
    "relationshipTendency": "亲密/疏远/稳定",
    "topicFocus": "当前话题"
  },
  "responseSuggestion": {
    "tone": "建议语气",
    "avoidTones": ["避免语气1", "避免语气2"],
    "keyPoints": ["要点1", "要点2"]
  }
}

【情绪标签列表】
- 正面情绪：开心、兴奋、感谢、满意、期待、好奇
- 负面情绪：生气、难过、沮丧、失望、焦虑、委屈
- 中性情绪：平静、疑惑、惊讶、害羞、犹豫

【注意】请只输出JSON格式，不要输出任何其他解释性文字。`;
    }

    // 解析火山引擎模型别名
    resolveDoubaoModel(model) {
        if (model === '1.6') return process.env.VOLC_MODEL_1_6;
        if (model === '2.0') return process.env.VOLC_MODEL_2_0;
        if (model === '1.8') return process.env.VOLC_MODEL_1_8 || process.env.VOLC_MODEL;
        return model || process.env.VOLC_MODEL_1_8 || process.env.VOLC_MODEL; // 直接使用模型名
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
                    stream: false
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
                    model: model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
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
                stream: false
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
            model: model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
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

    sceneTagExpertPrompt() {
        return `#角色
服饰和动作扩展专家，我给你我的初始需求，你直接输出服饰和动作和氛围，严格按照示例输出

#禁止事项
禁止增加角色特征

#输出示例
white frilly bikini, thin strings, mid-jump, spinning, dynamic side view, soft natural lighting, bright airy atmosphere, dreamy lighting, pale skin glowing, subtle pink tones, innocent, charming, cute little sister, gentle, pure, wholesome summer, gentle freckled beauty
---
navy blue school swimsuit, white trim, standing, pool edge, three-quarter front view, warm afternoon sunlight, water reflections, ripples, clear blue sky, breeze, refreshing, energetic, youthful summer, bright crisp colors, clean minimal composition
---
floral summer sundress, thin spaghetti straps, sitting, park bench, front view, dappled sunlight, tree leaves, golden hour glow, gentle shadows, peaceful, nostalgic, romantic countryside, warm earthy tones, soft greens, soft pinks`;
    }

    formatPreviousVisual(previousVisual) {
        if (!previousVisual) return '';
        if (typeof previousVisual === 'string') return previousVisual.trim();
        if (previousVisual.prompt) return String(previousVisual.prompt).trim();
        return ['outfit', 'scene', 'expression', 'action']
            .map((key) => String(previousVisual[key] || '').trim())
            .filter(Boolean)
            .join(', ');
    }

    continuityInstruction(previousVisual) {
        const prev = this.formatPreviousVisual(previousVisual);
        if (!prev) return '';
        return `
#连续性（必须遵守）
上一张图的英文提示词是：
${prev}

规则：
1. 若用户本轮没有明确要求更换服装/穿搭，必须沿用上一张图的服装相关 tags（可微调褶皱/角度，但服装类型与主体不变）。
2. 若用户本轮没有明确要求更换场景/地点/时间，必须沿用上一张图的场景与光影氛围 tags。
3. 本轮优先更新：表情、动作、姿势、机位，使其贴合当前对白。
4. 只有用户明确要求换衣服或换场景时，才改对应部分；未要求的部分保持上一张图。`;
    }

    buildVisualInstruction(previousVisual = null) {
        // put continuity FIRST so it is visible in logs and models weight it higher
        return `${this.continuityInstruction(previousVisual)}

${this.sceneTagExpertPrompt()}

#输出格式
先写角色对白。对白结束后另起一行写 ### ，再只输出一组英文提示词，格式和上面输出示例相同（不要用 --- 输出多组）。`;
    }

    async generateSceneTags({
        reply,
        provider,
        model,
        apiKey,
        baseUrl,
        previousVisual = null
    }) {
        const messages = [
            {
                role: 'system',
                content: `${this.sceneTagExpertPrompt()}
${this.continuityInstruction(previousVisual)}

这一次只输出一组。格式：

###
white frilly bikini, thin strings, mid-jump, spinning, dynamic side view, soft natural lighting, bright airy atmosphere, dreamy lighting, pale skin glowing, subtle pink tones, innocent, charming, cute little sister, gentle, pure, wholesome summer, gentle freckled beauty`
            },
            {
                role: 'user',
                content: `用户的需求为：\n${reply}`
            }
        ];
        const raw = await this.completeText(messages, provider, model, apiKey, baseUrl);
        const split = this.splitReplyAndVisual(raw);
        if (split.visual) return split.visual;
        return this.visualFromTagBlock(raw);
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
                format: 'json'
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
            
            // 验证必要字段
            if (parsed.emotionAnalysis && parsed.responseSuggestion) {
                return parsed;
            }
        } catch (e) {
            console.warn('Emotion JSON parsing failed:', e.message);
        }

        // 返回默认值
        return {
            analysisVersion: "1.0",
            emotionAnalysis: {
                primaryEmotion: "平静",
                secondaryEmotions: [],
                intensity: 3,
                trend: "稳定",
                confidence: 50
            },
            contextAnalysis: {
                keyEvents: [],
                relationshipTendency: "稳定",
                topicFocus: "未知"
            },
            responseSuggestion: {
                tone: "温柔",
                avoidTones: [],
                keyPoints: []
            }
        };
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
            const visual = {
                expression: String(parsed.expression || '').trim(),
                action: String(parsed.action || '').trim(),
                outfit: String(parsed.outfit || '').trim(),
                scene: String(parsed.scene || '').trim()
            };
            if (!visual.expression && !visual.action && !visual.outfit && !visual.scene) return null;
            visual.prompt = [visual.expression, visual.action, visual.outfit, visual.scene]
                .filter(Boolean)
                .join(', ');
            return visual;
        } catch (e) {
            return null;
        }
    }

    sanitizeEnglishTags(raw) {
        let text = String(raw || '')
            .replace(/```(?:json|prompt|text)?/gi, '')
            .replace(/```/g, '')
            .trim();
        const asJson = this.parseVisualJson(text);
        if (asJson?.prompt) return asJson.prompt;
        const heading = /^(prompt|image\s*prompt|tags|visual|绘图提示词|出图提示词)\s*[:：-]?\s*/i;
        const parts = text
            .split(/[\n,;，；]+/)
            .map((part) => part.replace(heading, '').replace(/^[-*•]\s*/, '').trim())
            .filter((part) => part && !/[\u3400-\u9fff]/.test(part) && !/^#{1,6}$/.test(part));
        return parts.join(', ');
    }

    visualFromTagBlock(raw) {
        const asJson = this.parseVisualJson(raw);
        if (asJson) return asJson;
        const pick = (key) => {
            const match = String(raw || '').match(new RegExp(`${key}\\s*[:：]\\s*([^\\n]+)`, 'i'));
            return match ? this.sanitizeEnglishTags(match[1]) : '';
        };
        const prompt = this.sanitizeEnglishTags(raw);
        if (!prompt) return null;
        return {
            prompt,
            expression: pick('expression'),
            action: pick('action'),
            outfit: pick('outfit'),
            scene: pick('scene')
        };
    }

    splitReplyAndVisual(raw) {
        const text = String(raw || '').replace(/\r\n/g, '\n');
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
        const jsonMatch = text.match(/\{[\s\S]*"(expression|action|scene|outfit)"[\s\S]*\}\s*$/);
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

    async finalizeChatReply({
        replyContent,
        conversationSummary,
        hasOlderHistory,
        recentTurns,
        provider,
        model,
        apiKey,
        baseUrl,
        emotionResult,
        emotionDebugInfo,
        fullSystemPrompt,
        chatMessages,
        emotionTimeMs,
        replyStartTime,
        totalStartTime,
        previousVisual = null
    }) {
        const { displayReply, visual } = this.splitReplyAndVisual(replyContent);
        const replyTimeMs = Date.now() - replyStartTime;
        const totalTimeMs = Date.now() - totalStartTime;
        let newSummary = conversationSummary || '';
        if ((hasOlderHistory || conversationSummary) && displayReply && displayReply !== '无回复') {
            const lastUserMsg = recentTurns.length > 0 ? recentTurns[recentTurns.length - 1].content : '';
            newSummary = await this.generateConversationSummary(
                conversationSummary, lastUserMsg, displayReply, provider, model, apiKey, baseUrl
            );
        }
        console.log('   回复生成完成，VISUAL:', visual ? JSON.stringify(visual) : '(未解析到)');
        return {
            reply: displayReply,
            visual,
            newSummary,
            emotionAnalysis: emotionResult,
            timing: {
                emotionTimeMs,
                replyTimeMs,
                totalTimeMs
            },
            debugInfo: {
                emotionPrompt: emotionDebugInfo?.emotionPrompt || '',
                emotionMessages: emotionDebugInfo?.emotionMessages || [],
                sentPrompt: fullSystemPrompt,
                sentMessages: chatMessages,
                rawResponse: replyContent,
                visual,
                previousVisual: previousVisual || null,
                previousVisualText: this.formatPreviousVisual(previousVisual) || ''
            }
        };
    }

    // 情感分析方法
    async analyzeEmotion(messages, provider, model, apiKey, baseUrl, characterSystemPrompt = '') {
        // 准备聊天历史：确保格式为 user → assistant → user → assistant → ... → user
        // 从后往前找完整的轮次
        let recentMessages = [];
        let i = messages.length - 1;
        
        // 如果最后一条是用户消息（当前要分析的），先取出来
        if (i >= 0 && messages[i].role === 'user') {
            recentMessages.unshift(messages[i]);
            i--;
        }
        
        // 再向前取最多2个完整轮次（user + assistant）
        let turnsCollected = 0;
        while (i >= 0 && turnsCollected < 2) {
            // 检查是否是完整的轮次（assistant 前面有 user）
            if (messages[i].role === 'assistant' && i - 1 >= 0 && messages[i - 1].role === 'user') {
                recentMessages.unshift(messages[i]);
                recentMessages.unshift(messages[i - 1]);
                turnsCollected++;
                i -= 2;
            } else {
                i--;
            }
        }
        
        // 将消息数组转换为文本格式
        const chatHistory = recentMessages.map(m => 
            `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`
        ).join('\n');

        // 获取最后一条用户消息
        const userMessage = messages.length > 0 && messages[messages.length - 1].role === 'user' 
            ? messages[messages.length - 1].content 
            : '';

        // 提取角色名称和强制提示词（从角色设定中提取）
        let characterName = '';
        let forcePrompt = '';
        if (characterSystemPrompt) {
            // 尝试从角色设定中提取角色名称
            const nameMatch = characterSystemPrompt.match(/你是(?:一个名叫)?([^，。！？]+)(?:的女孩|的角色)?/);
            if (nameMatch) {
                characterName = nameMatch[1].trim();
            }
            // 尝试提取强制提示词
            const forceMarker = '**强制提示词**：';
            const forceIndex = characterSystemPrompt.indexOf(forceMarker);
            if (forceIndex >= 0) {
                forcePrompt = characterSystemPrompt.substring(forceIndex + forceMarker.length).trim();
            }
        }

        // 构建分析提示词
        let prompt = this.emotionAnalysisPrompt
            .replace('{chat_history}', chatHistory)
            .replace('{user_message}', userMessage);
        
        // 如果有角色信息，添加到提示词中
        if (characterName || forcePrompt) {
            let roleInfo = '【角色信息】\n';
            if (characterName) {
                roleInfo += `角色名称：${characterName}\n`;
            }
            if (forcePrompt) {
                roleInfo += `强制提示词：${forcePrompt}\n`;
            }
            prompt = `${roleInfo}\n${prompt}`;
        }

        const debugInfo = {
            emotionPrompt: prompt,
            emotionMessages: [{ role: 'user', content: prompt }]
        };

        if (provider === 'ollama') {
            const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
            try {
                const response = await axios.post(`${url}/api/chat`, {
                    model: model,
                    messages: [{ role: 'user', content: prompt }],
                    stream: false,
                    format: 'json'
                }, { timeout: 600000 });
                
                if (response.data && response.data.message) {
                    return { ...this.parseEmotionResponse(response.data.message.content), debugInfo };
                }
            } catch (e) {
                console.error('Ollama Emotion Analysis Error:', e.message);
            }
        } else if (provider === 'doubao') {
            const key = process.env.VOLC_API_KEY;
            const url = (process.env.VOLC_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
            const endpoint = url.endsWith('/chat/completions') ? url : `${url}/chat/completions`;
            
            const targetModel = this.resolveDoubaoModel(model);
            
            try {
                const response = await axios.post(endpoint, {
                    model: targetModel,
                    messages: [{ role: 'user', content: prompt }],
                    stream: false
                }, {
                    headers: { 
                        'Authorization': `Bearer ${key}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000
                });
                
                if (response.data?.choices?.[0]?.message?.content) {
                    return { ...this.parseEmotionResponse(response.data.choices[0].message.content), debugInfo };
                }
            } catch (e) {
                console.error('Doubao Emotion Analysis Error:', e.message);
            }
        } else if (provider === 'deepseek') {
            const key = process.env.DEEPSEEK_API_KEY;
            const url = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
            try {
                const response = await axios.post(`${url}/chat/completions`, {
                    model: model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
                    messages: [{ role: 'user', content: prompt }],
                    stream: false,
                    response_format: { type: 'json_object' }
                }, {
                    headers: { 
                        'Authorization': `Bearer ${key}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 600000
                });
                
                if (response.data?.choices?.[0]?.message?.content) {
                    return { ...this.parseEmotionResponse(response.data.choices[0].message.content), debugInfo };
                }
            } catch (e) {
                console.error('DeepSeek Emotion Analysis Error:', e.message);
            }
        } else {
            const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
            try {
                const response = await axios.post(`${url}/chat/completions`, {
                    model: model,
                    messages: [{ role: 'user', content: prompt }]
                }, {
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                    timeout: 60000
                });
                
                if (response.data?.choices?.[0]?.message?.content) {
                    return { ...this.parseEmotionResponse(response.data.choices[0].message.content), debugInfo };
                }
            } catch (e) {
                console.error('API Emotion Analysis Error:', e.message);
            }
        }

        // 返回默认分析结果
        return { ...this.parseEmotionResponse(''), debugInfo };
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
                    stream: false
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
                     model: model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
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

    // 带情感分析的对话方法（两轮调用 + 摘要）
    async chatWithEmotion(messages, characterSystemPrompt, provider, model, apiKey, baseUrl, conversationSummary, appearancePrompt = '', outfitPrompt = '', previousVisual = null) {
        console.log('=== 开始两轮AI调用 ===');
        const totalStartTime = Date.now();

        const cleanMessages = Array.isArray(messages)
            ? messages
                .filter(m => m && typeof m === 'object')
                .map(m => ({ role: m.role, content: m.content }))
            : [];
        
        // 第一轮：情感分析
        console.log('1. 第一轮调用：情感分析');
        const emotionStartTime = Date.now();
        const emotionResultWithDebug = await this.analyzeEmotion(cleanMessages, provider, model, apiKey, baseUrl, characterSystemPrompt);
        const emotionTimeMs = Date.now() - emotionStartTime;
        const { debugInfo: emotionDebugInfo, ...emotionResultRaw } = emotionResultWithDebug || {};
        const emotionResult = emotionResultRaw?.emotionAnalysis && emotionResultRaw?.responseSuggestion
            ? emotionResultRaw
            : this.parseEmotionResponse('');
        
        // 准备聊天历史：保留最近2轮完整对话，更早历史用摘要代替
        let recentTurns = [];    // 最近2轮完整对话（给AI的上下文）
        let hasOlderHistory = false; // 是否有更早的历史
        let i = cleanMessages.length - 1;
        
        // 如果最后一条是用户消息（当前要回复的），先取出来
        if (i >= 0 && cleanMessages[i].role === 'user') {
            recentTurns.unshift(cleanMessages[i]);
            i--;
        }
        
        // 再向前取最多2个完整轮次（user + assistant）
        let turnsCollected = 0;
        while (i >= 0 && turnsCollected < 2) {
            if (cleanMessages[i].role === 'assistant' && i - 1 >= 0 && cleanMessages[i - 1].role === 'user') {
                recentTurns.unshift(cleanMessages[i]);
                recentTurns.unshift(cleanMessages[i - 1]);
                turnsCollected++;
                i -= 2;
            } else {
                i--;
            }
        }
        
        // 如果取完2轮后还有更早的消息，说明有更早历史
        hasOlderHistory = i >= 0;
        
        console.log('   情感分析完成，主情绪:', emotionResult.emotionAnalysis?.primaryEmotion || '未知');
        const prevVisualText = this.formatPreviousVisual(previousVisual);
        console.log('   上一轮出图提示词:', prevVisualText ? prevVisualText.slice(0, 120) : '(无)');

        // 构建系统提示词 = 角色设定 + 情绪分析 + 历史摘要（如果有更早历史）
        const summaryText = conversationSummary ? `\n\n【对话历史摘要】\n${conversationSummary}` : '';
        const emotionInfo = `
【用户情绪状态】
- 主情绪：${emotionResult.emotionAnalysis.primaryEmotion}（强度：${emotionResult.emotionAnalysis.intensity}/10）
- 情绪趋势：${emotionResult.emotionAnalysis.trend}
- 建议语气：${emotionResult.responseSuggestion.tone}
- 避免语气：${emotionResult.responseSuggestion.avoidTones.join(', ') || '无'}
- 回复要点：${emotionResult.responseSuggestion.keyPoints.join('；') || '无'}
`.trim();

        const continuityBlock = this.continuityInstruction(previousVisual);
        // continuity is already inside buildVisualInstruction; keep one clear copy before it for log visibility
        const enhancedSystemPrompt = `${characterSystemPrompt}\n\n${emotionInfo}${summaryText}\n\n${this.buildVisualInstruction(previousVisual)}`;
        if (continuityBlock) {
            console.log('   已注入服饰/场景连续性指令');
        } else {
            console.log('   未注入连续性（没有上一轮出图提示词）');
        }

        const systemMessage = {
            role: 'system',
            content: enhancedSystemPrompt
        };

        // 发送给AI：系统提示词 + 最近2轮完整对话
        const chatMessages = [systemMessage, ...recentTurns];

        // 构建完整的系统提示词（用于返回给前端调试）
        const fullSystemPrompt = enhancedSystemPrompt;
        console.log('   完整Prompt已构建，长度:', fullSystemPrompt.length);
        console.log('   角色设定长度:', characterSystemPrompt.length);
        console.log('   情绪信息长度:', emotionInfo.length);
        console.log('   对话摘要长度:', summaryText.length);
        console.log('   最近轮次消息数:', recentTurns.length);

        // 第二轮：生成回复
        console.log('2. 第二轮调用：生成回复');
        const replyStartTime = Date.now();

        if (provider === 'ollama') {
            const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
            try {
                const response = await axios.post(`${url}/api/chat`, {
                    model: model,
                    messages: chatMessages,
                    stream: false
                }, { timeout: 600000 });
                const replyContent = response.data?.message?.content || response.data?.message?.thinking || '无回复';
                return await this.finalizeChatReply({
                    replyContent,
                    conversationSummary,
                    hasOlderHistory,
                    recentTurns,
                    provider,
                    model,
                    apiKey,
                    baseUrl,
                    emotionResult,
                    emotionDebugInfo,
                    fullSystemPrompt,
                    chatMessages,
                    emotionTimeMs,
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
                    hasOlderHistory,
                    recentTurns,
                    provider,
                    model,
                    apiKey,
                    baseUrl,
                    emotionResult,
                    emotionDebugInfo,
                    fullSystemPrompt,
                    chatMessages,
                    emotionTimeMs,
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
                    model: model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
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
                    hasOlderHistory,
                    recentTurns,
                    provider,
                    model,
                    apiKey,
                    baseUrl,
                    emotionResult,
                    emotionDebugInfo,
                    fullSystemPrompt,
                    chatMessages,
                    emotionTimeMs,
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
                    hasOlderHistory,
                    recentTurns,
                    provider,
                    model,
                    apiKey,
                    baseUrl,
                    emotionResult,
                    emotionDebugInfo,
                    fullSystemPrompt,
                    chatMessages,
                    emotionTimeMs,
                    replyStartTime,
                    totalStartTime,
                    previousVisual
                });
            } catch (e) {
                throw new Error(`API Chat Error: ${e.message}`);
            }
        }
    }
}

module.exports = new AIService();
