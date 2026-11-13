// StaffLens application controller: owns alphaTab, the score model and UI state.

import * as alphaTab from '@coderline/alphatab';
import { arpeggio, playPreview, single, strum } from './audio';
import { exportAscii, exportGp5 } from './export/exporters';
import { esc } from './explain/format';
import { analyze, chordHtml, noteHtml, overviewHtml, type Analysis } from './explain/panels';
import { getLang, onLangChange, setLang, t, translateDom } from './i18n';
import { arrange, DEFAULT_TAB_SETTINGS, type Arrangement, type TabSettings } from './model/arrangement';
import { fromAlphaTab } from './model/fromAlphaTab';
import { readMxlScoreXml } from './model/mxl';
import { fixMusicXml } from './model/musicxmlFixups';
import { parseMusicXmlHarmony } from './model/musicxmlHarmony';
import type { SLNote, SLScore } from './model/score';
import { buildRenderScore, idForRenderedNote, type RenderScore } from './model/toAlphaTab';
import { chordShapes, shapePitches, simpleVoicing } from './theory/chordShapes';
import { positionsFor, TUNINGS, type FretPosition } from './theory/fretboard';
import type { OptimizerMode } from './theory/optimizer';
import { spellMidi, spn, type SpelledPitch } from './theory/pitch';
import { exportPanelHtml, tabPanelHtml } from './ui/forms';
import { Fretboard, type FretHighlight } from './ui/fretboard';
import { ScanView, type ScanResult } from './ui/scanView';
import { editPanelHtml } from './ui/editPanel';
import { addChordsToScore, applyEdit, barLengthIssues, setStartTempo, beatAt, beatRefOf, defaultWrittenPitch, EditHistory, finishScore, materializeChords, stepPitch, type BeatRef, type EditOp } from './model/edit';
import type { Segmentation } from './omr/runner';
import { isImageFile } from './omr/imageInput';

type PanelTab = 'overview' | 'note' | 'chord' | 'edit' | 'tab' | 'export';
type View = 'both' | 'staff' | 'tab';
type Mix = 'both' | 'melody' | 'chords';

const BASE = import.meta.env.BASE_URL;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const THEME_COLORS = {
  light: { main: '#1d1f24', secondary: '#1d1f24a0', staff: '#6b7180', bar: '#2c2f36', info: '#1d1f24', barNo: '#c0392b' },
  dark: { main: '#e7e9ee', secondary: '#e7e9eea0', staff: '#8d93a3', bar: '#c9ccd6', info: '#e7e9ee', barNo: '#ff8a7a' },
};

export class App {
  private api!: alphaTab.AlphaTabApi;
  private base: alphaTab.model.Score | null = null;
  private model: SLScore | null = null;
  private partIndex = 0;
  private an: Analysis | null = null;
  private settings: TabSettings = structuredClone(DEFAULT_TAB_SETTINGS);
  private arr: Arrangement | null = null;
  private render: RenderScore | null = null;
  private renderNotes = new Map<string, alphaTab.model.Note>();
  private selectedId: string | null = null;
  private selectedChord: number | null = null;
  private matchIds = new Set<string>();
  private tab: PanelTab = 'overview';
  private detailed = false;
  private view: View = 'both';
  private mix: Mix = 'both';
  private accompaniment = true;
  private program = 24;
  private loop = { from: 1, to: 4, on: false };
  private octaveScope: 'part' | 'selection' = 'part';
  private lastPointer: { x: number; y: number; clientX: number; clientY: number } | null = null;
  private fretboard!: Fretboard;
  private scan!: ScanView;
  private history = new EditHistory();
  private chordsMaterialized = false;
  /** Selected rest (when no note is selected). */
  private selectedRest: BeatRef | null = null;
  /** Last recognition result; the note-building step (M4) reads it. */
  omr: { scan: ScanResult; seg: Segmentation } | null = null;
  private playingIds: string[] = [];
  private asciiCache = '';

  start(): void {
    this.scan = new ScanView(
      (m, e) => this.toast(m, e),
      (scan, seg) => {
        this.omr = { scan, seg };
      },
      (xml, name, chords, tempo) => {
        this.setLoading(true);
        // oemer repeats a bar number at system breaks; number bars 1, 2, 3… for display
        let n = 0;
        const numbered = xml.replace(/<measure number="\d+"/g, () => `<measure number="${++n}"`);
        this.loadBytes(new TextEncoder().encode(numbered), name)
          .then(() => {
            if (chords.length || tempo) this.addRecognizedChords(chords, tempo);
            this.toast(t('omr.opened'));
          })
          .catch((e) => this.toast(t('open.error', { msg: (e as Error).message }), true))
          .finally(() => this.setLoading(false));
      },
    );
    this.fretboard = new Fretboard($('#fretboard'), (pos, midi) => this.onFretPick(pos, midi));
    this.setupAlphaTab();
    this.bindChrome();
    onLangChange(() => this.refreshTexts());
    this.refreshTexts();
  }

  // ------------------------------------------------------------ alphaTab

  /** The theme the page shows: the user's choice, else the system setting (the CSS does the same). */
  private get theme(): 'dark' | 'light' {
    const set = document.documentElement.dataset.theme;
    if (set === 'dark' || set === 'light') return set;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  private setupAlphaTab(): void {
    const el = $('#alphatab');
    const theme = this.theme;
    // follow the system theme while the user has not picked one
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      if (!document.documentElement.dataset.theme) this.applyTheme();
    });
    const c = THEME_COLORS[theme];
    this.api = new alphaTab.AlphaTabApi(el, {
      core: {
        fontDirectory: `${BASE}font/`,
        engine: 'html5',
        includeNoteBounds: true,
        enableLazyLoading: false,
      },
      display: {
        staveProfile: alphaTab.StaveProfile.ScoreTab,
        layoutMode: alphaTab.LayoutMode.Page,
        scale: window.innerWidth < 640 ? 0.8 : 1,
        resources: {
          mainGlyphColor: c.main,
          secondaryGlyphColor: c.secondary,
          staffLineColor: c.staff,
          barSeparatorColor: c.bar,
          scoreInfoColor: c.info,
          barNumberColor: c.barNo,
        },
      },
      player: {
        playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
        soundFont: `${BASE}soundfont/sonivox.sf2`,
        scrollElement: $('#score-scroll'),
        enableCursor: true,
        enableAnimatedBeatCursor: true,
        enableUserInteraction: true,
        enablePlaybackRangeSelection: true,
        resetPlaybackRangeOnClick: false,
        scrollOffsetY: -40,
      },
    } as alphaTab.json.SettingsJson);

