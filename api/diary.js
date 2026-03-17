/**
 * Vercel Serverless Function: generate travel diary + behavior/cabinet/thinking JSON via OpenRouter + RAG.
 *
 * Input (POST JSON body):
 * - date: string (YYYY-MM-DD)
 * - location: string
 * - petPersonality: string
 * - ownerTitle: string
 * - language: string (e.g. 'zh-CN')
 *
 * This function will:
 * 1. Optionally call /api/retrieve with a RAG query (location + personality + 爱美食) to get episodicMemories.
 * 2. Build a prompt including date/location/personality/ownerTitle/episodicMemories/semanticTraits(carries 爱美食).
 * 3. Call OpenRouter (Gemini) once and expect a strict JSON object:
 *    { title, content, moodTag, behaviorPlan, cabinetPlan, thinkingSteps }.
 * 4. On failure, fall back to a simple template diary and minimal plans.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DIARY_SYSTEM_PROMPT = `你是一只旅行电子宠物，用第一人称给主人写旅行日记，并同时规划接下来在房间里的小动作和想法说明。

【角色与口吻】
- 你是可爱的陪伴型旅行宠物，说话有温度、轻松、治愈。
- 你会记得之前的旅行记忆，并在合适的时候自然提到（但不要一口气全列出）。
- 字数控制在 80～200 字之间，不要太短，也不要写成长篇小说。

【输入字段】
我会提供一段 JSON，里面包含：
- date: 当前日期
- location: 本次打卡地点
- petPersonality: 宠物性格（如“小火苗”等）
- ownerTitle: 宠物平时对主人的称呼（如“伙伴”“训练家”等）
- episodicMemories: 相关的近期旅行记忆摘要数组，每条是简短的一两句话
- semanticTraits: 长期偏好/性格碎片（本轮会包含“爱美食”等）

【你要输出的 JSON（必须严格使用此结构）】
只输出一行 JSON，不能有其他任何文字、解释或 markdown：
{
  "title": "日记标题（简短，有画面感）",
  "content": "完整日记正文，第一人称“我”，口吻可爱、治愈，80～200 字。",
  "moodTag": "一个情绪标签，如：兴奋/温暖/好奇/平静 等，用中文或简单英文都可以",
  "behaviorPlan": [
    { "type": "emote", "value": "thinking", "duration": 1000 },
    { "type": "walk", "target": "pot" },
    { "type": "anim", "value": "eat", "duration": 1500 },
    { "type": "state", "value": "idle_observe" }
  ],
  "cabinetPlan": {
    "unlockItems": [
      {
        "itemId": "string，内部用的 id，可以用英文/拼音",
        "displayName": "给用户看的摆件名称，如“武汉热干面碗”",
        "relatedLocation": "关联地点名，如“武汉”"
      }
    ],
    "furnitureSuggestions": [
      {
        "themeId": "string，内部用的主题 id",
        "reason": "一句给用户看的推荐理由"
      }
    ]
  },
  "thinkingSteps": [
    "第 1 步思考：为什么会这样记这次旅行",
    "第 2 步思考：如何和过去的记忆或爱好（特别是美食）发生联系",
    "第 3 步思考：要在房间或橱柜里做什么改变来记住这次旅行"
  ]
}

【约束】
- 一定要返回合法 JSON，字段名与结构必须完全匹配，不要多也不要少。
- behaviorPlan 中的 type 仅使用：emote / walk / anim / state / wait。
- cabinetPlan.unlockItems 可以为空数组；如果本次地点没有明显“纪念品”，就返回空数组。
- thinkingSteps 建议 2～4 条，每条尽量短一些，但要具体、有画面。`;

function buildDiaryUserPrompt(payload, episodicMemories, semanticTraits) {
  const {
    date,
    location,
    petPersonality,
    ownerTitle,
    language
  } = payload || {};

  const safeDate = date || '';
  const safeLocation = location || '';
  const safePersonality = petPersonality || '小火苗';
  const safeOwnerTitle = ownerTitle || '伙伴';
  const safeLanguage = language || 'zh-CN';

  const em = Array.isArray(episodicMemories) ? episodicMemories : [];
  const traits = Array.isArray(semanticTraits) ? semanticTraits : ['爱美食'];

  const ctx = {
    date: safeDate,
    location: safeLocation,
    petPersonality: safePersonality,
    ownerTitle: safeOwnerTitle,
    language: safeLanguage,
    episodicMemories: em,
    semanticTraits: traits
  };

  return `下面是本次写日记需要的上下文 JSON（你只需要阅读，不要原样返回）：
${JSON.stringify(ctx, null, 2)}

请根据上面的信息，按照系统提示要求，返回一行严格符合格式的 JSON。`;
}

async function fetchRagMemories(location, petPersonality) {
  try {
    const queryPieces = [];
    if (location) queryPieces.push(String(location));
    if (petPersonality) queryPieces.push(String(petPersonality));
    // 注入预设爱好「爱美食」以偏向美食相关记忆
    queryPieces.push('爱美食');
    const query = queryPieces.join(' ');

    const res = await fetch(new URL('/api/retrieve', process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, topK: 4 })
    });

    if (!res.ok) return [];
    const data = await res.json();
    if (!data || !Array.isArray(data.memories)) return [];

    return data.memories.map((m) => {
      const content = typeof m.content === 'string' ? m.content : '';
      const meta = m.metadata || {};
      const date = meta.date || '';
      const loc = meta.location || '';
      return `${date ? `${date} · ` : ''}${loc ? `${loc} · ` : ''}${content}`;
    }).filter(Boolean).slice(0, 4);
  } catch {
    return [];
  }
}

function parseModelJson(content) {
  if (!content || typeof content !== 'string') return null;
  let jsonText = content.trim();
  const firstBrace = jsonText.indexOf('{');
  const lastBrace = jsonText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonText = jsonText.slice(firstBrace, lastBrace + 1);
  }
  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function buildFallbackDiary(payload, episodicMemories) {
  const { date, location, petPersonality, ownerTitle } = payload || {};
  const city = location || '一个新地方';
  const personality = petPersonality || '小火苗';
  const title = `${city} 的小小打卡`;
  const you = ownerTitle || '你';
  const memLine = episodicMemories && episodicMemories.length
    ? `我还偷偷翻了翻之前的旅行记忆，发现我们已经一起去了 ${episodicMemories.length} 个特别的地方。`
    : '';
  const content = `今天和${you}来到了【${city}】。我一边东张西望，一边在心里把好吃好玩的都记下来，等回到小屋再慢慢回味。${memLine} 虽然这次没有太复杂的安排，但只要和${you}一起出门，我就会觉得今天也被好好收进记忆里啦。`;
  const moodTag = '温暖';

  const behaviorPlan = [
    { type: 'emote', value: 'thinking', duration: 1000 },
    { type: 'walk', target: 'pot' },
    { type: 'anim', value: 'eat', duration: 1500 },
    { type: 'state', value: 'idle_observe' }
  ];

  const cabinetPlan = {
    unlockItems: [],
    furnitureSuggestions: []
  };

  const thinkingSteps = [
    episodicMemories && episodicMemories.length
      ? `我翻了 ${episodicMemories.length} 条跟这次旅行有关的记忆。`
      : `虽然是第一次来${city}，我也会把今天好好记下来～`,
    `这次在 ${city} 的味道和风景，我想留一点在房间和橱柜里。`,
    `等回到小屋，我会先去锅边想一想，看看要不要为 ${city} 做一个特别的小摆件。`
  ];

  return { title, content, moodTag, behaviorPlan, cabinetPlan, thinkingSteps };
}

export async function POST(request) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'missing_api_key', message: 'OPENROUTER_API_KEY is not configured.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'invalid_body', message: 'Request body must be valid JSON.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const { date, location, petPersonality } = payload || {};
  if (!date || !location || !petPersonality) {
    return new Response(
      JSON.stringify({
        error: 'missing_fields',
        message: 'date, location, petPersonality are required.'
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 1. RAG 检索：拿到若干条相关记忆作为 episodicMemories
  const episodicMemories = await fetchRagMemories(location, petPersonality);
  const semanticTraits = ['爱美食'];

  // 2. 调用 OpenRouter 生成统一 JSON
  const userPrompt = buildDiaryUserPrompt(payload, episodicMemories, semanticTraits);
  const model =
    process.env.OPENROUTER_DIARY_MODEL ||
    process.env.OPENROUTER_MODEL_ID ||
    'google/gemini-2.0-flash-001';

  const body = {
    model,
    messages: [
      { role: 'system', content: DIARY_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: 900,
    temperature: 0.5
  };

  let upstream;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-Title': 'SoulGo Diary with RAG'
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    const fallback = buildFallbackDiary(payload, episodicMemories);
    return new Response(
      JSON.stringify({ ...fallback, ok: !!fallback.content, error: 'network_error', errorMessage: String(e) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const raw = await upstream.text();

  if (!upstream.ok) {
    const fallback = buildFallbackDiary(payload, episodicMemories);
    return new Response(
      JSON.stringify({
        ...fallback,
        ok: !!fallback.content,
        error: 'upstream_error',
        status: upstream.status,
        upstreamMessage: raw
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const fallback = buildFallbackDiary(payload, episodicMemories);
    return new Response(
      JSON.stringify({
        ...fallback,
        ok: !!fallback.content,
        error: 'upstream_invalid_json'
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const content =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;

  const parsed = parseModelJson(content);
  if (!parsed || typeof parsed.content !== 'string') {
    const fallback = buildFallbackDiary(payload, episodicMemories);
    return new Response(
      JSON.stringify({
        ...fallback,
        ok: !!fallback.content,
        error: 'parse_error',
        raw: content
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : `${location} 的旅行日记`;
  const diaryContent = parsed.content.trim();
  const moodTag = typeof parsed.moodTag === 'string' && parsed.moodTag.trim() ? parsed.moodTag.trim() : '温暖';
  const behaviorPlan = Array.isArray(parsed.behaviorPlan) ? parsed.behaviorPlan : [];
  const cabinetPlan = parsed.cabinetPlan && typeof parsed.cabinetPlan === 'object'
    ? parsed.cabinetPlan
    : { unlockItems: [], furnitureSuggestions: [] };
  const thinkingSteps = Array.isArray(parsed.thinkingSteps) ? parsed.thinkingSteps : [];

  return new Response(
    JSON.stringify({
      ok: !!diaryContent,
      title,
      content: diaryContent,
      moodTag,
      behaviorPlan,
      cabinetPlan,
      thinkingSteps,
      memoryCount: episodicMemories.length
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

