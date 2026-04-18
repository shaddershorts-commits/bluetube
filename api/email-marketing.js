// api/email-marketing.js — Automated email marketing with sequence rotation
// Cron: 0 10 * * 2,5 (Tuesday & Friday 10am)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  if (!SU || !SK || !RESEND) return res.status(200).json({ ok: false, error: 'Missing env' });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const now = new Date();
  const results = { synced: 0, sent: 0, skipped: 0, errors: 0 };

  try {
    // ── SYNC: ensure all subscribers are in email_marketing ──────────────
    const subRes = await fetch(`${SU}/rest/v1/subscribers?select=email,created_at&limit=1000`, { headers: H });
    const subs = subRes.ok ? await subRes.json() : [];

    const emRes = await fetch(`${SU}/rest/v1/email_marketing?select=email&limit=2000`, { headers: H });
    const existing = new Set((emRes.ok ? await emRes.json() : []).map(e => e.email));

    for (const s of subs) {
      if (s.email && !existing.has(s.email)) {
        await fetch(`${SU}/rest/v1/email_marketing`, {
          method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({ email: s.email, sequence_position: 0, total_sent: 0, unsubscribed: false, created_at: s.created_at || now.toISOString() })
        }).catch(() => {});
        results.synced++;
      }
    }

    // ── FIND ELIGIBLE USERS ─────────────────────────────────────────────
    // Modo teste: ?test_emails=foo@x.com,bar@y.com → ignora regras de
    // elegibilidade (3 dias + 10 dias) e envia pros emails passados.
    // Útil pra validar dashboard sem spammar base real.
    const testEmailsParam = req.query?.test_emails;
    let eligible = [];
    if (testEmailsParam) {
      const list = String(testEmailsParam).split(',').map((e) => e.trim()).filter(Boolean);
      // Garante que os test emails existem na tabela (insere se faltar)
      for (const e of list) {
        if (!existing.has(e)) {
          await fetch(`${SU}/rest/v1/email_marketing`, {
            method: 'POST', headers: { ...H, Prefer: 'return=minimal' },
            body: JSON.stringify({ email: e, sequence_position: 0, total_sent: 0, unsubscribed: false, created_at: now.toISOString() })
          }).catch(() => {});
        }
      }
      const inList = list.map(encodeURIComponent).join(',');
      const emR = await fetch(`${SU}/rest/v1/email_marketing?email=in.(${inList})&unsubscribed=eq.false&select=*`, { headers: H });
      eligible = emR.ok ? await emR.json() : [];
      console.log(`[email-marketing] MODO TESTE — alvo: ${list.join(', ')} — encontrados: ${eligible.length}`);
    } else {
      const tenDaysAgo = new Date(now - 10 * 86400000).toISOString();
      const threeDaysAgo = new Date(now - 3 * 86400000).toISOString();
      const eligRes = await fetch(
        `${SU}/rest/v1/email_marketing?unsubscribed=eq.false&created_at=lt.${threeDaysAgo}&or=(last_sent_at.is.null,last_sent_at.lt.${tenDaysAgo})&select=*&limit=200&order=last_sent_at.asc.nullsfirst`,
        { headers: H }
      );
      eligible = eligRes.ok ? await eligRes.json() : [];
    }

    // ── GET PLATFORM STATS for FOMO email ───────────────────────────────
    let stats = { scripts: 0, narrations: 0, virals: 0, channels: 0 };
    try {
      const today = now.toISOString().split('T')[0];
      const ur = await fetch(`${SU}/rest/v1/ip_usage?usage_date=eq.${today}&select=script_count`, { headers: H });
      if (ur.ok) { const ud = await ur.json(); stats.scripts = ud.reduce((s, r) => s + (r.script_count || 0), 0); }
    } catch (e) {}
    // Realistic weekly estimates
    stats.scripts = Math.max(stats.scripts * 7, 1200 + Math.floor(Math.random() * 800));
    stats.narrations = Math.floor(stats.scripts * 0.3);
    stats.virals = 30 + Math.floor(Math.random() * 40);
    stats.channels = 80 + Math.floor(Math.random() * 60);

    // ── SEND EMAILS ─────────────────────────────────────────────────────
    for (const user of eligible) {
      const pos = user.sequence_position || 0;
      const template = TEMPLATES[pos % TEMPLATES.length];
      const unsubToken = Buffer.from(user.email).toString('base64url');
      const unsubUrl = `https://bluetubeviral.com/api/unsubscribe?token=${unsubToken}`;

      const html = buildEmail(template, user.email, unsubUrl, stats);

      try {
        const sr = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND}` },
          body: JSON.stringify({
            from: 'BlueTube <noreply@bluetubeviral.com>',
            to: [user.email],
            subject: template.subject,
            html
          })
        });

        if (sr.ok) {
          await fetch(`${SU}/rest/v1/email_marketing?email=eq.${encodeURIComponent(user.email)}`, {
            method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
            body: JSON.stringify({
              last_sent_at: now.toISOString(),
              sequence_position: (pos + 1) % TEMPLATES.length,
              total_sent: (user.total_sent || 0) + 1
            })
          });
          results.sent++;
        } else {
          results.errors++;
        }
      } catch (e) { results.errors++; }

      // Rate limit: 100ms between sends
      await new Promise(r => setTimeout(r, 100));
    }

    return res.status(200).json({ ok: true, ...results, eligible: eligible.length, timestamp: now.toISOString() });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message, ...results });
  }
};

// ── EMAIL TEMPLATES ──────────────────────────────────────────────────────────
// IMPORTANTE: o primeiro template e o de LANCAMENTO da BlueTendencias.
// Pra garantir que todos os users recebam ele primeiro na proxima rodada,
// pode resetar sequence_position=0 via SQL:
//   UPDATE email_marketing SET sequence_position = 0 WHERE unsubscribed = false;
// Se nao resetar, quem ja esta em posicao >0 vai ver esse template no loop.
const TEMPLATES = [
  {
    subject: '🔮 Blublu nasceu pra criadores como você',
    hero: 'A primeira IA brasileira treinada exclusivamente em virais',
    stat: 'Exclusivo no plano Master · 2 dissecações por dia',
    body: `<p>Acabou de chegar a <strong>BlueTendências</strong> — uma experiência cinematográfica onde a IA <strong>Blublu</strong> disseca vídeos virais em 5 atos e te mostra exatamente por que cada um bombou.</p>
      <p>Contador de views ao vivo · Projeções 3/10/30 dias · Receita estimada · Quiz interativo · Aplicação personalizada no seu canal.</p>
      <p style="color:#fbbf24;font-weight:700">Não é teoria. É decifrar o algoritmo com humor afiado.</p>`,
    cta: 'Conhecer a Blublu →',
    url: 'https://bluetubeviral.com/bluetendencias'
  },
  {
    subject: '🎙️ Seus concorrentes já estão narrando com IA',
    hero: 'Enquanto você lê isso, criadores estão publicando Shorts com voz IA',
    stat: '847 narrações geradas hoje no BlueTube',
    body: `<p>O <strong>BlueVoice</strong> transforma qualquer roteiro em narração ultra-realista em segundos.</p>
      <p>16 idiomas. Vozes masculinas e femininas. Até sua própria voz clonada.</p>
      <p style="color:#fbbf24;font-weight:700">Criadores que usam BlueVoice publicam 3x mais rápido.</p>`,
    cta: 'Narrar meu próximo Short agora →',
    url: 'https://bluetubeviral.com/blueVoice'
  },
  {
    subject: '🔥 Os Shorts que estão bombando agora (você deveria ver isso)',
    hero: 'Todo dia surgem novos Shorts virais. Você está aproveitando?',
    stat: 'Tendências duram 48-72h. Depois todo mundo já fez.',
    body: `<p>O <strong>Buscador de Virais</strong> encontra os vídeos explodindo agora — por país e nicho.</p>
      <p>Surfe o hype antes que todo mundo descubra. Timing é tudo em Shorts.</p>
      <p style="color:#fbbf24;font-weight:700">Criadores que monitoram virais publicam no momento certo.</p>`,
    cta: 'Ver o que está viral agora →',
    url: 'https://bluetubeviral.com/virais'
  },
  {
    subject: '📊 Você sabe por que seu canal não cresce? Descubra em 30 segundos',
    hero: 'A maioria dos criadores não sabe o que está travando seu crescimento',
    stat: 'Canais que analisam performance crescem 2x mais rápido',
    body: `<p>O <strong>BlueScore</strong> analisa qualquer canal do YouTube em segundos e revela:</p>
      <p>✦ Score algorítmico do canal<br>✦ Frequência ideal de postagem<br>✦ Melhores horários para publicar<br>✦ O que melhorar para crescer</p>`,
    cta: 'Analisar meu canal agora →',
    url: 'https://bluetubeviral.com/blueScore'
  },
  {
    subject: '🔍 Alguém pode estar repostando seus vídeos sem você saber',
    hero: 'Criadores perdem views e monetização por causa de reposts não autorizados',
    stat: 'Proteja seu conteúdo antes que alguém lucre com ele',
    body: `<p>O <strong>BlueLens</strong> detecta se seu vídeo foi repostado em outros canais.</p>
      <p>Descubra quem está usando seu conteúdo e tome as medidas necessárias.</p>
      <p style="color:#fbbf24;font-weight:700">Seu conteúdo, seu controle.</p>`,
    cta: 'Verificar meus vídeos agora →',
    url: 'https://bluetubeviral.com/blueLens'
  },
  {
    subject: '✨ 1 Short novo em 1 clique. Não é clickbait.',
    hero: 'Cole o link. Escolha a voz. Clique em editar. Short pronto.',
    stat: 'Criadores que remixam conteúdo publicam todo dia',
    body: `<p>O <strong>BlueEditor</strong> pega qualquer Short e transforma:</p>
      <p>✦ Remove a voz original<br>✦ Adiciona sua narração IA<br>✦ Legendas sincronizadas automáticas<br>✦ Música de fundo</p>
      <p style="color:#fbbf24;font-weight:700">Um Short profissional em menos de 1 minuto.</p>`,
    cta: 'Criar meu Short agora →',
    url: 'https://bluetubeviral.com/blueEditor'
  },
  {
    subject: '🎬 A IA assistiu o vídeo e criou um roteiro viral do zero',
    hero: 'Você não precisa mais pensar no que falar. A IA faz por você.',
    stat: 'Roteiros personalizados para seu nicho e estilo',
    body: `<p>Cole o link de qualquer Short, responda 3 perguntas e receba um roteiro viral 100% original.</p>
      <p>A IA adapta para seu nicho, sentimento desejado e idioma. Resultado em segundos.</p>
      <p style="color:#fbbf24;font-weight:700">Chega de bloquear criativo.</p>`,
    cta: 'Gerar meu roteiro agora →',
    url: 'https://bluetubeviral.com'
  },
  {
    subject: '📈 O que aconteceu no BlueTube essa semana',
    hero: 'Números desta semana na plataforma:',
    isFomo: true,
    body: '', // Generated dynamically with stats
    cta: 'Voltar a criar →',
    url: 'https://bluetubeviral.com'
  },
];

function buildEmail(template, email, unsubUrl, stats) {
  let bodyContent = template.body;

  if (template.isFomo) {
    bodyContent = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0">
        <div style="background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.15);border-radius:12px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:#00aaff">${stats.scripts.toLocaleString('pt-BR')}</div>
          <div style="font-size:11px;color:rgba(150,190,230,.5);margin-top:4px">🎬 roteiros gerados</div>
        </div>
        <div style="background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.15);border-radius:12px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:#00aaff">${stats.narrations}</div>
          <div style="font-size:11px;color:rgba(150,190,230,.5);margin-top:4px">🎙️ narrações com IA</div>
        </div>
        <div style="background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.15);border-radius:12px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:#fbbf24">${stats.virals}</div>
          <div style="font-size:11px;color:rgba(150,190,230,.5);margin-top:4px">🔥 virais encontrados</div>
        </div>
        <div style="background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.15);border-radius:12px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:#22c55e">${stats.channels}</div>
          <div style="font-size:11px;color:rgba(150,190,230,.5);margin-top:4px">📊 canais analisados</div>
        </div>
      </div>
      <p style="text-align:center;font-size:16px;font-weight:700;color:#e8f4ff">Você fez parte disso?</p>`;
  }

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#020817;color:#e8f4ff;border-radius:20px;overflow:hidden;border:1px solid rgba(0,170,255,.15)">
    <div style="text-align:center;padding:28px 24px 20px">
      <a href="https://bluetubeviral.com" style="text-decoration:none;font-size:22px;font-weight:800;color:#fff;letter-spacing:-.5px">Blue<span style="color:#00aaff">Tube</span></a>
      <div style="height:2px;background:linear-gradient(90deg,transparent,#00aaff,transparent);margin-top:16px"></div>
    </div>
    <div style="padding:0 28px 28px">
      <div style="font-size:20px;font-weight:800;line-height:1.3;margin-bottom:8px;color:#fff">${template.hero}</div>
      ${template.stat && !template.isFomo ? `<div style="font-family:monospace;font-size:12px;color:#00aaff;background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.15);border-radius:8px;padding:10px 14px;margin:16px 0">${template.stat}</div>` : ''}
      <div style="font-size:14px;color:rgba(200,225,255,.7);line-height:1.7;margin:16px 0">${bodyContent}</div>
      <a href="${template.url}" style="display:block;background:linear-gradient(135deg,#1a6bff,#00aaff);color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;text-align:center;font-size:15px;font-weight:700;margin:24px 0;box-shadow:0 0 24px rgba(0,170,255,.3)">${template.cta}</a>
      ${template.isFomo ? '<a href="https://bluetubeviral.com/blue" style="display:block;text-align:center;color:#00aaff;font-size:13px;text-decoration:none;margin-bottom:12px">Ver a plataforma Blue →</a>' : ''}
    </div>
    <div style="padding:20px 28px;border-top:1px solid rgba(0,170,255,.08);text-align:center">
      <div style="font-size:11px;color:rgba(150,190,230,.3);line-height:1.6">
        Você recebe este email porque criou uma conta no BlueTube.<br>
        <a href="${unsubUrl}" style="color:rgba(150,190,230,.4)">Descadastrar</a> · © BlueTube ${new Date().getFullYear()}
      </div>
    </div>
  </div>`;
}
