// api/comunidade-emails.js — Campanha da Comunidade BlueTube (/comunidade).
// Email 1: VOZ DO DANIEL (treinamento "2 canais do zero, 100 mil em 42 dias").
// Emails 2 e 3: anúncio geral da Comunidade (voz BlueTube).
// Audiência: master + full (quem tem acesso à Comunidade). Free fica fora (cota Resend).
// Mesmo padrão do blublu-emails: preview/teste/disparar + guarda anti-reenvio.

const SITE = 'https://www.bluetubeviral.com';
const unsub = (email) => `${SITE}/api/unsubscribe?token=${Buffer.from(email).toString('base64url')}`;

function shell({ badge, titulo, corpo, ctaTexto, ctaUrl, email, corBadge }) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#020817;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#020817;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:linear-gradient(180deg,#081430,#040c1e);border:1px solid rgba(127,212,255,.25);border-radius:20px;overflow:hidden;">
  <tr><td align="center" style="padding:34px 28px 0;">
    <div style="display:inline-block;background:${corBadge || 'linear-gradient(135deg,#fbbf24,#f59e0b)'};color:#0b0f19;font-family:Arial,sans-serif;font-weight:800;padding:8px 20px;border-radius:20px;letter-spacing:1px;font-size:11px;">${badge}</div>
    <div style="font-family:Arial,sans-serif;font-size:25px;line-height:1.25;color:#eaf3ff;font-weight:800;padding-top:16px;">${titulo}</div>
  </td></tr>
  <tr><td style="padding:16px 32px 8px;">
    <div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.65;color:#c7d8f0;">${corpo}</div>
  </td></tr>
  <tr><td align="center" style="padding:22px 28px 34px;">
    <a href="${ctaUrl}" style="display:inline-block;background:linear-gradient(100deg,#00d4ff,#1a6bff);color:#021018;font-family:Arial,sans-serif;font-size:15px;font-weight:800;text-decoration:none;padding:15px 34px;border-radius:100px;">${ctaTexto}</a>
  </td></tr>
  <tr><td align="center" style="padding:0 28px 26px;">
    <div style="font-family:Arial,sans-serif;font-size:11px;color:#5b7099;">BlueTube · Criador Viral<br/><a href="${unsub(email)}" style="color:#5b7099;">descadastrar</a></div>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

