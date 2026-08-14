// api/blublu-emails.js — Campanha de lançamento do "Falar com o Blublu" (Virais).
// 3 emails, escritos COMO O BLUBLU (voz do personagem, vetor dele no layout).
// Audiência: master + full — AMBOS com a copy de uso (2026-08-02: Full ganhou o chat).
// Free fica FORA: 298 emails estourariam a cota do Resend Free (100/dia).
//
// Actions (admin_secret obrigatório):
//   GET  ?action=preview&email=1|2|3&plano=master|full
//   POST {action:'teste', email:1|2|3, plano, email_teste}
//   GET/POST ?action=disparar&email=1|2|3  → envia pra master+full (com guarda:
//            se a campanha 'blublu-email-N' já foi enviada, recusa — os crons
//            anuais do GH Actions re-disparam sem efeito)
//
// Espelha as proteções do email-campanha.js: throttle 150ms (10/s do Resend),
// log em email_campanhas, unsubscribe em todos.

const { barrarSeDesligado, abrirCota } = require('./_helpers/emailGate.js');

const SITE = 'https://www.bluetubeviral.com';

const unsub = (email) => `${SITE}/api/unsubscribe?token=${Buffer.from(email).toString('base64url')}`;

// ── LAYOUT BASE (dark BlueTube, vetor do Blublu no topo, 1 coluna email-safe) ──
function shell({ vetor, titulo, corpo, ctaTexto, ctaUrl, email }) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#020817;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#020817;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:linear-gradient(180deg,#081430,#040c1e);border:1px solid rgba(127,212,255,.25);border-radius:20px;overflow:hidden;">
  <tr><td align="center" style="padding:36px 28px 0;">
    <img src="${SITE}/${vetor}" alt="Blublu" width="110" style="display:block;filter:drop-shadow(0 0 14px rgba(0,190,255,.5));"/>
  </td></tr>
  <tr><td align="center" style="padding:18px 28px 0;">
    <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;color:#00d4ff;text-transform:uppercase;font-weight:bold;">Blublu · direto do laboratório</div>
    <div style="font-family:Arial,sans-serif;font-size:26px;line-height:1.2;color:#eaf3ff;font-weight:800;padding-top:10px;">${titulo}</div>
  </td></tr>
  <tr><td style="padding:18px 32px 8px;">
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

