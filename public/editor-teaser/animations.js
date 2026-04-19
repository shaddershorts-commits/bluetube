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

    // Saudacao Master — destaque dourado
    if (plano === 'master'){
      const greet = document.getElementById('master-greet');
      if (greet){
        greet.textContent = nome ? `✨ Voce esta protegido, ${nome}` : '✨ Voce esta protegido, Master';
        greet.classList.remove('hidden');
      }
      // Esconde form de email (ja tem conta)
      const emailSec = document.getElementById('email-section');
      if (emailSec) emailSec.classList.add('hidden');
    } else if (plano === 'full'){
      // Full: mostra email, mensagem sutil
      const hint = document.getElementById('email-hint');
      if (hint) hint.innerHTML = 'Upgrade antes do lancamento trava o preco.<br>Blublu te avisa quando der.';
    } else if (plano === 'free'){
      const hint = document.getElementById('email-hint');
      if (hint) hint.innerHTML = 'Quer acompanhar o desenvolvimento?<br>Blublu te avisa quando tiver novidade.';
    }

    // Tweak na fala da Blublu conforme plano
    const speech = document.getElementById('blublu-speech');
    if (speech && window.teaserType){
      let texto;
      if (plano === 'master'){
        texto = `Entre nos, ${nome || 'criador'}...|Voce ja pagou a entrada. Voce ja viu o que e ser tratado como alguem que acredita cedo.|Quando o BlueEditor chegar, o plano Master vai refletir o novo valor.|Mas voce, que entrou agora, continua no mesmo preco. Para sempre.|Nao e marketing. E promessa.`;
      } else if (plano === 'full'){
        texto = `Ja que voce esta quase la...|O plano Full ja me da muito sobre voce. Criador serio.|Quando o BlueEditor lancar, o Master vai refletir o novo valor real.|Quem ja e Master agora, continua no mesmo preco. Para sempre.|Upgrade antes do lancamento = voce entra nessa lista.`;
      } else {
        texto = `Entre nos, criador...|Quando o BlueEditor lancar, o plano Master vai refletir o seu novo valor real.|Mas quem ja e Master agora, continua no mesmo preco. Para sempre.|E minha forma de agradecer a quem acreditou primeiro.`;
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
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
        fb.textContent = 'Email invalido';
        fb.className = 'email-feedback err';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Enviando...';
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
          fb.textContent = '✓ Voce esta na lista. Blublu te avisa.';
          fb.className = 'email-feedback ok';
          input.value = '';
          btn.textContent = 'Enviado';
          setTimeout(() => { btn.disabled = false; btn.textContent = 'Avise-me'; }, 3000);
        } else {
          fb.textContent = d.error || 'Erro ao salvar. Tenta de novo em 1min?';
          fb.className = 'email-feedback err';
          btn.disabled = false;
          btn.textContent = 'Avise-me';
        }
      } catch(err){
        fb.textContent = 'Sem conexao. Tenta de novo?';
        fb.className = 'email-feedback err';
        btn.disabled = false;
        btn.textContent = 'Avise-me';
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
    window.teaserType(l1, 'Enquanto voce dorme...', { speed: 55, jitter: 30 })
      .then(() => new Promise(r => setTimeout(r, 900)))
      .then(() => window.teaserType(l2, '...o BlueTube evolui.', { speed: 55, jitter: 30 }))
      .then(() => new Promise(r => setTimeout(r, 1100)))
      .then(() => {
        const logo = document.getElementById('mega-logo');
        if (logo){ logo.classList.add('glitching'); setTimeout(() => { logo.classList.remove('glitching'); logo.classList.add('stable'); }, 1200); }
        const tagline = document.getElementById('tagline-main');
        if (tagline) window.teaserType(tagline, 'Crie. Edite. Publique.|Sem nunca sair do BlueTube.', { speed: 38, jitter: 20, pausa: 800 });
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
  document.addEventListener('DOMContentLoaded', () => {
    startExperience();
    aplicarPersonalizacao();
  });
})();
