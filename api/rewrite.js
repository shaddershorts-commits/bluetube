// api/rewrite.js — Vercel Serverless Function
// Uses Google Gemini API (free tier) to rewrite transcripts into original scripts.
// GEMINI_API_KEY is stored as a Vercel environment variable — never exposed to browser.

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

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: 'Server misconfigured — Gemini key missing' });
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
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent
?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 800 }
        })
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      const msg = data.error?.message || 'Gemini API error';
      return res.status(502).json({ error: msg });
    }

    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';

    if (!text) return res.status(502).json({ error: 'Empty response from Gemini' });

    return res.status(200).json({ text });

  } catch (err) {
    console.error('Rewrite error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
