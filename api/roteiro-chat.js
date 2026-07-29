// api/roteiro-chat.js — Blublu, chat de ajuste de roteiro (home)
//
// SEPARADO de propósito:
//  • do /api/rewrite — a GERAÇÃO de roteiro é o funil do tráfego pago. Ela não
//    pode quebrar por causa de mexida no chat. São endpoints independentes.
//  • do /api/blublu-chat — aquele é o Blublu da Virais (analista de virais,
//    Master, busca no banco). Este é editor de roteiro. Mesma personalidade,
//    cérebros diferentes, cotas diferentes, registros diferentes.
//
// F0: portão de sanidade, registro, cota, portão de cadastro.  ✔
// F1: voz do Blublu nas mensagens + ângulo da aba no prompt.    ✔
// F2: memória (histórico das últimas trocas).                   pendente
// F3: discernimento (ordem / pergunta / vago / fora de escopo). pendente
//
// REGRAS DE ACESSO (definidas pelo user em 29/07):
//   sem conta            → 401 needs_account  (front abre popup de cadastro)
//   free com conta       → 5 ajustes por dia
//   full / master        → ilimitado

import { avaliar } from './_helpers/roteiro-sanidade.js';
import { falar, JULGAMENTO, anguloDe } from './_helpers/blublu-roteiro-voz.js';
import { classificar, respostaPronta, montarHistorico } from './_helpers/roteiro-intencao.js';

export const LIMITE_FREE_DIA = 5;
const MAX_ROTEIRO = 5000;
const MAX_INSTRUCAO = 500;

// Lido no momento do uso, não na carga do módulo: capturar env no import
// deixa o endpoint refém da ordem de inicialização e impossível de testar.
const cfg = () => ({
  URL: process.env.SUPABASE_URL,
  SERVICE: process.env.SUPABASE_SERVICE_KEY,
  ANON: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY,
});
const H = () => {
  const { SERVICE } = cfg();
  return { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' };
};

// ── quem é o usuário ────────────────────────────────────────────────────────
async function identificar(token) {
  const { URL: SUPABASE_URL, ANON: ANON_KEY } = cfg();
  if (!token || !SUPABASE_URL) return null;
  try {
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(5000),
    });
    if (!ur.ok) return null;
    const u = await ur.json();
    if (!u?.email) return null;

    const pr = await fetch(
      `${SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(u.email)}&select=plan,plan_expires_at,is_manual`,
      { headers: H(), signal: AbortSignal.timeout(5000) }
    );
    const sub = pr.ok ? (await pr.json())[0] : null;

    let plano = 'free';
    if (sub && (sub.plan === 'full' || sub.plan === 'master')) {
      const vencido = sub.plan_expires_at && new Date(sub.plan_expires_at) < new Date() && !sub.is_manual;
      if (!vencido) plano = sub.plan;
    }
    return { id: u.id, email: u.email, plano };
  } catch { return null; }
}

// ── cota diária (só free) ───────────────────────────────────────────────────
async function usoHoje(userId) {
  const { URL: SUPABASE_URL } = cfg();
  const dia = new Date().toISOString().slice(0, 10);
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/roteiro_chat_usage?user_id=eq.${userId}&dia=eq.${dia}&select=count`,
      { headers: H(), signal: AbortSignal.timeout(4000) }
    );
    if (!r.ok) return 0;
    return (await r.json())[0]?.count || 0;
  } catch { return 0; }   // banco fora do ar não pode travar o usuário
}

async function consumir(userId, usadoAntes) {
  const { URL: SUPABASE_URL } = cfg();
  const dia = new Date().toISOString().slice(0, 10);
  try {
    if (usadoAntes === 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/roteiro_chat_usage`, {
        method: 'POST',
        headers: { ...H(), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: userId, dia, count: 1 }),
      });
    } else {
      await fetch(`${SUPABASE_URL}/rest/v1/roteiro_chat_usage?user_id=eq.${userId}&dia=eq.${dia}`, {
        method: 'PATCH', headers: { ...H(), Prefer: 'return=minimal' },
        body: JSON.stringify({ count: usadoAntes + 1 }),
      });
    }
  } catch {}
}

// ── freio por IP ────────────────────────────────────────────────────────────
// A cota diária protege o free, mas Full e Master são ilimitados — um token
// vazado martelaria o motor de IA sem nenhum freio. Mesmo padrão do
// /api/rewrite. Falha do banco não bloqueia ninguém (fail-open de propósito:
// derrubar usuário legítimo é pior que deixar passar um abuso raro).
const TETO_MINUTO_IP = 20;

