// api/bluescore.js — BlueScore feito por gente
// ===========================================================================
// O BlueScore virou análise HUMANA: o usuário pede, entra numa fila, e quem
// avalia é o dono do BlueTube — ex-suporte do YouTube. Nada aqui calcula nota
// nem chama IA; este arquivo é fila, laudo e entrega.
//
// ⚠️ ISOLADO DE PROPÓSITO. Os endpoints antigos (bluescore-channel /
// bluescore-videos / bluescore-ai) vivem no api/auth.js, que é ESM e regra da
// casa não encostar. A página nova não chama nenhum deles.
//
// AÇÕES DO USUÁRIO (body.token):
//   pedir   — entra na fila (Full/Master, 2 por dia)
//   meus    — histórico de análises dele
//   ver     — abre uma análise entregue (só o dono)
//   salvar  — marca/desmarca como salva
//
// AÇÕES DO ADMIN (Authorization: Bearer ADMIN_SECRET):
//   fila          — o que está esperando + as últimas entregues
//   laudo_salvar  — rascunho, não avisa ninguém
//   laudo_enviar  — publica, avisa no sininho e por email
//   recusar       — link imprestável, devolve a cota pro usuário

const { enviarEmailAnalisePronta } = require('./_helpers/bluescoreEmail.js');

const LIMITE_DIA = 2;                    // por conta, por dia
const PLANOS_OK = ['full', 'master'];
const MAX_VIDEOS_LAUDO = 12;
const MAX_TEXTO = 4000;

// ── REDES ──────────────────────────────────────────────────────────────────
// A análise cobre YouTube, TikTok e Instagram. Link de fora disso é recusado
// na entrada, não na fila — não faz sentido o dono descobrir isso depois.
const REDES = {
  youtube:   { nome: 'YouTube',   emoji: '▶️' },
  tiktok:    { nome: 'TikTok',    emoji: '🎵' },
  instagram: { nome: 'Instagram', emoji: '📸' },
};

function detectarRede(url) {
  const u = String(url || '').toLowerCase();
  if (/(^|[./])(youtube\.com|youtu\.be)/.test(u)) return 'youtube';
  if (/(^|[./])tiktok\.com/.test(u)) return 'tiktok';
  if (/(^|[./])instagram\.com/.test(u)) return 'instagram';
  return null;
}

// Nome curto pra mostrar na fila e no email antes de o dono preencher o laudo.
function extrairHandle(url, rede) {
  const u = String(url || '').trim();
  let m;
  if (rede === 'youtube') {
    if ((m = u.match(/@([A-Za-z0-9_.-]+)/))) return '@' + m[1];
    if ((m = u.match(/\/(?:c|user)\/([A-Za-z0-9_.-]+)/i))) return m[1];
    // /channel/UCxxxx é ID, não nome. Devolver ele fazia a fila mostrar
    // "UCwWJxujawMclRdihmkbgryQ" e o formulário nascer com esse lixo no campo
    // "Nome do canal". Sem handle, o display cai pra URL, que ao menos é
    // clicável e diz de quem é.
  } else if (rede === 'tiktok') {
    if ((m = u.match(/@([A-Za-z0-9_.]+)/))) return '@' + m[1];
  } else if (rede === 'instagram') {
    if ((m = u.match(/instagram\.com\/([A-Za-z0-9_.]+)/i))) return '@' + m[1];
  }
  return null;
}

// Meia-noite de Brasília em UTC. O Brasil não tem horário de verão desde 2019,
// então -03:00 fixo resolve; usar UTC puro faria a cota virar às 21h pro user.
function inicioDoDiaBR() {
  const sp = new Date(Date.now() - 3 * 3600 * 1000);
  return new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate(), 3, 0, 0));
}

const limpar = (t, max) => String(t == null ? '' : t).trim().slice(0, max || MAX_TEXTO);

