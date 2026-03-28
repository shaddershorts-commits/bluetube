// api/rewrite.js — Vercel Serverless Function
// Calls Claude API server-side to rewrite transcripts into 3 original versions.
// The Anthropic API key is stored as an environment variable — never exposed to the browser.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transcript, lang, style } = req.body;

  if (!transcript || !lang || !style) {
    return res.status(400).json({ error: 'Missing transcript, lang or style' });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'Server misconfigured — Anthropic key missing' });
  }

  const prompt = `You are an expert content creator for YouTube Shorts.

ORIGINAL TRANSCRIPTION:
${transcript.slice(0, 4000)}

TASK: Write a completely ORIGINAL script based on this content.
- Output language: ${lang}
- Style: ${style}
- Use completely different words, structure, and examples from the original
- Must feel 100% original — not a translation or close paraphrase
- Length: suitable for a 30-90 second Short
- Format: ready-to-read script with clear flow

Return ONLY the script. No explanations, no meta-comments.`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await claudeRes.json();

    if (!claudeRes.ok) {
      return res.status(502).json({ error: data.error?.message || 'Claude API error' });
    }

    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    if (!text) return res.status(502).json({ error: 'Empty response from Claude' });

    return res.status(200).json({ text });

  } catch (err) {
    console.error('Rewrite error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
