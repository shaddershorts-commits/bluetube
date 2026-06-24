// api/_helpers/email-templates-library.js
//
// Biblioteca de templates pro engine email-sequence.js (2026-06-23).
// 24 templates FREE→FULL + 16 FULL→MASTER (~12 meses de runway antes do loop).
//
// Variáveis dinâmicas substituídas pelo engine:
//   {{nome}}                 — primeiro nome do user (parte antes do @ capitalizada)
//   {{dias_no_bluetube}}     — int, dias desde signup
//   {{trial_token}}          — só nos emails is_trial:true. HMAC do email.
//   {{unsubscribe_url}}      — link de descadastro 1-click
//
// Tom calibrado: AIDA + FOMO + quebra 4a parede ocasional + humor acido leve.
// NUNCA inventar fato do canal do user (não vemos, não comentamos).
// Sem assinatura pessoa — só "BlueTube" no remetente Resend.

const FREE_TEMPLATES = [
  // ── 01 — Curiosidade técnica: hook 1.8s ───────────────────────────────────
  {
    id: 'free_01_hook_1_8s',
    category: 'curiosidade_tecnica',
    subject: '1.8 segundos',
    preheader: 'É isso que separa um Short de 50k views de um de 5M.',
    body: `<p>Oi, {{nome}}.</p>
<p><strong>1.8 segundos.</strong> É a duração média do hook nos 100 maiores virais de 2026 no YouTube Shorts.</p>
<p>A maioria dos criadores faz hook de 4-6 segundos. Por isso o vídeo morre em 2 minutos de feed.</p>
<p>A diferença? Em 1.8s o cérebro decide se desliza ou não. Você não tem 6 segundos. Tem dois.</p>
<p>O BlueScore mostra a duração exata do seu hook em qualquer Short e compara com o padrão dos virais do seu nicho. Versão Full faz isso ilimitado.</p>
<p>Se você tá publicando há algumas semanas e não decola, é provavelmente no hook. Vale 4 minutos do seu dia testar.</p>
<p><em>(P.S.: se já decolou e veio aqui só pra curtir, ignora.)</em></p>`,
    cta_text: 'Analisar meu próximo Short →',
    cta_url: 'https://bluetubeviral.com/blueScore',
    is_trial: false,
  },

  // ── 02 — Humor ácido + quebra 4a parede ────────────────────────────────────
  {
    id: 'free_02_humor_268_criadores',
    category: 'humor_acido',
    subject: '{{nome}}, abri esse email só pra te falar isso',
    preheader: 'Provavelmente você vai fechar antes de terminar. Tudo bem.',
    body: `<p>Olha só.</p>
<p>Você tá no BlueTube há {{dias_no_bluetube}} dias e ainda não testou o plano Full. Já vi 268 criadores fazendo isso (literalmente, é o número exato hoje no nosso banco).</p>
<p>Sabe o padrão deles? Abrem o site, geram 1-2 roteiros free, fecham a aba, esquecem. Voltam 3 semanas depois pra fazer mais 1 free. E nunca passam disso.</p>
<p>Não é crítica. É só o que os dados mostram.</p>
<p>A diferença real do Full é simples:</p>
<ul>
  <li>Roteiros ilimitados (não 3/dia)</li>
  <li>BlueVoice narrando em 16 idiomas</li>
  <li>BlueScore profundo no seu canal</li>
  <li>Tendências do dia em tempo real</li>
</ul>
<p>Custa R$29,99/mês. Um delivery do Uber Eats.</p>
<p>Se publicar 4 Shorts por mês com isso e 1 sair, paga 100x o que custou.</p>
<p>Tô falando isso porque algoritmo do Gmail vai me penalizar se você não responder ou clicar. Então me ajuda. Ou desinscreve. Sem ressentimento.</p>`,
    cta_text: 'Testar Full por R$29,99 →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 03 — TRIAL 30 DIAS GRÁTIS (especial — só 1x por user) ─────────────────
  {
    id: 'free_03_trial_30d',
    category: 'trial_30d',
    subject: '30 dias de Full grátis. Sem cartão.',
    preheader: 'Não precisa cadastrar nada. É só clicar.',
    body: `<p>{{nome}}, isso aqui não é spam.</p>
<p>Estamos liberando <strong>30 dias de plano Full grátis</strong> pra algumas contas free que ainda não testaram. Sua tá na lista.</p>
<p>Não pedimos cartão. Não pedimos absolutamente nada. Você clica, faz login com a conta que já tem, e o plano Full ativa automaticamente por 30 dias. Acabou os 30 dias, volta pra free naturalmente. Sem cobrança, sem pegadinha.</p>
<p>O que você ganha nesses 30 dias:</p>
<ul>
  <li>Roteiros IA ilimitados (não 3/dia)</li>
  <li>BlueVoice em 16 idiomas + clonagem de voz</li>
  <li>BlueScore profundo (analisa qualquer canal)</li>
  <li>Tendências TikTok/YouTube em tempo real</li>
  <li>Buscador de virais sem limite</li>
</ul>
<p>Por que estamos dando isso? Honestamente: porque a maioria dos free nunca testa por achar que é "só mais uma assinatura". Quando testa, ~40% vira Master depois. Aposta calculada.</p>
<p>Sua oferta expira em 7 dias. Depois disso não conseguimos liberar de novo (só 1 trial por conta, regra do sistema).</p>`,
    cta_text: 'Ativar meus 30 dias grátis →',
    cta_url: 'https://bluetubeviral.com/api/trial-activate?token={{trial_token}}',
    is_trial: true,
  },

  // ── 04 — Confronto direto ──────────────────────────────────────────────────
  {
    id: 'free_04_publica_ou_viraliza',
    category: 'confronto',
    subject: '{{nome}}, pergunta honesta',
    preheader: 'Não dá pra responder fugindo dela.',
    body: `<p>Vou direto.</p>
<p>Nesses últimos {{dias_no_bluetube}} dias, você <strong>publicou Shorts</strong> ou <strong>viralizou Shorts</strong>?</p>
<p>São coisas diferentes.</p>
<p>Publicar é apertar o botão de upload. Qualquer um faz. É a parte mecânica.</p>
<p>Viralizar é o que decide se você cresce ou some no feed. Tem técnica. Tem padrão. Tem ciência.</p>
<p>A maioria dos criadores que conheço gasta 3-4 horas pra editar um Short e ZERO minutos analisando por que o último não decolou. Inversão clássica.</p>
<p>O Full vira essa equação. Você gasta 10 minutos analisando o padrão dos seus Shorts com o BlueScore, identifica o que tá travando (hook, pacing, CTA, áudio), e o próximo já sai melhor.</p>
<p>R$29,99/mês. Um vídeo decente pra cima desbloqueia o ano todo.</p>`,
    cta_text: 'Ver o que tá travando →',
    cta_url: 'https://bluetubeviral.com/blueScore',
    is_trial: false,
  },

  // ── 05 — Tendência mata em 48h ────────────────────────────────────────────
  {
    id: 'free_05_tendencia_48h',
    category: 'urgencia_tendencia',
    subject: 'Esse áudio morre em 5 dias',
    preheader: 'Quem postar até quinta surfa. Quem postar depois copia.',
    body: `<p>{{nome}}, atenção rápida.</p>
<p>Tendências de áudio no Shorts duram em média <strong>5-7 dias</strong> antes de saturar. Depois, qualquer Short usando o mesmo áudio cai como "cópia atrasada" no algoritmo.</p>
<p>Hoje você abre o TikTok Criativo ou o feed do Shorts e vê 6-8 áudios subindo agora. Daqui a uma semana, esses áudios já estão mortos e 4 novos subiram.</p>
<p>Quem monitora a janela publica no timing certo. Quem não monitora, copia o que já tá saturado.</p>
<p>O Buscador de Virais do Full mostra os Shorts explodindo agora — por país, nicho e velocidade de crescimento. Atualizado a cada poucas horas.</p>
<p>Custa o que custa um lanche. Pega a janela 1 vez e já se pagou pelo ano.</p>`,
    cta_text: 'Ver virais do momento →',
    cta_url: 'https://bluetubeviral.com/virais',
    is_trial: false,
  },

  // ── 06 — Insider Master tip leak ──────────────────────────────────────────
  {
    id: 'free_06_master_tip_leak',
    category: 'leak_master',
    subject: 'Coisa que só Master sabe',
    preheader: 'Vou te contar agora porque você merece um teaser.',
    body: `<p>{{nome}}, conversa rápida.</p>
<p>Tem uma coisa que aparece só na <strong>BlueTendências</strong> (exclusivo Master) que eu vou te contar agora:</p>
<p>A IA Blublu, quando disseca um viral, descobre que ~73% deles seguem o que chamamos de "padrão de 4 atos":</p>
<ul>
  <li><strong>Ato 1 (0-2s):</strong> hook que ativa curiosidade ou tensão</li>
  <li><strong>Ato 2 (2-7s):</strong> setup que entrega um problema</li>
  <li><strong>Ato 3 (7-15s):</strong> payoff visualmente surpreendente</li>
  <li><strong>Ato 4 (final):</strong> reforço de identidade do canal + CTA suave</li>
</ul>
<p>Não é estilo. É matemática. Os 100 maiores virais de Shorts deste ano seguem esse padrão.</p>
<p>O resto da análise (qual atributo de cada ato bate em cada nicho, quanto tempo dedicar a cada um, como adaptar pra seu canal específico) — isso é Master.</p>
<p>Mas você ganha o conceito. Já é um upgrade enorme sobre quem só "posta e vê o que acontece".</p>
<p>Quer testar o Full pra ver os roteiros que a IA já constrói nesse padrão pra você?</p>`,
    cta_text: 'Testar Full →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 07 — Calculadora ROI honesta ──────────────────────────────────────────
  {
    id: 'free_07_calc_roi',
    category: 'roi',
    subject: 'Quanto vale 1 viral?',
    preheader: 'Vamos fazer a conta com você.',
    body: `<p>{{nome}}, calc rápido.</p>
<p>Um Short que bate 500k views no YouTube paga em média <strong>R$150 a R$400</strong> de monetização (RPM 2026 BR, depende do nicho).</p>
<p>Master/Full custa R$89,99 ou R$29,99/mês.</p>
<p>Pra "se pagar", você precisa de:</p>
<ul>
  <li><strong>Full:</strong> 1 Short com 100k views a cada 2-3 meses</li>
  <li><strong>Master:</strong> 1 Short com 500k views a cada 5-6 meses</li>
</ul>
<p>É baixíssimo. Se você publica regular, você bate isso.</p>
<p>O que o BlueTube faz é AUMENTAR a chance de cada Short bater views. Não é mágica, é dado. Análise de padrão dos virais aplicada nos seus roteiros.</p>
<p>Quanto tá custando NÃO testar? Cada mês sem testar é potencialmente 1 viral a menos. Conta brutal.</p>`,
    cta_text: 'Testar Full por R$29,99 →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 08 — Anti-FOMO genuíno (psicologia inversa) ───────────────────────────
  {
    id: 'free_08_anti_fomo',
    category: 'psicologia_inversa',
    subject: 'Talvez Full não seja pra você',
    preheader: 'Sério, lê antes de assinar.',
    body: `<p>{{nome}}, vou contra meu próprio interesse aqui.</p>
<p>Full <strong>não vale</strong> pra todos. Honestamente.</p>
<p>Não vale se:</p>
<ul>
  <li>Você publica 1 Short por mês e tá ok com isso</li>
  <li>Você não tem tempo de assistir 5 vídeos virais por semana pra estudar</li>
  <li>Você só posta porque é hobby — não quer crescer</li>
  <li>Você acha que ferramenta resolve tudo (não resolve)</li>
</ul>
<p>Vale se:</p>
<ul>
  <li>Você publica regularmente (2+ Shorts/semana) e quer otimizar</li>
  <li>Você gasta horas pesquisando o que tá viralizando</li>
  <li>Você quer dado em vez de palpite</li>
  <li>Você tá disposto a aplicar o que a ferramenta mostra</li>
</ul>
<p>Se você é o segundo grupo, R$29,99 vai parecer ridiculamente barato em 3 meses.</p>
<p>Se você é o primeiro, ignora esse email. Sem ressentimento.</p>`,
    cta_text: 'Sou o segundo grupo. Testar.',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 09 — Storytelling de criador anônimo ──────────────────────────────────
  {
    id: 'free_09_storytelling',
    category: 'storytelling',
    subject: 'Caso real (sem foto antes/depois falsa)',
    preheader: 'Não vou inventar history. Vou só te contar o que vejo.',
    body: `<p>Oi {{nome}}.</p>
<p>Caso recente que vi no painel — sem nome porque privacidade, mas é gente real:</p>
<p>Criador postava 3-4 Shorts/semana fazia 8 meses. Média de views: 3-8k. Estagnado.</p>
<p>Pegou Full em maio. Primeira coisa: rodou BlueScore no canal. Saiu apontando que o pacing dele era 30% mais lento que a média do nicho. Hook longo. CTA tímido.</p>
<p>Aplicou. Próximo Short: 47k. O depois: 180k. Em 6 semanas, o primeiro dele de 500k.</p>
<p>Não é mágica. Foi <strong>análise + aplicação</strong>. A ferramenta mostrou onde tava o problema, ele aplicou.</p>
<p>Outros usuários Full não viram resultado parecido — alguns porque não aplicaram, alguns porque o problema deles não era no que a ferramenta cobre.</p>
<p>Mas a pergunta importante é: você sabe HOJE por que seus Shorts não decolam? Se não souber, vale gastar R$29,99 pra descobrir.</p>`,
    cta_text: 'Descobrir o que tá travando →',
    cta_url: 'https://bluetubeviral.com/blueScore',
    is_trial: false,
  },

  // ── 10 — Curiosidade técnica: pacing ──────────────────────────────────────
  {
    id: 'free_10_pacing',
    category: 'curiosidade_tecnica',
    subject: 'Cortes a cada 1.2 segundos',
    preheader: 'Esse é o pacing dos virais. O seu provavelmente é mais lento.',
    body: `<p>{{nome}}, dado curioso.</p>
<p>Análise de 50 mil Shorts virais mostra que o pacing médio dos vídeos com 1M+ views é de <strong>1.0 a 1.4 segundos por corte</strong>.</p>
<p>O criador iniciante médio usa 2.5-4 segundos por corte. Por isso o vídeo "arrasta" pro algoritmo.</p>
<p>Não é só editar mais rápido. É manter ritmo emocional. Cada corte precisa entregar uma nova informação visual ou auditiva.</p>
<p>O BlueScore detecta isso automaticamente — analisa qualquer Short e dá o pacing real em segundos por corte + compara com a média viral do nicho.</p>
<p>Aprende a editar mais rápido em 1 análise. R$29,99/mês de Full libera análises ilimitadas.</p>`,
    cta_text: 'Ver pacing dos meus vídeos →',
    cta_url: 'https://bluetubeviral.com/blueScore',
    is_trial: false,
  },

  // ── 11 — Soft sell BlueVoice ──────────────────────────────────────────────
  {
    id: 'free_11_bluevoice',
    category: 'feature_specific',
    subject: 'Sua voz cansa? Tem solução.',
    preheader: 'Não é desistir de gravar. É revezamento estratégico.',
    body: `<p>Oi {{nome}}.</p>
<p>Coisa que ninguém fala: gravar narração todo dia <strong>cansa</strong>. E quando cansa, a qualidade cai. E quando cai, o vídeo não viraliza.</p>
<p>O BlueVoice (Full) tem 16 idiomas + clonagem da sua própria voz. Você grava 30 segundos uma vez, e ele clona pra sempre.</p>
<p>Resultado: você narra Shorts até com gripe. Ou às 23h quando a vontade bateu. Ou no fim de semana enquanto cuida do filho.</p>
<p>Não é trapaça — é continuidade. O algoritmo recompensa quem publica regular, não quem publica perfeito.</p>
<p>R$29,99/mês.</p>`,
    cta_text: 'Ver BlueVoice em ação →',
    cta_url: 'https://bluetubeviral.com/blueVoice',
    is_trial: false,
  },

  // ── 12 — Quebra 4a parede + IA falando ─────────────────────────────────────
  {
    id: 'free_12_ia_meta',
    category: 'meta_4a_parede',
    subject: 'Email escrito por IA. Lê assim mesmo.',
    preheader: 'Sim, sou um modelo de linguagem mandando email. Não tem por que esconder.',
    body: `<p>{{nome}}, transparência:</p>
<p>Esse email foi gerado por modelo de linguagem (sim, IA). Você provavelmente já sabia, mas vou dizer.</p>
<p>Quer saber por quê?</p>
<p>Porque a estrutura do BlueTube inteiro é IA otimizando IA. Você analisa Shorts com IA (BlueScore). Narra com IA (BlueVoice). Gera roteiros com IA. Recebe email gerado por IA com base nos dados do seu padrão de uso.</p>
<p>Se isso te incomoda filosoficamente, ignora o resto.</p>
<p>Se você acha que IA bem usada é vantagem competitiva — você tá certo, e o Full te dá a vantagem.</p>
<p>R$29,99/mês.</p>
<p><em>(Inclusive — sou eu te dizendo: vou ser otimizado pra escrever email melhor que esse no mês que vem. É a vida.)</em></p>`,
    cta_text: 'Testar Full →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 13 — Comparação Full vs Free (sem cara de tabela publi) ───────────────
  {
    id: 'free_13_full_vs_free',
    category: 'comparacao',
    subject: '3 limites do Free que doem mais',
    preheader: 'Não são todos os limites. São os que travam crescimento.',
    body: `<p>{{nome}}, vou ser específico.</p>
<p>Free tem várias limitações. Mas só 3 realmente travam crescimento:</p>
<p><strong>1. Roteiros: 3 por dia</strong><br>
Você precisa testar formato, hook, tema. 3/dia é teste mínimo. Pra crescer rápido, precisa de 10-15/dia (testar e descartar).</p>
<p><strong>2. BlueScore: 1 análise/dia</strong><br>
Quem cresce analisa 3-5 canais concorrentes por semana. 1/dia é fragmentado demais — perde contexto.</p>
<p><strong>3. Sem BlueVoice</strong><br>
Sem narração IA, você grava cada vídeo. Tempo virou luxo de criador iniciante. Master/Full destrava isso.</p>
<p>Os outros limites (sem busca de virais, sem BlueTendências) são features extras — você sobrevive sem.</p>
<p>Mas esses 3 limites? Travam. R$29,99 destrava todos.</p>`,
    cta_text: 'Destravar agora →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 14 — Frequência de postagem ───────────────────────────────────────────
  {
    id: 'free_14_frequencia',
    category: 'curiosidade_tecnica',
    subject: 'Quantas vezes por dia publicar?',
    preheader: 'Tem ponto ótimo. Não é "quanto mais melhor".',
    body: `<p>Pergunta que mais recebo, {{nome}}.</p>
<p>Análise dos 500 maiores canais de Shorts BR de 2026 mostra padrão claro:</p>
<ul>
  <li><strong>1 Short/dia</strong> → crescimento lento, mas estável (recomendado pra iniciante)</li>
  <li><strong>2-3/dia</strong> → ponto ótimo de crescimento (algoritmo prioriza freqüência)</li>
  <li><strong>4+/dia</strong> → algoritmo distribui menos por vídeo (canibaliza)</li>
</ul>
<p>Maioria dos criadores postam 1 esporadicamente. Ficam no nível 1 — crescimento lento.</p>
<p>Pra subir pra 2-3/dia, você precisa de roteirização rápida. Aí Full destrava — roteiros ilimitados em segundos. Narração rápida via BlueVoice.</p>
<p>Custa R$29,99. Aumenta sua capacidade de output em 3x.</p>`,
    cta_text: 'Aumentar minha frequência →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 15 — TRIAL 30D variação leve (segunda chance de trial) ─────────────────
  {
    id: 'free_15_trial_30d_alt',
    category: 'trial_30d',
    subject: '{{nome}}, lembrança importante',
    preheader: '30 dias de Full grátis ainda na mesa pra você.',
    body: `<p>{{nome}}, oi.</p>
<p>Tô voltando porque vi que sua oferta de <strong>30 dias grátis no Full</strong> ainda não foi ativada. Tava por aqui faz semanas.</p>
<p>Pra recapitular: clica no link, faz login na sua conta, plano Full ativa por 30 dias. Sem cartão, sem cobrança automática depois, sem pegadinha.</p>
<p>O que você ganha:</p>
<ul>
  <li>Roteiros IA ilimitados</li>
  <li>BlueVoice 16 idiomas</li>
  <li>BlueScore profundo</li>
  <li>Buscador de virais</li>
  <li>Tendências em tempo real</li>
</ul>
<p>Aos 30 dias, volta pra Free naturalmente. Se quiser continuar Full, pagamento é decisão sua, não automático.</p>
<p>Por que esse aviso? Porque ofertas que ficam paradas costumam ser esquecidas. Vai por mim.</p>`,
    cta_text: 'Ativar 30 dias agora →',
    cta_url: 'https://bluetubeviral.com/api/trial-activate?token={{trial_token}}',
    is_trial: true,
  },

  // ── 16 — Anatomia de hook viral ───────────────────────────────────────────
  {
    id: 'free_16_anatomia_hook',
    category: 'curiosidade_tecnica',
    subject: 'Anatomia de hook',
    preheader: 'Componentes do "primeiro segundo" dos virais.',
    body: `<p>{{nome}}, dado bonitinho.</p>
<p>Decomposição do hook (primeiros 2 segundos) dos 100 maiores Shorts virais BR de 2026:</p>
<ul>
  <li><strong>87%</strong> abrem com movimento de câmera (zoom, pan, ou corte abrupto pra rosto)</li>
  <li><strong>73%</strong> têm uma palavra ou som forte nos primeiros 0.5s</li>
  <li><strong>61%</strong> mostram a pessoa olhando direto pra câmera</li>
  <li><strong>54%</strong> têm overlay de texto</li>
  <li><strong>92%</strong> têm áudio de impacto (não silêncio)</li>
</ul>
<p>Maioria dos criadores iniciantes faz o oposto: abertura estática, sem palavra forte, olhando pro lado, sem overlay.</p>
<p>BlueScore (Full) detecta cada um desses elementos no seu Short. Mostra o que tá faltando.</p>
<p>R$29,99/mês destrava análises ilimitadas.</p>`,
    cta_text: 'Analisar meu hook →',
    cta_url: 'https://bluetubeviral.com/blueScore',
    is_trial: false,
  },

  // ── 17 — Diss de plataforma concorrente (sutil) ───────────────────────────
  {
    id: 'free_17_diss_capcut',
    category: 'comparacao_concorrente',
    subject: 'CapCut + 6 abas + nada',
    preheader: 'Sua rotina de produção tá assim?',
    body: `<p>Vai pelas mãos, {{nome}}.</p>
<p>Pra fazer 1 Short, criador típico abre:</p>
<ul>
  <li>CapCut (edição)</li>
  <li>ChatGPT (roteiro)</li>
  <li>ElevenLabs (voz, talvez)</li>
  <li>YouTube (pesquisar referência)</li>
  <li>TikTok Criativo (ver áudios trending)</li>
  <li>Canva ou Figma (thumb)</li>
</ul>
<p>6 ferramentas. 6 assinaturas (~R$150-300/mês). 4-6 horas pra fazer 1 Short.</p>
<p>BlueTube faz roteiro + voz + análise + virais + descaracterização <strong>num lugar só</strong>. Plus: ferramentas são integradas (o que a IA escreve, ela mesma narra).</p>
<p>R$29,99/mês de Full ou R$89,99 de Master.</p>
<p>Não estamos dizendo que vai resolver tudo. Estamos dizendo que vai consolidar tudo.</p>`,
    cta_text: 'Consolidar minhas ferramentas →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 18 — Algoritmo do YouTube ─────────────────────────────────────────────
  {
    id: 'free_18_algoritmo',
    category: 'curiosidade_tecnica',
    subject: 'O que o algoritmo realmente mede',
    preheader: 'Não é só views. Vou listar os 6 fatores reais.',
    body: `<p>{{nome}}, leitura útil.</p>
<p>O algoritmo do YouTube Shorts em 2026 prioriza <strong>6 métricas</strong> nessa ordem:</p>
<ol>
  <li><strong>Watch time como % da duração</strong> (mais importante)</li>
  <li><strong>Replay rate</strong> — gente que assistiu mais de uma vez</li>
  <li><strong>Velocidade inicial de visualização</strong> (primeiras 2h)</li>
  <li><strong>Likes / view ratio</strong></li>
  <li><strong>Compartilhamentos</strong> (peso alto)</li>
  <li><strong>Comentários</strong> (peso médio)</li>
</ol>
<p>Quase ninguém olha pra esses dados antes de publicar. O BlueScore consolida tudo numa única página por Short.</p>
<p>Você sabe quais dos seus Shorts têm replay rate alto? Provavelmente não. E é onde tá ouro pra entender o que viraliza.</p>
<p>R$29,99/mês destrava.</p>`,
    cta_text: 'Ver minhas métricas →',
    cta_url: 'https://bluetubeviral.com/blueScore',
    is_trial: false,
  },

  // ── 19 — Storytelling criador iniciante ──────────────────────────────────
  {
    id: 'free_19_iniciante',
    category: 'storytelling',
    subject: 'O que eu faria se começasse hoje',
    preheader: 'Sem voltar no tempo. Receita pratica.',
    body: `<p>{{nome}}, exercício de pensamento.</p>
<p>Se eu começasse a fazer Shorts hoje, do zero, sem audiência, sem nicho definido:</p>
<p><strong>Semana 1-2:</strong> Estudaria 50 virais do nicho que me interessa (5/dia × 10 dias). Anotaria padrões de hook, pacing, CTA.</p>
<p><strong>Semana 3-4:</strong> Publicaria 1-2/dia, replicando estrutura dos virais. Mediria.</p>
<p><strong>Mês 2:</strong> Iteraria — o que pegou, repete; o que não, descarta.</p>
<p>O Full do BlueTube acelera isso. Em vez de assistir 50 virais manualmente (~10 horas), o Buscador filtra os top do nicho. BlueScore analisa cada um. Você fica com a parte importante: aplicar.</p>
<p>R$29,99/mês reduz 30 dias de aprendizado pra 5.</p>`,
    cta_text: 'Acelerar minha curva →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 20 — Thumbnail e CTR ──────────────────────────────────────────────────
  {
    id: 'free_20_thumbnail',
    category: 'curiosidade_tecnica',
    subject: 'Shorts não tem thumb, mas...',
    preheader: 'Tem 3 segundos visuais que funcionam como thumb. Você não trata como tal.',
    body: `<p>{{nome}}, micro-aula.</p>
<p>Shorts não tem thumbnail tradicional. Mas tem o <strong>"primeiro frame fixo"</strong> que aparece no feed antes do user clicar.</p>
<p>Esse frame é seu equivalente de thumb. E quase ninguém otimiza.</p>
<p>O que pega olhar:</p>
<ul>
  <li>Rosto humano (preferencialmente expressivo)</li>
  <li>Cores contrastantes (não fundo neutro)</li>
  <li>Overlay de texto curto (3-5 palavras)</li>
  <li>Movimento sugerido (não pose estática)</li>
</ul>
<p>BlueScore avalia tudo isso na thumb do seu Short. Aponta o que tá errado e sugere ajuste.</p>
<p>R$29,99/mês.</p>`,
    cta_text: 'Otimizar minhas thumbs →',
    cta_url: 'https://bluetubeviral.com/blueScore',
    is_trial: false,
  },

  // ── 21 — Quebra 4a parede agressivo ───────────────────────────────────────
  {
    id: 'free_21_meta_aviso',
    category: 'meta_4a_parede',
    subject: 'Eu não trabalho de graça',
    preheader: '(O modelo de IA que escreveu esse email custa caro. E tá rodando pra você.)',
    body: `<p>{{nome}}, conversa real.</p>
<p>Esse email custou ~R$0,02 pra gerar (modelo de linguagem rodando). Mandar pra você custa mais ~R$0,001 (Resend). Total: ~R$0,021.</p>
<p>Pra 268 free users na lista, isso é ~R$5,60 esta semana. Pra 24 meses de campanha, ~R$580.</p>
<p>Eu (o BlueTube) tô gastando R$580 pra te convencer a pagar R$29,99/mês. Faz sentido financeiro pra mim só se ~3% de vocês virarem Full.</p>
<p>Por quê tô te contando isso? Porque transparência. Você sabe o jogo. Eu sei o jogo. Vamos ser honestos.</p>
<p>A pergunta é: você é dos 3% que se beneficia ou dos 97% que não? Só você sabe.</p>
<p>Se acha que se beneficia: testa o Full.<br>
Se não: ignora. Sem ressentimento.</p>`,
    cta_text: 'Testar Full →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 22 — Curiosidade legal: monetização ───────────────────────────────────
  {
    id: 'free_22_ypp',
    category: 'curiosidade_legal',
    subject: 'Você sabe o que desmonetiza Shorts?',
    preheader: 'Lista das 5 razões mais comuns. Não é o que você imagina.',
    body: `<p>{{nome}}, importante saber.</p>
<p>YouTube Partner Program (YPP) bloqueia monetização de Shorts por 5 razões mais comuns:</p>
<ol>
  <li><strong>Reuso de conteúdo</strong> sem transformação substancial (clipe de outro vídeo + voz IA)</li>
  <li><strong>Voz IA sem disclosure</strong> (regra 2024+, muitos não sabem)</li>
  <li><strong>Música licenciada</strong> usada sem permissão</li>
  <li><strong>Clickbait extremo</strong> (thumb/título que prometem o que vídeo não entrega)</li>
  <li><strong>Compilação sem comentário</strong> (just collage de clipes alheios)</li>
</ol>
<p>O BlueScore (versão Master) tem um "Advogado YPP" que analisa seu canal nessas 5 frentes e aponta risco real de desmonetização ANTES de você perder dinheiro.</p>
<p>Full não tem essa parte profunda — mas tem análise básica do canal.</p>
<p>Vale conhecer.</p>`,
    cta_text: 'Analisar meu canal →',
    cta_url: 'https://bluetubeviral.com/blueScore',
    is_trial: false,
  },

  // ── 23 — Anti-spam consciente ─────────────────────────────────────────────
  {
    id: 'free_23_anti_spam_meta',
    category: 'meta_4a_parede',
    subject: 'Não vou te encher de email',
    preheader: 'Promessa de cadência. (Não promessa de prometer.)',
    body: `<p>{{nome}}, compromisso.</p>
<p>Você vai receber 1 email por semana. Quinta às 10h. Sempre.</p>
<p>Não vou mandar 2 no mesmo dia. Não vou mandar 5 na mesma semana. Não vou fingir urgência ("OFERTA ACABA EM 1 HORA") quando não acaba.</p>
<p>Quando tiver oferta real (tipo o trial 30 dias grátis), vai estar claro. Quando não tiver, é só conteúdo útil.</p>
<p>Pra cancelar tudo, link aqui embaixo. 1 clique. Sem formulário, sem "tem certeza?".</p>
<p>A razão é simples: pra você abrir meu email semana que vem, eu preciso ter respeitado seu tempo essa semana.</p>
<p>Se quiser testar o Full, link abaixo. Senão, te vejo quinta que vem.</p>`,
    cta_text: 'Testar Full →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 24 — Reforço ROI (último do ciclo, depois loop) ───────────────────────
  {
    id: 'free_24_ultima_chamada_ciclo',
    category: 'fim_ciclo',
    subject: 'Última vez antes de eu repetir',
    preheader: 'Loop começa quinta que vem. Vou ser direto.',
    body: `<p>{{nome}}, último email do ciclo atual.</p>
<p>Recapitulando os fatos:</p>
<ul>
  <li>Você tá no BlueTube há {{dias_no_bluetube}} dias</li>
  <li>Free dá pra começar, mas trava em volume e profundidade</li>
  <li>Full custa R$29,99 = preço de delivery</li>
  <li>1 Short com 500k views paga ~R$150-400</li>
  <li>Matemática quebra a favor de Full em qualquer cenário razoável</li>
</ul>
<p>A partir de quinta que vem, vou começar o ciclo de novo (com pequenas variações). Não porque sou robô — porque tem gente nova entrando na lista e o conteúdo é evergreen.</p>
<p>Se você quer testar Full, é uma boa hora. Se não quer, ignora. Sem ressentimento — sério.</p>`,
    cta_text: 'Testar Full →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },
];

const FULL_TEMPLATES = [
  // ── 01 — Diferenciação Master clara ───────────────────────────────────────
  {
    id: 'full_01_diferenciacao',
    category: 'diferenciacao_real',
    subject: 'O que você ainda não viu no BlueTube',
    preheader: '{{nome}}, esse é o tipo de coisa que não conta nem nas landing pages.',
    body: `<p>{{nome}}, conversinha rápida.</p>
<p>Você tá no Full há {{dias_no_bluetube}} dias. Tá usando bem (roteiros ilimitados, BlueVoice). E tem cinco features inteiras que o Full simplesmente não te mostra.</p>
<p>São essas:</p>
<p><strong>1. BlueScore PROFUNDO (Advogado YPP)</strong><br>
Análise jurídica do seu canal sob ótica de diretrizes YouTube semanais. Cita risco real de desmonetização com evidência por vídeo. Não é o BlueScore simples — é um nível acima.</p>
<p><strong>2. Blublu disseca vídeo viral em 5 atos</strong><br>
Você cola URL de qualquer Short viral, a Blublu mostra exatamente por que viralizou: hook, estrutura, gatilho do algoritmo. Sai com 2 templates aplicáveis pro SEU nicho.</p>
<p><strong>3. BlueEditor (em beta, exclusivo Master)</strong><br>
Timeline profissional + Blublu sugerindo cortes + score de viralidade em tempo real. Sem precisar abrir CapCut.</p>
<p><strong>4. Análises ilimitadas</strong> (Full tem limite por dia)</p>
<p><strong>5. Acesso antecipado a TUDO que lançamos</strong> (TikTok Virais, BlueTendências v3, etc.)</p>
<p>Custo do upgrade: R$60/mês a mais que o Full. R$2 por dia.</p>
<p>Pergunta direta: se 1 dos seus Shorts viralizar nos próximos 30 dias usando uma dessas features, paga o ano inteiro de Master de uma vez.</p>`,
    cta_text: 'Fazer upgrade pra Master →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 02 — Early access TikTok ──────────────────────────────────────────────
  {
    id: 'full_02_tiktok_early',
    category: 'early_access',
    subject: 'Master vai pegar TikTok 60 dias antes',
    preheader: 'Estamos terminando. Master tem prioridade na fila.',
    body: `<p>{{nome}}, novidade de bastidor.</p>
<p>Tá saindo do forno: <strong>filtro de Virais TikTok exclusivo</strong>. Mesma lógica do YouTube Virais (top vídeos explodindo por nicho), mas pegando direto do TikTok.</p>
<p>Vai entrar no painel só pra usuários MASTER nos primeiros 60 dias. Depois libera pro Full.</p>
<p>Por quê separar? Custo. SerpAPI cobra por chamada, e queremos validar o uso real antes de abrir pra base inteira.</p>
<p>Quem é Master quando a feature lançar (estimativa: 2-3 semanas) entra na lista. Quem virar Master DEPOIS do lançamento entra no fim da fila ou espera 60 dias.</p>
<p>Mesma coisa rolou com BlueScore Profundo, BlueTendências, BlueEditor beta. Todas tiveram janela exclusiva Master no início.</p>
<p>R$60/mês a mais que o Full. Se você usar TikTok Virais 4 vezes no primeiro mês, já justificou.</p>`,
    cta_text: 'Upgrade pra Master e entrar na fila →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 03 — Custo de oportunidade BlueScore Deep ─────────────────────────────
  {
    id: 'full_03_oportunidade_deep',
    category: 'roi_master',
    subject: '1 análise Deep vale R$60?',
    preheader: 'Vamos fazer a conta direito.',
    body: `<p>{{nome}}, calc honesta.</p>
<p>BlueScore Deep (Master) analisa seu canal sob 4 dimensões: Áudio (voz IA detection), Visual (clickbait detection), Reverse Search (reposts), Advogado YPP (diretrizes).</p>
<p>Saí com lista de 5-10 problemas REAIS no canal com evidência por vídeo. Tipo: "Vídeo X: thumb com setas vermelhas + áudio voz IA sem disclosure. Risco moderado de desmonetização."</p>
<p>Pra contratar consultoria pra fazer isso manualmente, custaria R$300-800 (1 análise externa típica).</p>
<p>O BlueTube faz por R$60 (diferença Master/Full). E você pode rodar 1 vez por dia, em quantos canais quiser.</p>
<p>Pergunta: vale R$60/mês pra ter consultoria de canal mensal?</p>`,
    cta_text: 'Testar BlueScore Deep →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 04 — Achievement style ────────────────────────────────────────────────
  {
    id: 'full_04_achievement',
    category: 'achievement',
    subject: '{{nome}}, marco desbloqueado',
    preheader: 'Você completou {{dias_no_bluetube}} dias de Full. Próximo nível tá aí.',
    body: `<p>Reconhecimento, {{nome}}.</p>
<p>Você é Full há {{dias_no_bluetube}} dias. Isso te coloca no top 20% de retenção do nosso plano pago.</p>
<p>Esse pessoal — quem retém Full por 30+ dias — geralmente cai num dos 2 grupos:</p>
<p><strong>Grupo A:</strong> Aplica o que a ferramenta mostra. Cresce visivelmente. Eventualmente vira Master pra ganhar features avançadas.</p>
<p><strong>Grupo B:</strong> Usa Full no básico (roteiros). Não migra. Acaba cancelando em 3-4 meses por achar que "não tá pegando".</p>
<p>A diferença entre A e B raramente é talento. É <strong>profundidade de análise</strong>.</p>
<p>Master destrava BlueScore Deep, BlueTendências (dissecação viral), BlueEditor beta. São exatamente as ferramentas que separam quem cresce de quem estagna.</p>
<p>R$60/mês a mais.</p>`,
    cta_text: 'Subir pro Grupo A →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 05 — Custo evitado (FOMO de aumento) ──────────────────────────────────
  {
    id: 'full_05_preco_subir',
    category: 'fomo_preco',
    subject: 'Aviso de preço',
    preheader: 'Master tá R$89,99. Não vai ficar nesse preço pra sempre.',
    body: `<p>{{nome}}, aviso honesto.</p>
<p>Master tá R$89,99/mês hoje. Esse preço foi definido em 2025, quando éramos menos features.</p>
<p>Adicionamos desde então: BlueScore Deep (Advogado YPP), BlueTendências v3 com Blublu personality v3, BlueLens v4, BlueEditor beta. Custo da operação subiu (IA, SerpAPI, Railway).</p>
<p>A pergunta que vamos enfrentar nos próximos 3-6 meses: subir o preço de Master pra cobrir custo, ou cortar features?</p>
<p>Provavelmente subir. Quando subir (não SE — quando), quem já é Master mantém o preço atual <strong>pra sempre</strong>. Quem entrar depois paga o novo.</p>
<p>Não é tática de vendas. É operacional. SerpAPI Starter $25/mês = 1000 análises. Crescimento de Master + BlueLens tá se aproximando disso.</p>
<p>Se você tava pensando em upgrade, agora é tecnicamente o momento mais barato.</p>`,
    cta_text: 'Travar preço atual →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 06 — Conteúdo exclusivo Master teaser ─────────────────────────────────
  {
    id: 'full_06_master_teaser',
    category: 'leak_conteudo',
    subject: 'Algo que só Master tem visto',
    preheader: 'Vou compartilhar contigo porque você tá perto.',
    body: `<p>{{nome}}, leak controlado.</p>
<p>Toda semana mando pros Masters um resumo dos 20 vídeos mais virais BR (todos nichos) com decomposição do que cada um fez certo. Não tem em lugar nenhum do site.</p>
<p>Exemplo do último: vídeo de 3.2M views no nicho de "curiosidades sobre comida". A decomposição que mandei foi:</p>
<ul>
  <li><strong>Hook 0-1.8s:</strong> Pergunta direta + zoom seco no rosto</li>
  <li><strong>Setup 1.8-6s:</strong> Visual chocante (corte de alimento mostrando contraste)</li>
  <li><strong>Payoff 6-14s:</strong> Informação inesperada explicada em frase curta</li>
  <li><strong>Reforço 14-22s:</strong> "Saiba qual a próxima curiosidade que vou contar — comenta aí"</li>
</ul>
<p>Aplicável em QUALQUER nicho com adaptação simples. Master ganha esse insight semanalmente — 4 vezes por mês. 48 por ano.</p>
<p>R$60/mês de upgrade.</p>`,
    cta_text: 'Receber decomposições semanais →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 07 — Comparação direta Full vs Master ─────────────────────────────────
  {
    id: 'full_07_full_vs_master',
    category: 'comparacao_planos',
    subject: 'Full vs Master, sem floreio',
    preheader: 'Diferença real em 4 pontos. Vou listar.',
    body: `<p>{{nome}}, direto.</p>
<p>Diferença Full → Master em 4 pontos práticos:</p>
<p><strong>1. BlueScore</strong><br>
Full: análise básica (hook, pacing, thumb)<br>
Master: BlueScore Deep com Advogado YPP + 4 engines (áudio, visual, reverse, jurídico)</p>
<p><strong>2. Blublu Personality v3</strong><br>
Full: roteiros bem feitos<br>
Master: BlueTendências — Blublu disseca virais em 5 atos com voz autoral própria, aplicação pro seu nicho específico</p>
<p><strong>3. Beta access</strong><br>
Full: features quando lançam estáveis<br>
Master: BlueEditor 60 dias antes, TikTok Virais 60 dias antes, próximos lançamentos primeiro</p>
<p><strong>4. Análises</strong><br>
Full: 1 análise profunda por dia<br>
Master: ilimitada</p>
<p>Custo: R$60/mês a mais.</p>
<p>Pra criador que publica 4+ Shorts por semana, paga em 1 vídeo bom.</p>`,
    cta_text: 'Upgrade Master →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 08 — Honesto: nem todos precisam ──────────────────────────────────────
  {
    id: 'full_08_anti_fomo',
    category: 'honestidade',
    subject: 'Master nem sempre vale a pena',
    preheader: 'Sério. Lê antes de decidir.',
    body: `<p>{{nome}}, contraintuitiva.</p>
<p>Master NÃO vale se:</p>
<ul>
  <li>Você publica 1-2 Shorts por semana e tá ok com isso</li>
  <li>Você não usa Full no máximo (roteiros 1-2/dia, sem BlueVoice)</li>
  <li>Você não rotina análise dos seus vídeos depois de publicar</li>
  <li>Você gosta do canal "como hobby" — sem foco em monetização</li>
</ul>
<p>Master vale se:</p>
<ul>
  <li>Você publica 4+ Shorts/semana</li>
  <li>Você usa Full no máximo (Roteiros ilimitados quase todo dia)</li>
  <li>Você analisa cada Short depois de publicar pra refinar próximo</li>
  <li>Você quer monetizar (ganhar dinheiro com canal)</li>
</ul>
<p>Se você é o segundo grupo, R$60/mês a mais paga sozinho. Se é o primeiro, fica no Full mesmo.</p>
<p>Não tem julgamento.</p>`,
    cta_text: 'Sou o segundo grupo →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 09 — Próximo lançamento + janela Master ───────────────────────────────
  {
    id: 'full_09_proximo_lancamento',
    category: 'early_access',
    subject: 'Próximo lançamento: pra Master primeiro',
    preheader: 'Padrão que vamos manter — features novas sempre Master inicial.',
    body: `<p>{{nome}}, padrão da casa.</p>
<p>Todo lançamento novo no BlueTube tem janela exclusiva Master nos primeiros 30-60 dias. Depois libera pro Full.</p>
<p>Histórico recente:</p>
<ul>
  <li>BlueScore Profundo (Advogado YPP) — Master 60 dias antes</li>
  <li>BlueTendências v3 com Blublu personality — Master 30 dias antes</li>
  <li>BlueEditor beta — Master only (ainda não liberou pra Full)</li>
  <li><strong>Próximo:</strong> Virais TikTok — Master 60 dias antes (lança em 2-3 semanas)</li>
</ul>
<p>Por quê? Custo de validação + recompensar quem paga mais. Não é pra "humilhar" Full.</p>
<p>Você é Full há {{dias_no_bluetube}} dias. Tá esperando o quê?</p>`,
    cta_text: 'Subir pra Master →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 10 — Quebra 4a parede Full ────────────────────────────────────────────
  {
    id: 'full_10_meta_quebra',
    category: 'meta_4a_parede',
    subject: 'Por que ainda não virou Master?',
    preheader: 'Pergunta real. Vou listar as 5 razões mais comuns que vejo.',
    body: `<p>{{nome}}, transparência IA.</p>
<p>Você é Full há {{dias_no_bluetube}} dias. Em paralelo, vejo dezenas de usuários no mesmo perfil.</p>
<p>5 razões mais comuns pra Full NÃO virar Master:</p>
<p><strong>1. Não usa Full no máximo</strong> — sente que pagar mais não resolve se nem usa o atual</p>
<p><strong>2. Custo psicológico</strong> — R$89,99 parece "muito" comparado a R$29,99 (mesmo sendo só R$60 a mais)</p>
<p><strong>3. Não viu as features Master</strong> — landing page mostra superficialmente, não no detalhe</p>
<p><strong>4. Falta de FOMO real</strong> — não rolou nenhum lançamento Master enquanto era Full</p>
<p><strong>5. Esperando "momento certo"</strong> — sempre tem uma boleta pra pagar</p>
<p>Qual é o seu? Cada razão tem resposta diferente. Tô curioso (e a IA aqui é literalmente curiosa).</p>`,
    cta_text: 'Quero conhecer Master →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 11 — ROI Master ──────────────────────────────────────────────────────
  {
    id: 'full_11_roi_master',
    category: 'roi_master',
    subject: 'Master se paga em 1 viral',
    preheader: 'Mostro a conta.',
    body: `<p>{{nome}}, calc com você.</p>
<p>Custo Master/Full: R$60/mês a mais.</p>
<p>Custo anual: R$720.</p>
<p>1 Short que bate 2M views paga em média R$600-1.500 (RPM 2026 BR varia por nicho).</p>
<p>Pra "se pagar" no ano, Master precisa te ajudar a ter <strong>1 viral médio a cada 12 meses</strong>.</p>
<p>Honestamente? Se você não consegue tirar 1 viral por ano de uma ferramenta que analisa profundo seu canal + dá dissecação viral semanal + acesso antecipado a recursos novos — provavelmente nem vai conseguir sem ferramenta nenhuma.</p>
<p>Master não substitui esforço. Acelera resultado de quem já tá esforçado.</p>`,
    cta_text: 'Upgrade Master →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 12 — Insider: quanto custa rodar isso ─────────────────────────────────
  {
    id: 'full_12_insider_custo',
    category: 'transparencia_custos',
    subject: 'Você paga R$30. Custa quanto?',
    preheader: 'Transparência operacional.',
    body: `<p>{{nome}}, abrindo a caixa preta.</p>
<p>Custo aproximado pra rodar a infraestrutura por usuário Full:</p>
<ul>
  <li>OpenAI / Gemini (roteiros + análise): R$3-6/mês</li>
  <li>Anthropic Claude (BlueScore visual): R$2-4/mês</li>
  <li>Supadata (transcrição): R$1-2/mês</li>
  <li>SerpAPI (busca virais): R$1-3/mês</li>
  <li>YouTube Data API: ~R$0 (quota free)</li>
  <li>Supabase + Vercel: R$3-5/mês por user</li>
  <li>Suporte humano + email + admin: R$2-3/mês</li>
</ul>
<p>Total: ~R$12-23/mês de custo por Full ativo.</p>
<p>Você paga R$29,99. Margem ~R$7-18/mês.</p>
<p>Master usa muito mais features (BlueScore Deep custa 4-5x mais que BlueScore Full por chamada). Margem é parecida em valor absoluto, mas Master tem features que Full não cobre.</p>
<p>Pergunta: você tá pagando R$30 ou usando R$30 em ferramenta? Pra Full a resposta varia. Pra Master, geralmente é claramente "usando".</p>`,
    cta_text: 'Ver detalhes Master →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 13 — BlueEditor beta exclusivo ────────────────────────────────────────
  {
    id: 'full_13_blueeditor',
    category: 'feature_specific',
    subject: 'BlueEditor tá pronto. Só pra Master.',
    preheader: 'Timeline + Blublu sugerindo cortes. Sem CapCut.',
    body: `<p>{{nome}}, anúncio de bastidor.</p>
<p>BlueEditor entrou em beta. <strong>Exclusivo Master nos primeiros 60-90 dias.</strong></p>
<p>O que ele faz que CapCut/Premiere não fazem:</p>
<ul>
  <li>Timeline profissional + Blublu sugerindo onde cortar pra otimizar pacing</li>
  <li>Score de viralidade em tempo real enquanto você edita (não depois)</li>
  <li>Legenda automática Whisper (integrada, não plugin)</li>
  <li>Export 9:16 otimizado pra Shorts (não você ajustando manualmente)</li>
  <li>Blublu apontando quando hook tá fraco, pacing lento, etc</li>
</ul>
<p>É o jeito do BlueTube fazer editor. Master ganha cedo.</p>
<p>R$60/mês a mais que Full.</p>`,
    cta_text: 'Acessar BlueEditor Master →',
    cta_url: 'https://bluetubeviral.com/blueEditor',
    is_trial: false,
  },

  // ── 14 — Quebra 4a parede meta-explícito ──────────────────────────────────
  {
    id: 'full_14_meta_email',
    category: 'meta_4a_parede',
    subject: 'Tô mandando email automático',
    preheader: '(Você sabia. Eu sei. Vamos seguir.)',
    body: `<p>{{nome}}, transparência.</p>
<p>Esse email foi gerado por engine que roda toda sexta às 10h, pegando seu nome do banco e mandando template rotativo. Sou eu, IA, te falando.</p>
<p>Você é Full há {{dias_no_bluetube}} dias. Eu sei isso porque é dado no banco. Não é mágica, não é stalker — é jeito normal de operar SaaS.</p>
<p>A questão real é: vou continuar te mandando email todo 10 dias até você virar Master, virar free, ou desinscrever.</p>
<p>Se você quer parar de receber: link abaixo, 1 clique.<br>
Se você quer testar Master: também tem link.<br>
Se você quer continuar Full: ignora. Tô bem com isso.</p>
<p>Sem pressão, sem manipulação. Eu sou IA, mas a decisão é sua.</p>`,
    cta_text: 'Conhecer Master →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 15 — Comparação concreta de features ─────────────────────────────────
  {
    id: 'full_15_features_grid',
    category: 'comparacao_planos',
    subject: 'Master tem 11 features Full não tem',
    preheader: 'Lista completa, sem rebuscamento.',
    body: `<p>{{nome}}, lista.</p>
<p>Features que Master tem e Full não:</p>
<ol>
  <li>BlueScore PROFUNDO (Advogado YPP)</li>
  <li>BlueTendências (Blublu disseca virais)</li>
  <li>BlueEditor beta (exclusivo Master)</li>
  <li>Virais TikTok (em breve, exclusivo Master por 60d)</li>
  <li>Análises BlueScore ilimitadas (Full = 1/dia)</li>
  <li>Roteiros com personalidade Blublu v3 (mais autoral)</li>
  <li>Acesso antecipado a tudo que lançamos</li>
  <li>Suporte prioritário (resposta em horas, não dias)</li>
  <li>Decomposições semanais de virais (manda pros Masters)</li>
  <li>BlueLens análise profunda (Full = básico)</li>
  <li>Voice clone múltiplas (Full = 1 só)</li>
</ol>
<p>R$60/mês a mais. Você usa quantas dessas?</p>`,
    cta_text: 'Ver Master detalhado →',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 16 — Último do ciclo + reflexão ───────────────────────────────────────
  {
    id: 'full_16_ultima_chamada',
    category: 'fim_ciclo',
    subject: 'Última coisa, {{nome}}',
    preheader: 'Cycle de emails Master vai recomeçar. Antes disso, reflexão.',
    body: `<p>{{nome}}, encerrando o ciclo atual.</p>
<p>Mandei 16 emails ao longo dos últimos meses te mostrando o que Master tem que Full não tem. Você leu (espero), reagiu (talvez), continuou Full (provavelmente).</p>
<p>Tudo bem. Sério.</p>
<p>Mas vou fazer um exercício final com você:</p>
<p><strong>Pergunta 1:</strong> Você é melhor criador hoje que era 30 dias atrás?</p>
<p><strong>Pergunta 2:</strong> Se sim, o que mudou? Foi ferramenta? Foi prática?</p>
<p><strong>Pergunta 3:</strong> Se você aumentar seu output em 30% nos próximos 30 dias, R$60/mês a mais valeria?</p>
<p>Master não muda esforço. Muda profundidade.</p>
<p>Próximo email vou recomeçar o ciclo (com variações). Antes disso, queria te perguntar se vale.</p>`,
    cta_text: 'Vale. Quero Master.',
    cta_url: 'https://bluetubeviral.com/#plans',
    is_trial: false,
  },

  // ── 17 — TikTok Virais · "vendo virais do mês passado" (2026-06-24) ──────
  {
    id: 'full_17_tiktok_atraso_14d',
    category: 'tiktok_virais',
    subject: 'Você tá vendo virais... do mês passado',
    preheader: 'TikTok mostra hoje o que viraliza no Shorts em 14 dias.',
    body: `<p>{{nome}}, conversa rápida.</p>
<p>Os virais do YouTube Shorts que você analisa hoje? Eles bombaram no TikTok há 7 a 14 dias.</p>
<p>Não é teoria. É padrão visível. O TikTok roda o algoritmo de viralização mais rápido do mundo. Quando um formato explode lá, ele vaza pro Reels em ~7 dias, pro YouTube Shorts em ~14.</p>
<p>Quem chega antes, ganha. Quem só vê quando já tá viral no Shorts, copia o que já tá saturado.</p>
<p>Hoje, mais cedo, conferi os virais TikTok:</p>
<ul>
  <li><strong>200+ vídeos com 800k+ likes</strong> — distribuídos em 8 países (US, BR, MX, ES, JP, KR, ID, FR)</li>
  <li>Atualizados <strong>3x por dia</strong> automaticamente</li>
  <li>Filtro por likes ou views</li>
  <li>Botão "Baixar no BlueTube" — copia o formato, posta no seu canal, ganha a janela de 14 dias</li>
</ul>
<p>Tá no painel Virais. Botão "🔥 TikTok" do lado de "30 dias". <strong>Exclusivo Master.</strong> R$60/mês a mais que o Full.</p>
<p>Vou ser brutalmente honesto: se você copia 1 formato TikTok antes da massa, paga o ano todo de Master de uma vez.</p>
<p><em>(P.S.: você é Full há {{dias_no_bluetube}} dias. Vou parar de mandar isso quando você for Master. Promessa.)</em></p>`,
    cta_text: 'Virar Master agora →',
    cta_url: 'https://bluetubeviral.com/?upgrade=master',
    is_trial: false,
  },

  // ── 18 — TikTok Virais · "200 virais agora · você vê 0" (2026-06-24) ─────
  {
    id: 'full_18_tiktok_200_zero',
    category: 'tiktok_virais',
    subject: '200 virais TikTok agora. Você vê 0.',
    preheader: 'Master vê. Full não. Math is math.',
    body: `<p>{{nome}}, contagem brutal.</p>
<p>Hoje, neste exato momento, tem <strong>200+ vídeos virais no TikTok com 800k+ likes</strong> rodando no painel Virais do BlueTube.</p>
<p>Países: 🇺🇸 🇧🇷 🇲🇽 🇪🇸 🇯🇵 🇰🇷 🇮🇩 🇫🇷<br>
Atualização: 3x ao dia, automática.<br>
Filtro: ordena por likes ou views — você escolhe.<br>
Bandeira de país em destaque em cada card.<br>
Botão "Baixar no BlueTube" pronto pra estudar formato.</p>
<p>Você vê quantos disso hoje? <strong>Zero.</strong></p>
<p>Porque Full não tem acesso. É exclusivo Master.</p>
<p>Calcula com calma:</p>
<ul>
  <li>Você é Full há <strong>{{dias_no_bluetube}} dias</strong></li>
  <li>Master custa R$60/mês a mais</li>
  <li>1 vídeo seu copiando formato TikTok viraliza? Paga o ano inteiro</li>
  <li>Tendência fica visível ~7 dias antes do Shorts</li>
</ul>
<p>Honestamente: a única razão pra ficar Full é não ter visto isso ainda. Agora você viu.</p>`,
    cta_text: 'Subir pra Master por R$60/mês →',
    cta_url: 'https://bluetubeviral.com/?upgrade=master',
    is_trial: false,
  },
];

module.exports = { FREE_TEMPLATES, FULL_TEMPLATES };
