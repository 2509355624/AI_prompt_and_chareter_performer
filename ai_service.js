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
    }

    async getOllamaModels(baseUrl) {
        const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
        try {
            const response = await axios.get(`${url}/api/tags`);
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
                }, { timeout: 60000 });
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
            let targetModel;
            if (model === '1.6') targetModel = process.env.VOLC_MODEL_1_6;
            else if (model === '2.0') targetModel = process.env.VOLC_MODEL_2_0;
            else targetModel = process.env.VOLC_MODEL_1_8 || process.env.VOLC_MODEL;
            
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
                timeout: 60000, // 60 seconds timeout
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
        
        // Determine model based on alias or fallback
        let model;
        if (modelAlias === '1.6') {
            model = process.env.VOLC_MODEL_1_6;
        } else if (modelAlias === '2.0') {
            model = process.env.VOLC_MODEL_2_0;
        } else {
            model = process.env.VOLC_MODEL_1_8 || process.env.VOLC_MODEL; // Fallback to old var if needed
        }

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
}

module.exports = new AIService();
