// api/auth.js — BlueTube Auth + Language Detection
// Supabase Auth: signup, signin, OTP verify, reset password
// Also handles GET /api/auth?action=lang for language detection
import crypto from 'crypto';

// ── LANGUAGE DETECTION DATA ────────────────────────────────────────────────
const COUNTRY_LANG = {
  BR:'pt',PT:'pt',
  US:'en',GB:'en',AU:'en',CA:'en',NZ:'en',IE:'en',ZA:'en',NG:'en',GH:'en',KE:'en',
  ES:'es',MX:'es',AR:'es',CO:'es',CL:'es',PE:'es',VE:'es',EC:'es',GT:'es',CU:'es',BO:'es',DO:'es',HN:'es',PY:'es',SV:'es',NI:'es',CR:'es',PA:'es',UY:'es',
  FR:'fr',BE:'fr',CD:'fr',CI:'fr',
  DE:'de',AT:'de',
  IT:'it',
  JP:'ja',
  CN:'zh',TW:'zh',HK:'zh',SG:'zh',
  SA:'ar',AE:'ar',EG:'ar',MA:'ar',DZ:'ar',TN:'ar',IQ:'ar',
  TR:'tr',
  IN:'hi',
  KR:'ko',
  RU:'ru',BY:'ru',KZ:'ru',
  ID:'id',
  TH:'th',
  PH:'tl',
};

// ── CURRENCY BY COUNTRY ───────────────────────────────────────────────────
const COUNTRY_CURRENCY = {
  US:'USD',GB:'GBP',AU:'AUD',CA:'CAD',NZ:'NZD',
  BR:'BRL',PT:'EUR',
  ES:'EUR',MX:'MXN',AR:'ARS',CO:'COP',CL:'CLP',PE:'PEN',
  FR:'EUR',BE:'EUR',DE:'EUR',AT:'EUR',IT:'EUR',
  JP:'JPY',CN:'CNY',TW:'TWD',HK:'HKD',SG:'SGD',
  SA:'SAR',AE:'AED',EG:'EGP',
  TR:'TRY',IN:'INR',KR:'KRW',RU:'RUB',
  ID:'IDR',TH:'THB',PH:'PHP',
  IE:'EUR',ZA:'ZAR',NG:'NGN',
};
const CURRENCY_SYMBOLS = {
  USD:'$',EUR:'€',GBP:'£',JPY:'¥',CNY:'¥',KRW:'₩',INR:'₹',
  TRY:'₺',RUB:'₽',BRL:'R$',MXN:'MX$',ARS:'ARS$',COP:'COP$',
  CLP:'CLP$',PEN:'S/',AUD:'A$',CAD:'C$',NZD:'NZ$',
  SAR:'﷼',AED:'د.إ',EGP:'E£',TWD:'NT$',HKD:'HK$',SGD:'S$',
  IDR:'Rp',THB:'฿',PHP:'₱',ZAR:'R',NGN:'₦',
};

