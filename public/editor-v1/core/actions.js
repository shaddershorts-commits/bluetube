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
  [A.SPLIT_TEXT]: U,
  [A.ADD_AUDIO_CLIP]: U,
  [A.DETACH_AUDIO]: U,
  [A.SPLIT_AUDIO]: U,
  [A.TRIM_AUDIO]: U,
  [A.MOVE_AUDIO]: U,
  [A.DELETE_AUDIO_CLIP]: U,
  [A.SET_AUDIO_VOLUME]: U,
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
export const setVolume = (track, value) => ({ type: A.SET_VOLUME, track, value });
export const setTransition = (between, ttype, duration) => ({ type: A.SET_TRANSITION, between, ttype, duration });
export const setAspect = (strategy) => ({ type: A.SET_ASPECT, strategy });
export const setProjectId = (id) => ({ type: A.SET_PROJECT_ID, id });
