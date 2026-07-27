// public/translations-en-overrides.js
// EN-overrides — vencem em colisao com TRANSLATIONS.en de api/auth.js (linha 48).
// Carregado em index.html ANTES do detectAndTranslate(). Quando siteLang === 'en',
// applyTranslations() le siteTranslations ja merged com EN_OVERRIDES. Chaves nao
// listadas aqui caem no TRANSLATIONS.en original (que continua sendo a base).
//
// 2026-07-25 — REFRESH COMPLETO (auditoria com IP dos EUA): o site pivotou pro
// conceito "Hub de ferramentas" e as traducoes ficaram na era antiga. Alem das
// chaves, este arquivo agora carrega EN_TEXT_MAP: mapa texto-exato PT→EN que o
// applyTranslations aplica num passe de tree-walk — cobre TUDO que nao tem id
// (cards das 9 ferramentas, planos, FAQ completo, modais, cookie banner).
// Gerado a partir de sonda Playwright que renderiza a home em EN e caça
// qualquer texto PT visivel (_scripts/en_leak_probe.mjs). Pra validar:
// rodar a sonda — meta é ZERO vazamento visivel.
//
// Diretrizes (EN nativa, nao traducao literal): verbos imperativos, frases
// curtas, "you/your", tom de criador, sem regionalismo BR.

window.EN_OVERRIDES = {
  // ── HERO (conceito atual: Hub de ferramentas) ──────────────────────────────
  hero_plain: 'The all-in-one toolkit for',
  hero_gradient: 'Short-Form Video Creators',
  hero_sub_html: '<span style="color:#fbbf24;font-weight:700">9 essential tools</span> — start free with <span style="color:#fbbf24;font-weight:700">Adapt Script</span>: paste a <span style="color:#fbbf24;font-weight:700">Shorts</span>, <span style="color:#fbbf24;font-weight:700">Instagram</span> or <span style="color:#fbbf24;font-weight:700">TikTok</span> link, pick a language, and get the transcript + 2 viral scripts ready to record.',
  page_title: 'BlueTube — Shorts, TikTok & Instagram Script Toolkit',
  page_meta: 'Paste any Shorts, Instagram or TikTok link and get the transcript + 2 viral scripts ready to record. 9 tools for short-form creators.',
  btn_go: 'Get My Scripts ↗',

  // ── TABS / RESULTS ──────────────────────────────────────────────────────────
  tab_appeal: '🔥 Punchy',
  new_short: 'Try Another',
  generating: 'Cooking up your next hit…',
  err_empty: 'Drop a video link to begin.',
  err_invalid: "That's not a supported link. Use YouTube Shorts, Instagram or TikTok.",

  // ── NAV / AUTH ──────────────────────────────────────────────────────────────
  nav_enter: 'Log In',
  nav_logout: 'Log Out',
  auth_title: 'Sign in or create your account',
  tab_login: 'Log In',
  tab_signup: 'Sign Up',
  pwd_min: 'Choose a password (6+ chars)',
  btn_login: 'Log In →',
  btn_signup: 'Sign Up →',
  forgot: 'Forgot password?',
  back_login: '← Back to log in',
  signing_in: 'Logging in…',
  welcome: "You're in! 🎉",
  creating: 'Setting up your account…',

  // ── UPGRADE MODAL ───────────────────────────────────────────────────────────
  up_live: 'creators making scripts right now',
  up_cta: 'Unlock now →',
  up_or: 'or sign up free',
  up_email_btn: 'Sign Up with Email',

  // ── PLANS ───────────────────────────────────────────────────────────────────
  plan_annual: 'Yearly',
  plan_annual_label: 'billed yearly',
  plan_full_btn: 'Get Full →',
  plan_master_btn: 'Get Master →',
  price_increase: "Prices increase next month: +$10 Full, +$20 Master. Lock in today's rate.",

  // Full features
  f5: 'Creator community',
  f6: 'AI that gets your style',

  // Master features
  m3: 'AI chat tuned to you',
  m6: 'Trending Short finder',
  m7: 'Creator community',

  // ── COMMUNITY ───────────────────────────────────────────────────────────────
  comm_sub: 'Subscribers only',
  comm_joined: '✓ Joined',

  // ── PROFILE ─────────────────────────────────────────────────────────────────
  profile_days: 'Days on premium',
  profile_until: 'Premium until',
  profile_pwd: "🔑 Change password — we'll email a link",
  profile_master: '👑 Upgrade to Master →',
  profile_logout: '↪ Log out',
  profile_info: 'Account details',
  support_ph: "What's on your mind?",
  support_btn: 'Send →',

  // ── CANCEL FLOW ─────────────────────────────────────────────────────────────
  cancel_r1: "It's hard to use",
  cancel_r2: 'Too expensive right now',
  cancel_r3: "I don't need it anymore",
  cancel_confirm: 'Confirm cancel',
  cancel_offer_title: 'Wait — quick offer for you',
  cancel_offer_sub: 'Stick around: $3 off your next month.',
  cancel_accept: 'Take the offer 💙',
  cancel_bye_sub: 'Subscription cancelled. You keep premium until the end of your paid period.',

  // ── BLUBLU CHATBOT ──────────────────────────────────────────────────────────
  blublu_hello: "Hey! I'm <strong>BluBlu</strong> 🤖<br>How's it going so far?<br>Liking BlueTube?",
  blublu_ph: 'Tell me anything…',
  blublu_send: 'Send →',
  blublu_thanks: 'Sending this to the team. Thanks! 🚀',

  // ── FOMO BAR ────────────────────────────────────────────────────────────────
  fomo_censored: "Name hidden at creator's request",
  fomo_protected: 'Identity protected',
  fomo_anon: 'Creator chose to stay anonymous',

  // ── PLANS SECTION ───────────────────────────────────────────────────────────
  plans_eye: 'Pricing',
  plans_title: 'Pick your plan.',

  // ── FOOTER ──────────────────────────────────────────────────────────────────
  footer_copy: '© 2026 BlueTube · For creators',

  // ── RESET PASSWORD ──────────────────────────────────────────────────────────
  new_pwd: 'Set a new password',
  pwd_new_ph: 'New password (6+ chars)',
  save_pwd: 'Save password →',
};

