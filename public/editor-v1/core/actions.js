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
  // camadas (overlays)
  CONVERT_TO_OVERLAY: 'CONVERT_TO_OVERLAY',
  SET_ITEM_LANE: 'SET_ITEM_LANE',
  TRIM_OVERLAY: 'TRIM_OVERLAY',
  SPLIT_OVERLAY: 'SPLIT_OVERLAY',
  MOVE_OVERLAY: 'MOVE_OVERLAY',
  SET_OVERLAY_TRANSFORM: 'SET_OVERLAY_TRANSFORM',
  DELETE_OVERLAY: 'DELETE_OVERLAY',
  SELECT_OVERLAY: 'SELECT_OVERLAY',
  SET_VOLUME: 'SET_VOLUME',
  SET_TRANSITION: 'SET_TRANSITION',
  SET_ASPECT: 'SET_ASPECT',
  // compostos (CapCut Alt+G)
  TOGGLE_MULTI_SELECT: 'TOGGLE_MULTI_SELECT',
  SELECT_ALL: 'SELECT_ALL',
  SET_MULTI_SELECT: 'SET_MULTI_SELECT',
  DELETE_MULTI: 'DELETE_MULTI',
  SET_CAPTIONS: 'SET_CAPTIONS',
  CREATE_COMPOUND: 'CREATE_COMPOUND',
  UNGROUP_COMPOUND: 'UNGROUP_COMPOUND',
  UPDATE_COMPOUND: 'UPDATE_COMPOUND',
  // multi-midia (takes)
  ADD_MEDIA_CLIP: 'ADD_MEDIA_CLIP',
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
  [A.CONVERT_TO_OVERLAY]: U,
  [A.TRIM_OVERLAY]: U,
  [A.SPLIT_OVERLAY]: U,
  [A.MOVE_OVERLAY]: U,
  [A.SET_OVERLAY_TRANSFORM]: U,
  [A.SET_ITEM_LANE]: U,
  [A.DELETE_OVERLAY]: U,
  [A.SET_VOLUME]: U,
  [A.SET_TRANSITION]: U,
  [A.SET_ASPECT]: U,
  [A.CREATE_COMPOUND]: U,
  [A.UNGROUP_COMPOUND]: U,
  [A.UPDATE_COMPOUND]: U,
  [A.DELETE_MULTI]: U, // apaga a multi-selecao inteira = 1 undo step
  [A.SET_CAPTIONS]: U, // geracao de legendas inteira = 1 undo step
  [A.ADD_MEDIA_CLIP]: U,
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
export const selectAudioClip = (audioId) => ({ type: A.SELECT_AUDIO_CLIP, audioId });
export const convertToOverlay = (clipId, atT, lane) => ({ type: A.CONVERT_TO_OVERLAY, clipId, atT, lane });
// muda a camada (z) de um overlay/texto — arrasto vertical na timeline
export const setItemLane = (itemType, id, lane) => ({ type: A.SET_ITEM_LANE, itemType, id, lane });
export const trimOverlay = (overlayId, edge, value) => ({ type: A.TRIM_OVERLAY, overlayId, edge, value });
export const splitOverlayAt = (t) => ({ type: A.SPLIT_OVERLAY, t });
export const moveOverlay = (overlayId, start) => ({ type: A.MOVE_OVERLAY, overlayId, start });
export const setOverlayTransform = (overlayId, patch) => ({ type: A.SET_OVERLAY_TRANSFORM, overlayId, patch });
export const deleteOverlay = (overlayId) => ({ type: A.DELETE_OVERLAY, overlayId });
export const selectOverlay = (overlayId) => ({ type: A.SELECT_OVERLAY, overlayId });
export const setVolume = (track, value) => ({ type: A.SET_VOLUME, track, value });
export const setTransition = (between, ttype, duration) => ({ type: A.SET_TRANSITION, between, ttype, duration });
export const setAspect = (strategy) => ({ type: A.SET_ASPECT, strategy });
export const setProjectId = (id) => ({ type: A.SET_PROJECT_ID, id });
export const toggleMultiSelect = (itemType, id) => ({ type: A.TOGGLE_MULTI_SELECT, itemType, id });
export const selectAll = () => ({ type: A.SELECT_ALL });
// marquee (arrastar no vazio) define a multi-selecao inteira de uma vez
export const setMultiSelect = (items) => ({ type: A.SET_MULTI_SELECT, items });
// Delete com multi-selecao ativa: apaga tudo que esta selecionado
export const deleteMulti = () => ({ type: A.DELETE_MULTI });
// caps: [{content,start_sec,end_sec,font,size,color,y_pct,...}] — substitui
// TODAS as legendas num unico dispatch (nao rouba selecao, 1 undo)
export const setCaptions = (caps) => ({ type: A.SET_CAPTIONS, caps });
// media: { url, path, filename, duration, width, height } — vira take no FIM
// da track principal SEM resetar o projeto (multi-midia 2026-07-20)
export const addMediaClip = (media) => ({ type: A.ADD_MEDIA_CLIP, media });
// reusa uma midia JA no pool (painel Midia: "+ adicionar de novo")
export const addClipFromMedia = (mediaId) => ({ type: A.ADD_MEDIA_CLIP, mediaId });
export const createCompound = () => ({ type: A.CREATE_COMPOUND });
export const ungroupCompound = (compoundId) => ({ type: A.UNGROUP_COMPOUND, compoundId });
export const updateCompound = (compoundId, doc) => ({ type: A.UPDATE_COMPOUND, compoundId, doc });
