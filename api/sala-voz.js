// api/sala-voz.js — Sala de voz ao vivo da Comunidade (SÓ ÁUDIO, P2P mesh)
//
// O que este endpoint NÃO faz: sinalização. Offer/answer/ICE trafegam por canal
// Realtime broadcast, aparelho↔aparelho, exatamente como já acontece nas
// chamadas 1:1 do app (bluetube-app/src/screens/CallScreen.js) — padrão já
// validado em produção. Aqui não tem banco, não tem tabela, não tem estado:
// quem está na sala é a PRESENCE do Realtime, que morre junto com o socket.
// Sala vazia = zero linhas em qualquer lugar. Foi de propósito: o campo
// `participantes jsonb` do blue_calls está lá desde 2026-07 e nunca ninguém
// leu — tabela que ninguém consulta é dívida, não é feature.
//
// O que este endpoint FAZ, e é o motivo dele existir:
//
//   1) config    → portão de plano no BACKEND. Só Full/Master (ou moderador,
//                  igual api/community.js:75) recebe a URL/anon key do Supabase,
//                  o nome do canal e um TICKET assinado.
//   2) verificar → resolve tickets alheios. Antes de abrir a conexão de áudio
//                  com alguém, o navegador manda o ticket daquela pessoa pra cá
//                  e só conecta se a assinatura bater.
//
// Por que ticket assinado e não só "confia no canal": canal broadcast é aberto.
// Quem tiver a anon key (que é pública por design) e adivinhar o nome do canal
// consegue assinar o canal e forjar payload — foi exatamente o bug que fez um
// aparelho tocar 45s com call_id inventado (CallScreen.js:284-295). A defesa lá
// foi validar no servidor antes de confiar; aqui é a mesma: ninguém entra no
// mesh sem ticket que o servidor assinou, e o nome/foto exibidos vêm da
// resposta DAQUI, nunca do que o outro navegador mandou. Um intruso sem plano
// no máximo vê tickets opacos passando; áudio ele não recebe de ninguém,
// porque nenhum peer honesto abre RTCPeerConnection com ticket inválido.
//
// Alternativa considerada e descartada: canal PRIVADO do Realtime com policy
// em realtime.messages. É mais elegante, mas exige rodar SQL numa tabela de
// sistema e, se a policy sair errada, a sala falha em silêncio pro dono. Esta
// versão sobe com deploy puro, sem nenhum SQL. Se um dia quisermos o canal
// privado, ele SOMA com isto aqui, não substitui.

const crypto = require('node:crypto');

// ── constantes ──────────────────────────────────────────────────────────────
// ATENÇÃO: MAX_PESSOAS é ESPELHO de MAX em public/sala-voz.js. Mudou aqui,
// muda lá. O front usa o valor que vem daqui (config.max), então o servidor
// manda; a constante do front é só fallback se a config falhar.
const MAX_PESSOAS = 10;
// Mesh P2P: cada pessoa mantém (N-1) conexões. Com 10 são 9 uploads de áudio
// por aparelho (~9 × 24kbps ≈ 216kbps) — celular aguenta. Acima disso precisa
// de SFU, não adianta só subir o número.
const CANAL = 'sala-voz-comunidade-v1';
// 12h: alguém pendurado na sala mais que isso é zumbi de qualquer jeito. Curto
// demais faria o ticket vencer com a pessoa ainda falando (os peers que
// chegassem depois recusariam ela).
const TICKET_TTL_MS = 12 * 60 * 60 * 1000;

// Chave do HMAC: nunca sai do servidor. Usa a service key como padrão pra não
// exigir env nova — se um dia quiser rotacionar sem mexer no Supabase, basta
// definir SALA_VOZ_SECRET.
function segredo() {
  return process.env.SALA_VOZ_SECRET || process.env.SUPABASE_SERVICE_KEY || '';
}

const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const assinar = (corpo) => b64u(crypto.createHmac('sha256', segredo()).update(corpo).digest());

function emitirTicket(p) {
  const corpo = b64u(JSON.stringify(p));
  return corpo + '.' + assinar(corpo);
}

// Retorna o payload só se a assinatura bater E não estiver vencido.
function lerTicket(t) {
  if (typeof t !== 'string' || t.length < 10 || t.length > 1200) return null;
  const p = t.split('.');
  if (p.length !== 2 || !p[0] || !p[1]) return null;
  const esperado = assinar(p[0]);
  // timingSafeEqual explode se os tamanhos diferem — compara antes.
  if (p[1].length !== esperado.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(p[1]), Buffer.from(esperado))) return null;
  } catch (e) { return null; }
  let d;
  try { d = JSON.parse(deB64u(p[0]).toString('utf8')); } catch (e) { return null; }
  if (!d || typeof d !== 'object' || !d.x || Date.now() > d.x) return null;
  return d;
}

// Nome/foto que saem daqui já vão limpos: quem consome escapa de novo no HTML,
// mas tag nenhuma deveria chegar até lá pra começo de conversa.
const limpar = (s, max) => String(s == null ? '' : s)
  .replace(/<[^>]*>/g, '')
  .replace(/[\u0000-\u001f\u007f]/g, '')   // tira caractere de controle: nome e uma linha so
  .trim().slice(0, max);