async function ipAbusando(ip) {
  const { URL: SUPABASE_URL, SERVICE: SERVICE_KEY } = cfg();
  if (!ip || !SUPABASE_URL || !SERVICE_KEY) return false;
  try {
    const desde = new Date(Date.now() - 60000).toISOString();
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/rate_limits?ip=eq.${encodeURIComponent(ip)}&endpoint=eq.${encodeURIComponent('/api/roteiro-chat')}&window_start=gte.${desde}&select=count`,
      { headers: H(), signal: AbortSignal.timeout(3000) }
    );
    const passou = r.ok ? ((await r.json())?.length || 0) >= TETO_MINUTO_IP : false;
    if (!passou) {
      fetch(`${SUPABASE_URL}/rest/v1/rate_limits`, {
        method: 'POST', headers: { ...H(), Prefer: 'return=minimal' },
        body: JSON.stringify({ ip, endpoint: '/api/roteiro-chat', count: 1, window_start: new Date().toISOString() }),
      }).catch(() => {});
    }
    return passou;
  } catch { return false; }
}

// ── registro (nunca derruba a resposta) ─────────────────────────────────────
function registrar(linha) {
  const { URL: SUPABASE_URL, SERVICE: SERVICE_KEY } = cfg();
  if (!SUPABASE_URL || !SERVICE_KEY) return;
  fetch(`${SUPABASE_URL}/rest/v1/roteiro_chat_log`, {
    method: 'POST', headers: { ...H(), Prefer: 'return=minimal' },
    body: JSON.stringify(linha),
  }).catch(() => {});
}

// ── classificação de erro de infra (o que o Blublu vai falar) ───────────────
export function classificarErro(msg) {
  const m = String(msg || '').toLowerCase();
  if (/401|403|unauthorized|invalid.*api.*key|permission/.test(m)) return 'IA-AUTH';
  if (/quota|credit|billing|insufficient|payment/.test(m))          return 'IA-CREDITO';
  if (/429|rate.?limit|overload|capacity|too many/.test(m))         return 'IA-FILA';
  if (/timeout|abort|etimedout|network|fetch failed/.test(m))       return 'IA-TIMEOUT';
  return 'GERAL';
}
// O que ele fala em cada erro mora em blublu-roteiro-voz.js (falar()).

// ── prompt de ajuste ───────────────────────────────────────────────────────
export function montarPrompt({ roteiro, instrucao, lang, versao, historico }) {
  // ⚠ A VOZ do Blublu NÃO entra aqui de propósito. Se entrasse, ele escreveria
  // o roteiro do usuário falando "cara", soltando palavrão e quebrando a
  // quarta parede — corrompendo o trabalho dele. O que entra é o JULGAMENTO
  // editorial. A voz mora só nas mensagens do chat.
  const system = `Você é um editor de roteiros experiente. Sua ÚNICA tarefa é aplicar a instrução do usuário no roteiro existente, com o mínimo de mudanças possível.

${JULGAMENTO}

${anguloDe(versao)}

REGRAS ABSOLUTAS:
1. NÃO reescreva o roteiro do zero
2. Mantenha as mesmas palavras, ritmo e estrutura que já existem
3. Mude APENAS o que o usuário pediu
4. NÃO adicione conteúdo que o usuário não pediu
5. NÃO remova fatos, nomes ou números que o usuário não pediu pra remover
6. NUNCA escreva a instrução do usuário dentro do roteiro — você APLICA a instrução, não a narra
7. NÃO responda conversando ("Aqui está...", "Claro!") — devolva SÓ o roteiro
8. IDIOMA DE SAÍDA: ${lang}
9. Retorne APENAS o texto final do roteiro, sem comentários, prefixos ou markdown

Pense em "diff mínimo": a menor mudança possível que satisfaz a instrução.`;

  const user = `${montarHistorico(historico)}ROTEIRO ATUAL:
"""
${roteiro.slice(0, 3000)}
"""

INSTRUÇÃO DO USUÁRIO:
"""
${instrucao.slice(0, MAX_INSTRUCAO)}
"""

Aplique a instrução no ROTEIRO ATUAL fazendo o MÍNIMO de mudanças. Retorne apenas o roteiro ajustado completo, em ${lang}.`;

  return { system, user };
}

// ── prompt de PERGUNTA (F3) ────────────────────────────────────────────────
// Aqui ele RESPONDE e não encosta no roteiro. É a única saída em que a voz do
// Blublu pode aparecer, porque o destino é a bolha do chat, não o roteiro.
export function montarPromptPergunta({ roteiro, pergunta, historico }) {
  const system = `Você é o Blublu, do BlueTube. Dissecou dezenas de milhares de Shorts virais e é direto ao ponto — nada de "Claro! Ficarei feliz em ajudar".

${JULGAMENTO}

O usuário fez uma PERGUNTA sobre o roteiro dele. Responda a pergunta.

REGRAS:
- NÃO reescreva o roteiro. Ele não pediu ajuste, pediu opinião.
- Seja específico DESTE roteiro: cite o trecho, a palavra, o número. Nada que serviria pra qualquer vídeo.
- No máximo 3 frases. Curto e útil.
- Se ele deveria mudar algo, diga o quê — e ofereça: ele pede e você aplica.
- Proibido: "engajamento", "métricas", "otimização", "performance", "agregar valor", frase de coach motivacional.
- Sem markdown, sem lista, sem título. Texto corrido.`;

  const user = `${montarHistorico(historico)}ROTEIRO DELE:
"""
${roteiro.slice(0, 3000)}
"""

PERGUNTA:
"""
${pergunta.slice(0, MAX_INSTRUCAO)}
"""

Responda em no máximo 3 frases, falando deste roteiro especificamente.`;

  return { system, user };
}

// ════════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const t0 = Date.now();
  const { token, transcript, instruction, version, lang, historico } = req.body || {};
  const roteiro = String(transcript || '').trim();
  const instrucao = String(instruction || '').trim();
  const idioma = String(lang || 'Português (Brasil)');
  const versao = ['V1', 'V2', 'V3'].includes(version) ? version : 'V1';

  // ── validação de entrada ──────────────────────────────────────────────────
  if (!roteiro) {
    return res.status(400).json({ error: 'sem_roteiro', mensagem: 'Não achei o roteiro na tela. Recarrega a página e tenta de novo.' });
  }
  if (roteiro.length > MAX_ROTEIRO) {
    return res.status(400).json({ error: 'roteiro_grande', mensagem: 'Esse roteiro é grande demais pra eu ajustar de uma vez.' });
  }
  if (!instrucao) {
    return res.status(400).json({ error: 'sem_instrucao', mensagem: 'Me diz o que você quer mudar.' });
  }

  // ── PORTÃO 0: freio por IP ────────────────────────────────────────────────
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (await ipAbusando(ip)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      error: 'rate_limit', mensagem: 'Calma aí que eu não sou máquina de lavar. Espera um minuto.',
    });
  }

  // ── PORTÃO 1: precisa de conta ────────────────────────────────────────────
  const user = await identificar(token);
  if (!user) {
    return res.status(401).json({
      error: 'needs_account',
      needs_account: true,
      limite_free: LIMITE_FREE_DIA,
      mensagem: `Cria tua conta pra falar comigo. No plano grátis são ${LIMITE_FREE_DIA} ajustes por dia — no Full e no Master, à vontade.`,
    });
  }

  // ── PORTÃO 2: cota diária do free ─────────────────────────────────────────
  const ilimitado = user.plano === 'full' || user.plano === 'master';
  let usado = 0;
  if (!ilimitado) {
    usado = await usoHoje(user.id);
    if (usado >= LIMITE_FREE_DIA) {
      return res.status(429).json({
        error: 'limit_reached',
        limit_reached: true,
        plano: user.plano,
        usado,
        limite: LIMITE_FREE_DIA,
        mensagem: `Você usou seus ${LIMITE_FREE_DIA} ajustes de hoje. No Full e no Master eu fico à disposição sem limite.`,
      });
    }
  }

  const giro = instrucao.length + roteiro.length;
  const intencao = classificar(instrucao);
  const base = { user_id: user.id, email: user.email, plano: user.plano, versao, idioma, instrucao, roteiro_antes: roteiro, intencao };

  // ── DISCERNIMENTO (F3): saber quando NÃO agir ─────────────────────────────
  // 'vago' e 'fora_escopo' são resolvidos aqui, SEM gastar chamada de IA e sem
  // consumir ajuste do usuário. Antes, os dois viravam reescrita — e o
  // fora_escopo chegava a colar a frase do usuário dentro do roteiro.
  const pronta = respostaPronta(intencao, giro);
  if (pronta) {
    registrar({ ...base, mudou: false, latencia_ms: Date.now() - t0 });
    return res.status(200).json({
      ok: true, aplicado: false, intencao,
      mensagem: pronta,
      texto: roteiro,
      restantes: ilimitado ? null : LIMITE_FREE_DIA - usado,
    });
  }

  const carregarIA = async () => {
    const aiMod = await import('./_helpers/ai.js');
    const callAI = aiMod.callAI || aiMod.default?.callAI;
    if (typeof callAI !== 'function') throw new Error('callAI não exportado do helper');
    return callAI;
  };

  // ── PERGUNTA (F3): ele responde e NÃO encosta no roteiro ──────────────────
  if (intencao === 'pergunta') {
    try {
      const callAI = await carregarIA();
      const { system, user: up } = montarPromptPergunta({ roteiro, pergunta: instrucao, historico });
      const r = await callAI(up, system, 400);
      const resposta = String(r?.result || '').replace(/\s+/g, ' ').trim();
      if (!resposta) throw new Error('resposta vazia');
      // gastou IA, então conta como uso — mas o roteiro fica intocado
      if (!ilimitado) await consumir(user.id, usado);
      registrar({ ...base, roteiro_depois: null, mudou: false, latencia_ms: Date.now() - t0 });
      return res.status(200).json({
        ok: true, aplicado: false, intencao: 'pergunta',
        mensagem: resposta.slice(0, 700),
        texto: roteiro,
        restantes: ilimitado ? null : LIMITE_FREE_DIA - usado - 1,
      });
    } catch (e) {
      const cod = classificarErro(e?.message);
      registrar({ ...base, erro: cod + ': ' + String(e?.message || '').slice(0, 300), mudou: false, latencia_ms: Date.now() - t0 });
      return res.status(200).json({ ok: false, aplicado: false, codigo: cod, mensagem: falar(cod, giro), texto: roteiro });
    }
  }

  // ── ORDEM DE EDIÇÃO ───────────────────────────────────────────────────────
  let cru = '';
  try {
    const callAI = await carregarIA();
    const { system, user: up } = montarPrompt({ roteiro, instrucao, lang: idioma, versao, historico });
    const r = await callAI(up, system, 900);
    cru = String(r?.result || '').trim();
  } catch (e) {
    const cod = classificarErro(e?.message);
    registrar({ ...base, erro: cod + ': ' + String(e?.message || '').slice(0, 300), latencia_ms: Date.now() - t0, mudou: false });
    return res.status(200).json({
      ok: false, aplicado: false, codigo: cod,
      mensagem: falar(cod, giro),
      texto: roteiro,   // devolve o original — o front nunca fica sem roteiro
    });
  }

  // ── PORTÃO 3: sanidade ────────────────────────────────────────────────────
  const v = avaliar(roteiro, cru, instrucao);

  if (!v.ok) {
    registrar({ ...base, roteiro_depois: cru.slice(0, 4000), recusado_por: v.motivo, mudou: false, latencia_ms: Date.now() - t0 });
    return res.status(200).json({
      ok: false, aplicado: false, motivo: v.motivo,
      mensagem: falar(v.motivo, giro),
      texto: roteiro,   // roteiro do usuário preservado
      restantes: ilimitado ? null : LIMITE_FREE_DIA - usado,
    });
  }

  if (!v.mudou) {
    registrar({ ...base, roteiro_depois: v.texto, mudou: false, latencia_ms: Date.now() - t0 });
    return res.status(200).json({
      ok: true, aplicado: false, motivo: 'sem_mudanca',
      mensagem: falar('sem_mudanca', giro),
      texto: roteiro,
      restantes: ilimitado ? null : LIMITE_FREE_DIA - usado,
    });
  }

  // ── sucesso: só AQUI a cota é consumida ───────────────────────────────────
  // Falha de IA ou reprovação do portão não podem queimar ajuste do usuário.
  if (!ilimitado) await consumir(user.id, usado);
  registrar({ ...base, roteiro_depois: v.texto, mudou: true, latencia_ms: Date.now() - t0 });

  return res.status(200).json({
    ok: true, aplicado: true,
    texto: v.texto,
    mensagem: falar('aplicado', giro),
    restantes: ilimitado ? null : LIMITE_FREE_DIA - usado - 1,
    ilimitado,
  });
}