// ── LAUDO ──────────────────────────────────────────────────────────────────
// Formato do que o dono preenche no admin. Tudo texto livre menos as notas:
// as métricas são digitadas à mão porque TikTok e Instagram não têm API aqui,
// e uma experiência só pra YouTube não serviria.
function normalizarLaudo(bruto) {
  const b = (bruto && typeof bruto === 'object') ? bruto : {};
  const nota = Math.max(0, Math.min(100, Math.round(Number(b.nota) || 0)));
  const pil = (b.pilares && typeof b.pilares === 'object') ? b.pilares : {};
  const met = (b.metricas && typeof b.metricas === 'object') ? b.metricas : {};
  const can = (b.canal && typeof b.canal === 'object') ? b.canal : {};

  const nota100 = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

  return {
    nota,
    classificacao: classificar(nota).chave,
    classificacao_label: limpar(b.classificacao_label, 60) || classificar(nota).rotulo,
    canal: {
      nome: limpar(can.nome, 120),
      seguidores: limpar(can.seguidores, 40),
      publicacoes: limpar(can.publicacoes, 40),
      foto: limpar(can.foto, 500),
    },
    metricas: {
      media_views: limpar(met.media_views, 40),
      engajamento: limpar(met.engajamento, 40),
      consistencia: limpar(met.consistencia, 40),
      tendencia: limpar(met.tendencia, 40),
    },
    pilares: {
      performance: nota100(pil.performance),
      performance_desc: limpar(pil.performance_desc, 400),
      risco: nota100(pil.risco),
      risco_desc: limpar(pil.risco_desc, 400),
      comportamento: nota100(pil.comportamento),
      comportamento_desc: limpar(pil.comportamento_desc, 400),
    },
    resumo: limpar(b.resumo),
    pontos: (Array.isArray(b.pontos) ? b.pontos : []).slice(0, 12).map((p) => ({
      tipo: ['pos', 'neg', 'warn'].includes(p?.tipo) ? p.tipo : 'warn',
      titulo: limpar(p?.titulo, 140),
      texto: limpar(p?.texto, 800),
    })).filter((p) => p.titulo || p.texto),
    recomendacoes: (Array.isArray(b.recomendacoes) ? b.recomendacoes : []).slice(0, 12).map((r) => ({
      acao: limpar(r?.acao, 200),
      porque: limpar(r?.porque, 600),
      impacto: ['alto', 'medio', 'baixo'].includes(r?.impacto) ? r.impacto : 'medio',
    })).filter((r) => r.acao),
    videos: (Array.isArray(b.videos) ? b.videos : []).slice(0, MAX_VIDEOS_LAUDO).map((v) => ({
      url: limpar(v?.url, 500),
      titulo: limpar(v?.titulo, 200),
      observacao: limpar(v?.observacao, 1200),
    })).filter((v) => v.url || v.titulo || v.observacao),
  };
}

function classificar(nota) {
  if (nota >= 80) return { chave: 'high', rotulo: '🚀 Alta confiança' };
  if (nota >= 60) return { chave: 'good', rotulo: '✅ Boa performance' };
  if (nota >= 40) return { chave: 'moderate', rotulo: '⚠ Atenção necessária' };
  return { chave: 'low', rotulo: '🔴 Precisa de ajuste' };
}

