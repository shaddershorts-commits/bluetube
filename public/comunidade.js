// comunidade.js — Painel Comunidade BlueTube (feed estilo X, exclusivo Full/Master)
// Carregado sob demanda pelo index.html (openCommunity). Autocontido: injeta
// CSS + overlay. Abas: Dicas (só moderador posta; vídeo destaque no topo) e
// Comunidade (feed dos assinantes). Moderador = anel + selo dourado + controle
// total (editar/apagar/fixar/banir). Mídia: foto/vídeo/áudio via Storage com
// JWT do próprio usuário; vídeo passa pelo transcode do Railway (faststart).
(function () {
  if (window.ComunidadeBT) return;

  const API = '/api/community';
  const WHATSAPP_URL = 'https://chat.whatsapp.com/EoHpURgJ9Kz1ZLkNOFaGyh';

  const S = { open: false, tab: 'comunidade', me: null, posts: [], next: null, loading: false, media: [], sending: false, wall: null, pageMode: false };

  // ── Utils ─────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = () => localStorage.getItem('bt_token');
  // Toast próprio (a página /comunidade não tem o toast() da home)
  const toast = (m) => {
    let el = $('cbtToast');
    if (!el) {
      el = document.createElement('div'); el.id = 'cbtToast';
      el.style.cssText = 'position:fixed;bottom:26px;left:50%;transform:translateX(-50%);z-index:9050;background:#0a1830;border:1px solid rgba(0,170,255,.35);color:#e8f0fb;font-family:var(--font-mono,monospace);font-size:12.5px;padding:11px 18px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);max-width:88vw;transition:opacity .3s;pointer-events:none';
      document.body.appendChild(el);
    }
    el.textContent = m; el.style.opacity = '1';
    clearTimeout(el._t); el._t = setTimeout(() => { el.style.opacity = '0'; }, 2600);
  };
  const timeAgo = (iso) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'agora';
    if (s < 3600) return Math.floor(s / 60) + 'min';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 604800) return Math.floor(s / 86400) + 'd';
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  };
  const initials = (n) => (n || '?').trim().charAt(0).toUpperCase();
  const hue = (n) => { let h = 0; for (const c of String(n || '')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  // Avatar com anel por status: MOD dourado fixo, Master 👑 dourado pulsando, Full ⚡ azul
  const avHtml = (a) => {
    const ring = a.mod ? ' mod' : a.plan === 'master' ? ' pmaster' : a.plan === 'full' ? ' pfull' : '';
    const badge = a.mod ? '' : a.plan === 'master' ? '<span class="cbt-pbdg">👑</span>' : a.plan === 'full' ? '<span class="cbt-pbdg">⚡</span>' : '';
    const core = a.avatar
      ? `<div class="cbt-av${ring}"><img src="${esc(a.avatar)}" alt=""></div>`
      : `<div class="cbt-av${ring}" style="background:hsl(${hue(a.name)},60%,38%)">${esc(initials(a.name))}</div>`;
    return `<div class="cbt-avwrap">${core}${badge}</div>`;
  };

  async function api(action, opts = {}) {
    const isGet = !opts.body;
    const url = API + '?action=' + action + '&token=' + encodeURIComponent(token() || '') + (opts.qs || '');
    const r = await fetch(url, isGet ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, token: token(), ...opts.body }) });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, d };
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  const css = `
  :root{--cbt-sans:'Inter',system-ui,-apple-system,sans-serif;--cbt-glass:rgba(10,22,40,.52);--cbt-glassbd:rgba(0,170,255,.13);--cbt-blur:blur(24px) saturate(140%)}
  .cbt-ov{position:fixed;inset:0;z-index:9000;background:rgba(2,8,23,.78);backdrop-filter:blur(8px);display:none;opacity:0;transition:opacity .25s}
  .cbt-ov.on{display:block;opacity:1}
  .cbt-panel{position:fixed;inset:0;z-index:9001;display:none;flex-direction:column;background:rgba(4,11,26,.92);backdrop-filter:var(--cbt-blur);-webkit-backdrop-filter:var(--cbt-blur);transform:translateY(24px);opacity:0;transition:transform .28s,opacity .28s}
  .cbt-panel.on{display:flex;transform:none;opacity:1}
  @media(min-width:760px){.cbt-panel{left:50%;transform:translate(-50%,24px);width:680px;inset:18px auto 18px 50%;border:1px solid var(--cbt-glassbd);border-radius:22px;box-shadow:0 24px 80px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.05)}
  .cbt-panel.on{transform:translate(-50%,0)}}
  .cbt-head{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(0,170,255,.09);flex:0 0 auto}
  .cbt-title{font-family:var(--font-display,Syne,sans-serif);font-weight:800;font-size:16px;letter-spacing:-.4px;color:#fff;flex:1}
  .cbt-title small{display:block;font-family:var(--font-mono,monospace);font-size:10px;font-weight:400;color:#00aaff;letter-spacing:.4px}
  .cbt-x{background:none;border:none;color:#8aa0bd;font-size:20px;cursor:pointer;padding:6px 10px;border-radius:10px}
  .cbt-x:hover{background:rgba(255,255,255,.06);color:#fff}
  .cbt-me{width:36px;height:36px;border-radius:50%;cursor:pointer;overflow:hidden;flex:0 0 36px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:15px;border:2px solid rgba(0,170,255,.35);box-shadow:0 0 16px rgba(0,170,255,.2)}
  .cbt-me img{width:100%;height:100%;object-fit:cover}
  .cbt-tabs{display:flex;gap:6px;padding:12px 16px 4px;flex:0 0 auto}
  .cbt-tab{flex:1;background:rgba(10,22,40,.4);border:1px solid transparent;border-radius:100px;color:#8aa0bd;font-family:var(--font-display,Syne,sans-serif);font-weight:700;font-size:13px;padding:10px 4px;cursor:pointer;letter-spacing:.2px;transition:all .2s;backdrop-filter:blur(12px)}
  .cbt-tab.on{color:#00d0ff;border-color:rgba(0,170,255,.35);background:rgba(0,170,255,.1);box-shadow:0 0 20px rgba(0,170,255,.12),inset 0 1px 0 rgba(255,255,255,.06)}
  .cbt-shell{display:flex;flex-direction:column;flex:1;min-height:0}
  .cbt-feed{flex:1;overflow-y:auto;padding:14px 16px 8px;-webkit-overflow-scrolling:touch;scrollbar-color:rgba(0,170,255,.3) transparent}
  .cbt-feed::-webkit-scrollbar,.cbt-rail::-webkit-scrollbar{width:8px}
  .cbt-feed::-webkit-scrollbar-thumb,.cbt-rail::-webkit-scrollbar-thumb{background:rgba(0,170,255,.22);border-radius:8px}
  .cbt-feed::-webkit-scrollbar-track,.cbt-rail::-webkit-scrollbar-track{background:transparent}
  .cbt-rail{scrollbar-color:rgba(0,170,255,.3) transparent}
  .cbt-foot{flex:0 0 auto;padding:9px 16px;border-top:1px solid rgba(0,170,255,.08);text-align:center}
  .cbt-foot a{font-family:var(--font-mono,monospace);font-size:10.5px;color:#5f7590;text-decoration:none}
  .cbt-foot a:hover{color:#25D366}
  .cbt-composer{background:var(--cbt-glass);border:1px solid var(--cbt-glassbd);border-radius:20px;padding:16px;margin-bottom:18px;backdrop-filter:var(--cbt-blur);-webkit-backdrop-filter:var(--cbt-blur);box-shadow:0 8px 40px rgba(0,30,90,.18),inset 0 1px 0 rgba(255,255,255,.05);transition:border-color .2s}
  .cbt-composer:focus-within{border-color:rgba(0,170,255,.4);box-shadow:0 8px 40px rgba(0,60,160,.25),0 0 24px rgba(0,170,255,.08),inset 0 1px 0 rgba(255,255,255,.05)}
  .cbt-composer textarea{width:100%;background:none;border:none;outline:none;resize:none;color:#e8f0fb;font-family:var(--cbt-sans);font-size:14.5px;line-height:1.55;min-height:44px;max-height:180px}
  .cbt-composer textarea::placeholder{color:#5f7590}
  .cbt-crow{display:flex;align-items:center;gap:8px;margin-top:10px}
  .cbt-mbtn{background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.18);border-radius:100px;color:#00c4ff;font-size:14px;padding:7px 13px;cursor:pointer;transition:all .2s;backdrop-filter:blur(8px)}
  .cbt-mbtn:hover{background:rgba(0,170,255,.14);box-shadow:0 0 16px rgba(0,170,255,.15);transform:translateY(-1px)}
  .cbt-pub{margin-left:auto;background:linear-gradient(135deg,#0077ff,#00c4ff);border:none;border-radius:100px;color:#fff;font-family:var(--font-display,Syne,sans-serif);font-weight:700;font-size:13px;padding:10px 26px;cursor:pointer;box-shadow:0 4px 24px rgba(0,150,255,.35),inset 0 1px 0 rgba(255,255,255,.25);transition:all .2s}
  .cbt-pub:hover{transform:translateY(-1px);box-shadow:0 6px 32px rgba(0,150,255,.5),inset 0 1px 0 rgba(255,255,255,.25)}
  .cbt-pub:disabled{opacity:.5;cursor:default;transform:none}
  .cbt-newdica{display:flex;align-items:center;gap:10px;width:100%;background:var(--cbt-glass);border:1px dashed rgba(251,191,36,.35);border-radius:16px;color:#fbbf24;font-family:var(--font-display,Syne,sans-serif);font-weight:700;font-size:13px;padding:14px 18px;cursor:pointer;margin-bottom:18px;backdrop-filter:var(--cbt-blur);transition:all .2s}
  .cbt-newdica:hover{border-color:rgba(251,191,36,.6);box-shadow:0 0 24px rgba(251,191,36,.1)}
  .cbt-chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  .cbt-chip{position:relative;width:72px;height:72px;border-radius:10px;overflow:hidden;border:1px solid rgba(0,170,255,.25);background:#0a1830;display:flex;align-items:center;justify-content:center;font-size:22px}
  .cbt-chip img{width:100%;height:100%;object-fit:cover}
  .cbt-chip .rm{position:absolute;top:2px;right:2px;background:rgba(0,0,0,.7);border:none;color:#fff;border-radius:50%;width:20px;height:20px;font-size:11px;cursor:pointer;line-height:1}
  .cbt-chip .pct{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(255,255,255,.15)}
  .cbt-chip .pct i{display:block;height:100%;background:#00aaff;width:0%}
  .cbt-card{border:1px solid var(--cbt-glassbd);border-radius:20px;padding:16px;margin-bottom:14px;background:var(--cbt-glass);backdrop-filter:var(--cbt-blur);-webkit-backdrop-filter:var(--cbt-blur);box-shadow:0 6px 32px rgba(0,20,60,.22),inset 0 1px 0 rgba(255,255,255,.045);transition:transform .2s,border-color .2s,box-shadow .2s}
  .cbt-card:hover{transform:translateY(-2px);border-color:rgba(0,170,255,.28);box-shadow:0 14px 44px rgba(0,40,120,.3),inset 0 1px 0 rgba(255,255,255,.045)}
  .cbt-card.pin{border-color:rgba(251,191,36,.4);box-shadow:0 6px 32px rgba(120,80,0,.15),inset 0 1px 0 rgba(255,255,255,.05)}
  .cbt-prow{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .cbt-av{width:40px;height:40px;border-radius:50%;overflow:hidden;flex:0 0 40px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:16px}
  .cbt-av img{width:100%;height:100%;object-fit:cover}
  .cbt-av.mod{box-shadow:0 0 0 2px #050d1f,0 0 0 4px #fbbf24,0 0 14px rgba(251,191,36,.5)}
  .cbt-avwrap{position:relative;flex:0 0 auto;display:flex}
  .cbt-pbdg{position:absolute;bottom:-5px;right:-5px;font-size:12px;filter:drop-shadow(0 1px 3px rgba(0,0,0,.9));pointer-events:none}
  .cbt-c .cbt-pbdg{font-size:10px;bottom:-4px;right:-4px}
  .cbt-av.pfull{box-shadow:0 0 0 2px #050d1f,0 0 0 3px #00aaff,0 0 12px rgba(0,170,255,.5)}
  .cbt-av.pmaster{animation:cbtGold 2.2s ease-in-out infinite}
  @keyframes cbtGold{0%,100%{box-shadow:0 0 0 2px #050d1f,0 0 0 3px #fbbf24,0 0 8px rgba(251,191,36,.3)}50%{box-shadow:0 0 0 2px #050d1f,0 0 0 3px #ffd977,0 0 20px rgba(251,191,36,.75)}}
  .cbt-train{font-family:var(--font-mono,monospace);font-size:9.5px;font-weight:700;color:#fbbf24;letter-spacing:.18em;margin-bottom:12px;display:flex;align-items:center;gap:8px}
  .cbt-nbadge{display:none;background:linear-gradient(135deg,#ff4757,#ff6b81);color:#fff;font-family:var(--font-mono,monospace);font-size:9px;font-weight:700;border-radius:100px;padding:1px 7px;margin-left:6px;vertical-align:middle;box-shadow:0 0 10px rgba(255,71,87,.4)}
  .cbt-pname{font-weight:700;font-size:13.5px;color:#fff;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .cbt-modbadge{background:linear-gradient(135deg,#fbbf24,#d97706);color:#1a1200;font-family:var(--font-mono,monospace);font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;letter-spacing:.5px}
  .cbt-ptime{font-family:var(--font-mono,monospace);font-size:10px;color:#5f7590}
  .cbt-menu{margin-left:auto;position:relative}
  .cbt-menu>button{background:none;border:none;color:#5f7590;font-size:17px;cursor:pointer;padding:4px 8px;border-radius:8px}
  .cbt-menu>button:hover{background:rgba(255,255,255,.06);color:#fff}
  .cbt-dd{position:absolute;right:0;top:28px;background:rgba(10,24,48,.85);backdrop-filter:var(--cbt-blur);-webkit-backdrop-filter:var(--cbt-blur);border:1px solid rgba(0,170,255,.22);border-radius:14px;min-width:170px;z-index:5;display:none;overflow:hidden;box-shadow:0 16px 40px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06)}
  .cbt-dd.on{display:block}
  .cbt-dd button{display:block;width:100%;background:none;border:none;color:#c7d5ea;font-size:12.5px;text-align:left;padding:10px 14px;cursor:pointer}
  .cbt-dd button:hover{background:rgba(0,170,255,.1)}
  .cbt-dd button.danger{color:#f87171}
  .cbt-content{font-family:var(--cbt-sans);font-size:14.5px;line-height:1.6;color:#dce8f8;white-space:pre-wrap;word-break:break-word}
  .cbt-media{margin-top:10px;display:grid;gap:6px;border-radius:12px;overflow:hidden}
  .cbt-media.g2{grid-template-columns:1fr 1fr}
  .cbt-media img{width:100%;max-height:420px;object-fit:cover;border-radius:10px;cursor:pointer;display:block}
  .cbt-media video{width:100%;max-height:480px;border-radius:10px;background:#000;display:block}
  .cbt-media audio{width:100%}
  .cbt-media .yt-embed{position:relative;padding-top:56.25%;border-radius:12px;overflow:hidden;background:#000;box-shadow:0 8px 30px rgba(0,0,0,.4)}
  .cbt-media .yt-embed iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
  .cbt-ytin{width:100%;background:rgba(255,0,0,.04);border:1px solid rgba(255,80,80,.2);border-radius:12px;color:#e8f0fb;font-family:var(--cbt-sans);font-size:12.5px;padding:10px 13px;outline:none;margin-top:10px;transition:border-color .2s}
  .cbt-ytin:focus{border-color:rgba(255,80,80,.5)}
  .cbt-ytin::placeholder{color:#5f7590}
  .cbt-abar{display:flex;gap:18px;margin-top:10px;align-items:center}
  .cbt-act{background:none;border:none;color:#7d93b0;font-family:var(--font-mono,monospace);font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:8px}
  .cbt-act:hover{color:#00aaff;background:rgba(0,170,255,.07)}
  .cbt-act.liked{color:#f87171}
  .cbt-cbox{margin-top:10px;border-top:1px solid rgba(0,170,255,.08);padding-top:10px;display:none}
  .cbt-cbox.on{display:block}
  .cbt-c{display:flex;gap:9px;margin-bottom:10px}
  .cbt-c .cbt-av{width:30px;height:30px;flex:0 0 30px;font-size:12px}
  .cbt-cbody{flex:1;min-width:0}
  .cbt-cname{font-size:12px;font-weight:700;color:#fff;display:flex;gap:6px;align-items:center}
  .cbt-ctext{font-family:var(--cbt-sans);font-size:13.5px;color:#c7d5ea;line-height:1.5;white-space:pre-wrap;word-break:break-word}
  .cbt-cdel{background:none;border:none;color:#5f7590;font-size:10px;cursor:pointer;padding:2px 4px}
  .cbt-cdel:hover{color:#f87171}
  .cbt-cact{display:flex;gap:10px;margin-top:5px;align-items:center;flex-wrap:wrap}
  .cbt-cbtn{background:none;border:none;color:#6d84a3;font-family:var(--font-mono,monospace);font-size:10.5px;cursor:pointer;display:flex;align-items:center;gap:4px;padding:3px 6px;border-radius:8px;transition:all .15s}
  .cbt-cbtn:hover{color:#00c4ff;background:rgba(0,170,255,.07)}
  .cbt-cbtn.liked{color:#f87171}
  .cbt-cbtn.danger:hover{color:#f87171;background:rgba(248,113,113,.07)}
  .cbt-creply{margin-left:40px}
  .cbt-cpinned{background:rgba(251,191,36,.05);border:1px solid rgba(251,191,36,.18);border-radius:14px;padding:10px 12px;margin-bottom:12px}
  .cbt-pinbadge{font-family:var(--font-mono,monospace);font-size:9px;color:#fbbf24;background:rgba(251,191,36,.1);border-radius:20px;padding:2px 8px}
  .cbt-replybox{margin-top:8px}
  .cbt-cgif{max-width:220px;max-height:180px;border-radius:12px;display:block;margin-top:2px}
  .cbt-mini{background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.16);border-radius:10px;color:#8fb6d8;font-family:var(--font-mono,monospace);font-size:11px;font-weight:700;padding:0 10px;cursor:pointer;transition:all .15s;flex:0 0 auto}
  .cbt-mini:hover{background:rgba(0,170,255,.14);color:#00c4ff}
  .cbt-float{position:fixed;z-index:9040;display:none;width:320px;max-width:92vw;background:rgba(10,24,48,.9);backdrop-filter:var(--cbt-blur);-webkit-backdrop-filter:var(--cbt-blur);border:1px solid rgba(0,170,255,.25);border-radius:16px;padding:10px;box-shadow:0 20px 60px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.06)}
  .cbt-float.on{display:block}
  .cbt-emj{background:none;border:none;font-size:21px;padding:5px;cursor:pointer;border-radius:8px;line-height:1}
  .cbt-emj:hover{background:rgba(0,170,255,.12);transform:scale(1.15)}
  .cbt-gifhead{display:flex;gap:6px;margin-bottom:8px}
  .cbt-gifhead input{flex:1;background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.2);border-radius:9px;color:#fff;font-size:12px;padding:8px 10px;outline:none}
  .cbt-gifhead button{background:rgba(0,170,255,.15);border:none;border-radius:9px;color:#00c4ff;padding:0 12px;cursor:pointer}
  .cbt-gifgrid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;max-height:260px;overflow-y:auto}
  .cbt-gifgrid img{width:100%;height:80px;object-fit:cover;border-radius:8px;cursor:pointer;display:block}
  .cbt-gifgrid img:hover{outline:2px solid #00c4ff}
  .cbt-cinput{display:flex;gap:8px;margin-top:6px}
  .cbt-cinput input{flex:1;background:rgba(0,170,255,.05);border:1px solid rgba(0,170,255,.15);border-radius:10px;color:#e8f0fb;font-size:13px;padding:9px 12px;outline:none}
  .cbt-cinput button{background:rgba(0,170,255,.15);border:none;border-radius:10px;color:#00aaff;font-size:13px;font-weight:700;padding:0 16px;cursor:pointer}
  .cbt-more{width:100%;background:var(--cbt-glass);backdrop-filter:blur(12px);border:1px dashed rgba(0,170,255,.3);border-radius:100px;color:#00c4ff;font-family:var(--font-mono,monospace);font-size:12px;padding:13px;cursor:pointer;margin:4px 0 14px;transition:all .2s}
  .cbt-more:hover{border-color:rgba(0,170,255,.55);box-shadow:0 0 20px rgba(0,170,255,.12)}
  .cbt-empty{text-align:center;color:#5f7590;font-family:var(--font-mono,monospace);font-size:12px;padding:46px 20px;line-height:1.9}
  .cbt-feat{position:relative;border:1px solid rgba(251,191,36,.35);border-radius:22px;overflow:hidden;margin-bottom:20px;background:var(--cbt-glass);backdrop-filter:var(--cbt-blur);-webkit-backdrop-filter:var(--cbt-blur);box-shadow:0 12px 48px rgba(120,80,0,.14),0 0 0 1px rgba(251,191,36,.06),inset 0 1px 0 rgba(255,255,255,.06)}
  .cbt-feat .eyebrow{display:flex;align-items:center;gap:8px;padding:13px 18px 0;font-family:var(--font-mono,monospace);font-size:10px;font-weight:700;color:#fbbf24;letter-spacing:.18em}
  .cbt-feat .yt{position:relative;padding-top:56.25%;margin:12px 14px 0;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.4)}
  .cbt-feat iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
  .cbt-feat .cap{padding:12px 18px 15px;font-size:13.5px;font-weight:700;color:#ffd977;display:flex;gap:8px;align-items:center;line-height:1.45}
  .cbt-wall{text-align:center;padding:48px 28px}
  .cbt-wall .ico{font-size:44px;margin-bottom:14px}
  .cbt-wall h3{font-family:var(--font-display,Syne,sans-serif);font-size:19px;color:#fff;margin:0 0 10px;letter-spacing:-.4px}
  .cbt-wall p{font-family:var(--font-mono,monospace);font-size:12px;color:#8aa0bd;line-height:1.9;margin:0 0 22px}
  .cbt-wall .cta{background:linear-gradient(135deg,#0077ff,#00aaff);border:none;border-radius:12px;color:#fff;font-family:var(--font-display,Syne,sans-serif);font-weight:700;font-size:14px;padding:13px 30px;cursor:pointer;box-shadow:0 0 24px rgba(0,170,255,.3)}
  .cbt-dlg{position:fixed;inset:0;z-index:9010;background:rgba(2,8,23,.85);display:none;align-items:center;justify-content:center;padding:20px}
  .cbt-dlg.on{display:flex}
  .cbt-dlgbox{background:rgba(10,24,48,.75);backdrop-filter:var(--cbt-blur);-webkit-backdrop-filter:var(--cbt-blur);border:1px solid rgba(0,170,255,.28);border-radius:22px;padding:26px;width:100%;max-width:390px;box-shadow:0 24px 70px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.07)}
  .cbt-dlgbox h3{font-family:var(--font-display,Syne,sans-serif);color:#fff;font-size:16px;margin:0 0 6px}
  .cbt-dlgbox p{font-family:var(--font-mono,monospace);font-size:11px;color:#8aa0bd;margin:0 0 16px;line-height:1.7}
  .cbt-dlgbox input{width:100%;background:rgba(0,170,255,.06);border:1px solid rgba(0,170,255,.2);border-radius:10px;color:#fff;font-size:14px;padding:11px 13px;outline:none;margin-bottom:14px}
  .cbt-avpick{display:flex;align-items:center;gap:14px;margin-bottom:16px}
  .cbt-avpick .cbt-av{width:64px;height:64px;flex:0 0 64px;font-size:24px;cursor:pointer;border:2px dashed rgba(0,170,255,.35)}
  .cbt-avpick small{font-family:var(--font-mono,monospace);font-size:10px;color:#5f7590;line-height:1.6}
  .cbt-dlgbtns{display:flex;gap:10px}
  .cbt-dlgbtns button{flex:1;border-radius:10px;padding:11px;font-family:var(--font-display,Syne,sans-serif);font-weight:700;font-size:13px;cursor:pointer;border:none}
  .cbt-dlgsave{background:linear-gradient(135deg,#0077ff,#00aaff);color:#fff}
  .cbt-dlgcancel{background:rgba(255,255,255,.06);color:#8aa0bd}
  .cbt-lightbox{position:fixed;inset:0;z-index:9020;background:rgba(0,0,0,.92);display:none;align-items:center;justify-content:center;cursor:zoom-out}
  .cbt-lightbox.on{display:flex}
  .cbt-lightbox img{max-width:96vw;max-height:94vh;border-radius:8px}
  .cbt-skel{height:110px;border-radius:14px;background:linear-gradient(100deg,rgba(0,170,255,.05) 30%,rgba(0,170,255,.11) 50%,rgba(0,170,255,.05) 70%);background-size:200% 100%;animation:cbtsk 1.2s infinite;margin-bottom:12px}
  @keyframes cbtsk{to{background-position:-200% 0}}
  /* MODO PÁGINA (/comunidade): layout tela cheia estilo X — sidebar + feed + rail */
  .cbt-panel.cbt-page{position:static;inset:auto;transform:none;opacity:1;display:flex;flex-direction:column;width:100%;max-width:none;margin:0;height:calc(100dvh - 58px);border:none;border-radius:0;box-shadow:none}
  @media(min-width:760px){.cbt-panel.cbt-page{position:static;inset:auto;transform:none;width:100%;border:none;border-radius:0}
  .cbt-panel.cbt-page.on{transform:none}}
  .cbt-panel.cbt-page .cbt-x{display:none}
  .cbt-page .cbt-shell{display:grid;grid-template-columns:minmax(0,1fr);width:100%;height:100%;min-height:0;flex:1}
  .cbt-side,.cbt-rail{display:none}
  @media(min-width:900px){
    .cbt-page .cbt-shell{grid-template-columns:264px minmax(0,1fr);max-width:1400px;margin:0 auto;gap:22px;padding:22px 22px 0}
    .cbt-page .cbt-head,.cbt-page .cbt-tabs,.cbt-page .cbt-foot{display:none}
    .cbt-side{display:flex;flex-direction:column;gap:6px;padding:22px 14px;background:var(--cbt-glass);border:1px solid var(--cbt-glassbd);border-radius:24px;backdrop-filter:var(--cbt-blur);-webkit-backdrop-filter:var(--cbt-blur);box-shadow:0 8px 40px rgba(0,20,60,.25),inset 0 1px 0 rgba(255,255,255,.05);height:fit-content;max-height:100%;position:sticky;top:0;margin-bottom:22px}
    .cbt-brand{font-family:var(--font-display,Syne,sans-serif);font-weight:800;font-size:17px;color:#fff;letter-spacing:-.4px;padding:2px 12px 18px}
    .cbt-brand small{display:block;font-family:var(--font-mono,monospace);font-size:9px;font-weight:400;color:#00aaff;letter-spacing:.22em;margin-top:4px}
    .cbt-snav{display:flex;align-items:center;gap:12px;background:none;border:1px solid transparent;border-radius:14px;color:#c7d5ea;font-family:var(--font-display,Syne,sans-serif);font-weight:700;font-size:14.5px;padding:13px 15px;cursor:pointer;text-align:left;transition:all .18s}
    .cbt-snav:hover{background:rgba(0,170,255,.07);transform:translateX(2px)}
    .cbt-snav.on{color:#00d0ff;background:rgba(0,170,255,.1);border-color:rgba(0,170,255,.22);box-shadow:0 0 18px rgba(0,170,255,.1),inset 0 1px 0 rgba(255,255,255,.05)}
    .cbt-swa{margin-top:12px;display:flex;align-items:center;gap:10px;color:#5f7590;font-family:var(--font-mono,monospace);font-size:11px;text-decoration:none;padding:11px 15px;border-radius:14px;transition:all .18s}
    .cbt-swa:hover{color:#25D366;background:rgba(37,211,102,.06)}
    .cbt-sideme{margin-top:18px;display:flex;align-items:center;gap:10px;padding:11px 12px;background:rgba(0,170,255,.05);border:1px solid rgba(0,170,255,.16);border-radius:16px;cursor:pointer;transition:all .18s;backdrop-filter:blur(10px)}
    .cbt-sideme:hover{border-color:rgba(0,170,255,.45);box-shadow:0 0 20px rgba(0,170,255,.12)}
    .cbt-sideme .cbt-av{width:38px;height:38px;flex:0 0 38px;font-size:15px}
    .cbt-sideme b{font-size:13px;color:#fff;display:block;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cbt-sideme small{font-family:var(--font-mono,monospace);font-size:9.5px;color:#5f7590}
    .cbt-page .cbt-feed{padding:2px 4px 20px}
    .cbt-page .cbt-feed>*{max-width:780px;margin-left:auto;margin-right:auto}
  }
  .cbt-page.cbt-walled .cbt-side,.cbt-page.cbt-walled .cbt-rail{display:none!important}
  .cbt-page.cbt-walled .cbt-shell{grid-template-columns:minmax(0,1fr)!important}
  @media(min-width:1220px){
    .cbt-page .cbt-shell{grid-template-columns:264px minmax(0,1fr) 344px}
    .cbt-rail{display:block;padding:0 0 20px;overflow-y:auto}
    .cbt-railcard{border:1px solid var(--cbt-glassbd);border-radius:22px;padding:18px;margin-bottom:18px;background:var(--cbt-glass);backdrop-filter:var(--cbt-blur);-webkit-backdrop-filter:var(--cbt-blur);box-shadow:0 8px 40px rgba(0,20,60,.22),inset 0 1px 0 rgba(255,255,255,.05)}
    .cbt-railcard h4{font-family:var(--font-display,Syne,sans-serif);font-size:13.5px;color:#fff;margin:0 0 12px;letter-spacing:-.2px}
    .cbt-railcard p{font-family:var(--cbt-sans);font-size:12px;color:#95aac4;line-height:1.9;margin:0}
  }
  `;

  // ── HTML ──────────────────────────────────────────────────────────────────
  function mount() {
    if ($('cbtPanel')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const w = document.createElement('div');
    w.innerHTML = `
    ${S.pageMode ? '' : '<div class="cbt-ov" id="cbtOv" onclick="ComunidadeBT.close()"></div>'}
    <div class="cbt-panel${S.pageMode ? ' cbt-page' : ''}" id="cbtPanel" role="${S.pageMode ? 'main' : 'dialog'}" aria-label="Comunidade BlueTube">
      <div class="cbt-head">
        <div class="cbt-title">🏛️ Comunidade BlueTube<small>exclusiva de assinantes</small></div>
        <button class="cbt-mini" id="cbtAmigosBtn" style="height:34px" title="Amigos" onclick="window.ComunidadeAmigos&&ComunidadeAmigos.abrir()">🤝 <span class="cbt-nbadge" data-cba-badge></span></button>
        <div class="cbt-me" id="cbtMe" title="Você">?</div>
        <button class="cbt-x" onclick="ComunidadeBT.close()" aria-label="Fechar">✕</button>
      </div>
      <div class="cbt-tabs" id="cbtTabs">
        <button class="cbt-tab" data-tab="dicas" onclick="ComunidadeBT.setTab('dicas')">💡 Dicas<span class="cbt-nbadge" data-nb="dicas"></span></button>
        <button class="cbt-tab on" data-tab="comunidade" onclick="ComunidadeBT.setTab('comunidade')">🏛️ Comunidade<span class="cbt-nbadge" data-nb="comunidade"></span></button>
      </div>
      <div class="cbt-shell">
        <aside class="cbt-side">
          <div class="cbt-brand">🏛️ Comunidade<small>EXCLUSIVA DE ASSINANTES</small></div>
          <button class="cbt-snav" data-tab="dicas" onclick="ComunidadeBT.setTab('dicas')">💡 Dicas<span class="cbt-nbadge" data-nb="dicas"></span></button>
          <button class="cbt-snav on" data-tab="comunidade" onclick="ComunidadeBT.setTab('comunidade')">🏛️ Comunidade<span class="cbt-nbadge" data-nb="comunidade"></span></button>
          <button class="cbt-snav" id="cbtAmigosNav" onclick="window.ComunidadeAmigos&&ComunidadeAmigos.abrir()">🤝 Amigos<span class="cbt-nbadge" data-cba-badge></span></button>
          <a class="cbt-swa" href="javascript:void(0)" onclick="ComunidadeBT.whats()">💬 Grupo no WhatsApp</a>
          <div class="cbt-sideme" id="cbtSideMe" style="cursor:default"></div>
        </aside>
        <div class="cbt-feed" id="cbtFeed"></div>
        <aside class="cbt-rail" id="cbtRail"></aside>
      </div>
      <div class="cbt-foot"><a href="javascript:void(0)" onclick="ComunidadeBT.whats()">💬 Prefere o grupo do WhatsApp? Entrar aqui</a></div>
    </div>
    <div class="cbt-lightbox" id="cbtLight" onclick="this.classList.remove('on')"><img id="cbtLightImg" alt=""></div>
    <div class="cbt-float" id="cbtEmojiPanel"></div>
    <div class="cbt-float" id="cbtGifPanel"></div>
    <input type="file" id="cbtMediaFile" style="display:none">`;
    const host = (S.pageMode && document.getElementById('pgMain')) || document.body;
    while (w.firstChild) host.appendChild(w.firstChild);

    // Rail (só desktop página): cards de regras e treinamento
    if (S.pageMode) {
      $('cbtRail').innerHTML =
        `<div class="cbt-railcard"><h4>📜 Como funciona</h4><p>✦ Poste resultados, dúvidas e ideias<br>✦ Respeito sempre — sem spam<br>✦ Treinamentos oficiais na aba 💡 Dicas<br>✦ Moderado pelo time BlueTube <span class="cbt-modbadge">★ MOD</span></p></div>` +
        `<div class="cbt-railcard"><h4>🎓 Treinamento oficial</h4><p>Na aba <b style="color:#ffd977">💡 Dicas</b> você encontra os vídeos do time BlueTube ensinando a usar cada ferramenta e a viralizar — com espaço de comentários pra tirar dúvidas.</p></div>`;
    }

    $('cbtMediaFile').addEventListener('change', onMediaPick);
    if (!S.pageMode) document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.open) ComunidadeBT.close(); });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.cbt-menu')) document.querySelectorAll('.cbt-dd.on').forEach((d) => d.classList.remove('on'));
      if (!e.target.closest('.cbt-float') && !e.target.closest('[data-float]')) hideFloats();
    });
  }

  // ── Estado/abertura ───────────────────────────────────────────────────────
  async function open(opts = {}) {
    S.pageMode = !!opts.page;
    mount();
    S.open = true;
    $('cbtOv')?.classList.add('on'); $('cbtPanel').classList.add('on');
    if (!S.pageMode) document.body.style.overflow = 'hidden';
    if (!S.me) {
      $('cbtFeed').innerHTML = '<div class="cbt-skel"></div><div class="cbt-skel"></div><div class="cbt-skel"></div>';
      const { ok, status, d } = await api('me');
      if (!ok) {
        S.wall = status === 401 ? 'login' : (d.banned ? 'banned' : 'upgrade');
        renderWall();
        return;
      }
      S.me = d;
      renderMeAvatar();
    }
    S.wall = null;
    loadFeed(true);
  }

  function close() {
    if (S.pageMode) { location.href = '/'; return; }
    S.open = false;
    $('cbtOv')?.classList.remove('on'); $('cbtPanel')?.classList.remove('on');
    document.body.style.overflow = '';
    document.querySelectorAll('#cbtFeed video, #cbtFeed audio').forEach((m) => { try { m.pause(); } catch (e) {} });
  }

  function renderWall() {
    const kind = S.wall;
    // Na página /comunidade os CTAs navegam pra home (que abre o modal certo)
    const walls = S.pageMode ? {
      login: { ico: '🔐', h: 'Faça login pra entrar', p: 'A Comunidade é o espaço exclusivo dos assinantes BlueTube.', cta: 'Fazer login', fn: "location.href='/?login=comunidade'" },
      upgrade: { ico: '👑', h: 'Comunidade exclusiva de assinantes', p: 'Feed exclusivo com criadores dark que fazem milhões de views<br>✦ Dicas e tutoriais em primeira mão<br>✦ Poste dúvidas, vídeos e resultados<br>✦ Networking com quem já vive disso', cta: 'Desbloquear com Full ou Master', fn: "location.href='/?upgrade=comunidade'" },
      banned: { ico: '🚫', h: 'Você foi banido da Comunidade', p: 'Seu acesso foi removido pelo moderador.', cta: 'Voltar ao site', fn: "location.href='/'" },
    } : {
      login: { ico: '🔐', h: 'Faça login pra entrar', p: 'A Comunidade é o espaço exclusivo dos assinantes BlueTube.', cta: 'Fazer login', fn: "ComunidadeBT.close();window.openAuthModal&&openAuthModal()" },
      upgrade: { ico: '👑', h: 'Comunidade exclusiva de assinantes', p: 'Feed exclusivo com criadores dark que fazem milhões de views<br>✦ Dicas e tutoriais em primeira mão<br>✦ Poste dúvidas, vídeos e resultados<br>✦ Networking com quem já vive disso', cta: 'Desbloquear com Full ou Master', fn: "ComunidadeBT.close();window.openUpgradeModal&&openUpgradeModal('tool_blocked','full')" },
      banned: { ico: '🚫', h: 'Você foi banido da Comunidade', p: 'Seu acesso foi removido pelo moderador.', cta: 'Fechar', fn: 'ComunidadeBT.close()' },
    };
    const wl = walls[kind] || walls.upgrade;
    $('cbtPanel')?.classList.add('cbt-walled');
    $('cbtFeed').innerHTML = `<div class="cbt-wall"><div class="ico">${wl.ico}</div><h3>${wl.h}</h3><p>${wl.p}</p><button class="cta" onclick="${wl.fn}">${wl.cta}</button></div>`;
  }

  function renderMeAvatar() {
    const p = S.me?.profile;
    const el = $('cbtMe');
    if (el) {
      if (p?.avatar_url) el.innerHTML = `<img src="${esc(p.avatar_url)}" alt="">`;
      else { el.textContent = initials(p?.display_name || '?'); el.style.background = `hsl(${hue(p?.display_name || 'x')},60%,38%)`; }
    }
    const sm = $('cbtSideMe');
    if (sm) {
      const av = avHtml({ name: p?.display_name, avatar: p?.avatar_url, mod: S.me?.is_moderator, plan: S.me?.plan });
      const tag = S.me?.is_moderator ? 'moderador ★' : S.me?.plan === 'master' ? 'assinante Master 👑' : S.me?.plan === 'full' ? 'assinante Full ⚡' : 'assinante';
      sm.innerHTML = `${av}<div><b>${esc(p?.display_name || 'Você')}</b><small>${tag} · foto/nome no perfil do site</small></div>`;
    }
    updateBadges();
  }

  // Sino: badges de novidades nas abas (some ao abrir a aba)
  function updateBadges() {
    const u = S.me?.unseen || {};
    // Só os badges das ABAS. O badge de amigos ([data-cba-badge]) é do
    // comunidade-amigos.js — se entrasse aqui, seria zerado a cada render.
    document.querySelectorAll('.cbt-nbadge[data-nb]').forEach((el) => {
      const n = u[el.dataset.nb] || 0;
      el.textContent = n > 99 ? '99+' : String(n);
      el.style.display = n > 0 ? 'inline-block' : 'none';
    });
  }

  function markSeen(tab) {
    if (!S.me) return;
    S.me.unseen = S.me.unseen || {};
    if (S.me.unseen[tab]) { S.me.unseen[tab] = 0; updateBadges(); }
    api('seen', { body: { tab } }).catch(() => {});
  }

  // ── Feed ──────────────────────────────────────────────────────────────────
  function setTab(tab) {
    if (S.tab === tab) return;
    S.tab = tab;
    document.querySelectorAll('.cbt-tab,.cbt-snav').forEach((b) => { if (b.dataset.tab) b.classList.toggle('on', b.dataset.tab === tab); });
    loadFeed(true);
  }

  async function loadFeed(reset) {
    if (S.loading || S.wall) return;
    S.loading = true;
    if (reset) { S.posts = []; S.next = null; $('cbtFeed').innerHTML = '<div class="cbt-skel"></div><div class="cbt-skel"></div>'; }
    const { ok, status, d } = await api('feed', { qs: '&tab=' + S.tab + (S.next && !reset ? '&before=' + encodeURIComponent(S.next) : '') });
    S.loading = false;
    if (!ok) { S.wall = status === 401 ? 'login' : 'upgrade'; renderWall(); return; }
    S.posts = reset ? d.posts : S.posts.concat(d.posts);
    S.next = d.next;
    render();
    if (reset) markSeen(S.tab); // viu a aba → sino dela zera
  }

  function composerHtml() {
    const p = S.me?.profile;
    const dicas = S.tab === 'dicas';
    const ph = dicas ? 'Escreva a dica/treinamento…' : 'No que você está trabalhando, ' + esc((p?.display_name || 'criador').split(' ')[0]) + '?';
    return `<div class="cbt-composer">
        <textarea id="cbtText" placeholder="${ph}" oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,180)+'px'"></textarea>
        ${dicas ? '<input class="cbt-ytin" id="cbtYt" placeholder="▶️ Cole o link do vídeo do YouTube (opcional)">' : ''}
        <div class="cbt-chips" id="cbtChips"></div>
        <div class="cbt-crow">
          <button class="cbt-mbtn" title="Foto" onclick="ComunidadeBT.pick('image')">📷</button>
          <button class="cbt-mbtn" title="Vídeo" onclick="ComunidadeBT.pick('video')">🎬</button>
          <button class="cbt-mbtn" title="Áudio" onclick="ComunidadeBT.pick('audio')">🎤</button>
          <button class="cbt-mbtn" data-float title="Emoji" onclick="ComunidadeBT.openEmoji(this,'cbtText')">😊</button>
          <button class="cbt-pub" id="cbtPub" onclick="ComunidadeBT.publish()">Publicar</button>
        </div>
      </div>`;
  }

  function render() {
    const f = $('cbtFeed');
    $('cbtPanel')?.classList.remove('cbt-walled');
    let h = '';
    if (S.tab === 'dicas') {
      // Dicas = área de treinamento: os vídeos são POSTS (fixados ganham o
      // selo dourado de treinamento e têm comentários como qualquer post).
      // Sem composer aberto — só o mod vê o botão discreto de nova dica.
      if (S.me?.is_moderator) {
        h += `<button class="cbt-newdica" onclick="ComunidadeBT.toggleComposer()">➕ Nova dica <span style="font-family:var(--font-mono,monospace);font-size:9.5px;font-weight:400;color:#8a7a3d;margin-left:auto">só você vê isso</span></button>`;
        h += `<div id="cbtComposerWrap" style="display:none">${composerHtml()}</div>`;
      }
    } else {
      h += composerHtml();
    }
    if (!S.posts.length) {
      h += `<div class="cbt-empty">${S.tab === 'dicas' ? '💡 Os treinamentos e dicas do time BlueTube aparecem aqui.' : '🏛️ Seja o primeiro a postar!<br>Compartilhe resultados, dúvidas e ideias.'}</div>`;
    } else {
      h += S.posts.map(cardHtml).join('');
      if (S.next) h += `<button class="cbt-more" onclick="ComunidadeBT.more()">Carregar mais ↓</button>`;
    }
    f.innerHTML = h;
    renderChips();
  }

  function toggleComposer() {
    const w = $('cbtComposerWrap');
    if (w) { w.style.display = w.style.display === 'none' ? 'block' : 'none'; if (w.style.display === 'block') $('cbtText')?.focus(); }
  }

  // Botão de amizade — mora em /comunidade-amigos.js (arquivo dedicado). Se
  // esse script não carregou, o feed segue funcionando sem o botão.
  function amigoBtn(p) {
    try {
      return (p.mine || !window.ComunidadeAmigos) ? '' : (ComunidadeAmigos.botao({ name: p.author?.name, mine: p.mine, amizade: p.amizade }) || '');
    } catch (e) { return ''; }
  }

  function cardHtml(p) {
    const a = p.author || {};
    const av = avHtml(a);
    const mine = p.mine, mod = S.me?.is_moderator;
    // Post fixado de Dicas = treinamento oficial (tratamento dourado)
    const train = (p.tab === 'dicas' && p.pinned) ? '<div class="cbt-train">🎓 TREINAMENTO OFICIAL BLUETUBE</div>' : '';
    let menu = '';
    if (mine || mod) {
      menu = `<div class="cbt-menu"><button onclick="this.nextElementSibling.classList.toggle('on');event.stopPropagation()">⋮</button><div class="cbt-dd">
        ${(mine || mod) ? `<button onclick="ComunidadeBT.editPost('${p.id}')">✏️ Editar</button>` : ''}
        ${mod ? `<button onclick="ComunidadeBT.pin('${p.id}')">📌 ${p.pinned ? 'Desafixar' : 'Fixar'}</button>` : ''}
        ${(mine || mod) ? `<button class="danger" onclick="ComunidadeBT.delPost('${p.id}')">🗑️ Apagar</button>` : ''}
        ${(mod && !mine && p.author_id) ? `<button class="danger" onclick="ComunidadeBT.ban('${p.author_id}')">🚫 Banir usuário</button>` : ''}
      </div></div>`;
    }
    const media = (p.media || []).map((m) => {
      if (m.type === 'youtube' && /^[A-Za-z0-9_-]{6,15}$/.test(m.id || '')) return `<div class="yt-embed"><iframe src="https://www.youtube.com/embed/${m.id}" title="YouTube" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
      if (m.type === 'image') return `<img src="${esc(m.url)}" loading="lazy" alt="" onclick="ComunidadeBT.light(this.src)">`;
      if (m.type === 'video') return `<video controls playsinline preload="metadata" ${m.thumb ? `poster="${esc(m.thumb)}"` : ''} src="${esc(m.url)}"></video>`;
      return `<audio controls preload="none" src="${esc(m.url)}"></audio>`;
    }).join('');
    const imgs = (p.media || []).filter((m) => m.type === 'image').length;
    return `<div class="cbt-card${p.pinned ? ' pin' : ''}" id="post-${p.id}">
      ${train}
      <div class="cbt-prow">${av}<div><div class="cbt-pname">${esc(a.name)}${a.mod ? '<span class="cbt-modbadge">★ MOD</span>' : ''}${p.pinned ? ' 📌' : ''}</div>
      <div class="cbt-ptime">${timeAgo(p.created_at)}${p.edited_at ? ' · editado' : ''}</div></div>${amigoBtn(p)}${menu}</div>
      ${p.content ? `<div class="cbt-content" id="pc-${p.id}">${esc(p.content)}</div>` : ''}
      ${media ? `<div class="cbt-media${imgs > 1 ? ' g2' : ''}">${media}</div>` : ''}
      <div class="cbt-abar">
        <button class="cbt-act${p.liked ? ' liked' : ''}" id="like-${p.id}" onclick="ComunidadeBT.like('${p.id}')">${p.liked ? '❤️' : '🤍'} <span>${p.likes_count || 0}</span></button>
        <button class="cbt-act" onclick="ComunidadeBT.comments('${p.id}')">💬 <span id="cc-${p.id}">${p.comments_count || 0}</span></button>
      </div>
      <div class="cbt-cbox" id="cb-${p.id}"></div>
    </div>`;
  }

  // ── Ações de post ─────────────────────────────────────────────────────────
  // Perfil é auto-provisionado pelo backend (username da conta) — nada a pedir
  async function needProfile() { return false; }

  async function publish() {
    if (S.sending) return;
    if (await needProfile()) return;
    const text = ($('cbtText')?.value || '').trim();
    const yt = ($('cbtYt')?.value || '').trim();
    if (yt && !/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)[A-Za-z0-9_-]{6,15}/.test(yt)) return toast('❌ Link do YouTube inválido.');
    if (!text && !S.media.length && !yt) return toast('Escreva algo ou anexe uma mídia.');
    if (S.media.some((m) => m.uploading)) return toast('Aguarde o envio da mídia terminar.');
    S.sending = true; const btn = $('cbtPub'); if (btn) { btn.disabled = true; btn.textContent = 'Publicando…'; }
    const media = S.media.filter((m) => m.url).map((m) => ({ type: m.type, url: m.url, thumb: m.thumb || null }));
    const { ok, d } = await api('post-create', { body: { tab: S.tab, content: text, media, youtube: yt || undefined } });
    S.sending = false;
    // needs_profile (428) chamava editProfile(), função que NÃO existe neste
    // arquivo — resquício do diálogo de nome/foto removido. Dava
    // ReferenceError e o usuário ficava sem feedback nenhum.
    if (!ok) { if (btn) { btn.disabled = false; btn.textContent = 'Publicar'; } if (d.needs_profile) return toast('⚠️ Seu perfil da Comunidade ainda não terminou de ser criado. Recarregue a página.'); return toast('❌ ' + (d.error || 'Erro ao publicar.')); }
    S.media = [];
    toast('✅ Publicado!');
    loadFeed(true);
  }

  async function like(id) {
    if (await needProfile()) return;
    const post = S.posts.find((p) => p.id === id); if (!post) return;
    post.liked = !post.liked; post.likes_count += post.liked ? 1 : -1; // otimista
    const el = $('like-' + id); if (el) { el.classList.toggle('liked', post.liked); el.innerHTML = `${post.liked ? '❤️' : '🤍'} <span>${post.likes_count}</span>`; }
    const { ok, d } = await api('like-toggle', { body: { post_id: id } });
    if (ok && typeof d.likes_count === 'number') { post.likes_count = d.likes_count; post.liked = d.liked; if (el) el.innerHTML = `${d.liked ? '❤️' : '🤍'} <span>${d.likes_count}</span>`; }
  }

  async function delPost(id) {
    if (!confirm('Apagar este post?')) return;
    const { ok, d } = await api('post-delete', { body: { post_id: id } });
    if (!ok) return toast('❌ ' + (d.error || 'Erro.'));
    $('post-' + id)?.remove();
    S.posts = S.posts.filter((p) => p.id !== id);
  }

  async function editPost(id) {
    const post = S.posts.find((p) => p.id === id); if (!post) return;
    const novo = prompt('Editar post:', post.content || '');
    if (novo == null || novo.trim() === post.content) return;
    const { ok, d } = await api('post-edit', { body: { post_id: id, content: novo.trim() } });
    if (!ok) return toast('❌ ' + (d.error || 'Erro.'));
    post.content = novo.trim(); post.edited_at = new Date().toISOString();
    const el = $('pc-' + id); if (el) el.textContent = post.content;
    toast('✏️ Editado.');
  }

  async function pin(id) {
    const { ok, d } = await api('pin-toggle', { body: { post_id: id } });
    if (!ok) return toast('❌ ' + (d.error || 'Erro.'));
    toast(d.pinned ? '📌 Fixado no topo.' : 'Desafixado.');
    loadFeed(true);
  }

  async function ban(uid) {
    const name = (S.posts.find((p) => p.author_id === uid)?.author?.name) || 'este usuário';
    if (!confirm(`Banir "${name}" da Comunidade? A pessoa não poderá mais postar nem comentar.`)) return;
    const { ok, d } = await api('ban-user', { body: { user_id: uid, banned: true } });
    toast(ok ? `🚫 ${name} banido.` : '❌ ' + (d.error || 'Erro.'));
  }

  // ── Comentários ───────────────────────────────────────────────────────────
  async function comments(id) {
    const box = $('cb-' + id); if (!box) return;
    if (box.classList.contains('on')) { box.classList.remove('on'); return; }
    box.classList.add('on');
    box.innerHTML = '<div class="cbt-empty" style="padding:14px">Carregando…</div>';
    const { ok, d } = await api('comments', { qs: '&post_id=' + encodeURIComponent(id) });
    if (!ok) { box.innerHTML = ''; return toast('❌ ' + (d.error || 'Erro.')); }
    renderComments(id, d.comments);
  }

  // Barra de input de comentário (usada no rodapé do post e nas respostas)
  function cinputHtml(inputId, postId, parentId) {
    const send = `ComunidadeBT.sendComment('${postId}'${parentId ? `,'${parentId}'` : ''})`;
    return `<div class="cbt-cinput">
      <button class="cbt-mini" data-float title="Emoji" onclick="ComunidadeBT.openEmoji(this,'${inputId}')">😊</button>
      ${S.me?.gifs ? `<button class="cbt-mini" data-float title="GIF" onclick="ComunidadeBT.openGif(this,'${postId}'${parentId ? `,'${parentId}'` : ''})">GIF</button>` : ''}
      <input id="${inputId}" maxlength="600" placeholder="${parentId ? 'Responder…' : 'Comentar…'}" onkeydown="if(event.key==='Enter')${send}">
      <button onclick="${send}">➤</button>
    </div>`;
  }

  function commentHtml(c, postId, isReply) {
    const mod = S.me?.is_moderator;
    const a = c.author || {};
    const av = avHtml(a);
    const body = (c.content || '').startsWith('[gif]')
      ? `<img class="cbt-cgif" src="${esc(c.content.slice(5))}" loading="lazy" alt="GIF">`
      : esc(c.content);
    return `<div class="cbt-c${isReply ? ' cbt-creply' : ''}${c.pinned ? ' cbt-cpinned' : ''}">${av}<div class="cbt-cbody">
      <div class="cbt-cname">${esc(a.name)}${a.mod ? '<span class="cbt-modbadge">★ MOD</span>' : ''}${c.pinned ? '<span class="cbt-pinbadge">📌 fixado</span>' : ''}<span class="cbt-ptime">${timeAgo(c.created_at)}</span></div>
      <div class="cbt-ctext">${body}</div>
      <div class="cbt-cact">
        <button class="cbt-cbtn${c.liked ? ' liked' : ''}" id="cl-${c.id}" onclick="ComunidadeBT.likeComment('${c.id}')">${c.liked ? '❤️' : '🤍'} <span>${c.likes_count || 0}</span></button>
        ${!isReply ? `<button class="cbt-cbtn" onclick="ComunidadeBT.toggleReply('${c.id}')">↩ Responder</button>` : ''}
        ${(mod && !isReply) ? `<button class="cbt-cbtn" onclick="ComunidadeBT.pinComment('${postId}','${c.id}')">📌 ${c.pinned ? 'Desafixar' : 'Fixar'}</button>` : ''}
        ${(c.mine || mod) ? `<button class="cbt-cbtn danger" onclick="ComunidadeBT.delComment('${postId}','${c.id}')">apagar</button>` : ''}
      </div>
      ${!isReply ? `<div class="cbt-replybox" id="rb-${c.id}" style="display:none">${cinputHtml('ri-' + c.id, postId, c.id)}</div>` : ''}
    </div></div>`;
  }

  function renderComments(postId, list) {
    const box = $('cb-' + postId); if (!box) return;
    S.commentsCache = S.commentsCache || {}; S.commentsCache[postId] = list;
    // Fixados primeiro, depois mais curtidos, depois mais antigos
    const tops = list.filter((c) => !c.parent_id).sort((x, y) => (y.pinned - x.pinned) || ((y.likes_count || 0) - (x.likes_count || 0)) || (new Date(x.created_at) - new Date(y.created_at)));
    const replies = {};
    list.filter((c) => c.parent_id).sort((x, y) => new Date(x.created_at) - new Date(y.created_at)).forEach((c) => { (replies[c.parent_id] = replies[c.parent_id] || []).push(c); });
    const items = tops.map((c) => commentHtml(c, postId, false) + (replies[c.id] || []).map((r) => commentHtml(r, postId, true)).join('')).join('');
    box.innerHTML = `${items || ''}${cinputHtml('ci-' + postId, postId)}`;
  }

  async function sendComment(postId, parentId) {
    if (await needProfile()) return;
    const inp = parentId ? $('ri-' + parentId) : $('ci-' + postId);
    const text = (inp?.value || '').trim();
    if (!text) return;
    inp.value = '';
    const { ok, d } = await api('comment-create', { body: { post_id: postId, content: text, parent_id: parentId || undefined } });
    if (!ok) { inp.value = text; return toast('❌ ' + (d.error || 'Erro.')); }
    const cc = $('cc-' + postId); if (cc) cc.textContent = (parseInt(cc.textContent) || 0) + 1;
    const post = S.posts.find((p) => p.id === postId); if (post) post.comments_count++;
    const { ok: ok2, d: d2 } = await api('comments', { qs: '&post_id=' + encodeURIComponent(postId) });
    if (ok2) renderComments(postId, d2.comments);
  }

  async function likeComment(cid) {
    if (await needProfile()) return;
    // Otimista no DOM (sem re-render pra não reordenar enquanto a pessoa lê)
    const el = $('cl-' + cid); if (!el) return;
    const wasLiked = el.classList.contains('liked');
    const n = (parseInt(el.querySelector('span')?.textContent) || 0) + (wasLiked ? -1 : 1);
    el.classList.toggle('liked', !wasLiked);
    el.innerHTML = `${!wasLiked ? '❤️' : '🤍'} <span>${Math.max(0, n)}</span>`;
    const { ok, d } = await api('comment-like-toggle', { body: { comment_id: cid } });
    if (ok && typeof d.likes_count === 'number') { el.classList.toggle('liked', d.liked); el.innerHTML = `${d.liked ? '❤️' : '🤍'} <span>${d.likes_count}</span>`; }
  }

  function toggleReply(cid) {
    const rb = $('rb-' + cid); if (!rb) return;
    rb.style.display = rb.style.display === 'none' ? 'block' : 'none';
    if (rb.style.display === 'block') $('ri-' + cid)?.focus();
  }

  async function pinComment(postId, cid) {
    const { ok, d } = await api('comment-pin-toggle', { body: { comment_id: cid } });
    if (!ok) return toast('❌ ' + (d.error || 'Erro.'));
    toast(d.pinned ? '📌 Comentário fixado no topo.' : 'Comentário desafixado.');
    const { ok: ok2, d: d2 } = await api('comments', { qs: '&post_id=' + encodeURIComponent(postId) });
    if (ok2) renderComments(postId, d2.comments);
  }

  async function delComment(postId, commentId) {
    if (!confirm('Apagar comentário?')) return;
    const { ok, d } = await api('comment-delete', { body: { comment_id: commentId } });
    if (!ok) return toast('❌ ' + (d.error || 'Erro.'));
    const cc = $('cc-' + postId); if (cc) cc.textContent = Math.max(0, (parseInt(cc.textContent) || 1) - 1);
    const { ok: ok2, d: d2 } = await api('comments', { qs: '&post_id=' + encodeURIComponent(postId) });
    if (ok2) renderComments(postId, d2.comments);
  }

  // ── Mídia ─────────────────────────────────────────────────────────────────
  let pickKind = 'image';
  function pick(kind) {
    if (S.media.length >= 4) return toast('Máximo de 4 mídias por post.');
    if (kind !== 'image' && S.media.some((m) => m.type !== 'image')) return toast('Só 1 vídeo ou áudio por post.');
    pickKind = kind;
    const f = $('cbtMediaFile');
    f.accept = kind === 'image' ? 'image/jpeg,image/png,image/webp,image/gif' : kind === 'video' ? 'video/mp4,video/quicktime,video/webm' : 'audio/*';
    f.value = ''; f.click();
  }

  async function onMediaPick(e) {
    const file = e.target.files?.[0]; if (!file) return;
    if (await needProfile()) return;
    const kind = pickKind;
    const item = { type: kind, file, uploading: true, pct: 0, url: null, thumb: null, preview: kind === 'image' ? URL.createObjectURL(file) : null };
    S.media.push(item); renderChips();

    const { ok, d } = await api('get-upload-url', { body: { kind, content_type: file.type, filename: file.name } });
    if (!ok) { S.media = S.media.filter((m) => m !== item); renderChips(); return toast('❌ ' + (d.error || 'Erro no upload.')); }
    if (file.size > d.max_mb * 1024 * 1024) { S.media = S.media.filter((m) => m !== item); renderChips(); return toast(`❌ Arquivo grande demais (máx ${d.max_mb}MB).`); }

    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) { item.pct = Math.round((ev.loaded / ev.total) * 100); renderChips(); } };
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error('HTTP ' + xhr.status)));
        xhr.onerror = () => reject(new Error('Falha de rede'));
        xhr.open('POST', d.supabase_url + '/storage/v1/object/blue-videos/' + d.storage_path);
        xhr.setRequestHeader('apikey', d.anon_key);
        xhr.setRequestHeader('Authorization', 'Bearer ' + token());
        xhr.setRequestHeader('Content-Type', file.type);
        xhr.setRequestHeader('x-upsert', 'true');
        xhr.send(file);
      });
      item.url = d.public_url;
      if (kind === 'video') {
        const t = await api('transcode', { body: { storage_path: d.storage_path } });
        if (t.ok && t.d.thumb_url) item.thumb = t.d.thumb_url;
      }
    } catch (err) {
      S.media = S.media.filter((m) => m !== item); renderChips();
      return toast('❌ Upload falhou: ' + err.message);
    }
    item.uploading = false; item.pct = 100; renderChips();
  }

  function renderChips() {
    const el = $('cbtChips'); if (!el) return;
    el.innerHTML = S.media.map((m, i) => `<div class="cbt-chip">
      ${m.preview ? `<img src="${m.preview}">` : (m.type === 'video' ? '🎬' : m.type === 'audio' ? '🎤' : '🖼️')}
      <button class="rm" onclick="ComunidadeBT.rmMedia(${i})">✕</button>
      ${m.uploading ? `<div class="pct"><i style="width:${m.pct}%"></i></div>` : ''}
    </div>`).join('');
  }
  function rmMedia(i) { S.media.splice(i, 1); renderChips(); }

  // ── Emojis e GIFs nos comentários ─────────────────────────────────────────
  const EMOJIS = ['😀','😂','🤣','😊','😍','😎','🥳','🤯','😅','😢','😡','🤔','👀','🙏','💪','👏','🙌','🤝','👍','👎','❤️','💙','🔥','⭐','✨','⚡','👑','🚀','🎯','🎉','💰','📈','🏆','✅','❌','💡','🎬','📌','🧠','💥'];
  let floatTarget = null; // input alvo do painel aberto

  function hideFloats() { $('cbtEmojiPanel')?.classList.remove('on'); $('cbtGifPanel')?.classList.remove('on'); }

  function placeFloat(panel, anchorBtn) {
    const r = anchorBtn.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(window.innerWidth - 328, r.left - 150)) + 'px';
    const top = r.top - panel.offsetHeight - 8;
    panel.style.top = (top > 8 ? top : r.bottom + 8) + 'px';
  }

  function openEmoji(btn, inputId) {
    hideFloats();
    floatTarget = inputId;
    const p = $('cbtEmojiPanel');
    if (!p.innerHTML) p.innerHTML = EMOJIS.map((e2) => `<button class="cbt-emj" onclick="ComunidadeBT.addEmoji('${e2}')">${e2}</button>`).join('');
    p.classList.add('on');
    placeFloat(p, btn);
  }

  function addEmoji(e2) {
    const inp = $(floatTarget); if (!inp) return;
    inp.value += e2; inp.focus();
  }

  async function openGif(btn, postId, parentId) {
    hideFloats();
    const p = $('cbtGifPanel');
    p.dataset.post = postId; p.dataset.parent = parentId || '';
    p.innerHTML = `<div class="cbt-gifhead"><input id="cbtGifQ" placeholder="Buscar GIF…" onkeydown="if(event.key==='Enter')ComunidadeBT.searchGif()"><button onclick="ComunidadeBT.searchGif()">🔎</button></div><div class="cbt-gifgrid" id="cbtGifGrid"><div class="cbt-empty" style="padding:14px">Carregando…</div></div>`;
    p.classList.add('on');
    placeFloat(p, btn);
    await searchGif();
    $('cbtGifQ')?.focus();
  }

  async function searchGif() {
    const grid = $('cbtGifGrid'); if (!grid) return;
    const qv = ($('cbtGifQ')?.value || '').trim();
    const { ok, d } = await api('gif-search', { qs: '&q=' + encodeURIComponent(qv) });
    if (!ok || d.disabled || !d.gifs?.length) { grid.innerHTML = '<div class="cbt-empty" style="padding:14px">Nenhum GIF encontrado.</div>'; return; }
    grid.innerHTML = d.gifs.map((g) => `<img src="${esc(g.preview)}" loading="lazy" onclick="ComunidadeBT.sendGif('${esc(g.url)}')">`).join('');
  }

  async function sendGif(url) {
    const p = $('cbtGifPanel');
    const postId = p.dataset.post, parentId = p.dataset.parent || undefined;
    hideFloats();
    const { ok, d } = await api('comment-create', { body: { post_id: postId, content: '[gif]' + url, parent_id: parentId } });
    if (!ok) return toast('❌ ' + (d.error || 'Erro ao enviar GIF.'));
    const cc = $('cc-' + postId); if (cc) cc.textContent = (parseInt(cc.textContent) || 0) + 1;
    const { ok: ok2, d: d2 } = await api('comments', { qs: '&post_id=' + encodeURIComponent(postId) });
    if (ok2) renderComments(postId, d2.comments);
  }

  // ── API pública ───────────────────────────────────────────────────────────
  window.ComunidadeBT = {
    open, close, setTab, publish, like, delPost, editPost, pin, ban, toggleComposer,
    comments, sendComment, delComment, likeComment, toggleReply, pinComment,
    openEmoji, addEmoji, openGif, searchGif, sendGif,
    pick, rmMedia,
    more: () => loadFeed(false),
    // Superfície usada pelo comunidade-amigos.js (arquivo dedicado):
    // `call` reusa o mesmo fetch autenticado, `me` é o portão Full/Master já
    // resolvido pelo backend, `toast`/`esc` evitam duplicar utilitário.
    call: (action, opts) => api(action, opts),
    me: () => S.me,
    toast,
    esc,
    refresh: () => loadFeed(true),
    light: (u) => { $('cbtLightImg').src = u; $('cbtLight').classList.add('on'); },
    whats: () => { try { window.joinCommunity ? joinCommunity() : window.open(WHATSAPP_URL, '_blank'); } catch (e) { window.open(WHATSAPP_URL, '_blank'); } },
  };
})();
