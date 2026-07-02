// editor-v1/main.js
// Bootstrap: flag -> gate auth/plano -> restaura projeto -> mount.

import { createStore } from './core/store.js';
import { normalizeLoadedState } from './core/schema.js';
import { bootstrapGate, api, getToken } from './services/api.js';
import { readSessionFallback } from './services/autosave.js';
import { mountEditor } from './ui/shell.js';

const root = document.getElementById('beRoot');

function gateScreen(icon, title, msg, ctaHtml = '') {
  root.innerHTML = `
    <div class="be-gate">
      <div class="be-gate-icon">${icon}</div>
      <div class="be-gate-title">${title}</div>
      <div class="be-gate-msg">${msg}</div>
      ${ctaHtml}
    </div>`;
}

async function boot() {
  gateScreen('⏳', 'Carregando BlueEditor…', 'Um instante.');

  const { flag, user } = await bootstrapGate();

  if (!flag?.enabled) {
    gateScreen('🚧', 'Em construção', 'O BlueEditor está recebendo os últimos ajustes. Volta em breve!',
      '<a class="be-export-btn" href="/">Voltar pro início</a>');
    return;
  }
  if (!getToken() || !user) {
    gateScreen('🔒', 'Login necessário', 'Entre na sua conta BlueTube pra usar o editor.',
      '<a class="be-export-btn" href="/?login=1&next=/blueEditor-app">Fazer login</a>');
    return;
  }
  const plan = (user.plan || 'free').toLowerCase();
  if (plan !== 'master' && plan !== 'full') {
    gateScreen('👑', 'Exclusivo Full e Master', 'O BlueEditor faz parte dos planos Full e Master.',
      '<a class="be-export-btn" href="/#planos">Ver planos</a>');
    return;
  }

  // estado inicial: backend > sessionStorage > vazio
  const store = createStore();
  let restored = false;
  try {
    const { project } = await api.loadProject(null);
    if (project?.project_state) {
      store.replaceState(normalizeLoadedState({ ...project.project_state, project_id: project.id }));
      restored = true;
    }
  } catch { /* segue */ }
  if (!restored) {
    const ss = readSessionFallback();
    if (ss?.video) store.replaceState(normalizeLoadedState(ss));
  }

  root.innerHTML = '';
  mountEditor(root, store);
}

boot().catch(e => {
  console.error('[main] boot falhou:', e);
  gateScreen('⚠️', 'Erro ao carregar', e.message || 'Tenta recarregar a página.',
    '<button class="be-export-btn" onclick="location.reload()">Recarregar</button>');
});
