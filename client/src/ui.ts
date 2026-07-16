/**
 * DOM rendering + event wiring: LCD (time / marquee / visualizer), transport,
 * sliders, playlist, search, and the token/connect strip.
 *
 * Errors are never swallowed: every failure surfaces in the status line
 * (playlist footer) and/or the LCD marquee.
 */
import type { StatusResponse } from '@shared';
import {
  addToPlaylist,
  createPlaylist,
  errorMessage,
  getLikedIds,
  getPlaylists,
  getPlaylistTracks,
  getStatus,
  getWave,
  searchTracks,
  sendWaveFeedback,
  setLike,
  submitToken,
} from './api';
import { EQ_FREQS, EQ_RANGE_DB } from './player';
import type { PlaybackState, Player, RepeatMode } from './player';

const MARQUEE_CHARS = 32;
const MARQUEE_SEPARATOR = ' *** ';
const MARQUEE_TICK_MS = 200;

const NUM_BARS = 19;
const VIS_W = 76; // canvas is 76x16 device pixels, CSS-scaled 2x (pixelated)
const VIS_H = 16;

/** Keep at least this many wave tracks queued ahead of the current one, so
 *  "Моя волна" is effectively infinite. */
const WAVE_RUNWAY = 20;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`ui: missing element #${id}`);
  return node as T;
}

