// Canvas de particulas com atracao pelo mouse + trail.
// Adapta densidade ao hardware (hardwareConcurrency) e a tamanho da tela.
// Pausa quando aba fica inativa pra economizar CPU.

(function(){
  const canvas = document.getElementById('particles');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const isMobile = window.matchMedia('(max-width:760px)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const isLowEnd = cores <= 4 || isMobile;

  let W = 0, H = 0, DPR = Math.min(window.devicePixelRatio || 1, 2);
  const COUNT = isLowEnd ? 60 : 180;
  const particles = [];
  const mouse = { x: -999, y: -999, vx: 0, vy: 0, lx: 0, ly: 0 };

  function resize(){
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  class P {
    constructor(){ this.reset(true); }
    reset(initial){
      this.x = Math.random() * W;
      this.y = initial ? Math.random() * H : H + 20;
      this.vx = (Math.random() - 0.5) * 0.3;
      this.vy = -0.2 - Math.random() * 0.4;
      this.r = 0.6 + Math.random() * 1.8;
      this.o = 0.15 + Math.random() * 0.55;
      this.phase = Math.random() * Math.PI * 2;
    }
    step(dt){
      // movimento organico base
      this.phase += 0.01;
      this.x += this.vx + Math.sin(this.phase) * 0.1;
      this.y += this.vy;
      // atracao do mouse
      const dx = mouse.x - this.x;
      const dy = mouse.y - this.y;
      const d2 = dx*dx + dy*dy;
      if (d2 < 22500 && d2 > 100){
        const d = Math.sqrt(d2);
        const force = (1 - d/150) * 0.35;
        this.x += (dx/d) * force;
        this.y += (dy/d) * force;
      }
      if (this.y < -10 || this.x < -10 || this.x > W + 10){
        this.reset(false);
      }
    }
    draw(){
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,170,255,${this.o})`;
      ctx.fill();
    }
  }

  for (let i = 0; i < COUNT; i++) particles.push(new P());

  window.addEventListener('mousemove', (e) => {
    mouse.vx = e.clientX - mouse.lx;
    mouse.vy = e.clientY - mouse.ly;
    mouse.lx = e.clientX;
    mouse.ly = e.clientY;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  window.addEventListener('mouseleave', () => { mouse.x = -999; mouse.y = -999; });

  let last = performance.now();
  let paused = false;
  document.addEventListener('visibilitychange', () => { paused = document.hidden; });

  function tick(t){
    const dt = Math.min(50, t - last);
    last = t;
    if (paused){ requestAnimationFrame(tick); return; }

    // fade trail — em vez de clearRect, pinta um preto semi-transparente
    ctx.fillStyle = 'rgba(2,8,23,0.18)';
    ctx.fillRect(0, 0, W, H);

    // conexoes proximas (apenas no desktop nao low-end, custa CPU)
    if (!isLowEnd){
      ctx.strokeStyle = 'rgba(0,170,255,0.05)';
      ctx.lineWidth = 0.5;
      for (let i = 0; i < particles.length; i++){
        for (let j = i+1; j < particles.length; j++){
          const a = particles[i], b = particles[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx*dx + dy*dy;
          if (d2 < 6400){
            ctx.globalAlpha = (1 - d2/6400) * 0.3;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    for (const p of particles){
      p.step(dt);
      p.draw();
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
