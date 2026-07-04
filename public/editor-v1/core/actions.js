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
  SELECT_TEXT: 'SELECT_TEXT',
  // audio / transicoes / config
  SET_AUDIO_EXTRA: 'SET_AUDIO_EXTRA',
  REMOVE_AUDIO_EXTRA: 'REMOVE_AUDIO_EXTRA',
  DETACH_AUDIO: 'DETACH_AUDIO',
  REMOVE_VIDEO_AUDIO: 'REMOVE_VIDEO_AUDIO',
  SELECT_AUDIO: 'SELECT_AUDIO',
  SET_VOLUME: 'SET_VOLUME',
  SET_TRANSITION: 'SET_TRANSITION',
  SET_ASPECT: 'SET_ASPECT',
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
  [A.SET_AUDIO_EXTRA]: U,
  [A.REMOVE_AUDIO_EXTRA]: U,
  [A.DETACH_AUDIO]: U,
  [A.REMOVE_VIDEO_AUDIO]: U,
  [A.SET_VOLUME]: U,
  [A.SET_TRANSITION]: U,
  [A.SET_ASPECT]: U,
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
export const selectText = (textId) => ({ type: A.SELECT_TEXT, textId });

export const setAudioExtra = (audio) => ({ type: A.SET_AUDIO_EXTRA, audio });
export const removeAudioExtra = () => ({ type: A.REMOVE_AUDIO_EXTRA });
export const detachAudio = () => ({ type: A.DETACH_AUDIO });
export const removeVideoAudio = () => ({ type: A.REMOVE_VIDEO_AUDIO });
export const selectAudio = (kind) => ({ type: A.SELECT_AUDIO, kind });
export const setVolume = (track, value) => ({ type: A.SET_VOLUME, track, value });
export const setTransition = (between, ttype, duration) => ({ type: A.SET_TRANSITION, between, ttype, duration });
export const setAspect = (strategy) => ({ type: A.SET_ASPECT, strategy });
export const setProjectId = (id) => ({ type: A.SET_PROJECT_ID, id });
