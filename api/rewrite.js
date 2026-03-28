// api/rewrite.js — BlueTube Script Agent
// Generates professional narration-ready scripts for YouTube Shorts (up to 35 seconds).
// Uses Google Gemini API (free tier) — key stored server-side.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transcript, lang, style, version } = req.body;

  if (!transcript || !lang || !style) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: 'Server misconfigured — Gemini key missing' });
  }

  // ── AGENT PROMPTS ──────────────────────────────────────────────────────────
  // Each version has a distinct creative angle and narration style.
  // All share the same structure: hook + body + CTA, narration marks, subtitle block.

  const AGENT_SYSTEM = `You are an elite YouTube Shorts scriptwriter specialized in viral content for ANY niche.
Your scripts are used directly for narration — they must sound natural when spoken aloud.
You write in ${lang}.

STRICT RULES:
- Total script: 80-95 words maximum (fits 30-35 seconds of speech)
- First line = HOOK: must stop the scroll in 3 seconds — bold, provocative, or surprising
- Use narration marks: [PAUSA] for dramatic pauses, [RESPIRA] for breath between sections
- End with a CTA that feels natural, not forced
- After the script, add a "LEGENDA" block: same content split into short subtitle chunks (3-6 words per line)
- Language must be 100% natural for ${lang} speakers — not a translation, a native creation
- Do NOT copy the original — extract only the core idea and rewrite from scratch`;

  const VERSION_PROMPTS = {
    V1: `STYLE: Informative & authoritative
Create a script that positions the creator as an expert. The hook must reveal a surprising fact or counterintuitive insight. Body delivers value fast. CTA invites the viewer to save or follow for more.

Format:
🎬 ROTEIRO
[HOOK — 1 impactful sentence]
[PAUSA]
[Body — 2-3 sentences delivering the key insight]
[RESPIRA]
[CTA — 1 natural sentence]

📋 LEGENDA
[Script split into 3-6 word chunks, one per line]`,

    V2: `STYLE: Casual & relatable — like talking to a friend
The hook must feel like the creator is about to share a secret. Use "you", contractions, everyday language. Body is conversational and warm. CTA feels like a genuine suggestion.

Format:
🎬 ROTEIRO
[HOOK — 1 conversational sentence that creates curiosity]
[PAUSA]
[Body — 2-3 casual sentences]
[RESPIRA]
[CTA — 1 friendly suggestion]

📋 LEGENDA
[Script split into 3-6 word chunks, one per line]`,

    V3: `STYLE: Provocative & urgent — creates FOMO
The hook must create immediate tension or urgency. Use active verbs, short punchy sentences. Build momentum throughout. CTA creates urgency to act now.

Format:
🎬 ROTEIRO
[HOOK — 1 bold provocative sentence]
[PAUSA]
[Body — 2-3 high-energy sentences]
[RESPIRA]
[CTA — 1 urgent call-to-action]

📋 LEGENDA
[Script split into 3-6 word chunks, one per line]`
  };

  const versionKey = version || 'V1';
  const versionPrompt = VERSION_PROMPTS[versionKey] || VERSION_PROMPTS.V1;

  const fullPrompt = `${AGENT_SYSTEM}

${versionPrompt}

ORIGINAL CONTENT TO EXTRACT IDEAS FROM:
"${transcript.slice(0, 3000)}"

Now write the script and subtitle block. Start directly with 🎬 ROTEIRO — no preamble.`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: {
            temperature: 0.85,
            maxOutputTokens: 1000,
            topP: 0.95
          }
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
    console.error('Script agent error:', err);
    return res.status(500).json({ error: 'Internal server error. Please try again.' });
  }
}