    const surface = $('#score-overlay');
    surface.addEventListener(
      'pointerdown',
      (e) => {
        const r = $('#alphatab').getBoundingClientRect();
        this.lastPointer = { x: e.clientX - r.left, y: e.clientY - r.top, clientX: e.clientX, clientY: e.clientY };
      },
      true,
    );

    // alphaTab only reports a note when the notehead itself is hit; use a generous, touch-friendly radius instead.
    this.api.beatMouseDown.on((beat) => this.onScoreBeatClick(beat));
    this.api.postRenderFinished.on(() => {
      this.drawOverlay();
      $('#score-scroll').classList.remove('busy');
    });
    this.api.renderStarted.on(() => $('#score-scroll').classList.add('busy'));
    this.api.soundFontLoad.on((e) => {
      const pct = e.total ? Math.round((e.loaded / e.total) * 100) : 0;
      $('#sound-status').textContent = t('play.loadingSound', { pct });
    });
    this.api.playerReady.on(() => {
      $('#sound-status').textContent = '';
      document.body.classList.add('player-ready');
      this.applyPlaybackOptions();
    });
    this.api.playerStateChanged.on((e) => {
      const playing = e.state === alphaTab.synth.PlayerState.Playing;
      const btn = $('#btn-play');
      btn.textContent = playing ? '⏸' : '▶';
      btn.setAttribute('aria-label', t(playing ? 'play.pause' : 'play.play'));
      btn.title = t(playing ? 'play.pause' : 'play.play');
      if (!playing) {
        this.playingIds = [];
        this.updateFretboard();
      }
    });
    this.api.activeBeatsChanged.on((e) => {
      if (!this.render || !this.model) return;
      const part = this.model.parts[this.partIndex];
      const ids: string[] = [];
      for (const beat of e.activeBeats) {
        for (const n of beat.notes) {
          const id = idForRenderedNote(n, part);
          if (id) ids.push(id);
        }
      }
      this.playingIds = ids;
      this.updateFretboard();
    });
    // Drag across the score to choose the loop bars.
    this.api.playbackRangeHighlightChanged.on((e) => {
      if (!e.startBeat || !e.endBeat) return;
      const a = e.startBeat.voice.bar.index;
      const b = e.endBeat.voice.bar.index;
      this.pendingLoop = [Math.min(a, b) + 1, Math.max(a, b) + 1];
    });
    this.api.playbackRangeChanged.on((e) => {
      if (this.applyingLoop) return;
      if (e.playbackRange && this.pendingLoop) {
        this.loop = { on: true, from: this.pendingLoop[0], to: this.pendingLoop[1] };
        this.syncLoopInputs();
        this.applyLoop();
        if (this.tab === 'tab') this.renderPanel();
      }
      this.pendingLoop = null;
    });
    this.api.error.on((err) => this.toast(t('open.error', { msg: err.message ?? String(err) }), true));
  }

  private applyTheme(): void {
    if (!this.api) return;
    const theme = this.theme;
    const c = THEME_COLORS[theme];
    const res = this.api.settings.display.resources;
    const C = alphaTab.model.Color;
    res.mainGlyphColor = C.fromJson(c.main)!;
    res.secondaryGlyphColor = C.fromJson(c.secondary)!;
    res.staffLineColor = C.fromJson(c.staff)!;
    res.barSeparatorColor = C.fromJson(c.bar)!;
    res.scoreInfoColor = C.fromJson(c.info)!;
    res.barNumberColor = C.fromJson(c.barNo)!;
    this.api.updateSettings();
    if (this.render) this.api.render();
  }

  // ------------------------------------------------------------ loading

  async loadUrl(url: string, fileName: string): Promise<void> {
    this.setLoading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await this.loadBytes(new Uint8Array(await res.arrayBuffer()), fileName);
    } catch (e) {
      this.toast(t('open.error', { msg: (e as Error).message }), true);
    } finally {
      this.setLoading(false);
    }
  }

  async loadFile(file: File): Promise<void> {
    if (isImageFile(file.name) || file.type.startsWith('image/') || file.type === 'application/pdf') {
      await this.scan.open(file);
      return;
    }
    this.setLoading(true);
    try {
      await this.loadBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (e) {
      this.toast(t('open.error', { msg: (e as Error).message }), true);
    } finally {
      this.setLoading(false);
    }
  }

  private async loadBytes(bytes: Uint8Array, fileName: string): Promise<void> {
    const ext = fileName.toLowerCase().split('.').pop() ?? '';
    const kind: SLScore['source']['kind'] = ext === 'mxl' ? 'mxl' : ext === 'xml' || ext === 'musicxml' ? 'musicxml' : ['gp', 'gpx', 'gp5', 'gp4', 'gp3'].includes(ext) ? 'guitarpro' : 'other';
    let xmlText: string | null = null;
    if (kind === 'musicxml') xmlText = new TextDecoder().decode(bytes);
    else if (kind === 'mxl') xmlText = await readMxlScoreXml(bytes);
    // repaired MusicXML goes to alphaTab as plain XML (also for .mxl, whose root score was read above)
    const fixed = xmlText !== null ? fixMusicXml(xmlText) : null;
    const source = fixed !== null && fixed !== xmlText ? new TextEncoder().encode(fixed) : bytes;
    const at = alphaTab.importer.ScoreLoader.loadScoreFromBytes(source, this.api.settings);
    const harmony = xmlText ? parseMusicXmlHarmony(xmlText) : null;
    const model = fromAlphaTab(at, { kind, fileName }, harmony);
    if (model.parts.length === 0) throw new Error('no pitched notes found');
    this.base = at;
    this.model = model;
    this.history.clear();
    this.chordsMaterialized = !harmony;
    this.selectedRest = null;
    // Prefer a part with notes in a treble-ish range (melody); otherwise the first.
    this.partIndex = Math.max(0, model.parts.findIndex((p) => p.clef === 'treble'));
    this.settings = structuredClone(DEFAULT_TAB_SETTINGS);
    this.selectedId = null;
    this.selectedChord = null;
    this.matchIds.clear();
    const n = model.measures.length;
    this.loop = { from: 1, to: Math.min(4, n), on: false };
    this.syncLoopInputs();
    document.body.classList.add('has-score');
    this.prepareArrangement();
    // Parts that do not fit (piano, violin…): apply the suggested octave right away and tell the user.
    if (this.arr && this.arr.unplayable.size > 0 && this.arr.suggestedShift !== 0) {
      const before = this.arr.unplayable.size;
      this.setWholeShift(this.arr.suggestedShift);
      this.prepareArrangement();
      if (this.arr.unplayable.size < before) this.toast(t('tab.suggest', { dir: t(this.arr.suggestedShift < 0 ? 'dir.down' : 'dir.up') }) + ' ✓');
    }
    this.rebuild();
    this.setTab('overview');
    document.title = `${model.title} — StaffLens`;
  }

  private setLoading(on: boolean): void {
    document.body.classList.toggle('loading', on);
  }

  // ------------------------------------------------------------ arrangement & render

  private get part() {
    return this.model!.parts[this.partIndex];
  }

  private prepareArrangement(): void {
    if (!this.model) return;
    this.an = analyze(this.model, this.part);
    this.arr = arrange(this.model, this.part, this.settings);
  }

  /** Re-optimizes the tab and re-renders the score. */
  private rebuild(): void {
    if (!this.model || !this.base) return;
    this.prepareArrangement();
    const arr = this.arr!;
    const render = buildRenderScore(this.base, this.model, this.part, arr, { accompaniment: this.accompaniment, program: this.program }, this.api.settings);
    // Index rendered notes and color unplayable ones
    this.renderNotes.clear();
    const staff = render.score.tracks[render.melodyTrackIndex].staves[0];
    const red = alphaTab.model.Color.fromJson('#e0453a')!;
    for (const bar of staff.bars)
      for (const voice of bar.voices)
        for (const beat of voice.beats)
          for (const note of beat.notes) {
            const id = idForRenderedNote(note, this.part);
            if (!id) continue;
            this.renderNotes.set(id, note);
            if (arr.unplayable.has(id)) {
              const style = new alphaTab.model.NoteStyle();
              style.colors.set(alphaTab.model.NoteSubElement.StandardNotationNoteHead, red);
              style.colors.set(alphaTab.model.NoteSubElement.StandardNotationAccidentals, red);
              note.style = style;
            }
          }
    this.render = render;
    this.api.renderScore(render.score, [render.melodyTrackIndex]);
    this.fretboard.configure(arr.tuning, arr.capo, 15);
    this.asciiCache = exportAscii(this.model, this.part, arr);
    this.updateFretboard();
    this.renderPanel();
    this.updateToolbarState();
    this.applyMix();
    this.setSpeed(this.speed); // the score's tempo may have changed: refresh the BPM field
  }

  /** Playback speed as a share of the score's tempo (the slider and the BPM field both set it). */
  private speed = 1;

  /** Starting tempo of the loaded score (♩ per minute). */
  private get scoreTempo(): number {
    return this.model?.tempo || 120;
  }

  /** Sets the playback speed and keeps the slider, the % label and the BPM field in step. */
  private setSpeed(speed: number, from: 'slider' | 'bpm' | 'score' = 'score'): void {
    this.speed = Math.max(0.25, Math.min(2, speed));
    this.api.playbackSpeed = this.speed;
    const slider = $<HTMLInputElement>('#tempo');
    if (from !== 'slider') slider.value = String(Math.round(this.speed * 100));
    $('#tempo-value').textContent = `${Math.round(this.speed * 100)}%`;
    const bpm = $<HTMLInputElement>('#bpm');
    if (from !== 'bpm') bpm.value = String(Math.round(this.scoreTempo * this.speed));
    bpm.title = t('play.bpmTitle', { bpm: Math.round(this.scoreTempo) });
  }

  private applyPlaybackOptions(): void {
    this.setSpeed(this.speed);
    this.api.metronomeVolume = ($('#metronome') as HTMLInputElement).checked ? 1 : 0;
    this.api.countInVolume = ($('#countin') as HTMLInputElement).checked ? 1 : 0;
    this.applyLoop();
    this.applyMix();
  }

  private applyMix(): void {
    if (!this.render) return;
    const tracks = this.render.score.tracks;
    const melody = tracks[this.render.melodyTrackIndex];
    const acc = this.render.accompanimentTrackIndex !== null ? tracks[this.render.accompanimentTrackIndex] : null;
    this.api.changeTrackMute([melody], this.mix === 'chords');
    if (acc) this.api.changeTrackMute([acc], this.mix === 'melody');
  }

  private pendingLoop: [number, number] | null = null;
  private applyingLoop = false;

  private applyLoop(): void {
    this.applyingLoop = true;
    try {
      this.applyLoopInner();
    } finally {
      this.applyingLoop = false;
    }
  }

  private applyLoopInner(): void {
    const score = this.render?.score;
    const cache = this.api.tickCache;
    if (!score || !cache || !this.loop.on) {
      this.api.playbackRange = null;
      this.api.clearPlaybackRangeHighlight();
      this.api.isLooping = false;
      return;
    }
    const n = score.masterBars.length;
    const from = Math.max(1, Math.min(n, this.loop.from));
    const to = Math.max(from, Math.min(n, this.loop.to));
    const range = new alphaTab.synth.PlaybackRange();
    range.startTick = cache.getMasterBar(score.masterBars[from - 1]).start;
    range.endTick = cache.getMasterBar(score.masterBars[to - 1]).end;
    this.api.playbackRange = range;
    this.api.isLooping = true;
  }

  // ------------------------------------------------------------ selection

  private onScoreBeatClick(beat: alphaTab.model.Beat): void {
    const lp = this.lastPointer;
    const entries = this.api.boundsLookup?.findBeats(beat) ?? [];
    if (!lp || entries.length === 0) return;
    let best: alphaTab.model.Note | null = null;
    let bestD = Infinity;
    let bestEntryY = 0;
    for (const bb of entries) {
      for (const nb of bb.notes ?? []) {
        const b = nb.noteHeadBounds;
        const d = Math.hypot((lp.x - (b.x + b.w / 2)) * 0.7, lp.y - (b.y + b.h / 2));
        if (d < bestD) {
          bestD = d;
          best = nb.note;
          bestEntryY = bb.visualBounds.y;
        }
      }
    }
    if (!best || bestD > 28) {
      // Click above the top staff of the system: the chord-symbol row.
      const top = Math.min(...entries.map((e) => e.barBounds.visualBounds.y));
      if (lp.y < top + 6) this.onScoreChordClick(beat);
      else if (beat.notes.length === 0 && this.model && beat.voice.bar.staff.track.index === this.part.trackIndex) {
        this.selectRest({ track: this.part.trackIndex, staff: this.part.staffIndex, bar: beat.voice.bar.index, voice: beat.voice.index, beat: beat.index });
      }
      return;
    }
    const onTab = this.view === 'tab' || (this.view === 'both' && entries.length > 1 && bestEntryY >= Math.max(...entries.map((e) => e.visualBounds.y)));
    this.onScoreNoteClick(best, onTab);
  }

  /** Opens the chord panel for the chord symbol at (or in force at) the clicked beat. */
  private onScoreChordClick(beat: alphaTab.model.Beat): void {
    if (!this.model) return;
    const measure = beat.voice.bar.index;
    const m = this.model.measures[measure];
    if (!m) return;
    const chords = this.part.chords;
    let idx = chords.findIndex((c) => c.measure === measure && c.tick === beat.displayStart);
    if (idx < 0) {
      // nearest chord symbol in this bar at or before the beat
      for (let i = 0; i < chords.length; i++) if (chords[i].measure === measure && chords[i].tick <= beat.displayStart) idx = i;
    }
    if (idx < 0) return;
    this.selectedChord = idx;
    this.setTab('chord');
    const c = chords[idx].parsed;
    if (c) {
      const shape = chordShapes(c, 1)[0];
      playPreview(this.api, strum(shape ? shapePitches(shape) : simpleVoicing(c)), this.program);
    }
  }

  private onScoreNoteClick(note: alphaTab.model.Note, onTab: boolean): void {
    if (!this.model) return;
    const id = idForRenderedNote(note, this.part);
    const sl = id ? this.part.notes.find((n) => n.id === id) : null;
    if (!sl) {
      // bass note we added
      const bass = this.arr?.bass.find((b) => b.measure === note.beat.voice.bar.index && b.beatIndex === note.beat.index);
      if (bass) this.toast(t('note.bassNote', { chord: bass.chord }));
      return;
    }
    this.selectNote(sl.id, true);
    if (onTab) this.openLockPopover(sl);
  }

  private selectRest(ref: BeatRef): void {
    this.selectedId = null;
    this.selectedRest = ref;
    if (this.tab !== 'edit') this.setTab('edit');
    this.drawOverlay();
    this.updateFretboard();
    this.renderPanel();
  }

  selectNote(id: string | null, play: boolean, scroll = false): void {
    this.selectedId = id;
    if (id) this.selectedRest = null;
    this.closePopover();
    const sl = id ? this.part.notes.find((n) => n.id === id) : null;
    if (sl) {
      const chord = this.part.chords.filter((c) => c.absTick <= sl.absTick).pop();
      if (chord) this.selectedChord = this.part.chords.indexOf(chord);
      if (play) this.playNote(sl);
      if (this.tab !== 'note' && this.tab !== 'tab' && this.tab !== 'edit') this.setTab('note');
      if (scroll) this.scrollToNote(sl.id);
    }
    this.drawOverlay();
    this.updateFretboard();
    this.renderPanel();
  }

  private stepSelection(delta: number): void {
    if (!this.an) return;
    const list = this.an.ordered.filter((n) => !n.isTieDestination);
    if (list.length === 0) return;
    let idx = list.findIndex((n) => n.id === this.selectedId);
    idx = idx < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, idx + delta));
    this.selectNote(list[idx].id, true, true);
  }

  private playNote(sl: SLNote): void {
    const midi = this.arr?.guitarMidi.get(sl.id) ?? sl.writtenMidi - 12;
    playPreview(this.api, single(midi), this.program);
  }

  private scrollToNote(id: string): void {
    const note = this.renderNotes.get(id);
    const bounds = note ? this.api.boundsLookup?.findBeat(note.beat) : null;
    if (!bounds) return;
    const scroller = $('#score-scroll');
    const y = bounds.visualBounds.y;
    if (y < scroller.scrollTop + 40 || y > scroller.scrollTop + scroller.clientHeight - 120) {
      scroller.scrollTo({ top: Math.max(0, y - 80), behavior: 'smooth' });
    }
  }

  private gotoBar(index: number): void {
    const first = this.an?.ordered.find((n) => n.measure === index && !n.isTieDestination);
    if (first) this.selectNote(first.id, false, true);
    const mb = this.api.boundsLookup?.findMasterBarByIndex(index);
    if (mb) $('#score-scroll').scrollTo({ top: Math.max(0, mb.visualBounds.y - 60), behavior: 'smooth' });
  }

  /** Rings around the selected note and fretboard matches. */
  private drawOverlay(): void {
    const layer = $('#selection-layer');
    layer.innerHTML = '';
    const lookup = this.api.boundsLookup;
    if (!lookup) return;
    const add = (id: string, cls: string) => {
      const note = this.renderNotes.get(id);
      if (!note) return;
      for (const bb of lookup.findBeats(note.beat) ?? []) {
        const nb = bb.notes?.find((x) => x.note === note);
        if (!nb) continue;
        const b = nb.noteHeadBounds;
        const div = document.createElement('div');
        div.className = `sel ${cls}`;
        div.style.left = `${b.x - 4}px`;
        div.style.top = `${b.y - 4}px`;
        div.style.width = `${b.w + 8}px`;
        div.style.height = `${b.h + 8}px`;
        layer.appendChild(div);
      }
    };
    for (const id of this.matchIds) add(id, 'match');
    if (this.selectedId) add(this.selectedId, 'selected');
    if (this.selectedRest && this.render) {
      const r = this.selectedRest;
      const beat = this.render.score.tracks[r.track]?.staves[0]?.bars[r.bar]?.voices[r.voice]?.beats[r.beat];
      const bb = beat ? lookup.findBeats(beat)?.[0] : null;
      if (bb) {
        const b = bb.visualBounds;
        const div = document.createElement('div');
        div.className = 'sel selected rest';
        div.style.left = `${b.x - 3}px`;
        div.style.top = `${b.y - 3}px`;
        div.style.width = `${b.w + 6}px`;
        div.style.height = `${b.h + 6}px`;
        layer.appendChild(div);
      }
    }
  }

  // ------------------------------------------------------------ lock popover

  private openLockPopover(sl: SLNote): void {
    if (!this.arr || !this.lastPointer) return;
    const midi = this.arr.guitarMidi.get(sl.id)!;
    const options = positionsFor(midi, this.arr.tuning, this.settings.capo, this.settings.maxFret);
    if (options.length === 0) return;
    const current = this.arr.placements.get(sl.id)?.position;
    const locked = this.settings.locks[sl.id];
    const pop = $('#popover');
    const name = spn(spellMidi(midi, this.model!.measures[sl.measure].keyFifths, sl.written.alter));
    pop.innerHTML =
      `<p class="pop-title">${esc(t('pop.title', { name }))}</p>` +
      options
        .map((o) => {
          const isCur = current && current.string === o.string && current.fret === o.fret;
          return `<button class="pop-opt ${isCur ? 'current' : ''}" data-action="lock" data-string="${o.string}" data-fret="${o.fret}">${esc(t('note.stringFret', { s: o.string, f: o.fret - this.settings.capo }))}${isCur ? ' ✓' : ''}</button>`;
        })
        .join('') +
      `<button class="pop-opt ghost ${locked ? '' : 'current'}" data-action="unlock">${esc(t('pop.auto'))}${locked ? '' : ' ✓'}</button>`;
    pop.hidden = false;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const x = Math.min(window.innerWidth - w - 8, Math.max(8, this.lastPointer.clientX - w / 2));
    const y = this.lastPointer.clientY + 14 + h > window.innerHeight ? this.lastPointer.clientY - h - 14 : this.lastPointer.clientY + 14;
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
    (pop.querySelector('button') as HTMLButtonElement | null)?.focus();
  }

  private closePopover(): void {
    const pop = $('#popover');
    if (!pop.hidden) pop.hidden = true;
  }

  private lockSelected(pos: FretPosition | null): void {
    if (!this.selectedId) return;
    if (pos) this.settings.locks[this.selectedId] = pos;
    else delete this.settings.locks[this.selectedId];
    this.closePopover();
    this.rebuild();
  }

  // ------------------------------------------------------------ fretboard

  private updateFretboard(): void {
    const h: FretHighlight[] = [];
    if (this.arr) {
      for (const id of this.playingIds) {
        const p = this.arr.placements.get(id);
        if (p) h.push({ ...p.position, kind: 'playing' });
      }
      if (this.selectedId && this.playingIds.length === 0) {
        const midi = this.arr.guitarMidi.get(this.selectedId);
        const cur = this.arr.placements.get(this.selectedId)?.position;
        if (midi !== undefined) {
          for (const p of positionsFor(midi, this.arr.tuning, this.settings.capo, 15)) {
            const isCur = cur && cur.string === p.string && cur.fret === p.fret;
            h.push({ ...p, kind: isCur ? 'current' : 'option' });
          }
        }
      }
    }
    if (this.picked) h.push({ ...this.picked, kind: 'picked' });
    this.fretboard?.setHighlights(h);
  }

  private picked: FretPosition | null = null;
  private pickedMidi: number | null = null;

  private updateFretStatus(): void {
    const el = $('#fb-status');
    if (this.pickedMidi === null) {
      el.textContent = t('fb.hint');
      return;
    }
    const name = spn(spellMidi(this.pickedMidi, this.model?.measures[0]?.keyFifths ?? 0));
    el.textContent = this.model ? (this.matchIds.size ? t('fb.matches', { name, n: this.matchIds.size }) : t('fb.none', { name })) : name;
  }

  private onFretPick(pos: FretPosition, midi: number): void {
    this.picked = pos;
    this.pickedMidi = midi;
    playPreview(this.api, single(midi), this.program);
    this.matchIds.clear();
    if (this.arr) for (const [id, m] of this.arr.guitarMidi) if (m === midi) this.matchIds.add(id);
    this.updateFretStatus();
    this.drawOverlay();
    this.updateFretboard();
    const first = [...this.matchIds][0];
    if (first) this.scrollToNote(first);
  }

  // ------------------------------------------------------------ panels

  setTab(tab: PanelTab): void {
    this.tab = tab;
    document.querySelectorAll<HTMLButtonElement>('.panel-tabs [role=tab]').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    this.renderPanel();
  }

  private renderPanel(): void {
    const panel = $('#panel');
    if (!this.model || !this.an) {
      panel.innerHTML = `<p class="muted">${esc(t('empty.text'))}</p>`;
      return;
    }
    let html = '';
    switch (this.tab) {
      case 'overview':
        html = `<h2>${esc(this.model.title)}</h2>${this.model.composer ? `<p class="muted">${esc(this.model.composer)}</p>` : ''}` + overviewHtml(this.an, this.arr, this.settings, this.detailed);
        break;
      case 'note': {
        const sl = this.selectedId ? this.part.notes.find((n) => n.id === this.selectedId) : null;
        html = sl ? noteHtml(this.an, sl, this.arr, this.settings, this.detailed) : `<p class="muted">${esc(t('note.selectHint'))}</p>`;
        break;
      }
      case 'chord':
        html = this.selectedChord !== null ? chordHtml(this.an, this.selectedChord, this.detailed) : `<p class="muted">${esc(t('chord.selectHint'))}</p>`;
        break;
      case 'tab':
        html =
          `<h2>${esc(t('tab.heading'))}</h2>` +
          tabPanelHtml({ score: this.model, partIndex: this.partIndex, settings: this.settings, arr: this.arr, loop: this.loop, octaveScope: this.octaveScope });
        break;
      case 'export':
        html = `<h2>${esc(t('export.heading'))}</h2>` + exportPanelHtml(this.asciiCache);
        break;
      case 'edit':
        html = editPanelHtml(this.editState());
        break;
    }
    panel.innerHTML = html;
    panel.classList.toggle('detailed', this.detailed);
  }

  private onPanelAction(el: HTMLElement): void {
    const action = el.dataset.action;
    switch (action) {
      case 'goto-bar':
        this.gotoBar(Number(el.dataset.bar));
        break;
      case 'show-chord':
        this.selectedChord = Number(el.dataset.chord);
        this.setTab('chord');
        break;
      case 'play-note': {
        const sl = this.part.notes.find((n) => n.id === this.selectedId);
        if (sl) this.playNote(sl);
        break;
      }
      case 'lock':
        this.lockSelected({ string: Number(el.dataset.string), fret: Number(el.dataset.fret) });
        break;
      case 'unlock':
        this.lockSelected(null);
        break;
      case 'strum':
      case 'arpeggio': {
        const c = this.selectedChord !== null ? this.part.chords[this.selectedChord]?.parsed : null;
        if (!c) break;
        const shape = chordShapes(c, 1)[0];
        const pitches = shape ? shapePitches(shape) : simpleVoicing(c);
        playPreview(this.api, action === 'strum' ? strum(pitches) : arpeggio(pitches), this.program);
        break;
      }
      case 'octave':
        this.shiftOctave(Number(el.dataset.delta));
        break;
      case 'octave-reset':
        this.settings.octaveShift = {};
        this.rebuild();
        break;
      case 'apply-shift':
        this.setWholeShift(Number(el.dataset.shift));
        this.rebuild();
        break;
      case 'clear-locks':
        this.settings.locks = {};
        this.rebuild();
        break;
      case 'export-gp5':
        this.download(exportGp5(this.model!, this.part, this.arr!, this.program), 'gp5', 'application/octet-stream');
        break;
      case 'export-gp7': {
        const bytes = new alphaTab.exporter.Gp7Exporter().export(this.render!.score, this.api.settings);
        this.download(bytes, 'gp', 'application/octet-stream');
        break;
      }
      case 'export-midi':
        this.exportMidi();
        break;
      case 'export-ascii':
        this.download(new TextEncoder().encode(this.asciiCache), 'txt', 'text/plain;charset=utf-8');
        break;
      case 'copy-ascii':
        navigator.clipboard?.writeText(this.asciiCache).then(
          () => this.toast(t('export.copied')),
          () => this.toast('Clipboard unavailable', true),
        );
        break;
      case 'export-png':
        this.exportPng();
        break;
      case 'export-print':
        window.print();
        break;
      case 'ed-step':
        this.editPitch((p, fifths) => stepPitch(p, Number(el.dataset.d), fifths));
        break;
      case 'ed-oct':
        this.editPitch((p) => ({ ...p, octave: p.octave + Number(el.dataset.d) }));
        break;
      case 'ed-acc':
        this.editPitch((p) => ({ ...p, alter: Number(el.dataset.a) }));
        break;
      case 'ed-dur':
        this.editDuration(Number(el.dataset.v), null);
        break;
      case 'ed-dot':
        this.editDuration(null, 'toggle');
        break;
      case 'ed-insert':
        this.editInsert();
        break;
      case 'ed-chordnote':
        this.editChordNote();
        break;
      case 'ed-rest': {
        const ref = this.currentRef();
        if (ref) this.applyEditOp({ kind: 'makeRest', ref });
        break;
      }
      case 'ed-note': {
        const ref = this.currentRef();
        if (ref) this.applyEditOp({ kind: 'addNote', ref, written: defaultWrittenPitch(this.part, ref, this.keyAt(ref.bar)), offset: this.partOffset() }, true);
        break;
      }
      case 'ed-del-note':
        if (this.selectedId) this.applyEditOp({ kind: 'deleteNote', noteId: this.selectedId });
        break;
      case 'ed-del-beat': {
        const ref = this.currentRef();
        if (ref) this.applyEditOp({ kind: 'deleteBeat', ref }, false, true);
        break;
      }
      case 'ed-chord-set': {
        const ref = this.currentRef();
        const input = $('#panel').querySelector<HTMLInputElement>('input[name=ed-chord]');
        if (ref && input) this.applyEditOp({ kind: 'chord', ref, text: input.value });
        break;
      }
      case 'ed-tempo-set': {
        const input = $('#panel').querySelector<HTMLInputElement>('input[name=ed-tempo]');
        const v = Number(input?.value);
        if (v > 0) this.applyEditOp({ kind: 'tempo', bpm: v });
        break;
      }
      case 'ed-chord-del': {
        const ref = this.currentRef();
        if (ref) this.applyEditOp({ kind: 'chord', ref, text: null });
        break;
      }
      case 'ed-undo':
        this.undoRedo('undo');
        break;
      case 'ed-redo':
        this.undoRedo('redo');
        break;
    }
  }

  private onPanelChange(el: HTMLInputElement | HTMLSelectElement): void {
    const s = this.settings;
    switch (el.name) {
      case 'part':
        this.partIndex = Number(el.value);
        this.settings = structuredClone(DEFAULT_TAB_SETTINGS);
        this.selectedId = null;
        this.selectedChord = null;
        break;
      case 'mode':
        s.mode = el.value as OptimizerMode;
        break;
      case 'position':
        s.position = Math.max(1, Math.min(12, Number(el.value) || 1));
        s.mode = 'position';
        break;
      case 'tuning':
        s.tuningId = el.value as keyof typeof TUNINGS;
        break;
      case 'capo':
        s.capo = Number(el.value);
        break;
      case 'beginner':
        s.beginner = (el as HTMLInputElement).checked;
        break;
      case 'addBass':
        s.addBass = (el as HTMLInputElement).checked;
        break;
      case 'octaveScope':
        this.octaveScope = el.value as 'part' | 'selection';
        return;
      default:
        return;
    }
    this.rebuild();
  }

  private setWholeShift(shift: number): void {
    const o: Record<number, number> = {};
    this.model!.measures.forEach((m) => (o[m.index] = shift));
    this.settings.octaveShift = o;
  }

  private shiftOctave(delta: number): void {
    if (!this.model) return;
    const n = this.model.measures.length;
    const [from, to] = this.octaveScope === 'selection' ? [this.loop.from - 1, this.loop.to - 1] : [0, n - 1];
    for (let i = Math.max(0, from); i <= Math.min(n - 1, to); i++) {
      const v = (this.settings.octaveShift[i] ?? 0) + delta;
      this.settings.octaveShift[i] = Math.max(-3, Math.min(3, v));
    }
    this.rebuild();
  }

  /** Puts chord symbols found by OCR onto the beats of the recognised score (not an undoable edit). */
  private addRecognizedChords(chords: { measure: number; tick: number; text: string }[], tempo: number | null = null): void {
    if (!this.base || !this.model) return;
    addChordsToScore(this.base, this.part, chords);
    if (tempo) setStartTempo(this.base, tempo);
    this.afterScoreChange(null, null, false);
    this.history.clear();
    this.setTab('overview');
  }

  // ------------------------------------------------------------ editing

  private currentRef(): BeatRef | null {
    if (this.selectedId) return beatRefOf(this.selectedId);
    return this.selectedRest;
  }

  private keyAt(bar: number): number {
    return this.model?.measures[bar]?.keyFifths ?? 0;
  }

  /** written − sounding for this part (12 for guitar notation). */
  private partOffset(): number {
    const n = this.part.notes[0];
    return n ? n.writtenMidi - n.soundingMidi : 12;
  }

  private editState() {
    const note = this.selectedId ? this.part.notes.find((n) => n.id === this.selectedId) ?? null : null;
    const ref = this.currentRef();
    const rest = !note && ref ? this.part.beats.find((b) => b.measure === ref.bar && b.voice === ref.voice && b.beatIndex === ref.beat) ?? null : null;
    const tick = note?.tick ?? rest?.tick;
    const chordAtBeat = ref && tick !== undefined ? this.part.chords.find((c) => c.measure === ref.bar && c.tick === tick) ?? null : null;
    return {
      note,
      rest,
      ref,
      chordAtBeat,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      issues: this.model ? barLengthIssues(this.model, this.part) : [],
      quarterTicks: 960,
      tempo: this.scoreTempo,
    };
  }

  /** Applies an edit to the source score, rebuilds the model and re-renders. */
  private applyEditOp(op: EditOp, play = false, structural = false): void {
    if (!this.base || !this.model) return;
    if (!this.chordsMaterialized) {
      materializeChords(this.base, this.part);
      this.base = finishScore(this.base, this.api.settings);
      this.chordsMaterialized = true;
    }
    this.history.record(this.base);
    let res;
    try {
      res = applyEdit(this.base, op);
    } catch (e) {
      this.toast((e as Error).message, true);
      return;
    }
    this.afterScoreChange(res.noteId, res.noteId ? null : res.ref, structural);
    if (play && this.selectedId) {
      const sl = this.part.notes.find((n) => n.id === this.selectedId);
      if (sl) this.playNote(sl);
    }
  }

  private afterScoreChange(noteId: string | null, rest: BeatRef | null, structural: boolean): void {
    this.base = finishScore(this.base!, this.api.settings);
    const source = this.model!.source;
    const trackIndex = this.part.trackIndex;
    const staffIndex = this.part.staffIndex;
    this.model = fromAlphaTab(this.base, source, null);
    const idx = this.model.parts.findIndex((p) => p.trackIndex === trackIndex && p.staffIndex === staffIndex);
    this.partIndex = idx >= 0 ? idx : 0;
    if (structural) this.settings.locks = {};
    this.selectedId = noteId && this.part.notes.some((n) => n.id === noteId) ? noteId : null;
    this.selectedRest = this.selectedId ? null : rest;
    this.matchIds.clear();
    this.rebuild();
    this.setTab('edit');
  }

  private undoRedo(dir: 'undo' | 'redo'): void {
    if (!this.base) return;
    const next = dir === 'undo' ? this.history.undo(this.base, this.api.settings) : this.history.redo(this.base, this.api.settings);
    if (!next) return;
    this.base = next;
    const keep = this.selectedId;
    this.afterScoreChange(keep, this.selectedRest, true);
  }

  private editPitch(f: (p: SpelledPitch, fifths: number) => SpelledPitch): void {
    const sl = this.selectedId ? this.part.notes.find((n) => n.id === this.selectedId) : null;
    if (!sl) return;
    const written = f(sl.written, this.keyAt(sl.measure));
    if (written.octave < 0 || written.octave > 8) return;
    this.applyEditOp({ kind: 'pitch', noteId: sl.id, written, offset: sl.writtenMidi - sl.soundingMidi }, true);
  }

  private editDuration(value: number | null, dot: 'toggle' | null): void {
    const ref = this.currentRef();
    const beat = ref && this.base ? beatAt(this.base, ref) : null;
    if (!ref || !beat) return;
    const v = value ?? Number(beat.duration);
    const dots = dot === 'toggle' ? (beat.dots ? 0 : 1) : beat.dots;
    this.applyEditOp({ kind: 'duration', ref, value: v, dots });
  }

  private editInsert(): void {
    const ref = this.currentRef();
    if (!ref) return;
    const sl = this.selectedId ? this.part.notes.find((n) => n.id === this.selectedId) : null;
    const written = sl ? sl.written : defaultWrittenPitch(this.part, ref, this.keyAt(ref.bar));
    this.applyEditOp({ kind: 'insertAfter', ref, written, offset: sl ? sl.writtenMidi - sl.soundingMidi : this.partOffset() }, true, true);
  }

  private editChordNote(): void {
    const sl = this.selectedId ? this.part.notes.find((n) => n.id === this.selectedId) : null;
    if (!sl) return;
    const written = stepPitch(sl.written, 2, this.keyAt(sl.measure)); // a third above
    this.applyEditOp({ kind: 'addNote', ref: beatRefOf(sl.id), written, offset: sl.writtenMidi - sl.soundingMidi }, true);
  }

  // ------------------------------------------------------------ export helpers

  private fileBase(): string {
    return (this.model?.title || 'stafflens').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'stafflens';
  }

  private download(bytes: Uint8Array, ext: string, type: string): void {
    const blob = new Blob([bytes as BlobPart], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.fileBase()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  private exportMidi(): void {
    if (!this.render) return;
    const midi = new alphaTab.midi.MidiFile();
    const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(midi, true);
    new alphaTab.midi.MidiFileGenerator(this.render.score, this.api.settings, handler).generate();
    this.download(midi.toBinary(), 'mid', 'audio/midi');
  }

  private exportPng(): void {
    const host = $('#alphatab');
    const hostRect = host.getBoundingClientRect();
    const items = Array.from(host.querySelectorAll<HTMLCanvasElement | HTMLImageElement>('.at-surface canvas, .at-surface img'));
    if (items.length === 0) return;
    const w = Math.ceil(host.scrollWidth);
    const h = Math.ceil(Math.max(...items.map((c) => c.getBoundingClientRect().bottom - hostRect.top)));
    const scale = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--score-bg').trim() || '#ffffff';
    ctx.fillRect(0, 0, w, h);
    for (const el of items) {
      const r = el.getBoundingClientRect();
      ctx.drawImage(el, r.left - hostRect.left, r.top - hostRect.top, r.width, r.height);
    }
    canvas.toBlob((blob) => {
      if (!blob) return;
      blob.arrayBuffer().then((b) => this.download(new Uint8Array(b), 'png', 'image/png'));
    }, 'image/png');
  }

  // ------------------------------------------------------------ chrome

  private bindChrome(): void {
    const fileInput = $<HTMLInputElement>('#file-input');
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) this.loadFile(f);
      fileInput.value = '';
    });
    const imageInput = $<HTMLInputElement>('#image-input');
    imageInput.addEventListener('change', () => {
      const f = imageInput.files?.[0];
      if (f) void this.scan.open(f);
      imageInput.value = '';
    });
    document.querySelectorAll<HTMLButtonElement>('[data-demo]').forEach((b) =>
      b.addEventListener('click', () => this.loadUrl(`${BASE}samples/${b.dataset.demo}.musicxml`, `${b.dataset.demo}.musicxml`)),
    );

    // drag & drop anywhere
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      document.body.classList.add('dragging');
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) document.body.classList.remove('dragging');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      const f = e.dataTransfer?.files?.[0];
      if (f) this.loadFile(f);
    });

    $('#lang-btn').addEventListener('click', () => setLang(getLang() === 'en' ? 'th' : 'en'));
    $('#theme-btn').addEventListener('click', () => {
      const root = document.documentElement;
      const dark = root.dataset.theme ? root.dataset.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = dark ? 'light' : 'dark';
      try {
        localStorage.setItem('stafflens.theme', root.dataset.theme);
      } catch {
        /* ignore */
      }
      this.applyTheme();
    });

    // toolbar
    $('#btn-play').addEventListener('click', () => this.api.playPause());
    $('#btn-stop').addEventListener('click', () => this.api.stop());
    $('#btn-from').addEventListener('click', () => {
      const note = this.selectedId ? this.renderNotes.get(this.selectedId) : null;
      const cache = this.api.tickCache;
      if (note && cache) this.api.tickPosition = cache.getBeatStart(note.beat);
      this.api.play();
    });
    const tempo = $<HTMLInputElement>('#tempo');
    tempo.addEventListener('input', () => this.setSpeed(Number(tempo.value) / 100, 'slider'));
    const bpm = $<HTMLInputElement>('#bpm');
    const fromBpm = () => {
      const v = Number(bpm.value);
      if (v > 0) this.setSpeed(v / this.scoreTempo, 'bpm');
    };
    bpm.addEventListener('change', () => {
      fromBpm();
      bpm.value = String(Math.round(this.scoreTempo * this.speed)); // show the clamped value
    });
    bpm.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') bpm.blur();
    });
    $('#metronome').addEventListener('change', () => this.applyPlaybackOptions());
    $('#countin').addEventListener('change', () => this.applyPlaybackOptions());
    const loopOn = $<HTMLInputElement>('#loop-on');
    const loopFrom = $<HTMLInputElement>('#loop-from');
    const loopTo = $<HTMLInputElement>('#loop-to');
    const onLoop = () => {
      this.loop = { on: loopOn.checked, from: Number(loopFrom.value) || 1, to: Number(loopTo.value) || 1 };
      this.applyLoop();
      if (this.tab === 'tab') this.renderPanel();
    };
    [loopOn, loopFrom, loopTo].forEach((el) => el.addEventListener('change', onLoop));
    $<HTMLSelectElement>('#mix').addEventListener('change', (e) => {
      this.mix = (e.target as HTMLSelectElement).value as Mix;
      this.applyMix();
    });
    $<HTMLSelectElement>('#sound').addEventListener('change', (e) => {
      this.program = Number((e.target as HTMLSelectElement).value);
      this.rebuild();
    });
    $<HTMLInputElement>('#accomp').addEventListener('change', (e) => {
      this.accompaniment = (e.target as HTMLInputElement).checked;
      this.rebuild();
    });
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
      b.addEventListener('click', () => {
        this.view = b.dataset.view as View;
        document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        this.api.settings.display.staveProfile = this.view === 'both' ? alphaTab.StaveProfile.ScoreTab : this.view === 'staff' ? alphaTab.StaveProfile.Score : alphaTab.StaveProfile.Tab;
        this.api.updateSettings();
        if (this.render) this.api.render();
      }),
    );

    // panel tabs (with arrow-key navigation)
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.panel-tabs [role=tab]'));
    tabs.forEach((b, i) => {
      b.addEventListener('click', () => this.setTab(b.dataset.tab as PanelTab));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        e.stopPropagation();
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        this.setTab(next.dataset.tab as PanelTab);
      });
    });
    document.querySelectorAll<HTMLButtonElement>('[data-detail]').forEach((b) =>
      b.addEventListener('click', () => {
        this.detailed = b.dataset.detail === 'detailed';
        document.querySelectorAll<HTMLButtonElement>('[data-detail]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        this.renderPanel();
      }),
    );

    const panel = $('#panel');
    panel.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (el) this.onPanelAction(el);
    });
    panel.addEventListener('change', (e) => this.onPanelChange(e.target as HTMLInputElement));
    $('#popover').addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (el) this.onPanelAction(el);
    });
    document.addEventListener('pointerdown', (e) => {
      const pop = $('#popover');
      if (!pop.hidden && !pop.contains(e.target as Node) && !(e.target as Element).closest('#score-overlay')) this.closePopover();
    });

    // keyboard
    document.addEventListener('keydown', (e) => {
      if (this.scan.isOpen) return;
      const target = e.target as HTMLElement;
      const typing = target.closest('input, select, textarea, [contenteditable]');
      if (e.key === 'Escape') this.closePopover();
      if (typing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (this.model && mod && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
        e.preventDefault();
        this.undoRedo(e.key === 'y' || e.shiftKey ? 'redo' : 'undo');
        return;
      }
      if (this.model && this.tab === 'edit' && !target.closest('[role=tab]')) {
        const durKeys: Record<string, number> = { '1': 1, '2': 2, '3': 4, '4': 8, '5': 16, '6': 32 };
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const d = e.key === 'ArrowUp' ? 1 : -1;
          if (mod) this.editPitch((p) => ({ ...p, octave: p.octave + d }));
          else this.editPitch((p, f) => stepPitch(p, d, f));
          return;
        }
        if (durKeys[e.key]) return this.editDuration(durKeys[e.key], null);
        if (e.key === '.') return this.editDuration(null, 'toggle');
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          const ref = this.currentRef();
          if (this.selectedId) this.applyEditOp({ kind: 'deleteNote', noteId: this.selectedId });
          else if (ref) this.applyEditOp({ kind: 'deleteBeat', ref }, false, true);
          return;
        }
        if (e.key === 'r' || e.key === 'R') {
          const ref = this.currentRef();
          if (ref) this.applyEditOp({ kind: 'makeRest', ref });
          return;
        }
        if (e.key === 'n' || e.key === 'N') return this.editInsert();
        if (e.key === '#') return this.editPitch((p) => ({ ...p, alter: 1 }));
        if (e.key === '-') return this.editPitch((p) => ({ ...p, alter: -1 }));
        if (e.key === '=') return this.editPitch((p) => ({ ...p, alter: 0 }));
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (target.closest('[role=tab]')) return;
        e.preventDefault();
        this.stepSelection(e.key === 'ArrowRight' ? 1 : -1);
      } else if (e.key === ' ' && !target.closest('button, a, [role=button]')) {
        e.preventDefault();
        if (this.render) this.api.playPause();
      }
    });
  }

  private syncLoopInputs(): void {
    const n = this.model?.measures.length ?? 1;
    const from = $<HTMLInputElement>('#loop-from');
    const to = $<HTMLInputElement>('#loop-to');
    from.max = to.max = String(n);
    from.value = String(this.loop.from);
    to.value = String(this.loop.to);
    $<HTMLInputElement>('#loop-on').checked = this.loop.on;
  }

  private updateToolbarState(): void {
    const hasChords = !!this.model && this.part.chords.some((c) => c.parsed);
    const accomp = $<HTMLInputElement>('#accomp');
    accomp.disabled = !hasChords;
    $<HTMLSelectElement>('#mix').disabled = !hasChords || !this.accompaniment;
  }

  private refreshTexts(): void {
    translateDom();
    $('#lang-btn').textContent = t('lang.switch');
    this.renderPanel();
    this.updateFretStatus();
  }

  private toastTimer = 0;
  toast(msg: string, error = false): void {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', error);
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), error ? 6000 : 3000);
  }
}
