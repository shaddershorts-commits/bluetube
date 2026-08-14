// editor-v1/core/actions.js
// Action creators. Toda mutacao do documento passa por aqui -> reducers.js.
// Actions com `undoable: true` entram no undo stack (1 action = 1 undo step).

export const A = {
  // documento
  LOAD_PROJECT: 'LOAD_PROJECT',
  SET_VIDEO: 'SET_VIDEO',
  RENAME_PROJECT: 'RENAME_PROJECT',
  // clips
  SPLIT_CLIP: 'SPLIT_CLIP',
  TRIM_CLIP: 'TRIM_CLIP',
  MOVE_CLIP: 'MOVE_CLIP',
  DELETE_CLIP: 'DELETE_CLIP',
  TOGGLE_CLIP: 'TOGGLE_CLIP',
  SELECT_CLIP: 'SELECT_CLIP',
  CLEAR_SELECTION: 'CLEAR_SELECTION',
  DELETE_RANGE_LEFT: 'DELETE_RANGE_LEFT',
  DELETE_RANGE_RIGHT: 'DELETE_RANGE_RIGHT',
  // textos
  ADD_TEXT: 'ADD_TEXT',
  UPDATE_TEXT: 'UPDATE_TEXT',
  MOVE_TEXT: 'MOVE_TEXT',
  DELETE_TEXT: 'DELETE_TEXT',
  SPLIT_TEXT: 'SPLIT_TEXT',
  SELECT_TEXT: 'SELECT_TEXT',
  // audio (clips editaveis)
  ADD_AUDIO_CLIP: 'ADD_AUDIO_CLIP',
  DETACH_AUDIO: 'DETACH_AUDIO',
  SPLIT_AUDIO: 'SPLIT_AUDIO',
  TRIM_AUDIO: 'TRIM_AUDIO',
  MOVE_AUDIO: 'MOVE_AUDIO',
  DELETE_AUDIO_CLIP: 'DELETE_AUDIO_CLIP',
  SET_AUDIO_VOLUME: 'SET_AUDIO_VOLUME',
  SELECT_AUDIO_CLIP: 'SELECT_AUDIO_CLIP',
  // Aprimorar áudio (2026-07-29): reduzir ruído / aprimorar voz / normalizar
  SET_AUDIO_FX: 'SET_AUDIO_FX',
  // camadas (overlays)
  CONVERT_TO_OVERLAY: 'CONVERT_TO_OVERLAY',
  SET_ITEM_LANE: 'SET_ITEM_LANE',
  // fluidez de camadas (2026-07-22): lane manual de áudio, camada extra vazia
  // (botão direito no vazio), olhinho por lane, camada de vídeo -> principal
  SET_AUDIO_LANE: 'SET_AUDIO_LANE',
  ADD_EXTRA_LANE: 'ADD_EXTRA_LANE',
  TOGGLE_LANE_VIS: 'TOGGLE_LANE_VIS',
  // arrastar o cabecalho/olhinho da camada reordena as camadas (2026-07-29)
  REORDER_LANES: 'REORDER_LANES',
  // arrasto diagonal: tempo E camada num dispatch so (ver reducer)
  MOVE_ITEM_TO: 'MOVE_ITEM_TO',
  // Cortar respiros: remove os trechos sem fala e junta o resto (1 undo)
  CUT_SILENCE: 'CUT_SILENCE',
  OVERLAY_TO_CLIP: 'OVERLAY_TO_CLIP',
  TRIM_OVERLAY: 'TRIM_OVERLAY',
  SPLIT_OVERLAY: 'SPLIT_OVERLAY',
  MOVE_OVERLAY: 'MOVE_OVERLAY',
  SET_OVERLAY_TRANSFORM: 'SET_OVERLAY_TRANSFORM',
  TOGGLE_OVERLAY_MUTED: 'TOGGLE_OVERLAY_MUTED',
  DELETE_OVERLAY: 'DELETE_OVERLAY',
  SELECT_OVERLAY: 'SELECT_OVERLAY',
  SET_VOLUME: 'SET_VOLUME',
  SET_TRANSITION: 'SET_TRANSITION',
  SET_ASPECT: 'SET_ASPECT',
  SET_FORMATO: 'SET_FORMATO',
  SET_CLIP_ANIM: 'SET_CLIP_ANIM',
  // compostos (CapCut Alt+G)
  TOGGLE_MULTI_SELECT: 'TOGGLE_MULTI_SELECT',
  SELECT_ALL: 'SELECT_ALL',
  SET_MULTI_SELECT: 'SET_MULTI_SELECT',
  DELETE_MULTI: 'DELETE_MULTI',
  MOVE_MULTI: 'MOVE_MULTI',
  SET_CAPTIONS: 'SET_CAPTIONS',
  CREATE_COMPOUND: 'CREATE_COMPOUND',
  UNGROUP_COMPOUND: 'UNGROUP_COMPOUND',
  UPDATE_COMPOUND: 'UPDATE_COMPOUND',
  // multi-midia (takes)
  ADD_MEDIA_CLIP: 'ADD_MEDIA_CLIP',
  // remove um take da biblioteca (pool) + todos os clips que o usam
  REMOVE_MEDIA: 'REMOVE_MEDIA',
  REMOVE_PRIMARY: 'REMOVE_PRIMARY',
  // imagem (PNG/sticker com transparência) como camada sobre o vídeo
  ADD_IMAGE_OVERLAY: 'ADD_IMAGE_OVERLAY',
  // transform da cena (aba Vídeo > Básico: escala + opacidade)
  SET_CLIP_TRANSFORM: 'SET_CLIP_TRANSFORM',
  SET_CLIP_GRADE: 'SET_CLIP_GRADE',
  // velocidade da faixa selecionada (aba Velocidade) — clip OU audio
  SET_SPEED: 'SET_SPEED',
  // copiar/colar faixa (Ctrl+C/X/V)
  PASTE: 'PASTE',
  // editar (menu botao direito): congelar frame / reverso / espelhar
  FREEZE_FRAME: 'FREEZE_FRAME',
  SET_CLIP_FX: 'SET_CLIP_FX',
  SET_CLIP_MASK: 'SET_CLIP_MASK',
  SET_FREEZE_DUR: 'SET_FREEZE_DUR',
  // meta
  SET_PROJECT_ID: 'SET_PROJECT_ID',
};

