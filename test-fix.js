
const testMessages = [
    { "role": "user", "content": "老师你好，我是你的粉丝哦，色气漫画的作者大大" },
    { "role": "assistant", "content": "呀……！怎、怎么突然说这种奇怪的称呼啦，好、好丢人……\n（把半个脸埋进抱枕里，耳尖红得要滴血，声音闷乎乎的）那、那个……谢谢你喜欢我的插图啦……\n（手指悄悄揪了揪抱枕的边角，视线飘来飘去不敢看你）你、你比较喜欢我画的哪个部分啊？……才、才不是想参考你的意见调整什么哦，就、就是随便问问而已……" },
    { "role": "user", "content": "其实我比较喜欢你" },
    { "role": "assistant", "content": "（唰地一下耳尖红到了发梢，整个人嗖得把脸完全埋进抱枕里，连带着上半身都团成了小小的一团，只有露在外面的手指紧张得把抱枕边角揪出几道褶皱）\n你、你乱讲什么啦！突、突然说这种奇怪的话……（声音闷得快要听不清，尾音还带着点颤）我、我才没有很高兴……不对！才、才不信你是真的喜欢啦……（隔了好半天，才从抱枕缝里露出一点湿漉漉的眼尾，声音细得像蚊子叫）你、你要是骗我的话……我、我以后再也不给你看我没公开的草稿了哦……" },
    { "role": "user", "content": "让我康康你珍藏的画作嘛，老师你肯定有私藏的" }
];

// 模拟我们的修复代码
function prepareHistoryForAI(cleanMessages) {
    // 准备聊天历史：确保格式为 user → assistant → user → assistant → ... → user
    // 从后往前找完整的轮次
    let historyForAI = [];
    let i = cleanMessages.length - 1;
    
    // 如果最后一条是用户消息（当前要回复的），先取出来
    if (i >= 0 && cleanMessages[i].role === 'user') {
        historyForAI.unshift(cleanMessages[i]);
        i--;
    }
    
    // 再向前取最多2个完整轮次（user + assistant）
    let turnsCollected = 0;
    while (i >= 0 && turnsCollected < 2) {
        // 检查是否是完整的轮次（assistant 前面有 user）
        if (cleanMessages[i].role === 'assistant' && i - 1 >= 0 && cleanMessages[i - 1].role === 'user') {
            historyForAI.unshift(cleanMessages[i]);
            historyForAI.unshift(cleanMessages[i - 1]);
            turnsCollected++;
            i -= 2;
        } else {
            i--;
        }
    }
    
    return historyForAI;
}

const history = prepareHistoryForAI(testMessages);
console.log("准备好的聊天历史：");
console.log(history.map(m => `${m.role}: ${m.content.substring(0, 30)}...`).join('\n'));
console.log(`\n总消息数: ${history.length}`);
console.log("\n结构是否正确（应交替 user/assistant，最后为 user）：");
console.log(history.every((m, i) => i % 2 === 0 ? m.role === 'user' : m.role === 'assistant') ? '✅ 结构正确' : '❌ 结构错误');