// Um laudo sem nota e sem diagnóstico não é análise — barra antes de avisar o
// usuário, senão ele recebe email pra ver uma página vazia.
function laudoEstaPronto(laudo) {
  if (!laudo) return 'laudo vazio';
  if (!laudo.nota) return 'falta a nota';
  if (!laudo.resumo) return 'falta o diagnóstico';
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  if (!SU || !SK) return res.status(500).json({ error: 'config_incompleta' });

  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const acao = String(body.action || '');

  // ═══ ADMIN ═══════════════════════════════════════════════════════════════
  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  const ehAdmin = !!ADMIN_SECRET &&
    (req.headers.authorization || '') === 'Bearer ' + ADMIN_SECRET;
  const ACOES_ADMIN = ['fila', 'laudo_salvar', 'laudo_enviar', 'recusar', 'previa', 'abrir'];

  if (ACOES_ADMIN.includes(acao)) {
    if (!ehAdmin) return res.status(401).json({ error: 'nao_autorizado' });

    // ── FILA ───────────────────────────────────────────────────────────────
    if (acao === 'fila') {
      const pR = await fetch(
        `${SU}/rest/v1/bluescore_pedidos?status=in.(na_fila,em_analise)&order=criado_em.asc&select=*`,
        { headers: h });
      // ⚠️ Fila vazia e fila QUEBRADA não podem se parecer. Se a consulta
      // falhar (tabela ausente, coluna errada), devolver [] mostraria
      // "fila vazia 🎉" enquanto gente espera análise. Falha alto.
      if (!pR.ok) {
        const t = await pR.text().catch(() => '');
        console.error('[bluescore] fila', pR.status, t.slice(0, 200));
        return res.status(500).json({
          error: 'fila_indisponivel',
          detalhe: pR.status === 404 || /does not exist|PGRST205/i.test(t)
            ? 'A tabela bluescore_pedidos ainda não existe — rode sql/bluescore_pedidos.sql no Supabase.'
            : `Banco respondeu ${pR.status}.`,
        });
      }
      const pendentes = await pR.json();
      const eR = await fetch(
        `${SU}/rest/v1/bluescore_pedidos?status=in.(entregue,recusado)&order=atualizado_em.desc&limit=20&select=id,email,nome,rede,perfil_handle,perfil_url,status,criado_em,entregue_em,laudo`,
        { headers: h });
      const recentes = eR.ok ? await eR.json() : [];
      return res.status(200).json({
        ok: true,
        pendentes,
        recentes: recentes.map((r) => ({ ...r, laudo: r.laudo ? { nota: r.laudo.nota } : null })),
        total_pendentes: pendentes.length,
      });
    }

    // ── PRÉVIA ─────────────────────────────────────────────────────────────
    // Devolve o laudo passando pela MESMA normalização da entrega, sem gravar
    // nada. Se a prévia usasse o texto cru do formulário, você veria uma coisa
    // e o usuário receberia outra (a nota é limitada a 0–100, a faixa é
    // derivada, linha vazia some). Prévia que mente é pior que prévia nenhuma.
    if (acao === 'previa') {
      const laudo = normalizarLaudo(body.laudo);
      return res.status(200).json({ ok: true, laudo, falta: laudoEstaPronto(laudo) });
    }

    const id = String(body.id || '');
    if (!id) return res.status(400).json({ error: 'id_obrigatorio' });

    // ── ABRIR ──────────────────────────────────────────────────────────────
    // Um pedido específico, com o laudo inteiro. Serve pra você espiar a
    // página de uma análise JÁ ENTREGUE — que você não consegue ver pelo link
    // do usuário, porque aquele link exige a sessão dele.
    if (acao === 'abrir') {
      const r = await fetch(`${SU}/rest/v1/bluescore_pedidos?id=eq.${id}&select=*`, { headers: h });
      if (!r.ok) return res.status(500).json({ error: 'falha_ao_ler' });
      const pedido = (await r.json())[0];
      if (!pedido) return res.status(404).json({ error: 'pedido_nao_encontrado' });
      return res.status(200).json({ ok: true, pedido });
    }

    // ── RECUSAR ────────────────────────────────────────────────────────────
    // Link quebrado, perfil privado, conta com 2 vídeos. Devolve a cota
    // avisando o motivo — sumir com o pedido em silêncio seria pior.
    if (acao === 'recusar') {
      const motivo = limpar(body.motivo, 400) || 'Não consegui abrir esse perfil.';
      const pR = await fetch(`${SU}/rest/v1/bluescore_pedidos?id=eq.${id}&select=*`, { headers: h });
      const pedido = pR.ok ? (await pR.json())[0] : null;
      if (!pedido) return res.status(404).json({ error: 'pedido_nao_encontrado' });

      await fetch(`${SU}/rest/v1/bluescore_pedidos?id=eq.${id}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'recusado', motivo_recusa: motivo, atualizado_em: new Date().toISOString() }),
      });
      await avisarSininho(SU, h, pedido.user_id, {
        tipo: 'bluescore',
        titulo: 'Não deu pra analisar esse perfil',
        mensagem: motivo.slice(0, 140),
        dados: { pedido_id: id, status: 'recusado' },
      });
      return res.status(200).json({ ok: true, status: 'recusado' });
    }

    // ── SALVAR / ENVIAR ────────────────────────────────────────────────────
    const laudo = normalizarLaudo(body.laudo);
    const enviando = acao === 'laudo_enviar';

    if (enviando) {
      const falta = laudoEstaPronto(laudo);
      if (falta) return res.status(400).json({ error: 'laudo_incompleto', detalhe: falta });
    }

    const patch = {
      laudo,
      status: enviando ? 'entregue' : 'em_analise',
      atualizado_em: new Date().toISOString(),
    };
    if (enviando) patch.entregue_em = new Date().toISOString();

    const uR = await fetch(`${SU}/rest/v1/bluescore_pedidos?id=eq.${id}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    if (!uR.ok) {
      const t = await uR.text().catch(() => '');
      console.error('[bluescore] patch', uR.status, t.slice(0, 200));
      return res.status(500).json({ error: 'falha_ao_salvar' });
    }
    const pedido = (await uR.json())[0];

    if (!enviando) return res.status(200).json({ ok: true, status: 'em_analise' });

    // Avisos: o sininho é o que importa (fica no site), o email é o empurrão.
    // Nenhum dos dois pode derrubar a entrega — a análise já está publicada.
    const sino = await avisarSininho(SU, h, pedido.user_id, {
      tipo: 'bluescore',
      titulo: 'Sua análise do BlueScore está pronta',
      mensagem: `${pedido.laudo?.canal?.nome || pedido.perfil_handle || 'Seu perfil'} · nota ${pedido.laudo?.nota}/100`,
      dados: { pedido_id: pedido.id, status: 'entregue', url: `/blueScore?pedido=${pedido.id}` },
    });
    const email = await enviarEmailAnalisePronta(pedido).catch(() => ({ ok: false }));

    return res.status(200).json({ ok: true, status: 'entregue', sininho: sino.ok, email: email.ok });
  }

  // ═══ USUÁRIO ═════════════════════════════════════════════════════════════
  const token = body.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'login_obrigatorio' });

  let userId = null, email = null, nome = '';
  try {
    const u = await fetch(`${SU}/auth/v1/user`, {
      headers: { apikey: AK, Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(8000),
    });
    if (u.ok) {
      const usuario = await u.json();
      userId = usuario?.id || null;
      email = (usuario?.email || '').toLowerCase() || null;
      const bruto = usuario?.user_metadata?.name || usuario?.user_metadata?.full_name || '';
      nome = String(bruto).trim();
    }
  } catch (e) {}
  if (!userId || !email) return res.status(401).json({ error: 'token_invalido' });

  // ── VER / SALVAR / MEUS: não precisam de plano ─────────────────────────
  // Quem já pediu tem direito de rever o laudo mesmo se o plano caiu depois.
  // Cobrar plano pra LER algo que a pessoa já pagou seria pegadinha.
  if (acao === 'meus') {
    const r = await fetch(
      `${SU}/rest/v1/bluescore_pedidos?user_id=eq.${userId}&order=criado_em.desc&limit=50&select=id,rede,perfil_url,perfil_handle,status,motivo_recusa,salvo,criado_em,entregue_em,laudo`,
      { headers: h });
    // Mesma regra da fila do admin: "não tenho análises" e "não consegui
    // buscar" são coisas diferentes. Dizer que não tem, quando tem, faria a
    // pessoa pedir de novo e gastar cota à toa.
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[bluescore] meus', r.status, t.slice(0, 200));
      return res.status(503).json({ error: 'historico_indisponivel' });
    }
    const linhas = await r.json();
    return res.status(200).json({
      ok: true,
      // a lista não carrega o laudo inteiro: só o suficiente pro card
      pedidos: linhas.map((p) => ({
        id: p.id, rede: p.rede, perfil_url: p.perfil_url, perfil_handle: p.perfil_handle,
        status: p.status, motivo_recusa: p.motivo_recusa, salvo: p.salvo,
        criado_em: p.criado_em, entregue_em: p.entregue_em,
        nota: p.laudo?.nota ?? null,
        canal_nome: p.laudo?.canal?.nome || null,
      })),
      usadas_hoje: linhas.filter((p) => new Date(p.criado_em) >= inicioDoDiaBR()).length,
      limite_dia: LIMITE_DIA,
    });
  }

  if (acao === 'ver') {
    const id = String(body.id || '');
    if (!id) return res.status(400).json({ error: 'id_obrigatorio' });
    const r = await fetch(
      `${SU}/rest/v1/bluescore_pedidos?id=eq.${id}&user_id=eq.${userId}&select=*`, { headers: h });
    const pedido = r.ok ? (await r.json())[0] : null;
    if (!pedido) return res.status(404).json({ error: 'nao_encontrado' });
    return res.status(200).json({ ok: true, pedido });
  }

  if (acao === 'salvar') {
    const id = String(body.id || '');
    if (!id) return res.status(400).json({ error: 'id_obrigatorio' });
    const salvo = body.salvo !== false;
    const r = await fetch(`${SU}/rest/v1/bluescore_pedidos?id=eq.${id}&user_id=eq.${userId}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({ salvo }),
    });
    return res.status(200).json({ ok: r.ok, salvo });
  }

  // ── PEDIR: aqui sim cobra plano e cota ──────────────────────────────────
  if (acao !== 'pedir') return res.status(400).json({ error: 'acao_desconhecida' });

  let plano = 'free';
  try {
    // ⚠️ NÃO adicionar campo aqui sem conferir o schema. Coluna inexistente
    // devolve 400, o sub vira null e TODO assinante cai pra free (bug de 06/08
    // no Blublu Suporte). Confirmadas: plan, plan_expires_at, is_manual.
    const s = await fetch(
      `${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=plan,plan_expires_at,is_manual&limit=1`,
      { headers: h, signal: AbortSignal.timeout(8000) });
    const sub = s.ok ? (await s.json())[0] : null;
    if (sub) {
      const manual = sub.is_manual === true;
      const naoVenceu = !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
      plano = (sub.plan && sub.plan !== 'free' && (manual || naoVenceu)) ? sub.plan : 'free';
    }
  } catch (e) {}
  if (!PLANOS_OK.includes(plano)) return res.status(403).json({ error: 'plano_necessario' });

  const url = limpar(body.url, 500);
  if (!url) return res.status(400).json({ error: 'url_obrigatoria' });
  const rede = detectarRede(url);
  if (!rede) return res.status(400).json({ error: 'rede_nao_suportada' });

  // Já tem pedido aberto pro mesmo perfil? Devolve o que existe em vez de
  // criar fila duplicada — protege a cota do usuário e o trabalho do dono.
  try {
    const dupR = await fetch(
      `${SU}/rest/v1/bluescore_pedidos?user_id=eq.${userId}&status=in.(na_fila,em_analise)&perfil_url=eq.${encodeURIComponent(url)}&select=id,status&limit=1`,
      { headers: h });
    const dup = dupR.ok ? (await dupR.json())[0] : null;
    if (dup) return res.status(200).json({ ok: true, id: dup.id, status: dup.status, ja_existia: true });
  } catch (e) {}

  // Cota do dia — contada no servidor, não no navegador.
  try {
    const cR = await fetch(
      `${SU}/rest/v1/bluescore_pedidos?user_id=eq.${userId}&criado_em=gte.${inicioDoDiaBR().toISOString()}&status=neq.recusado&select=id`,
      { headers: h });
    const hoje = cR.ok ? await cR.json() : [];
    if (hoje.length >= LIMITE_DIA) {
      return res.status(429).json({ error: 'limite_diario', limite: LIMITE_DIA, usadas: hoje.length });
    }
  } catch (e) {}

  const insR = await fetch(`${SU}/rest/v1/bluescore_pedidos`, {
    method: 'POST', headers: { ...h, Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: userId, email, nome: nome || null, plano, rede,
      perfil_url: url, perfil_handle: extrairHandle(url, rede), status: 'na_fila',
    }),
  });
  if (!insR.ok) {
    const t = await insR.text().catch(() => '');
    console.error('[bluescore] insert', insR.status, t.slice(0, 200));
    return res.status(500).json({ error: 'falha_ao_registrar' });
  }
  const novo = (await insR.json())[0];

  // Avisa o dono que caiu trabalho na fila. Sem isso ele só descobre abrindo
  // o admin por acaso. Fire-and-forget: a fila não depende do email.
  avisarAdminNovoPedido({ ...novo, nome, email }).catch(() => {});

  return res.status(200).json({ ok: true, id: novo.id, status: novo.status, rede });
};

// ── AVISOS ─────────────────────────────────────────────────────────────────
// blue_notificacoes é a tabela VIVA do sininho (a blue_notifications não
// existe — dead code confirmado). É a mesma caixa do app Blue, então o aviso
// aparece nos dois lugares.
async function avisarSininho(SU, h, userId, notif) {
  if (!userId) return { ok: false };
  try {
    const r = await fetch(`${SU}/rest/v1/blue_notificacoes`, {
      method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId, ...notif }),
      signal: AbortSignal.timeout(8000),
    });
    return { ok: r.ok };
  } catch (e) {
    console.error('[bluescore] sininho', e.message);
    return { ok: false };
  }
}

async function avisarAdminNovoPedido(pedido) {
  const RESEND = process.env.RESEND_API_KEY;
  const PARA = process.env.ADMIN_EMAIL;
  if (!RESEND || !PARA) return;
  const rede = REDES[pedido.rede] || REDES.youtube;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'BlueScore <noreply@bluetubeviral.com>',
      to: [PARA],
      subject: `📊 BlueScore na fila: ${pedido.perfil_handle || pedido.perfil_url}`,
      html: `<div style="font-family:sans-serif;font-size:14px;line-height:1.6">
        <p><strong>${rede.emoji} ${rede.nome}</strong> · ${pedido.perfil_handle || ''}</p>
        <p><a href="${pedido.perfil_url}">${pedido.perfil_url}</a></p>
        <p>Pedido por <strong>${pedido.nome || pedido.email}</strong> (${pedido.plano})</p>
        <p><a href="https://www.bluetubeviral.com/admin">Abrir a fila no admin →</a></p>
      </div>`,
    }),
    signal: AbortSignal.timeout(8000),
  });
}

module.exports.__test = {
  detectarRede, extrairHandle, normalizarLaudo, classificar,
  laudoEstaPronto, inicioDoDiaBR, LIMITE_DIA, PLANOS_OK,
};