const U = true; // atalho legivel

/** type -> undoable? Transporte/selecao NAO entram no undo. */
export const UNDOABLE = {
  [A.SET_VIDEO]: U,
  [A.RENAME_PROJECT]: U,
  [A.SPLIT_CLIP]: U,
  [A.TRIM_CLIP]: U,
  [A.MOVE_CLIP]: U,
  [A.DELETE_CLIP]: U,
  [A.TOGGLE_CLIP]: U,
  [A.DELETE_RANGE_LEFT]: U,
  [A.DELETE_RANGE_RIGHT]: U,
  [A.ADD_TEXT]: U,
  [A.UPDATE_TEXT]: U,
  [A.MOVE_TEXT]: U,
  [A.DELETE_TEXT]: U,
  [A.SPLIT_TEXT]: U,
  [A.ADD_AUDIO_CLIP]: U,
  [A.DETACH_AUDIO]: U,
  [A.SPLIT_AUDIO]: U,
  [A.TRIM_AUDIO]: U,
  [A.MOVE_AUDIO]: U,
  [A.DELETE_AUDIO_CLIP]: U,
  [A.SET_AUDIO_VOLUME]: U,
  [A.SET_AUDIO_FX]: U,
  [A.CONVERT_TO_OVERLAY]: U,
  [A.TRIM_OVERLAY]: U,
  [A.SPLIT_OVERLAY]: U,
  [A.MOVE_OVERLAY]: U,
  [A.SET_OVERLAY_TRANSFORM]: U,
  [A.TOGGLE_OVERLAY_MUTED]: U,
  [A.SET_ITEM_LANE]: U,
  [A.SET_AUDIO_LANE]: U,
  [A.ADD_EXTRA_LANE]: U,
  [A.TOGGLE_LANE_VIS]: U,
  [A.REORDER_LANES]: U,
  [A.MOVE_ITEM_TO]: U,
  [A.CUT_SILENCE]: U,
  [A.OVERLAY_TO_CLIP]: U,
  [A.DELETE_OVERLAY]: U,
  [A.SET_VOLUME]: U,
  [A.SET_TRANSITION]: U,
  [A.SET_ASPECT]: U,
  [A.SET_FORMATO]: U,
  [A.SET_CLIP_ANIM]: U,
  [A.CREATE_COMPOUND]: U,
  [A.UNGROUP_COMPOUND]: U,
  [A.UPDATE_COMPOUND]: U,
  [A.DELETE_MULTI]: U, // apaga a multi-selecao inteira = 1 undo step
  [A.MOVE_MULTI]: U,   // arrasta a multi-selecao inteira junto
  [A.SET_CAPTIONS]: U, // geracao de legendas inteira = 1 undo step
  [A.ADD_MEDIA_CLIP]: U,
  [A.REMOVE_MEDIA]: U,
  [A.REMOVE_PRIMARY]: U,
  [A.ADD_IMAGE_OVERLAY]: U,
  [A.SET_CLIP_TRANSFORM]: U,
  [A.SET_CLIP_GRADE]: U,
  [A.SET_SPEED]: U,
  [A.PASTE]: U,
  [A.FREEZE_FRAME]: U,
  [A.SET_CLIP_FX]: U,
  [A.SET_CLIP_MASK]: U,
  [A.SET_FREEZE_DUR]: U,
};

