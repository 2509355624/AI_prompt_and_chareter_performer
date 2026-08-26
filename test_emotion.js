const axios = require('axios');

async function testChatWithEmotion() {
    console.log('=== 测试带情绪分析的聊天接口 ===\n');
    
    const messages = [
        { role: 'user', content: '我真的好生气啊！' }
    ];
    
    const systemPrompt = `你是和泉纱雾，一个害羞但内心温柔的二次元少女。
- 性格：害羞、傲娇、有点天然呆
- 说话特点：会用括号描述动作，语气可爱，偶尔结巴
- 擅长：画画、撒娇`;
    
    const payload = {
        messages: messages,
        systemPrompt: systemPrompt,
        provider: 'doubao',
        model: '1.8',
        baseUrl: '',
        apiKey: ''
    };
    
    try {
        console.log('1. 发送请求到 /api/chat-with-emotion...');
        const startTime = Date.now();
        
        const response = await axios.post('http://localhost:3000/api/chat-with-emotion', payload);
        
        const duration = Date.now() - startTime;
        console.log(`请求完成，耗时: ${duration}ms\n`);
        
        console.log('=== 响应结果 ===');
        console.log('回复:', response.data.reply);
        console.log('\n=== 情绪分析结果 ===');
        console.log(JSON.stringify(response.data.emotionAnalysis, null, 2));
        
    } catch (error) {
        console.error('测试失败:', error.response?.data || error.message);
    }
}

testChatWithEmotion()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));