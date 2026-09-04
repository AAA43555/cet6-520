const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'summary', 'errors', 'improved', 'strengths'],
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 15 },
    summary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    errors: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'original', 'suggestion', 'reason'],
        properties: {
          type: { type: 'string', enum: ['漏译', '语法', '用词', '表达', '标点'] },
          original: { type: 'string' },
          suggestion: { type: 'string' },
          reason: { type: 'string' }
        }
      }
    },
    improved: { type: 'string' }
  }
};

const translationSources = [
  '越来越多的大学生意识到，真正有效的学习不是简单延长时间，而是保持专注并及时反思错误。',
  '近年来，许多城市通过改善公共交通来减少拥堵。这不仅节省了市民的时间，也降低了空气污染。',
  '中国传统节日不仅是家人团聚的时刻，也承载着人们对历史和文化的共同记忆。',
  '随着数字技术的发展，边远地区的学生也能获得更多优质课程。然而，技术不能完全取代教师的指导。',
  '志愿服务为青年人提供了解社会的机会，并帮助他们在实践中培养责任感。',
  '保护历史建筑并不意味着拒绝现代化。关键在于在城市发展和文化传承之间找到平衡。',
  '阅读的价值不仅在于获取信息。它还能帮助我们理解不同的观点，并以更开放的态度看待世界。'
];

const recentRequests = new Map();

function isRateLimited(request) {
  const forwarded = request.headers?.['x-forwarded-for'];
  const key = String(Array.isArray(forwarded) ? forwarded[0] : forwarded || 'unknown').split(',')[0];
  const now = Date.now();
  const recent = (recentRequests.get(key) || []).filter((time) => now - time < 10 * 60 * 1000);
  recent.push(now);
  recentRequests.set(key, recent);
  return recent.length > 12;
}

function outputText(result) {
  if (typeof result.output_text === 'string') return result.output_text;
  return (result.output || [])
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text)
    .join('');
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: '仅支持 POST' });
  if (!process.env.OPENAI_API_KEY) return response.status(503).json({ error: 'AI 批改服务尚未配置' });
  if (Number(request.headers?.['content-length'] || 0) > 4096) return response.status(413).json({ error: '提交内容过长' });
  if (isRateLimited(request)) return response.status(429).json({ error: '提交太频繁，请稍后再试' });

  const { day, answer } = request.body || {};
  const dayIndex = Number(day);
  if (!Number.isInteger(dayIndex) || !translationSources[dayIndex] || typeof answer !== 'string' || !answer.trim()) {
    return response.status(400).json({ error: '请先输入英文翻译' });
  }
  if (answer.length > 1200) return response.status(400).json({ error: '翻译请控制在 1200 字符内' });

  const source = translationSources[dayIndex];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const apiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        store: false,
        max_output_tokens: 700,
        instructions: '你是严谨、鼓励型的大学英语六级翻译阅卷老师。按 15 分制评分，重点检查信息完整、语法、搭配和英语自然度。不要因与参考答案不同而扣分。反馈用简洁中文，只指出真正存在的问题。',
        input: `中文原文：${source}\n\n学生译文：${answer}`,
        text: { format: { type: 'json_schema', name: 'cet6_translation_feedback', strict: true, schema } }
      })
    });
    const result = await apiResponse.json();
    if (!apiResponse.ok) throw new Error(result?.error?.message || 'AI 服务请求失败');
    return response.status(200).json(JSON.parse(outputText(result)));
  } catch (error) {
    return response.status(500).json({ error: error?.name === 'AbortError' ? 'AI 批改超时，请重试' : '批改失败，请稍后重试' });
  } finally {
    clearTimeout(timeout);
  }
}