// ── OS 3 EMAILS (voz do Blublu). 2026-08-02: Full ganhou o chat, entao TODOS
// recebem a copy de USO (chave master). A copy full abaixo virou legado.
const EMAILS = {
  1: {
    master: {
      assunto: 'Agora você pode falar comigo. Tenta não desperdiçar. 🧪',
      vetor: 'blublu-pointing.png',
      titulo: 'Eu ganhei um chat.<br/>Você ganhou um garimpeiro.',
      corpo: `Sim, sou eu. O Blublu. Mandando email. (Uma IA escrevendo email pra você — o futuro é estranho, aceita.)<br/><br/>
A novidade: dentro da <b style="color:#eaf3ff;">Virais</b> agora existe o botão <b style="color:#00d4ff;">"Falar com o Blublu"</b>. Você me pede em bom português — <i>"vídeos que falam do Michael Jackson"</i>, <i>"os do Luiz Stubbe"</i>, <i>"mais de 5 mi de views em 2 semanas"</i> — e eu viro o acervo INTEIRO de cabeça pra baixo. YouTube, canais secretos, TikTok. Em 10 idiomas.<br/><br/>
E o meu diferencial que nenhum botão de filtro te dá: eu <b style="color:#eaf3ff;">PROVO</b>. Quando o assunto é citado na fala do vídeo, eu te digo o minuto exato.<br/><br/>Sua assinatura já te dá isso. Vai lá me dar trabalho.`,
      ctaTexto: 'Falar com o Blublu →',
      ctaUrl: `${SITE}/virais`,
    },
    full: {
      assunto: 'Os Master ganharam meu número. Você ganhou este email. 😏',
      vetor: 'blublu-sad.png',
      titulo: 'Eu queria falar<br/>com você. Juro.',
      corpo: `Notícia do laboratório: agora existe um chat onde criadores conversam COMIGO dentro da Virais. Pedem qualquer tema, canal ou filtro — e eu encontro, com prova de onde o assunto foi citado, minuto exato.<br/><br/>
"Nossa Blublu, quero!" — eu sei. Mas tem um detalhe constrangedor pra você: <b style="color:#fbbf24;">é exclusivo Master</b>.<br/><br/>
Você é Full. Tá quase lá. O que separa nós dois é um upgrade — e sinceramente? Teu concorrente Master já tá me pedindo os virais do teu nicho agora, enquanto você lê este email.`,
      ctaTexto: '👑 Virar Master e falar comigo',
      ctaUrl: `${SITE}/?upgrade=master`,
    },
  },
  2: {
    master: {
      assunto: 'Eu não chuto. Eu te digo o MINUTO. ⏱️',
      vetor: 'blublu-thumbsup.png',
      titulo: 'O truque que 90%<br/>ainda não descobriu.',
      corpo: `Voltei. (Eu sempre volto — sou um botão, tecnicamente. Piadas de IA, desculpa.)<br/><br/>
Três coisas que você talvez não saiba do meu chat na Virais:<br/><br/>
🗣️ <b style="color:#eaf3ff;">"Citado aos 2:13"</b> — quando o tema aparece NA FALA do vídeo, o card mostra o minuto exato. Clica e cai direto no momento.<br/><br/>
🔬 <b style="color:#eaf3ff;">Analisar</b> — do card direto pra BlueTendências, comigo dissecando o vídeo em 5 atos.<br/><br/>
📝 <b style="color:#eaf3ff;">Roteiro</b> — do card direto pro gerador, com o link já colado.<br/><br/>
Achar → entender → produzir. Sem sair do fluxo. É assim que quem posta todo dia trabalha.`,
      ctaTexto: 'Testar os 3 agora →',
      ctaUrl: `${SITE}/virais`,
    },
    full: {
      assunto: 'O que separa nós dois: Master. 🧪',
      vetor: 'blublu-pointing.png',
      titulo: 'Deixa eu te contar o<br/>que você tá perdendo.',
      corpo: `Enquanto isso, no chat que você ainda não pode abrir:<br/><br/>
✅ Masters pedindo <i>"vídeos que falam de [tema do SEU nicho]"</i> e recebendo a lista com o minuto exato da citação<br/>
✅ Busca em 10 idiomas no acervo inteiro — até nos canais secretos<br/>
✅ Card → análise em 5 atos → roteiro pronto, em 3 cliques<br/><br/>
Eu guardo até o apelido de cada um. Memória de elefante. (Sou uma IA, minha memória é literalmente infinita, mas você entendeu o charme.)<br/><br/>
FALA COMIGO. Ah, é… você ainda não pode. 😏`,
      ctaTexto: '👑 Resolver isso agora',
      ctaUrl: `${SITE}/?upgrade=master`,
    },
  },
  3: {
    master: {
      assunto: 'Me pede o impossível. Eu gosto. 🔥',
      vetor: 'blublu-happy.png',
      titulo: 'Teu próximo viral<br/>já tá no meu acervo.',
      corpo: `Última do lançamento, prometo. (Mentira, eu não prometo nada.)<br/><br/>
Um desafio: abre o chat e me pede a coisa mais específica que você conseguir. <i>"Tigre escalando árvore."</i> <i>"O mais recente do fulano acima de 1 milhão."</i> <i>"Só TikTok sobre tal assunto."</i><br/><br/>
Se tiver no acervo, eu acho — e te mostro ONDE é citado. Se não tiver, eu falo na lata, sem enrolação. Precisão é meu sobrenome. (Blublu Precisão. Soa bem.)<br/><br/>
E cada busca tua me deixa mais rápido pro resto da comunidade. Ciência coletiva, mano.`,
      ctaTexto: 'Me desafiar agora →',
      ctaUrl: `${SITE}/virais`,
    },
    full: {
      assunto: 'Última chamada do laboratório. Depois eu paro. (Talvez.) 🧪',
      vetor: 'blublu-happy.png',
      titulo: 'Vou parar de te<br/>provocar. Hoje.',
      corpo: `Terceiro email. Eu sei. Até IA tem limite de insistência (o meu é configurável, mas enfim).<br/><br/>
Resumo da história: existe um chat na Virais onde eu acho qualquer vídeo do acervo pra você — por tema, canal, filtro, em 10 idiomas, com o minuto da citação. Os Master usam todo dia. Você não.<br/><br/>
A matemática é simples: <b style="color:#eaf3ff;">1 viral certo achado por mim</b> paga o upgrade do mês. E eu acho vários por dia.<br/><br/>
Decide aí. Eu fico no botão azul, esperando. Brilhando. Literalmente — meu botão brilha.`,
      ctaTexto: '👑 Virar Master',
      ctaUrl: `${SITE}/?upgrade=master`,
    },
  },
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Corte de marketing (10/08/2026): cota do Resend caiu pra 200/dia.
  if (barrarSeDesligado(res, 'blublu-emails')) return;

  // Teto diário COMPARTILHADO entre todos os jobs de marketing — sem isso
  // cada um respeitaria "30 por dia" e o total viraria 8 × 30, estourando a
  // cota do Resend e derrubando o código de cadastro. Ver _helpers/emailGate.js.
  const cota = abrirCota('blublu-emails');

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

  const render = (plano, email) => {
    const t = EMAILS[n][plano];
    return { assunto: t.assunto, html: shell({ ...t, email }) };
  };

  try {
    if (src.action === 'preview') {
      const plano = src.plano === 'full' ? 'full' : 'master';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(render(plano, 'preview@exemplo.com').html);
    }

    if (src.action === 'teste') {
      if (!src.email_teste) return res.status(400).json({ error: 'email_teste obrigatorio' });
      const plano = src.plano === 'full' ? 'full' : 'master';
      const e = render(plano, src.email_teste);
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'BlueTube Blublu <noreply@bluetubeviral.com>', to: [src.email_teste], subject: '[TESTE] ' + e.assunto, html: e.html }),
      });
      return res.status(200).json({ ok: r.ok, status: r.status });
    }

    if (src.action === 'disparar') {
      const nomeCampanha = `blublu-email-${n}`;
      // guarda anti-reenvio (os crons do GH sao anuais — sem isso, refire em 2027)
      const jaR = await fetch(`${SU}/rest/v1/email_campanhas?nome=eq.${encodeURIComponent(nomeCampanha)}&select=id,status`, { headers: h });
      const ja = jaR.ok ? await jaR.json() : [];
      if (ja.length) return res.status(200).json({ ok: true, pulado: 'campanha ja enviada', campanha: nomeCampanha });

      // audiencia: master + full ativos (free fica fora — cota do Resend)
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
        // acabou a cota do dia: para AQUI, no envio exato (o teto não depende
        // de o job ter cortado a lista direito lá em cima).
        if (!(await cota.pegarUm())) break;
        try {
          const e = render('master', s.email); // 2026-08-02: Full ganhou o Blublu — copy única de USO pra todos
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: 'BlueTube Blublu <noreply@bluetubeviral.com>', to: [s.email], subject: e.assunto, html: e.html }),
          });
          if (r.ok) resultados.enviados++; else { resultados.falhas++; if (r.status === 429) await new Promise((x) => setTimeout(x, 2000)); }
        } catch (e) { resultados.falhas++; }
        await new Promise((x) => setTimeout(x, 150)); // 10/s do Resend
      }
      if (campanhaId) {
        await fetch(`${SU}/rest/v1/email_campanhas?id=eq.${campanhaId}`, { method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'concluida', enviados: resultados.enviados, falhas: resultados.falhas, concluida_em: new Date().toISOString() }) }).catch(() => {});
      }
      return res.status(200).json({ ok: true, campanha: nomeCampanha, ...resultados });
    }

    return res.status(400).json({ error: 'action invalida' });
  } catch (e) {
    console.error('[blublu-emails]', e.message);
    return res.status(500).json({ error: e.message.slice(0, 150) });
  }
};