const EMAILS = {
  1: { // VOZ DO DANIEL
    from: 'Daniel Augusto no BlueTube <noreply@bluetubeviral.com>',
    assunto: 'Criei 2 canais do ZERO e bati 100 MIL inscritos em 42 dias. Te mostro como. 🤫',
    badge: '🎬 TREINAMENTO OFICIAL BLUETUBE',
    corBadge: 'linear-gradient(135deg,#fbbf24,#f59e0b)',
    titulo: 'Fala galera,<br/>aqui é o Daniel!',
    corpo: `Gravei um treinamento exclusivo pro <b style="color:#eaf3ff;">BlueTube</b> abrindo o jogo COMPLETO: como eu criei <b style="color:#eaf3ff;">2 canais do zero</b> e bati <b style="color:#fbbf24;">100 mil inscritos em menos de 42 dias</b> — o Daniel Blox chegou lá em 37, e o meu canal em 42.<br/><br/>
Não é teoria: é o passo a passo do que eu fiz, na ordem que eu fiz, com o que funcionou e o que eu jogaria fora. Se você tá começando um canal (ou travado no mesmo número há meses), esse vídeo é literalmente o mapa.<br/><br/>
Tá disponível agora dentro da <b style="color:#00d4ff;">Comunidade BlueTube</b> — e ainda dá pra comentar lá comigo e com os outros criadores.`,
    ctaTexto: '▶️ Assistir na Comunidade',
    ctaUrl: `${SITE}/comunidade`,
  },
  2: { // anúncio geral v1
    from: 'BlueTube <noreply@bluetubeviral.com>',
    assunto: 'Abrimos a Comunidade BlueTube. Seu lugar tá guardado. 🚀',
    badge: '🏛️ NOVIDADE NO SEU PLANO',
    corBadge: 'linear-gradient(135deg,#00d4ff,#1a6bff)',
    titulo: 'A Comunidade BlueTube<br/>está no ar.',
    corpo: `Agora existe um lugar onde os criadores do BlueTube se encontram: a <b style="color:#00d4ff;">Comunidade</b>.<br/><br/>
📚 <b style="color:#eaf3ff;">Treinamentos oficiais</b> — conteúdo exclusivo que não existe em nenhum outro lugar (o primeiro já está lá: 2 canais do zero a 100 mil inscritos em 42 dias)<br/><br/>
💬 <b style="color:#eaf3ff;">Troca real entre criadores</b> — comente, pergunte, mostre seu trabalho pra quem tá no mesmo jogo que você<br/><br/>
🔔 <b style="color:#eaf3ff;">Sino de notificações</b> — você fica sabendo na hora quando sai treinamento novo<br/><br/>
Já está incluso no seu plano. É só entrar.`,
    ctaTexto: 'Entrar na Comunidade →',
    ctaUrl: `${SITE}/comunidade`,
  },
  3: { // anúncio geral v2
    from: 'BlueTube <noreply@bluetubeviral.com>',
    assunto: 'Tem treinamento oficial te esperando na Comunidade 👀',
    badge: '🏛️ VOCÊ AINDA NÃO ENTROU',
    corBadge: 'linear-gradient(135deg,#a78bfa,#6d28d9)',
    titulo: 'Criar sozinho é mais<br/>difícil. E desnecessário.',
    corpo: `Todo criador que cresce rápido tem uma coisa em comum: <b style="color:#eaf3ff;">não cresce sozinho</b>.<br/><br/>
A <b style="color:#00d4ff;">Comunidade BlueTube</b> já está movimentada: treinamento oficial mostrando o caminho do zero aos 100 mil inscritos, criadores trocando o que está funcionando AGORA, e novidades chegando primeiro pra quem está lá dentro.<br/><br/>
Você já paga por isso — está incluso no seu plano. Só falta aparecer. Passa lá, deixa um comentário no treinamento e marca presença: a comunidade fica melhor com você dentro.`,
    ctaTexto: 'Marcar presença →',
    ctaUrl: `${SITE}/comunidade`,
  },
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'config' });
  const h = { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json' };

  const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  if (!ADMIN_SECRET || src.admin_secret !== ADMIN_SECRET) return res.status(403).json({ error: 'nao autorizado' });

  const n = ['1', '2', '3'].includes(String(src.email)) ? String(src.email) : null;
  if (!n) return res.status(400).json({ error: 'email=1|2|3 obrigatorio' });
  const T = EMAILS[n];

  try {
    if (src.action === 'preview') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(shell({ ...T, email: 'preview@exemplo.com' }));
    }

    if (src.action === 'teste') {
      if (!src.email_teste) return res.status(400).json({ error: 'email_teste obrigatorio' });
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: T.from, to: [src.email_teste], subject: '[TESTE] ' + T.assunto, html: shell({ ...T, email: src.email_teste }) }),
      });
      return res.status(200).json({ ok: r.ok, status: r.status });
    }

    if (src.action === 'disparar') {
      const nomeCampanha = `comunidade-email-${n}`;
      const jaR = await fetch(`${SU}/rest/v1/email_campanhas?nome=eq.${encodeURIComponent(nomeCampanha)}&select=id`, { headers: h });
      const ja = jaR.ok ? await jaR.json() : [];
      if (ja.length) return res.status(200).json({ ok: true, pulado: 'campanha ja enviada', campanha: nomeCampanha });

      const subsR = await fetch(`${SU}/rest/v1/subscribers?plan=in.(master,full)&select=email,plan,plan_expires_at,is_manual`, { headers: h });
      if (!subsR.ok) return res.status(502).json({ error: 'subscribers ' + subsR.status });
      const agora = new Date();
      const subs = (await subsR.json()).filter((s) => s.email && (s.is_manual || !s.plan_expires_at || new Date(s.plan_expires_at) > agora));

      let campanhaId = null;
      try {
        const insR = await fetch(`${SU}/rest/v1/email_campanhas`, {
          method: 'POST', headers: { ...h, Prefer: 'return=representation' },
          body: JSON.stringify({ nome: nomeCampanha, total_free: 0, total_full: subs.filter((s) => s.plan === 'full').length, total_master: subs.filter((s) => s.plan === 'master').length, status: 'enviando', iniciada_em: new Date().toISOString() }),
        });
        if (insR.ok) { const [row] = await insR.json(); campanhaId = row?.id || null; }
      } catch (e) {}

      const resultados = { enviados: 0, falhas: 0 };
      for (const s of subs) {
        try {
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: T.from, to: [s.email], subject: T.assunto, html: shell({ ...T, email: s.email }) }),
          });
          if (r.ok) resultados.enviados++; else { resultados.falhas++; if (r.status === 429) await new Promise((x) => setTimeout(x, 2000)); }
        } catch (e) { resultados.falhas++; }
        await new Promise((x) => setTimeout(x, 150));
      }
      if (campanhaId) {
        await fetch(`${SU}/rest/v1/email_campanhas?id=eq.${campanhaId}`, { method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'concluida', enviados: resultados.enviados, falhas: resultados.falhas, concluida_em: new Date().toISOString() }) }).catch(() => {});
      }
      return res.status(200).json({ ok: true, campanha: nomeCampanha, ...resultados });
    }

    return res.status(400).json({ error: 'action invalida' });
  } catch (e) {
    console.error('[comunidade-emails]', e.message);
    return res.status(500).json({ error: e.message.slice(0, 150) });
  }
};
