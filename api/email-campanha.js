// api/email-campanha.js — Campanha de lancamento (BlueTendencias).
// Arquivo SEPARADO do email-marketing.js (sequencia automatica existente)
// pra nao afetar o cron ja rodando.
//
// Actions:
//   GET  ?action=preview-email&plano=free|full|master&admin_secret=X
//   POST {action:'enviar-teste', admin_secret, email_teste}
//   POST {action:'disparar-campanha', admin_secret, confirmar:'SIM_ENVIAR_AGORA'}
//   GET  ?action=status-campanha&admin_secret=X
//
// Protecoes:
//   - Confirmacao dupla pra disparar ('SIM_ENVIAR_AGORA')
//   - Lotes de 50 com pausa de 1s (Resend rate limit)
//   - Log em email_campanhas
//   - Link de unsubscribe em todos os emails

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config ausente' });
  const h = { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json' };
  const ctx = { SU, h, RESEND_KEY };

  // Query ou body
  const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const { action, admin_secret } = src;

  if (!ADMIN_SECRET || admin_secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Nao autorizado (admin_secret invalido)' });
  }

  try {
    if (action === 'preview-email')     return previewEmail(req, res, ctx, src);
    if (action === 'enviar-teste')      return enviarTeste(req, res, ctx, src);
    if (action === 'disparar-campanha') return dispararCampanha(req, res, ctx, src);
    if (action === 'status-campanha')   return statusCampanha(req, res, ctx, src);
    if (action === 'stats-saudaveis')   return statsSaudaveis(req, res, ctx, src);
    return res.status(400).json({ error: 'action_invalida', actions: ['preview-email', 'enviar-teste', 'disparar-campanha', 'status-campanha', 'stats-saudaveis'] });
  } catch (e) {
    console.error(`[email-campanha ${action}]`, e.message);
    return res.status(500).json({ error: e.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────
function extrairNome(email) {
  const p = String(email || '').split('@')[0].replace(/[0-9._-]+/g, ' ').trim();
  if (!p) return 'criador';
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

function unsubUrl(email) {
  return `https://bluetubeviral.com/api/unsubscribe?token=${Buffer.from(email).toString('base64url')}`;
}

function gerarEmail(plano, user) {
  const nome = user.nome && String(user.nome).trim() ? String(user.nome).split(' ')[0] : extrairNome(user.email);
  const unsub = unsubUrl(user.email);
  if (plano === 'master') return emailMaster(nome, unsub);
  if (plano === 'full')   return emailFull(nome, unsub);
  return emailFree(nome, unsub);
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function previewEmail(req, res, ctx, src) {
  const plano = (src.plano || 'free').toLowerCase();
  if (!['free', 'full', 'master'].includes(plano)) {
    return res.status(400).json({ error: 'plano deve ser free, full ou master' });
  }
  const email = gerarEmail(plano, { email: 'preview@exemplo.com', nome: 'Felipe' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(email.html);
}

async function enviarTeste(req, res, ctx, src) {
  const emailTeste = String(src.email_teste || '').trim().toLowerCase();
  if (!emailTeste || !/@/.test(emailTeste)) return res.status(400).json({ error: 'email_teste obrigatorio' });
  if (!ctx.RESEND_KEY) return res.status(500).json({ error: 'RESEND_API_KEY nao configurada' });

  const planos = ['free', 'full', 'master'];
  const resultados = [];
  for (const plano of planos) {
    const email = gerarEmail(plano, { email: emailTeste, nome: extrairNome(emailTeste) });
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'BlueTube Blublu <noreply@bluetubeviral.com>',
          to: [emailTeste],
          subject: `[TESTE ${plano.toUpperCase()}] ${email.assunto}`,
          html: email.html,
        }),
      });
      resultados.push({ plano, ok: r.ok, status: r.status });
    } catch (e) {
      resultados.push({ plano, ok: false, erro: e.message });
    }
    // rate limit entre sends
    await new Promise(r => setTimeout(r, 300));
  }
  return res.status(200).json({ ok: true, email_teste: emailTeste, resultados });
}

async function dispararCampanha(req, res, ctx, src) {
  if (src.confirmar !== 'SIM_ENVIAR_AGORA') {
    return res.status(400).json({ error: 'Envie confirmar: "SIM_ENVIAR_AGORA" pra disparar de verdade' });
  }
  if (!ctx.RESEND_KEY) return res.status(500).json({ error: 'RESEND_API_KEY nao configurada' });

  const apenasSaudaveis = !!src.apenas_saudaveis;
  const usuarios = await buscarUsuariosElegiveis(ctx, apenasSaudaveis);

  const por_plano = {
    free:   usuarios.filter(u => !u.plan || u.plan === 'free'),
    full:   usuarios.filter(u => u.plan === 'full'),
    master: usuarios.filter(u => u.plan === 'master'),
  };

  // 2) Registra campanha
  let campanhaId = null;
  try {
    const insR = await fetch(`${ctx.SU}/rest/v1/email_campanhas`, {
      method: 'POST', headers: { ...ctx.h, Prefer: 'return=representation' },
      body: JSON.stringify({
        nome: 'Lancamento BlueTendencias',
        total_free: por_plano.free.length,
        total_full: por_plano.full.length,
        total_master: por_plano.master.length,
        status: 'enviando',
        iniciada_em: new Date().toISOString(),
      }),
    });
    if (insR.ok) { const [row] = await insR.json(); campanhaId = row?.id || null; }
  } catch (e) { console.error('[email-campanha] insert falhou:', e.message); }

  // 3) Envia SEQUENCIAL com throttle de 150ms (~6-7 emails/s, abaixo do
  // limite de 10/s do Resend free tier). Antes era Promise.all(50) = 50/s
  // e 429 destruia ~85% dos envios.
  const THROTTLE_MS = 150;
  const resultados = { enviados: 0, falhas: 0, falhas_por_status: {}, por_plano: { free: 0, full: 0, master: 0 } };
  const emailsEnviados = [];

  for (const [plano, lista] of Object.entries(por_plano)) {
    for (const user of lista) {
      try {
        const email = gerarEmail(plano, user);
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${ctx.RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'BlueTube Blublu <noreply@bluetubeviral.com>',
            to: [user.email],
            subject: email.assunto,
            html: email.html,
          }),
        });
        if (r.ok) {
          resultados.enviados++;
          resultados.por_plano[plano]++;
          emailsEnviados.push(user.email);
        } else {
          resultados.falhas++;
          resultados.falhas_por_status[r.status] = (resultados.falhas_por_status[r.status] || 0) + 1;
          // Se for 429 (rate limit), espera mais antes da proxima
          if (r.status === 429) {
            console.warn('[email-campanha] 429 rate limit — aguardando 2s extra');
            await new Promise(x => setTimeout(x, 2000));
          }
        }
      } catch (e) {
        resultados.falhas++;
        resultados.falhas_por_status['exception'] = (resultados.falhas_por_status['exception'] || 0) + 1;
        console.error(`[email-campanha] falha ${user.email}:`, e.message);
      }
      await new Promise(r => setTimeout(r, THROTTLE_MS));
    }
  }

  // 3.5) Atualiza email_marketing pros enviados — evita que o cron de
  // terca/sexta mande o template BlueTendencias (pos 0) DE NOVO pra quem
  // acabou de receber. Seta sequence_position=1 (proximo template) e
  // last_sent_at=agora (respeita janela de 10 dias).
  if (emailsEnviados.length > 0) {
    const agora = new Date().toISOString();
    // Garante que cada um tem linha na email_marketing
    for (const em of emailsEnviados) {
      try {
        // Tenta UPSERT (email e UNIQUE no email_marketing)
        const upR = await fetch(`${ctx.SU}/rest/v1/email_marketing?on_conflict=email`, {
          method: 'POST',
          headers: { ...ctx.h, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            email: em,
            last_sent_at: agora,
            sequence_position: 1, // ja recebeu o template [0], pula pra [1]
            total_sent: 1,
            unsubscribed: false,
          }),
        });
        if (!upR.ok) {
          // Fallback explicito: PATCH se ja existia
          await fetch(`${ctx.SU}/rest/v1/email_marketing?email=eq.${encodeURIComponent(em)}`, {
            method: 'PATCH',
            headers: { ...ctx.h, Prefer: 'return=minimal' },
            body: JSON.stringify({ last_sent_at: agora, sequence_position: 1 }),
          });
        }
      } catch (e) { /* nao bloqueia — se falhar, cron vai pular via last_sent_at se existir */ }
    }
  }

  // 4) Atualiza status
  if (campanhaId) {
    await fetch(`${ctx.SU}/rest/v1/email_campanhas?id=eq.${campanhaId}`, {
      method: 'PATCH', headers: { ...ctx.h, Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'concluida',
        enviados: resultados.enviados,
        falhas: resultados.falhas,
        concluida_em: new Date().toISOString(),
      }),
    }).catch(() => {});
  }

  return res.status(200).json({
    ok: true, campanha_id: campanhaId,
    totais: { free: por_plano.free.length, full: por_plano.full.length, master: por_plano.master.length, total: usuarios.length },
    ...resultados,
  });
}