// ── creators ────────────────────────────────────────────────────────────────
export const loadProject = (project) => ({ type: A.LOAD_PROJECT, project });
export const setVideo = (video) => ({ type: A.SET_VIDEO, video });
export const renameProject = (nome) => ({ type: A.RENAME_PROJECT, nome });

export const splitClipAt = (t) => ({ type: A.SPLIT_CLIP, t });
export const trimClip = (clipId, edge, sourceTime) => ({ type: A.TRIM_CLIP, clipId, edge, sourceTime });
export const moveClip = (clipId, toIndex) => ({ type: A.MOVE_CLIP, clipId, toIndex });
export const deleteClip = (clipId) => ({ type: A.DELETE_CLIP, clipId });
export const toggleClip = (clipId) => ({ type: A.TOGGLE_CLIP, clipId });
export const selectClip = (clipId) => ({ type: A.SELECT_CLIP, clipId });
export const clearSelection = () => ({ type: A.CLEAR_SELECTION });
export const deleteRangeLeft = (t) => ({ type: A.DELETE_RANGE_LEFT, t });
export const deleteRangeRight = (t) => ({ type: A.DELETE_RANGE_RIGHT, t });

export const addText = (props) => ({ type: A.ADD_TEXT, props });
export const updateText = (textId, patch) => ({ type: A.UPDATE_TEXT, textId, patch });
export const moveText = (textId, x_pct, y_pct) => ({ type: A.MOVE_TEXT, textId, x_pct, y_pct });
export const deleteText = (textId) => ({ type: A.DELETE_TEXT, textId });
export const splitTextAt = (textId, t) => ({ type: A.SPLIT_TEXT, textId, t });
export const selectText = (textId) => ({ type: A.SELECT_TEXT, textId });

