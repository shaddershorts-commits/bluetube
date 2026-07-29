// editor-v1/services/api.js
// Cliente da API /api/blue-editor (actions do backend v0 — contrato estavel).

const API = '/api/blue-editor';

export function getToken() {
  try { return localStorage.getItem('bt_token') || null; } catch { return null; }
}

// ── SESSÃO QUE VENCE COM O EDITOR ABERTO (fix 2026-07-29) ──────────────────
// Editar vídeo é sessão longa: o access_token vencia no meio do trabalho e
// TUDO passava a dar 401 — importar arquivo, salvar, reabrir projeto. No
// console aparecia só "401 (Unauthorized)" e, ao voltar pro projeto, ele
// abria vazio, como se os dados tivessem sumido.
//
// Agora o 401 dispara UMA renovação pelo refresh_token (mesmo endpoint que o
// toolbar do site usa) e refaz a chamada. Se a renovação também falhar, aí sim
// a sessão morreu de verdade — e quem chamou recebe um erro com
// `sessaoExpirada` pra avisar o usuário em vez de falhar calado.
let renovando = null;

async function renovarSessao() {
  if (renovando) return renovando;           // chamadas simultâneas esperam a mesma
  renovando = (async () => {
    let rt = null;
    try { rt = localStorage.getItem('bt_refresh_token'); } catch {}
    if (!rt) return null;
    try {
      const r = await fetch('/api/session-refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.session?.access_token) return null;
      try {
        localStorage.setItem('bt_token', d.session.access_token);
        // o Supabase ROTACIONA o refresh_token — guardar o novo é obrigatório
        if (d.session.refresh_token) localStorage.setItem('bt_refresh_token', d.session.refresh_token);
      } catch {}
      return d.session.access_token;
    } catch { return null; }
  })().finally(() => { renovando = null; });
  return renovando;
}

async function chamar(body, token) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, token }),
  });
  const data = await r.json().catch(() => ({}));
  return { r, data };
}

async function post(body) {
  let token = getToken();
  let { r, data } = await chamar(body, token);

  if (r.status === 401) {
    const novo = await renovarSessao();
    if (novo) ({ r, data } = await chamar(body, novo));
  }

  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.data = data;
    if (r.status === 401) {
      err.sessaoExpirada = true;
      err.message = 'Sua sessão expirou. Entre de novo pra continuar editando.';
    }
    throw err;
  }
  return data;
}

export const api = {
  getUploadUrl: (ext) => post({ action: 'upload-url', ext }),
  saveProject: (project_id, project_state, nome_projeto, video_url) =>
    post({ action: 'save-project', project_id, project_state, nome_projeto, video_url }),
  loadProject: (project_id) => post({ action: 'load-project', project_id }),
  listProjects: () => post({ action: 'list-projects' }),
  deleteProject: (project_id) => post({ action: 'delete-project', project_id }),
  renameProject: (project_id, nome_projeto) => post({ action: 'rename-project', project_id, nome_projeto }),
  exportV0: (project_id, project_state) => post({ action: 'edit-v0', project_id, project_state }),
  autoCaptions: (video_url) => post({ action: 'auto-captions', video_url }),
  // biblioteca de audio (Musicas/Efeitos) — proxy pro provedor no backend
  audioSearch: (query, kind) => post({ action: 'audio-search', query, kind }),
  statusV0: (project_id) => post({ action: 'status-v0', project_id }),
  cancelV0: (project_id) => post({ action: 'cancel-v0', project_id }),
};

/** Flag + auth gate. Retorna { flag, user } — user null se nao logado.
 *  user = { plan: 'free'|'full'|'master', email } via /api/get-plan (POST token). */
export async function bootstrapGate() {
  const flagR = await fetch('/api/editor-flag').then(r => r.json()).catch(() => ({ enabled: false, reason: 'flag_fetch_failed' }));
  let user = null;
  const token = getToken();
  if (token) {
    try {
      const r = await fetch('/api/get-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (r.ok) user = await r.json();
    } catch {}
  }
  return { flag: flagR, user };
}