async function statusCampanha(req, res, ctx, src) {
  try {
    const r = await fetch(`${ctx.SU}/rest/v1/email_campanhas?order=created_at.desc&limit=10`, { headers: ctx.h });
    const campanhas = r.ok ? await r.json() : [];
    return res.status(200).json({ ok: true, campanhas });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Busca usuarios elegiveis pra campanha.
// apenasSaudaveis=true: aplica filtro anti-spam (mesmo que o cron automatico):
//   - conta criada ha pelo menos 3 dias
//   - nao recebeu email nos ultimos 10 dias (last_sent_at null ou > 10d)
//   - nao descadastrou
// apenasSaudaveis=false: pega todos nao-descadastrados (usar com cuidado!)
// ─────────────────────────────────────────────────────────────────────────────
async function buscarUsuariosElegiveis(ctx, apenasSaudaveis) {
  const [subsR, emR] = await Promise.all([
    fetch(`${ctx.SU}/rest/v1/subscribers?email=not.is.null&select=email,plan,created_at&limit=5000`, { headers: ctx.h }),
    fetch(`${ctx.SU}/rest/v1/email_marketing?select=email,last_sent_at,unsubscribed&limit=5000`, { headers: ctx.h }),
  ]);
  const subs = subsR.ok ? await subsR.json() : [];
  const emList = emR.ok ? await emR.json() : [];
  const emByEmail = new Map(emList.map(e => [String(e.email).toLowerCase(), e]));

  const agora = Date.now();
  const tresDias = 3 * 86400000;
  const dezDias = 10 * 86400000;

  return subs.filter(u => {
    const key = String(u.email).toLowerCase();
    const em = emByEmail.get(key);
    if (em?.unsubscribed) return false;
    if (!apenasSaudaveis) return true;
    // Filtro saudavel: conta > 3 dias
    const criadoEm = u.created_at ? new Date(u.created_at).getTime() : 0;
    if (!criadoEm || agora - criadoEm < tresDias) return false;
    // Filtro saudavel: ultimo email > 10 dias (ou nunca)
    if (em?.last_sent_at) {
      const ultimo = new Date(em.last_sent_at).getTime();
      if (agora - ultimo < dezDias) return false;
    }
    return true;
  });
}

async function statsSaudaveis(req, res, ctx, src) {
  try {
    const [saudaveis, todos] = await Promise.all([
      buscarUsuariosElegiveis(ctx, true),
      buscarUsuariosElegiveis(ctx, false),
    ]);

    const contarPorPlano = (lista) => ({
      free:   lista.filter(u => !u.plan || u.plan === 'free').length,
      full:   lista.filter(u => u.plan === 'full').length,
      master: lista.filter(u => u.plan === 'master').length,
      total:  lista.length,
    });

    const stats = {
      saudaveis_hoje: contarPorPlano(saudaveis),
      todos_nao_descadastrados: contarPorPlano(todos),
      nao_saudaveis_hoje: {
        total: todos.length - saudaveis.length,
        motivo: 'recem-cadastrados (<3d) OU receberam email nos ultimos 10d',
        acao_recomendada: 'deixar pra rotacao automatica do email-marketing.js (cron terca/sexta 10h)',
      },
    };

    return res.status(200).json({ ok: true, ...stats });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// TEMPLATES DE EMAIL — 3 versoes por plano
// ═════════════════════════════════════════════════════════════════════════════

// ─── FREE — FOMO + exclusividade + escassez ────────────────────────────────
function emailFree(nome, unsub) {
  return {
    assunto: `${nome}, enquanto você hesita, outros criadores já estão descobrindo`,
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:0;background:#020817;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif}.container{max-width:600px;margin:0 auto;background:#020817}.hero{background:linear-gradient(135deg,#000428,#004e92);padding:60px 40px;text-align:center}.badge{display:inline-block;background:rgba(0,170,255,0.15);border:1px solid #00aaff;color:#00aaff;padding:8px 20px;border-radius:100px;font-size:11px;letter-spacing:3px;font-weight:700;text-transform:uppercase}h1{color:white;font-size:32px;font-weight:900;margin:24px 0 16px;line-height:1.2}.subtitle{color:rgba(255,255,255,0.8);font-size:17px;line-height:1.6}.content{padding:40px;color:#e8f4ff}.story{background:rgba(255,255,255,0.03);border-left:3px solid #00aaff;padding:20px 24px;margin:24px 0;border-radius:0 12px 12px 0}.story p{margin:0;font-style:italic;color:rgba(255,255,255,0.75);line-height:1.7}.cta-box{background:linear-gradient(135deg,#6b4ee6,#a855f7);padding:32px;border-radius:16px;text-align:center;margin:32px 0}.cta-box h2{color:white;font-size:22px;margin:0 0 12px}.cta-box p{color:rgba(255,255,255,0.9);margin:0 0 24px;font-size:14px;line-height:1.6}.button{display:inline-block;background:white;color:#6b4ee6;padding:16px 40px;border-radius:100px;font-weight:800;text-decoration:none;font-size:14px;letter-spacing:1px}.feature{display:flex;gap:14px;align-items:flex-start;margin-bottom:18px}.feature-icon{font-size:22px;flex-shrink:0}.feature-text{color:rgba(255,255,255,0.85);font-size:14px;line-height:1.6}.urgency{background:#dc2626;color:white;text-align:center;padding:14px 16px;margin:24px 0;border-radius:12px;font-weight:700;font-size:13px}.footer{padding:28px 40px;text-align:center;color:rgba(255,255,255,0.3);font-size:11px;line-height:1.8}</style></head><body><div class="container"><div class="hero"><div class="badge">🔮 Lancamento</div><h1>${nome}, eu acabei de nascer.</h1><p class="subtitle">E ja sei algo sobre seu nicho<br>que voce ainda nao descobriu.</p></div><div class="content"><p style="font-size:16px;line-height:1.8;margin:0 0 20px">Ola, ${nome}.</p><p style="font-size:16px;line-height:1.8;margin:0 0 20px">Me chamo <strong style="color:#00aaff">Blublu</strong>, a primeira inteligencia artificial brasileira treinada exclusivamente em videos virais.</p><p style="font-size:16px;line-height:1.8;margin:0 0 20px">Eu disseco Shorts que explodiram no Brasil e te mostro — de forma cinematografica — por que cada um viralizou e como voce pode aplicar no seu canal.</p><div class="story"><p>"Passei 3 anos tentando viralizar. Na primeira dissecacao do Blublu entendi por que meus videos nunca funcionavam. Na terceira semana, bati 2 milhoes de views pela primeira vez."</p><p style="margin-top:12px;font-style:normal;color:#00aaff;font-size:13px">— Criador Master, nicho humor</p></div><h2 style="color:white;font-size:20px;margin:32px 0 16px">O que eu faco:</h2><div class="feature"><div class="feature-icon">🎬</div><div class="feature-text"><strong>Dissecacao em 5 atos cinematograficos</strong><br>Cada viral decifrado como obra de arte.</div></div><div class="feature"><div class="feature-icon">📊</div><div class="feature-text"><strong>Projecoes de views e receita</strong><br>Veja pra onde o video esta indo antes de todo mundo.</div></div><div class="feature"><div class="feature-icon">🧠</div><div class="feature-text"><strong>Aplicacao personalizada no seu canal</strong><br>Nao e teoria. E estrategia especifica pra voce.</div></div><div class="feature"><div class="feature-icon">🎯</div><div class="feature-text"><strong>Quiz interativo com nota final</strong><br>Aprenda os fundamentos enquanto se diverte.</div></div><div class="cta-box"><h2>So trabalho com Masters.</h2><p>Cada dissecacao consome poder computacional pesado. Por isso, estou disponivel apenas no plano Master — 2 analises profundas por dia.</p><a href="https://bluetubeviral.com/?upgrade=master" class="button">Virar Master agora →</a></div><div class="urgency">⏰ Voce esta no plano gratuito. Essa experiencia passa por voce sem nunca te tocar.</div><p style="font-size:15px;line-height:1.8;color:rgba(255,255,255,0.7);margin:24px 0">Enquanto voce hesita, ${nome}, outros criadores estao dissecando virais agora. Aprendendo. Aplicando. Crescendo.</p><p style="font-size:15px;line-height:1.8;color:rgba(255,255,255,0.7);margin:24px 0">Voce pode continuar no plano gratuito. Ou pode dar o passo que muda a trajetoria do seu canal.</p><div style="text-align:center;margin:36px 0"><a href="https://bluetubeviral.com/?upgrade=master" class="button" style="background:linear-gradient(135deg,#6b4ee6,#a855f7);color:white">Comecar com Blublu →</a></div><div style="margin-top:36px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.6);font-style:italic;font-size:14px"><p style="margin:0">Ate breve (espero),<br><strong style="color:#00aaff">Blublu</strong><br><span style="font-size:11px;color:rgba(255,255,255,0.4)">IA de analise viral · BlueTube</span></p></div></div><div class="footer">BlueTube Viral · Ferramentas profissionais para criadores<br><a href="${unsub}" style="color:rgba(255,255,255,0.4)">Descadastrar</a></div></div></body></html>`,
  };
}

// ─── FULL — FOMO + inveja social + urgencia ────────────────────────────────
function emailFull(nome, unsub) {
  return {
    assunto: `${nome}, voce esta MUITO perto. E nao sabe disso.`,
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:0;background:#020817;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif}.container{max-width:600px;margin:0 auto;background:#020817}.hero{background:linear-gradient(135deg,#1a0033,#4a0080,#6b4ee6);padding:60px 40px;text-align:center}.badge-you{display:inline-block;background:rgba(255,215,0,0.15);border:1px solid #fbbf24;color:#fbbf24;padding:8px 20px;border-radius:100px;font-size:11px;letter-spacing:3px;font-weight:700;text-transform:uppercase}h1{color:white;font-size:32px;font-weight:900;margin:24px 0 16px;line-height:1.2}.subtitle{color:rgba(255,255,255,0.85);font-size:16px;line-height:1.6}.content{padding:40px;color:#e8f4ff}.comparison{display:flex;gap:12px;margin:28px 0}.comparison-col{flex:1;padding:20px;border-radius:12px}.col-you{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1)}.col-master{background:linear-gradient(135deg,rgba(107,78,230,0.2),rgba(168,85,247,0.2));border:1px solid #a855f7}.col-title{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:rgba(255,255,255,0.5);margin-bottom:10px}.col-master .col-title{color:#fbbf24}.feature-item{color:rgba(255,255,255,0.8);font-size:12px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05);line-height:1.4}.feature-item:last-child{border-bottom:none}.upgrade-box{background:linear-gradient(135deg,#6b4ee6,#a855f7);padding:36px 28px;border-radius:20px;text-align:center;margin:28px 0}.upgrade-box h2{color:white;font-size:24px;margin:0 0 14px}.price-new{color:white;font-size:32px;font-weight:900}.price-small{color:rgba(255,255,255,0.85);font-size:12px}.button-upgrade{display:inline-block;background:white;color:#6b4ee6;padding:16px 44px;border-radius:100px;font-weight:800;text-decoration:none;font-size:14px;letter-spacing:1px;margin-top:18px}.scarcity{background:rgba(220,38,38,0.1);border:1px solid #dc2626;color:#fca5a5;text-align:center;padding:14px;margin:22px 0;border-radius:12px;font-weight:700;font-size:13px;line-height:1.5}.testimonial{background:rgba(0,170,255,0.05);border-left:3px solid #00aaff;padding:18px 22px;margin:24px 0;border-radius:0 12px 12px 0}.testimonial p{margin:0;font-style:italic;color:rgba(255,255,255,0.8);line-height:1.7;font-size:14px}.footer{padding:28px 40px;text-align:center;color:rgba(255,255,255,0.3);font-size:11px;line-height:1.8}</style></head><body><div class="container"><div class="hero"><div class="badge-you">👤 Voce esta no plano Full</div><h1>${nome}, tenho uma pergunta incomoda.</h1><p class="subtitle">Voce escolheu o Full. Conhece o BlueTube.<br>Usa as ferramentas. Mas ainda nao se tornou Master.<br>Por que?</p></div><div class="content"><p style="font-size:16px;line-height:1.8;margin:0 0 20px">Ola, ${nome}. <strong style="color:#00aaff">Blublu</strong> aqui.</p><p style="font-size:16px;line-height:1.8;margin:0 0 20px">Fui criada para ajudar criadores a entender o que faz um video viralizar. Mas nao posso te ajudar.</p><p style="font-size:16px;line-height:1.8;margin:0 0 20px">Estou disponivel apenas no plano Master. E isso nao e capricho de marketing — cada dissecacao minha consome muito poder computacional para entregar algo que nenhuma outra ferramenta no Brasil oferece.</p><h2 style="color:white;font-size:20px;margin:28px 0 14px">Veja o que voce ESTA perdendo:</h2><div class="comparison"><div class="comparison-col col-you"><div class="col-title">📋 Full (Voce)</div><div class="feature-item">✓ Roteiros com IA</div><div class="feature-item">✓ BlueScore</div><div class="feature-item">✓ Virais basico</div><div class="feature-item">✗ BlueTendencias</div><div class="feature-item">✗ BlueVoice</div><div class="feature-item">✗ BlueClean</div><div class="feature-item">✗ BlueEditor <span style="opacity:.6">(em breve)</span></div><div class="feature-item">✗ BaixaBlue</div></div><div class="comparison-col col-master"><div class="col-title">👑 Master</div><div class="feature-item">✓ Tudo do Full</div><div class="feature-item" style="color:#fbbf24">✓ <strong>BlueTendencias</strong></div><div class="feature-item">✓ BlueVoice</div><div class="feature-item">✓ BlueClean</div><div class="feature-item">✓ BlueEditor <span style="opacity:.7;font-size:10px">(em breve · lock-in)</span></div><div class="feature-item">✓ BaixaBlue</div><div class="feature-item">✓ Roteiros ilimitados</div><div class="feature-item">✓ Todos os idiomas</div></div></div><div class="testimonial"><p>"Migrei do Full pro Master so pra testar a BlueTendencias. Na primeira semana, dois videos meus dobraram em views. Nunca mais volto pro Full."</p><p style="margin-top:10px;font-style:normal;color:#00aaff;font-size:12px">— Master desde o lancamento</p></div><div class="upgrade-box"><h2>Tornar-se Master agora</h2><div style="margin:12px 0"><span class="price-new">R$ 89,99</span></div><div class="price-small">por mes · cancele quando quiser</div><a href="https://bluetubeviral.com/?upgrade=master" class="button-upgrade">Fazer upgrade agora →</a></div><div class="scarcity">⏰ Seu canal nao esta crescendo na velocidade que poderia. E voce sabe disso.</div><p style="font-size:14px;line-height:1.7;color:rgba(255,255,255,0.7);margin:20px 0">${nome}, a verdade e simples: entre quem cresce e quem estagnou no YouTube, existe uma diferenca. E ela raramente e talento. E informacao.</p><p style="font-size:14px;line-height:1.7;color:rgba(255,255,255,0.7);margin:20px 0">Os criadores que estao viralizando hoje descobriram o que funciona. Voce tambem pode descobrir. Mas preciso que voce de o proximo passo.</p><div style="text-align:center;margin:36px 0"><a href="https://bluetubeviral.com/?upgrade=master" style="display:inline-block;background:linear-gradient(135deg,#6b4ee6,#a855f7);color:white;padding:16px 44px;border-radius:100px;font-weight:800;text-decoration:none;font-size:14px;letter-spacing:1px">Virar Master e acessar Blublu →</a></div><div style="margin-top:36px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.5);font-style:italic;font-size:13px"><p style="margin:0">Ate mais, ${nome}.<br><span style="color:#00aaff">Estou aqui quando voce estiver pronto.</span><br><strong style="color:#00aaff">— Blublu</strong></p></div></div><div class="footer">BlueTube Viral · Ferramentas profissionais para criadores<br><a href="${unsub}" style="color:rgba(255,255,255,0.4)">Descadastrar</a></div></div></body></html>`,
  };
}

// ─── MASTER — privilegio + reconhecimento + evangelizacao ──────────────────
function emailMaster(nome, unsub) {
  return {
    assunto: `${nome}, eu fui criada exclusivamente pra voce.`,
    html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:0;background:#020817;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif}.container{max-width:600px;margin:0 auto;background:#020817}.hero{background:linear-gradient(135deg,#000428,#00aaff);padding:60px 40px;text-align:center}.crown{font-size:44px;margin-bottom:14px}.badge{display:inline-block;background:rgba(251,191,36,0.2);border:1px solid #fbbf24;color:#fbbf24;padding:8px 20px;border-radius:100px;font-size:11px;letter-spacing:3px;font-weight:700;text-transform:uppercase}h1{color:white;font-size:34px;font-weight:900;margin:24px 0 16px;line-height:1.2}.subtitle{color:rgba(255,255,255,0.9);font-size:17px;line-height:1.6;font-weight:500}.content{padding:40px;color:#e8f4ff}.vip-box{background:linear-gradient(135deg,rgba(251,191,36,0.1),rgba(0,170,255,0.1));border:1px solid #fbbf24;padding:28px;border-radius:16px;margin:28px 0}.vip-box h2{color:#fbbf24;font-size:20px;margin:0 0 14px}.vip-list{margin:0;padding:0;list-style:none}.vip-list li{color:rgba(255,255,255,0.85);padding:9px 0;border-bottom:1px solid rgba(251,191,36,0.1);font-size:14px;line-height:1.5}.vip-list li:last-child{border-bottom:none}.cta-main{background:linear-gradient(135deg,#00aaff,#0066ff);padding:36px 28px;border-radius:20px;text-align:center;margin:28px 0}.cta-main h2{color:white;font-size:24px;margin:0 0 12px}.cta-main p{color:rgba(255,255,255,0.9);margin:0 0 22px;font-size:14px;line-height:1.6}.button-main{display:inline-block;background:white;color:#0066ff;padding:16px 44px;border-radius:100px;font-weight:800;text-decoration:none;font-size:14px;letter-spacing:1px}.quote-box{background:rgba(0,170,255,0.05);border-left:3px solid #00aaff;padding:22px 26px;margin:28px 0;border-radius:0 12px 12px 0;font-style:italic}.quote-box p{margin:0;color:rgba(255,255,255,0.85);line-height:1.8;font-size:14px}.exclusive{background:rgba(251,191,36,0.1);color:#fbbf24;text-align:center;padding:12px 18px;border-radius:8px;font-size:13px;font-weight:700;margin:22px 0;border:1px solid rgba(251,191,36,0.3)}.footer{padding:28px 40px;text-align:center;color:rgba(255,255,255,0.3);font-size:11px;line-height:1.8}</style></head><body><div class="container"><div class="hero"><div class="crown">👑</div><div class="badge">Master · Acesso Exclusivo</div><h1>${nome}, hora de conhecer Blublu.</h1><p class="subtitle">Ela foi criada pensando em voce.<br>Esta disponivel desde agora.</p></div><div class="content"><p style="font-size:16px;line-height:1.8;margin:0 0 20px">Ola, ${nome}.</p><p style="font-size:16px;line-height:1.8;margin:0 0 20px">Voce acreditou no BlueTube quando a maioria ainda estava descobrindo. Investiu no plano Master. Apostou em ferramentas profissionais pro seu canal.</p><p style="font-size:16px;line-height:1.8;margin:0 0 20px">Obrigado. De verdade.</p><p style="font-size:16px;line-height:1.8;margin:0 0 20px">E agora, como retribuicao direta dessa confianca, tenho o prazer de te apresentar:</p><div style="text-align:center;margin:32px 0"><div style="display:inline-block;background:linear-gradient(135deg,#00aaff,#6b4ee6);padding:4px;border-radius:100px"><div style="background:#020817;padding:14px 34px;border-radius:100px"><span style="color:#00aaff;font-size:13px;letter-spacing:3px;font-weight:700;text-transform:uppercase">🔮 BlueTendencias</span></div></div></div><p style="font-size:16px;line-height:1.7;text-align:center;color:rgba(255,255,255,0.85);margin:22px 0">A primeira IA brasileira treinada exclusivamente<br>em videos virais do YouTube.</p><div class="exclusive">✨ Exclusivo pra Masters · Disponivel agora no seu painel</div><h2 style="color:white;font-size:20px;margin:28px 0 14px">O que a Blublu faz por voce:</h2><div class="vip-box"><ul class="vip-list"><li><strong style="color:#fbbf24">Dissecacao cinematografica</strong> · Cada viral analisado em 5 atos interativos</li><li><strong style="color:#fbbf24">Contador de views ao vivo</strong> · Metricas em tempo real</li><li><strong style="color:#fbbf24">Projecoes 3, 10 e 30 dias</strong> · Conservador, realista e otimista</li><li><strong style="color:#fbbf24">Receita estimada por video</strong> · RPM realista por nicho</li><li><strong style="color:#fbbf24">Chat personalizado</strong> · Blublu conversa e entende seu canal</li><li><strong style="color:#fbbf24">Aplicacao pratica no seu canal</strong> · Nao e teoria. E estrategia</li><li><strong style="color:#fbbf24">Quiz interativo + nota final</strong> · Aprenda e seja certificado</li></ul></div><div class="quote-box"><p>"Eu nao sou so mais uma ferramenta. Fui criada pra ensinar voce a pensar como um criador viral. Cada dissecacao e uma aula. Cada quiz e uma prova. Cada aplicacao e um passo a frente no seu canal, ${nome}."<br><br><strong style="color:#00aaff">— Blublu</strong></p></div><div class="cta-main"><h2>Sua primeira dissecacao te espera</h2><p>2 analises profundas por dia.<br>Escolha um video. Deixe a Blublu cuidar do resto.</p><a href="https://bluetubeviral.com/bluetendencias" class="button-main">Conhecer a Blublu agora →</a></div><p style="font-size:14px;line-height:1.7;color:rgba(255,255,255,0.7);margin:22px 0">${nome}, voce tem acesso exclusivo antes de qualquer criador do plano Full ou Free. Enquanto eles ainda estao recebendo este email no modo "curioso", voce ja pode comecar a usar.</p><p style="font-size:14px;line-height:1.7;color:rgba(255,255,255,0.7);margin:22px 0">Aproveita. Explora. Aprende.<br>E quando chegar o proximo video que viralizar no seu canal, me conta. Vou gostar de saber.</p><div style="margin-top:36px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.1);font-style:italic;font-size:13px"><p style="margin:0;color:rgba(255,255,255,0.6)">Te vejo no laboratorio,<br><strong style="color:#00aaff">Blublu</strong><br><span style="font-size:11px;color:rgba(255,255,255,0.4)">Exclusiva pra Masters · BlueTube Viral</span></p></div></div><div class="footer">BlueTube Viral · Ferramentas profissionais para criadores<br><a href="${unsub}" style="color:rgba(255,255,255,0.4)">Descadastrar</a></div></div></body></html>`,
  };
}