export const addAudioClip = (media) => ({ type: A.ADD_AUDIO_CLIP, media });
export const detachAudio = () => ({ type: A.DETACH_AUDIO });
export const splitAudioAt = (t) => ({ type: A.SPLIT_AUDIO, t });
export const trimAudio = (audioId, edge, value) => ({ type: A.TRIM_AUDIO, audioId, edge, value });
export const moveAudio = (audioId, start) => ({ type: A.MOVE_AUDIO, audioId, start });
export const deleteAudioClip = (audioId) => ({ type: A.DELETE_AUDIO_CLIP, audioId });
export const setAudioVolume = (audioId, value) => ({ type: A.SET_AUDIO_VOLUME, audioId, value });
// Aprimorar áudio. `alvo` diz ONDE o áudio mora:
//   'audio' = clipe de áudio solto · 'clip' = cena de vídeo (áudio embutido)
//             ou clipe COMPOSTO (cascateia pro áudio de dentro)
// patch = { fx_ruido?, fx_voz?, fx_voz_int?, fx_norm? }
export const setAudioFx = (alvo, id, patch) => ({ type: A.SET_AUDIO_FX, alvo, id, patch });
export const selectAudioClip = (audioId) => ({ type: A.SELECT_AUDIO_CLIP, audioId });
export const convertToOverlay = (clipId, atT, lane) => ({ type: A.CONVERT_TO_OVERLAY, clipId, atT, lane });
// muda a camada (z) de um overlay/texto — arrasto vertical na timeline
export const setItemLane = (itemType, id, lane) => ({ type: A.SET_ITEM_LANE, itemType, id, lane });
export const setAudioLane = (audioId, lane) => ({ type: A.SET_AUDIO_LANE, audioId, lane });
export const addExtraLane = (kind) => ({ type: A.ADD_EXTRA_LANE, kind }); // 'video' | 'audio'
export const toggleLaneVisibility = (kind, lane) => ({ type: A.TOGGLE_LANE_VIS, kind, lane }); // 'overlay' | 'audio'
// arrasto do cabecalho: leva a camada `de` pra posicao da camada `para`
export const reorderLanes = (kind, de, para) => ({ type: A.REORDER_LANES, kind, de, para });
// fim do arrasto de camada/texto: grava TEMPO e CAMADA juntos. Separado (mover
// + trocar de camada) o repelir olhava a camada que o item estava DEIXANDO e
// jogava o item pra um tempo errado. laneAlvo null = mantem a camada atual.
export const moveItemTo = (itemType, id, start, laneAlvo) => ({ type: A.MOVE_ITEM_TO, itemType, id, start, laneAlvo });
// CORTAR RESPIROS. alvo: 'clip' (cena de vídeo — o vídeo acompanha o corte) ou
// 'audio'. falas = [{in,out}] em segundos DA FONTE, vindas de core/silencio.js.
// UM dispatch = UM undo: N respiros não podem virar N passos de Ctrl+Z.
export const cutSilence = (alvo, id, falas) => ({ type: A.CUT_SILENCE, alvo, id, falas });
export const overlayToClip = (overlayId, atT) => ({ type: A.OVERLAY_TO_CLIP, overlayId, atT });
export const trimOverlay = (overlayId, edge, value) => ({ type: A.TRIM_OVERLAY, overlayId, edge, value });
export const toggleOverlayMuted = (overlayId) => ({ type: A.TOGGLE_OVERLAY_MUTED, overlayId });
export const splitOverlayAt = (t) => ({ type: A.SPLIT_OVERLAY, t });
export const moveOverlay = (overlayId, start) => ({ type: A.MOVE_OVERLAY, overlayId, start });
export const setOverlayTransform = (overlayId, patch) => ({ type: A.SET_OVERLAY_TRANSFORM, overlayId, patch });
export const deleteOverlay = (overlayId) => ({ type: A.DELETE_OVERLAY, overlayId });
export const selectOverlay = (overlayId) => ({ type: A.SELECT_OVERLAY, overlayId });
export const setVolume = (track, value) => ({ type: A.SET_VOLUME, track, value });
// ttype = id do catalogo (core/transitions.js) ou null/cut pra remover
export const setTransition = (between, ttype, duration, intensity) => ({ type: A.SET_TRANSITION, between, ttype, duration, intensity });
export const setAspect = (strategy) => ({ type: A.SET_ASPECT, strategy });
export const setFormato = (formato) => ({ type: A.SET_FORMATO, formato });
// slot: 'in' | 'out' | 'loop'; animId null = remover
export const setClipAnim = (clipId, slot, animId) => ({ type: A.SET_CLIP_ANIM, clipId, slot, animId });
export const setProjectId = (id) => ({ type: A.SET_PROJECT_ID, id });
export const toggleMultiSelect = (itemType, id) => ({ type: A.TOGGLE_MULTI_SELECT, itemType, id });
export const selectAll = () => ({ type: A.SELECT_ALL });
// marquee (arrastar no vazio) define a multi-selecao inteira de uma vez
export const setMultiSelect = (items) => ({ type: A.SET_MULTI_SELECT, items });
// Delete com multi-selecao ativa: apaga tudo que esta selecionado
export const deleteMulti = () => ({ type: A.DELETE_MULTI });
// arrasta TODAS as faixas selecionadas juntas por delta segundos
export const moveMulti = (delta) => ({ type: A.MOVE_MULTI, delta });
// caps: [{content,start_sec,end_sec,font,size,color,y_pct,...}] — substitui
// TODAS as legendas num unico dispatch (nao rouba selecao, 1 undo)
export const setCaptions = (caps) => ({ type: A.SET_CAPTIONS, caps });
// media: { url, path, filename, duration, width, height } — vira take no FIM
// da track principal SEM resetar o projeto (multi-midia 2026-07-20)
export const addMediaClip = (media) => ({ type: A.ADD_MEDIA_CLIP, media });
// reusa uma midia JA no pool (painel Midia: "+ adicionar de novo")
export const addClipFromMedia = (mediaId) => ({ type: A.ADD_MEDIA_CLIP, mediaId });
export const removeMedia = (mediaId) => ({ type: A.REMOVE_MEDIA, mediaId });
// exclui o video principal; promove o 1o take a principal se houver
export const removePrimary = () => ({ type: A.REMOVE_PRIMARY });
// imagem (PNG com transparência) vira camada no playhead. media = {url, width, height}
export const addImageOverlay = (media, atT) => ({ type: A.ADD_IMAGE_OVERLAY, media, atT });
// patch = { scale?, opacity? } — aba Vídeo > Básico
export const setClipTransform = (clipId, patch) => ({ type: A.SET_CLIP_TRANSFORM, clipId, patch });
// correcao de cor da cena; patch parcial, null = redefinir
export const setClipGrade = (clipId, patch) => ({ type: A.SET_CLIP_GRADE, clipId, patch });
// target 'clip'|'audio', speed 0.1..100 — aba Velocidade (só a faixa selecionada)
export const setSpeed = (target, id, speed) => ({ type: A.SET_SPEED, target, id, speed });
// colar item do clipboard: kind 'clip'|'audio'|'text'|'overlay', data = cópia, atT = playhead
export const paste = (kind, data, atT) => ({ type: A.PASTE, kind, data, atT });
// Congelar: frame do clip vira imagem esticável (freeze_sec = duração inicial)
export const freezeFrame = (clipId, atT) => ({ type: A.FREEZE_FRAME, clipId, atT });
// efeitos do menu Editar: patch { reversed?, mirrored? } no clip
export const setClipFx = (clipId, patch) => ({ type: A.SET_CLIP_FX, clipId, patch });
// patch = merge no mask atual (cria com defaults se não existe); null = remove
export const setClipMask = (clipId, patch) => ({ type: A.SET_CLIP_MASK, clipId, patch });
// estica/encolhe a cena congelada (arrastar borda) — dur em segundos
export const setFreezeDur = (clipId, dur) => ({ type: A.SET_FREEZE_DUR, clipId, dur });
export const createCompound = () => ({ type: A.CREATE_COMPOUND });
export const ungroupCompound = (compoundId) => ({ type: A.UNGROUP_COMPOUND, compoundId });
export const updateCompound = (compoundId, doc) => ({ type: A.UPDATE_COMPOUND, compoundId, doc });
