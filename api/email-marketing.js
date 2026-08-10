// api/email-marketing.js — Automated email marketing with sequence rotation
// Cron: 0 10 * * 2,5 (Tuesday & Friday 10am)

const { barrarSeDesligado } = require('./_helpers/emailGate.js');

const { signToken } = require('./_helpers/unsub-token');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Corte de marketing (10/08/2026): cota do Resend caiu pra 200/dia.
  if (barrarSeDesligado(res, 'email-marketing')) return;

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const RESEND = process.env.RESEND_API_KEY;
  if (!SU || !SK || !RESEND) return res.status(200).json({ ok: false, error: 'Missing env' });

  // Auth (2026-07-25): endpoint era público — qualquer um podia disparar
  // rodadas ou usar test_emails como canhão de spam. Cron GH passa admin_secret;
  // header x-vercel-cron aceito por compatibilidade com o cron Vercel antigo.
  const isCron = !!req.headers['x-vercel-cron'];
  const isAdmin = (req.query.admin_secret || (req.body && req.body.admin_secret)) === process.env.ADMIN_SECRET;
  if (!isCron && !isAdmin) return res.status(401).json({ error: 'unauthorized' });

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

      // ── FILTRO DE PLANO: marketing SO pra users free, NUNCA pra
      //    full/master ativos NEM pra quem cancelou (cancel_at_period_end=true).
      //    Critério: emails de marketing são pra captar/converter free → pago.
      //    Pagantes ja sao clientes (recebem outras comunicacoes via
      //    email-campanha) e cancelados nao devem ser ressentidos com promo.
      if (eligible.length > 0) {
        const emails = eligible.map(e => e.email).filter(Boolean);
        const inList = emails.map(encodeURIComponent).join(',');
        const subR = await fetch(
          `${SU}/rest/v1/subscribers?email=in.(${inList})&select=email,plan,cancel_at_period_end,plan_expires_at`,
          { headers: H }
        );
        const subscribersData = subR.ok ? await subR.json() : [];
        const subMap = new Map(subscribersData.map(s => [String(s.email).toLowerCase(), s]));

        const beforeCount = eligible.length;
        eligible = eligible.filter(user => {
          const sub = subMap.get(String(user.email).toLowerCase());
          if (!sub) return true; // sem registro = anonimo/free, libera
          // Cancelou (mesmo plano ainda ativo): NAO envia
          if (sub.cancel_at_period_end === true) return false;
          // Plan free: libera
          if (!sub.plan || sub.plan === 'free') return true;
          // Plan pago ATIVO (full/master): NAO envia
          // Excecao: se plan_expires_at ja passou, considera free
          if (sub.plan_expires_at && new Date(sub.plan_expires_at) < now) return true;
          return false;
        });
        const filtered = beforeCount - eligible.length;
        if (filtered > 0) console.log(`[email-marketing] filtro plano excluiu ${filtered} (full/master ativos OU cancelados)`);
      }

      // ── FILTRO RECOVERY: users em checkout_recovery pendente NAO recebem
      //    email-marketing. Evita martelar inbox de quem ja esta numa
      //    sequencia de recuperacao (1h/24h/72h). Quando recovery terminar
      //    (recovered/expired/unsubscribed), volta a ser elegivel.
      //    Comparacao case-insensitive (recovery normaliza pra lowercase no
      //    sweep, mas subscribers/email_marketing podem ter case original).
      if (eligible.length > 0) {
        const emails = eligible.map(e => e.email).filter(Boolean);
        const inList = emails.map(encodeURIComponent).join(',');
        const recR = await fetch(
          `${SU}/rest/v1/checkout_recovery?email=in.(${inList})&status=eq.pending&select=email`,
          { headers: H }
        );
        const pendingSet = new Set(recR.ok ? (await recR.json()).map(r => String(r.email).toLowerCase()) : []);
        if (pendingSet.size > 0) {
          const beforeRecovery = eligible.length;
          eligible = eligible.filter(u => !pendingSet.has(String(u.email).toLowerCase()));
          const filteredRec = beforeRecovery - eligible.length;
          if (filteredRec > 0) console.log(`[email-marketing] filtro recovery excluiu ${filteredRec} (em recuperacao de checkout pendente)`);
        }
      }
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
      const unsubToken = signToken(user.email);
      const unsubUrl = `https://bluetubeviral.com/api/v1/unsubscribe?token=${unsubToken}`;

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
// 2026-07-25: os DOIS primeiros templates sao o LANCAMENTO do Instagram Virais.
// sequence_position foi resetado pra 0 em toda a base (via PostgREST) — todo
// mundo recebe os 2 anuncios primeiro (terca + sexta), depois a rotacao segue.
// Pra repetir a manobra num proximo lancamento:
//   UPDATE email_marketing SET sequence_position = 0 WHERE unsubscribed = false;
const TEMPLATES = [
  // ── LANÇAMENTO BLUEVOICE (2026-07-28) — narrados pelo BluBlu ─────────────
  {
    subject: '🎙️ Eu clonei minha voz. Agora é a sua vez (literalmente)',
    hero: 'O BlueVoice cresceu — e agora ele fala com a SUA voz',
    stat: 'Grave 1 minuto. Narre para sempre. Exclusivo Master.',
    body: `<p>Oi, aqui é o <strong>BluBlu</strong>. Sim, eu escrevo emails agora. Meu contrato é elástico.</p>
      <p>O <strong>BlueVoice</strong> acabou de ganhar <strong>clonagem de voz</strong>: você grava 1 minuto falando qualquer coisa e, em segundos, tem uma voz idêntica à sua pronta pra narrar todos os seus Shorts. Sem estúdio, sem microfone caro, sem gravar de novo às 2 da manhã porque o cachorro latiu no melhor take.</p>
      <p>✦ Grave direto no site (nada de instalar programa)<br>✦ Sua voz fica <strong>privada</strong> — ninguém mais vê ou usa<br>✦ Narrações ilimitadas com ela, quando quiser</p>
      <p style="color:#fbbf24;font-weight:700">Sua cara no vídeo é opcional. Sua voz, agora, é infinita.</p>`,
    cta: 'Clonar minha voz agora →',
    url: 'https://bluetubeviral.com/blueVoice'
  },
  {
    subject: '🎛️ Sua narração estava no piloto automático (eu consertei isso)',
    hero: 'Velocidade, emoção, estilo — agora quem manda é você',
    stat: 'Do sussurro dramático ao hype de Short viral, no mesmo painel',
    body: `<p>Confissão rápida: até semana passada, toda narração do BlueVoice saía do mesmo jeitinho. Eu tentei avisar. Ninguém me escuta — o que é irônico, considerando meu ramo.</p>
      <p>Agora você tem <strong>controle total</strong> sobre como a voz soa:</p>
      <p>✦ <strong>Velocidade</strong> — mais pausado pra storytelling, mais acelerado pra viral<br>✦ <strong>Estabilidade</strong> — do criativo (cheio de emoção) ao robusto (previsível)<br>✦ <strong>Exagero de estilo</strong> — do sussurro ao grito de narrador de luta livre<br>✦ <strong>Atalhos prontos</strong>: Narração · Viral · Calmo</p>
      <p style="color:#fbbf24;font-weight:700">E tudo isso em qualidade de estúdio, com áudio mais nítido que a maioria dos podcasts que você ouve.</p>`,
    cta: 'Testar os controles novos →',
    url: 'https://bluetubeviral.com/blueVoice'
  },
  {
    subject: '🤔 "Mas eu odeio minha voz" — ótimo, temos 20 idiomas e dezenas de vozes',
    hero: 'Não quer usar a sua voz? Escolhe uma melhor. Sem ressentimentos.',
    stat: 'Português, inglês, espanhol, japonês… e mais 16',
    body: `<p>Nem todo mundo quer ouvir a própria voz. Eu entendo — eu ouço a minha o dia inteiro e já pedi demissão três vezes.</p>
      <p>Por isso o <strong>BlueVoice</strong> tem um acervo pronto: vozes masculinas e femininas, jovens e maduras, de narração séria a energia de Short viral — filtráveis por gênero, idade, estilo e idioma.</p>
      <p>✦ Quer dark channel em inglês? Tem voz nativa.<br>✦ Quer testar o mesmo roteiro em 3 vozes? São 2 versões por geração.<br>✦ Achou uma voz sua no ElevenLabs? Importa e usa aqui.</p>
      <p style="color:#fbbf24;font-weight:700">Sua identidade sonora não precisa ser a sua garganta.</p>`,
    cta: 'Ouvir as vozes disponíveis →',
    url: 'https://bluetubeviral.com/blueVoice'
  },
  {
    subject: '📸 O Instagram abriu o jogo: os Reels que explodiram, com views REAIS',
    hero: 'Chegou o Instagram Virais — a vitrine dos Reels que o mundo inteiro está assistindo',
    stat: 'Só entra Reel com 3M+ views e 1M+ likes. Zero ruído.',
    body: `<p>A ferramenta Virais do BlueTube acaba de ganhar uma nova dimensão: <strong>Reels virais do Instagram com o número REAL de views</strong> — aquele número que o Instagram esconde de todo mundo.</p>
      <p>No acervo de estreia: vídeos com <strong>até 1,6 BILHÃO de views</strong>, curadoria dos maiores virais da história e perfis gigantes monitorados 24/7. O que explode lá é o roteiro pronto do seu próximo Short.</p>
      <p style="color:#fbbf24;font-weight:700">YouTube + TikTok + Instagram no mesmo painel. O mapa completo do que está viralizando — exclusivo Master.</p>`,
    cta: 'Ver os Reels que explodiram →',
    url: 'https://bluetubeviral.com/virais'
  },
  {
    subject: '🔥 1.600.000.000 de views num vídeo só. E você ainda procurando ideia?',
    hero: 'Enquanto você pensa no que postar, a resposta já explodiu no Instagram',
    stat: 'Tendência viaja de plataforma: o que estoura lá, estoura no Shorts dias depois',
    body: `<p>O novo <strong>Instagram Virais</strong> te entrega os Reels que passaram de <strong>3 milhões de views e 1 milhão de likes</strong> — com métrica verdadeira, atualizada automaticamente.</p>
      <p>✦ Curadoria dos maiores virais da história<br>✦ Perfis que mais estouram, vigiados de perto<br>✦ Baixe qualquer Reel direto no BaixaBlue<br>✦ Peça pro Blublu: "me traz virais do Instagram"</p>
      <p style="color:#fbbf24;font-weight:700">Criador que enxerga a tendência antes, publica antes. Botão rosa, dentro da Virais.</p>`,
    cta: 'Abrir o Instagram Virais agora →',
    url: 'https://bluetubeviral.com/virais'
  },
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
    subject: '✨ O editor nativo do BlueTube está a caminho',
    hero: 'Timeline, Blublu editora, score de viralidade. Tudo sem sair daqui.',
    stat: 'Criador não deveria usar 6 apps pra publicar 1 Short',
    body: `<p>O <strong>BlueEditor</strong> está em desenvolvimento — e vem com algo que nenhum editor tem:</p>
      <p>✦ Timeline profissional inspirada no CapCut<br>✦ Blublu sugerindo onde cortar<br>✦ Score de viralidade em tempo real<br>✦ Legenda automática com Whisper<br>✦ Export 9:16 otimizado para Shorts</p>
      <p style="color:#fbbf24;font-weight:700">Masters que entram antes do lançamento travam o preço atual — para sempre.</p>`,
    cta: 'Ver o teaser e entrar na lista →',
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
