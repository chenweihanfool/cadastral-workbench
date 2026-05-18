export class AIExplain {
  constructor(appCtx) {
    this._app = appCtx;
    this.text = '';
    this.loading = false;
  }

  async generate() {
    const result = this._app.fitModule?.result;
    if (!result) return;

    const { apiKey, aiProvider } = this._app.settings;
    if (!apiKey) {
      this.text = '請先在「設定」中填入 API Key。';
      return;
    }

    this.loading = true;
    const prompt = _buildPrompt(result, this._app.fitModule.caseNo);

    try {
      if (aiProvider === 'openai') {
        this.text = await _callOpenAI(apiKey, prompt);
      } else {
        this.text = await _callGemini(apiKey, prompt);
      }
    } catch (err) {
      this.text = `AI 呼叫失敗：${err.message}`;
    } finally {
      this.loading = false;
    }
  }
}

function _buildPrompt(result, caseNo) {
  return `你是台灣地籍測量專家。以下是一次地籍圖套合（fit-cadastral）的運算結果，請用繁體中文說明套合品質與可信度（100字以內）。

案號：${caseNo || '未設定'}
旋轉角 θ：${result.theta?.toFixed(4) ?? 'N/A'} 度
平移 tx：${result.tx?.toFixed(3) ?? 'N/A'} 公尺
平移 ty：${result.ty?.toFixed(3) ?? 'N/A'} 公尺
套合前 RMSE：${result.rmseBefore?.toFixed(3) ?? 'N/A'} 公尺
套合後 RMSE：${result.rmseAfter?.toFixed(3) ?? 'N/A'} 公尺

請評估此套合結果是否符合地籍測量實施規則的精度要求，並說明主要誤差來源可能為何。`;
}

async function _callOpenAI(apiKey, prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '（無回應）';
}

async function _callGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '（無回應）';
}