const fotoOk = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u) && u.length < 500) ? u : null;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || '';
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  if (!segredo()) return res.status(500).json({ error: 'Config missing' });

  const H = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };
  const q = req.query || {};
  const b = req.body || {};
  const action = q.action || b.action;
  const token = q.token || b.token;

  // ── PORTÃO: mesmo de api/community.js (login + Full/Master, mod entra sem) ──
  let userId = null, userEmail = null, paying = false, planName = null;
  if (token) {
    try {
      const ur = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK || SK, Authorization: 'Bearer ' + token } });
      if (ur.ok) {
        const u = await ur.json();
        userId = u.id; userEmail = u.email;
        const pr = await fetch(`${SU}/rest/v1/subscribers?email=eq.${encodeURIComponent(userEmail)}&select=plan,plan_expires_at,is_manual`, { headers: H });
        if (pr.ok) {
          const sub = (await pr.json())[0];
          if (sub && ['full', 'master'].includes(sub.plan)) {
            const valido = sub.is_manual || !sub.plan_expires_at || new Date(sub.plan_expires_at) > new Date();
            if (valido) { paying = true; planName = sub.plan; }
          }
        }
      }
    } catch (e) {}
  }
  if (!userId) return res.status(401).json({ error: 'Login necessário.', login: true });

  // Perfil da comunidade: aqui só LÊ. Quem cria é o api/community.js quando a
  // pessoa abre a Comunidade — e ela precisa abrir a Comunidade pra ver a sala.
  let profile = null;
  try {
    const pf = await fetch(`${SU}/rest/v1/community_profiles?user_id=eq.${userId}&select=display_name,avatar_url,is_moderator,banned,plan`, { headers: H });
    if (pf.ok) profile = (await pf.json())[0] || null;
  } catch (e) {}

  const isMod = !!(profile && profile.is_moderator);
  // Moderador entra sem plano — se esquecer isto, a moderação fica trancada
  // pra fora da própria sala (mesma regra de api/community.js:75).
  if (!paying && !isMod) return res.status(403).json({ error: 'A sala de voz é exclusiva de assinantes Full e Master.', upgrade: true });
  if (profile && profile.banned && !isMod) return res.status(403).json({ error: 'Você foi banido da Comunidade.', banned: true });

  const nome = limpar((profile && profile.display_name) || (userEmail || 'criador').split('@')[0], 32) || 'criador';
  const foto = fotoOk(profile && profile.avatar_url);

  try {
    // ── CONFIG: credenciais + ticket. Sem passar por aqui não existe sala. ──
    if (action === 'config') {
      // UM instante só pros dois campos: se `x` e `expira_em` são calculados
      // em chamadas diferentes de Date.now(), o front acha que ainda tem
      // ticket e o servidor já recusa. Aqui a diferença é de milissegundos,
      // mas é o tipo de fresta que vira "fantasma" na renovação.
      const expiraEm = Date.now() + TICKET_TTL_MS;
      const ticket = emitirTicket({
        u: userId,
        n: nome,
        a: foto || '',
        p: isMod ? 'mod' : (planName || 'full'),
        x: expiraEm,
      });
      return res.status(200).json({
        ok: true,
        supabase_url: SU,
        anon_key: AK,
        canal: CANAL,
        max: MAX_PESSOAS,
        ticket,
        // expira_em vai explícito pro front saber renovar antes de vencer
        expira_em: expiraEm,
        me: { id: userId, nome, avatar: foto, plano: planName, mod: isMod },
      });
    }

    // ── VERIFICAR: quem é o dono destes tickets? ────────────────────────────
    // Em lote de propósito: numa sala de 10, cada entrada resolveria 9 tickets.
    // Uma chamada por sincronização em vez de nove.
    if (action === 'verificar') {
      const lista = Array.isArray(b.tickets) ? b.tickets.slice(0, MAX_PESSOAS + 4) : [];
      const pessoas = {};
      // `invalidos` é explícito de propósito: antes o front tinha que DEDUZIR
      // a recusa pela ausência na resposta, e ausência também é o que acontece
      // quando a chamada falha pela metade. Sem o sinal claro, o participante
      // de ticket vencido virava um card mudo e sem marcação nenhuma.
      const invalidos = [];
      for (const t of lista) {
        const d = lerTicket(t);
        if (!d) { invalidos.push(t); continue; }  // assinatura ruim ou vencido
        pessoas[t] = {
          id: String(d.u || ''),
          nome: limpar(d.n, 32) || 'criador',
          avatar: fotoOk(d.a),
          plano: d.p === 'mod' ? 'mod' : (d.p === 'master' ? 'master' : 'full'),
        };
      }
      return res.status(200).json({ ok: true, pessoas, invalidos, max: MAX_PESSOAS });
    }

    return res.status(400).json({ error: 'Ação inválida.' });
  } catch (e) {
    return res.status(500).json({ error: 'Falha na sala de voz.', detail: String((e && e.message) || e).slice(0, 200) });
  }
};
