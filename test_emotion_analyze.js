const axios = require('axios');

async function testEmotionAnalysis() {
    console.log('=== 测试情感分析接口 ===\n');
    
    const messages = [
        { role: 'user', content: '我真的好生气啊！' }
    ];
    
    const payload = {
        messages: messages,
        provider: 'doubao',
        model: '1.8',
        baseUrl: '',
        apiKey: ''
    };
    
    try {
        console.log('1. 发送请求到 /api/analyze-emotion...');
        const startTime = Date.now();
        
        const response = await axios.post('http://localhost:3000/api/analyze-emotion', payload);
        
        const duration = Date.now() - startTime;
        console.log(`请求完成，耗时: ${duration}ms\n`);
        
        console.log('=== 情感分析结果 ===');
        console.log(JSON.stringify(response.data, null, 2));
        
    } catch (error) {
        console.error('测试失败:', error.response?.data || error.message);
        console.error('Error details:', error);
    }
}

testEmotionAnalysis()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));