// ─────────────────────────────────────────────────────────────────────────────
// EN_TEXT_MAP — texto exato PT → EN (aplicado por tree-walk; espaços
// normalizados). Cobre elementos SEM id/chave: cards de ferramentas, planos,
// FAQ, modais, banners. Manter o PT daqui EM SINCRONIA com o HTML — se o texto
// PT mudar na página, atualizar a chave aqui (a sonda acusa).
// ─────────────────────────────────────────────────────────────────────────────
window.EN_TEXT_MAP = {
  // ── Toolbar / nav ──
  'Roteiro': 'Scripts',
  'Plataforma de vídeos': 'Video platform',
  'Comunidade': 'Community',
  '✓ Salvo': '✓ Saved',
  'Download HD sem marca d\'água': 'HD download, no watermark',
  'Shorts em alta agora': 'Trending Shorts right now',
  'Narração IA hiper-realista': 'Hyper-realistic AI voiceover',
  'Análise algorítmica do canal': 'Algorithmic channel analysis',
  'Editor completo · Em breve': 'Full editor · Coming soon',
  'Rastreador de origem do vídeo': 'Video origin tracker',
  'Remove legendas, setas, círculos e marcas d\'água com IA': 'AI removes captions, arrows, circles and watermarks',
  'Studio do Blublu · dissecação IA': 'Blublu Studio · AI breakdowns',

  // ── Modos do gerador ──
  '📝 Adaptar roteiro': '📝 Adapt script',
  'GRÁTIS': 'FREE',
  '✨ Roteirizar vídeo': '✨ Script from video',
  '⚠ O vídeo curto precisa ter narração': '⚠ The video needs narration',

  // ── Seção ferramentas ──
  'Feito para criadores de Vídeos curtos.': 'Built for short-form creators.',
  'Roteiro viral em segundos': 'Viral scripts in seconds',
  'Cole o Short, clique, receba 2 versões prontas para narrar. Sem edição, sem perda de tempo.': 'Paste a Short, click, get 2 versions ready to record. No editing, no wasted time.',
  'Gere narrações em português, inglês e espanhol que soam humanas. Baixe o MP3 e poste diretamente.': 'Generate human-sounding voiceovers in English, Portuguese and Spanish. Download the MP3 and post right away.',
  'BlueScore — Análise Algorítmica': 'BlueScore — Algorithmic Analysis',
  'Descubra o nível de confiança que o YouTube tem no seu canal. Score 0-100 com diagnóstico IA e recomendações acionáveis.': "See how much trust YouTube has in your channel. 0-100 score with AI diagnosis and actionable recommendations.",
  'Monitore os vídeos explodindo agora por país e nicho. Surfe o hype antes que todo mundo descubra.': 'Track the videos blowing up right now by country and niche. Ride the hype before everyone else finds it.',
  'Baixe qualquer vídeo do TikTok, Instagram e YouTube em alta qualidade para reutilizar legalmente.': 'Download any TikTok, Instagram or YouTube video in high quality for legal reuse.',
  'BlueLens — Rastreador de origem': 'BlueLens — Origin Tracker',
  'Descubra de onde veio qualquer Short. Detecte reposts, encontre o criador original e proteja seu conteúdo contra cópias não autorizadas.': 'Find where any Short came from. Detect reposts, find the original creator, and protect your content from unauthorized copies.',
  'Responda 3 perguntas e a IA cria um roteiro viral 100% original para o seu nicho. Escolha sentimento, estilo e idioma. Sem precisar de referência.': 'Answer 3 questions and the AI writes a 100% original viral script for your niche. Pick the feeling, style and language. No reference needed.',
  'BlueEditor — Editor nativo do BlueTube': "BlueEditor — BlueTube's native editor",
  'Timeline profissional, Blublu sugerindo cortes, score de viralidade em tempo real, legenda automática com Whisper e export 9:16 otimizado. Tudo sem sair do BlueTube. Masters ativos travam o preço atual antes do lançamento.': 'Pro timeline, Blublu suggesting cuts, real-time virality score, auto-captions with Whisper and optimized 9:16 export. All without leaving BlueTube. Active Masters lock in the current price before launch.',
  'BlueClean — Vídeo limpo com IA': 'BlueClean — AI-cleaned video',
  'Remove legendas, setas, marcas d\'água e qualquer overlay de vídeos automaticamente. Dois modos: padrão e agressivo. Exclusivo Master.': 'Automatically removes captions, arrows, watermarks and any overlay from videos. Two modes: standard and aggressive. Master exclusive.',
  'BlueTendências — Aula de viralização': 'BlueTendências — Virality masterclass',
  'A IA Blublu disseca virais em 5 atos cinematográficos e te ensina, de forma dinâmica e interativa, como aplicar tudo no seu canal. Cada análise é uma aula prática: projeções, receita estimada, quiz, plano de ação. Exclusivo Master.': 'The Blublu AI dissects viral videos in 5 cinematic acts and teaches you, interactively, how to apply it all to your channel. Every breakdown is a hands-on lesson: projections, estimated revenue, quiz, action plan. Master exclusive.',

  // ── Banner desafio ──
  'Chegue a 1.000 seguidores no Blue, desbloqueie seu link exclusivo e receba R$1.000 no Pix a cada 100 assinantes indicados.': 'Reach 1,000 followers on Blue, unlock your exclusive link and earn cash for every 100 referred subscribers.',
  'Ver como participar →': 'See how to join →',

  // ── Planos ──
  'Comece grátis. Faça upgrade quando quiser.': 'Start free. Upgrade whenever you want.',
  '/mês': '/mo',
  '2 roteiros por dia': '2 scripts per day',
  'Apenas Português': 'Portuguese only',
  '✗ Sem BlueVoice': '✗ No BlueVoice',
  '✗ Sem BlueScore': '✗ No BlueScore',
  '✗ Sem BlueLens': '✗ No BlueLens',
  '✗ Sem download': '✗ No downloads',
  '✗ Sem comunidade': '✗ No community',
  'Criar conta grátis': 'Sign up free',
  '9 roteiros por dia': '9 scripts per day',
  'Todos os idiomas': 'All languages',
  'Transcrição completa': 'Full transcript',
  'BlueVoice ilimitado (narração IA)': 'Unlimited BlueVoice (AI voiceover)',
  '(em breve · lock-in garantido)': '(coming soon · price locked in)',
  '✨ BlueTendências': '✨ BlueTendências',
  'Descubra tendências antes de todo mundo': 'Spot trends before everyone else',
  'BlueScore · BlueLens · Virais': 'BlueScore · BlueLens · Virals',
  'Suporte prioritário': 'Priority support',
  '🎁 13 meses pelo preço de 12 + economize R$269,88/ano no Full · R$809,88/ano no Master': '🎁 13 months for the price of 12 — save big with yearly billing',
  '· pagamento único': '· one-time payment',

  // ── Feed Instagram home ──
  'Carregando feed…': 'Loading feed…',

  // ── FAQ ──
  'O que é o BlueTube?': 'What is BlueTube?',
  'O BlueTube é uma plataforma de IA para criadores de Shorts, TikTok e Instagram Reels. Cole o link de qualquer vídeo, receba transcrição + 2 roteiros virais em segundos. Comece grátis com 2 roteiros por dia — faça upgrade para desbloquear mais.': 'BlueTube is an AI platform for Shorts, TikTok and Instagram Reels creators. Paste any video link and get the transcript + 2 viral scripts in seconds. Start free with 2 scripts a day — upgrade to unlock more.',
  'Como funciona?': 'How does it work?',
  'Cole o link de qualquer Short, TikTok ou Instagram Reels, escolha o idioma e clique em Transcrever. Nossa IA analisa o áudio, gera a transcrição completa e cria dois roteiros virais — um casual e um apelativo. Tudo em menos de 30 segundos.': 'Paste any Short, TikTok or Instagram Reels link, pick a language and click Transcribe. Our AI analyzes the audio, generates the full transcript and writes two viral scripts — one casual, one punchy. All in under 30 seconds.',
  'Preciso criar uma conta?': 'Do I need an account?',
  'Sim, e é grátis! Com a conta gratuita você recebe 2 roteiros por dia em Português. Para mais roteiros, todos os idiomas e ferramentas avançadas, conheça nossos planos Full (R$29,99/mês) e Master (R$89,99/mês).': 'Yes — and it\'s free! The free account gives you 2 scripts a day. For more scripts, every language and the advanced tools, check out the Full and Master plans.',
  'Tem limite de uso?': 'Are there usage limits?',
  'No plano gratuito você tem 2 roteiros por dia. No Full são 9 por dia, e no Master é ilimitado. O BlueVoice (narração IA) é ilimitado para assinantes Master. O BlueClean (remoção de legendas e overlays) é ilimitado para assinantes Master.': 'The free plan gives you 2 scripts a day. Full gets 9 a day, Master is unlimited. BlueVoice (AI voiceover) is unlimited for Masters. BlueClean (caption and overlay removal) is unlimited for Masters.',
  'Quais idiomas estão disponíveis?': 'Which languages are available?',
  'Português, Inglês, Espanhol, Francês, Alemão, Italiano, Japonês, Chinês, Árabe, Turco, Hindi, Coreano, Russo, Bahasa Indonesia, Tailandês e Tagalog. Você pode transcrever um vídeo em japonês e receber o roteiro em português.': 'English, Portuguese, Spanish, French, German, Italian, Japanese, Chinese, Arabic, Turkish, Hindi, Korean, Russian, Bahasa Indonesia, Thai and Tagalog. You can transcribe a Japanese video and get the script in English.',
  'Os roteiros são cópia do vídeo original?': 'Are the scripts copies of the original video?',
  'Não. São roteiros 100% originais gerados pela IA a partir da transcrição. Nunca é uma cópia — é uma reescrita viral adaptada para máximo engajamento. Sem risco de direitos autorais.': 'No. They are 100% original scripts generated by AI from the transcript. Never a copy — a viral rewrite built for maximum engagement. No copyright risk.',
  'O que é a Comunidade BlueTube?': 'What is the BlueTube Community?',
  'Um grupo no WhatsApp gratuito para todos os criadores cadastrados. Você encontra dicas de nicho, estratégias virais, suporte entre criadores e atualizações antecipadas das novas ferramentas. Aberto a qualquer usuário do BlueTube.': 'A free WhatsApp group for every registered creator. Niche tips, viral strategies, creator-to-creator support and early updates on new tools. Open to any BlueTube user.',
  'O que é o BlueClean?': 'What is BlueClean?',
  'O BlueClean remove legendas, setas, marcas d\'água e qualquer overlay de vídeos usando IA. Faça upload do vídeo e a IA detecta e remove automaticamente. Exclusivo e ilimitado para assinantes Master.': 'BlueClean removes captions, arrows, watermarks and any overlay from videos using AI. Upload the video and the AI detects and removes them automatically. Exclusive and unlimited for Masters.',
  'Meus dados ficam salvos?': 'Is my data stored?',
  'As transcrições são salvas anonimamente para melhorar a IA ao longo do tempo. Nenhum dado pessoal é vinculado ao conteúdo. Você pode solicitar exclusão dos seus dados a qualquer momento. Veja nossa': 'Transcripts are stored anonymously to improve the AI over time. No personal data is tied to the content. You can request deletion of your data at any time. See our',
  'Política de Privacidade': 'Privacy Policy',

  // ── Cookie banner ──
  'Usamos cookies para melhorar sua experiência. Ao continuar, você aceita nossa': 'We use cookies to improve your experience. By continuing, you accept our',
  'Aceitar': 'Accept',

  // ── Upgrade modal ──
  'Você vai ficar': 'Are you falling',
  'para trás?': 'behind?',
  'Você usou seus 2 roteiros gratuitos de hoje.': "You've used your 2 free scripts today.",
  'Enquanto você espera, seus concorrentes já estão postando.': 'While you wait, your competitors are already posting.',
  '-25% + 1 mês grátis': '-25% + 1 month free',
  '✓ 9 roteiros/dia': '✓ 9 scripts/day',
  '✓ Todos os idiomas': '✓ All languages',
  '✓ Download .TXT e .SRT': '✓ .TXT and .SRT download',
  '✓ Comunidade exclusiva': '✓ Exclusive community',
  '✓ Buscador de Virais': '✓ Viral finder',
  '✓ Roteiros ilimitados': '✓ Unlimited scripts',
  '✓ BlueVoice ilimitado': '✓ Unlimited BlueVoice',
  '✓ BlueClean (remove overlays)': '✓ BlueClean (removes overlays)',
  '✓ BaixaBlue · BlueEditor (em breve)': '✓ BaixaBlue · BlueEditor (soon)',
  '✓ BlueClean · BlueEditor (em breve)': '✓ BlueClean · BlueEditor (soon)',

  // ── Lang lock modal ──
  'Este idioma está disponível apenas no plano Full ou Master.': 'This language is only available on the Full or Master plan.',
  'Faça upgrade e crie roteiros virais em qualquer idioma do mundo.': 'Upgrade and create viral scripts in any language in the world.',
  '✓ Comunidade': '✓ Community',
  'Desbloquear todos os idiomas →': 'Unlock all languages →',
  'Criar conta gratuita': 'Sign up free',

  // ── Auth / OTP ──
  'Digite seu email e enviaremos': "Enter your email and we'll send",
  'um link para redefinir sua senha.': 'a link to reset your password.',
  '← Voltar ao login': '← Back to log in',
  'Tenho 16 anos ou mais': "I'm 16 or older",
  'Verifique seu email': 'Check your email',
  'Enviamos um código de 6 dígitos para': 'We sent a 6-digit code to',
  'Não achou o email?': "Can't find the email?",
  'spam / lixo eletrônico': 'spam / junk folder',
  '— o código costuma cair lá. Marque como "não é spam" pra facilitar os próximos.': '— the code usually lands there. Mark it "not spam" to make the next ones easier.',
  'Verificar código →': 'Verify code →',
  'Reenviar código': 'Resend code',
  'Verifique também a caixa de spam': 'Also check your spam folder',

  // ── Roteirizar do zero (wizard) ──
  'Resuma o que acontece no vídeo': 'Summarize what happens in the video',
  'Descreva em poucas palavras a ação principal do vídeo.': "Describe the video's main action in a few words.",
  'Próximo →': 'Next →',
  'Que sentimento você quer passar?': 'What feeling do you want to convey?',
  'Selecione um ou mais.': 'Pick one or more.',
  '😮 Admiração': '😮 Awe',
  '😨 Tensão': '😨 Tension',
  '🔥 Motivação': '🔥 Motivation',
  '😂 Humor': '😂 Humor',
  '🤯 Surpresa': '🤯 Surprise',
  '😢 Emoção': '😢 Emotion',
  'Qual o nicho do seu canal?': "What's your channel's niche?",
  'Selecione o que mais se encaixa.': 'Pick the closest fit.',
  '🔬 Ciência': '🔬 Science',
  '💰 Finanças': '💰 Finance',
  '🏋️ Saúde/Fitness': '🏋️ Health/Fitness',
  '🐶 Animais': '🐶 Animals',
  '🍳 Culinária': '🍳 Cooking',
  '⚽ Esportes': '⚽ Sports',
  '🎮 Games': '🎮 Gaming',
  '💡 Curiosidades': '💡 Curiosities',
  'Em qual idioma você quer o roteiro?': 'Which language do you want the script in?',
  'O roteiro será adaptado culturalmente para o idioma escolhido.': 'The script is culturally adapted to the chosen language.',
  'Gerar Roteiro ✨': 'Generate Script ✨',
  'Analisando frames do vídeo...': 'Analyzing video frames...',
  'Roteiros gerados ✨': 'Scripts ready ✨',
  'Recomeçar': 'Start over',
  '✏️ Pedir ajuste': '✏️ Request tweak',
  '✏️ Pedir ajuste com IA': '✏️ Tweak with AI',

  // ── Resultados ──
  '🌍 Tradução': '🌍 Translation',
  '💬 TÍTULO CASUAL': '💬 CASUAL TITLE',
  '🔥 TÍTULO APELATIVO': '🔥 PUNCHY TITLE',
  '🌍 TÍTULO ORIGINAL TRADUZIDO': '🌍 TRANSLATED ORIGINAL TITLE',
  '📋 Copiar título': '📋 Copy title',
  'Leve, natural e próximo do público': 'Light, natural, audience-friendly',
  'Hook poderoso, máximo impacto': 'Powerful hook, maximum impact',
  'Este roteiro foi útil?': 'Was this script useful?',
  '👍 Sim': '👍 Yes',
  '👎 Não': '👎 No',
  '🌍 Tradução Fiel': '🌍 Faithful Translation',
  'O original traduzido — moedas e termos adaptados': 'The original translated — currency and terms adapted',
  'Tradução Fiel é exclusiva Full e Master': 'Faithful Translation is Full and Master exclusive',
  'O vídeo original traduzido com moedas e termos adaptados': 'The original video translated with currency and terms adapted',
  '⚡ Desbloquear agora': '⚡ Unlock now',
  'Esse homem encontrou uma pérola avaliada em R$ 18 milhões dentro de um molusco gigante. Ele guardou debaixo da cama por dez anos sem fazer ideia do valor. Quando finalmente levou para avaliar, os especialistas confirmaram: era a maior já encontrada no mundo. A tradução fiel mantém cada detalhe do vídeo original, com moedas e termos adaptados para o seu público.': 'This man found a pearl worth $3.5 million inside a giant clam. He kept it under his bed for ten years with no idea of its value. When he finally had it appraised, experts confirmed: it was the largest ever found. Faithful Translation keeps every detail of the original video, with currency and terms adapted to your audience.',

  // ── Comunidade (modais) ──
  'Grátis para todos os criadores': 'Free for all creators',
  'Você está prestes a entrar num grupo exclusivo no WhatsApp com': "You're about to join an exclusive WhatsApp group with",
  'criadores dark que fazem milhões de views por mês.': 'faceless creators pulling millions of views a month.',
  'Dentro do grupo você vai encontrar:': "Inside the group you'll find:",
  '✦ Dicas e estratégias virais em primeira mão': '✦ First-hand viral tips and strategies',
  '✦ Suporte de criadores experientes': '✦ Support from experienced creators',
  '✦ Nichos em alta antes de todo mundo': '✦ Hot niches before everyone else',
  '✦ Ferramentas e atualizações antecipadas': '✦ Early access to tools and updates',
  'Entrar na Comunidade WhatsApp': 'Join the WhatsApp Community',
  'Após entrar no grupo, o botão ficará marcado na sua conta': 'After joining, the button stays marked on your account',
  'milhões de views por mês:': 'millions of views a month:',
  'Treinamentos oficiais em vídeo': 'Official video trainings',
  '— passo a passo pra viralizar, com espaço pra tirar dúvidas': '— step-by-step to going viral, with room for questions',
  '— poste resultados, dúvidas e ideias (texto, foto, vídeo e áudio)': '— post results, questions and ideas (text, photo, video and audio)',
  '💬 Comentários com curtidas e respostas — os melhores sobem': '💬 Comments with likes and replies — the best rise to the top',
  '👑 Destaque no seu perfil: anel dourado Master ou azul Full': '👑 Profile highlight: gold Master ring or blue Full ring',
  '🤝 Networking direto com quem já vive de dark channels': '🤝 Direct networking with people already living off faceless channels',
  'Já sou assinante — entrar': "I'm a subscriber — sign in",

  // ── Perfil / cancelamento ──
  '⚠ CANCELAMENTO AGENDADO': '⚠ CANCELLATION SCHEDULED',
  'Voce mantem acesso completo ate la. Nao havera mais cobrancas.': 'You keep full access until then. No further charges.',
  'Próxima cobrança': 'Next charge',
  'Acesso premium até': 'Premium until',
  '🎁 Indique e ganhe 1 mês grátis': '🎁 Refer a friend, get 1 month free',
  'Toque na foto pra trocar. O nome é o seu usuário.': 'Tap the photo to change it. The name is your username.',
  'Deletar minha conta': 'Delete my account',
  'Não pode ser! Me fala que você clicou por engano?': 'No way! Tell me you clicked by mistake?',
  'Não me abandone! 😢': "Don't leave me! 😢",
  'Por que você quer cancelar?': 'Why do you want to cancel?',

  // ── Ferramenta em breve ──
  'Esta ferramenta está sendo desenvolvida e chegará em breve para assinantes Master.': 'This tool is in development and coming soon for Master subscribers.',
  '✨ Roteirizar vídeo — chegando em breve': '✨ Script from video — coming soon',

  // ── Diversos ──
  'Buscando Short…': 'Fetching video…',
  '↓ .TXT': '↓ .TXT',
  'Informações da conta': 'Account details',
  '↪ Sair': '↪ Log out',

  // ── Oferta de Ativação (popup pós-cadastro) ──
  'Oferta de boas-vindas —': 'Welcome offer —',
  'só nesta tela': 'this screen only',
  'Master por': 'Master at',
  'R$ 44,99/mês nos seus 2 primeiros meses': '50% off your first 2 months',
  '— depois volta ao preço normal.': '— then back to full price.',
  '🔥 Virais': '🔥 Virals',
  '— os vídeos explodindo AGORA no TikTok, YouTube e Instagram, com views reais': '— the videos blowing up RIGHT NOW on TikTok, YouTube and Instagram, with real views',
  '— a IA limpa o vídeo: remove legendas, setas e marcas d\'água sozinha': '— AI cleans the video: removes captions, arrows and watermarks on its own',
  '— baixe em HD de todas as plataformas, sem anúncio e com metadados limpos': '— download in HD from every platform, ad-free, with clean metadata',
  '⏳ Expira em': '⏳ Expires in',
  '· essa oferta não se repete — nem amanhã, nem no upgrade': "· this offer won't repeat — not tomorrow, not at upgrade",
  '👑 Ativar meu Master com 50% →': '👑 Activate my Master at 50% off →',
  'Prefiro pagar preço cheio depois': "I'd rather pay full price later",
  'Tem certeza?': 'Are you sure?',
  'Essa oferta': 'This offer',
  'não volta': 'never comes back',
  '. Fechando agora, o Master fica R$ 89,99/mês pra sempre.': '. Close it now and Master stays full price forever.',
  '← Voltar pra oferta': '← Back to the offer',
  'Perder a oferta pra sempre': 'Lose the offer forever',
};

// Placeholders PT → EN (inputs/textareas por id)
window.EN_PH_MAP = {
  zeroSummary: 'E.g.: A guy trying to balance 100 cups of water...',
  adjustInput: 'E.g.: make it shorter, add more tension...',
  cancelOtherBox: 'Tell us more…',
};
