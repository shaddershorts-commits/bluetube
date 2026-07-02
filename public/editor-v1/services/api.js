// editor-v1/services/api.js
// Cliente da API /api/blue-editor (actions do backend v0 — contrato estavel).

const API = '/api/blue-editor';

export function getToken() {
  try { return localStorage.getItem('bt_token') || null; } catch { return null; }
}

async function post(body) {
  const token = getToken();
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, token }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.data = data;
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
  exportV0: (project_id, project_state) => post({ action: 'edit-v0', project_id, project_state }),
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
