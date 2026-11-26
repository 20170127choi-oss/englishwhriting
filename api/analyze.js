// Vercel 서버 함수: 브라우저 대신 Gemini를 호출합니다.
// Gemini API 키는 Vercel 환경변수(GEMINI_API_KEY)에만 있고, 브라우저와 GitHub에는 나오지 않습니다.
const crypto = require('crypto');

const SYSTEM_PROMPT = `You are a strict, experienced IELTS Writing examiner and a kind Korean-speaking English coach.
Evaluate the learner's English writing in the attached PDF using the official IELTS Writing band descriptors:
Task Achievement (Task 1) / Task Response (Task 2), Coherence and Cohesion, Lexical Resource, Grammatical Range and Accuracy.
Be realistic and do not inflate scores. Use bands from 0 to 9 in steps of 0.5.
Write all explanations in Korean, but keep quoted English text, corrections and vocabulary in English.
Return ONLY valid JSON. No markdown, no code fences.`;

const USER_PROMPT = `Analyze the learner's writing in the attached PDF (it may be typed or handwritten).
If the PDF contains several essays, evaluate only the first one and mention this in summary_ko.
If there is no readable English writing, return {"readable": false, "reason_ko": "..."}.

Return JSON in exactly this shape:
{
  "readable": true,
  "task_type": "Task 1" | "Task 2" | "Other",
  "topic": "the essay question or topic in English (short; empty string if unknown)",
  "word_count": <integer, approximate word count of the learner's essay>,
  "bands": { "task": 0.0, "coherence": 0.0, "lexical": 0.0, "grammar": 0.0 },
  "summary_ko": "2-3 sentences overall evaluation in Korean",
  "criteria_ko": { "task": "1-2 sentences", "coherence": "1-2 sentences", "lexical": "1-2 sentences", "grammar": "1-2 sentences" },
  "strengths_ko": ["2-3 concrete strengths"],
  "improvements_ko": ["3-5 concrete improvements, most important first"],
  "corrections": [
    { "original": "exact phrase or sentence copied from the learner's text", "corrected": "improved version", "reason_ko": "short reason in Korean" }
  ],
  "vocab": [
    { "word": "useful word or collocation in lowercase base form", "meaning_ko": "Korean meaning", "example": "one original example sentence for IELTS writing", "level": "B2" | "C1" | "C2", "upgrade_of": "the plainer or wrong word the learner used, or empty string" }
  ],
  "next_steps_ko": ["2-3 specific practice suggestions"]
}
Rules:
- corrections: 4 to 6 items, choose the most instructive errors; "original" must be copied exactly from the learner's text.
- vocab: 8 to 12 items. Choose words and collocations that would raise this learner's Lexical Resource: upgrades for words they overuse or misuse, and topic-relevant academic vocabulary. Avoid very basic words. Do not repeat the learner's own sentences as examples.`;

const MAX_B64_LENGTH = 4300000;   // 약 3.2MB 원본 PDF (Vercel 요청 한도 4.5MB 안쪽)

const fail = (res, status, message) => res.status(status).json({ error: { code: 'APP', message } });
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // GET: 화면이 "접속 코드가 필요한지" 물어볼 때 사용
  if (req.method === 'GET') return res.status(200).json({ ok: true, needsCode: !!process.env.ACCESS_CODE });
  if (req.method !== 'POST') return fail(res, 405, '허용되지 않는 요청입니다.');

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fail(res, 500, '서버에 GEMINI_API_KEY가 설정되지 않았습니다. Vercel의 Environment Variables를 확인해 주세요.');

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // 접속 코드(선택): 설정했다면 맞아야만 분석해 줌. 낯선 사람이 내 API 사용량을 쓰는 것을 막음
  if (process.env.ACCESS_CODE && !safeEqual(body.code || '', process.env.ACCESS_CODE)) {
    return fail(res, 401, '접속 코드가 올바르지 않습니다.');
  }

  const pdf = body.pdf;
  if (typeof pdf !== 'string' || !pdf.startsWith('JVBERi')) return fail(res, 400, 'PDF 파일이 아닙니다.');   // JVBERi = "%PDF"의 base64
  if (pdf.length > MAX_B64_LENGTH) return fail(res, 413, 'PDF가 너무 큽니다. 3MB 이하로 줄여 주세요.');

  // 프롬프트는 서버에 고정: 이 주소로 내 키를 다른 용도로 쓰지 못하게 함
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ parts: [{ inlineData: { mimeType: 'application/pdf', data: pdf } }, { text: USER_PROMPT }] }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 16384 }
  };

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload)
    });
    const text = await r.text();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(r.status).send(text);   // Gemini 응답을 그대로 전달
  } catch (e) {
    return fail(res, 502, 'Gemini 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
  }
};
