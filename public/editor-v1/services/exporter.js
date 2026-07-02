// editor-v1/services/exporter.js
// Export: save fresh -> edit-v0 -> polling status-v0 -> done/erro/cancel.

import { api } from './api.js';
import { canExport } from '../core/selectors.js';

const POLL_MS = 1500;

export function createExporter(store) {
  let polling = 0;
  let active = false;

  async function start({ onProgress, onDone, onError }) {
    const state = store.getState();
    if (!canExport(state)) { onError?.('Adicione um vídeo com pelo menos 0,5s de duração.'); return; }
    if (active) return;
    active = true;
    try {
      // garante project_id + estado fresco no backend
      const saved = await api.saveProject(state.project_id, state, state.nome_projeto, state.video?.url || null);
      const projectId = saved.project_id || state.project_id;
      if (!projectId) throw new Error('Não consegui salvar o projeto antes do export');

      const r = await api.exportV0(projectId, store.getState());
      if (!r.ok) throw new Error(r.error || 'Falha ao iniciar export');
      onProgress?.(2, 'Na fila…');

      polling = setInterval(async () => {
        try {
          const s = await api.statusV0(projectId);
          if (s.status === 'done' && s.output_url) {
            stop();
            onDone?.(s.output_url);
          } else if (s.status === 'error') {
            stop();
            onError?.(s.erro || 'Erro no processamento');
          } else {
            onProgress?.(Math.max(2, s.progresso || 0), labelFor(s.progresso));
          }
        } catch (e) {
          // erro transitorio de polling: segue tentando
          console.warn('[export] poll:', e.message);
        }
      }, POLL_MS);
    } catch (e) {
      active = false;
      onError?.(e.message);
    }
  }

  async function cancel() {
    const state = store.getState();
    stop();
    if (state.project_id) {
      try { await api.cancelV0(state.project_id); } catch {}
    }
  }

  function stop() {
    clearInterval(polling);
    polling = 0;
    active = false;
  }

  function labelFor(p) {
    if (p < 15) return 'Baixando vídeo…';
    if (p < 40) return 'Cortando clipes…';
    if (p < 55) return 'Unindo cenas…';
    if (p < 70) return 'Processando áudio…';
    if (p < 92) return 'Renderizando (1080×1920)…';
    return 'Enviando resultado…';
  }

  return { start, cancel, isActive: () => active, destroy: stop };
}