/** "MM:SS" with zero-padded minutes — the LCD clock format. */
function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** "M:SS" without minute padding — playlist row / total format. */
function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function initUI(player: Player): void {
  const timeEl = el('time');
  const timeWrap = el('time-toggle');
  const stateIcon = el('state-icon');
  const marqueeEl = el('marquee');
  const kbpsEl = el('kbps');
  const khzEl = el('khz');
  const lampStereo = el('lamp-stereo');
  const visCanvas = el<HTMLCanvasElement>('vis');
  const seekEl = el<HTMLInputElement>('seek');
  const volumeEl = el<HTMLInputElement>('volume');
  const balanceEl = el<HTMLInputElement>('balance');
  const modeLed = el('mode-led');
  const modeLabel = el('mode-label');
  const tokenInput = el<HTMLInputElement>('token-input');
  const connectBtn = el<HTMLButtonElement>('btn-connect');
  const connectRow = el('connect-row');
  const plSearch = el('pl-search');
  const plBtn = el<HTMLButtonElement>('btn-pl');
  const playlistPicker = el<HTMLSelectElement>('playlist-picker');
  const addTarget = el<HTMLSelectElement>('add-target');
  const playlistEl = el<HTMLOListElement>('playlist');
  const playlistWin = el('playlist-win');
  const searchInput = el<HTMLInputElement>('search');
  const searchBtn = el<HTMLButtonElement>('btn-search');
  const statusEl = el('status');
  const totalEl = el('pl-total');
  const waveBtn = el<HTMLButtonElement>('btn-wave');
  const shuffleBtn = el<HTMLButtonElement>('btn-shuffle');
  const repeatBtn = el<HTMLButtonElement>('btn-repeat');
  const likeBtn = el<HTMLButtonElement>('btn-like');
  const plBadge = el('pl-badge');
  const newPlBtn = el<HTMLButtonElement>('btn-newpl');
  const newPlBox = el('pl-new');
  const newPlName = el<HTMLInputElement>('pl-new-name');
  const newPlSave = el<HTMLButtonElement>('btn-newpl-save');
  const newPlCancel = el<HTMLButtonElement>('btn-newpl-cancel');

  /** Ids of the connected user's liked tracks (for the heart button state). */
  const likedIds = new Set<string>();

  let marqueeBase = '';
  let marqueeOffset = 0;
  let remainingMode = false; // time readout: elapsed vs. -remaining
  let seekDragging = false;

  // "Моя волна" state: when active, the playlist IS the AI wave queue, and it
  // auto-extends as the listener nears the frontier.
  let waveActive = false;
  let waveSessionId: string | null = null;
  let wavePrefetching = false;
  let yandexMode = false;

  // ---------------------------------------------------------------- status
  function setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
    statusEl.textContent = text;
    statusEl.className = kind === 'error' ? 'status error' : 'status';
    if (kind === 'error') console.error(`[ya-namp] ${text}`);
  }

  // --------------------------------------------------------------- marquee
  function renderMarquee(): void {
    if (marqueeBase.length <= MARQUEE_CHARS) {
      marqueeEl.textContent = marqueeBase;
      return;
    }
    const loop = marqueeBase + MARQUEE_SEPARATOR;
    marqueeEl.textContent = (loop + loop).slice(marqueeOffset, marqueeOffset + MARQUEE_CHARS);
  }

  function setMarquee(text: string): void {
    marqueeBase = text.toUpperCase();
    marqueeOffset = 0;
    renderMarquee();
  }

  window.setInterval(() => {
    if (marqueeBase.length <= MARQUEE_CHARS) return;
    marqueeOffset = (marqueeOffset + 1) % (marqueeBase.length + MARQUEE_SEPARATOR.length);
    renderMarquee();
  }, MARQUEE_TICK_MS);

  // ------------------------------------------------------------ time + seek
  function updateTime(): void {
    const duration = player.durationSeconds;
    const current = player.audio.currentTime;
    if (player.state === 'stopped' && player.currentIndex < 0) {
      timeEl.textContent = '00:00';
    } else if (remainingMode && duration > 0) {
      timeEl.textContent = `-${fmtClock(duration - current)}`;
    } else {
      timeEl.textContent = fmtClock(current);
    }
    if (!seekDragging) {
      seekEl.value = String(duration > 0 ? Math.min(1000, Math.round((current / duration) * 1000)) : 0);
    }
  }

  timeWrap.addEventListener('click', () => {
    remainingMode = !remainingMode;
    updateTime();
  });

  seekEl.addEventListener('input', () => {
    seekDragging = true;
    const duration = player.durationSeconds;
    if (duration > 0) {
      timeEl.textContent = fmtClock((Number(seekEl.value) / 1000) * duration); // live preview
    }
  });
  seekEl.addEventListener('change', () => {
    seekDragging = false;
    const duration = player.durationSeconds;
    if (duration > 0) {
      player.seekTo((Number(seekEl.value) / 1000) * duration);
    } else {
      seekEl.value = '0';
    }
  });

  // -------------------------------------------------------- volume / balance
  volumeEl.value = String(Math.round(player.audio.volume * 100));
  volumeEl.addEventListener('input', () => player.setVolume(Number(volumeEl.value) / 100));
  balanceEl.addEventListener('input', () => player.setBalance(Number(balanceEl.value) / 100));
  balanceEl.addEventListener('dblclick', () => {
    balanceEl.value = '0';
    player.setBalance(0);
  });

  // ---------------------------------------------------------------- playlist
  function renderPlaylist(): void {
    playlistEl.textContent = '';
    const frag = document.createDocumentFragment();
    let totalMs = 0;
    player.tracks.forEach((track, index) => {
      totalMs += track.durationMs;
      const li = document.createElement('li');
      if (index === player.currentIndex) li.classList.add('current');
      const idx = document.createElement('span');
      idx.className = 'pl-idx';
      idx.textContent = `${index + 1}.`;
      const name = document.createElement('span');
      name.className = 'pl-name';
      name.textContent = `${track.artist} - ${track.title}`;
      if (track.album) name.title = track.album;
      const time = document.createElement('span');
      time.className = 'pl-time';
      time.textContent = fmtDuration(track.durationMs / 1000);
      const add = document.createElement('button');
      add.className = 'pl-add-btn';
      add.type = 'button';
      add.textContent = '+';
      add.title = 'Add this track to the selected playlist';
      add.addEventListener('click', (event) => {
        event.stopPropagation(); // don't also play the row
        void addTrackToTarget(track);
      });
      li.append(idx, name, time, add);
      li.addEventListener('click', () => player.playIndex(index));
      frag.append(li);
    });
    playlistEl.append(frag);
    totalEl.textContent = fmtDuration(totalMs / 1000);
  }

  function highlightCurrent(): void {
    const rows = playlistEl.children;
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('current', i === player.currentIndex);
    }
    // Scroll only the playlist pane — scrollIntoView would scroll the page too.
    const current = rows[player.currentIndex];
    const body = playlistEl.parentElement;
    if (current instanceof HTMLElement && body instanceof HTMLElement) {
      const rowTop = current.offsetTop;
      const rowBottom = rowTop + current.offsetHeight;
      if (rowTop < body.scrollTop) body.scrollTop = rowTop;
      else if (rowBottom > body.scrollTop + body.clientHeight) {
        body.scrollTop = rowBottom - body.clientHeight;
      }
    }
  }

  // --------------------------------------------------------------- transport
  // A manual skip counts as a "skip" signal to the wave model.
  function userNext(): void {
    if (waveActive) waveFeedback('skip');
    player.next();
  }
  function userPrev(): void {
    if (waveActive) waveFeedback('skip');
    player.prev();
  }
  el('btn-prev').addEventListener('click', userPrev);
  el('btn-play').addEventListener('click', () => player.play());
  el('btn-pause').addEventListener('click', () => player.pause());
  el('btn-stop').addEventListener('click', () => player.stop());
  el('btn-next').addEventListener('click', userNext);
  el('btn-eject').addEventListener('click', () => {
    searchInput.focus();
    setStatus('type a search and press enter to load tracks', 'info');
  });
  const eqWin = el('eq-win');
  const eqBtn = el<HTMLButtonElement>('btn-eq');
  eqBtn.addEventListener('click', () => {
    eqWin.classList.toggle('hidden');
    eqBtn.classList.toggle('lit', !eqWin.classList.contains('hidden'));
  });
  plBtn.addEventListener('click', () => {
    playlistWin.classList.toggle('hidden');
    plBtn.classList.toggle('lit', !playlistWin.classList.contains('hidden'));
  });

  // ---------------------------------------------------------------- keyboard
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    switch (event.key.toLowerCase()) {
      case 'z': userPrev(); break;
      case 'x': player.play(); break;
      case 'c': player.pause(); break;
      case 'v': player.stop(); break;
      case 'b': userNext(); break;
      case 's': toggleShuffle(); break;
      case 'r': cycleRepeat(); break;
      case 'w': void startWave(); break;
      case 'l': void toggleLike(); break;
      case ' ':
        event.preventDefault();
        if (player.state === 'playing') player.pause();
        else player.play();
        break;
    }
  });

  // ------------------------------------------------------------ mode / token
  function applyStatus(status: StatusResponse): void {
    yandexMode = status.mode === 'yandex';
    if (yandexMode) {
      modeLed.className = 'led yandex';
      modeLabel.textContent = status.account ? `yandex · ${status.account.login}` : 'yandex';
      searchInput.placeholder = 'search all of Yandex Music';
      waveBtn.querySelector('.wave-sub')!.textContent = 'my wave · personalized';
    } else {
      modeLed.className = 'led demo';
      modeLabel.textContent = 'demo mode';
      searchInput.placeholder = 'search demo tracks — artist or title';
      waveBtn.querySelector('.wave-sub')!.textContent = 'my wave · demo radio';
    }
    layoutForMode(yandexMode);
  }

  const plSearchHome = plSearch.parentElement; // playlist window (its normal spot)
  const plFooter = statusEl.parentElement; // reinsert anchor

  // Static (GitHub Pages) demo build: there is no server to reach a Yandex
  // account, so the token field + Connect button can never do anything. Hide
  // them and drop a short note in the connect row instead.
  const IS_STATIC = Boolean(import.meta.env.VITE_STATIC);
  if (IS_STATIC) {
    const note = document.createElement('span');
    note.className = 'demo-note';
    note.append('DEMO — ');
    const link = document.createElement('a');
    link.href = 'https://github.com/lifeart/ya-namp';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'clone & run locally';
    note.append(link, ' to use your Yandex account');
    connectRow.appendChild(note);
  }

  /**
   * Once connected, the token field is done: hide it (and Connect) and lift the
   * search box up into the connect row so it takes the freed space. In the
   * static demo build the token field is always hidden (see IS_STATIC above).
   */
  function layoutForMode(yandex: boolean): void {
    const hideConnect = yandex || IS_STATIC;
    tokenInput.classList.toggle('hidden', hideConnect);
    connectBtn.classList.toggle('hidden', hideConnect);
    connectRow.classList.toggle('connected', yandex);
    plSearch.classList.toggle('in-connect', yandex);
    if (yandex) {
      connectRow.appendChild(plSearch);
    } else if (plSearchHome && plFooter && plSearch.parentElement !== plSearchHome) {
      plSearchHome.insertBefore(plSearch, plFooter); // restore to the playlist window
    }
  }

  async function connect(): Promise<void> {
    const raw = tokenInput.value.trim();
    // Accept either a bare token or the whole OAuth redirect URL/fragment
    // (…#access_token=XXXX&token_type=…) and pull the token out of it.
    const token = /access_token=([^&\s]+)/.exec(raw)?.[1] ?? raw;
    if (!token) {
      setStatus('paste a yandex oauth token first', 'error');
      tokenInput.focus();
      return;
    }
    connectBtn.disabled = true;
    const oldLabel = connectBtn.textContent;
    connectBtn.textContent = '...';
    try {
      const res = await submitToken(token);
      applyStatus({ mode: 'yandex', account: res.account });
      tokenInput.value = '';
      void populatePlaylists(); // refresh the picker with the connected user's playlists
      void refreshLikedIds(); // load the like state for the heart button
      setStatus(`connected to yandex as ${res.account.login} — search to load tracks`, 'info');
      setMarquee(`CONNECTED AS ${res.account.login} - SEARCH TO LOAD TRACKS`);
    } catch (err) {
      setStatus(`token rejected: ${errorMessage(err)}`, 'error');
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = oldLabel;
    }
  }
  connectBtn.addEventListener('click', () => void connect());
  tokenInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void connect();
  });

  // ------------------------------------------------------------------ search
  async function runSearch(query: string): Promise<void> {
    setWaveActive(false); // a manual search leaves wave mode
    playlistPicker.value = ''; // the playlist is now search results, not a picked list
    setStatus(query ? `searching "${query}"…` : 'loading playlist…', 'info');
    try {
      const res = await searchTracks(query);
      player.setPlaylist(res.tracks);
      renderPlaylist();
      if (res.tracks.length === 0) {
        setStatus(
          query
            ? `nothing found for "${query}"`
            : yandexMode
              ? 'search Yandex Music to load tracks'
              : 'playlist empty — search to load tracks',
          'info',
        );
      } else {
        const n = res.tracks.length;
        setStatus(`${n} track${n === 1 ? '' : 's'} in playlist`, 'info');
      }
    } catch (err) {
      setStatus(`search failed: ${errorMessage(err)}`, 'error');
      setMarquee(`ERROR: SEARCH FAILED - ${errorMessage(err)}`);
    }
  }
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void runSearch(searchInput.value.trim());
  });
  searchBtn.addEventListener('click', () => void runSearch(searchInput.value.trim()));

  // ---------------------------------------------------------------- playlists
  /** Rebuild the picker options from the server (placeholder first). */
  async function populatePlaylists(): Promise<void> {
    try {
      const res = await getPlaylists();
      const prevTarget = addTarget.value;
      playlistPicker.textContent = '';
      addTarget.textContent = '';
      const loadPlaceholder = new Option('— playlists —', '');
      playlistPicker.append(loadPlaceholder);
      const addPlaceholder = new Option('— choose —', '');
      addTarget.append(addPlaceholder);
      for (const pl of res.playlists) {
        playlistPicker.append(new Option(`${pl.title} (${pl.trackCount})`, pl.id));
        // The add-target can't include "Liked" (change-relative doesn't apply);
        // liking is done with the heart button.
        if (pl.id !== 'liked') addTarget.append(new Option(`${pl.title} (${pl.trackCount})`, pl.id));
      }
      // keep the previously-chosen add-target selected if it still exists
      if (prevTarget && [...addTarget.options].some((o) => o.value === prevTarget)) {
        addTarget.value = prevTarget;
      }
    } catch (err) {
      setStatus(`could not load playlists: ${errorMessage(err)}`, 'error');
    }
  }

  /** Add one track to the playlist chosen in the "Add to" selector. */
  async function addTrackToTarget(track: { id: string; artist: string; title: string }): Promise<void> {
    const id = addTarget.value;
    if (!id) {
      setStatus('pick a playlist in "Add to" first (or + New)', 'error');
      addTarget.focus();
      return;
    }
    const label = addTarget.selectedOptions[0]?.textContent ?? 'playlist';
    setStatus(`adding "${track.title}" to ${label}…`, 'info');
    try {
      const pl = await addToPlaylist(id, [track.id]);
      await populatePlaylists(); // refresh the counts shown in both pickers
      addTarget.value = id; // keep the same target selected
      setStatus(`added "${track.artist} - ${track.title}" → ${pl.title} (${pl.trackCount})`, 'info');
    } catch (err) {
      setStatus(`could not add to playlist: ${errorMessage(err)}`, 'error');
    }
  }

  /** Load one playlist's tracks into the playlist. Does NOT auto-play. */
  async function loadPlaylist(id: string): Promise<void> {
    setWaveActive(false); // picking a playlist leaves wave mode, like a search does
    const label = playlistPicker.selectedOptions[0]?.textContent ?? 'playlist';
    setStatus(`loading ${label}…`, 'info');
    try {
      const res = await getPlaylistTracks(id);
      player.setPlaylist(res.tracks);
      renderPlaylist();
      const n = res.tracks.length;
      if (n === 0) {
        setStatus(`${label} is empty`, 'info');
      } else {
        setStatus(`${label}: ${n} track${n === 1 ? '' : 's'} — press play or pick a row`, 'info');
      }
    } catch (err) {
      setStatus(`could not load playlist: ${errorMessage(err)}`, 'error');
      setMarquee(`ERROR: PLAYLIST - ${errorMessage(err)}`);
    }
  }

  playlistPicker.addEventListener('change', () => {
    const id = playlistPicker.value;
    if (!id) return; // placeholder re-selected — nothing to load
    void loadPlaylist(id);
  });

  // ------------------------------------------------------------- edit mode
  // Editing controls (per-row +, "Add to", + New) only appear in edit mode so
  // the browse/listen view stays clean.
  const editBtn = el<HTMLButtonElement>('btn-edit');
  let editMode = false;
  function setEditMode(on: boolean): void {
    editMode = on;
    playlistWin.classList.toggle('editing', on);
    editBtn.classList.toggle('lit', on);
    editBtn.textContent = on ? 'Done' : 'Edit';
    if (!on) showNewPlaylist(false); // collapse the inline name box on exit
    setStatus(on ? 'edit mode — search, then + a track into "Add to"' : 'ready', 'info');
  }
  editBtn.addEventListener('click', () => setEditMode(!editMode));

  // --------------------------------------------------------- new playlist
  function showNewPlaylist(show: boolean): void {
    newPlBox.classList.toggle('hidden', !show);
    newPlBtn.classList.toggle('hidden', show);
    if (show) {
      newPlName.value = '';
      newPlName.focus();
    }
  }
  async function createNewPlaylist(): Promise<void> {
    const title = newPlName.value.trim();
    if (!title) {
      setStatus('enter a playlist name', 'error');
      newPlName.focus();
      return;
    }
    const trackIds = player.tracks.map((t) => t.id);
    newPlSave.disabled = true;
    setStatus(`creating "${title}"…`, 'info');
    try {
      const pl = await createPlaylist(title, trackIds.length ? trackIds : undefined);
      showNewPlaylist(false);
      await populatePlaylists();
      playlistPicker.value = pl.id; // select it; its tracks are already in the editor
      setStatus(`created "${pl.title}" (${pl.trackCount} track${pl.trackCount === 1 ? '' : 's'})`, 'info');
    } catch (err) {
      setStatus(`could not create playlist: ${errorMessage(err)}`, 'error');
    } finally {
      newPlSave.disabled = false;
    }
  }
  newPlBtn.addEventListener('click', () => showNewPlaylist(true));
  newPlCancel.addEventListener('click', () => showNewPlaylist(false));
  newPlSave.addEventListener('click', () => void createNewPlaylist());
  newPlName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void createNewPlaylist();
    else if (event.key === 'Escape') showNewPlaylist(false);
  });

  // ------------------------------------------------------------------- likes
  function renderLikeButton(): void {
    const track = player.currentTrack;
    const liked = track ? likedIds.has(track.id) : false;
    likeBtn.classList.toggle('liked', liked);
    likeBtn.disabled = !track;
    const sub = likeBtn.querySelector('i');
    if (sub) sub.textContent = liked ? 'liked' : 'like';
  }
  async function refreshLikedIds(): Promise<void> {
    try {
      const res = await getLikedIds();
      likedIds.clear();
      for (const id of res.ids) likedIds.add(id);
    } catch (err) {
      console.warn('[ya-namp] liked ids:', errorMessage(err)); // non-fatal
    }
    renderLikeButton();
  }
  async function toggleLike(): Promise<void> {
    const track = player.currentTrack;
    if (!track) {
      setStatus('play a track to like it', 'info');
      return;
    }
    const want = !likedIds.has(track.id);
    if (want) likedIds.add(track.id); // optimistic
    else likedIds.delete(track.id);
    renderLikeButton();
    try {
      await setLike(track.id, want);
      setStatus(`${want ? 'liked' : 'unliked'}: ${track.artist} - ${track.title}`, 'info');
    } catch (err) {
      if (want) likedIds.delete(track.id); // revert
      else likedIds.add(track.id);
      renderLikeButton();
      setStatus(`could not ${want ? 'like' : 'unlike'}: ${errorMessage(err)}`, 'error');
    }
  }
  likeBtn.addEventListener('click', () => void toggleLike());
  renderLikeButton();

  // ------------------------------------------------------------------- EQ
  const eqSliders = el('eq-sliders');
  const eqOnBtn = el<HTMLButtonElement>('eq-on');
  const eqPreset = el<HTMLSelectElement>('eq-preset');
  const eqBandSliders: HTMLInputElement[] = [];

  const EQ_PRESETS: Record<string, number[]> = {
    Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    Rock: [5, 4, 2, -1, -1, 1, 3, 4, 4, 4],
    Pop: [-1, 2, 4, 4, 2, 0, -1, -1, -1, -1],
    Jazz: [4, 3, 1, 2, -1, -1, 0, 1, 3, 4],
    Classical: [5, 4, 3, 2, -1, -1, 0, 2, 3, 4],
    Dance: [6, 5, 2, 0, 0, -3, -2, 0, 3, 4],
    Bass: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
    Treble: [0, 0, 0, 0, 0, 2, 3, 5, 6, 7],
    Vocal: [-2, -1, 0, 2, 4, 4, 3, 2, 0, -1],
  };

  function makeEqColumn(labelText: string, extraClass: string): HTMLInputElement {
    const col = document.createElement('div');
    col.className = `eq-band ${extraClass}`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(-EQ_RANGE_DB);
    input.max = String(EQ_RANGE_DB);
    input.step = '1';
    input.value = '0';
    input.className = 'eq-slider';
    const label = document.createElement('span');
    label.className = 'eq-label';
    label.textContent = labelText;
    col.append(input, label);
    eqSliders.append(col);
    return input;
  }

  function buildEq(): void {
    const preamp = makeEqColumn('PRE', 'eq-preamp');
    preamp.addEventListener('input', () => player.setPreamp(Number(preamp.value)));
    EQ_FREQS.forEach((hz, i) => {
      const s = makeEqColumn(hz >= 1000 ? `${hz / 1000}K` : String(hz), 'eq-col');
      s.addEventListener('input', () => {
        player.setEqBand(i, Number(s.value));
        eqPreset.value = ''; // a manual tweak no longer matches a named preset
      });
      eqBandSliders.push(s);
    });
    eqPreset.append(new Option('— preset —', ''));
    for (const name of Object.keys(EQ_PRESETS)) eqPreset.append(new Option(name, name));
    eqPreset.addEventListener('change', () => {
      const vals = EQ_PRESETS[eqPreset.value];
      if (!vals) return;
      vals.forEach((db, i) => {
        const s = eqBandSliders[i];
        if (s) {
          s.value = String(db);
          player.setEqBand(i, db);
        }
      });
    });
  }

  function setEqOn(on: boolean): void {
    player.setEqEnabled(on);
    eqOnBtn.classList.toggle('lit', on);
    eqOnBtn.textContent = on ? 'On' : 'Off';
    eqSliders.classList.toggle('eq-off', !on);
  }

  buildEq();
  eqOnBtn.addEventListener('click', () => setEqOn(!player.eqOn));

  // ------------------------------------------------------- picture-in-picture
  // Document Picture-in-Picture (Chromium): pop the whole player window into a
  // floating always-on-top window. All controls + the visualizer keep working
  // because the audio element is detached and the DOM nodes (with their
  // listeners) are just re-parented.
  const pipBtn = el<HTMLButtonElement>('btn-pip');
  const mainWin = document.querySelector<HTMLElement>('.main-win');
  interface DocumentPiP {
    requestWindow(opts: { width: number; height: number }): Promise<Window>;
  }
  const docPip = (window as unknown as { documentPictureInPicture?: DocumentPiP })
    .documentPictureInPicture;
  let pipWindow: Window | null = null;
  let pipPlaceholder: HTMLElement | null = null;

  function copyStylesInto(doc: Document): void {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const cssText = Array.from(sheet.cssRules)
          .map((r) => r.cssText)
          .join('\n');
        const style = doc.createElement('style');
        style.textContent = cssText;
        doc.head.appendChild(style);
      } catch {
        // Cross-origin stylesheet — can't read its rules, so link it instead.
        if (sheet.href) {
          const link = doc.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          doc.head.appendChild(link);
        }
      }
    }
  }

  function restoreFromPip(): void {
    if (pipPlaceholder && mainWin) pipPlaceholder.replaceWith(mainWin);
    pipPlaceholder = null;
    pipWindow = null;
    pipBtn.classList.remove('lit');
  }

  async function togglePip(): Promise<void> {
    if (!docPip) {
      setStatus('picture-in-picture needs a Chromium browser (Document PiP)', 'error');
      return;
    }
    if (pipWindow) {
      pipWindow.close();
      return;
    }
    if (!mainWin) return;
    try {
      pipWindow = await docPip.requestWindow({ width: 574, height: 316 });
    } catch (err) {
      setStatus(`picture-in-picture failed: ${errorMessage(err)}`, 'error');
      return;
    }
    copyStylesInto(pipWindow.document);
    const body = pipWindow.document.body;
    body.style.cssText = 'margin:0;background:#0d0d13;display:flex;justify-content:center';
    pipPlaceholder = document.createElement('div');
    pipPlaceholder.className = 'pip-placeholder';
    pipPlaceholder.textContent = '▸ player is in picture-in-picture — close that window to bring it back';
    mainWin.replaceWith(pipPlaceholder);
    body.appendChild(mainWin);
    pipBtn.classList.add('lit');
    pipWindow.addEventListener('pagehide', restoreFromPip);
  }
  pipBtn.addEventListener('click', () => void togglePip());

  // --------------------------------------------------------- OS media session
  // Lets OS media keys / lock-screen / headset controls drive the player.
  function initMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => player.play());
    ms.setActionHandler('pause', () => player.pause());
    ms.setActionHandler('previoustrack', () => userPrev());
    ms.setActionHandler('nexttrack', () => userNext());
    try {
      ms.setActionHandler('seekto', (d) => {
        if (typeof d.seekTime === 'number') player.seekTo(d.seekTime);
      });
    } catch (err) {
      console.warn('[ya-namp] mediaSession seekto unsupported:', errorMessage(err));
    }
  }
  function updateMediaSession(track: { title: string; artist: string; album: string | null }): void {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album ?? '',
    });
  }
  initMediaSession();

  // ------------------------------------------------------- "Моя волна" / wave
  function setWaveActive(active: boolean): void {
    waveActive = active;
    if (!active) waveSessionId = null;
    plBadge.classList.toggle('hidden', !active);
    waveBtn.classList.toggle('lit', active);
  }

  function waveFeedback(event: 'trackStarted' | 'trackFinished' | 'skip'): void {
    const track = player.currentTrack;
    if (!track) return;
    void sendWaveFeedback({
      sessionId: waveSessionId,
      trackId: track.id,
      event,
      totalPlayedSeconds: Math.floor(player.audio.currentTime),
    });
  }

  async function startWave(autoplay = true): Promise<void> {
    playlistPicker.value = ''; // the playlist is now the wave queue, not a picked list
    setStatus('starting Моя волна…', 'info');
    setMarquee('МОЯ ВОЛНА - TUNING THE AI RADIO…');
    waveBtn.disabled = true;
    try {
      const res = await getWave();
      if (res.tracks.length === 0) {
        setStatus('the wave returned no tracks', 'error');
        return;
      }
      waveSessionId = res.sessionId;
      setWaveActive(true);
      player.setPlaylist(res.tracks);
      renderPlaylist();
      setStatus(`Моя волна · ${res.tracks.length} tracks queued`, 'info');
      if (autoplay) {
        player.playIndex(0);
      } else {
        setMarquee('МОЯ ВОЛНА - PRESS PLAY TO START YOUR WAVE');
      }
    } catch (err) {
      setStatus(`My Wave failed: ${errorMessage(err)}`, 'error');
      setMarquee(`ERROR: MY WAVE - ${errorMessage(err)}`);
    } finally {
      waveBtn.disabled = false;
    }
  }

  /** Keep the wave queue at least WAVE_RUNWAY tracks ahead — makes it infinite. */
  async function prefetchWaveIfNeeded(): Promise<void> {
    if (!waveActive || wavePrefetching) return;
    const ahead = player.tracks.length - player.currentIndex - 1;
    if (ahead >= WAVE_RUNWAY) return; // enough runway queued
    wavePrefetching = true;
    try {
      const res = await getWave(player.frontierId ?? undefined);
      // In yandex mode drop tracks already queued; in demo mode the catalog is
      // tiny, so allow repeats — that's what keeps the demo wave endless too.
      const existing = new Set(player.tracks.map((p) => p.id));
      const fresh = yandexMode ? res.tracks.filter((t) => !existing.has(t.id)) : res.tracks;
      if (res.sessionId) waveSessionId = res.sessionId;
      if (fresh.length > 0) {
        player.appendTracks(fresh);
        renderPlaylist();
      }
    } catch (err) {
      // Non-fatal: the current queue keeps playing; surface it quietly.
      setStatus(`could not extend the wave: ${errorMessage(err)}`, 'error');
    } finally {
      wavePrefetching = false;
    }
  }
  waveBtn.addEventListener('click', () => void startWave());

  // --------------------------------------------------------- shuffle / repeat
  const REPEAT_LABEL: Record<RepeatMode, string> = { off: 'repeat', all: 'repeat', one: 'repeat 1' };
  function renderPlayModes(): void {
    shuffleBtn.classList.toggle('lit', player.shuffle);
    repeatBtn.classList.toggle('lit', player.repeatMode !== 'off');
    repeatBtn.classList.toggle('one', player.repeatMode === 'one');
    const sub = repeatBtn.querySelector('i');
    if (sub) sub.textContent = REPEAT_LABEL[player.repeatMode];
  }
  function toggleShuffle(): void {
    player.shuffle = !player.shuffle;
    renderPlayModes();
    setStatus(`shuffle ${player.shuffle ? 'on' : 'off'}`, 'info');
  }
  function cycleRepeat(): void {
    const order: RepeatMode[] = ['off', 'all', 'one'];
    player.repeatMode = order[(order.indexOf(player.repeatMode) + 1) % order.length] as RepeatMode;
    renderPlayModes();
    const desc =
      player.repeatMode === 'one'
        ? 'repeat one — looping this track'
        : player.repeatMode === 'all'
          ? 'repeat all'
          : 'repeat off';
    setStatus(desc, 'info');
  }
  shuffleBtn.addEventListener('click', toggleShuffle);
  repeatBtn.addEventListener('click', cycleRepeat);
  renderPlayModes();

  // ------------------------------------------------------------ player events
  player.on('timeupdate', updateTime);

  player.on('statechange', (state: PlaybackState) => {
    stateIcon.textContent =
      state === 'playing' ? '▶︎' : state === 'paused' ? '❚❚' : '■';
    timeWrap.classList.toggle('paused', state === 'paused');
    lampStereo.classList.toggle('lit', state !== 'stopped');
    const khz = player.sampleRateKhz;
    if (khz !== null) khzEl.textContent = String(khz);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState =
        state === 'playing' ? 'playing' : state === 'paused' ? 'paused' : 'none';
    }
    updateTime();
  });

  player.on('trackchange', (track, index) => {
    const kbps = track.bitrateKbps;
    setMarquee(
      `${index + 1}. ${track.artist} - ${track.title}${kbps === null ? '' : ` (${kbps} KBPS)`}`,
    );
    kbpsEl.textContent = kbps === null ? '--' : String(kbps);
    document.title = `${track.artist} - ${track.title} · ya-namp`;
    highlightCurrent();
    renderLikeButton();
    updateMediaSession(track);
    if (waveActive) {
      waveFeedback('trackStarted');
      void prefetchWaveIfNeeded();
    }
  });

  async function continueWave(): Promise<void> {
    if (player.currentIndex >= player.tracks.length - 2) await prefetchWaveIfNeeded();
    if (player.currentIndex < player.tracks.length - 1) {
      player.playIndex(player.currentIndex + 1);
    } else {
      setStatus('wave stalled — press Моя волна to retune', 'error');
    }
  }

  player.on('ended', () => {
    // Wave keeps flowing (endless AI radio) unless the user asked to loop one.
    if (waveActive && player.repeatMode !== 'one') {
      waveFeedback('trackFinished');
      void continueWave();
      return;
    }
    const result = player.handleTrackEnd();
    if (result === 'stopped') {
      setStatus('end of playlist', 'info');
      updateTime();
    }
  });

  player.on('error', (message) => {
    setStatus(message, 'error');
    setMarquee(`ERROR: ${message}`);
  });

  // -------------------------------------------------------------- visualizer
  const visModes = ['spectrum', 'oscilloscope', 'off'] as const;
  let visMode = 0;
  visCanvas.addEventListener('click', () => {
    visMode = (visMode + 1) % visModes.length;
    setStatus(`visualizer: ${visModes[visMode]}`, 'info');
  });

  const visCtx = visCanvas.getContext('2d');
  if (!visCtx) {
    setStatus('2d canvas unavailable — visualizer disabled', 'error');
  } else {
    startVisualizer(visCtx);
  }

  function startVisualizer(g: CanvasRenderingContext2D): void {
    // Classic Winamp viscolor ramp: green at the bottom → red at the top.
    const colors: string[] = [];
    for (let row = 0; row < VIS_H; row++) {
      const t = row / (VIS_H - 1);
      colors.push(`hsl(${Math.round(120 - t * 120)}, 100%, ${45 + Math.round(t * 12)}%)`);
    }
    // Static background: black with the subtle dark dot grid.
    const bg = document.createElement('canvas');
    bg.width = VIS_W;
    bg.height = VIS_H;
    const bgCtx = bg.getContext('2d');
    if (bgCtx) {
      bgCtx.fillStyle = '#000';
      bgCtx.fillRect(0, 0, VIS_W, VIS_H);
      bgCtx.fillStyle = '#101826';
      for (let y = 0; y < VIS_H; y += 2) {
        for (let x = 0; x < VIS_W; x += 2) bgCtx.fillRect(x, y, 1, 1);
      }
    }

    const bars = new Float32Array(NUM_BARS);
    const peaks = new Float32Array(NUM_BARS);
    const holds = new Float32Array(NUM_BARS);

    function frame(): void {
      requestAnimationFrame(frame);
      g.drawImage(bg, 0, 0);
      const mode = visModes[visMode];
      if (mode === 'off') return;

      if (mode === 'oscilloscope') {
        const wave = player.getWaveformData();
        if (!wave) return;
        g.fillStyle = '#00e800';
        const step = wave.length / VIS_W;
        for (let x = 0; x < VIS_W; x++) {
          const v = wave[Math.floor(x * step)];
          const y = Math.min(
            VIS_H - 1,
            Math.max(0, Math.round(((v - 128) / 128) * (VIS_H / 2 - 1) + VIS_H / 2)),
          );
          g.fillRect(x, y, 1, 1);
        }
        return;
      }

      // Spectrum: 19 log-spaced bands with falloff + slowly-dropping peak caps.
      const freq = player.getFrequencyData();
      for (let i = 0; i < NUM_BARS; i++) {
        let target = 0;
        if (freq) {
          const span = freq.length * 0.75; // ignore the near-empty top bins
          const lo = Math.max(1, Math.floor(Math.pow(span, i / NUM_BARS)));
          const hi = Math.max(lo + 1, Math.floor(Math.pow(span, (i + 1) / NUM_BARS)));
          let v = 0;
          for (let j = lo; j < hi && j < freq.length; j++) v = Math.max(v, freq[j]);
          target = (v / 255) * VIS_H;
        }
        bars[i] = target >= bars[i] ? target : Math.max(0, bars[i] - 0.8);
        if (bars[i] >= peaks[i]) {
          peaks[i] = bars[i];
          holds[i] = 20;
        } else if (holds[i] > 0) {
          holds[i] -= 1;
        } else {
          peaks[i] = Math.max(0, peaks[i] - 0.3);
        }
        const h = Math.round(bars[i]);
        const x = i * 4;
        for (let row = 0; row < h; row++) {
          g.fillStyle = colors[row];
          g.fillRect(x, VIS_H - 1 - row, 3, 1);
        }
        const p = Math.round(peaks[i]);
        if (p > 0) {
          g.fillStyle = '#c0c8d8';
          g.fillRect(x, Math.max(0, VIS_H - 1 - p), 3, 1);
        }
      }
    }
    requestAnimationFrame(frame);
  }

  // -------------------------------------------------------------------- boot
  setMarquee('WELCOME TO YA-NAMP - A WINAMP-STYLE YANDEX MUSIC PLAYER');
  updateTime();
  renderPlaylist();

  async function boot(): Promise<void> {
    setStatus('contacting server…', 'info');
    try {
      applyStatus(await getStatus());
    } catch (err) {
      modeLed.className = 'led offline';
      modeLabel.textContent = 'offline';
      setStatus(`server unreachable: ${errorMessage(err)}`, 'error');
      setMarquee('SERVER UNREACHABLE - START THE BACKEND ON PORT 8058');
      return;
    }
    void populatePlaylists(); // fill the playlist picker (demo playlists or the user's)
    void refreshLikedIds(); // seed the heart button's like state
    // Open + load "Моя волна" by default (paused until the first user gesture —
    // browsers block autoplay). Press play to start.
    await startWave(false);
  }
  void boot();
}
