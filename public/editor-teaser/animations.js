// Animations coordenadas: cursor, intersection reveals, glitch, saudacao por plano,
// captura de email, replay da experiencia.

(function(){
  // ── CURSOR CUSTOM ────────────────────────────────────────────────
  const dot = document.querySelector('.cursor-dot');
  const ring = document.querySelector('.cursor-ring');
  if (dot && ring && !matchMedia('(hover:none)').matches){
    let mx = 0, my = 0, rx = 0, ry = 0;
    window.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; });
    function loop(){
      rx += (mx - rx) * 0.18;
      ry += (my - ry) * 0.18;
      dot.style.transform = `translate(${mx}px,${my}px) translate(-50%,-50%)`;
      ring.style.transform = `translate(${rx}px,${ry}px) translate(-50%,-50%)`;
      requestAnimationFrame(loop);
    }
    loop();
    document.addEventListener('mouseover', e => {
      if (e.target.closest('button,a,input,.feat,.nav-btn,.replay-btn')) ring.classList.add('hover');
    });
    document.addEventListener('mouseout', e => {
      if (e.target.closest('button,a,input,.feat,.nav-btn,.replay-btn')) ring.classList.remove('hover');
    });
  }

  // ── REVEAL FEATURES ON SCROLL ───────────────────────────────────
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting){
        const feats = e.target.querySelectorAll('.feat');
        feats.forEach((f,i) => setTimeout(() => f.classList.add('in'), i * 400));
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.2 });
  document.querySelectorAll('.features-grid').forEach(g => io.observe(g));

  // ── SAUDACAO POR PLANO (detecta token + subscriber) ─────────────
  async function detectarPlano(){
    const token = localStorage.getItem('bt_token');
    if (!token) return { plano: 'guest', nome: null };
    try {
      const r = await fetch('/api/editor-espera?action=plano&token=' + encodeURIComponent(token));
      if (!r.ok) return { plano: 'guest', nome: null };
      const d = await r.json();
      return d;
    } catch(e){ return { plano: 'guest', nome: null }; }
  }

  async function aplicarPersonalizacao(){
    const info = await detectarPlano();
    const plano = info.plano || 'guest';
    const nome = info.nome || '';
    document.body.dataset.plano = plano;

    // i18n helper com fallback seguro (se i18n.js nao carregou, usa fallback PT)
    const tFn = (typeof window.t === 'function') ? window.t : (k, f) => f;

    // Saudacao Master — destaque dourado
    if (plano === 'master'){
      const greet = document.getElementById('master-greet');
      if (greet){
        greet.textContent = nome
          ? tFn('editor_master_greet_format', '✨ Você está protegido, {nome}').replace('{nome}', nome)
          : tFn('editor_master_greet_noname', '✨ Você está protegido, Master');
        greet.classList.remove('hidden');
      }
      // Esconde form de email (ja tem conta)
      const emailSec = document.getElementById('email-section');
      if (emailSec) emailSec.classList.add('hidden');
    } else if (plano === 'full'){
      // Full: mostra email, mensagem sutil
      const hint = document.getElementById('email-hint');
      if (hint) hint.innerHTML = tFn('editor_email_hint_full_html', 'Upgrade antes do lançamento trava o preço.<br>Blublu te avisa quando der.');
    } else if (plano === 'free'){
      // Free usa o mesmo HTML default do data-i18n-html="editor_email_hint_guest_html"
      // — applyI18n ja o aplica no boot. Nada a fazer aqui.
    }

    // Tweak na fala da Blublu conforme plano
    const speech = document.getElementById('blublu-speech');
    if (speech && window.teaserType){
      let texto;
      if (plano === 'master'){
        const fallback = `Entre nós, ${nome || 'criador'}...|Você já pagou a entrada. Você já viu o que é ser tratado como alguém que acredita cedo.|Quando o BlueEditor chegar, o plano Master vai refletir o novo valor.|Mas você, que entrou agora, continua no mesmo preço. Para sempre.|Não é marketing. É promessa.`;
        texto = tFn('editor_blublu_speech_master', fallback).replace('{nome}', nome || 'criador');
      } else if (plano === 'full'){
        texto = tFn('editor_blublu_speech_full', `Já que você está quase lá...|O plano Full já me dá muito sobre você. Criador sério.|Quando o BlueEditor lançar, o Master vai refletir o novo valor real.|Quem já é Master agora, continua no mesmo preço. Para sempre.|Upgrade antes do lançamento = você entra nessa lista.`);
      } else {
        texto = tFn('editor_blublu_speech_guest', `Entre nós, criador...|Quando o BlueEditor lançar, o plano Master vai refletir o seu novo valor real.|Mas quem já é Master agora, continua no mesmo preço. Para sempre.|É minha forma de agradecer a quem acreditou primeiro.`);
      }
      // Espera um tempo pra não conflitar com o typewriter da cena 1
      setTimeout(() => { if (speech.dataset.typed !== '1'){ speech.dataset.typed = '1'; window.teaserType(speech, texto, { speed: 28, jitter: 20, pausa: 1000 }); } }, 1200);
    }
  }

  // ── EMAIL CAPTURE ───────────────────────────────────────────────
  const form = document.getElementById('email-form');
  if (form){
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('input[type=email]');
      const btn = form.querySelector('button');
      const fb = document.getElementById('email-feedback');
      const email = (input.value || '').trim().toLowerCase();
      const tFn = (typeof window.t === 'function') ? window.t : (k, f) => f;
      const submitLabel = tFn('editor_email_submit', 'Avise-me');
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
        fb.textContent = tFn('editor_email_feedback_invalid', 'Email inválido');
        fb.className = 'email-feedback err';
        return;
      }
      btn.disabled = true;
      btn.textContent = tFn('editor_email_sending', 'Enviando...');
      fb.textContent = '';
      fb.className = 'email-feedback';
      try {
        const token = localStorage.getItem('bt_token') || null;
        const r = await fetch('/api/editor-espera', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, token })
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok){
          fb.textContent = tFn('editor_email_feedback_ok', '✓ Você está na lista. Blublu te avisa.');
          fb.className = 'email-feedback ok';
          input.value = '';
          btn.textContent = tFn('editor_email_sent', 'Enviado');
          setTimeout(() => { btn.disabled = false; btn.textContent = submitLabel; }, 3000);
        } else {
          fb.textContent = d.error || tFn('editor_email_feedback_generic_err', 'Erro ao salvar. Tenta de novo em 1min?');
          fb.className = 'email-feedback err';
          btn.disabled = false;
          btn.textContent = submitLabel;
        }
      } catch(err){
        fb.textContent = tFn('editor_email_feedback_offline', 'Sem conexão. Tenta de novo?');
        fb.className = 'email-feedback err';
        btn.disabled = false;
        btn.textContent = submitLabel;
      }
    });
  }

  // ── REPLAY ──────────────────────────────────────────────────────
  const replay = document.getElementById('replay-btn');
  if (replay){
    replay.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(() => { if (window.teaserReplay) window.teaserReplay(); }, 600);
    });
  }

  // ── MASTER SEQUENCE: cena 1 -> cena 2 -> personalizacao ─────────
  function startExperience(){
    const l1 = document.getElementById('line-1');
    const l2 = document.getElementById('line-2');
    if (!l1 || !window.teaserType) return;
    const tFn = (typeof window.t === 'function') ? window.t : (k, f) => f;
    const line1 = tFn('editor_scene1_line1', 'Enquanto você dorme...');
    const line2 = tFn('editor_scene1_line2', '...o BlueTube evolui.');
    const taglineTxt = tFn('editor_scene2_tagline_dyn', 'Crie. Edite. Publique.|Sem nunca sair do BlueTube.');
    window.teaserType(l1, line1, { speed: 55, jitter: 30 })
      .then(() => new Promise(r => setTimeout(r, 900)))
      .then(() => window.teaserType(l2, line2, { speed: 55, jitter: 30 }))
      .then(() => new Promise(r => setTimeout(r, 1100)))
      .then(() => {
        const logo = document.getElementById('mega-logo');
        if (logo){ logo.classList.add('glitching'); setTimeout(() => { logo.classList.remove('glitching'); logo.classList.add('stable'); }, 1200); }
        const tagline = document.getElementById('tagline-main');
        if (tagline) window.teaserType(tagline, taglineTxt, { speed: 38, jitter: 20, pausa: 800 });
      });
  }

  window.teaserReplay = () => {
    const l1 = document.getElementById('line-1');
    const l2 = document.getElementById('line-2');
    const tagline = document.getElementById('tagline-main');
    const logo = document.getElementById('mega-logo');
    if (l1) l1.innerHTML = '';
    if (l2) l2.innerHTML = '';
    if (tagline) tagline.innerHTML = '';
    if (logo){ logo.classList.remove('stable'); }
    startExperience();
  };

  // ── BOOT ────────────────────────────────────────────────────────
  // Espera window.__i18nReady (promise do i18n boot do blueEditor.html)
  // pra garantir que window.t() retorna traducoes, nao fallbacks PT,
  // no momento em que o typewriter comeca.
  document.addEventListener('DOMContentLoaded', async () => {
    if (window.__i18nReady && typeof window.__i18nReady.then === 'function') {
      try { await window.__i18nReady; } catch (e) { /* segue com fallback PT */ }
    }
    startExperience();
    aplicarPersonalizacao();
  });
})();
