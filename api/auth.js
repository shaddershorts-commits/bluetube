// api/auth.js — BlueTube Auth + Language Detection
// Supabase Auth: signup, signin, OTP verify, reset password
// Also handles GET /api/auth?action=lang for language detection

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
        if (!rapidKey) return res.status(400).json({ error: 'RAPIDAPI_KEY não configurada no Vercel.' });

        // Use youtube-to-mp4-mp3 API — returns links from their own CDN (no CORS issues)
        let r = await fetch(`https://youtube-to-mp4-mp3.p.rapidapi.com/v1/videoInfo?videoId=${videoId}`, {
          headers: {
            'x-rapidapi-key': rapidKey,
            'x-rapidapi-host': 'youtube-to-mp4-mp3.p.rapidapi.com'
          }
        });

        if (r.ok) {
          const d = await r.json();
          title = d.title || title;
          thumbnail = d.thumbnail || thumbnail;
          // Get best mp4 format
          const fmts = d.formats || [];
          const mp4 = fmts.filter(f => f.ext === 'mp4' || f.format_note?.includes('p'))
            .sort((a,b) => (parseInt(b.height)||0) - (parseInt(a.height)||0));
          downloadUrl = mp4[0]?.url || fmts[0]?.url;
        }

        // Fallback: YTStream
        if (!downloadUrl) {
          r = await fetch(`https://ytstream-download-youtube-videos.p.rapidapi.com/dl?id=${videoId}`, {
            headers: {
              'x-rapidapi-key': rapidKey,
              'x-rapidapi-host': 'ytstream-download-youtube-videos.p.rapidapi.com'
            }
          });
          if (r.ok) {
            const d = await r.json();
            title = d.title || title;
            const fmts = d.formats || {};
            for (const q of ['1080','720','480','360']) {
              if (fmts[q]?.url) { downloadUrl = fmts[q].url; break; }
            }
          }
        }

        // Fallback: youtube-media-downloader
        if (!downloadUrl) {
          r = await fetch(`https://youtube-media-downloader.p.rapidapi.com/v2/video/details?videoId=${videoId}`, {
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
          }
        }

        if (!downloadUrl) {
          return res.status(400).json({ error: 'Não foi possível obter link. Verifique se a API youtube-to-mp4-mp3 está ativada no RapidAPI.' });
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

      return res.status(200).json({ url: downloadUrl, title, thumbnail, platform });

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

  // ── BLUESCORE: AI DIAGNOSIS ──────────────────────────────────────────────────
  if (req.method === 'POST' && req.body?.action === 'bluescore-ai') {
    const { channelData, videos, scoreData } = req.body;
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

    const systemPrompt = `Você é o BlueScore Engine — um sistema de IA especializado em análise de confiança algorítmica do YouTube, baseado nas diretrizes oficiais do YouTube Partner Program (YPP) e nos padrões de distribuição do algoritmo.

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
- País: ${channelData.country || 'não informado'}
- BlueScore calculado: ${scoreData.score}/100
- Classificação: ${scoreData.classLabel}

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
        
        // Salva no Supabase para retroalimentação
        // SUPA_URL já declarada globalmente
        const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
        if (SUPA_URL && SUPA_KEY) {
          fetch(`${SUPA_URL}/rest/v1/bluescore_analyses`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPA_KEY,
              'Authorization': `Bearer ${SUPA_KEY}`,
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              channel_id: channelData.channelId,
              channel_name: channelData.title,
              score: scoreData.score,
              classification: scoreData.classification,
              avg_views: Math.round(scoreData.metrics?.avgViews || 0),
              engagement_rate: scoreData.metrics?.avgEngRate || 0,
              trend_ratio: scoreData.metrics?.trendRatio || 1,
              risk_flags: parsed.riskFlags || [],
              ytp_compliance: parsed.ytpCompliance || {},
              analyzed_at: new Date().toISOString()
            })
          }).catch(()=>{});
        }
        
        return res.status(200).json(parsed);
    }

    return res.status(200).json({ insights: [], riskFlags: [], recommendations: [], summary: 'Análise indisponível no momento.', ytpCompliance: { score: 0, status: 'atenção', notes: '' } });
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
              console.log('viral-shorts CACHE HIT:', cacheKey, 'age:', Math.round(age/60000)+'min');
              return res.status(200).json({ ...rows[0].data, fromCache: true, cacheAge: Math.round(age/60000) });
            }
          }
        }
      } catch(e) { /* cache miss, continua */ }
    }

    const REGION_CONFIG = {
      ALL: { lang: null, queries: ['viral shorts trending', 'shorts viral global', 'shorts blowing up'] },
      BR:  { lang:'pt', queries: ['shorts viral brasil', 'shorts viralizando', 'curta viral brasil'] },
      US:  { lang:'en', queries: ['viral shorts usa', 'shorts blowing up', 'trending shorts america'] },
      GB:  { lang:'en', queries: ['viral shorts uk', 'trending shorts britain', 'shorts going viral uk'] },
      IN:  { lang:'hi', queries: ['shorts viral india', 'viral shorts hindi', 'trending shorts india'] },
      MX:  { lang:'es', queries: ['shorts viral mexico', 'cortos virales mexico', 'shorts tendencia mexico'] },
      JP:  { lang:'ja', queries: ['ショート 急上昇 日本', 'ショート バズ 日本', 'ショート動画 人気'] },
      KR:  { lang:'ko', queries: ['쇼츠 인기 한국', '한국 쇼츠 바이럴', '인기급상승 쇼츠'] },
      DE:  { lang:'de', queries: ['shorts viral deutschland', 'virale shorts deutsch', 'trending shorts deutsch'] },
      FR:  { lang:'fr', queries: ['shorts viral france', 'shorts qui buzze france', 'tendance shorts france'] },
      ES:  { lang:'es', queries: ['shorts viral espana', 'shorts virales espana', 'tendencia shorts espana'] },
      AR:  { lang:'es', queries: ['shorts viral argentina', 'shorts virales argentina'] },
      CO:  { lang:'es', queries: ['shorts viral colombia', 'shorts virales colombia'] },
      TR:  { lang:'tr', queries: ['shorts viral turkiye', 'trend shorts turkce', 'viral shorts turkiye'] },
    };

    const cfg = REGION_CONFIG[region] || REGION_CONFIG['ALL'];
    const { lang, queries: regionQueries } = cfg;
    const searchQueries = q
      ? [`${q} shorts`, `${q} viral`, q]
      : regionQueries;

    const fmtViews = n => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : n.toString();

    // Tenta busca com uma chave, se der 403/quota error tenta a próxima
    const makeSearch = async (searchQ) => {
      for (let ki = 0; ki < YT_KEYS.length; ki++) {
        const key = YT_KEYS[(keyIndex + ki) % YT_KEYS.length];
        const params = new URLSearchParams({
          part: 'snippet', type: 'video', videoDuration: 'short',
          order: 'viewCount', maxResults: '50',
          key, q: searchQ, publishedAfter,
          ...(lang ? { relevanceLanguage: lang } : {}),
          ...(region !== 'ALL' ? { regionCode: region } : {}),
          ...(category ? { videoCategoryId: category } : {}),
        });
        const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
        const d = await r.json();
        if (d.error?.code === 403 || d.error?.message?.includes('quota')) {
          console.log('Quota esgotada na chave', ki, '- tentando próxima...');
          continue; // tenta próxima chave
        }
        console.log('YT search:', searchQ.slice(0,25), '| key:', ki, '| items:', d.items?.length || 0, '| err:', d.error?.message || 'ok');
        if (!r.ok) return [];
        return d.items || [];
      }
      console.log('Todas as chaves com quota esgotada!');
      return [];
    };

    try {
      const allSearches = await Promise.all(searchQueries.map(sq => makeSearch(sq)));

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

      const allVideos = statsResults.flat().map(v => {
        const stats = v.statistics || {}, snippet = v.snippet || {};
        const dur = v.contentDetails?.duration || '';
        const m = dur.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
        const secs = (parseInt(m?.[1]||0)*60)+parseInt(m?.[2]||0);
        const views = parseInt(stats.viewCount||0);
        return {
          id: v.id, title: snippet.title, channel: snippet.channelTitle,
          thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url,
          views, viewsFormatted: fmtViews(views), likes: parseInt(stats.likeCount||0),
          publishedAt: snippet.publishedAt, duration: secs,
          url: `https://www.youtube.com/shorts/${v.id}`
        };
      }).filter(v => v.duration <= 65 || v.duration === 0); // 65s de margem para Shorts

      // Filtro de data suave — remove apenas vídeos com mais de 3x o período
      // Confia no publishedAfter que já foi enviado à API
      const softCutoff = new Date(now - cutoffMs * 3);
      let videos = allVideos
        .filter(v => !v.publishedAt || new Date(v.publishedAt) >= softCutoff)
        .sort((a,b) => b.views - a.views)
        .slice(0, 100);

      // Fallback: se filtro zerou, retorna sem filtro de data (API já filtrou)
      if (videos.length === 0 && allVideos.length > 0) {
        videos = allVideos.sort((a,b) => b.views - a.views).slice(0, 100);
        console.log('viral-shorts: fallback sem filtro de data, total:', videos.length);
      }

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
      return res.status(200).json({ country, lang: langCode, translations });
    } catch (e) {
      return res.status(200).json({ country: 'BR', lang: 'pt', translations: TRANSLATIONS['pt'] });
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
      if (!previewUrl) return res.status(404).json({ error: 'Prévia não disponível' });

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
    const XI_KEY = process.env.ELEVENLABS_API_KEY;
    if (!XI_KEY) return res.status(500).json({ error: 'ElevenLabs não configurado. Adicione ELEVENLABS_API_KEY no Vercel.' });

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
        const err = await ttsRes.json().catch(()=>({}));
        const errMsg = err.detail?.message || err.detail?.status || err.detail || 'Serviço de voz indisponível';
        // Nunca expõe nome do provedor ao usuário
        console.error('TTS error:', errMsg);
        return res.status(400).json({ error: 'Falha ao gerar narração. Verifique o texto e tente novamente.' });
      }

      const audioBuffer = await ttsRes.arrayBuffer();
      const base64 = Buffer.from(audioBuffer).toString('base64');
      return res.status(200).json({ audio: base64, format: 'mp3' });
    } catch(e) {
      console.error('TTS exception:', e.message);
      return res.status(500).json({ error: 'Falha ao gerar narração. Tente novamente.' });
    }
  }

  const { action, email, password, token, otp } = req.body;
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

    // ── SIGN UP (email + password, sends confirmation email) ─────────────────
    if (action === 'signup') {
      if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });
      if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter mínimo 6 caracteres' });

      const signupUrl = `${authBase}/signup`;
      console.log('Signing up:', email, 'URL:', signupUrl);

      const r = await fetch(signupUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email,
          password,
          options: {
            emailRedirectTo: `${process.env.SITE_URL || 'https://bluetubeviral.com'}/`
          }
        })
      });
      const data = await r.json();
      console.log('Signup response status:', r.status, 'data:', JSON.stringify(data).slice(0, 200));

      if (!r.ok) {
        const msg = data.msg || data.error_description || data.error || 'Erro ao criar conta';
        if (msg.includes('already registered')) return res.status(400).json({ error: 'Este email já está cadastrado. Faça login.' });
        return res.status(400).json({ error: msg });
      }

      // Insere usuário na tabela subscribers como 'free' (aparece no admin)
      const newEmail = data.user?.email || email;
      const refCode = req.body?.ref_code || null; // código de afiliado se veio no signup
      if (newEmail && SUPABASE_URL && SUPABASE_KEY) {
        fetch(`${SUPABASE_URL}/rest/v1/subscribers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'resolution=merge-duplicates,return=minimal'
          },
          body: JSON.stringify({
            email: newEmail,
            plan: 'free',
            is_manual: false,
            affiliate_ref: refCode,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        }).catch(e => console.error('Subscriber insert error:', e.message));

        // Registra conversão de afiliado (signup free)
        if (refCode) {
          fetch(`${process.env.SITE_URL || 'https://bluetubeviral.com'}/api/affiliate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'conversion', email: newEmail, plan: 'free', conversion_type: 'signup' })
          }).catch(() => {});
        }
      }

      // If email confirmation is enabled in Supabase, session will be null
      if (!data.session) {
        return res.status(200).json({
          needsConfirmation: true,
          message: 'Conta criada! Verifique seu email e clique no link de confirmação.'
        });
      }
      return res.status(200).json({ user: data.user, session: data.session });
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
        if (msg.includes('Email not confirmed')) {
          return res.status(400).json({ error: 'Email não confirmado. Verifique sua caixa de entrada.' });
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

      // Resend confirmation email (not magic link)
      const r = await fetch(`${authBase}/resend`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'signup',
          email,
          options: {
            emailRedirectTo: `${process.env.SITE_URL || 'https://bluetubeviral.com'}/`
          }
        })
      });

      if (!r.ok) {
        const data = await r.json();
        return res.status(400).json({ error: data.msg || 'Erro ao reenviar email' });
      }

      return res.status(200).json({ sent: true, message: 'Email de confirmação reenviado!' });
    }

    // ── VERIFY OTP ────────────────────────────────────────────────────────────
    if (action === 'verify_otp') {
      if (!email || !otp) return res.status(400).json({ error: 'Email e código são obrigatórios' });

      const r = await fetch(`${authBase}/verify`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, token: otp, type: 'email' })
      });
      const data = await r.json();

      if (!r.ok) {
        return res.status(400).json({ error: 'Código inválido ou expirado. Tente novamente.' });
      }

      return res.status(200).json({
        user: data.user,
        session: { access_token: data.access_token }
      });
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
  const PLAN_AMOUNTS = { full: 9.99, master: 29.99 };
  const getAffLevel = (p) => p >= 1000 ? 'gold' : p >= 380 ? 'silver' : 'bronze';
  const genRefCode = (email) => {
    const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,8);
    const suffix = crypto.randomBytes(3).toString('hex');
    return base + suffix;
  };

  // ── TRACK CLICK ────────────────────────────────────────────────────────────
  // GET /api/affiliate?action=click&ref=CODE&cookie_id=X
  if (req.method === 'GET' && action === 'click') {
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
      await fetch(`${SUPA_URL}/rest/v1/rpc/increment_affiliate_clicks`, {
        method: 'POST',
        headers: supaH,
        body: JSON.stringify({ ref: ref })
      }).catch(() => {
        // Fallback se RPC não existir
        fetch(`${SUPA_URL}/rest/v1/affiliates?ref_code=eq.${ref}`, {
          method: 'PATCH',
          headers: { ...supaH, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ updated_at: new Date().toISOString() })
        });
      });

      return res.status(200).json({ ok: true, affiliate_id: affiliate.id });
    } catch(e) {
      console.error('Affiliate click error:', e.message);
      return res.status(200).json({ ok: false });
    }
  }

  // ── REGISTER AFFILIATE ─────────────────────────────────────────────────────
  // POST { action: 'register', token, name }
  if (req.method === 'POST' && action === 'register') {
    const { token, name } = req.body;
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
      return res.status(201).json({ affiliate: data[0] });
    } catch(e) {
      console.error('Register affiliate error:', e.message);
      return res.status(500).json({ error: 'Erro ao criar afiliado' });
    }
  }

  // ── GET DASHBOARD DATA ─────────────────────────────────────────────────────
  // GET ?action=dashboard&token=X
  if (req.method === 'GET' && action === 'dashboard') {
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
      const level = getLevel(totalPaying);
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
      console.error('Dashboard error:', e.message);
      return res.status(500).json({ error: 'Erro ao carregar dashboard' });
    }
  }

  // ── RECORD CONVERSION ──────────────────────────────────────────────────────
  // POST { action: 'conversion', email, plan, cookie_id, stripe_customer_id }
  // Chamado internamente pelo auth.js no signup/pagamento
  if (req.method === 'POST' && action === 'conversion') {
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
          const level = getLevel(totalPaying);
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
              level: getLevel(totalPaying),
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
  if (req.method === 'POST' && action === 'renewal') {
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
      const level = getLevel(totalPaying);
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
  // POST { action: 'cancel', email } — chamado pelo webhook.js no cancelamento
  if (req.method === 'POST' && action === 'cancel') {
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
            level: getLevel(totalPaying),
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


    return res.status(400).json({ error: 'Ação inválida' });

  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
  }
}
