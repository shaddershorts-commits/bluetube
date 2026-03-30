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

  // ── LANGUAGE DETECTION (GET) ───────────────────────────────────────────────
  // ── VIRAL SHORTS ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.query?.action === 'viral-shorts') {
    const YT_KEY = process.env.YOUTUBE_API_KEY;
    if (!YT_KEY) return res.status(500).json({ error: 'YouTube API não configurada. Adicione YOUTUBE_API_KEY no Vercel.' });

    const { period = '7d', category = '', region = 'BR', q = '' } = req.query;

    const now = new Date();
    let publishedAfter;
    if (period === '24h') publishedAfter = new Date(now - 24*60*60*1000).toISOString();
    else if (period === '7d') publishedAfter = new Date(now - 7*24*60*60*1000).toISOString();
    else if (period === '30d') publishedAfter = new Date(now - 30*24*60*60*1000).toISOString();

    try {
      const searchQuery = q ? q + ' #shorts' : '#shorts #viral';
      const params = new URLSearchParams({
        part: 'snippet', type: 'video', videoDuration: 'short',
        order: 'viewCount', maxResults: '24', regionCode: region,
        key: YT_KEY, q: searchQuery,
        ...(publishedAfter && { publishedAfter }),
        ...(category && { videoCategoryId: category }),
      });

      const searchRes = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
      const searchData = await searchRes.json();
      if (!searchRes.ok) return res.status(400).json({ error: searchData.error?.message || 'Erro YouTube API' });

      const videoIds = (searchData.items || []).filter(i => i.id?.videoId).map(i => i.id.videoId).join(',');
      if (!videoIds) return res.status(200).json({ videos: [] });

      const statsRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet,contentDetails&id=${videoIds}&key=${YT_KEY}`);
      const statsData = await statsRes.json();

      const fmtViews = n => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : n.toString();

      const videos = (statsData.items || []).map(v => {
        const stats = v.statistics || {}, snippet = v.snippet || {};
        const dur = v.contentDetails?.duration || '';
        const m = dur.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
        const secs = (parseInt(m?.[1]||0)*60)+parseInt(m?.[2]||0);
        const views = parseInt(stats.viewCount||0);
        return { id: v.id, title: snippet.title, channel: snippet.channelTitle,
          thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url,
          views, viewsFormatted: fmtViews(views), likes: parseInt(stats.likeCount||0),
          publishedAt: snippet.publishedAt, duration: secs,
          url: `https://www.youtube.com/shorts/${v.id}` };
      }).filter(v => v.duration <= 60 || v.duration === 0).sort((a,b) => b.views - a.views);

      return res.status(200).json({ videos, total: videos.length });
    } catch(e) {
      return res.status(500).json({ error: 'Falha ao buscar vídeos virais: ' + e.message });
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

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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

    return res.status(400).json({ error: 'Ação inválida' });

  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
  }
}