const TRANSLATIONS = {
  pt:{hero_1:'Seu novo vídeo com',hero_2:'milhões de views',hero_3:'começa agora.',hero_badge:'Grátis · 2 roteiros/dia · Sem cadastro',hero_sub:'Cole qualquer link de YouTube Shorts, escolha o idioma e receba transcrição + 2 roteiros virais prontos para narrar.',btn_go:'Transcrever + Roteiro ↗',tab_transcript:'📝 Transcrição',tab_casual:'💬 Casual',tab_appeal:'🔥 Apelativo',copy:'📋 Copiar',copied:'✓ Copiado!',new_short:'Novo Short',l1:'Buscando Short…',l2:'Analisando áudio…',l3:'Processando fala…',l4:'Gerando transcrição…',l5:'Quase pronto…',generating:'Criando seu próximo roteiro viral…',err_empty:'Cole um link de YouTube Shorts antes de continuar.',err_invalid:'Link inválido. Use: youtube.com/shorts/...',placeholder:'https://www.youtube.com/shorts/...',nav_enter:'Entrar',nav_upgrade:'⚡ Upgrade',nav_community:'Comunidade',nav_logout:'Sair',auth_title:'Crie sua conta ou entre',tab_login:'Entrar',tab_signup:'Criar conta',email_ph:'seu@email.com',pwd_ph:'Senha',pwd_min:'Criar senha (mín. 6 caracteres)',confirm_ph:'Confirmar senha',btn_login:'Entrar →',btn_signup:'Criar conta →',forgot:'Esqueci minha senha',forgot_btn:'Enviar link de redefinição →',back_login:'← Voltar ao login',sending:'Enviando link…',link_sent:'✓ Link enviado! Verifique seu email.',signing_in:'Entrando…',welcome:'Bem-vindo! 🎉',creating:'Criando conta…',up_live:'pessoas gerando roteiros agora',up_timer:'Seu limite reseta em',up_cta:'Quero acesso agora →',up_or:'ou crie sua conta gratuita',up_email_btn:'Criar conta por E-mail',plan_monthly:'Mensal',plan_annual:'Anual',plan_save:'Economize 25%',plan_popular:'Mais popular',plan_monthly_label:'cobrado mensalmente',plan_annual_label:'cobrado anualmente',plan_full_btn:'Assinar Full →',plan_master_btn:'Assinar Master →',price_increase:'A partir do mês que vem o valor aumentará $10 no Full e $20 no Master. Assine agora!',f1:'9 roteiros por dia',f2:'Todos os 9 idiomas',f3:'Transcrição completa',f4:'Download .TXT e .SRT',f5:'Comunidade exclusiva',f6:'IA que aprende com você',f7:'Roteiros ilimitados',m1:'Roteiros ilimitados',m2:'Todos os idiomas',m3:'Chat IA personalizado',m4:'IA de voz hiper realista',m5:'Download de vídeo HD',m6:'Buscador de vídeo viral',m7:'Comunidade exclusiva',m8:'Suporte prioritário',comm_title:'Comunidade BlueTube',comm_sub:'Exclusivo para assinantes',comm_btn:'Entrar na Comunidade WhatsApp',comm_joined:'✓ Comunidade',profile_since:'Membro desde',profile_plan:'Plano atual',profile_days:'Dias como premium',profile_until:'Acesso premium até',profile_pwd:'🔑 Alterar senha — link enviado por email',profile_support:'💬 Falar com suporte',profile_upgrade:'⚡ Fazer upgrade',profile_master:'👑 Ir para o Master →',profile_logout:'↪ Sair',profile_cancel:'Cancelar assinatura',profile_info:'Informações da conta',support_ph:'Descreva sua dúvida ou problema…',support_btn:'Enviar mensagem →',cancel_blublu:'Não pode ser! Me fala que você clicou por engano? Não me abandone! 😢',cancel_why:'Por que você quer cancelar?',cancel_r1:'Estou tendo dificuldade em usar o BlueTube',cancel_r2:'Muito caro para mim agora',cancel_r3:'Não preciso mais do serviço',cancel_r4:'Outro motivo',cancel_give_chance:'Dar mais uma chance! 💙',cancel_confirm:'Confirmar cancelamento',cancel_offer_title:'Espera! Temos uma oferta especial',cancel_offer_sub:'Como você é um cliente especial, queremos oferecer $3 de desconto na sua próxima mensalidade.',cancel_accept:'Aceitar oferta 💙',cancel_proceed:'Cancelar assinatura',cancel_bye:'Vou ter saudades do que a gente viveu!',cancel_bye_sub:'Sua assinatura foi cancelada. Você continua com acesso premium até o final do período pago.',cancel_close:'Fechar',blublu_hello:'Olá! Eu sou o <strong>BluBlu</strong> 🤖<br>Como está sendo sua experiência?<br>Está gostando do BlueTube?',blublu_ph:'Deixe seu feedback…',blublu_send:'Enviar feedback →',blublu_thanks:'Estou levando sua mensagem para meu dono, obrigado pelo seu feedback! 🚀',faq_title:'Perguntas frequentes.',faq_eye:'Dúvidas frequentes',fomo_censored:'Nome censurado a pedido do criador',fomo_protected:'Identidade preservada',fomo_anon:'Criador prefere anonimato',plans_eye:'Planos',plans_title:'Escolha seu plano.',footer_copy:'© 2025 BlueTube · Criador Viral',new_pwd:'Criar nova senha',new_pwd_sub:'Digite e confirme sua nova senha abaixo.',pwd_new_ph:'Nova senha (mín. 6 caracteres)',pwd_confirm_new:'Confirmar nova senha',save_pwd:'Salvar nova senha →'},
  en:{hero_1:'Your next video with',hero_2:'millions of views',hero_3:'starts now.',hero_badge:'Free · 2 scripts/day · No signup',hero_sub:'Paste any YouTube Shorts link, choose the language and get a transcript + 2 viral scripts ready to record.',btn_go:'Transcribe + Script ↗',tab_transcript:'📝 Transcript',tab_casual:'💬 Casual',tab_appeal:'🔥 Engaging',copy:'📋 Copy',copied:'✓ Copied!',new_short:'New Short',l1:'Fetching Short…',l2:'Analyzing audio…',l3:'Processing speech…',l4:'Generating transcript…',l5:'Almost done…',generating:'Creating your next viral script…',err_empty:'Paste a YouTube Shorts link to continue.',err_invalid:'Invalid link. Use: youtube.com/shorts/...',placeholder:'https://www.youtube.com/shorts/...',nav_enter:'Sign In',nav_upgrade:'⚡ Upgrade',nav_community:'Community',nav_logout:'Sign Out',auth_title:'Create your account or sign in',tab_login:'Sign In',tab_signup:'Create account',email_ph:'your@email.com',pwd_ph:'Password',pwd_min:'Create password (min. 6 chars)',confirm_ph:'Confirm password',btn_login:'Sign In →',btn_signup:'Create account →',forgot:'Forgot my password',forgot_btn:'Send reset link →',back_login:'← Back to login',sending:'Sending link…',link_sent:'✓ Link sent! Check your email.',signing_in:'Signing in…',welcome:'Welcome! 🎉',creating:'Creating account…',up_live:'people generating scripts right now',up_timer:'Your limit resets in',up_cta:'Get access now →',up_or:'or create your free account',up_email_btn:'Create account by Email',plan_monthly:'Monthly',plan_annual:'Annual',plan_save:'Save 25%',plan_popular:'Most popular',plan_monthly_label:'billed monthly',plan_annual_label:'billed annually',plan_full_btn:'Subscribe Full →',plan_master_btn:'Subscribe Master →',price_increase:'Starting next month price increases $10 on Full and $20 on Master. Subscribe now!',f1:'9 scripts per day',f2:'All 9 languages',f3:'Full transcript',f4:'Download .TXT and .SRT',f5:'Exclusive community',f6:'AI that learns with you',f7:'Unlimited scripts',m1:'Unlimited scripts',m2:'All languages',m3:'Custom AI chat',m4:'Hyper-realistic AI voice',m5:'HD video download',m6:'Viral video finder',m7:'Exclusive community',m8:'Priority support',comm_title:'BlueTube Community',comm_sub:'Exclusive for subscribers',comm_btn:'Join WhatsApp Community',comm_joined:'✓ Community',profile_since:'Member since',profile_plan:'Current plan',profile_days:'Days as premium',profile_until:'Premium access until',profile_pwd:'🔑 Change password — link sent by email',profile_support:'💬 Talk to support',profile_upgrade:'⚡ Upgrade plan',profile_master:'👑 Go to Master →',profile_logout:'↪ Sign out',profile_cancel:'Cancel subscription',profile_info:'Account information',support_ph:'Describe your question or issue…',support_btn:'Send message →',cancel_blublu:"No way! Tell me you clicked by mistake? Don't leave me! 😢",cancel_why:'Why do you want to cancel?',cancel_r1:"I'm having trouble using BlueTube",cancel_r2:'Too expensive for me right now',cancel_r3:"I don't need the service anymore",cancel_r4:'Other reason',cancel_give_chance:'Give it another chance! 💙',cancel_confirm:'Confirm cancellation',cancel_offer_title:'Wait! We have a special offer',cancel_offer_sub:"As a special customer, we'd like to offer you $3 off your next monthly bill.",cancel_accept:'Accept offer 💙',cancel_proceed:'Cancel subscription',cancel_bye:"I'll miss what we had!",cancel_bye_sub:'Your subscription has been cancelled. You keep premium access until the end of the paid period.',cancel_close:'Close',blublu_hello:"Hi! I'm <strong>BluBlu</strong> 🤖<br>How's your experience?<br>Are you enjoying BlueTube?",blublu_ph:'Leave your feedback…',blublu_send:'Send feedback →',blublu_thanks:"I'm passing your message to my owner, thanks for your feedback! 🚀",faq_title:'Frequently asked questions.',faq_eye:'FAQ',fomo_censored:"Name censored at creator's request",fomo_protected:'Identity preserved',fomo_anon:'Creator prefers anonymity',plans_eye:'Plans',plans_title:'Choose your plan.',footer_copy:'© 2025 BlueTube · Viral Creator',new_pwd:'Create new password',new_pwd_sub:'Enter and confirm your new password below.',pwd_new_ph:'New password (min. 6 chars)',pwd_confirm_new:'Confirm new password',save_pwd:'Save new password →'},
  es:{hero_1:'Tu próximo video con',hero_2:'millones de vistas',hero_3:'empieza ahora.',hero_badge:'Gratis · 2 guiones/día · Sin registro',hero_sub:'Pega cualquier enlace de YouTube Shorts, elige el idioma y recibe transcripción + 2 guiones virales listos para grabar.',btn_go:'Transcribir + Guión ↗',tab_transcript:'📝 Transcripción',tab_casual:'💬 Casual',tab_appeal:'🔥 Impactante',copy:'📋 Copiar',copied:'✓ ¡Copiado!',new_short:'Nuevo Short',l1:'Buscando Short…',l2:'Analizando audio…',l3:'Procesando voz…',l4:'Generando transcripción…',l5:'Casi listo…',generating:'Creando tu próximo guión viral…',err_empty:'Pega un enlace de YouTube Shorts para continuar.',err_invalid:'Enlace inválido. Usa: youtube.com/shorts/...',placeholder:'https://www.youtube.com/shorts/...',nav_enter:'Entrar',nav_upgrade:'⚡ Mejorar',nav_community:'Comunidad',nav_logout:'Salir',auth_title:'Crea tu cuenta o inicia sesión',tab_login:'Entrar',tab_signup:'Crear cuenta',email_ph:'tu@email.com',pwd_ph:'Contraseña',pwd_min:'Crear contraseña (mín. 6 caracteres)',confirm_ph:'Confirmar contraseña',btn_login:'Entrar →',btn_signup:'Crear cuenta →',forgot:'Olvidé mi contraseña',forgot_btn:'Enviar enlace →',back_login:'← Volver al login',sending:'Enviando enlace…',link_sent:'✓ ¡Enlace enviado! Revisa tu email.',signing_in:'Entrando…',welcome:'¡Bienvenido! 🎉',creating:'Creando cuenta…',up_live:'personas generando guiones ahora',up_timer:'Tu límite se reinicia en',up_cta:'Quiero acceso ahora →',up_or:'o crea tu cuenta gratuita',up_email_btn:'Crear cuenta por Email',plan_monthly:'Mensual',plan_annual:'Anual',plan_save:'Ahorra 25%',plan_popular:'Más popular',plan_monthly_label:'cobrado mensualmente',plan_annual_label:'cobrado anualmente',plan_full_btn:'Suscribirse Full →',plan_master_btn:'Suscribirse Master →',price_increase:'A partir del próximo mes el precio aumentará $10 en Full y $20 en Master.',f1:'9 guiones por día',f2:'Los 9 idiomas',f3:'Transcripción completa',f4:'Descarga .TXT y .SRT',f5:'Comunidad exclusiva',f6:'IA que aprende contigo',f7:'Guiones ilimitados',m1:'Guiones ilimitados',m2:'Todos los idiomas',m3:'Chat IA personalizado',m4:'Voz IA hiper-realista',m5:'Descarga de video HD',m6:'Buscador de videos virales',m7:'Comunidad exclusiva',m8:'Soporte prioritario',comm_title:'Comunidad BlueTube',comm_sub:'Exclusivo para suscriptores',comm_btn:'Unirse a la Comunidad WhatsApp',comm_joined:'✓ Comunidad',profile_since:'Miembro desde',profile_plan:'Plan actual',profile_days:'Días como premium',profile_until:'Acceso premium hasta',profile_pwd:'🔑 Cambiar contraseña',profile_support:'💬 Hablar con soporte',profile_upgrade:'⚡ Mejorar plan',profile_master:'👑 Ir al Master →',profile_logout:'↪ Cerrar sesión',profile_cancel:'Cancelar suscripción',profile_info:'Información de la cuenta',support_ph:'Describe tu duda o problema…',support_btn:'Enviar mensaje →',cancel_blublu:'¡No puede ser! ¿Me dices que hiciste clic por error? ¡No me abandones! 😢',cancel_why:'¿Por qué quieres cancelar?',cancel_r1:'Tengo dificultades para usar BlueTube',cancel_r2:'Es muy caro para mí ahora',cancel_r3:'Ya no necesito el servicio',cancel_r4:'Otro motivo',cancel_give_chance:'¡Dale otra oportunidad! 💙',cancel_confirm:'Confirmar cancelación',cancel_offer_title:'¡Espera! Tenemos una oferta especial',cancel_offer_sub:'Como cliente especial, queremos ofrecerte $3 de descuento en tu próxima mensualidad.',cancel_accept:'Aceptar oferta 💙',cancel_proceed:'Cancelar suscripción',cancel_bye:'¡Voy a extrañar lo que vivimos!',cancel_bye_sub:'Tu suscripción fue cancelada. Mantienes acceso premium hasta el final del período pagado.',cancel_close:'Cerrar',blublu_hello:'¡Hola! Soy <strong>BluBlu</strong> 🤖<br>¿Cómo va tu experiencia?<br>¿Estás disfrutando BlueTube?',blublu_ph:'Deja tu feedback…',blublu_send:'Enviar feedback →',blublu_thanks:'¡Estoy llevando tu mensaje a mi dueño, gracias! 🚀',faq_title:'Preguntas frecuentes.',faq_eye:'Preguntas frecuentes',fomo_censored:'Nombre censurado a petición del creador',fomo_protected:'Identidad preservada',fomo_anon:'El creador prefiere el anonimato',plans_eye:'Planes',plans_title:'Elige tu plan.',footer_copy:'© 2025 BlueTube · Creador Viral',new_pwd:'Crear nueva contraseña',new_pwd_sub:'Ingresa y confirma tu nueva contraseña.',pwd_new_ph:'Nueva contraseña (mín. 6 caracteres)',pwd_confirm_new:'Confirmar nueva contraseña',save_pwd:'Guardar nueva contraseña →'},
  fr:{hero_1:'Votre prochaine vidéo avec',hero_2:'des millions de vues',hero_3:'commence maintenant.',hero_badge:'Gratuit · 2 scripts/jour · Sans inscription',hero_sub:"Collez n'importe quel lien YouTube Shorts, choisissez la langue et recevez la transcription + 2 scripts viraux prêts à enregistrer.",btn_go:'Transcrire + Script ↗',tab_transcript:'📝 Transcription',tab_casual:'💬 Casual',tab_appeal:'🔥 Percutant',copy:'📋 Copier',copied:'✓ Copié!',new_short:'Nouveau Short',l1:'Recherche du Short…',l2:'Analyse audio…',l3:'Traitement vocal…',l4:'Génération de la transcription…',l5:'Presque prêt…',generating:'Création de votre prochain script viral…',err_empty:'Collez un lien YouTube Shorts pour continuer.',err_invalid:'Lien invalide. Utilisez: youtube.com/shorts/...',placeholder:'https://www.youtube.com/shorts/...',nav_enter:'Connexion',nav_upgrade:'⚡ Améliorer',nav_community:'Communauté',nav_logout:'Déconnexion',auth_title:'Créez votre compte ou connectez-vous',tab_login:'Connexion',tab_signup:'Créer un compte',email_ph:'votre@email.com',pwd_ph:'Mot de passe',pwd_min:'Créer un mot de passe (min. 6 caractères)',confirm_ph:'Confirmer le mot de passe',btn_login:'Se connecter →',btn_signup:'Créer un compte →',forgot:'Mot de passe oublié',forgot_btn:'Envoyer le lien →',back_login:'← Retour à la connexion',sending:'Envoi du lien…',link_sent:'✓ Lien envoyé! Vérifiez votre email.',signing_in:'Connexion…',welcome:'Bienvenue! 🎉',creating:'Création du compte…',up_live:'personnes générant des scripts maintenant',up_timer:'Votre limite se réinitialise dans',up_cta:"Je veux l'accès maintenant →",up_or:'ou créez votre compte gratuit',up_email_btn:'Créer un compte par Email',plan_monthly:'Mensuel',plan_annual:'Annuel',plan_save:'Économisez 25%',plan_popular:'Le plus populaire',plan_monthly_label:'facturé mensuellement',plan_annual_label:'facturé annuellement',plan_full_btn:"S'abonner Full →",plan_master_btn:"S'abonner Master →",price_increase:"À partir du mois prochain le prix augmentera de $10 sur Full et $20 sur Master.",f1:'9 scripts par jour',f2:'Les 9 langues',f3:'Transcription complète',f4:'Téléchargement .TXT et .SRT',f5:'Communauté exclusive',f6:'IA qui apprend avec vous',f7:'Scripts illimités',m1:'Scripts illimités',m2:'Toutes les langues',m3:'Chat IA personnalisé',m4:'Voix IA hyper-réaliste',m5:'Téléchargement vidéo HD',m6:'Chercheur de vidéos virales',m7:'Communauté exclusive',m8:'Support prioritaire',comm_title:'Communauté BlueTube',comm_sub:'Exclusif pour les abonnés',comm_btn:'Rejoindre la Communauté WhatsApp',comm_joined:'✓ Communauté',profile_since:'Membre depuis',profile_plan:'Plan actuel',profile_days:'Jours premium',profile_until:"Accès premium jusqu'au",profile_pwd:'🔑 Changer le mot de passe',profile_support:'💬 Parler au support',profile_upgrade:'⚡ Améliorer le plan',profile_master:'👑 Aller au Master →',profile_logout:'↪ Déconnexion',profile_cancel:"Annuler l'abonnement",profile_info:'Informations du compte',support_ph:'Décrivez votre question ou problème…',support_btn:'Envoyer le message →',cancel_blublu:"Non! Dis-moi que tu as cliqué par erreur? Ne m'abandonne pas! 😢",cancel_why:'Pourquoi voulez-vous annuler?',cancel_r1:"J'ai du mal à utiliser BlueTube",cancel_r2:'Trop cher pour moi en ce moment',cancel_r3:"Je n'ai plus besoin du service",cancel_r4:'Autre raison',cancel_give_chance:'Donnez-lui une autre chance! 💙',cancel_confirm:"Confirmer l'annulation",cancel_offer_title:'Attendez! Nous avons une offre spéciale',cancel_offer_sub:'En tant que client spécial, nous souhaitons vous offrir $3 de réduction.',cancel_accept:"Accepter l'offre 💙",cancel_proceed:"Annuler l'abonnement",cancel_bye:"Je vais regretter ce qu'on a vécu!",cancel_bye_sub:"Votre abonnement a été annulé. Vous gardez l'accès premium jusqu'à la fin de la période payée.",cancel_close:'Fermer',blublu_hello:'Bonjour! Je suis <strong>BluBlu</strong> 🤖<br>Comment se passe votre expérience?<br>Vous appréciez BlueTube?',blublu_ph:'Laissez votre avis…',blublu_send:"Envoyer l'avis →",blublu_thanks:'Je transmets votre message à mon propriétaire, merci! 🚀',faq_title:'Questions fréquentes.',faq_eye:'Questions fréquentes',fomo_censored:'Nom censuré à la demande du créateur',fomo_protected:'Identité préservée',fomo_anon:"Le créateur préfère l'anonymat",plans_eye:'Plans',plans_title:'Choisissez votre plan.',footer_copy:'© 2025 BlueTube · Créateur Viral',new_pwd:'Créer un nouveau mot de passe',new_pwd_sub:'Entrez et confirmez votre nouveau mot de passe.',pwd_new_ph:'Nouveau mot de passe (min. 6 caractères)',pwd_confirm_new:'Confirmer le nouveau mot de passe',save_pwd:'Enregistrer le mot de passe →'},
  hi:{hero_1:'आपका अगला वीडियो',hero_2:'लाखों व्यूज़ के साथ',hero_3:'अभी शुरू होता है।',hero_badge:'मुफ़्त · 2 स्क्रिप्ट/दिन · बिना साइनअप',hero_sub:'कोई भी YouTube Shorts लिंक डालें, भाषा चुनें और ट्रांसक्रिप्ट + 2 वायरल स्क्रिप्ट पाएं।',btn_go:'ट्रांसक्राइब + स्क्रिप्ट ↗',tab_transcript:'📝 ट्रांसक्रिप्ट',tab_casual:'💬 कैज़ुअल',tab_appeal:'🔥 प्रभावशाली',copy:'📋 कॉपी',copied:'✓ कॉपी हो गया!',new_short:'नया Short',l1:'Short खोज रहे हैं…',l2:'ऑडियो विश्लेषण…',l3:'आवाज़ प्रोसेसिंग…',l4:'ट्रांसक्रिप्ट बना रहे हैं…',l5:'लगभग तैयार…',generating:'अगली वायरल स्क्रिप्ट बना रहे हैं…',err_empty:'जारी रखने के लिए YouTube Shorts लिंक डालें।',err_invalid:'अमान्य लिंक। उपयोग करें: youtube.com/shorts/...',placeholder:'https://www.youtube.com/shorts/...',nav_enter:'साइन इन',nav_upgrade:'⚡ अपग्रेड',nav_community:'समुदाय',nav_logout:'लॉग आउट',auth_title:'खाता बनाएं या साइन इन करें',tab_login:'साइन इन',tab_signup:'खाता बनाएं',email_ph:'आपका@email.com',pwd_ph:'पासवर्ड',pwd_min:'पासवर्ड बनाएं (कम से कम 6 अक्षर)',confirm_ph:'पासवर्ड की पुष्टि करें',btn_login:'साइन इन →',btn_signup:'खाता बनाएं →',forgot:'पासवर्ड भूल गए',forgot_btn:'रीसेट लिंक भेजें →',back_login:'← लॉगिन पर वापस',sending:'लिंक भेज रहे हैं…',link_sent:'✓ लिंक भेजा! अपना ईमेल जांचें।',signing_in:'साइन इन हो रहे हैं…',welcome:'स्वागत है! 🎉',creating:'खाता बना रहे हैं…',up_live:'लोग अभी स्क्रिप्ट बना रहे हैं',up_timer:'आपकी सीमा रीसेट होगी',up_cta:'अभी एक्सेस पाएं →',up_or:'या मुफ़्त खाता बनाएं',up_email_btn:'Email से खाता बनाएं',plan_monthly:'मासिक',plan_annual:'वार्षिक',plan_save:'25% बचाएं',plan_popular:'सबसे लोकप्रिय',plan_monthly_label:'मासिक बिलिंग',plan_annual_label:'वार्षिक बिलिंग',plan_full_btn:'Full सब्सक्राइब करें →',plan_master_btn:'Master सब्सक्राइब करें →',price_increase:'अगले महीने से Full पर $10 और Master पर $20 बढ़ेगा।',plans_eye:'प्लान',plans_title:'अपना प्लान चुनें।',footer_copy:'© 2025 BlueTube · वायरल क्रिएटर',new_pwd:'नया पासवर्ड बनाएं',new_pwd_sub:'नया पासवर्ड दर्ज करें और पुष्टि करें।',pwd_new_ph:'नया पासवर्ड (कम से कम 6 अक्षर)',pwd_confirm_new:'नए पासवर्ड की पुष्टि',save_pwd:'नया पासवर्ड सहेजें →',fomo_censored:'निर्माता के अनुरोध पर नाम छुपाया',fomo_protected:'पहचान सुरक्षित',fomo_anon:'निर्माता गुमनाम रहना पसंद करते हैं',comm_title:'BlueTube समुदाय',comm_sub:'सब्सक्राइबर के लिए',comm_btn:'WhatsApp समुदाय में शामिल हों',comm_joined:'✓ समुदाय',cancel_blublu:'नहीं! क्या आपने गलती से क्लिक किया? मुझे मत छोड़ो! 😢',cancel_give_chance:'एक और मौका दें! 💙',cancel_confirm:'रद्द करने की पुष्टि करें',cancel_accept:'ऑफर स्वीकार करें 💙',cancel_proceed:'सब्सक्रिप्शन रद्द करें',cancel_bye:'हमारी यादों की कमी खलेगी!',cancel_close:'बंद करें',blublu_hello:'नमस्ते! मैं <strong>BluBlu</strong> हूं 🤖<br>आपका अनुभव कैसा है?',blublu_ph:'अपनी प्रतिक्रिया छोड़ें…',blublu_send:'फीडबैक भेजें →',blublu_thanks:'आपका संदेश भेज रहा हूं, धन्यवाद! 🚀',faq_title:'अक्सर पूछे जाने वाले सवाल।',faq_eye:'सवाल-जवाब'},
  tr:{hero_1:'Bir sonraki videonuz',hero_2:'milyonlarca görüntülemeyle',hero_3:'şimdi başlıyor.',hero_badge:'Ücretsiz · Günde 2 script · Kayıt gerekmez',hero_sub:'Herhangi bir YouTube Shorts bağlantısı yapıştırın, dil seçin ve transkript + 2 viral script alın.',btn_go:'Transkript + Script ↗',tab_transcript:'📝 Transkript',tab_casual:'💬 Günlük',tab_appeal:'🔥 Etkili',copy:'📋 Kopyala',copied:'✓ Kopyalandı!',new_short:'Yeni Short',l1:'Short aranıyor…',l2:'Ses analiz ediliyor…',l3:'Konuşma işleniyor…',l4:'Transkript oluşturuluyor…',l5:'Neredeyse hazır…',generating:'Bir sonraki viral scriptiniz oluşturuluyor…',err_empty:'Devam etmek için YouTube Shorts bağlantısı yapıştırın.',err_invalid:'Geçersiz bağlantı. Kullanın: youtube.com/shorts/...',placeholder:'https://www.youtube.com/shorts/...',nav_enter:'Giriş',nav_upgrade:'⚡ Yükselt',nav_community:'Topluluk',nav_logout:'Çıkış',auth_title:'Hesap oluştur veya giriş yap',tab_login:'Giriş',tab_signup:'Hesap oluştur',email_ph:'sizin@email.com',pwd_ph:'Şifre',pwd_min:'Şifre oluştur (en az 6 karakter)',confirm_ph:'Şifreyi onayla',btn_login:'Giriş yap →',btn_signup:'Hesap oluştur →',forgot:'Şifremi unuttum',forgot_btn:'Sıfırlama bağlantısı gönder →',back_login:'← Girişe dön',sending:'Bağlantı gönderiliyor…',link_sent:'✓ Bağlantı gönderildi! E-postanızı kontrol edin.',signing_in:'Giriş yapılıyor…',welcome:'Hoş geldiniz! 🎉',creating:'Hesap oluşturuluyor…',up_live:'kişi şu anda script oluşturuyor',up_timer:'Limitiniz sıfırlanıyor',up_cta:'Şimdi erişim al →',up_or:'veya ücretsiz hesap oluşturun',up_email_btn:'E-posta ile hesap oluştur',plan_monthly:'Aylık',plan_annual:'Yıllık',plan_save:'%25 Tasarruf',plan_popular:'En popüler',plan_monthly_label:'aylık faturalandırılır',plan_annual_label:'yıllık faturalandırılır',plan_full_btn:"Full'a Abone Ol →",plan_master_btn:"Master'a Abone Ol →",price_increase:"Önümüzdeki aydan itibaren Full'da $10, Master'da $20 artacak.",plans_eye:'Planlar',plans_title:'Planınızı seçin.',footer_copy:'© 2025 BlueTube · Viral Yaratıcı',new_pwd:'Yeni şifre oluştur',new_pwd_sub:'Yeni şifrenizi girin ve onaylayın.',pwd_new_ph:'Yeni şifre (en az 6 karakter)',pwd_confirm_new:'Yeni şifreyi onayla',save_pwd:'Yeni şifreyi kaydet →',fomo_censored:"Yaratıcının isteğiyle isim gizlendi",fomo_protected:'Kimlik korunuyor',fomo_anon:'Yaratıcı anonim kalmayı tercih ediyor',comm_title:'BlueTube Topluluğu',comm_sub:'Abonelere özel',comm_btn:'WhatsApp Topluluğuna Katıl',comm_joined:'✓ Topluluk',cancel_blublu:'Olamaz! Yanlışlıkla tıkladığını söyle? Beni bırakma! 😢',cancel_give_chance:'Bir şans daha ver! 💙',cancel_confirm:'İptali onayla',cancel_accept:'Teklifi kabul et 💙',cancel_proceed:'Aboneliği iptal et',cancel_bye:'Birlikte yaşadıklarımızı özleyeceğim!',cancel_close:'Kapat',blublu_hello:"Merhaba! Ben <strong>BluBlu</strong>'yum 🤖<br>Deneyiminiz nasıl?",blublu_ph:'Geri bildiriminizi bırakın…',blublu_send:'Geri bildirim gönder →',blublu_thanks:'Mesajınızı sahibime iletiyorum, teşekkürler! 🚀',faq_title:'Sıkça sorulan sorular.',faq_eye:'SSS'},
  ko:{hero_1:'당신의 다음 영상',hero_2:'수백만 조회수와 함께',hero_3:'지금 시작됩니다.',hero_badge:'무료 · 하루 2개 스크립트 · 가입 불필요',hero_sub:'YouTube Shorts 링크를 붙여넣고, 언어를 선택하고, 트랜스크립트 + 바이럴 스크립트 2개를 받으세요.',btn_go:'트랜스크립트 + 스크립트 ↗',tab_transcript:'📝 트랜스크립트',tab_casual:'💬 캐주얼',tab_appeal:'🔥 임팩트',copy:'📋 복사',copied:'✓ 복사됨!',new_short:'새 Short',l1:'Short 검색 중…',l2:'오디오 분석 중…',l3:'음성 처리 중…',l4:'트랜스크립트 생성 중…',l5:'거의 완료…',generating:'다음 바이럴 스크립트 생성 중…',err_empty:'계속하려면 YouTube Shorts 링크를 붙여넣으세요.',err_invalid:'잘못된 링크입니다. 사용: youtube.com/shorts/...',placeholder:'https://www.youtube.com/shorts/...',nav_enter:'로그인',nav_upgrade:'⚡ 업그레이드',nav_community:'커뮤니티',nav_logout:'로그아웃',auth_title:'계정 만들기 또는 로그인',tab_login:'로그인',tab_signup:'계정 만들기',email_ph:'이메일@email.com',pwd_ph:'비밀번호',pwd_min:'비밀번호 만들기 (최소 6자)',confirm_ph:'비밀번호 확인',btn_login:'로그인 →',btn_signup:'계정 만들기 →',forgot:'비밀번호를 잊었습니다',forgot_btn:'재설정 링크 보내기 →',back_login:'← 로그인으로 돌아가기',sending:'링크 전송 중…',link_sent:'✓ 링크 전송됨! 이메일을 확인하세요.',signing_in:'로그인 중…',welcome:'환영합니다! 🎉',creating:'계정 만드는 중…',up_live:'명이 지금 스크립트를 생성 중입니다',up_timer:'한도가 재설정될 때까지',up_cta:'지금 이용하기 →',up_or:'또는 무료 계정을 만드세요',up_email_btn:'이메일로 계정 만들기',plan_monthly:'월간',plan_annual:'연간',plan_save:'25% 절약',plan_popular:'가장 인기',plan_monthly_label:'월간 청구',plan_annual_label:'연간 청구',plan_full_btn:'Full 구독 →',plan_master_btn:'Master 구독 →',price_increase:'다음 달부터 Full은 $10, Master는 $20 인상됩니다.',plans_eye:'플랜',plans_title:'플랜을 선택하세요.',footer_copy:'© 2025 BlueTube · 바이럴 크리에이터',new_pwd:'새 비밀번호 만들기',new_pwd_sub:'새 비밀번호를 입력하고 확인하세요.',pwd_new_ph:'새 비밀번호 (최소 6자)',pwd_confirm_new:'새 비밀번호 확인',save_pwd:'새 비밀번호 저장 →',fomo_censored:'크리에이터 요청으로 이름 검열됨',fomo_protected:'신원 보호됨',fomo_anon:'크리에이터가 익명을 선호합니다',comm_title:'BlueTube 커뮤니티',comm_sub:'구독자 전용',comm_btn:'WhatsApp 커뮤니티 참여',comm_joined:'✓ 커뮤니티',cancel_blublu:'안돼요! 실수로 클릭한 거죠? 떠나지 마세요! 😢',cancel_give_chance:'한 번 더 기회를! 💙',cancel_confirm:'취소 확인',cancel_accept:'제안 수락 💙',cancel_proceed:'구독 취소',cancel_bye:'함께한 시간이 그리울 거예요!',cancel_close:'닫기',blublu_hello:'안녕하세요! 저는 <strong>BluBlu</strong>예요 🤖<br>경험은 어떠신가요?',blublu_ph:'피드백을 남겨주세요…',blublu_send:'피드백 보내기 →',blublu_thanks:'메시지를 전달하고 있습니다, 감사합니다! 🚀',faq_title:'자주 묻는 질문.',faq_eye:'자주 묻는 질문'},
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── SUPABASE GLOBALS (disponíveis para todos os blocos) ────────────────────
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY || SUPA_KEY;
  const supaH = { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' };

  // ── HELPERS GLOBAIS ───────────────────────────────────────────────────────
  const fmtViews = n => !n ? '0' : n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : n.toString();

  // ── LANGUAGE DETECTION (GET) ───────────────────────────────────────────────
  // ── VIRAL SHORTS ──────────────────────────────────────────────────────────
  // ── FILE DOWNLOAD PROXY ───────────────────────────────────────────────────
  if (req.method === 'GET' && req.query?.action === 'proxy-download') {
    const { fileUrl, filename = 'video.mp4' } = req.query;
    if (!fileUrl) return res.status(400).json({ error: 'fileUrl obrigatória' });

    const decodedUrl = decodeURIComponent(fileUrl);
    const decodedName = decodeURIComponent(filename);

    // Detect platform from URL to set correct Referer
    const isTikTok = decodedUrl.includes('tiktok') || decodedUrl.includes('tikwm') || decodedUrl.includes('muscdn');
    const isInstagram = decodedUrl.includes('instagram') || decodedUrl.includes('cdninstagram') || decodedUrl.includes('fbcdn');
    const referer = isTikTok ? 'https://www.tiktok.com/'
      : isInstagram ? 'https://www.instagram.com/'
      : 'https://www.youtube.com/';
    const origin = isTikTok ? 'https://www.tiktok.com'
      : isInstagram ? 'https://www.instagram.com'
      : 'https://www.youtube.com';

    try {
      console.log('Proxy downloading from:', decodedUrl.slice(0, 80), '| platform:', isTikTok ? 'tiktok' : isInstagram ? 'instagram' : 'other');
      const fileRes = await fetch(decodedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8',
          'Accept-Encoding': 'identity',
          'Referer': referer,
          'Origin': origin,
          'Sec-Fetch-Dest': 'video',
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Site': 'same-site',
        }
      });

      if (!fileRes.ok) {
        const errText = await fileRes.text().catch(()=>'');
        console.error('Proxy fetch failed:', fileRes.status, errText.slice(0,200));
        return res.status(502).json({ error: `Servidor retornou ${fileRes.status}` });
      }

      let contentType = fileRes.headers.get('content-type') || 'video/mp4';
      // Force video/mp4 if server returns wrong content-type (e.g. text/html redirect)
      if (!contentType.includes('video') && !contentType.includes('octet')) {
        contentType = 'video/mp4';
      }
      const contentLength = fileRes.headers.get('content-length');
      console.log('Proxy content-type:', contentType, 'length:', contentLength);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${decodedName}"`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      if (contentLength) res.setHeader('Content-Length', contentLength);

      // Pipe the stream directly
      const reader = fileRes.body.getReader();
      const write = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const canContinue = res.write(Buffer.from(value));
          if (!canContinue) {
            await new Promise(resolve => res.once('drain', resolve));
          }
        }
        res.end();
      };
      await write();

    } catch(e) {
      console.error('Proxy error:', e.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Erro no proxy: ' + e.message });
      }
    }
    return;
  }

  // ── VIDEO DOWNLOAD PROXY ──────────────────────────────────────────────────
  if (req.method === 'GET' && req.query?.action === 'download') {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL obrigatória' });

    try {
      // Detect platform
      const platform = url.includes('tiktok.com') ? 'tiktok'
        : url.includes('instagram.com') ? 'instagram'
        : url.includes('twitter.com') || url.includes('x.com') ? 'twitter'
        : url.includes('facebook.com') || url.includes('fb.watch') ? 'facebook'
        : url.includes('youtube.com') || url.includes('youtu.be') ? 'youtube'
        : 'generic';

      let downloadUrl = null;
      let title = 'Vídeo';
      let thumbnail = null;

      // ── YOUTUBE / SHORTS ────────────────────────────────────────────────
      if (platform === 'youtube') {
        const ytMatch = url.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        const videoId = ytMatch?.[1];
        if (!videoId) return res.status(400).json({ error: 'ID do vídeo do YouTube não encontrado.' });

        thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        title = 'YouTube Short';

        const rapidKey = process.env.RAPIDAPI_KEY;
        const failures = [];

        // ── HQ MODE: delega tudo pro Railway /youtube-hq ────────────────────
        // Railway faz ytstream + download + mux no mesmo IP pra contornar o
        // IP-bound das signed URLs do YouTube (googlevideo.com retorna 403 se
        // o IP que baixa != IP que pediu a URL).
        const wantHQ = req.query?.quality === 'hq' || req.query?.quality === '1080' || req.query?.quality === '1080p';
        if (wantHQ) {
          const hqFailures = [];
          if (!rapidKey) hqFailures.push('RAPIDAPI_KEY ausente');
          const RAILWAY = process.env.RAILWAY_FFMPEG_URL;
          if (!RAILWAY) hqFailures.push('RAILWAY_FFMPEG_URL ausente');

          if (rapidKey && RAILWAY) {
            // Retry 1x em caso de 502 (cold start Railway) ou 5xx transitório
            const callRailway = async () => {
              const ctrl = new AbortController();
              const timer = setTimeout(() => ctrl.abort(), 55000);
              try {
                const hqR = await fetch(`${RAILWAY.replace(/\/$/, '')}/youtube-hq`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    video_id: videoId,
                    rapidapi_key: rapidKey,
                    supabase_url: process.env.SUPABASE_URL,
                    supabase_key: process.env.SUPABASE_SERVICE_KEY,
                    output_path: `downloads/youtube/${videoId}_${Date.now()}_hq.mp4`
                  }),
                  signal: ctrl.signal
                });
                clearTimeout(timer);
                const hqD = await hqR.json().catch(() => ({}));
                return { status: hqR.status, body: hqD, ok: hqR.ok };
              } catch (e) {
                clearTimeout(timer);
                return { status: 0, body: {}, ok: false, exception: e.name === 'AbortError' ? 'timeout 55s' : e.message };
              }
            };

            let attempt = await callRailway();
            // Retry em 502/503/504 (cold start/proxy issues) ou exception de rede
            if (!attempt.ok && (attempt.status === 502 || attempt.status === 503 || attempt.status === 504 || attempt.exception)) {
              console.log('[BaixaBlue HQ] retry após', attempt.status || attempt.exception);
              await new Promise(r => setTimeout(r, 500));
              attempt = await callRailway();
            }

            if (attempt.ok && attempt.body.url) {
              return res.status(200).json({
                url: attempt.body.url,
                quality: attempt.body.quality || '1080p',
                title: attempt.body.title || title,
                thumbnail,
                platform,
                provider: 'youtube-hq',
                video_itag: attempt.body.video_itag,
                audio_itag: attempt.body.audio_itag,
                size: attempt.body.size
              });
            }

            if (attempt.exception) {
              hqFailures.push('railway exception: ' + attempt.exception);
            } else {
              const hqDetail = [attempt.body.step && `step=${attempt.body.step}`, attempt.body.error, attempt.body.detail].filter(Boolean).join(' | ') || 'unknown (empty body)';
              hqFailures.push(`railway status ${attempt.status}: ${hqDetail}`);
            }
          }

          // HQ falhou: erro explícito
          return res.status(502).json({
            error: 'Falha ao obter HD 1080p. Tente a opção Auto.',
            hq_failures: hqFailures,
            provider: 'hq-failed',
            title,
            thumbnail
          });
        }

        // ── 1º: Cobalt próprio (instância self-hosted) ─────────────────
        const cobaltUrl = process.env.COBALT_API_URL;
        const cobaltKey = process.env.COBALT_API_KEY;
        if (cobaltUrl) {
          try {
            const cobaltHeaders = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
            if (cobaltKey) cobaltHeaders['Authorization'] = 'Api-Key ' + cobaltKey;
            console.log('[BaixaBlue] Tentando Cobalt:', cobaltUrl);
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 30000);
            const cobaltR = await fetch(cobaltUrl, {
              method: 'POST',
              headers: cobaltHeaders,
              body: JSON.stringify({ url: url }),
              signal: ctrl.signal
            });
            clearTimeout(timer);
            const cobaltD = await cobaltR.json().catch(() => ({}));
            console.log('[BaixaBlue] Cobalt response:', cobaltR.status, JSON.stringify(cobaltD).slice(0, 300));
            if (cobaltR.ok) {
              if (cobaltD.status === 'redirect' || cobaltD.status === 'tunnel') downloadUrl = cobaltD.url;
              else if (cobaltD.status === 'picker') downloadUrl = cobaltD.picker?.[0]?.url;
              else if (cobaltD.url) downloadUrl = cobaltD.url;
              if (cobaltD.filename) title = cobaltD.filename.replace(/\.[^.]+$/, '') || title;
            }
            if (!downloadUrl) failures.push(`Cobalt status ${cobaltR.status}: ${cobaltD.error?.code || cobaltD.status || 'sem url'}`);
          } catch (e) {
            const msg = e.name === 'AbortError' ? 'timeout 30s' : e.message;
            console.error('[BaixaBlue] Cobalt falhou:', msg);
            failures.push('Cobalt: ' + msg);
          }
        } else {
          failures.push('Cobalt: COBALT_API_URL não configurada');
        }

        // ── 2º: ytstream (RapidAPI) — parser tolerante a schemas variados ───
        if (!downloadUrl && rapidKey) {
          try {
            const r = await fetch(`https://ytstream-download-youtube-videos.p.rapidapi.com/dl?id=${videoId}`, {
              headers: {
                'x-rapidapi-key': rapidKey,
                'x-rapidapi-host': 'ytstream-download-youtube-videos.p.rapidapi.com'
              }
            });
            if (r.ok) {
              const d = await r.json();
              title = d.title || title;
              // Tenta múltiplos formatos do schema ytstream:
              // 1) {formats: {720: {url}, 480: {url}}}                 — schema antigo
              // 2) {formats: [{quality, url}, ...]}                    — schema novo (array)
              // 3) {adaptiveFormats: [{qualityLabel, url, mimeType}]}  — schema Innertube-like
              // 4) {link: "..."}                                       — single direct link
              // 5) Busca recursiva por qualquer URL de vídeo mp4
              const fmts = d.formats;
              const adapt = d.adaptiveFormats;

              // Tentativa 1: dict por qualidade
              if (fmts && typeof fmts === 'object' && !Array.isArray(fmts)) {
                for (const q of ['1080','720','480','360','240','1080p','720p','480p','360p']) {
                  if (fmts[q]?.url) { downloadUrl = fmts[q].url; break; }
                }
              }

              // Tentativa 2: array de formats
              if (!downloadUrl && Array.isArray(fmts)) {
                const mp4Items = fmts.filter(f =>
                  (f?.mimeType || '').includes('mp4') ||
                  (f?.container || '').includes('mp4') ||
                  (f?.ext || '').includes('mp4') ||
                  typeof f?.url === 'string'
                );
                // Ordena por altura/qualidade descendente
                mp4Items.sort((a, b) => {
                  const ah = parseInt(a.height || a.quality || '0');
                  const bh = parseInt(b.height || b.quality || '0');
                  return bh - ah;
                });
                downloadUrl = mp4Items[0]?.url || null;
              }

              // Tentativa 3: adaptiveFormats (vídeo only, precisa mux com áudio separado — só pega o mp4 combinado)
              if (!downloadUrl && Array.isArray(adapt)) {
                const combined = adapt.find(f =>
                  (f?.mimeType || '').includes('video/mp4') &&
                  (f?.mimeType || '').includes('avc1') &&
                  typeof f?.url === 'string'
                );
                downloadUrl = combined?.url || null;
              }

              // Tentativa 4: link direto
              if (!downloadUrl && typeof d.link === 'string' && d.link.startsWith('http')) {
                downloadUrl = d.link;
              }

              // Tentativa 5: busca recursiva por qualquer URL mp4 no objeto
              if (!downloadUrl) {
                const stack = [d];
                while (stack.length && !downloadUrl) {
                  const cur = stack.pop();
                  if (!cur) continue;
                  if (typeof cur === 'string' && cur.startsWith('http') && (cur.includes('.mp4') || cur.includes('videoplayback'))) {
                    downloadUrl = cur; break;
                  }
                  if (Array.isArray(cur)) { stack.push(...cur); continue; }
                  if (typeof cur === 'object') {
                    if (typeof cur.url === 'string' && cur.url.startsWith('http')) {
                      downloadUrl = cur.url; break;
                    }
                    stack.push(...Object.values(cur));
                  }
                }
              }

              if (!downloadUrl) {
                // Log do schema real pra diagnosticar
                const topKeys = Object.keys(d || {}).slice(0, 10).join(',');
                console.error('[BaixaBlue] ytstream schema desconhecido. top keys:', topKeys);
                failures.push(`ytstream: schema desconhecido (keys: ${topKeys})`);
              }
            } else {
              const body = await r.text().catch(() => '');
              console.error('[BaixaBlue] ytstream falhou:', r.status, body.slice(0, 200));
              failures.push(`ytstream status ${r.status}`);
            }
          } catch (e) {
            console.error('[BaixaBlue] ytstream falhou:', e.message);
            failures.push('ytstream: ' + e.message);
          }
        } else if (!rapidKey) {
          failures.push('ytstream: RAPIDAPI_KEY ausente');
        }

        // ── 3º: youtube-media-downloader (RapidAPI) ────────────────────
        if (!downloadUrl && rapidKey) {
          try {
            const r = await fetch(`https://youtube-media-downloader.p.rapidapi.com/v2/video/details?videoId=${videoId}`, {
              headers: {
                'x-rapidapi-key': rapidKey,
                'x-rapidapi-host': 'youtube-media-downloader.p.rapidapi.com'
              }
            });
            if (r.ok) {
              const d = await r.json();
              title = d.title || title;
              const videos = d.videos?.items || [];
              const best = videos.find(f => f.height >= 720) || videos[0];
              downloadUrl = best?.url;
              if (!downloadUrl) failures.push('youtube-media-downloader: nenhum vídeo retornado');
            } else {
              const body = await r.text().catch(() => '');
              console.error('[BaixaBlue] youtube-media-downloader falhou:', r.status, body.slice(0, 200));
              failures.push(`youtube-media-downloader status ${r.status}`);
            }
          } catch (e) {
            console.error('[BaixaBlue] youtube-media-downloader falhou:', e.message);
            failures.push('youtube-media-downloader: ' + e.message);
          }
        }

        if (!downloadUrl) {
          console.error('[BaixaBlue] Todas as APIs falharam para', url, '| failures:', failures);
          return res.status(502).json({
            error: 'Não foi possível baixar este vídeo. Tente novamente em alguns minutos ou use outro link.',
            detail: failures.join(' | ')
          });
        }
      }

      // ── TIKTOK ──────────────────────────────────────────────────────────
      else if (platform === 'tiktok') {
        const rapidKey = process.env.RAPIDAPI_KEY;
        if (!rapidKey) {
          return res.status(400).json({ error: 'RAPIDAPI_KEY nao configurada no Vercel.' });
        }

        // Method 1: tiktok-download-without-watermark4 (subscribed)
        try {
          const r = await fetch(`https://tiktok-download-without-watermark4.p.rapidapi.com/tiktok?url=${encodeURIComponent(url)}`, {
            headers: {
              'x-rapidapi-key': rapidKey,
              'x-rapidapi-host': 'tiktok-download-without-watermark4.p.rapidapi.com'
            }
          });
          const d = await r.json();
          console.log('TikTok API1 status:', r.status, JSON.stringify(d).slice(0,400));
          if (!r.ok) { console.log('TikTok API1 error body:', JSON.stringify(d)); }
          // Try multiple possible response shapes
          const videoData = d.data || d.result || d;
          const hdUrl = videoData.hdplay || videoData.play || videoData.wmplay
            || videoData.video?.noWatermark || videoData.video?.play
            || (Array.isArray(videoData.video) ? videoData.video[0] : null);
          if (r.ok && hdUrl) {
            downloadUrl = hdUrl;
            title = videoData.title || videoData.desc || 'TikTok';
            thumbnail = videoData.cover || videoData.thumbnail || videoData.origin_cover;
          }
        } catch(e) { console.log('tiktok api1 failed:', e.message); }

        // Method 2: tiktok-scraper7
        if (!downloadUrl) {
          try {
            const r = await fetch(`https://tiktok-scraper7.p.rapidapi.com/?url=${encodeURIComponent(url)}&hd=1`, {
              headers: {
                'x-rapidapi-key': rapidKey,
                'x-rapidapi-host': 'tiktok-scraper7.p.rapidapi.com'
              }
            });
            const d = await r.json();
            console.log('TikTok API2 status:', r.status, JSON.stringify(d).slice(0,200));
            if (r.ok && d.data) {
              downloadUrl = d.data.hdplay || d.data.play || d.data.wmplay;
              title = d.data.title || 'TikTok';
              thumbnail = d.data.cover;
            }
          } catch(e) { console.log('tiktok api2 failed:', e.message); }
        }

        // Fallback: Cobalt
        if (!downloadUrl) {
          const _cu = process.env.COBALT_API_URL, _ck = process.env.COBALT_API_KEY;
          if (_cu) { try {
            const _ch = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
            if (_ck) _ch['Authorization'] = 'Api-Key ' + _ck;
            const cr = await fetch(_cu, { method: 'POST', headers: _ch, body: JSON.stringify({ url, videoQuality: '720' }) });
            if (cr.ok) { const cd = await cr.json(); downloadUrl = cd.url || cd.picker?.[0]?.url; }
          } catch(e) {} }
        }
      }

      // ── INSTAGRAM ───────────────────────────────────────────────────────
      else if (platform === 'instagram') {
        const rapidKey = process.env.RAPIDAPI_KEY;
        if (!rapidKey) {
          return res.status(400).json({ error: 'RAPIDAPI_KEY não configurada.' });
        }

        // Method 1: Social Media Video Downloader — Instagram-Media endpoint
        try {
          // Extract shortcode from Instagram URL
          // Formats: /p/CODE/, /reel/CODE/, /reels/CODE/, /tv/CODE/
          const scMatch = url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
          const shortcode = scMatch?.[1];
          if (!shortcode) throw new Error('Could not extract shortcode from URL: ' + url);

          const smvdUrl = `https://social-media-video-downloader.p.rapidapi.com/instagram/v3/media/post/details?shortcode=${shortcode}&renderableFormats=720p%2Chighres`;
          const r = await fetch(smvdUrl, {
            headers: {
              'x-rapidapi-key': rapidKey,
              'x-rapidapi-host': 'social-media-video-downloader.p.rapidapi.com'
            }
          });
          const d = await r.json();
          console.log('Instagram API1 (smvd) status:', r.status, JSON.stringify(d).slice(0,800));
          if (r.ok && d) {
            // smvd API: busca recursiva por URL de vídeo no JSON
            const findVideoUrl = (obj, depth=0) => {
              if (!obj || depth > 5) return null;
              if (typeof obj === 'string' && obj.includes('.mp4') && obj.startsWith('http')) return obj;
              if (Array.isArray(obj)) {
                for (const item of obj) { const r = findVideoUrl(item, depth+1); if (r) return r; }
              } else if (typeof obj === 'object') {
                // Prioriza campos com nome de vídeo
                for (const k of ['video_url','playback_url','src','url','download_url','hdplay','play']) {
                  if (obj[k] && typeof obj[k] === 'string' && obj[k].includes('http')) {
                    if (obj[k].includes('.mp4') || obj[k].includes('video') || obj[k].includes('cdn')) return obj[k];
                  }
                }
                for (const v of Object.values(obj)) { const r = findVideoUrl(v, depth+1); if (r) return r; }
              }
              return null;
            };
            downloadUrl = findVideoUrl(d);
            // Thumbnail
            const findImg = (obj, depth=0) => {
              if (!obj || depth > 5) return null;
              if (typeof obj === 'string' && (obj.includes('.jpg')||obj.includes('.jpeg')||obj.includes('thumbnail')) && obj.startsWith('http')) return obj;
              if (Array.isArray(obj)) { for (const i of obj) { const r = findImg(i, depth+1); if (r) return r; } }
              else if (typeof obj === 'object') { for (const v of Object.values(obj)) { const r = findImg(v, depth+1); if (r) return r; } }
              return null;
            };
            thumbnail = findImg(d);
            title = d.data?.caption?.text?.slice(0,60) || d.caption?.text?.slice(0,60) || 'Instagram';
            console.log('Instagram shortcode:', shortcode, 'downloadUrl found:', !!downloadUrl, downloadUrl?.slice(0,60));
          }
        } catch(e) { console.log('instagram api1 failed:', e.message); }

        // Method 2: Instagram Reels Downloader API (fallback)
        if (!downloadUrl) {
          try {
            const r = await fetch(`https://instagram-reels-downloader-api.p.rapidapi.com/download?url=${encodeURIComponent(url)}`, {
              headers: {
                'x-rapidapi-key': rapidKey,
                'x-rapidapi-host': 'instagram-reels-downloader-api.p.rapidapi.com'
              }
            });
            const d = await r.json();
            console.log('Instagram API2 (reels) status:', r.status, JSON.stringify(d).slice(0,300));
            if (r.ok && d.success !== false) {
              downloadUrl = d.download_url || d.url || d.video_url
                || (Array.isArray(d.data) ? d.data[0]?.url : d.data?.url);
              title = d.title || d.caption || 'Instagram';
              thumbnail = d.thumbnail || d.cover;
            }
          } catch(e) { console.log('instagram api2 failed:', e.message); }
        }

        // Fallback: Cobalt
        if (!downloadUrl) {
          const _cu2 = process.env.COBALT_API_URL, _ck2 = process.env.COBALT_API_KEY;
          if (_cu2) { try {
            const _ch2 = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
            if (_ck2) _ch2['Authorization'] = 'Api-Key ' + _ck2;
            const cr = await fetch(_cu2, { method: 'POST', headers: _ch2, body: JSON.stringify({ url, videoQuality: '720' }) });
            if (cr.ok) { const cd = await cr.json(); downloadUrl = cd.url || cd.picker?.[0]?.url; }
          } catch(e) {} }
        }
      }

      // ── TWITTER/X ────────────────────────────────────────────────────────
      else if (platform === 'twitter') {
        const rapidKey = process.env.RAPIDAPI_KEY;
        if (rapidKey) {
          const r = await fetch(`https://twitter-video-downloader10.p.rapidapi.com/?url=${encodeURIComponent(url)}`, {
            headers: {
              'x-rapidapi-key': rapidKey,
              'x-rapidapi-host': 'twitter-video-downloader10.p.rapidapi.com'
            }
          });
          if (r.ok) {
            const d = await r.json();
            const variants = d.media_url_https || d.variants || [];
            downloadUrl = Array.isArray(variants) ? variants.find(v => v.content_type === 'video/mp4')?.url : variants;
            title = d.text || 'Twitter/X';
          }
        }
      }

      if (!downloadUrl) {
        console.error(`[download] FAILED platform=${platform} url=${url.slice(0,80)}`);
        return res.status(400).json({
          error: 'Não foi possível extrair o vídeo.',
          platform,
          hint: platform === 'youtube'
            ? 'Configure RAPIDAPI_KEY no Vercel para YouTube.'
            : platform === 'instagram' || platform === 'twitter'
            ? 'Configure RAPIDAPI_KEY no Vercel para esta plataforma.'
            : 'Verifique se o link é público e tente novamente.'
        });
      }

      // Wrap TODAS as URLs não-Supabase no Railway /proxy-download pra
      // garantir que fetch-to-blob funcione cross-origin no browser.
      // Plataformas afetadas (todas usam CDNs sem CORS ou com CORS parcial):
      // - TikTok (tokcdn), YouTube (googlevideo), Instagram (cdninstagram),
      //   Twitter (twimg), Facebook (fbcdn)
      // Supabase URLs já têm CORS e passam direto.
      const RAILWAY_FFMPEG = process.env.RAILWAY_FFMPEG_URL;
      const needsProxy = RAILWAY_FFMPEG && !downloadUrl.includes('supabase.co');
      let finalUrl = downloadUrl;
      if (needsProxy) {
        const safeName = (title || platform).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
        const proxyBase = RAILWAY_FFMPEG.replace(/\/$/, '');
        finalUrl = `${proxyBase}/proxy-download?url=${encodeURIComponent(downloadUrl)}&filename=BaixaBlue_${platform}_${safeName}.mp4`;
      }

      return res.status(200).json({ url: finalUrl, title, thumbnail, platform, proxied: needsProxy });

    } catch(e) {
      console.error('Download error:', e);
      return res.status(500).json({ error: 'Erro ao processar: ' + e.message });
    }
  }

  // ── BLUESCORE: RESOLVE CHANNEL + VIDEOS (com cache 6h + rate limit) ─────────
  if (req.method === 'GET' && (req.query?.action === 'bluescore-channel' || req.query?.action === 'bluescore-videos')) {
    const YT_KEYS = [
      process.env.YOUTUBE_API_KEY,
      process.env.YOUTUBE_API_KEY_2,
      process.env.YOUTUBE_API_KEY_3,
      process.env.YOUTUBE_API_KEY_4,
      process.env.YOUTUBE_API_KEY_5,
      process.env.YOUTUBE_API_KEY_6,
      process.env.YOUTUBE_API_KEY_7,
      process.env.YOUTUBE_API_KEY_8,
      process.env.YOUTUBE_API_KEY_9,
      process.env.YOUTUBE_API_KEY_10,
    ].filter(Boolean);
    if (!YT_KEYS.length) return res.status(500).json({ error: 'YouTube API não configurada.' });

    // Rotação de chave por minuto para distribuir cota
    const YT_KEY = YT_KEYS[Math.floor(Date.now() / 60000) % YT_KEYS.length];

    // Helper: chama YouTube com fallback de chaves se quota esgotar
    const ytFetch = async (url) => {
      for (const key of YT_KEYS) {
        const fullUrl = url + (url.includes('?') ? '&' : '?') + 'key=' + key;
        const r = await fetch(fullUrl);
        const d = await r.json();
        if (d.error?.code === 403 || d.error?.message?.toLowerCase().includes('quota')) {
          console.log('BlueScore: quota esgotada, tentando próxima chave...');
          continue;
        }
        return { r, d };
      }
      return { r: null, d: { error: { message: 'quota_all', code: 403 } } };
    };

    const quotaError = (d) => d?.error?.code === 403 || d?.error?.message?.toLowerCase().includes('quota');
    const quotaMsg = 'Análises temporariamente pausadas por alta demanda. Tente novamente em alguns minutos.';

    // ── CHANNEL ──────────────────────────────────────────────────────────────
    if (req.query?.action === 'bluescore-channel') {
      const { type, id } = req.query;
      if (!id) return res.status(400).json({ error: 'ID obrigatório' });

      // Cache no Supabase (6h)
      const cacheKey = `bs_ch_${type}_${id.toLowerCase().replace(/[^a-z0-9]/g,'_')}`;
      if (SUPA_URL && SUPA_KEY) {
        try {
          const cr = await fetch(`${SUPA_URL}/rest/v1/viral_cache?cache_key=eq.${encodeURIComponent(cacheKey)}&select=data,cached_at`, { headers: supaH });
          if (cr.ok) {
            const rows = await cr.json();
            if (rows?.[0] && (Date.now() - new Date(rows[0].cached_at).getTime()) < 6*60*60*1000) {
              console.log('BlueScore channel: CACHE HIT', cacheKey);
              return res.status(200).json({ ...rows[0].data, fromCache: true });
            }
          }
        } catch(e) { /* cache miss */ }
      }

      try {
        let channelId = null;
        if (type === 'channelId' || id.startsWith('UC')) {
          channelId = id;
        } else if (type === 'video') {
          const { d } = await ytFetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${id}`);
          if (quotaError(d)) return res.status(429).json({ error: quotaMsg });
          channelId = d.items?.[0]?.snippet?.channelId;
        } else {
          const { d } = await ytFetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(id)}&maxResults=1`);
          if (quotaError(d)) return res.status(429).json({ error: quotaMsg });
          if (d.error) return res.status(400).json({ error: d.error.message });
          channelId = d.items?.[0]?.snippet?.channelId;
        }

        if (!channelId) return res.status(404).json({ error: 'Canal não encontrado. Verifique o link.' });

        const { d: cd } = await ytFetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}`);
        if (quotaError(cd)) return res.status(429).json({ error: quotaMsg });
        const ch = cd.items?.[0];
        if (!ch) return res.status(404).json({ error: 'Canal não encontrado.' });

        const result = {
          channelId,
          title: ch.snippet?.title || 'Canal',
          thumbnail: ch.snippet?.thumbnails?.medium?.url || ch.snippet?.thumbnails?.default?.url,
          subscribers: parseInt(ch.statistics?.subscriberCount || 0),
          videoCount: parseInt(ch.statistics?.videoCount || 0),
          totalViews: parseInt(ch.statistics?.viewCount || 0),
          country: ch.snippet?.country || '',
          publishedAt: ch.snippet?.publishedAt,
        };

        // Salva cache
        if (SUPA_URL && SUPA_KEY) {
          fetch(`${SUPA_URL}/rest/v1/viral_cache`, {
            method: 'POST',
            headers: { ...supaH, 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify({ cache_key: cacheKey, data: result, cached_at: new Date().toISOString() })
          }).catch(()=>{});
        }

        return res.status(200).json(result);
      } catch(e) {
        console.error('BlueScore channel error:', e.message);
        return res.status(500).json({ error: 'Erro ao buscar canal.' });
      }
    }

    // ── VIDEOS ────────────────────────────────────────────────────────────────
    if (req.query?.action === 'bluescore-videos') {
      const { channelId } = req.query;
      if (!channelId) return res.status(400).json({ error: 'channelId obrigatório' });

      // Cache 6h
      const cacheKey = `bs_vids_${channelId}`;
      if (SUPA_URL && SUPA_KEY) {
        try {
          const cr = await fetch(`${SUPA_URL}/rest/v1/viral_cache?cache_key=eq.${encodeURIComponent(cacheKey)}&select=data,cached_at`, { headers: supaH });
          if (cr.ok) {
            const rows = await cr.json();
            if (rows?.[0] && (Date.now() - new Date(rows[0].cached_at).getTime()) < 6*60*60*1000) {
              console.log('BlueScore videos: CACHE HIT', channelId);
              return res.status(200).json({ ...rows[0].data, fromCache: true });
            }
          }
        } catch(e) { /* cache miss */ }
      }

      try {
        const { d: sd } = await ytFetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&order=date&maxResults=12`);
        if (quotaError(sd)) return res.status(429).json({ error: quotaMsg });
        if (sd.error) return res.status(400).json({ error: sd.error.message });

        const videoIds = (sd.items || []).map(i => i.id?.videoId).filter(Boolean).join(',');
        if (!videoIds) return res.status(200).json({ videos: [] });

        const { d: vd } = await ytFetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet,contentDetails&id=${videoIds}`);
        if (quotaError(vd)) return res.status(429).json({ error: quotaMsg });

        const videos = (vd.items || []).map(v => {
          const stats = v.statistics || {}, snippet = v.snippet || {};
          const dur = v.contentDetails?.duration || '';
          const m = dur.match(/PT(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?/);
          const secs = (parseInt(m?.[1]||0)*3600)+(parseInt(m?.[2]||0)*60)+parseInt(m?.[3]||0);
          return {
            id: v.id, title: snippet.title || 'Sem título',
            publishedAt: snippet.publishedAt,
            thumbnail: snippet.thumbnails?.medium?.url,
            views: parseInt(stats.viewCount || 0),
            likes: parseInt(stats.likeCount || 0),
            comments: parseInt(stats.commentCount || 0),
            duration: secs, isShort: secs > 0 && secs <= 60,
          };
        }).sort((a,b) => new Date(b.publishedAt) - new Date(a.publishedAt));

        const result = { videos };

        // Salva cache
        if (SUPA_URL && SUPA_KEY) {
          fetch(`${SUPA_URL}/rest/v1/viral_cache`, {
            method: 'POST',
            headers: { ...supaH, 'Prefer': 'resolution=merge-duplicates' },
            body: JSON.stringify({ cache_key: cacheKey, data: result, cached_at: new Date().toISOString() })
          }).catch(()=>{});
        }

        return res.status(200).json(result);
      } catch(e) {
        console.error('BlueScore videos error:', e.message);
        return res.status(500).json({ error: 'Erro ao buscar vídeos.' });
      }
    }
  }

  // ── BLUESCORE: FEEDBACK (aprendizado) ────────────────────────────────────
  if (req.method === 'POST' && req.body?.action === 'bluescore-feedback') {
    const { analise_id, util } = req.body;
    if (!analise_id) return res.status(400).json({ error: 'analise_id obrigatório' });
    const _FK = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPA_URL || !_FK) return res.status(200).json({ ok: false, reason: 'supabase ausente' });
    try {
      const r = await fetch(`${SUPA_URL}/rest/v1/bluescore_analises?id=eq.${encodeURIComponent(analise_id)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': _FK,
          'Authorization': `Bearer ${_FK}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ feedback_util: !!util })
      });
      return res.status(200).json({ ok: r.ok });
    } catch (e) {
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  // ── BLUESCORE: AI DIAGNOSIS ──────────────────────────────────────────────────
  if (req.method === 'POST' && req.body?.action === 'bluescore-ai') {
    const { channelData, videos, scoreData, isShorts: isShortsChannel, faixa } = req.body;
    if (!channelData || !videos || !scoreData) return res.status(400).json({ error: 'Dados obrigatórios' });

    const GEMINI_KEYS = [
      process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3,
      process.env.GEMINI_KEY_4, process.env.GEMINI_KEY_5, process.env.GEMINI_KEY_6,
      process.env.GEMINI_KEY_7, process.env.GEMINI_KEY_8, process.env.GEMINI_KEY_9,
      process.env.GEMINI_KEY_10,
    ].filter(Boolean);

    // Análise inferencial de padrões de conteúdo reutilizado
    const titles = videos.map(v => v.title || '');
    const avgTitleLen = titles.reduce((s,t) => s+t.length, 0) / (titles.length || 1);
    
    // Detecta padrões de título repetitivo (sinal de conteúdo reutilizado)
    const titleWords = titles.flatMap(t => t.toLowerCase().split(/\s+/));
    const wordFreq = {};
    titleWords.forEach(w => { if(w.length > 3) wordFreq[w] = (wordFreq[w]||0)+1; });
    const topWords = Object.entries(wordFreq).filter(([,n]) => n >= 3).sort((a,b) => b[1]-a[1]).slice(0,5);
    const hasRepetitivePattern = topWords.length >= 2;
    
    // Detecta variação anormal de views (possível conteúdo viral de terceiros)
    const viewsArr = videos.map(v => v.views);
    const maxViews = Math.max(...viewsArr);
    const avgViews = viewsArr.reduce((s,v) => s+v, 0) / viewsArr.length;
    const hasOutlier = maxViews > avgViews * 5;
    
    // Detecta shorts vs longos
    const shorts = videos.filter(v => v.duration <= 60 && v.duration > 0);
    const shortsRatio = shorts.length / (videos.length || 1);
    
    // Frequência de postagem
    const dates = videos.map(v => new Date(v.publishedAt)).sort((a,b) => b-a);
    const daysBetween = dates.length > 1 
      ? (dates[0] - dates[dates.length-1]) / (1000*60*60*24) / (dates.length-1)
      : 7;

    // Engagement por vídeo para detectar inconsistência
    const engRates = videos.map(v => v.views > 0 ? ((v.likes + v.comments) / v.views * 100) : 0);
    const avgEng = engRates.reduce((s,e) => s+e, 0) / (engRates.length || 1);
    const lowEngVideos = engRates.filter(e => e < avgEng * 0.3).length;
    const commentRatio = videos.reduce((s,v) => s + v.comments, 0) / (videos.reduce((s,v) => s + v.likes, 0) || 1);

    // ── Few-shot: análises aprovadas de canais Shorts na mesma faixa ────────
    let fewShotBlock = '';
    if (isShortsChannel && faixa && SUPA_URL && SUPA_KEY) {
      try {
        const fsRes = await fetch(
          `${SUPA_URL}/rest/v1/bluescore_analises?eh_shorts=eq.true&faixa=eq.${encodeURIComponent(faixa)}&feedback_util=eq.true&select=nicho,diagnostico,dicas&order=created_at.desc&limit=3`,
          { headers: supaH }
        );
        if (fsRes.ok) {
          const rows = await fsRes.json();
          if (rows?.length > 0) {
            fewShotBlock = `\n\nEXEMPLOS DE ANÁLISES APROVADAS (canais Shorts da mesma faixa "${faixa}" — use como referência de qualidade):\n` +
              rows.map((r, i) => `${i+1}. ${r.nicho ? '[' + r.nicho + '] ' : ''}${(r.diagnostico || '').slice(0, 220)}\n   Dicas top: ${(r.dicas || []).slice(0, 3).map(d => '• ' + (d || '').slice(0, 120)).join(' ')}`).join('\n\n') +
              '\n\nGere análise com qualidade igual ou superior aos exemplos acima.\n';
          }
        }
      } catch (e) { /* sem exemplos, segue */ }
    }

    // ── Bloco Shorts (quando aplicável) ──────────────────────────────────────
    const shortsBlock = isShortsChannel ? `
⚠️ IMPORTANTE — Este é um canal de YouTube Shorts. Faixa detectada: ${faixa || 'n/d'}. Use APENAS estes benchmarks:

BENCHMARKS PARA SHORTS (nunca use métricas de vídeos longos):
- Views por Short: <1K=iniciante (normal, não é ruim), 1K-10K=crescendo, 10K-100K=estabelecido, 100K+=viral
- Taxa de like: 1%+ = bom, 3%+ = excelente para Shorts
- Retenção: 60%+ = bom, 80%+ = excelente para Shorts
- Frequência: 1/dia = ideal, 3-4/semana = bom, menos = problema real

REGRAS ABSOLUTAS PARA CANAIS SHORTS:
- NUNCA compare views de Shorts com as de vídeos longos
- NUNCA diga que um canal com <1K views por Short está "mal" só pelo número — pode ser iniciante normal
- Identifique o NICHO do canal logo nos primeiros 5 segundos da análise, olhando os títulos dos vídeos
- TODAS as dicas devem ser 100% focadas no nicho identificado do canal
- Priorize dicas de maior impacto primeiro (alto impacto no topo)
- No campo "summary", mencione o nicho identificado e a faixa do canal
${fewShotBlock}` : '';

    const systemPrompt = `Você é o BlueScore Engine — um sistema de IA especializado em análise de confiança algorítmica do YouTube, baseado nas diretrizes oficiais do YouTube Partner Program (YPP) e nos padrões de distribuição do algoritmo.
${shortsBlock}
DIRETRIZES YPP QUE VOCÊ CONHECE PROFUNDAMENTE:
1. CONTEÚDO REUTILIZADO: O YouTube penaliza canais que republicam conteúdo de terceiros sem transformação substancial. Sinais: vídeos com views inconsistentes, padrões de título repetitivos, spikes isolados de views.
2. ORIGINALIDADE: Canais precisam demonstrar valor criativo único. Edição mínima, narração sintética óbvia e conteúdo compilado sem comentário original reduzem distribuição.
3. ENGAJAMENTO REAL: O algoritmo prioriza engajamento orgânico. Baixa razão comentário/like pode indicar engajamento artificial. Responder comentários tem correlação positiva com distribuição comprovada.
4. CONSISTÊNCIA: Canais com postagem irregular perdem posição nos feeds. O algoritmo valoriza previsibilidade.
5. RETENÇÃO INICIAL: Os primeiros 30 segundos determinam a distribuição. Vídeos com alto abandono inicial recebem menos impressões.
6. SINAIS DE VOZ SINTÉTICA: Canais dark-face que usam narração IA sem disclosure podem ser penalizados. O YPP exige transparência sobre conteúdo gerado por IA desde 2024.
7. CTR: Thumbnails e títulos com CTR abaixo de 2% recebem menos impressões orgânicas.

DADOS DO CANAL PARA ANÁLISE:
- Nome: ${channelData.title}
- Inscritos: ${channelData.subscribers?.toLocaleString()}
- Total de vídeos: ${channelData.videoCount}
- Total de views do canal: ${(channelData.totalViews || 0).toLocaleString()}
- País: ${channelData.country || 'não informado'}
- BlueScore calculado: ${scoreData.score}/100
- Classificação: ${scoreData.classLabel}
${Array.isArray(scoreData.scoreRiskFlags) && scoreData.scoreRiskFlags.length ? `
SINAIS DETECTADOS PELO ENGINE (comente estes especificamente no diagnóstico):
${scoreData.scoreRiskFlags.map(f => `- [${f.severity?.toUpperCase() || 'INFO'}] ${f.flag}: ${f.detail}`).join('\n')}
` : ''}

MÉTRICAS CALCULADAS:
- Média de views (últimos ${videos.length} vídeos): ${Math.round(scoreData.metrics?.avgViews || 0).toLocaleString()}
- Taxa de engajamento médio: ${(scoreData.metrics?.avgEngRate || 0).toFixed(2)}%
- Razão comentário/like: ${commentRatio.toFixed(3)} ${commentRatio < 0.05 ? '(BAIXA — possível engajamento artificial ou ausência de resposta a comentários)' : commentRatio > 0.15 ? '(ALTA — boa interação)' : '(normal)'}
- Frequência de postagem: 1 vídeo a cada ~${Math.round(daysBetween)} dias
- Tendência: ${(scoreData.metrics?.trendRatio || 1) > 1.1 ? 'CRESCENDO' : (scoreData.metrics?.trendRatio || 1) < 0.9 ? 'CAINDO' : 'ESTÁVEL'} (${Math.round(((scoreData.metrics?.trendRatio || 1) - 1) * 100)}% vs período anterior)
- Consistência de views: ${scoreData.metrics?.cv < 0.5 ? 'ALTA (bom)' : scoreData.metrics?.cv < 1 ? 'MODERADA' : 'BAIXA — variação suspeita'}
- Proporção Shorts: ${Math.round(shortsRatio * 100)}% dos vídeos são Shorts
- Vídeos com engajamento anormalmente baixo: ${lowEngVideos} de ${videos.length}
- Padrão de título repetitivo detectado: ${hasRepetitivePattern ? 'SIM — palavras: ' + topWords.map(([w,n]) => w+'('+n+'x)').join(', ') : 'NÃO'}
- Spike anormal de views detectado: ${hasOutlier ? 'SIM — um vídeo tem ' + Math.round(maxViews/avgViews) + 'x a média (possível viral de terceiro ou compra de views)' : 'NÃO'}

TÍTULOS DOS ÚLTIMOS VÍDEOS:
${titles.slice(0, 8).map((t,i) => (i+1) + '. ' + t).join('\n')}
')}

INSTRUÇÃO:
Gere uma análise profunda, honesta e acionável. NÃO seja genérico. Use os dados específicos do canal. Identifique padrões reais. Se detectar sinais de conteúdo reutilizado, diga claramente. Se a razão comentário/like for baixa, mencione que responder comentários tem impacto comprovado.

Responda APENAS em JSON válido sem markdown:
{
  "insights": [
    {
      "type": "pos|neg|warn",
      "title": "título direto e específico",
      "desc": "análise detalhada de 2-3 frases com dados reais do canal e conexão com as diretrizes do YouTube"
    }
  ],
  "riskFlags": [
    {
      "flag": "nome_do_risco",
      "severity": "high|medium|low",
      "title": "título do risco",
      "desc": "explicação do risco baseada nas diretrizes YPP"
    }
  ],
  "recommendations": [
    {
      "priority": 1,
      "action": "ação específica e mensurável",
      "why": "por que isso vai melhorar o score com base em dados reais do canal",
      "impact": "high|medium|low"
    }
  ],
  "summary": "diagnóstico executivo em 2 frases, honesto, com o principal problema e principal oportunidade do canal",
  "niche": "nicho identificado do canal em 1-3 palavras (ex: 'Tech reviews', 'Humor diário', 'Receitas fit')",
  "ytpCompliance": {
    "score": 0-100,
    "status": "aprovado|atenção|risco",
    "notes": "avaliação de conformidade com o YouTube Partner Program"
  }
}`;

    // Helper para extrair JSON da resposta
    const extractJson = (text) => {
      text = text.split('```json').join('').split('```').join('').trim();
      const s = text.indexOf('{');
      const e = text.lastIndexOf('}');
      if (s === -1 || e === -1) return null;
      try { return JSON.parse(text.slice(s, e + 1)); }
      catch(e) { return null; }
    };

    // Tenta OpenAI primeiro (mais rápido, menos timeout)
    let parsed = null;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (OPENAI_KEY && !parsed) {
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: systemPrompt }],
            max_tokens: 1200,
            temperature: 0.4
          })
        });
        const d = await r.json();
        if (r.ok && d.choices?.[0]?.message?.content) {
          parsed = extractJson(d.choices[0].message.content);
          if (parsed) console.log('BlueScore AI: OpenAI OK');
        }
      } catch(e) { console.log('OpenAI BlueScore error:', e.message); }
    }

    // Fallback: Gemini (tenta até 3 chaves para não dar timeout)
    if (!parsed) {
      const keysToTry = GEMINI_KEYS.slice(0, 3);
      for (const key of keysToTry) {
        if (parsed) break;
        try {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: systemPrompt }] }],
              generationConfig: { temperature: 0.4, maxOutputTokens: 1200 }
            })
          });
          const d = await r.json();
          if (d.error?.code === 429) continue;
          if (!r.ok) continue;
          const text = d.candidates?.[0]?.content?.parts?.map(p => p.text||'').join('').trim() || '';
          console.log('Gemini BlueScore raw:', text.slice(0, 200));
          parsed = extractJson(text);
          if (parsed) console.log('BlueScore AI: Gemini OK');
        } catch(e) { console.log('Gemini error:', e.message); continue; }
      }
    }

    if (parsed) {
        // Salva análise com aprendizado na tabela bluescore_analises (PT)
        const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
        if (SUPA_URL && SUPA_KEY) {
          try {
            const dicasArr = (parsed.recommendations || [])
              .map(r => typeof r === 'object' ? (r.action || '') : String(r || ''))
              .filter(Boolean)
              .slice(0, 10);
            const insR = await fetch(`${SUPA_URL}/rest/v1/bluescore_analises`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': SUPA_KEY,
                'Authorization': `Bearer ${SUPA_KEY}`,
                'Prefer': 'return=representation'
              },
              body: JSON.stringify({
                canal_id: channelData.channelId,
                canal_nome: channelData.title,
                nicho: parsed.niche || null,
                eh_shorts: !!isShortsChannel,
                score: scoreData.score,
                faixa: faixa || null,
                metricas: {
                  avg_views: Math.round(scoreData.metrics?.avgViews || 0),
                  engagement_rate: scoreData.metrics?.avgEngRate || 0,
                  trend_ratio: scoreData.metrics?.trendRatio || 1,
                  classification: scoreData.classification,
                  components: scoreData.components || null,
                  bonuses: scoreData.bonuses || null
                },
                diagnostico: parsed.summary || '',
                dicas: dicasArr,
                feedback_util: null
              })
            });
            if (insR.ok) {
              const rows = await insR.json();
              if (rows?.[0]?.id) parsed.analise_id = rows[0].id;
            }
          } catch (e) { console.log('bluescore_analises insert:', e.message); }
        }

        return res.status(200).json(parsed);
    }

    return res.status(200).json({ insights: [], riskFlags: [], recommendations: [], summary: 'Análise indisponível no momento.', ytpCompliance: { score: 0, status: 'atenção', notes: '' } });
  }

  // Detecta idioma provável pelo título (fallback quando YouTube não retorna metadados)
  function detectLangFromTitle(title) {
    if (!title) return '';
    // Caracteres exclusivos de scripts específicos
    if (/[\u0900-\u097F]/.test(title)) return 'hi'; // Devanagari (Hindi)
    if (/[\u0600-\u06FF]/.test(title)) return 'ar'; // Árabe
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(title)) return 'ja'; // Japonês
    if (/[\uAC00-\uD7AF]/.test(title)) return 'ko'; // Coreano
    if (/[\u4E00-\u9FFF]/.test(title)) return 'zh'; // Chinês
    if (/[\u0E00-\u0E7F]/.test(title)) return 'th'; // Tailandês
    if (/[\u0980-\u09FF]/.test(title)) return 'bn'; // Bengali
    if (/[\u0C80-\u0CFF]/.test(title)) return 'kn'; // Kannada
    if (/[\u0B80-\u0BFF]/.test(title)) return 'ta'; // Tamil
    if (/[\u0A00-\u0A7F]/.test(title)) return 'pa'; // Punjabi
    // Palavras exclusivas de cada idioma (evita falsos positivos com palavras globais como "shorts", "viral")
    const lower = title.toLowerCase();
    if (/\b(você|voce|não|nao|muito|isso|esse|essa|pra|vídeo|brasil|incrível|incrivel|então|entao|ninguém|ninguem|também|tambem|porquê)\b/.test(lower)) return 'pt';
    if (/\b(esto|porque|muy|pero|mejor|más|todos|aquí|también|puede|cuando|tiene|desde|entre|hasta|después|siempre)\b/.test(lower)) return 'es';
    if (/\b(und|das|ist|ein|für|mit|auf|dem|den|die|der|nicht|auch|sich)\b/.test(lower)) return 'de';
    if (/\b(les|des|une|est|pas|pour|dans|avec|sur|ses|cette|nous|vous|sont|leur)\b/.test(lower)) return 'fr';
    if (/\b(bir|bu|ile|için|olan|çok|daha|ama|değil|kadar|sonra|olarak)\b/.test(lower)) return 'tr';
    // Inglês: só detecta se tiver 3+ palavras exclusivas (evita falso positivo com títulos internacionais)
    const enWords = lower.match(/\b(the|this|that|with|from|what|when|about|just|your|will|been|have|than|nobody|could|would|should|because|every|never|always)\b/g);
    if (enWords && enWords.length >= 3) return 'en';
    return '';
  }

  if (req.method === 'GET' && req.query?.action === 'viral-shorts') {
    // Rotação de 3 chaves para triplicar a cota diária (30.000 unidades/dia)
    const YT_KEYS = [
      process.env.YOUTUBE_API_KEY,
      process.env.YOUTUBE_API_KEY_2,
      process.env.YOUTUBE_API_KEY_3,
      process.env.YOUTUBE_API_KEY_4,
      process.env.YOUTUBE_API_KEY_5,
      process.env.YOUTUBE_API_KEY_6,
      process.env.YOUTUBE_API_KEY_7,
      process.env.YOUTUBE_API_KEY_8,
      process.env.YOUTUBE_API_KEY_9,
      process.env.YOUTUBE_API_KEY_10,
    ].filter(Boolean);
    if (!YT_KEYS.length) return res.status(500).json({ error: 'YouTube API nao configurada.' });

    // Rotaciona chave por hora para distribuir cota ao longo do dia
    const keyIndex = Math.floor(Date.now() / (60*60*1000)) % YT_KEYS.length;
    let YT_KEY = YT_KEYS[keyIndex];

    const { period = '7d', category = '', region = 'BR', q = '' } = req.query;

    const now = new Date();
    const cutoffMs = period === '24h' ? 24*60*60*1000
      : period === '7d' ? 7*24*60*60*1000
      : 30*24*60*60*1000;
    const cutoffDate = new Date(now - cutoffMs);
    const publishedAfter = cutoffDate.toISOString();

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

    // Cache no Supabase: chave = region+period+category+q, TTL = 1h (24h para período 30d)
    const cacheKey = `virais_${region}_${period}_${category}_${q.slice(0,20).replace(/\s/g,'_')}`;
    const cacheTTL = 14*60*60*1000; // 14h para todos os períodos

    // Tenta ler cache do Supabase
    if (SUPABASE_URL && SUPABASE_KEY && !q) {
      try {
        const cacheRes = await fetch(
          `${SUPABASE_URL}/rest/v1/viral_cache?cache_key=eq.${encodeURIComponent(cacheKey)}&select=data,cached_at`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        if (cacheRes.ok) {
          const rows = await cacheRes.json();
          if (rows?.[0]) {
            const age = Date.now() - new Date(rows[0].cached_at).getTime();
            if (age < cacheTTL) {
              // Aplica filtro de views mínimas no cache também
              const minV = period === '24h' ? 100000 : period === '7d' ? 1000000 : 3000000;
              const cachedVideos = (rows[0].data?.videos || []).filter(v => v.views >= minV);
              // Se cache ficou vazio após filtro, ignora e rebusca
              if (cachedVideos.length === 0 && rows[0].data?.videos?.length > 0) {
                console.log('viral-shorts CACHE STALE (views abaixo do mínimo), rebuscando...');
                // Apaga cache antigo para forçar nova busca
                fetch(`${SUPABASE_URL}/rest/v1/viral_cache?cache_key=eq.${encodeURIComponent(cacheKey)}`, {
                  method: 'DELETE',
                  headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
                }).catch(()=>{});
              } else {
                console.log('viral-shorts CACHE HIT:', cacheKey, 'age:', Math.round(age/60000)+'min', '| vídeos:', cachedVideos.length);
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
                return res.status(200).json({ ...rows[0].data, videos: cachedVideos, total: cachedVideos.length, fromCache: true, cacheAge: Math.round(age/60000) });
              }
            }
          }
        }
      } catch(e) { /* cache miss, continua */ }
    }

    // Queries massivas no idioma nativo — muitas queries = mais cobertura
    const REGION_CONFIG = {
      BR:  { lang:'pt', rc:'BR', queries: [
        'shorts viralizou', 'shorts mais visto brasil', 'voce sabia shorts', 'curiosidades shorts',
        'shorts viral brasil', 'fatos incriveis shorts', 'shorts narrado', 'inacreditavel shorts',
        'shorts impressionante', 'ninguem esperava shorts', 'shorts chocante brasil'
      ]},
      US:  { lang:'en', rc:'US', queries: [
        'did you know shorts', 'facts shorts viral', 'amazing facts shorts', 'mind blowing shorts',
        'narrated shorts viral', 'story time shorts', 'unbelievable shorts', 'you wont believe shorts',
        'shorts facts english', 'crazy facts shorts', 'shocking shorts viral'
      ]},
      ES:  { lang:'es', rc:'ES', queries: [
        'curiosidades shorts español', 'sabías que shorts', 'datos curiosos shorts', 'shorts viral español',
        'increíble shorts', 'shorts impactante', 'no vas a creer shorts', 'shorts narrado español',
        'shorts más visto español', 'hechos increíbles shorts'
      ]},
      JP:  { lang:'ja', rc:'JP', queries: [
        'ショート 急上昇', 'ショート バズった', '雑学 ショート', '豆知識 ショート',
        'ショート 衝撃', '知らなかった ショート', 'ショート 面白い事実', 'ショート ナレーション',
        '驚き ショート', 'ショート 人気'
      ]},
      DE:  { lang:'de', rc:'DE', queries: [
        'wusstest du shorts', 'fakten shorts deutsch', 'unglaublich shorts', 'shorts viral deutsch',
        'erstaunliche fakten shorts', 'shorts trending deutsch', 'krass shorts', 'shorts wissen deutsch',
        'schockierend shorts', 'shorts deutsch beliebt'
      ]},
      FR:  { lang:'fr', rc:'FR', queries: [
        'le saviez vous shorts', 'faits incroyables shorts', 'shorts viral france', 'incroyable shorts',
        'shorts tendance france', 'shorts français populaire', 'choquant shorts', 'shorts narré français',
        'curiosités shorts français', 'shorts impressionnant'
      ]},
    };

    const cfg = REGION_CONFIG[region] || REGION_CONFIG['BR'];
    const { lang, queries: regionQueries, rc } = cfg;
    const searchQueries = regionQueries;

    const fmtViews = n => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : n.toString();

    // Tenta busca com uma chave, se der 403/quota error tenta a próxima
    const makeSearch = async (searchQ, order = 'viewCount') => {
      for (let ki = 0; ki < YT_KEYS.length; ki++) {
        const key = YT_KEYS[(keyIndex + ki) % YT_KEYS.length];
        const params = new URLSearchParams({
          part: 'snippet', type: 'video', videoDuration: 'short',
          order, maxResults: '50',
          key, q: searchQ, publishedAfter,
          ...(lang ? { relevanceLanguage: lang } : {}),
          ...(rc ? { regionCode: rc } : {}),
        });
        const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
        const d = await r.json();
        if (d.error?.code === 403 || d.error?.message?.includes('quota')) {
          console.log('Quota esgotada na chave', ki, '- tentando próxima...');
          continue;
        }
        console.log('YT search:', searchQ.slice(0,25), '| order:', order, '| key:', ki, '| items:', d.items?.length || 0);
        if (!r.ok) return [];
        return d.items || [];
      }
      return [];
    };

    try {
      // Busca com viewCount E relevance em TODAS as queries para máxima cobertura
      const allSearches = await Promise.all([
        ...searchQueries.map(sq => makeSearch(sq, 'viewCount')),
        ...searchQueries.map(sq => makeSearch(sq, 'relevance'))
      ]);

      const seen = new Set();
      const allItems = allSearches.flat().filter(i => {
        const id = i.id?.videoId;
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      console.log('viral-shorts bruto:', allItems.length, '| região:', region, '| período:', period);
      if (!allItems.length) return res.status(200).json({ videos: [], total: 0, quotaError: true });

      // Stats em lotes de 50 com rotação de chave
      const allVideoIds = allItems.map(i => i.id.videoId);
      const chunks = [];
      for (let i = 0; i < allVideoIds.length; i += 50) chunks.push(allVideoIds.slice(i, i+50));

      const statsResults = await Promise.all(
        chunks.map((ids, ci) => {
          const key = YT_KEYS[(keyIndex + ci) % YT_KEYS.length];
          return fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet,contentDetails&id=${ids.join(',')}&key=${key}`)
            .then(r => r.json()).then(d => d.items || []).catch(() => []);
        })
      );

      // Cada país aceita APENAS seu idioma — bloqueia todo o resto
      const _allLangs = ['pt','en','es','ja','de','fr','hi','ar','ko','zh','th','bn','kn','ta','pa','tr','id','ru','te','mr','gu','ml','si','ne','ur'];
      const ALLOWED_LANG = { BR: ['pt'], US: ['en'], ES: ['es'], JP: ['ja'], DE: ['de'], FR: ['fr'] };
      const allowed = ALLOWED_LANG[region] || ['pt'];
      const blockedLangs = _allLangs.filter(l => !allowed.includes(l));

      const allVideos = statsResults.flat().map(v => {
        const stats = v.statistics || {}, snippet = v.snippet || {};
        const dur = v.contentDetails?.duration || '';
        const m = dur.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
        const secs = (parseInt(m?.[1]||0)*60)+parseInt(m?.[2]||0);
        const views = parseInt(stats.viewCount||0);
        const rawAudio = (snippet.defaultAudioLanguage || '').slice(0,2).toLowerCase();
        const rawText = (snippet.defaultLanguage || '').slice(0,2).toLowerCase();
        // 'un' = undefined no YouTube, ignorar
        const audioLang = (rawAudio && rawAudio !== 'un') ? rawAudio : '';
        const textLang = (rawText && rawText !== 'un') ? rawText : '';
        const titleLang = detectLangFromTitle(snippet.title || '');
        const detectedLang = audioLang || textLang || titleLang || '';
        return {
          id: v.id, title: snippet.title, channel: snippet.channelTitle,
          thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url,
          views, viewsFormatted: fmtViews(views), likes: parseInt(stats.likeCount||0),
          publishedAt: snippet.publishedAt, duration: secs,
          url: `https://www.youtube.com/shorts/${v.id}`,
          _lang: detectedLang
        };
      }).filter(v => {
        if (v.duration > 65 && v.duration !== 0) return false;
        // Se detectou idioma, bloqueia se não é do país
        if (v._lang && blockedLangs.includes(v._lang)) return false;
        // Se NÃO detectou idioma, usa o título para verificar se tem script incompatível
        if (!v._lang) {
          const t = v.title || '';
          // Bloqueia se tem caracteres de scripts não-latinos (para países latinos)
          if (allowed.every(a => ['pt','en','es','de','fr'].includes(a))) {
            if (/[\u0900-\u097F\u0600-\u06FF\u0E00-\u0E7F\u0980-\u09FF\u0C80-\u0CFF\u0B80-\u0BFF\u0A00-\u0A7F]/.test(t)) return false;
          }
        }
        return true;
      });

      // Views mínimas por período — mesmo threshold para todos
      const MIN_VIEWS = period === '24h' ? 100000
                      : period === '7d'  ? 1000000
                      : 3000000;
      console.log('viral-shorts MIN_VIEWS:', MIN_VIEWS, '| total antes filtro:', allVideos.length, '| max views:', Math.max(...allVideos.map(v=>v.views), 0));

      // Filtro de data suave — remove apenas vídeos com mais de 3x o período
      const softCutoff = new Date(now - cutoffMs * 3);
      let videos = allVideos
        .filter(v => !v.publishedAt || new Date(v.publishedAt) >= softCutoff)
        .filter(v => v.views >= MIN_VIEWS)
        .sort((a,b) => b.views - a.views)
        .slice(0, 50); // max 50 — todos são top

      // Fallback: sem filtro de data mas SEMPRE mantém views mínimas
      if (videos.length === 0 && allVideos.length > 0) {
        videos = allVideos
          .filter(v => v.views >= MIN_VIEWS)
          .sort((a,b) => b.views - a.views)
          .slice(0, 50);
        console.log('viral-shorts: fallback sem data, total:', videos.length);
      }

      // NUNCA mostra vídeos abaixo do mínimo de views

      const dateFilterFailed = false;

      const result = { videos, total: videos.length, region, period, dateFilterFailed };

      // Salva cache no Supabase
      if (SUPABASE_URL && SUPABASE_KEY && videos.length > 0 && !q) {
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/viral_cache`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify({ cache_key: cacheKey, data: result, cached_at: new Date().toISOString() })
          });
          console.log('viral-shorts cache salvo:', cacheKey, videos.length, 'vídeos');
        } catch(e) { /* non-blocking */ }
      }

      return res.status(200).json(result);
    } catch(e) {
      console.error('viral-shorts error:', e.message);
      return res.status(500).json({ error: 'Falha ao buscar videos virais: ' + e.message });
    }
  }

  if (req.method === 'GET' && req.query?.action === 'lang') {
    try {
      const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
      let country = 'BR';
      let langCode = 'pt';
      if (ip && ip !== '127.0.0.1' && ip !== '::1' && !ip.startsWith('192.') && !ip.startsWith('10.')) {
        try {
          const geoRes = await fetch(`https://ipapi.co/${ip}/country/`, { headers: { 'User-Agent': 'BlueTube/1.0' } });
          if (geoRes.ok) {
            const text = (await geoRes.text()).trim().toUpperCase();
            if (text.length === 2) { country = text; langCode = COUNTRY_LANG[country] || 'pt'; }
          }
        } catch (e) { /* default pt */ }
      }
      const translations = TRANSLATIONS[langCode] || TRANSLATIONS['pt'];
      const currency = COUNTRY_CURRENCY[country] || 'USD';
      const symbol = CURRENCY_SYMBOLS[currency] || currency;

      // Fetch exchange rate BRL → user currency (cached in Supabase for 24h)
      let rate = null;
      if (currency !== 'BRL') {
        const SU = SUPA_URL, SK = SUPA_KEY;
        const cacheKey = `fx_brl_${currency}`;
        // Check Supabase cache first
        if (SU && SK) {
          try {
            const cr = await fetch(`${SU}/rest/v1/api_cache?cache_key=eq.${cacheKey}&expires_at=gt.${new Date().toISOString()}&select=value&limit=1`, {
              headers: { 'apikey': SK, 'Authorization': `Bearer ${SK}` }
            });
            if (cr.ok) { const cd = await cr.json(); if (cd?.[0]?.value?.rate) rate = cd[0].value.rate; }
          } catch(e) {}
        }
        // If no cache, fetch fresh rate
        if (!rate) {
          try {
            const fxRes = await fetch(`https://open.er-api.com/v6/latest/BRL`);
            if (fxRes.ok) {
              const fxData = await fxRes.json();
              if (fxData.rates?.[currency]) {
                rate = fxData.rates[currency];
                // Cache for 24h in Supabase
                if (SU && SK) {
                  fetch(`${SU}/rest/v1/api_cache?cache_key=eq.${cacheKey}`, { method:'DELETE', headers:{'apikey':SK,'Authorization':`Bearer ${SK}`} }).catch(()=>{});
                  fetch(`${SU}/rest/v1/api_cache`, { method:'POST', headers:{'Content-Type':'application/json','apikey':SK,'Authorization':`Bearer ${SK}`,'Prefer':'return=minimal'},
                    body:JSON.stringify({cache_key:cacheKey,value:{rate,currency,fetched:new Date().toISOString()},created_at:new Date().toISOString(),expires_at:new Date(Date.now()+24*3600*1000).toISOString()})
                  }).catch(()=>{});
                }
              }
            }
          } catch(e) {}
        }
      }

      return res.status(200).json({
        country, lang: langCode, translations,
        currency: { code: currency, symbol, rate, isBRL: currency === 'BRL' }
      });
    } catch (e) {
      return res.status(200).json({ country: 'BR', lang: 'pt', translations: TRANSLATIONS['pt'], currency: { code: 'BRL', symbol: 'R$', rate: null, isBRL: true } });
    }
  }

  // ── VOICE PREVIEW (GET, sample sem custo) ────────────────────────────────
  if (req.method === 'GET' && req.query?.action === 'voice-preview') {
    const XI_KEY = process.env.ELEVENLABS_API_KEY;
    if (!XI_KEY) return res.status(500).json({ error: 'Voz não disponível.' });
    const { voiceId } = req.query;
    if (!voiceId) return res.status(400).json({ error: 'voiceId obrigatório' });

    try {
      // Busca metadados da voz incluindo preview_url
      const r = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
        headers: { 'xi-api-key': XI_KEY }
      });
      if (!r.ok) return res.status(404).json({ error: 'Voz não encontrada' });
      const data = await r.json();
      const previewUrl = data.preview_url;
      if (!previewUrl) {
        // Voz clonada sem preview — gera TTS curto como fallback
        try {
          const ttsR = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: 'POST',
            headers: { 'xi-api-key': XI_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
            body: JSON.stringify({ text: 'Olá! Essa é uma prévia da minha voz.', model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
          });
          if (ttsR.ok) {
            const buf = await ttsR.arrayBuffer();
            return res.status(200).json({ audio: Buffer.from(buf).toString('base64'), format: 'mp3', name: data.name });
          }
        } catch(e) {}
        return res.status(404).json({ error: 'Prévia não disponível' });
      }

      // Faz proxy do áudio para evitar CORS
      const audioRes = await fetch(previewUrl);
      if (!audioRes.ok) return res.status(502).json({ error: 'Prévia indisponível' });

      const audioBuffer = await audioRes.arrayBuffer();
      const base64 = Buffer.from(audioBuffer).toString('base64');
      return res.status(200).json({ audio: base64, format: 'mp3', name: data.name });
    } catch(e) {
      console.error('Preview error:', e.message);
      return res.status(500).json({ error: 'Prévia indisponível' });
    }
  }

  // ── TEXT TO SPEECH (ElevenLabs) ────────────────────────────────────────────
  if (req.body?.action === 'tts') {
    const userKey = req.body.user_xi_key;
    const sysKey = process.env.ELEVENLABS_API_KEY;
    // Try user key first (for cloned voices), then system key
    const XI_KEY = (userKey && userKey.length > 10) ? userKey : sysKey;
    if (!XI_KEY) return res.status(500).json({ error: 'ElevenLabs não configurado.' });

    const { voiceId, text, model = 'eleven_multilingual_v2', stability = 0.5, similarity = 0.75 } = req.body;
    if (!voiceId || !text) return res.status(400).json({ error: 'voiceId e text são obrigatórios' });
    if (text.length > 3000) return res.status(400).json({ error: 'Texto excede 3000 caracteres' });

    try {
      // eleven_v3 usa endpoint diferente (turbo/v3 preview)
      const isV3 = model === 'eleven_v3';
      const modelId = isV3 ? 'eleven_v3' : (model || 'eleven_multilingual_v2');
      const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

      const ttsRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'xi-api-key': XI_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
        body: JSON.stringify({
          text, model_id: modelId,
          voice_settings: { stability, similarity_boost: similarity, style: 0.4, use_speaker_boost: true }
        })
      });

      if (!ttsRes.ok) {
        // Retry with the other key if available
        const fallbackKey = XI_KEY === userKey ? sysKey : (userKey && userKey.length > 10 ? userKey : null);
        if (fallbackKey && fallbackKey !== XI_KEY) {
          console.log('[tts] Retrying with fallback key');
          const retryRes = await fetch(endpoint, {
            method: 'POST',
            headers: { 'xi-api-key': fallbackKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
            body: JSON.stringify({ text, model_id: modelId, voice_settings: { stability, similarity_boost: similarity, style: 0.4, use_speaker_boost: true } })
          });
          if (retryRes.ok) {
            const buf = await retryRes.arrayBuffer();
            return res.status(200).json({ audio: Buffer.from(buf).toString('base64'), format: 'mp3' });
          }
        }
        const err = await ttsRes.json().catch(()=>({}));
        console.error('TTS error:', err.detail?.message || err.detail || 'unknown');
        return res.status(400).json({ error: 'Falha ao gerar narração. Esta voz pode não estar acessível.' });
      }

      const audioBuffer = await ttsRes.arrayBuffer();
      const base64 = Buffer.from(audioBuffer).toString('base64');
      return res.status(200).json({ audio: base64, format: 'mp3' });
    } catch(e) {
      console.error('TTS exception:', e.message);
      return res.status(500).json({ error: 'Falha ao gerar narração. Tente novamente.' });
    }
  }

  // action vem de body (POST) ou query (GET)
  const { action, email, password, token, otp } = req.body || {};
  const _action = action || req.query?.action;
  const SUPABASE_URL = process.env.SUPABASE_URL;

  // Use anon key if available, fallback to service key
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing env vars:', { hasUrl: !!SUPABASE_URL, hasKey: !!SUPABASE_KEY });
    return res.status(500).json({ error: `Configuração incompleta: URL=${!!SUPABASE_URL} KEY=${!!SUPABASE_KEY}` });
  }

  const authBase = `${SUPABASE_URL}/auth/v1`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`
  };

  try {

    // ── SIGN UP — NÃO cria conta. Salva dados + envia OTP. Conta criada só após verificação.
    if (action === 'signup') {
      if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });
      if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter mínimo 6 caracteres' });

      // Verificação de duplicata acontece no verify_otp quando tentar criar a conta
      const refCode = req.body?.ref_code || null;
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      console.log('[auth] Signup OTP for:', email, 'code:', otp);

      // Salva dados pendentes no cache (NÃO cria conta ainda)
      await fetch(`${SUPA_URL}/rest/v1/api_cache?cache_key=eq.otp_${encodeURIComponent(email)}`, { method: 'DELETE', headers: supaH }).catch(() => {});
      const saveR = await fetch(`${SUPA_URL}/rest/v1/api_cache`, {
        method: 'POST', headers: { ...supaH, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          cache_key: 'otp_' + email,
          value: { code: otp, password, ref_code: refCode },
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 600000).toISOString()
        })
      });
      console.log('[auth] OTP cache save:', saveR.status);

      // Envia OTP via Resend
      const RESEND = process.env.RESEND_API_KEY;
      if (RESEND) {
        const emailR = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND },
          body: JSON.stringify({
            from: 'BlueTube <noreply@bluetubeviral.com>', to: [email],
            subject: otp + ' — Seu código de verificação BlueTube',
            html: `<div style="background:#020817;color:#e8f4ff;font-family:-apple-system,sans-serif;padding:40px;max-width:480px;margin:0 auto;border-radius:16px;border:1px solid rgba(0,170,255,.2)">
              <div style="text-align:center;margin-bottom:20px"><span style="font-size:24px;font-weight:800;color:#fff">Blue<span style="color:#00aaff">Tube</span></span></div>
              <p style="font-size:16px;text-align:center">Seu código de verificação:</p>
              <div style="background:#0a1628;border:1px solid #1a6bff;border-radius:12px;padding:28px;text-align:center;margin:20px 0">
                <span style="font-size:44px;font-weight:800;letter-spacing:14px;color:#00aaff">${otp}</span>
              </div>
              <p style="color:rgba(200,225,255,0.5);font-size:13px;text-align:center">Este código expira em 10 minutos.</p>
              <p style="color:rgba(200,225,255,0.3);font-size:12px;text-align:center;margin-top:16px">Se não foi você, ignore este email.</p>
            </div>`
          })
        });
        const emailBody = await emailR.json().catch(() => ({}));
        console.log('[auth] Resend OTP email:', emailR.status, JSON.stringify(emailBody).slice(0, 200));
        if (!emailR.ok) {
          return res.status(200).json({ session: null, needsOTP: true, emailError: emailBody.message || 'Falha ao enviar email' });
        }
      } else {
        console.error('[auth] RESEND_API_KEY not set!');
        return res.status(500).json({ error: 'Sistema de email não configurado.' });
      }

      return res.status(200).json({ session: null, needsOTP: true, emailSent: true });
    }

    // ── SIGN IN ───────────────────────────────────────────────────────────────
    if (action === 'signin') {
      if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });

      const r = await fetch(`${authBase}/token?grant_type=password`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, password })
      });
      const data = await r.json();

      if (!r.ok) {
        const msg = data.error_description || data.msg || data.error || 'Credenciais inválidas';
        if (msg.includes('Invalid login') || msg.includes('invalid')) {
          return res.status(400).json({ error: 'Email ou senha incorretos' });
        }
        // Email não confirmado → gerar OTP customizado via Resend
        if (msg.includes('Email not confirmed')) {
          const otp = String(Math.floor(100000 + Math.random() * 900000));
          if (SUPA_URL && SUPA_KEY) {
            await fetch(`${SUPA_URL}/rest/v1/api_cache?cache_key=eq.otp_${encodeURIComponent(email)}`, { method: 'DELETE', headers: supaH }).catch(() => {});
            await fetch(`${SUPA_URL}/rest/v1/api_cache`, {
              method: 'POST', headers: { ...supaH, 'Prefer': 'return=minimal' },
              body: JSON.stringify({ cache_key: 'otp_' + email, value: { code: otp, password }, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString() })
            }).catch(() => {});
          }
          const RESEND = process.env.RESEND_API_KEY;
          if (RESEND) {
            fetch('https://api.resend.com/emails', { method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND },
              body: JSON.stringify({ from: 'BlueTube <noreply@bluetubeviral.com>', to: [email],
                subject: otp + ' — Seu código de verificação BlueTube',
                html: `<div style="background:#020817;color:#e8f4ff;font-family:sans-serif;padding:40px;max-width:480px;margin:0 auto;border-radius:16px"><h1 style="color:#00aaff">BlueTube</h1><p>Seu código:</p><div style="background:#0a1628;border:1px solid #1a6bff;border-radius:12px;padding:24px;text-align:center;margin:20px 0"><span style="font-size:40px;font-weight:800;letter-spacing:12px;color:#00aaff">${otp}</span></div><p style="color:rgba(200,225,255,0.55);font-size:13px">Expira em 10 minutos.</p></div>`
              })
            }).catch(() => {});
          }
          return res.status(200).json({ session: null, needsOTP: true, error: null });
        }
        return res.status(400).json({ error: msg });
      }

      // Garante que usuário existe na tabela subscribers (upsert seguro)
      if (email && SUPABASE_URL && SUPABASE_KEY) {
        fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'resolution=ignore,return=minimal' // ignora se já existe
          },
          body: JSON.stringify({
            email,
            plan: 'free',
            is_manual: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        }).catch(() => {});
      }

      return res.status(200).json({
        user: data.user,
        session: { access_token: data.access_token }
      });
    }

    // ── RESEND CONFIRMATION EMAIL ─────────────────────────────────────────────
    if (action === 'send_otp') {
      if (!email) return res.status(400).json({ error: 'Email é obrigatório' });

      // Generate and send custom OTP via Resend
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      // Save to cache
      if (SUPA_URL && SUPA_KEY) {
        // Get stored password from existing OTP cache (if resending)
        let storedPwd = '';
        try {
          const old = await fetch(`${SUPA_URL}/rest/v1/api_cache?cache_key=eq.otp_${encodeURIComponent(email)}&select=value`, { headers: supaH });
          if (old.ok) { const od = await old.json(); storedPwd = od?.[0]?.value?.password || ''; }
        } catch(e) {}
        await fetch(`${SUPA_URL}/rest/v1/api_cache?cache_key=eq.otp_${encodeURIComponent(email)}`, { method: 'DELETE', headers: supaH }).catch(() => {});
        await fetch(`${SUPA_URL}/rest/v1/api_cache`, {
          method: 'POST', headers: { ...supaH, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ cache_key: 'otp_' + email, value: { code: otp, password: storedPwd }, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString() })
        }).catch(() => {});
      }
      const RESEND = process.env.RESEND_API_KEY;
      if (RESEND) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + RESEND },
          body: JSON.stringify({
            from: 'BlueTube <noreply@bluetubeviral.com>', to: [email],
            subject: otp + ' — Seu código de verificação BlueTube',
            html: `<div style="background:#020817;color:#e8f4ff;font-family:sans-serif;padding:40px;max-width:480px;margin:0 auto;border-radius:16px"><h1 style="color:#00aaff">BlueTube</h1><p>Seu código de verificação:</p><div style="background:#0a1628;border:1px solid #1a6bff;border-radius:12px;padding:24px;text-align:center;margin:20px 0"><span style="font-size:40px;font-weight:800;letter-spacing:12px;color:#00aaff">${otp}</span></div><p style="color:rgba(200,225,255,0.55);font-size:13px">Expira em 10 minutos.</p></div>`
          })
        });
      }

      return res.status(200).json({ sent: true, message: 'Código enviado!' });
    }

    // ── VERIFY OTP ────────────────────────────────────────────────────────────
    if (action === 'verify_otp') {
      if (!email || !otp) return res.status(400).json({ error: 'Email e código são obrigatórios' });

      // Check custom OTP from cache
      try {
        const cr = await fetch(`${SUPA_URL}/rest/v1/api_cache?cache_key=eq.otp_${encodeURIComponent(email)}&expires_at=gt.${new Date().toISOString()}&select=value`, { headers: supaH });
        if (!cr.ok) return res.status(400).json({ error: 'Código expirado. Clique em reenviar.' });
        const cd = await cr.json();
        const stored = cd?.[0]?.value;
        if (!stored || stored.code !== otp) {
          return res.status(400).json({ error: 'Código incorreto. Verifique e tente novamente.' });
        }

        // OTP CORRETO → AGORA criar conta no Supabase Auth
        console.log('[auth] OTP verified for:', email, '— creating account');
        const signupR = await fetch(`${authBase}/signup`, {
          method: 'POST', headers,
          body: JSON.stringify({ email, password: stored.password })
        });
        const signupD = await signupR.json();

        // Tenta login imediato
        let session = signupD.session;
        if (!session) {
          const loginR = await fetch(`${authBase}/token?grant_type=password`, {
            method: 'POST', headers,
            body: JSON.stringify({ email, password: stored.password })
          });
          if (loginR.ok) session = await loginR.json();
        }

        // Registra na tabela subscribers + email_marketing
        fetch(`${SUPA_URL}/rest/v1/subscribers`, {
          method: 'POST',
          headers: { ...supaH, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ email, plan: 'free', is_manual: false, affiliate_ref: stored.ref_code || null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        }).catch(() => {});
        fetch(`${SUPA_URL}/rest/v1/email_marketing`, {
          method: 'POST', headers: { ...supaH, 'Prefer': 'resolution=ignore,return=minimal' },
          body: JSON.stringify({ email, sequence_position: 0, total_sent: 0, unsubscribed: false, created_at: new Date().toISOString() })
        }).catch(() => {});
        // Afiliado
        if (stored.ref_code) {
          fetch(`${process.env.SITE_URL || 'https://bluetubeviral.com'}/api/auth`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'conversion', email, plan: 'free', conversion_type: 'signup' })
          }).catch(() => {});
        }

        // Delete used OTP
        fetch(`${SUPA_URL}/rest/v1/api_cache?cache_key=eq.otp_${encodeURIComponent(email)}`, { method: 'DELETE', headers: supaH }).catch(() => {});

        console.log('[auth] Account created + logged in:', email);
        return res.status(200).json({ user: signupD.user || session?.user, session });

      } catch(e) {
        console.error('[auth] OTP verify error:', e.message);
        return res.status(400).json({ error: 'Erro ao verificar código. Tente novamente.' });
      }
    }

    // ── UPDATE PASSWORD (using recovery token) ────────────────────────────────
    if (action === 'update_password') {
      if (!token || !password) return res.status(400).json({ error: 'Token e senha são obrigatórios' });
      if (password.length < 6) return res.status(400).json({ error: 'Senha mínima de 6 caracteres' });

      const r = await fetch(`${authBase}/user`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ password })
      });
      const data = await r.json();
      if (!r.ok) {
        const msg = data.msg || data.error_description || data.error || 'Erro ao atualizar senha';
        return res.status(400).json({ error: msg });
      }
      return res.status(200).json({ success: true });
    }

    // ── RESET PASSWORD (sends email link) ─────────────────────────────────────
    if (action === 'reset_password') {
      if (!email) return res.status(400).json({ error: 'Email é obrigatório' });
      const redirectTo = `${process.env.SITE_URL || 'https://bluetubeviral.com'}/`;
      const r = await fetch(`${authBase}/recover`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, gotrue_meta_security: {}, options: { redirectTo } })
      });
      // Always return success to avoid email enumeration
      return res.status(200).json({ sent: true });
    }

    // ── GOOGLE OAUTH ──────────────────────────────────────────────────────────
    if (action === 'google') {
      const redirectTo = `${process.env.SITE_URL || 'https://bluetubeviral.com'}/`;
      const url = `${authBase}/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
      return res.status(200).json({ url });
    }

    // ── VERIFY TOKEN ──────────────────────────────────────────────────────────
    if (action === 'verify' && token) {
      const r = await fetch(`${authBase}/user`, {
        headers: { ...headers, 'Authorization': `Bearer ${token}` }
      });
      const data = await r.json();
      if (!r.ok) return res.status(401).json({ error: 'Token inválido' });
      return res.status(200).json({ user: data });
    }


  // ══════════════════════════════════════════════════════════════════════════
  // ── AFFILIATE SYSTEM ──────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  // Usa as vars globais SUPA_URL, SUPA_KEY, ANON_KEY, supaH declaradas no topo
  const COMMISSION_RATES = { bronze: 0.35, silver: 0.40, gold: 0.58 };
  const PLAN_AMOUNTS = { full: 29.99, master: 89.99 };
  const getAffLevel = (p) => p >= 1000 ? 'gold' : p >= 380 ? 'silver' : 'bronze';
  const genRefCode = (email) => {
    const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,8);
    const suffix = crypto.randomBytes(3).toString('hex');
    return base + suffix;
  };

  // ── TRACK CLICK ────────────────────────────────────────────────────────────
  // GET /api/affiliate?action=click&ref=CODE&cookie_id=X
  if (req.method === 'GET' && _action === 'click') {
    const { ref, cookie_id, referrer } = req.query;
    if (!ref) return res.status(400).json({ error: 'ref obrigatório' });

    try {
      // Busca afiliado pelo ref_code
      const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?ref_code=eq.${ref}&select=id,status`, { headers: supaH });
      const affiliates = await ar.json();
      const affiliate = affiliates?.[0];
      if (!affiliate || affiliate.status === 'suspended') {
        return res.status(404).json({ error: 'Link inválido' });
      }

      // Hash do IP para antifraude (sem guardar IP real)
      const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '';
      const ipHash = crypto.createHash('sha256').update(ip + process.env.ADMIN_SECRET).digest('hex').slice(0, 16);

      // Fingerprint do visitor
      const ua = req.headers['user-agent'] || '';
      const lang = req.headers['accept-language'] || '';
      const fingerprint = crypto.createHash('sha256').update(ua + lang).digest('hex').slice(0, 16);

      // Registra clique
      await fetch(`${SUPA_URL}/rest/v1/affiliate_clicks`, {
        method: 'POST',
        headers: { ...supaH, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          affiliate_id: affiliate.id,
          ref_code: ref,
          cookie_id: cookie_id || null,
          ip_hash: ipHash,
          visitor_fingerprint: fingerprint,
          referrer: referrer?.slice(0, 200) || null
        })
      });

      // Incrementa total_clicks
      await fetch(`${SUPA_URL}/rest/v1/affiliates?ref_code=eq.${ref}`, {
        method: 'PATCH',
        headers: { ...supaH, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ total_clicks: (affiliate.total_clicks || 0) + 1, updated_at: new Date().toISOString() })
      }).catch(() => {});

      return res.status(200).json({ ok: true, affiliate_id: affiliate.id });
    } catch(e) {
      console.error('Affiliate click error:', e.message);
      return res.status(200).json({ ok: false });
    }
  }

  // ── REGISTER AFFILIATE ─────────────────────────────────────────────────────
  // POST { action: 'register', token, name }
  if (req.method === 'POST' && _action === 'register') {
    const { token, name } = req.body || {};
    console.log('Register affiliate called, token present:', !!token, 'SUPA_URL:', !!SUPA_URL);
    if (!token) return res.status(401).json({ error: 'Token obrigatório' });

    try {
      // Valida token e pega email
      const ur = await fetch(`${SUPA_URL}/auth/v1/user`, {
        headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
      });
      if (!ur.ok) return res.status(401).json({ error: 'Token inválido' });
      const user = await ur.json();
      const email = user.email;
      if (!email) return res.status(400).json({ error: 'Email não encontrado' });

      // Verifica se já é afiliado
      const existing = await fetch(`${SUPA_URL}/rest/v1/affiliates?email=eq.${encodeURIComponent(email)}&select=id,ref_code,status,level`, { headers: supaH });
      const existingData = await existing.json();
      if (existingData?.[0]) {
        return res.status(200).json({ affiliate: existingData[0], alreadyExists: true });
      }

      // Cria afiliado
      const refCode = genRefCode(email);
      const r = await fetch(`${SUPA_URL}/rest/v1/affiliates`, {
        method: 'POST',
        headers: { ...supaH, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          email,
          name: name || email.split('@')[0],
          ref_code: refCode,
          status: 'pending', // aguarda aprovação manual do admin
          level: 'bronze',
          terms_accepted_at: new Date().toISOString()
        })
      });
      const data = await r.json();
      if (!r.ok) {
        console.error('Supabase insert error:', JSON.stringify(data).slice(0,300));
        return res.status(500).json({ error: 'Erro ao salvar afiliado: ' + (data.message || data.details || JSON.stringify(data)) });
      }
      if (!data[0]) {
        console.error('Supabase insert returned empty:', JSON.stringify(data));
        return res.status(500).json({ error: 'Afiliado criado mas sem retorno do banco' });
      }
      return res.status(201).json({ affiliate: data[0] });
    } catch(e) {
      console.error('Register affiliate error:', e.message, e.stack?.slice(0,300));
      return res.status(500).json({ error: 'Erro ao criar afiliado: ' + e.message });
    }
  }

  // ── GET DASHBOARD DATA ─────────────────────────────────────────────────────
  // GET ?action=dashboard&token=X
  if (req.method === 'GET' && _action === 'dashboard') {
    const { token } = req.query;
    if (!token) return res.status(401).json({ error: 'Token obrigatório' });

    try {
      const ur = await fetch(`${SUPA_URL}/auth/v1/user`, {
        headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${token}` }
      });
      if (!ur.ok) return res.status(401).json({ error: 'Token inválido' });
      const user = await ur.json();

      const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?email=eq.${encodeURIComponent(user.email)}&select=*`, { headers: supaH });
      const affiliates = await ar.json();
      const affiliate = affiliates?.[0];
      if (!affiliate) return res.status(404).json({ error: 'not_affiliate' });
      if (affiliate.status === 'pending') return res.status(403).json({ error: 'pending_approval' });
      if (affiliate.status === 'suspended') return res.status(403).json({ error: 'suspended' });

      // Busca conversões
      const cr = await fetch(`${SUPA_URL}/rest/v1/affiliate_conversions?affiliate_id=eq.${affiliate.id}&select=*&order=converted_at.desc&limit=50`, { headers: supaH });
      const conversions = await cr.json() || [];

      // Busca comissões
      const cmr = await fetch(`${SUPA_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${affiliate.id}&select=*&order=created_at.desc&limit=100`, { headers: supaH });
      const commissions = await cmr.json() || [];

      // Busca clicks dos últimos 30 dias
      const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString();
      const clkr = await fetch(`${SUPA_URL}/rest/v1/affiliate_clicks?affiliate_id=eq.${affiliate.id}&landed_at=gte.${thirtyDaysAgo}&select=landed_at`, { headers: supaH });
      const clicks = await clkr.json() || [];

      // Histórico de comissões por mês (últimos 12 meses)
      const twelveMonthsAgo = new Date(Date.now() - 365*24*60*60*1000).toISOString();
      const histR = await fetch(`${SUPA_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${affiliate.id}&created_at=gte.${twelveMonthsAgo}&select=commission_amount,status,created_at,plan,subscriber_email&order=created_at.desc`, { headers: supaH });
      const allCommissions = await histR.json() || [];

      // Agrupa por mês
      const monthlyMap = {};
      allCommissions.forEach(c => {
        const month = c.created_at?.slice(0,7); // "2025-03"
        if (!monthlyMap[month]) monthlyMap[month] = { month, total: 0, paid: 0, pending: 0, count: 0 };
        const amt = parseFloat(c.commission_amount || 0);
        monthlyMap[month].total += amt;
        monthlyMap[month].count++;
        if (c.status === 'paid') monthlyMap[month].paid += amt;
        else if (c.status === 'pending') monthlyMap[month].pending += amt;
      });
      const monthlyHistory = Object.values(monthlyMap).sort((a,b) => b.month.localeCompare(a.month));

      // Ganhos de hoje
      const todayStr = new Date().toISOString().split('T')[0];
      const todayEarnings = allCommissions
        .filter(c => c.created_at?.startsWith(todayStr))
        .reduce((s,c) => s + parseFloat(c.commission_amount||0), 0);

      // Calcula stats
      const totalPaying = (affiliate.total_full || 0) + (affiliate.total_master || 0);
      const level = getAffLevel(totalPaying);
      const rate = COMMISSION_RATES[level];

      const pendingCommissions = commissions.filter(c => c.status === 'pending');
      const paidCommissions = commissions.filter(c => c.status === 'paid');
      const pendingAmount = pendingCommissions.reduce((s, c) => s + parseFloat(c.commission_amount || 0), 0);
      const paidAmount = paidCommissions.reduce((s, c) => s + parseFloat(c.commission_amount || 0), 0);
      const mrrAffiliate = (affiliate.total_full || 0) * PLAN_AMOUNTS.full * rate +
                           (affiliate.total_master || 0) * PLAN_AMOUNTS.master * rate;

      // Próximo nível
      const nextLevelInfo = level === 'bronze'
        ? { next: 'silver', nextRate: 0.40, needed: 380 - totalPaying, total: 380 }
        : level === 'silver'
        ? { next: 'gold', nextRate: 0.58, needed: 1000 - totalPaying, total: 1000 }
        : { next: null, needed: 0, total: 1000 };

      // Clicks por dia (últimos 7 dias)
      const clicksByDay = {};
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i*24*60*60*1000).toISOString().split('T')[0];
        clicksByDay[d] = 0;
      }
      clicks.forEach(c => {
        const d = c.landed_at?.split('T')[0];
        if (d && clicksByDay[d] !== undefined) clicksByDay[d]++;
      });

      // Atualiza nível se mudou
      if (affiliate.level !== level) {
        fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliate.id}`, {
          method: 'PATCH',
          headers: supaH,
          body: JSON.stringify({ level, updated_at: new Date().toISOString() })
        });
      }

      return res.status(200).json({
        affiliate: { ...affiliate, level },
        stats: {
          totalClicks: affiliate.total_clicks || 0,
          clicksLast30: clicks.length,
          totalFree: affiliate.total_free || 0,
          totalFull: affiliate.total_full || 0,
          totalMaster: affiliate.total_master || 0,
          totalPaying,
          mrrAffiliate: parseFloat(mrrAffiliate.toFixed(2)),
          pendingAmount: parseFloat(pendingAmount.toFixed(2)),
          paidAmount: parseFloat(paidAmount.toFixed(2)),
          totalEarnings: parseFloat((pendingAmount + paidAmount).toFixed(2)),
          commissionRate: rate,
          level,
          nextLevel: nextLevelInfo,
          clicksByDay: Object.entries(clicksByDay).map(([date, count]) => ({ date, count })),
        },
        conversions: conversions.slice(0, 20),
        recentCommissions: commissions.slice(0, 10),
        monthlyHistory,
        todayEarnings: parseFloat(todayEarnings.toFixed(2)),
        allCommissions: allCommissions.slice(0, 50),
      });
    } catch(e) {
      console.error('Dashboard error:', e.message, e.stack?.slice(0,300));
      return res.status(500).json({ error: 'Erro ao carregar dashboard: ' + e.message });
    }
  }

  // ── RECORD CONVERSION ──────────────────────────────────────────────────────
  // POST { action: 'conversion', email, plan, cookie_id, stripe_customer_id }
  // Chamado internamente pelo auth.js no signup/pagamento
  if (req.method === 'POST' && _action === 'conversion') {
    const { email, plan, cookie_id, stripe_customer_id, conversion_type } = req.body;
    if (!email) return res.status(400).json({ error: 'email obrigatório' });

    try {
      // Busca subscriber para pegar affiliate_ref
      const sr = await fetch(`${SUPA_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=affiliate_ref`, { headers: supaH });
      const subs = await sr.json();
      const refCode = subs?.[0]?.affiliate_ref;
      if (!refCode) return res.status(200).json({ ok: true, skipped: 'no_ref' });

      // Busca afiliado
      const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?ref_code=eq.${refCode}&select=*`, { headers: supaH });
      const affiliates = await ar.json();
      const affiliate = affiliates?.[0];
      if (!affiliate) return res.status(200).json({ ok: true, skipped: 'affiliate_not_found' });

      // Antifraude: afiliado não pode ser o próprio referido
      if (affiliate.email === email) return res.status(200).json({ ok: true, skipped: 'self_referral' });

      // Verifica se já existe conversão para este email
      const existingConv = await fetch(`${SUPA_URL}/rest/v1/affiliate_conversions?converted_email=eq.${encodeURIComponent(email)}&affiliate_id=eq.${affiliate.id}`, { headers: supaH });
      const existing = await existingConv.json();

      const type = conversion_type || (plan === 'free' ? 'signup' : `upgrade_${plan}`);

      if (!existing?.length || type !== 'signup') {
        // Registra conversão
        const convR = await fetch(`${SUPA_URL}/rest/v1/affiliate_conversions`, {
          method: 'POST',
          headers: { ...supaH, 'Prefer': 'return=representation' },
          body: JSON.stringify({
            affiliate_id: affiliate.id,
            ref_code: refCode,
            converted_email: email,
            cookie_id: cookie_id || null,
            conversion_type: type,
            plan: plan || 'free',
            stripe_customer_id: stripe_customer_id || null
          })
        });
        const conv = await convR.json();

        // Se plano pago, cria comissão
        if (plan === 'full' || plan === 'master') {
          const totalPaying = (affiliate.total_full || 0) + (affiliate.total_master || 0) + 1;
          const level = getAffLevel(totalPaying);
          const rate = COMMISSION_RATES[level];
          const planAmount = PLAN_AMOUNTS[plan];
          const commissionAmount = planAmount * rate;

          await fetch(`${SUPA_URL}/rest/v1/affiliate_commissions`, {
            method: 'POST',
            headers: { ...supaH, 'Prefer': 'return=minimal' },
            body: JSON.stringify({
              affiliate_id: affiliate.id,
              conversion_id: conv?.[0]?.id || null,
              subscriber_email: email,
              plan,
              plan_amount: planAmount,
              commission_rate: rate,
              commission_amount: commissionAmount,
              status: 'pending',
              period_start: new Date().toISOString(),
              period_end: new Date(Date.now() + 37*24*60*60*1000).toISOString()
            })
          });

          // Atualiza stats do afiliado
          const field = plan === 'full' ? 'total_full' : 'total_master';
          await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliate.id}`, {
            method: 'PATCH',
            headers: supaH,
            body: JSON.stringify({
              [field]: (affiliate[field] || 0) + 1,
              total_earnings: parseFloat((affiliate.total_earnings || 0) + commissionAmount).toFixed(2),
              level: getAffLevel(totalPaying),
              updated_at: new Date().toISOString()
            })
          });

          console.log(`💰 Commission: ${affiliate.email} ← ${email} (${plan}) = $${commissionAmount.toFixed(2)}`);
        } else if (plan === 'free') {
          // Incrementa total_free
          await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliate.id}`, {
            method: 'PATCH',
            headers: supaH,
            body: JSON.stringify({
              total_free: (affiliate.total_free || 0) + 1,
              updated_at: new Date().toISOString()
            })
          });
        }
      }

      return res.status(200).json({ ok: true });
    } catch(e) {
      console.error('Conversion error:', e.message);
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  // ── PROCESS RENEWAL COMMISSION ─────────────────────────────────────────────
  // POST { action: 'renewal', email, plan } — chamado pelo webhook.js
  if (req.method === 'POST' && _action === 'renewal') {
    const { email, plan } = req.body;
    if (!email || !plan) return res.status(400).json({ error: 'email e plan obrigatórios' });

    try {
      // Busca conversão do afiliado para este email
      const cr = await fetch(`${SUPA_URL}/rest/v1/affiliate_conversions?converted_email=eq.${encodeURIComponent(email)}&select=affiliate_id`, { headers: supaH });
      const convs = await cr.json();
      if (!convs?.length) return res.status(200).json({ ok: true, skipped: 'no_conversion' });

      const affiliateId = convs[0].affiliate_id;
      const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliateId}&select=*`, { headers: supaH });
      const affiliates = await ar.json();
      const affiliate = affiliates?.[0];
      if (!affiliate) return res.status(200).json({ ok: true, skipped: 'no_affiliate' });

      const totalPaying = (affiliate.total_full || 0) + (affiliate.total_master || 0);
      const level = getAffLevel(totalPaying);
      const rate = COMMISSION_RATES[level];
      const planAmount = PLAN_AMOUNTS[plan] || 0;
      const commissionAmount = planAmount * rate;

      await fetch(`${SUPA_URL}/rest/v1/affiliate_commissions`, {
        method: 'POST',
        headers: { ...supaH, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          affiliate_id: affiliateId,
          subscriber_email: email,
          plan,
          plan_amount: planAmount,
          commission_rate: rate,
          commission_amount: commissionAmount,
          status: 'pending',
          period_start: new Date().toISOString(),
          period_end: new Date(Date.now() + 37*24*60*60*1000).toISOString()
        })
      });

      // Atualiza total_earnings
      await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliateId}`, {
        method: 'PATCH',
        headers: supaH,
        body: JSON.stringify({
          total_earnings: parseFloat((affiliate.total_earnings || 0) + commissionAmount).toFixed(2),
          updated_at: new Date().toISOString()
        })
      });

      console.log(`🔄 Renewal commission: ${affiliate.email} ← ${email} (${plan}) = $${commissionAmount.toFixed(2)}`);
      return res.status(200).json({ ok: true, commission: commissionAmount });
    } catch(e) {
      console.error('Renewal commission error:', e.message);
      return res.status(200).json({ ok: false });
    }
  }

  // ── CANCEL COMMISSION ──────────────────────────────────────────────────────
  // ╔════════════════════════════════════════════════════════════════════════╗
  // ║ ⚠️  DEAD CODE ZONE — NAO MODIFICAR  ⚠️                                  ║
  // ║ Esta action=cancel NAO e mais chamada desde 2026-04-23.                 ║
  // ║ O codigo VIVO esta em api/affiliate.js:518+ (action=cancel).            ║
  // ║ webhook.js agora chama /api/affiliate diretamente.                      ║
  // ║ Mantido aqui apenas pra nao violar a regra de nao-mexer-em-auth.js.     ║
  // ║ Qualquer mudanca no fluxo de cancelamento vai em affiliate.js, NAO AQUI.║
  // ╚════════════════════════════════════════════════════════════════════════╝
  // POST { action: 'cancel', email } — chamado pelo webhook.js no cancelamento
  if (req.method === 'POST' && _action === 'cancel') {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email obrigatório' });

    try {
      // Busca conversão
      const cr = await fetch(`${SUPA_URL}/rest/v1/affiliate_conversions?converted_email=eq.${encodeURIComponent(email)}&select=affiliate_id,plan`, { headers: supaH });
      const convs = await cr.json();
      if (!convs?.length) return res.status(200).json({ ok: true, skipped: 'no_conversion' });

      const { affiliate_id, plan } = convs[0];

      // Cancela comissões pendentes futuras
      await fetch(`${SUPA_URL}/rest/v1/affiliate_commissions?affiliate_id=eq.${affiliate_id}&subscriber_email=eq.${encodeURIComponent(email)}&status=eq.pending`, {
        method: 'PATCH',
        headers: supaH,
        body: JSON.stringify({ status: 'cancelled' })
      });

      // Decrementa contador do afiliado
      const ar = await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliate_id}&select=*`, { headers: supaH });
      const affiliates = await ar.json();
      const affiliate = affiliates?.[0];
      if (affiliate) {
        const field = plan === 'full' ? 'total_full' : 'total_master';
        const newCount = Math.max(0, (affiliate[field] || 0) - 1);
        const totalPaying = Math.max(0, (affiliate.total_full||0) + (affiliate.total_master||0) - 1);
        await fetch(`${SUPA_URL}/rest/v1/affiliates?id=eq.${affiliate_id}`, {
          method: 'PATCH',
          headers: supaH,
          body: JSON.stringify({
            [field]: newCount,
            level: getAffLevel(totalPaying),
            updated_at: new Date().toISOString()
          })
        });
      }

      console.log(`❌ Commission cancelled for: ${email}`);
      return res.status(200).json({ ok: true });
    } catch(e) {
      console.error('Cancel commission error:', e.message);
      return res.status(200).json({ ok: false });
    }
  }



  // ══════════════════════════════════════════════════════════════════════════
  // ── BLUELENS: BUSCA DE ORIGEM DE VÍDEO ───────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════

  // GET ?action=bluelens-analyze&url=...&token=...
  if (req.method === 'GET' && req.query?.action === 'bluelens-analyze') {
    const { url: videoUrl, token: userToken, offset = '0', exclude = '[]' } = req.query;
    let excludeIds = [];
    try { excludeIds = JSON.parse(decodeURIComponent(exclude)); } catch(e) {}
    if (!videoUrl) return res.status(400).json({ error: 'URL obrigatória' });

    // Valida token
    let userEmail = null;
    if (userToken) {
      try {
        const ur = await fetch(`${SUPA_URL}/auth/v1/user`, {
          headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${userToken}` }
        });
        if (ur.ok) { const u = await ur.json(); userEmail = u.email; }
      } catch(e) {}
    }

    try {
      const decodedUrl = decodeURIComponent(videoUrl);

      // 1. Detecta plataforma e extrai metadados básicos
      const platform = decodedUrl.includes('tiktok.com') ? 'tiktok'
        : decodedUrl.includes('instagram.com') ? 'instagram'
        : decodedUrl.includes('youtube.com') || decodedUrl.includes('youtu.be') ? 'youtube'
        : 'unknown';

      // 2. Extrai ID do vídeo e metadados via YouTube API (para YT) ou metadados OG
      let videoMeta = { title: '', thumbnail: '', duration: 0, channel: '' };
      let ytVideoId = null;

      if (platform === 'youtube') {
        const m = decodedUrl.match(/(?:v=|shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        ytVideoId = m?.[1];
        if (ytVideoId) {
          const YT_KEY = process.env.YOUTUBE_API_KEY;
          const vr = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${ytVideoId}&key=${YT_KEY}`);
          const vd = await vr.json();
          const v = vd.items?.[0];
          if (v) {
            const dur = v.contentDetails?.duration || '';
            const dm = dur.match(/PT(?:([0-9]+)M)?(?:([0-9]+)S)?/);
            videoMeta = {
              title: v.snippet?.title || '',
              thumbnail: v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.medium?.url || '',
              duration: (parseInt(dm?.[1]||0)*60)+parseInt(dm?.[2]||0),
              channel: v.snippet?.channelTitle || '',
              views: parseInt(v.statistics?.viewCount || 0),
              publishedAt: v.snippet?.publishedAt
            };
          }
        }
      }

      // 3. Busca base interna (vídeos já analisados com hash similar)
      let internalMatches = [];
      if (SUPA_URL && SUPA_KEY) {
        try {
          // Busca por URL exata primeiro
          const dbR = await fetch(`${SUPA_URL}/rest/v1/bluelens_video_db?url=eq.${encodeURIComponent(decodedUrl)}&select=*`, { headers: supaH });
          const dbData = await dbR.json();
          if (dbData?.[0]) {
            dbData[0].times_matched = (dbData[0].times_matched || 0) + 1;
            fetch(`${SUPA_URL}/rest/v1/bluelens_video_db?url=eq.${encodeURIComponent(decodedUrl)}`, {
              method: 'PATCH', headers: supaH,
              body: JSON.stringify({ times_matched: dbData[0].times_matched, last_seen: new Date().toISOString() })
            }).catch(()=>{});
            internalMatches = dbData;
          }
        } catch(e) {}
      }

      // 4. Busca YouTube por título similar (find origin)
      // Detectores de repost — declarados globalmente para uso no prompt da IA
      // Padrões visuais de criador dark (legenda colorida no título = emoji quadrado colorido)
      const hasColorCaption = (t) => /\u{1F7E5}|\u{1F7E7}|\u{1F7E8}|\u{1F7E9}|\u{1F7E6}|\u{1F7EA}|\u{1F7EB}/u.test(t);
      // Padrões típicos de criador dark: narração + legenda + música + seta/círculo
      // Identificamos pelo título: múltiplos @, créditos, compilações, repost explícito
      const DARK_CREATOR_KEYWORDS = /compilation|compilacao|parte \d|part \d|\bcreds?\b|credit|credito|via @|found on|repost|re-?post|duet|collab|for you|\bfy[pb]\b/i;
      const AGGREGATOR_PATTERN = /@\w{3,}.*@\w{3,}|\(via @|\| @|cr[eé]ditos?/i;
      // INCLUI como válido: canais dark sem sinal óbvio (a maioria não coloca crédito)
      const hasRepostSignal = (t) => hasColorCaption(t) || DARK_CREATOR_KEYWORDS.test(t) || AGGREGATOR_PATTERN.test(t);
      // Sinal mais fraco — só penaliza, não exclui
      const hasSoftRepostSignal = (t) => /@\w+/.test(t) && t.split('@').length > 2;
      const inputHasRepost = videoMeta.title ? hasRepostSignal(videoMeta.title) : false;

      let searchResults = [];
      if (videoMeta.title && process.env.YOUTUBE_API_KEY) {


        // Limpa título para busca
        const cleanTitle = videoMeta.title
          .replace(/#\w+/g, '').replace(/\|.*$/, '').replace(/@\w+/g, '')
          .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

        // Queries especializadas para encontrar o original
        const tiktokQuery = cleanTitle.slice(0, 50) + ' tiktok';     // TikTok é origem mais comum
        const ytShortsQuery = cleanTitle.slice(0, 50) + ' shorts';   // busca Shorts específico
        const originalQuery = cleanTitle.slice(0, 50) + ' original'; // busca versão original

        const YT1 = process.env.YOUTUBE_API_KEY;
        const YT2 = process.env.YOUTUBE_API_KEY_2 || YT1;
        const YT3 = process.env.YOUTUBE_API_KEY_3 || YT1;
        const YT4 = process.env.YOUTUBE_API_KEY_4 || YT1;
        const YT5 = process.env.YOUTUBE_API_KEY_5 || YT1;

        // 5 buscas paralelas com queries diferentes para maximizar cobertura
        const [byViews, byDate, byTiktok, byOriginal, byDescription] = await Promise.all([
          // Por views — encontra versões populares
          fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(cleanTitle)}&maxResults=10&order=viewCount&videoDuration=short&key=${YT1}`).then(r=>r.json()).catch(()=>({items:[]})),
          // Mais antigos — original veio primeiro
          fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(cleanTitle)}&maxResults=8&order=date&videoDuration=short&key=${YT2}`).then(r=>r.json()).catch(()=>({items:[]})),
          // TikTok reposts no YouTube — origem mais comum de conteúdo viral
          fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(tiktokQuery)}&maxResults=8&order=viewCount&videoDuration=short&key=${YT3}`).then(r=>r.json()).catch(()=>({items:[]})),
          // Busca "original" explícita
          fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(originalQuery)}&maxResults=6&order=viewCount&videoDuration=short&key=${YT4}`).then(r=>r.json()).catch(()=>({items:[]})),
          // Sem filtro de duração — original pode ser vídeo longo cortado para Short
          fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(cleanTitle)}&maxResults=6&order=date&key=${YT5}`).then(r=>r.json()).catch(()=>({items:[]})),
        ]);

        const excludeSet = new Set(excludeIds);
        const seen = new Set();
        const unique = [
          ...(byViews.items||[]),
          ...(byDate.items||[]),
          ...(byTiktok.items||[]),
          ...(byOriginal.items||[]),
          ...(byDescription.items||[])
        ].filter(i => {
          const id = i.id?.videoId;
          if (!id || seen.has(id) || id === ytVideoId || excludeSet.has(id)) return false;
          seen.add(id); return true;
        });

        if (unique.length > 0) {
          const ids = unique.map(i=>i.id.videoId).join(',');
          const sd = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet,contentDetails&id=${ids}&key=${YT1}`).then(r=>r.json()).catch(()=>({items:[]}));

          const STOP = new Set(['the','and','for','that','this','with','from','have','mais','para','que','uma','nao','com','por','sao','dos','das']);
          const inputWords = new Set(videoMeta.title.toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/).filter(w=>w.length>2&&!STOP.has(w)));

          searchResults = (sd.items||[]).map(v => {
            const stats=v.statistics||{}, snip=v.snippet||{};
            const dur=v.contentDetails?.duration||'';
            const dm=dur.match(/PT(?:([0-9]+)M)?(?:([0-9]+)S)?/);
            const secs=(parseInt(dm?.[1]||0)*60)+parseInt(dm?.[2]||0);
            const views=parseInt(stats.viewCount||0);
            const rTitle=snip.title||'';

            const isColorCaption = hasColorCaption(rTitle);
            const isRepost = hasRepostSignal(rTitle);

            // ── FILTRO PRIMÁRIO: DURAÇÃO ────────────────────────────────────
            // Vídeos com duração muito diferente são irrelevantes — descarte imediato
            // Tolerância: ±40% da duração do vídeo analisado
            const durDiff = videoMeta.duration > 0 && secs > 0
              ? Math.abs(videoMeta.duration - secs) / Math.max(videoMeta.duration, secs)
              : 1;
            const durTooFar = durDiff > 0.40; // mais de 40% diferente = provavelmente outro vídeo

            // ── SIMILARIDADE ────────────────────────────────────────────────
            const rWords = new Set(rTitle.toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/).filter(w=>w.length>2&&!STOP.has(w)));
            const inter = [...inputWords].filter(w=>rWords.has(w)).length;
            const union = new Set([...inputWords,...rWords]).size;
            const titleSim = union > 0 ? inter/union : 0;

            // Duração — filtro mais estrito: ±20% = similar, ±40% = possível, >40% = descarte
            const durSim = 1 - durDiff;

            // Score combinado — duração tem peso 60% (mais confiável que título traduzido)
            let similarity = Math.round((titleSim * 0.40 + durSim * 0.60) * 100);
            if (isColorCaption) similarity = 0;
            similarity = Math.max(0, Math.min(100, similarity));

            const publishedBefore = videoMeta.publishedAt
              ? new Date(snip.publishedAt) < new Date(videoMeta.publishedAt) : false;
            const durVeryClose = durDiff < 0.15;
            const isLikelyOriginal = !isColorCaption && publishedBefore && durVeryClose;

            return {id:v.id, url:`https://www.youtube.com/shorts/${v.id}`, title:rTitle,
              channel:snip.channelTitle||'', thumbnail:snip.thumbnails?.high?.url||snip.thumbnails?.medium?.url||'',
              views, viewsFormatted:fmtViews(views), duration:secs, publishedAt:snip.publishedAt,
              platform:'youtube', similarity, isLikelyOriginal, isColorCaption, isRepost,
              publishedBefore, durDiff, durTooFar: durDiff > 0.40};
          })
          .filter(v => !v.isColorCaption && !v.durTooFar) // descarta legenda colorida E duração muito diferente
          .sort((a,b) => {
            // Prioridade: publicado antes + sem repost + duração similar + data antiga absoluta
            const pb = (v) => v.publishedBefore ? 50 : 0;
            const noRepost = (v) => !v.isRepost ? 20 : 0;
            const durScore = (v) => v.similarity; // duração similar = mesmo vídeo
            // Mais antigo = maior chance de ser original (timestamp absoluto)
            const ageScore = (v) => v.publishedAt
              ? Math.min(20, (Date.now() - new Date(v.publishedAt).getTime()) / (1000*60*60*24*30)) // dias desde publicação / 30
              : 0;
            const sc = (v) => pb(v) + noRepost(v) + durScore(v)*0.4 + ageScore(v);
            return sc(b) - sc(a);
          });
        }
        if(inputHasRepost) console.log('BlueLens: video analisado tem legenda colorida (repost)');
      }
      // 5. Análise visual do thumbnail para detectar setas, círculos e legendas coloridas
      let thumbnailFlags = [];
      if (videoMeta.thumbnail) {
        try {
          const GEMINI_VISION_KEY = process.env.GEMINI_KEY_1;
          if (GEMINI_VISION_KEY) {
            // Faz fetch do thumbnail e converte para base64
            const thumbRes = await fetch(videoMeta.thumbnail);
            if (thumbRes.ok) {
              const thumbBuf = await thumbRes.arrayBuffer();
              const thumbB64 = Buffer.from(thumbBuf).toString('base64');
              const visionPrompt = 'Analise esta thumbnail de vídeo. Responda APENAS com JSON: {"hasColoredCaption":bool,"hasRedArrows":bool,"hasRedCircles":bool,"hasZoomEffect":bool,"hasWatermark":bool,"isLikelyEdited":bool,"reason":"1 frase"}. hasColoredCaption=true se tiver legenda com cor de fundo viva (amarelo/verde/vermelho/azul). hasRedArrows=true se tiver setas vermelhas ou de destaque. hasRedCircles=true se tiver círculos ou marcações de destaque.';
              const visionRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_VISION_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [
                    { inline_data: { mime_type: 'image/jpeg', data: thumbB64 } },
                    { text: visionPrompt }
                  ]}],
                  generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
                })
              });
              const vd = await visionRes.json();
              let vtext = vd.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim()||'';
              vtext = vtext.split('```json').join('').split('```').join('').trim();
              const vs = vtext.indexOf('{'); const ve = vtext.lastIndexOf('}');
              if (vs>=0 && ve>=0) {
                const vdata = JSON.parse(vtext.slice(vs,ve+1));
                if (vdata.hasColoredCaption) thumbnailFlags.push('legenda colorida detectada na thumbnail');
                if (vdata.hasRedArrows) thumbnailFlags.push('setas de destaque na thumbnail');
                if (vdata.hasRedCircles) thumbnailFlags.push('círculos/marcações de destaque na thumbnail');
                if (vdata.hasZoomEffect) thumbnailFlags.push('efeito de zoom na thumbnail');
                if (vdata.hasWatermark) thumbnailFlags.push('marca dagua detectada');
                if (vdata.isLikelyEdited) thumbnailFlags.push('thumbnail parece editada: ' + (vdata.reason||''));
                console.log('BlueLens thumbnail analysis:', vdata);
              }
            }
          }
        } catch(e) { console.log('Thumbnail vision error:', e.message); }
      }

      // 6. IA analisa padrões e emite veredicto
      let aiAnalysis = { verdict: 'unknown', confidence: 0, reasoning: '', patterns: [] };
      const GEMINI_KEYS = [
        process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3
      ].filter(Boolean);

      if (GEMINI_KEYS.length && videoMeta.title) {
        const topResult = searchResults[0];
        const prompt = `Você é um especialista em canais dark do YouTube — canais que pegam conteúdo viral (geralmente do TikTok) e repostam com edição: legenda colorida centralizada, seta vermelha ou círculo de destaque, narração por IA, música de fundo. Seu objetivo é analisar se o vídeo é um repost dark e quantos concorrentes já publicaram o mesmo conteúdo.

VÍDEO ANALISADO:
- Título: "${videoMeta.title}"
- Canal: "${videoMeta.channel}"
- Duração: ${videoMeta.duration}s
- Views: ${(videoMeta.views||0).toLocaleString()}
- Publicado: ${videoMeta.publishedAt || 'desconhecido'}
- Plataforma: ${platform}
- Sinais de repost no título: ${inputHasRepost ? 'SIM (legenda colorida ou compilation detectada)' : 'não detectado'}
- Sinais visuais na thumbnail: ${thumbnailFlags.length > 0 ? thumbnailFlags.join(', ') : 'nenhum detectado'}

REGRAS CRÍTICAS:
1. Legenda colorida (emojis 🟥🟧🟨🟩🟦🟪) no título = DEFINITIVAMENTE repost editado. Veredicto: "edited_repost".
2. O vídeo ORIGINAL quase sempre tem MENOS views que o repost — o repost viraliza mais por ter edição (zoom, legenda, música).
3. O indicador mais forte de original é: publicado ANTES + sem emojis coloridos + título simples sem múltiplos @.
4. Se nenhum resultado foi encontrado no YouTube, o original provavelmente está no TikTok ou Instagram.

${topResult ? `RESULTADO MAIS PROVÁVEL DE ORIGEM:
- Título: "${topResult.title}"
- Canal: "${topResult.channel}"
- Views: ${(topResult.views||0).toLocaleString()}
- Publicado: ${topResult.publishedAt}
- Duração: ${topResult.duration}s (vídeo analisado: ${videoMeta.duration}s)
- Publicado ANTES do analisado: ${topResult.isLikelyOriginal}
- Similaridade calculada: ${topResult.similarity}%` : 'Nenhum resultado encontrado — original pode ser do TikTok/Instagram.'}

TOTAL DE CANDIDATOS ENCONTRADOS NO YOUTUBE: ${searchResults.length}

Analise e responda APENAS em JSON válido sem markdown:
{
  "verdict": "original|repost|edited_repost|unknown",
  "confidence": 0.0-1.0,
  "reasoning": "explicação em 2-3 frases sobre por que este vídeo é ou não original",
  "patterns": ["padrão1 detectado no título/metadata", "padrão2"],
  "originChannel": "nome do canal que provavelmente criou o original ou null",
  "recommendation": "o que o usuário deve fazer com essa informação"
}`;

        for (const key of GEMINI_KEYS) {
          try {
            const gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 600 } })
            });
            const gd = await gr.json();
            if (gd.error?.code === 429) continue;
            let text = gd.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim()||'';
            text = text.split('```json').join('').split('```').join('').trim();
            const s = text.indexOf('{'); const e = text.lastIndexOf('}');
            if (s >= 0 && e >= 0) {
              aiAnalysis = JSON.parse(text.slice(s, e+1));
              break;
            }
          } catch(e) { continue; }
        }
      }

      // 6. Salva análise no Supabase para retroalimentação
      const analysisId = crypto.randomBytes(8).toString('hex');
      if (SUPA_URL && SUPA_KEY) {
        fetch(`${SUPA_URL}/rest/v1/bluelens_analyses`, {
          method: 'POST',
          headers: { ...supaH, 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            user_email: userEmail,
            input_url: decodedUrl,
            input_platform: platform,
            video_title: videoMeta.title,
            video_duration: videoMeta.duration,
            thumbnail_url: videoMeta.thumbnail,
            results: searchResults.slice(0, 5),
            best_match_url: searchResults[0]?.url || null,
            best_match_similarity: searchResults[0]?.similarity || 0,
            ai_verdict: aiAnalysis.verdict,
            ai_confidence: aiAnalysis.confidence,
            ai_reasoning: aiAnalysis.reasoning,
            visual_patterns: aiAnalysis.patterns || []
          })
        }).catch(()=>{});

        // Adiciona vídeo ao banco interno se não existir
        if (ytVideoId && videoMeta.title) {
          fetch(`${SUPA_URL}/rest/v1/bluelens_video_db`, {
            method: 'POST',
            headers: { ...supaH, 'Prefer': 'resolution=ignore,return=minimal' },
            body: JSON.stringify({
              url: decodedUrl,
              platform,
              title: videoMeta.title,
              channel: videoMeta.channel,
              duration: videoMeta.duration,
              thumbnail_url: videoMeta.thumbnail,
              is_original: aiAnalysis.verdict === 'original',
              confidence: aiAnalysis.confidence
            })
          }).catch(()=>{});
        }
      }

      return res.status(200).json({
        analysisId,
        platform,
        videoMeta,
        results: searchResults.slice(0, 6),
        thumbnailFlags,
        aiAnalysis,
        internalMatch: internalMatches[0] || null,
        totalFound: searchResults.length
      });

    } catch(e) {
      console.error('BlueLens error:', e.message);
      return res.status(500).json({ error: 'Erro na análise: ' + e.message });
    }
  }

  // POST { action: 'bluelens-feedback', analysisId, clickedUrl }
  if (req.method === 'POST' && _action === 'bluelens-feedback') {
    const { analysisId, clickedUrl } = req.body || {};
    if (!analysisId || !clickedUrl) return res.status(400).json({ error: 'Dados obrigatórios' });
    try {
      // Atualiza análise com feedback do usuário
      await fetch(`${SUPA_URL}/rest/v1/bluelens_analyses?id=eq.${analysisId}`, {
        method: 'PATCH',
        headers: supaH,
        body: JSON.stringify({ user_clicked_result: clickedUrl })
      });
      // Incrementa score do vídeo clicado no banco interno
      fetch(`${SUPA_URL}/rest/v1/bluelens_video_db?url=eq.${encodeURIComponent(clickedUrl)}`, {
        method: 'PATCH',
        headers: supaH,
        body: JSON.stringify({ times_matched: 999, last_seen: new Date().toISOString() })
      }).catch(()=>{});
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(200).json({ ok: false });
    }
  }

    return res.status(400).json({ error: 'Ação inválida' });

  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
  }
}
