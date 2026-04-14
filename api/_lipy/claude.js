// Wrapper Claude (Lipy) com fallback mock

async function askClaude({ system, messages, model = 'claude-sonnet-4-5', max_tokens = 2000, temperature = 0.7, json = false }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return mockResponse(messages, json);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens,
        temperature,
        system: Array.isArray(system) ? system : [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages
      })
    });
    if (!res.ok) {
      console.error('[lipy/claude]', res.status, await res.text());
      return mockResponse(messages, json);
    }
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    if (json) {
      try {
        const match = text.match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : { texto: text };
      } catch { return { texto: text }; }
    }
    return text;
  } catch (err) {
    console.error('[lipy/claude]', err);
    return mockResponse(messages, json);
  }
}

function mockResponse(messages, json) {
  const last = messages[messages.length - 1]?.content || '';
  if (json) {
    return {
      mock: true,
      resumo: 'Resposta simulada — ANTHROPIC_API_KEY não configurada',
      acoes: [],
      input_preview: String(last).slice(0, 200)
    };
  }
  return `[MOCK] Lipy recebeu: "${String(last).slice(0, 120)}"`;
}

module.exports = { askClaude };
