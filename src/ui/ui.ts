// Toolbar, palette, wells, status readout. The UI's accent is the held element's
// color (--accent-l / --accent-r) — the chassis stays neutral, substances carry chroma.

import {
  E, B, ELEMENTS, REACT, REACT_COUNT, REACT_NAME, REACT_DT, PH, CONDUCTS,
  N_IDS, HOT_AT, HOT_TO, COLD_AT, COLD_TO, IGNITES_AT, FLAMMABLE, EXPLODE_R,
  REACT_BYPRODUCT, HAS_REACT,
  pairKey, type CustomSpec,
} from "../engine/elements";

export interface UiState {
  toolL: number;
  toolR: number;
  pen: number;
  speed: number;
  paused: boolean;
}

export interface UiHooks {
  onStep(): void;
  onClear(): void;
  onFit(): void;
  onBgMode(mode: number): void;
  onSlotSave(index: number, name: string): void;
  onSlotLoad(index: number): void;
  onSlotDelete(index: number): void;
  onExport(): void;
  onImport(): void;
  onCopyCode(): void;
  onPasteCode(): void;
  onCodeEntered(code: string): void;
  onSetting(key: "cvd" | "minimap" | "engine" | "telemetry", value: boolean | string): void;
  onKeyPaintToggle(): void;
  onHighlight(id: number): void;
  onTuneOpen(): void;
  onTune(key: string, value: number): void;
  onTuneReset(all: boolean): void;
  onSaveElement(index: number, spec: CustomSpec): void;
  onDeleteElement(index: number): void;
  onDemo(name: string): void;
  onUndo(): void;
  onRedo(): void;
  onRecord(): void;
  onGalleryOpen(): void;
  onGalleryUpload(name: string, author: string): void;
  onGalleryLoad(scene: GalleryScene): void;
  onGalleryDelete(stamp: string): void;
}

/** one gallery listing entry, as served by /api/gallery */
export interface GalleryScene {
  id: string;
  stamp: string;
  name: string;
  author: string;
  created: number;
  size: number;
  url: string;
  /** data URL, filled in after the listing renders */
  thumb?: string;
  /** true when this browser uploaded it and therefore may delete it */
  owned?: boolean;
}

/** pseudo-tool: click the canvas to (re)place the stickman */
export const TOOL_PLAYER = -2;
/** pseudo-tool: click the canvas to add an AI fighter */
export const TOOL_FIGHTER = -3;
/** pseudo-tool: drag to stir whatever movable matter is under the brush */
export const TOOL_STIR = -4;

export type PenMode = "free" | "line" | "rect";
/** brush nib: what one dab of the pen covers */
export type PenShape = "round" | "square" | "diamond" | "ring" | "spray";

// palette rails: explicit registry group, else derived from behavior/device
const RAIL_ORDER = ["SOLIDS", "LIQUIDS", "GASES", "METALS", "REAGENTS", "LIFE & ENERGY", "DEVICES"] as const;
const railOf = (el: (typeof ELEMENTS)[number]): string => {
  if (el.group === "HIDDEN") return "HIDDEN";
  if (el.group) return el.group;
  if (el.device) return "DEVICES";
  if (el.behavior === B.LIQUID) return "LIQUIDS";
  if (el.behavior === B.GAS) return "GASES";
  return "SOLIDS";
};
const RAILS = new Map<string, number[]>(RAIL_ORDER.map((r) => [r, []]));
RAILS.get("SOLIDS")!.push(E.WALL);
for (const el of ELEMENTS) {
  if (el.id === E.EMPTY || el.id === E.WALL) continue;
  RAILS.get(railOf(el))?.push(el.id);
}

/** Read a JSON value out of localStorage without letting a bad one kill the app.
 *  Seven call sites used to parse straight at boot, so a half-written value — a
 *  quota failure mid-write, a crashed tab, a stray extension — threw before the
 *  UI existed and left a permanently blank page with no way back short of
 *  devtools. A corrupt key is now dropped and reported instead. */
export function readJson<T>(key: string, fallback: T, ok?: (v: unknown) => boolean): T {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return fallback; // storage disabled entirely (private mode, blocked cookies)
  }
  if (raw === null) return fallback;
  try {
    const v = JSON.parse(raw) as T;
    if (v === null || v === undefined || (ok && !ok(v))) throw new Error("unusable shape");
    return v;
  } catch {
    console.warn(`[granulab] ${key} was unreadable and has been reset`);
    try { localStorage.removeItem(key); } catch { /* nothing else to try */ }
    return fallback;
  }
}

/** dates in the viewer's own locale and timezone — toISOString dated an
 *  11pm save as tomorrow */
const shortDate = (t: number): string =>
  new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(new Date(t));

/** every reaction in the table, once per pair (react() writes both directions) */
export interface Recipe {
  a: number;
  b: number;
  /** what each side turns into; equal to the reactant when it is unchanged */
  newA: number;
  newB: number;
  /** third product vented to a free neighbour, 0 = none */
  extra: number;
  p: number;
  dT: number;
  name: string;
}

let recipeCache: Recipe[] | null = null;

/** Walk REACT once and keep one entry per unordered pair. Custom elements can
 *  add rows at runtime, so the cache is dropped whenever one is registered. */
export function allRecipes(): Recipe[] {
  if (recipeCache) return recipeCache;
  const out: Recipe[] = [];
  for (let a = E.WALL + 1; a < ELEMENTS.length; a++) {
    for (let b = a; b < ELEMENTS.length; b++) {
      const r = REACT[a * N_IDS + b];
      if (r === 0) continue;
      const k = pairKey(a, b);
      out.push({
        a, b,
        newA: (r >>> 8) & 255,
        newB: r & 255,
        extra: REACT_BYPRODUCT[k] ?? 0,
        p: (r >>> 16) & 255,
        dT: REACT_DT[k],
        name: REACT_NAME[k] ?? `${ELEMENTS[a]?.name ?? a} + ${ELEMENTS[b]?.name ?? b}`,
      });
    }
  }
  out.sort((x, z) => x.name.localeCompare(z.name));
  recipeCache = out;
  return out;
}

export function dropRecipeCache(): void {
  recipeCache = null;
}

/** everything that yields `id`: reaction rows, third products, and the thermal
 *  transitions, which is how Glass and Steam and Stone actually come about */
function makersOf(id: number): { parts: (number | string)[] }[] {
  const out: { parts: (number | string)[] }[] = [];
  const seen = new Set<string>();
  const add = (parts: (number | string)[]): void => {
    const key = parts.join("|");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ parts });
  };
  for (const r of allRecipes()) {
    // a row that merely leaves the element alone is not a recipe for it
    const makesA = r.newA === id && r.a !== id;
    const makesB = r.newB === id && r.b !== id;
    if (makesA || makesB || r.extra === id) add([r.a, r.b]);
  }
  for (let x = E.WALL + 1; x < ELEMENTS.length; x++) {
    if (HOT_TO[x] === id) add([x, `≥ ${HOT_AT[x]}°`]);
    if (COLD_TO[x] === id) add([x, `≤ ${COLD_AT[x]}°`]);
  }
  return out;
}

export class Ui {
  state: UiState & { penMode: PenMode; penShape: PenShape } = {
    toolL: E.POWDER, toolR: E.EMPTY, pen: 6, speed: 1, paused: false,
    penMode: "free", penShape: "round",
  };

  /** one id can have two buttons: its home rail and the RECENT rail */
  private buttons = new Map<number, HTMLButtonElement[]>();
  private rails: { label: HTMLElement; host: HTMLElement }[] = [];
  private recentHost!: HTMLElement;
  private recent: number[] = readJson<number[]>("granulab-recent", [], Array.isArray);
  private filterInput!: HTMLInputElement;
  private filterCount!: HTMLElement;
  private noMatch!: HTMLElement;
  private propHint!: HTMLElement;
  private addButtonFn!: (host: HTMLElement, id: number) => void;
  private customHost!: HTMLElement;
  private newElBtn!: HTMLButtonElement;
  private playBtn!: HTMLButtonElement;
  private penOut!: HTMLOutputElement;
  private penInput!: HTMLInputElement;
  private wellL!: HTMLElement;
  private wellR!: HTMLElement;
  private statFps!: HTMLElement;
  private statTick!: HTMLElement;
  private statDots!: HTMLElement;
  private statChunks!: HTMLElement;
  private statPos!: HTMLElement;
  private statZoom!: HTMLElement;
  private probeWhat!: HTMLElement;
  private probeSw!: HTMLElement;
  private probeName!: HTMLElement;
  private probeTemp!: HTMLElement;
  private probeAir!: HTMLElement;
  private probePress!: HTMLElement;
  private probePh!: HTMLElement;
  private reagentCard!: HTMLElement;

  constructor(root: HTMLElement, private hooks: UiHooks) {
    root.innerHTML = `
      <a class="skip" href="#dish">Skip the palette, go to the canvas</a>
      <header>
        <h1 class="wordmark">GRANULAB<small>granular matter laboratory</small></h1>
        <button id="railtoggle" aria-expanded="false" aria-controls="side"
                aria-label="Show the element palette">elements</button>
        <div class="transport">
          <div class="grp" role="group" aria-label="Run">
            <button id="play" class="primary" title="Play or pause (Space)">pause</button>
            <button id="stepb" title="Advance one frame (Enter)">step</button>
            <select id="speed" title="Simulation speed" aria-label="Simulation speed">
              <option value="0.1">0.1×</option>
              <option value="0.25">0.25×</option>
              <option value="0.5">0.5×</option>
              <option value="1" selected>1×</option>
              <option value="2">2×</option>
              <option value="4">4×</option>
            </select>
          </div>
          <div class="grp" role="group" aria-label="Edit">
            <button id="undo" title="Undo the last edit (Ctrl+Z)" disabled>undo</button>
            <button id="redo" title="Redo (Ctrl+Shift+Z)" disabled>redo</button>
            <button id="clear" title="Empty the grid">clear</button>
          </div>
          <div class="grp" role="group" aria-label="Pen">
            <select id="penshape" title="Brush nib shape" aria-label="Brush nib shape">
              <option value="round" selected>nib: round</option>
              <option value="square">nib: square</option>
              <option value="diamond">nib: diamond</option>
              <option value="ring">nib: ring</option>
              <option value="spray">nib: spray</option>
            </select>
            <select id="penmode" title="Pen mode" aria-label="Pen mode">
              <option value="free" selected>pen: free</option>
              <option value="line">pen: line</option>
              <option value="rect">pen: rect</option>
            </select>
            <button id="kbdbtn" aria-pressed="false" title="Paint with the keyboard (K)">kbd</button>
          </div>
          <div class="grp" role="group" aria-label="View">
            <select id="bg" title="Background render mode" aria-label="Background render mode">
              <option value="0" selected>bg: none</option>
              <option value="1">bg: air</option>
              <option value="2">bg: gray</option>
              <option value="3">bg: dark</option>
              <option value="4">bg: silhouet</option>
              <option value="5">bg: TG</option>
              <option value="6">bg: toon</option>
              <option value="7">bg: rx glow</option>
              <option value="8">bg: pH</option>
            </select>
            <button id="fit" title="Reset zoom and pan">fit</button>
          </div>
          <div class="grp" role="group" aria-label="Scene">
            <select id="demosel" title="Load a prebuilt scene" aria-label="Load a prebuilt demo scene">
              <option value="" selected disabled>demo…</option>
              <option value="sandbox">demo: sandbox</option>
              <option value="chem">demo: chem lab</option>
              <option value="range">demo: weapons range</option>
              <option value="doom">demo: doomsday</option>
              <option value="alchemy">demo: alchemy</option>
              <option value="cryo">demo: cryo works</option>
              <option value="boiler">demo: boiler room</option>
              <option value="cannon">demo: pressure guns</option>
              <option value="machines">demo: machines</option>
              <option value="sculpture">demo: sculpture garden</option>
            </select>
            <div class="menuwrap">
              <button id="scenebtn" aria-haspopup="menu" aria-expanded="false" aria-controls="scenemenu"
                      title="Save, share and record this scene">scene ▾</button>
              <div id="scenemenu" class="menu" role="menu" hidden>
                <button type="button" role="menuitem" data-act="slots">Save slots…</button>
                <button type="button" role="menuitem" data-act="export">Export a .grn file</button>
                <button type="button" role="menuitem" data-act="import">Open a .grn file</button>
                <hr>
                <button type="button" role="menuitem" data-act="copy">Copy share code</button>
                <button type="button" role="menuitem" data-act="paste">Paste share code</button>
                <hr>
                <button type="button" role="menuitem" data-act="gallery">Scene gallery…</button>
                <button type="button" role="menuitem" data-act="rec" id="recitem">Record video</button>
                <hr>
                <button type="button" role="menuitem" data-act="settings">Settings…</button>
              </div>
            </div>
            <button id="rec" title="Stop recording and download the clip" hidden>stop</button>
            <button id="nblog" title="Lab notebook — every reaction you've made happen">log</button>
            <button id="helpbtn" title="Controls and shortcuts (?)" aria-label="Controls and shortcuts">?</button>
          </div>
        </div>
        <div class="wells">
          <div class="well left"><span class="dot"></span>L <b id="wellL">Powder</b></div>
          <div class="well right"><span class="dot"></span>R <b id="wellR">Erase</b></div>
        </div>
        <label class="pen">pen
          <input id="pen" type="range" min="1" max="48" value="6" title="Pen size (keys 1–9, 0)">
          <output id="penout">6</output>
        </label>
      </header>
      <aside id="side">
        <div class="railsearch">
          <input id="elfilter" type="text" placeholder="filter elements…" aria-label="Filter elements by name or group"
                 autocomplete="off" autocorrect="off" spellcheck="false">
          <span id="elcount" aria-live="polite"></span>
        </div>
        <div id="rails" translate="no"></div>
        <p id="prophint" hidden></p>
        <p id="norail" hidden>Nothing matches. Try a name, a rail, or a property
          — burns, conducts, explodes, melts, freezes, acid, base, reacts, inert.</p>
      </aside>
      <dialog id="eldialog" aria-labelledby="eltitle">
        <form method="dialog" id="elform">
          <h2 id="eltitle">New element</h2>
          <p class="dlg-note" id="elnote" hidden></p>
          <div class="grid2">
            <label>name <input name="name" maxlength="12" required></label>
            <label>color <input name="color" type="color" value="#8ad0c0"></label>
            <label>state <select name="state">
              <option value="powder" selected>powder</option>
              <option value="liquid">liquid</option>
              <option value="gas">gas</option>
              <option value="static">static</option>
            </select></label>
            <label>density <input name="density" type="number" value="60" min="1" max="200"></label>
            <label>flammable <input name="flammable" type="number" value="0" min="0" max="255"></label>
            <label>blast radius <input name="explodeR" type="number" value="0" min="0" max="16"></label>
            <label>own temp °C <input name="temp0" type="number" value="20" min="-50" max="1000"></label>
            <label>heat pump <input name="pump" type="number" value="0" min="0" max="0.35" step="0.05"></label>
            <label>hot at °C <input name="hotAt" type="number" placeholder="never"></label>
            <label>turns into <select name="hotTo" data-targets></select></label>
            <label>cold at °C <input name="coldAt" type="number" placeholder="never"></label>
            <label>turns into <select name="coldTo" data-targets></select></label>
            <label>ignites at °C <input name="ignitesAt" type="number" placeholder="never"></label>
          </div>
          <div class="rxhead"><span>reactions</span><button type="button" id="addrx">+ row</button></div>
          <div class="rxcols"><span>reacts with</span><span>self becomes</span><span>partner becomes</span><span>p/256</span><span></span></div>
          <div id="rxrows"></div>
          <menu>
            <button value="cancel" formnovalidate>cancel</button>
            <button value="ok" class="primary" id="elsave">create</button>
          </menu>
        </form>
      </dialog>
      <dialog id="gallerydialog" aria-labelledby="galtitle">
        <form method="dialog" id="galleryform">
          <h2 id="galtitle">Scene gallery</h2>
          <div class="gal-upload">
            <input id="galname" name="gname" maxlength="40" placeholder="scene name" required aria-label="Scene name" autocomplete="off" spellcheck="false">
            <input id="galauthor" name="gauthor" maxlength="24" placeholder="by (optional)" aria-label="Your name, optional" autocomplete="nickname" spellcheck="false">
            <button value="upload" class="primary">upload current scene</button>
          </div>
          <div class="gal-status" id="galstatus" aria-live="polite" hidden></div>
          <div class="gal-count" id="galcount" aria-live="polite"></div>
          <div id="gallist"><div class="gal-empty">loading…</div></div>
          <menu>
            <button value="close" formnovalidate>close</button>
          </menu>
        </form>
      </dialog>
      <dialog id="slotdialog" aria-labelledby="slottitle">
        <form method="dialog" id="slotform">
          <h2 id="slottitle">Save slots</h2>
          <p class="dlg-note">Six scenes, kept in this browser. To move one somewhere else, export a
            .grn file or copy a share code.</p>
          <div id="slotlist"></div>
          <menu><button value="close" formnovalidate>close</button></menu>
        </form>
      </dialog>
      <dialog id="rxdialog" aria-labelledby="rxtitle">
        <form method="dialog">
          <h2 id="rxtitle">Reaction index</h2>
          <p class="dlg-note">Every reaction the simulation knows, whether or not you have made it
            happen. The notebook tracks the ones you have.</p>
          <div class="railsearch rxsearch">
            <input id="rxfilter" type="text" placeholder="filter by element or reaction…"
                   aria-label="Filter reactions" autocomplete="off" spellcheck="false">
            <span id="rxcount"></span>
          </div>
          <div id="rxlist"></div>
          <menu><button value="close" class="primary" formnovalidate>close</button></menu>
        </form>
      </dialog>
      <dialog id="setdialog" aria-labelledby="settitle">
        <form method="dialog">
          <h2 id="settitle">Settings</h2>
          <label class="setrow">
            <input type="checkbox" id="setcvd">
            <span><b>Colour-blind assist</b><em>Letters on the palette swatches, and a blue-to-yellow
              pH scale instead of red-to-green.</em></span>
          </label>
          <label class="setrow">
            <input type="checkbox" id="settel" checked>
            <span><b>Performance readout</b><em>fps, tick cost, dot and chunk counts in the status
              bar. Off leaves the cell probe more room.</em></span>
          </label>
          <label class="setrow">
            <input type="checkbox" id="setmini" checked>
            <span><b>Minimap</b><em>The overview in the corner. Click it to jump the view.</em></span>
          </label>
          <label class="setrow">
            <span class="setsel"><b>Engine</b><em>WASM is the default and about twice as fast. Both
              produce identical simulations.</em></span>
            <select id="setengine" aria-label="Simulation engine">
              <option value="wasm">WASM</option>
              <option value="ts">TypeScript</option>
            </select>
          </label>
          <menu><button value="close" class="primary" formnovalidate>done</button></menu>
        </form>
      </dialog>
      <dialog id="tunedialog" aria-labelledby="tunetitle">
        <form method="dialog">
          <h2 id="tunetitle">Tune <span id="tunename"></span></h2>
          <p class="dlg-note">Changes take effect immediately and stick in this browser. They are not
            carried by saves or share codes — a scene you send someone runs on their settings.</p>
          <div id="tunerows"></div>
          <menu>
            <button type="button" id="tunereset">reset this element</button>
            <button type="button" id="tuneresetall">reset everything</button>
            <button value="close" class="primary" formnovalidate>done</button>
          </menu>
        </form>
      </dialog>
      <dialog id="customdialog" aria-labelledby="customtitle">
        <form method="dialog">
          <h2 id="customtitle">Your elements</h2>
          <p class="dlg-note">Editing or deleting reloads the page so the registry rebuilds cleanly.
            The scene on the grid is kept.</p>
          <div id="customlist"></div>
          <menu><button value="close" formnovalidate>close</button></menu>
        </form>
      </dialog>
      <dialog id="codedialog" aria-labelledby="codetitle">
        <form method="dialog" id="codeform">
          <h2 id="codetitle">Share code</h2>
          <p class="dlg-note" id="codenote">Paste a code someone sent you. It carries the whole
            scene, including any elements they invented.</p>
          <textarea id="codebox" rows="4" spellcheck="false" autocomplete="off"
                    aria-label="Scene share code" placeholder="GLAB1.…"></textarea>
          <menu>
            <button value="cancel" formnovalidate>cancel</button>
            <button value="load" class="primary" id="codego">load scene</button>
          </menu>
        </form>
      </dialog>
      <dialog id="helpdialog" aria-labelledby="helptitle">
        <form method="dialog">
          <h2 id="helptitle">Controls</h2>
          <div class="keycols">
            <section>
              <h3>Simulation</h3>
              <dl>
                <div><dt><kbd>Space</kbd></dt><dd>play or pause</dd></div>
                <div><dt><kbd>Enter</kbd></dt><dd>advance one frame</dd></div>
                <div><dt><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd></dt><dd>walk the stickman</dd></div>
              </dl>
              <h3>Editing</h3>
              <dl>
                <div><dt><kbd>Ctrl</kbd><kbd>Z</kbd></dt><dd>undo, 24 deep</dd></div>
                <div><dt><kbd>Ctrl</kbd><kbd>⇧</kbd><kbd>Z</kbd></dt><dd>redo</dd></div>
              </dl>
            </section>
            <section>
              <h3>Pen</h3>
              <dl>
                <div><dt><kbd>1</kbd>–<kbd>9</kbd></dt><dd>pen size 1 to 32</dd></div>
                <div><dt><kbd>0</kbd></dt><dd>pen size 48</dd></div>
                <div><dt><kbd>[</kbd><kbd>]</kbd></dt><dd>pen size one at a time</dd></div>
                <div><dt><kbd>/</kbd></dt><dd>filter the elements</dd></div>
                <div><dt><kbd>T</kbd></dt><dd>tune the held element</dd></div>
                <div><dt><kbd>K</kbd></dt><dd>paint with the keyboard</dd></div>
                <div><dt><kbd>?</kbd></dt><dd>this panel</dd></div>
              </dl>
              <h3>View</h3>
              <dl>
                <div><dt><kbd>+</kbd><kbd>-</kbd></dt><dd>zoom in and out</dd></div>
                <div><dt><kbd>F</kbd></dt><dd>fit the whole grid</dd></div>
                <div><dt><kbd>⇧</kbd>+arrows</dt><dd>pan the view</dd></div>
              </dl>
              <h3>Keyboard painting <kbd>K</kbd></h3>
              <dl>
                <div><dt>arrows</dt><dd>move the cursor a nib at a time</dd></div>
                <div><dt><kbd>⇧</kbd>+arrows</dt><dd>move one cell</dd></div>
                <div><dt><kbd>Enter</kbd></dt><dd>paint a dab</dd></div>
                <div><dt><kbd>⇧</kbd><kbd>Enter</kbd></dt><dd>dab the right-hand element</dd></div>
              </dl>
              <h3>Pointer</h3>
              <dl>
                <div><dt>left</dt><dd>paint the left-hand element</dd></div>
                <div><dt>right</dt><dd>paint the right-hand one</dd></div>
                <div><dt><kbd>Alt</kbd>+click</dt><dd>pick up what is already there</dd></div>
                <div><dt>Stir tool</dt><dd>drag to mix a beaker's contents</dd></div>
                <div><dt>space drag</dt><dd>pan, on any mouse or trackpad</dd></div>
                <div><dt>middle drag</dt><dd>pan the view</dd></div>
                <div><dt>wheel</dt><dd>zoom</dd></div>
                <div><dt>two fingers</dt><dd>pinch to zoom, drag to pan</dd></div>
              </dl>
            </section>
          </div>
          <p class="dlg-note">In the palette, click an element to hold it on the left button and
            right-click to hold it on the right; the arrow keys walk the rails once one is focused.
            Fans, cannons and lasers aim along the direction you drag while painting them. Click the
            minimap to jump the view. Colour-blind assist and the engine choice live under
            scene → settings.</p>
          <p class="dlg-note">The palette filter takes properties as well as names —
            <b>burns</b>, <b>conducts</b>, <b>explodes</b>, <b>melts</b>, <b>freezes</b>, <b>acid</b>,
            <b>base</b>, <b>reacts</b>, <b>inert</b> — and the card in the corner says both what the
            held element does and what it is made from. For everything the simulation can react,
            open the lab notebook and hit <b>index</b>.</p>
          <menu><button value="close" class="primary">close</button></menu>
        </form>
      </dialog>
      <main><canvas id="dish" tabindex="-1" aria-label="Simulation grid — paint with the left and right mouse buttons"></canvas>
        <!-- not a live region: it rewrites every reaction row each time you pick
             an element, and reading thirty rows aloud per click helps nobody -->
        <div id="reagent" aria-live="off" hidden></div>
        <div id="emptyhint" hidden><b>EMPTY GRID</b>Pick an element on the left, then drag here.<br>Hover any cell to read its temperature, oxygen and pH.</div>
        <div id="intro" hidden>
          <h2>Start here</h2>
          <ul>
            <li>Left button paints, right button erases.</li>
            <li>Pick what you paint from the rails on the left — <kbd>/</kbd> filters them.</li>
            <li><kbd>Space</kbd> pauses, <kbd>Enter</kbd> steps one frame.</li>
          </ul>
          <div class="introbtns">
            <button type="button" id="introdemo" class="primary">Load a demo scene</button>
            <button type="button" id="introhelp">All controls</button>
            <button type="button" id="introclose">Dismiss</button>
          </div>
        </div>
        <div id="toasts" role="status" aria-live="polite"></div>
        <div id="notebook" hidden>
          <div class="nb-head">
            <div class="nb-tabs" role="tablist" aria-label="Lab panel">
              <button role="tab" id="tab-rx" aria-controls="nbrows" aria-selected="true">reactions</button>
              <button role="tab" id="tab-legend" aria-controls="nblegend" aria-selected="false">contents</button>
            </div>
            <button id="nbclose" title="Close the panel" aria-label="Close the panel">×</button>
          </div>
          <div class="nb-tools" id="nbtools">
            <select id="nbsort" aria-label="Sort the notebook" title="Sort the notebook">
              <option value="recent" selected>latest first</option>
              <option value="count">most reactions</option>
              <option value="name">by name</option>
            </select>
            <button id="nbindex" title="Every reaction in the table, not just the ones you have seen">index</button>
            <button id="nbclear" title="Start a fresh page — only reactions from now on"
                    aria-label="Start a fresh page">clear</button>
          </div>
          <div id="nbrows" role="tabpanel" aria-labelledby="tab-rx"><div class="nb-empty">No reactions witnessed yet — mix something.</div></div>
          <div id="nblegend" role="tabpanel" aria-labelledby="tab-legend" hidden></div>
        </div>
      </main>
      <footer>
        <span class="telemetry">fps <b id="s-fps">–</b></span>
        <span class="telemetry">tick <b id="s-tick">–</b> ms</span>
        <span class="telemetry">dots <b id="s-dots">0</b></span>
        <span class="telemetry">chunks <b id="s-chunks">–</b></span>
        <span>zoom <b id="s-zoom">1.0×</b></span>
        <span class="spacer"></span>
        <div id="probe" aria-live="off" translate="no">
          <span id="s-pos" class="ch pos">–</span>
          <span id="s-what" class="ch what"><i class="rsw" hidden></i><b></b></span>
          <span id="s-temp" class="ch"></span>
          <span id="s-air" class="ch"></span>
          <span id="s-press" class="ch"></span>
          <span id="s-ph" class="ch"></span>
        </div>
      </footer>`;

    const addButton = (host: HTMLElement, id: number): void => {
      const el = ELEMENTS[id];
      const label = id === TOOL_PLAYER ? "Player" : id === TOOL_FIGHTER ? "Fighter"
        : id === TOOL_STIR ? "Stir" : id === E.EMPTY ? "Erase" : el.name;
      const sw = id === TOOL_PLAYER ? "#ffe94a" : id === TOOL_FIGHTER ? "#c05ac0"
        : id === TOOL_STIR ? "conic-gradient(from 0deg,#7ab8c8,#e0a8c8,#7ab8c8)"
        : id === E.EMPTY ? "transparent" : el.color;
      const btn = document.createElement("button");
      btn.className = "el";
      btn.innerHTML = `<span class="sw" style="background:${sw};${id === E.EMPTY ? "border:1px solid var(--hairline)" : ""}"></span>${label}`;
      btn.title = `${label} — click to hold on the left button, right-click for the right`;
      btn.setAttribute("aria-label", label);
      btn.dataset.name = label.toLowerCase();
      btn.dataset.id = String(id);
      btn.addEventListener("click", () => this.bind("L", id));
      btn.addEventListener("contextmenu", (e) => { e.preventDefault(); this.bind("R", id); });
      host.appendChild(btn);
      const list = this.buttons.get(id);
      if (list) list.push(btn);
      else this.buttons.set(id, [btn]);
    };
    const aside = root.querySelector<HTMLElement>("#rails")!;
    const makeRail = (label: string): HTMLElement => {
      const lab = document.createElement("div");
      lab.className = "rail-label";
      lab.textContent = label;
      const pal = document.createElement("div");
      pal.className = "palette";
      pal.dataset.rail = label.toLowerCase();
      aside.appendChild(lab);
      aside.appendChild(pal);
      this.rails.push({ label: lab, host: pal });
      return pal;
    };
    this.recentHost = makeRail("RECENT");
    for (const rail of RAIL_ORDER) {
      const ids = RAILS.get(rail)!;
      if (ids.length === 0) continue;
      const host = makeRail(rail);
      for (const id of ids) addButton(host, id);
    }
    const customHost = makeRail("CUSTOM");
    const tools = makeRail("TOOLS");
    addButton(tools, E.EMPTY);
    addButton(tools, TOOL_STIR);
    addButton(tools, TOOL_PLAYER);
    addButton(tools, TOOL_FIGHTER);
    this.addButtonFn = addButton;
    this.customHost = customHost;
    const newBtn = document.createElement("button");
    newBtn.className = "el";
    newBtn.innerHTML = `<span class="sw" style="background:linear-gradient(45deg,#e84a9a,#7ab8c8)"></span>+ New…`;
    const dialog = root.querySelector<HTMLDialogElement>("#eldialog")!;
    this.customHost.appendChild(newBtn);
    this.newElBtn = newBtn;
    // transition-target dropdowns: base elements only
    const targetOptions = ELEMENTS.filter((el) => el.id > E.WALL && el.id !== E.STICK)
      .map((el) => `<option value="${el.id}">${el.name}</option>`).join("");
    for (const sel of dialog.querySelectorAll<HTMLSelectElement>("select[data-targets]")) {
      sel.innerHTML = `<option value="0">—</option>` + targetOptions;
    }
    // reaction rows: dynamic list, each row is one REACT table entry
    const rxRows = dialog.querySelector<HTMLElement>("#rxrows")!;
    const morphOptions = `<option value="-1">unchanged</option><option value="0">vanish</option>` + targetOptions;
    const addRxRow = (): void => {
      if (rxRows.children.length >= 6) return;
      const row = document.createElement("div");
      row.className = "rrow";
      row.innerHTML = `
        <select data-rw aria-label="Reacts with"><option value="0">—</option>${targetOptions}</select>
        <select data-rs aria-label="This element becomes">${morphOptions}</select>
        <select data-ro aria-label="The partner becomes">${morphOptions}</select>
        <input data-rp type="number" value="60" min="1" max="255" aria-label="Chance out of 256">
        <button type="button" class="rxdel" title="Remove this reaction row" aria-label="Remove this reaction row">×</button>`;
      row.querySelector(".rxdel")!.addEventListener("click", () => row.remove());
      rxRows.appendChild(row);
    };
    dialog.querySelector("#addrx")!.addEventListener("click", addRxRow);
    this.elDialog = dialog;
    this.rxRows = rxRows;
    this.addRxRow = addRxRow;
    newBtn.addEventListener("click", () => this.openMaker(null, -1));
    // a rail you can only ever add to is a dead end: 19 slots, and no way back
    // out of an element that turned out wrong
    const manageBtn = document.createElement("button");
    manageBtn.className = "el manage";
    manageBtn.dataset.name = "manage";
    manageBtn.innerHTML = `<span class="sw" style="background:var(--hairline)"></span>Manage…`;
    manageBtn.addEventListener("click", () => this.customDialog.showModal());
    this.customHost.appendChild(manageBtn);
    this.manageBtn = manageBtn;
    this.customDialog = root.querySelector<HTMLDialogElement>("#customdialog")!;
    this.customList = root.querySelector<HTMLElement>("#customlist")!;
    // create on submit, not on dialog "close" — embedded browsers can drop the
    // close event entirely; submit + e.submitter is reliable everywhere
    const elform = root.querySelector<HTMLFormElement>("#elform")!;
    elform.addEventListener("submit", (e) => {
      if ((e.submitter as HTMLButtonElement | null)?.value !== "ok") return;
      const f = new FormData(elform);
      const num = (k: string): number | undefined => {
        const v = String(f.get(k) ?? "").trim();
        return v === "" ? undefined : Number(v);
      };
      const hotTo = Number(f.get("hotTo"));
      const coldTo = Number(f.get("coldTo"));
      const reactions: NonNullable<CustomSpec["reactions"]> = [];
      for (const row of rxRows.querySelectorAll<HTMLElement>(".rrow")) {
        const w = Number(row.querySelector<HTMLSelectElement>("[data-rw]")!.value);
        if (w <= 0) continue;
        reactions.push({
          with: w,
          becomeSelf: Number(row.querySelector<HTMLSelectElement>("[data-rs]")!.value),
          becomeOther: Number(row.querySelector<HTMLSelectElement>("[data-ro]")!.value),
          p: Number(row.querySelector<HTMLInputElement>("[data-rp]")!.value) || 60,
        });
      }
      hooks.onSaveElement(this.makerIndex, {
        name: String(f.get("name")),
        color: String(f.get("color")),
        state: String(f.get("state")) as CustomSpec["state"],
        density: num("density"),
        flammable: num("flammable"),
        explodeR: num("explodeR"),
        temp0: num("temp0"),
        pump: num("pump"),
        hotAt: hotTo ? num("hotAt") : undefined,
        hotTo: num("hotAt") !== undefined ? hotTo : 0,
        coldAt: coldTo ? num("coldAt") : undefined,
        coldTo: num("coldAt") !== undefined ? coldTo : 0,
        ignitesAt: num("ignitesAt"),
        reactions: reactions.length ? reactions : undefined,
      });
    });

    this.playBtn = root.querySelector("#play")!;
    this.penOut = root.querySelector("#penout")!;
    this.penInput = root.querySelector("#pen")!;
    this.wellL = root.querySelector("#wellL")!;
    this.wellR = root.querySelector("#wellR")!;
    this.statFps = root.querySelector("#s-fps")!;
    this.statTick = root.querySelector("#s-tick")!;
    this.statDots = root.querySelector("#s-dots")!;
    this.statChunks = root.querySelector("#s-chunks")!;
    this.statPos = root.querySelector("#s-pos")!;
    this.statZoom = root.querySelector("#s-zoom")!;
    this.probeWhat = root.querySelector("#s-what")!;
    this.probeSw = this.probeWhat.querySelector("i")!;
    this.probeName = this.probeWhat.querySelector("b")!;
    this.probeTemp = root.querySelector("#s-temp")!;
    this.probeAir = root.querySelector("#s-air")!;
    this.probePress = root.querySelector("#s-press")!;
    this.probePh = root.querySelector("#s-ph")!;

    this.playBtn.addEventListener("click", () => this.setPaused(!this.state.paused));
    root.querySelector("#stepb")!.addEventListener("click", () => hooks.onStep());
    root.querySelector("#clear")!.addEventListener("click", () => hooks.onClear());
    root.querySelector("#fit")!.addEventListener("click", () => hooks.onFit());
    root.querySelector<HTMLSelectElement>("#speed")!.addEventListener("change", (e) => {
      this.state.speed = parseFloat((e.target as HTMLSelectElement).value);
    });
    root.querySelector<HTMLSelectElement>("#bg")!.addEventListener("change", (e) => {
      hooks.onBgMode(parseInt((e.target as HTMLSelectElement).value));
    });
    // "scene" menu: the occasional jobs — files, codes, slots, gallery, video —
    // folded off the instrument face so the row you use every minute stays short
    this.sceneBtn = root.querySelector<HTMLButtonElement>("#scenebtn")!;
    this.sceneMenu = root.querySelector<HTMLElement>("#scenemenu")!;
    this.recItem = root.querySelector<HTMLButtonElement>("#recitem")!;
    this.sceneBtn.addEventListener("click", () => this.toggleSceneMenu(this.sceneMenu.hidden));
    this.sceneMenu.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (!act) return;
      this.toggleSceneMenu(false);
      if (act === "slots") this.openSlots();
      else if (act === "export") hooks.onExport();
      else if (act === "import") hooks.onImport();
      else if (act === "copy") hooks.onCopyCode();
      else if (act === "paste") hooks.onPasteCode();
      else if (act === "gallery") this.openGallery();
      else if (act === "rec") hooks.onRecord();
      else if (act === "settings") this.setDialog.showModal();
    });
    document.addEventListener("pointerdown", (e) => {
      const inMenu = (e.target as Element | null)?.closest?.(".menuwrap");
      if (!this.sceneMenu.hidden && !inMenu) this.toggleSceneMenu(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.sceneMenu.hidden) { this.toggleSceneMenu(false); this.sceneBtn.focus(); }
    });
    root.querySelector<HTMLSelectElement>("#penshape")!.addEventListener("change", (e) => {
      this.state.penShape = (e.target as HTMLSelectElement).value as PenShape;
    });
    root.querySelector<HTMLSelectElement>("#penmode")!.addEventListener("change", (e) => {
      this.state.penMode = (e.target as HTMLSelectElement).value as PenMode;
    });
    root.querySelector<HTMLSelectElement>("#demosel")!.addEventListener("change", (e) => {
      const sel = e.target as HTMLSelectElement;
      const name = sel.value;
      // snap back to the placeholder: a native select fires no change when you
      // re-pick the option it already holds, so leaving it set meant a scene you
      // were already in could never be restarted
      sel.value = "";
      if (name) hooks.onDemo(name);
    });
    this.setDialog = root.querySelector<HTMLDialogElement>("#setdialog")!;
    const cvd = root.querySelector<HTMLInputElement>("#setcvd")!;
    const miniBox = root.querySelector<HTMLInputElement>("#setmini")!;
    const engineSel = root.querySelector<HTMLSelectElement>("#setengine")!;
    const telBox = root.querySelector<HTMLInputElement>("#settel")!;
    telBox.addEventListener("change", () => { this.setTelemetry(telBox.checked); hooks.onSetting("telemetry", telBox.checked); });
    cvd.addEventListener("change", () => { this.setCvd(cvd.checked); hooks.onSetting("cvd", cvd.checked); });
    miniBox.addEventListener("change", () => hooks.onSetting("minimap", miniBox.checked));
    engineSel.addEventListener("change", () => hooks.onSetting("engine", engineSel.value));
    this.setBoxes = { cvd, minimap: miniBox, engine: engineSel, telemetry: telBox };
    this.emptyHint = root.querySelector<HTMLElement>("#emptyhint")!;
    this.toastHost = root.querySelector<HTMLElement>("#toasts")!;
    this.tuneDialog = root.querySelector<HTMLDialogElement>("#tunedialog")!;
    this.tuneRows = root.querySelector<HTMLElement>("#tunerows")!;
    this.tuneName = root.querySelector<HTMLElement>("#tunename")!;
    this.kbdBtn = root.querySelector<HTMLButtonElement>("#kbdbtn")!;
    this.kbdBtn.addEventListener("click", () => hooks.onKeyPaintToggle());
    root.querySelector("#tunereset")!.addEventListener("click", () => hooks.onTuneReset(false));
    root.querySelector("#tuneresetall")!.addEventListener("click", () => hooks.onTuneReset(true));
    this.codeDialog = root.querySelector<HTMLDialogElement>("#codedialog")!;
    this.codeBox = root.querySelector<HTMLTextAreaElement>("#codebox")!;
    this.codeNote = root.querySelector<HTMLElement>("#codenote")!;
    this.codeGo = root.querySelector<HTMLButtonElement>("#codego")!;
    // submit + e.submitter, never the dialog "close" event (M4.3 rule)
    root.querySelector<HTMLFormElement>("#codeform")!.addEventListener("submit", (e) => {
      if ((e.submitter as HTMLButtonElement | null)?.value !== "load") return;
      hooks.onCodeEntered(this.codeBox.value);
    });
    this.reagentCard = root.querySelector<HTMLElement>("#reagent")!;
    this.notebook = root.querySelector<HTMLElement>("#notebook")!;
    this.nbRowsHost = root.querySelector<HTMLElement>("#nbrows")!;
    this.nbBtn = root.querySelector<HTMLButtonElement>("#nblog")!;
    this.nbBtn.addEventListener("click", () => {
      this.notebook.hidden = !this.notebook.hidden;
      if (!this.notebook.hidden) {
        this.nbFresh = 0;
        this.nbBtn.classList.remove("attn");
        this.nbBtn.textContent = "log";
      }
    });
    root.querySelector("#nbclose")!.addEventListener("click", () => { this.notebook.hidden = true; });
    this.legendHost = root.querySelector<HTMLElement>("#nblegend")!;
    const tabRx = root.querySelector<HTMLButtonElement>("#tab-rx")!;
    const tabLg = root.querySelector<HTMLButtonElement>("#tab-legend")!;
    const nbTools = root.querySelector<HTMLElement>("#nbtools")!;
    const showTab = (legend: boolean): void => {
      this.legendHost.hidden = !legend;
      this.nbRowsHost.hidden = legend;
      nbTools.hidden = legend; // sort/index/clear only mean anything for reactions
      tabRx.setAttribute("aria-selected", String(!legend));
      tabLg.setAttribute("aria-selected", String(legend));
      tabRx.tabIndex = legend ? -1 : 0;
      tabLg.tabIndex = legend ? 0 : -1;
    };
    tabRx.addEventListener("click", () => showTab(false));
    tabLg.addEventListener("click", () => showTab(true));
    for (const [tab, other, legend] of [[tabRx, tabLg, false], [tabLg, tabRx, true]] as const) {
      tab.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        showTab(!legend);
        other.focus();
      });
    }
    root.querySelector("#nbclear")!.addEventListener("click", () => this.clearNotebook());
    this.rxDialog = root.querySelector<HTMLDialogElement>("#rxdialog")!;
    this.rxList = root.querySelector<HTMLElement>("#rxlist")!;
    this.rxFilter = root.querySelector<HTMLInputElement>("#rxfilter")!;
    this.rxCount = root.querySelector<HTMLElement>("#rxcount")!;
    this.rxFilter.addEventListener("input", () => this.renderRecipeIndex());
    root.querySelector("#nbindex")!.addEventListener("click", () => this.openRecipeIndex());
    root.querySelector<HTMLSelectElement>("#nbsort")!.addEventListener("change", (e) => {
      this.nbSort = (e.target as HTMLSelectElement).value as typeof this.nbSort;
      this.sortNotebook();
    });
    this.undoBtn = root.querySelector<HTMLButtonElement>("#undo")!;
    this.undoBtn.addEventListener("click", () => hooks.onUndo());
    this.redoBtn = root.querySelector<HTMLButtonElement>("#redo")!;
    this.redoBtn.addEventListener("click", () => hooks.onRedo());
    this.recBtn = root.querySelector<HTMLButtonElement>("#rec")!;
    this.recBtn.addEventListener("click", () => hooks.onRecord());
    // save slots
    this.slotDialog = root.querySelector<HTMLDialogElement>("#slotdialog")!;
    this.slotList = root.querySelector<HTMLElement>("#slotlist")!;
    // controls panel + the first-run card that points at it
    this.helpDialog = root.querySelector<HTMLDialogElement>("#helpdialog")!;
    root.querySelector("#helpbtn")!.addEventListener("click", () => this.openHelp());
    this.intro = root.querySelector<HTMLElement>("#intro")!;
    root.querySelector("#introclose")!.addEventListener("click", () => this.dismissIntro());
    root.querySelector("#introhelp")!.addEventListener("click", () => { this.dismissIntro(); this.openHelp(); });
    root.querySelector("#introdemo")!.addEventListener("click", () => {
      this.dismissIntro();
      const sel = root.querySelector<HTMLSelectElement>("#demosel")!;
      sel.value = "sandbox";
      hooks.onDemo("sandbox");
    });
    // scene gallery: act on submit + e.submitter, never on dialog "close"
    // (embedded browsers can drop the close event entirely)
    this.galDialog = root.querySelector<HTMLDialogElement>("#gallerydialog")!;
    this.galList = root.querySelector<HTMLElement>("#gallist")!;
    this.galStatus = root.querySelector<HTMLElement>("#galstatus")!;
    this.galCount = root.querySelector<HTMLElement>("#galcount")!;
    this.galName = root.querySelector<HTMLInputElement>("#galname")!;
    this.galAuthor = root.querySelector<HTMLInputElement>("#galauthor")!;
    root.querySelector<HTMLFormElement>("#galleryform")!.addEventListener("submit", (e) => {
      if ((e.submitter as HTMLButtonElement | null)?.value !== "upload") return; // close button proceeds
      e.preventDefault(); // upload keeps the dialog open
      hooks.onGalleryUpload(this.galName.value.trim(), this.galAuthor.value.trim());
    });
    this.penInput.addEventListener("input", () => this.setPen(parseInt(this.penInput.value)));
    this.filterInput = root.querySelector<HTMLInputElement>("#elfilter")!;
    this.filterCount = root.querySelector<HTMLElement>("#elcount")!;
    this.noMatch = root.querySelector<HTMLElement>("#norail")!;
    this.propHint = root.querySelector<HTMLElement>("#prophint")!;
    this.filterInput.addEventListener("input", () => this.applyFilter());
    this.filterInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        // otherwise filtering down to one element still ends in a mouse trip
        e.preventDefault();
        const first = this.firstMatch();
        if (first) { first.click(); this.filterInput.select(); }
        return;
      }
      if (e.key !== "Escape") return;
      if (this.filterInput.value === "") this.filterInput.blur();
      else { this.filterInput.value = ""; this.applyFilter(); }
    });

    // small screens: the palette slides over the canvas instead of stealing a
    // column from it, and picking an element closes it again
    const side = root.querySelector<HTMLElement>("#side")!;
    const railToggle = root.querySelector<HTMLButtonElement>("#railtoggle")!;
    const showRail = (on: boolean): void => {
      side.classList.toggle("open", on);
      railToggle.setAttribute("aria-expanded", String(on));
    };
    railToggle.addEventListener("click", () => showRail(!side.classList.contains("open")));
    aside.addEventListener("click", (e) => {
      if (window.innerWidth <= 900 && (e.target as Element).closest(".el")) showRail(false);
    });
    aside.addEventListener("keydown", (e) => this.paletteKeys(e));
    aside.setAttribute("role", "toolbar");
    aside.setAttribute("aria-orientation", "vertical");
    aside.setAttribute("aria-label", "Elements");

    this.renderRecent();
    this.bind("L", E.POWDER);
    this.bind("R", E.EMPTY);
  }

  bind(side: "L" | "R", id: number): void {
    if (side === "L") this.state.toolL = id;
    else this.state.toolR = id;
    const name = id === TOOL_PLAYER ? "Player" : id === TOOL_FIGHTER ? "Fighter"
      : id === TOOL_STIR ? "Stir" : id === E.EMPTY ? "Erase" : ELEMENTS[id].name;
    const color = id === TOOL_PLAYER ? "#ffe94a" : id === TOOL_FIGHTER ? "#c05ac0"
      : id === TOOL_STIR ? "#9ec8d0" : id === E.EMPTY ? "#3a4049" : ELEMENTS[id].color;
    if (side === "L") {
      this.wellL.textContent = name;
      document.documentElement.style.setProperty("--accent-l", color);
    } else {
      this.wellR.textContent = name;
      document.documentElement.style.setProperty("--accent-r", color);
    }
    if (side === "L") {
      document.documentElement.dataset.tool =
        id === TOOL_STIR ? "stir"
          : id === TOOL_PLAYER || id === TOOL_FIGHTER || id === E.BALL || id === E.BOX || id === E.WHEEL || id === E.BUBBLE ? "place"
            : id === E.EMPTY ? "erase" : "paint";
    }
    this.remember(id);
    this.markSelection();
    if (side === "L") this.renderRecipes(id);
  }

  private markSelection(): void {
    for (const [bid, list] of this.buttons) {
      for (const btn of list) {
        const l = bid === this.state.toolL;
        const r = bid === this.state.toolR;
        btn.classList.toggle("sel-l", l);
        btn.classList.toggle("sel-r", r);
        btn.setAttribute("aria-pressed", String(l || r));
      }
    }
    this.setRoving();
  }

  /** every visible palette entry, in the order they sit on screen */
  private paletteOrder(): HTMLButtonElement[] {
    const out: HTMLButtonElement[] = [];
    for (const rail of this.rails) {
      if (rail.host.hidden) continue;
      for (const b of rail.host.children) {
        if (!(b as HTMLElement).hidden) out.push(b as HTMLButtonElement);
      }
    }
    return out;
  }

  /** Roving tabindex: 110 buttons were 110 tab stops between the filter and the
   *  canvas. Now the palette is one stop and the arrows walk it. */
  private setRoving(): void {
    const list = this.paletteOrder();
    const active = list.find((b) => b.classList.contains("sel-l")) ?? list[0];
    for (const rail of this.rails) {
      for (const b of rail.host.children) (b as HTMLButtonElement).tabIndex = -1;
    }
    if (active) active.tabIndex = 0;
  }

  private paletteKeys(e: KeyboardEvent): void {
    const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const list = this.paletteOrder();
    const here = list.indexOf(document.activeElement as HTMLButtonElement);
    if (here < 0) return;
    e.preventDefault();
    // the palette is a grid, so up/down move a ROW and left/right move one cell.
    // Rails have their own column count (the drawer is one-up on small screens),
    // so measure it from where the buttons actually sit rather than assume.
    const rowOf = (b: HTMLElement): number => b.offsetTop;
    const cols = (() => {
      const top = rowOf(list[here]);
      const host = list[here].parentElement;
      let n = 0;
      for (const b of list) if (b.parentElement === host && rowOf(b as HTMLElement) === top) n++;
      return Math.max(1, n);
    })();
    const step = e.key === "ArrowRight" ? 1
      : e.key === "ArrowLeft" ? -1
      : e.key === "ArrowDown" ? cols
      : e.key === "ArrowUp" ? -cols : 0;
    const next = e.key === "Home" ? 0
      : e.key === "End" ? list.length - 1
      : Math.max(0, Math.min(list.length - 1, here + step));
    list[here].tabIndex = -1;
    list[next].tabIndex = 0;
    list[next].focus();
  }

  /** RECENT rail: with 106 elements across nine rails, the handful you are
   *  actually building with should not need a scroll to reach twice */
  private static RECENT_MAX = 8;
  private remember(id: number): void {
    const next = [id, ...this.recent.filter((x) => x !== id)].slice(0, Ui.RECENT_MAX);
    if (next.length === this.recent.length && next.every((x, i) => x === this.recent[i])) return;
    this.recent = next;
    localStorage.setItem("granulab-recent", JSON.stringify(next));
    this.renderRecent();
  }

  private renderRecent(): void {
    // the rebuilt buttons replace the old ones in the id -> buttons lookup
    for (const [bid, list] of this.buttons) {
      const kept = list.filter((b) => b.parentElement !== this.recentHost);
      if (kept.length) this.buttons.set(bid, kept);
      else this.buttons.delete(bid);
    }
    this.recentHost.replaceChildren();
    for (const id of this.recent) {
      if (id !== TOOL_PLAYER && id !== TOOL_FIGHTER && !ELEMENTS[id]) continue; // a custom that is gone
      this.addButtonFn(this.recentHost, id);
    }
    this.markSelection();
    this.applyFilter();
    this.setCvd(this.cvdOn); // the rebuilt buttons need their letters back
  }

  /** Property words the filter understands. The registry has always known which
   *  elements burn, conduct, explode or melt; none of it was askable, so with
   *  106 elements "what can I set on fire" had no answer but scrolling. */
  private static PROPS: { words: string[]; test: (id: number) => boolean }[] = [
    { words: ["burns", "flammable", "fuel"], test: (id) => FLAMMABLE[id] > 0 || IGNITES_AT[id] < 32767 },
    { words: ["conducts", "conductor", "wire"], test: (id) => CONDUCTS[id] > 0 },
    { words: ["explodes", "explosive", "blast"], test: (id) => EXPLODE_R[id] > 0 },
    { words: ["melts"], test: (id) => HOT_TO[id] !== 0 },
    { words: ["freezes"], test: (id) => COLD_TO[id] !== 0 },
    { words: ["acid", "acidic"], test: (id) => PH[id] !== 255 && PH[id] < 7 },
    { words: ["alkali", "base", "basic"], test: (id) => PH[id] !== 255 && PH[id] > 7 },
    { words: ["ph", "aqueous"], test: (id) => PH[id] !== 255 },
    { words: ["reacts", "reactive"], test: (id) => HAS_REACT[id] === 1 },
    { words: ["inert"], test: (id) => HAS_REACT[id] !== 1 && HOT_TO[id] === 0 && COLD_TO[id] === 0 },
  ];

  /** name/group/property filter over the whole palette; empty rails fold away */
  private applyFilter(): void {
    const q = (this.filterInput?.value ?? "").trim().toLowerCase();
    const prop = (q === "" ? undefined : Ui.PROPS.find((p) => p.words.some((w) => w.startsWith(q) && q.length >= 3))) ?? null;
    let shown = 0;
    let total = 0;
    for (const rail of this.rails) {
      const railName = rail.host.dataset.rail ?? "";
      const railHit = q !== "" && railName.includes(q);
      let visible = 0;
      for (const btn of rail.host.children) {
        const el = btn as HTMLElement;
        const isNew = el === this.newElBtn;
        const name = el.dataset.name ?? "";
        const eid = Number(el.dataset.id ?? NaN);
        const propHit = prop !== null && Number.isFinite(eid) && eid > E.WALL && prop.test(eid);
        const hit = q === "" ? true : !isNew && (railHit || propHit || name.includes(q));
        el.hidden = !hit;
        if (hit) visible++;
        if (rail.host !== this.recentHost && !isNew) {
          total++;
          if (hit) shown++;
        }
      }
      rail.host.hidden = visible === 0;
      rail.label.hidden = visible === 0;
    }
    this.filterCount.textContent = q === "" ? `${total}` : `${shown}/${total}`;
    this.filterCount.classList.toggle("none", q !== "" && shown === 0);
    this.noMatch.hidden = shown > 0 || q === "";
    this.propHint.hidden = prop === null;
    if (prop) this.propHint.textContent = `matching “${prop.words[0]}”`;
    this.setRoving(); // what is reachable by arrow key changed with the filter
  }

  /** the first still-visible palette entry, skipping the RECENT duplicates */
  private firstMatch(): HTMLButtonElement | null {
    for (const rail of this.rails) {
      if (rail.host === this.recentHost || rail.host.hidden) continue;
      for (const btn of rail.host.children) {
        if (!(btn as HTMLElement).hidden && btn !== this.newElBtn) return btn as HTMLButtonElement;
      }
    }
    return null;
  }

  /** focus the palette filter (the "/" shortcut) */
  focusFilter(): void {
    this.filterInput.focus();
    this.filterInput.select();
  }

  /** reagent datasheet: what the held element reacts with, straight from the
   *  live REACT table + thermal registry — custom elements document themselves */
  private renderRecipes(id: number): void {
    const card = this.reagentCard;
    if (id <= E.WALL || id >= ELEMENTS.length) { card.hidden = true; return; }

    const sw = (eid: number): string =>
      eid === E.EMPTY
        ? `<i class="rsw" style="border:1px solid var(--hairline)"></i>`
        : `<i class="rsw" style="background:${ELEMENTS[eid].color}"></i>`;
    const nm = (eid: number): string => (eid === E.EMPTY ? "∅" : ELEMENTS[eid].name);
    const rows: string[] = [];
    for (let b = E.WALL + 1; b < ELEMENTS.length; b++) {
      const r = REACT[id * N_IDS + b];
      if (r === 0) continue;
      const newA = (r >>> 8) & 255;
      const newB = r & 255;
      const prods: number[] = [];
      if (newA !== id) prods.push(newA);
      if (newB !== b) prods.push(newB);
      const shown = prods.filter((p) => p !== E.EMPTY); // absorbed partners read cleaner unlisted
      let prod: string;
      if (prods.length === 2 && prods[0] === prods[1] && prods[0] !== E.EMPTY) {
        prod = `${sw(prods[0])}${nm(prods[0])} ×2`;
      } else if (shown.length > 0) {
        prod = shown.map((p) => sw(p) + nm(p)).join(" + ");
      } else {
        prod = "∅";
      }
      const dT = REACT_DT[pairKey(id, b)];
      const heat = dT > 0 ? ` <em class="exo">+${dT}°</em>` : dT < 0 ? ` <em class="endo">${dT}°</em>` : "";
      rows.push(`<div class="rx"><span>+ ${sw(b)}${nm(b)}</span><span class="arr">→</span><span>${prod}${heat}</span></div>`);
    }
    if (HOT_TO[id] !== 0) {
      rows.push(`<div class="rx"><span>≥ ${HOT_AT[id]}°</span><span class="arr">→</span><span>${sw(HOT_TO[id])}${nm(HOT_TO[id])}</span></div>`);
    }
    if (COLD_TO[id] !== 0) {
      rows.push(`<div class="rx"><span>≤ ${COLD_AT[id]}°</span><span class="arr">→</span><span>${sw(COLD_TO[id])}${nm(COLD_TO[id])}</span></div>`);
    }
    const flags: string[] = [];
    if (IGNITES_AT[id] < 32767) flags.push(`ignites ≥ ${IGNITES_AT[id]}°`);
    else if (FLAMMABLE[id] > 0) flags.push("flammable");
    if (EXPLODE_R[id] > 0) flags.push(`blast r${EXPLODE_R[id]}`);
    if (PH[id] !== 255) flags.push(`pH ${PH[id]}`);
    if (CONDUCTS[id] > 0) flags.push("conducts");
    if (flags.length) rows.push(`<div class="rx flags">${flags.join(" · ")}</div>`);

    // WHERE IT COMES FROM. The card only ever said what an element does to other
    // things; for 27 of them it said nothing at all, because they are products —
    // Glass, Smoke, Nitrogen, Litmus. "How do I make this" is the question a
    // chemistry set has to answer, so scan the table backwards for the answer.
    const sources = makersOf(id);
    if (sources.length) {
      rows.push(`<div class="rx made">made from</div>`);
      for (const m of sources.slice(0, 6)) {
        rows.push(`<div class="rx"><span>${m.parts.map((p) =>
          typeof p === "number" ? sw(p) + nm(p) : p).join(" + ")}</span><span class="arr">→</span><span>${sw(id)}${nm(id)}</span></div>`);
      }
      if (sources.length > 6) rows.push(`<div class="rx flags">+ ${sources.length - 6} more — see the reaction index</div>`);
    }
    if (rows.length === 0) { card.hidden = true; return; }
    card.innerHTML = `<div class="rhead">${sw(id)}${ELEMENTS[id].name}<button type="button" id="cardtune" title="Tune this element's physics (T)">tune</button></div>` + rows.join("");
    card.querySelector("#cardtune")!.addEventListener("click", () => this.openTune());
    card.hidden = false;
  }

  /** add a palette button for a freshly registered custom element */
  addElementButton(id: number): void {
    this.addButtonFn(this.customHost, id);
    dropRecipeCache(); // a new element can add reaction rows
    this.customHost.append(this.newElBtn, this.manageBtn); // keep the two actions last
    this.applyFilter();
    this.setCvd(this.cvdOn);
  }

  // ---- the element maker, in create and edit mode -------------------------
  private elDialog!: HTMLDialogElement;
  private rxRows!: HTMLElement;
  private addRxRow!: () => void;
  private manageBtn!: HTMLButtonElement;
  private customDialog!: HTMLDialogElement;
  private customList!: HTMLElement;
  /** index into the saved custom list, or -1 when inventing a new one */
  private makerIndex = -1;

  /** open the maker blank, or filled in with an element you already made */
  openMaker(spec: CustomSpec | null, index: number): void {
    this.makerIndex = index;
    const f = this.elDialog.querySelector<HTMLFormElement>("#elform")!;
    const set = (name: string, v: string | number | undefined): void => {
      const el = f.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
      if (el) el.value = v === undefined || v === null ? "" : String(v);
    };
    this.elDialog.querySelector("#eltitle")!.textContent = spec ? "Edit element" : "New element";
    const note = this.elDialog.querySelector<HTMLElement>("#elnote")!;
    note.hidden = !spec;
    note.textContent = spec ? "Saving reloads the page so the registry rebuilds cleanly. The scene is kept." : "";
    this.elDialog.querySelector("#elsave")!.textContent = spec ? "save changes" : "create";
    set("name", spec?.name ?? "");
    set("color", spec?.color ?? "#8ad0c0");
    set("state", spec?.state ?? "powder");
    set("density", spec?.density ?? 60);
    set("flammable", spec?.flammable ?? 0);
    set("explodeR", spec?.explodeR ?? 0);
    set("temp0", spec?.temp0 ?? 20);
    set("pump", spec?.pump ?? 0);
    set("hotAt", spec?.hotAt);
    set("hotTo", spec?.hotTo ?? 0);
    set("coldAt", spec?.coldAt);
    set("coldTo", spec?.coldTo ?? 0);
    set("ignitesAt", spec?.ignitesAt);
    this.rxRows.replaceChildren();
    const rows = spec?.reactions ?? [];
    for (const r of rows) {
      this.addRxRow();
      const row = this.rxRows.lastElementChild!;
      row.querySelector<HTMLSelectElement>("[data-rw]")!.value = String(r.with);
      row.querySelector<HTMLSelectElement>("[data-rs]")!.value = String(r.becomeSelf);
      row.querySelector<HTMLSelectElement>("[data-ro]")!.value = String(r.becomeOther);
      row.querySelector<HTMLInputElement>("[data-rp]")!.value = String(r.p);
    }
    if (rows.length === 0) this.addRxRow();
    this.elDialog.showModal();
  }

  /** render the invented-element list; main.ts owns the storage */
  setCustomElements(specs: CustomSpec[]): void {
    this.manageBtn.hidden = specs.length === 0;
    if (specs.length === 0) {
      this.customList.replaceChildren(this.galNote("You have not invented anything yet."));
      return;
    }
    this.customList.replaceChildren(...specs.map((spec, i) => {
      const row = document.createElement("div");
      row.className = "slot";
      const sw = document.createElement("i");
      sw.className = "rsw big";
      sw.style.background = spec.color;
      const name = document.createElement("span");
      name.className = "gal-name";
      name.textContent = spec.name;
      const meta = document.createElement("span");
      meta.className = "slot-meta";
      meta.textContent = `${spec.state} · ${spec.reactions?.length ?? 0} rx`;
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "edit";
      edit.addEventListener("click", () => { this.customDialog.close(); this.openMaker(spec, i); });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "slot-del";
      del.textContent = "×";
      del.title = `Delete ${spec.name}`;
      del.setAttribute("aria-label", `Delete ${spec.name}`);
      del.addEventListener("click", () => {
        if (confirm(`Delete "${spec.name}"? Anything already painted with it is erased, and the page reloads.`)) {
          this.hooks.onDeleteElement(i);
        }
      });
      row.append(sw, name, meta, edit, del);
      return row;
    }));
  }

  /** Lab Notebook: diffs the REACT_COUNT table on the stats cadence; new
   *  pairs become entries (flashing if never seen in this browser before) */
  private nbPrev = new Uint32Array(N_IDS * N_IDS);
  private nbRows = new Map<number, { row: HTMLElement; count: HTMLElement; rate: HTMLElement; last: number; total: number; name: string; seq: number }>();
  private nbSeen = new Set<string>(readJson<string[]>("granulab-seen-rx", [], Array.isArray));
  private notebook!: HTMLElement;
  private nbRowsHost!: HTMLElement;
  private nbBtn!: HTMLButtonElement;
  private nbFresh = 0;

  // ---- scene legend ------------------------------------------------------
  // Load someone else's scene and all you get is shapes: the minimap shows form
  // rather than identity, and the notebook only lists reactions you happen to
  // have witnessed. With 114 elements the first question about any scene is
  // what it is made of, and nothing answered it.
  private legendHost!: HTMLElement;
  private legendRows = new Map<number, { row: HTMLElement; count: HTMLElement; bar: HTMLElement }>();
  /** the element the canvas is currently picking out, or -1 */
  private highlighted = -1;

  setLegend(counts: Uint32Array, total: number): void {
    if (total === 0) {
      this.legendRows.clear();
      this.legendHost.replaceChildren(this.galNote("Nothing on the grid yet."));
      return;
    }
    const present: number[] = [];
    for (let id = 1; id < counts.length; id++) if (counts[id] > 0) present.push(id);
    present.sort((a, b) => counts[b] - counts[a]);
    // rebuild only when the cast changes; otherwise just move the numbers, so
    // the list does not flicker while a scene runs
    const sig = present.join(",");
    if (sig !== this.legendSig) {
      this.legendSig = sig;
      this.legendRows.clear();
      this.legendHost.replaceChildren(...present.map((id) => {
        const el = ELEMENTS[id];
        const row = document.createElement("button");
        row.type = "button";
        row.className = "lg-row";
        row.title = `${el?.name ?? id} — click to hold it, click again to pick it out on the canvas`;
        row.innerHTML =
          `<i class="rsw" style="background:${el?.color ?? "#888"}"></i>` +
          `<span class="lg-name"></span><span class="lg-bar"><i></i></span><span class="lg-count"></span>`;
        row.querySelector<HTMLElement>(".lg-bar i")!.style.background = el?.color ?? "#888";
        row.setAttribute("aria-pressed", "false");
        row.querySelector<HTMLElement>(".lg-name")!.textContent = el?.name ?? `#${id}`;
        row.addEventListener("click", () => {
          if (this.state.toolL === id) {
            // second click on the element you are already holding: show me where
            this.highlighted = this.highlighted === id ? -1 : id;
            this.hooks.onHighlight(this.highlighted);
          } else {
            this.bind("L", id);
          }
          this.markLegend();
        });
        this.legendRows.set(id, {
          row,
          count: row.querySelector<HTMLElement>(".lg-count")!,
          bar: row.querySelector<HTMLElement>(".lg-bar i")!,
        });
        return row;
      }));
      this.markLegend();
    }
    const top = counts[present[0]] || 1;
    for (const id of present) {
      const e = this.legendRows.get(id);
      if (!e) continue;
      e.count.textContent = counts[id].toLocaleString();
      e.bar.style.width = `${Math.max(2, (counts[id] / top) * 100)}%`;
    }
  }

  private legendSig = "";

  private markLegend(): void {
    for (const [id, e] of this.legendRows) {
      e.row.classList.toggle("held", id === this.state.toolL);
      e.row.classList.toggle("lit", id === this.highlighted);
      e.row.setAttribute("aria-pressed", String(id === this.state.toolL));
    }
  }

  /** true while the contents tab is the visible one */
  legendVisible(): boolean {
    return !this.notebook.hidden && !this.legendHost.hidden;
  }

  // ---- reaction index ----------------------------------------------------
  // The notebook is a record of what you have witnessed. That is the wrong tool
  // for "what can I make" — a hundred rows were discoverable only by accident.
  private rxDialog!: HTMLDialogElement;
  private rxList!: HTMLElement;
  private rxFilter!: HTMLInputElement;
  private rxCount!: HTMLElement;

  openRecipeIndex(): void {
    this.renderRecipeIndex();
    if (!this.rxDialog.open) this.rxDialog.showModal();
    this.rxFilter.focus();
  }

  private renderRecipeIndex(): void {
    const q = this.rxFilter.value.trim().toLowerCase();
    const all = allRecipes();
    const hits = q === "" ? all : all.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      (ELEMENTS[r.a]?.name ?? "").toLowerCase().includes(q) ||
      (ELEMENTS[r.b]?.name ?? "").toLowerCase().includes(q) ||
      (ELEMENTS[r.newA]?.name ?? "").toLowerCase().includes(q) ||
      (ELEMENTS[r.newB]?.name ?? "").toLowerCase().includes(q) ||
      (ELEMENTS[r.extra]?.name ?? "").toLowerCase().includes(q));
    this.rxCount.textContent = q === "" ? `${all.length}` : `${hits.length}/${all.length}`;
    this.rxCount.classList.toggle("none", hits.length === 0);
    if (hits.length === 0) {
      this.rxList.replaceChildren(this.galNote("Nothing matches that."));
      return;
    }
    const chip = (eid: number): string =>
      `<i class="rsw" style="background:${ELEMENTS[eid]?.color ?? "#888"}"></i>${ELEMENTS[eid]?.name ?? "∅"}`;
    this.rxList.replaceChildren(...hits.map((r) => {
      const row = document.createElement("div");
      row.className = "rx-row";
      const prods: string[] = [];
      if (r.newA !== r.a) prods.push(r.newA === E.EMPTY ? "∅" : chip(r.newA));
      if (r.newB !== r.b) prods.push(r.newB === E.EMPTY ? "∅" : chip(r.newB));
      if (r.extra) prods.push(chip(r.extra));
      const heat = r.dT > 0 ? `<em class="exo">+${r.dT}°</em>` : r.dT < 0 ? `<em class="endo">${r.dT}°</em>` : "";
      row.innerHTML =
        `<div class="rx-name">${r.name}${heat}</div>` +
        `<div class="rx-eq">${chip(r.a)} + ${chip(r.b)} <span class="arr">→</span> ${prods.join(" + ") || "∅"}` +
        `<span class="rx-p">${((r.p / 256) * 100).toFixed(r.p < 3 ? 1 : 0)}%</span></div>`;
      return row;
    }));
  }

  private nbSort: "recent" | "count" | "name" = "recent";
  /** live tallies per row, so sorting does not have to re-read the table */
  private nbSeq = 0;

  /** Start a fresh page. The engine's tallies are cumulative and shared with
   *  the rx-glow field, so this baselines the view rather than zeroing them:
   *  what you have already witnessed goes away, and only new pairs come back. */
  private clearNotebook(): void {
    for (let k = 0; k < REACT_COUNT.length; k++) this.nbPrev[k] = REACT_COUNT[k];
    this.nbRows.clear();
    this.nbFresh = 0;
    this.nbBtn.classList.remove("attn");
    this.nbBtn.textContent = "log";
    const empty = document.createElement("div");
    empty.className = "nb-empty";
    empty.textContent = "Fresh page — nothing witnessed since you cleared it.";
    this.nbRowsHost.replaceChildren(empty);
  }

  private sortNotebook(): void {
    const rows = [...this.nbRows.values()];
    if (rows.length === 0) return;
    const key = this.nbSort;
    rows.sort((a, b) =>
      key === "count" ? b.total - a.total
        : key === "name" ? a.name.localeCompare(b.name)
          : b.seq - a.seq);
    this.nbRowsHost.replaceChildren(...rows.map((r) => r.row));
  }

  refreshNotebook(dtMs: number): void {
    let touched = false;
    for (let k = 0; k < REACT_COUNT.length; k++) {
      const c = REACT_COUNT[k];
      if (c === 0) continue;
      const prev = this.nbPrev[k];
      // nothing new for this pair. The "and we already have a row" this used to
      // carry made `clear` useless: baselining nbPrev drops the rows, and the
      // very next refresh built every one of them straight back.
      if (c === prev) continue;
      this.nbPrev[k] = c;
      const a = (k / N_IDS) | 0;
      const b = k % N_IDS;
      let entry = this.nbRows.get(k);
      if (!entry) {
        const nameA = ELEMENTS[a]?.name ?? `#${a}`;
        const nameB = ELEMENTS[b]?.name ?? `#${b}`;
        const title = REACT_NAME[k] ?? `${nameA} + ${nameB}`;
        const seenKey = `${nameA}+${nameB}`;
        const isNew = !this.nbSeen.has(seenKey);
        if (isNew) {
          this.nbSeen.add(seenKey);
          localStorage.setItem("granulab-seen-rx", JSON.stringify([...this.nbSeen]));
        }
        const sw = (eid: number): string =>
          `<i class="rsw" style="background:${ELEMENTS[eid]?.color ?? "#888"}"></i>`;
        const row = document.createElement("div");
        row.className = "nb-row" + (isNew ? " nb-new" : "");
        row.innerHTML =
          `<div class="nb-title">${title}${isNew ? '<span class="nb-badge">NEW</span>' : ""}</div>` +
          `<div class="nb-formula">${sw(a)}${ELEMENTS[a]?.name}${sw(b)}${ELEMENTS[b]?.name}</div>` +
          `<div class="nb-stats"><span class="nb-count"></span><span class="nb-rate"></span></div>`;
        this.nbRowsHost.querySelector(".nb-empty")?.remove();
        this.nbRowsHost.prepend(row);
        entry = {
          row,
          count: row.querySelector<HTMLElement>(".nb-count")!,
          rate: row.querySelector<HTMLElement>(".nb-rate")!,
          last: 0,
          total: 0,
          name: title,
          seq: ++this.nbSeq,
        };
        this.nbRows.set(k, entry);
        if (this.notebook.hidden) {
          this.nbFresh++;
          this.nbBtn.classList.add("attn");
          this.nbBtn.textContent = `log ${this.nbFresh}`;
        }
      }
      entry.total = c;
      entry.count.textContent = c.toLocaleString();
      const perSec = ((c - entry.last) / dtMs) * 1000;
      entry.last = c;
      entry.rate.textContent = perSec > 0.5 ? `${perSec.toFixed(0)}/s` : "";
      touched = true;
    }
    // a non-default order has to be re-applied when a row's tally moves
    if (touched && this.nbSort !== "recent") this.sortNotebook();
  }

  // ---- scene gallery -----------------------------------------------------
  private galDialog!: HTMLDialogElement;
  private galList!: HTMLElement;
  private galStatus!: HTMLElement;
  private galCount!: HTMLElement;
  private galName!: HTMLInputElement;
  private galAuthor!: HTMLInputElement;

  private galNote(text: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "gal-empty";
    d.textContent = text;
    return d;
  }

  /** default author for the upload form (persisted by main.ts) */
  setGalleryAuthor(author: string): void {
    this.galAuthor.value = author;
  }

  setGalleryStatus(msg: string, isError = false): void {
    this.galStatus.hidden = false;
    this.galStatus.textContent = msg;
    this.galStatus.classList.toggle("err", isError);
  }

  /** render the gallery listing; null = fetch failed. Community strings go in
   *  via textContent only — never innerHTML. */
  setGalleryScenes(scenes: GalleryScene[] | null, total = 0): void {
    if (scenes === null) {
      this.galList.replaceChildren(this.galNote("gallery unreachable — try again later"));
      return;
    }
    if (scenes.length === 0) {
      this.galList.replaceChildren(this.galNote("no scenes yet — upload the first one"));
      this.galCount.textContent = "";
      return;
    }
    // the endpoint walks the whole store but returns a fixed page, so say what
    // fraction is on screen rather than implying this is everything
    this.galCount.textContent = total > scenes.length
      ? `newest ${scenes.length} of ${total}` : `${scenes.length} scene${scenes.length === 1 ? "" : "s"}`;
    const rows = scenes.map((s) => {
      const row = document.createElement("div");
      row.className = "gal-row";
      const shot = document.createElement("img");
      shot.className = "gal-thumb";
      shot.alt = "";
      shot.width = 160;
      shot.height = 90;
      shot.loading = "lazy";
      if (s.thumb) shot.src = s.thumb;
      const name = document.createElement("span");
      name.className = "gal-name";
      name.textContent = s.name;
      name.title = s.name;
      const meta = document.createElement("span");
      meta.className = "gal-meta";
      const when = shortDate(s.created);
      meta.textContent = `${s.author ? s.author + " · " : ""}${when} · ${(s.size / 1024).toFixed(1)}k`;
      const load = document.createElement("button");
      load.type = "button";
      load.textContent = "load";
      load.title = "Load this scene";
      load.addEventListener("click", () => {
        this.galDialog.close();
        this.hooks.onGalleryLoad(s);
      });
      row.append(shot, name, meta, load);
      if (s.owned) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "gal-del";
        del.textContent = "×";
        del.title = "Delete this upload";
        del.addEventListener("click", () => {
        if (confirm(`Delete "${s.name}" from the gallery? This cannot be undone.`)) this.hooks.onGalleryDelete(s.stamp);
      });
        row.append(del);
      }
      return row;
    });
    this.galList.replaceChildren(...rows);
  }

  // ---- settings ----------------------------------------------------------
  private setDialog!: HTMLDialogElement;
  private setBoxes!: { cvd: HTMLInputElement; minimap: HTMLInputElement; engine: HTMLSelectElement; telemetry: HTMLInputElement };
  private emptyHint!: HTMLElement;

  /** put the stored settings into the dialog at boot */
  setSettings(s: { cvd: boolean; minimap: boolean; engine: string; telemetry: boolean }): void {
    this.setBoxes.telemetry.checked = s.telemetry;
    this.setTelemetry(s.telemetry);
    this.setBoxes.cvd.checked = s.cvd;
    this.setBoxes.minimap.checked = s.minimap;
    this.setBoxes.engine.value = s.engine;
    this.setCvd(s.cvd);
  }

  private setTelemetry(on: boolean): void {
    document.querySelector("footer")!.classList.toggle("lean", !on);
  }

  /** the blank grid a first-time visitor lands on should say what to do with it */
  setEmpty(empty: boolean): void {
    this.emptyHint.hidden = !empty;
  }

  /** Colour-blind assist on the palette: 106 swatches carry the whole meaning
   *  of the sidebar, and several pairs collapse under deuteranopia. Letters
   *  survive any colour vision. */
  private cvdOn = false;
  private setCvd(on: boolean): void {
    this.cvdOn = on;
    document.documentElement.classList.toggle("cvd", on);
    for (const [id, list] of this.buttons) {
      const name = id === TOOL_PLAYER ? "Player" : id === TOOL_FIGHTER ? "Fighter"
        : id === TOOL_STIR ? "Stir" : id === E.EMPTY ? "Erase" : ELEMENTS[id]?.name ?? "?";
      for (const btn of list) {
        const sw = btn.querySelector<HTMLElement>(".sw");
        if (sw) sw.dataset.tag = on ? name.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() : "";
      }
    }
  }

  // ---- keyboard painting -------------------------------------------------
  private kbdBtn!: HTMLButtonElement;

  setKeyPaint(on: boolean): void {
    this.kbdBtn.classList.toggle("on", on);
    this.kbdBtn.setAttribute("aria-pressed", String(on));
  }

  // ---- element tuning ----------------------------------------------------
  private tuneDialog!: HTMLDialogElement;
  private tuneRows!: HTMLElement;
  private tuneName!: HTMLElement;

  openTune(): void {
    this.hooks.onTuneOpen();
    if (!this.tuneDialog.open) this.tuneDialog.showModal();
  }

  /** null = nothing tunable is held (empty, wall, or a placement tool) */
  setTunables(spec: {
    name: string; color: string; tuned: boolean;
    rows: { key: string; label: string; min: number; max: number; step: number; value: number; isDefault: boolean }[];
  } | null): void {
    if (!spec) {
      this.tuneName.textContent = "—";
      this.tuneRows.replaceChildren(this.galNote("Hold an element on the left button to tune it."));
      return;
    }
    this.tuneName.textContent = spec.name;
    this.tuneRows.replaceChildren(...spec.rows.map((r) => {
      const row = document.createElement("label");
      row.className = "tune-row" + (r.isDefault ? "" : " tuned");
      const label = document.createElement("span");
      label.className = "tune-label";
      label.textContent = r.label;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(r.min);
      input.max = String(r.max);
      input.step = String(r.step);
      input.value = String(r.value);
      const out = document.createElement("output");
      out.className = "tune-val";
      out.value = String(r.value);
      input.addEventListener("input", () => {
        out.value = input.value;
        row.classList.add("tuned");
        this.hooks.onTune(r.key, Number(input.value));
      });
      row.append(label, input, out);
      return row;
    }));
  }

  // ---- share codes -------------------------------------------------------
  private codeDialog!: HTMLDialogElement;
  private codeBox!: HTMLTextAreaElement;
  private codeNote!: HTMLElement;
  private codeGo!: HTMLButtonElement;

  /** ask for a code to load (replaces prompt(), which cannot be styled, cannot
   *  be pasted into on some mobile browsers, and blocks the frame loop) */
  askCode(): void {
    this.codeBox.value = "";
    this.codeBox.readOnly = false;
    this.codeNote.textContent = "Paste a code someone sent you. It carries the whole scene, including any elements they invented.";
    this.codeGo.hidden = false;
    this.codeDialog.showModal();
    this.codeBox.focus();
  }

  /** clipboard write was refused: show the code so it can be copied by hand */
  showCode(code: string): void {
    this.codeBox.value = code;
    this.codeBox.readOnly = true;
    this.codeNote.textContent = "This browser blocked the clipboard. Select the code and copy it.";
    this.codeGo.hidden = true;
    this.codeDialog.showModal();
    this.codeBox.select();
  }

  // ---- toasts ------------------------------------------------------------
  // Copying a share code used to succeed in total silence and a bad file used
  // to stop the whole app with alert(). Both are the same event — something
  // finished — and both belong in the corner of the glass, not in a modal.
  private toastHost!: HTMLElement;

  toast(message: string, kind: "ok" | "err" = "ok"): void {
    const t = document.createElement("div");
    t.className = `toast ${kind}`;
    t.textContent = message;
    this.toastHost.append(t);
    while (this.toastHost.children.length > 3) this.toastHost.firstElementChild!.remove();
    setTimeout(() => {
      t.classList.add("out");
      setTimeout(() => t.remove(), 220);
    }, kind === "err" ? 5200 : 2800);
  }

  // ---- scene menu --------------------------------------------------------
  private sceneBtn!: HTMLButtonElement;
  private sceneMenu!: HTMLElement;
  private recItem!: HTMLButtonElement;

  private toggleSceneMenu(open: boolean): void {
    this.sceneMenu.hidden = !open;
    this.sceneBtn.setAttribute("aria-expanded", String(open));
    if (open) this.sceneMenu.querySelector<HTMLButtonElement>("[data-act]")!.focus();
  }

  private openGallery(): void {
    this.galStatus.hidden = true;
    this.galList.replaceChildren(this.galNote("loading…"));
    this.galDialog.showModal();
    this.hooks.onGalleryOpen();
  }

  // ---- save slots --------------------------------------------------------
  private slotDialog!: HTMLDialogElement;
  private slotList!: HTMLElement;

  private openSlots(): void {
    this.slotDialog.showModal();
  }

  /** render the six slots; main.ts owns the storage and passes what it has */
  setSlots(slots: ({ name: string; when: number; size: number; thumb?: string } | null)[]): void {
    const rows = slots.map((s, i) => {
      const row = document.createElement("div");
      row.className = "slot" + (s ? "" : " empty");
      const shot = document.createElement("img");
      shot.className = "slot-thumb";
      shot.alt = "";
      shot.width = 160;
      shot.height = 90;
      if (s?.thumb) shot.src = s.thumb;
      const name = document.createElement("input");
      name.className = "slot-name";
      name.maxLength = 28;
      name.value = s?.name ?? "";
      name.placeholder = `slot ${i + 1}`;
      name.setAttribute("aria-label", `Name for slot ${i + 1}`);
      name.autocomplete = "off";
      name.spellcheck = false;
      const meta = document.createElement("span");
      meta.className = "slot-meta";
      meta.textContent = s ? `${shortDate(s.when)} · ${(s.size / 1024).toFixed(0)}k` : "empty";
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = s ? "overwrite" : "save here";
      save.addEventListener("click", () => this.hooks.onSlotSave(i, name.value.trim() || `slot ${i + 1}`));
      row.append(shot, name, meta, save);
      if (s) {
        const load = document.createElement("button");
        load.type = "button";
        load.className = "primary";
        load.textContent = "load";
        load.addEventListener("click", () => { this.slotDialog.close(); this.hooks.onSlotLoad(i); });
        const del = document.createElement("button");
        del.type = "button";
        del.className = "slot-del";
        del.textContent = "×";
        del.title = `Delete slot ${i + 1}`;
        del.setAttribute("aria-label", `Delete slot ${i + 1}`);
        del.addEventListener("click", () => {
          if (confirm(`Delete "${s.name}"? This slot cannot be recovered.`)) this.hooks.onSlotDelete(i);
        });
        row.append(load, del);
      }
      return row;
    });
    this.slotList.replaceChildren(...rows);
  }

  // ---- controls panel + first run ---------------------------------------
  private helpDialog!: HTMLDialogElement;
  private intro!: HTMLElement;

  openHelp(): void {
    if (!this.helpDialog.open) this.helpDialog.showModal();
  }

  /** the first-run card: a blank grid and 106 elements need a way in */
  showIntro(): void {
    this.intro.hidden = false;
  }

  private dismissIntro(): void {
    this.intro.hidden = true;
    localStorage.setItem("granulab-intro", "1");
  }

  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private recBtn!: HTMLButtonElement;

  /** while recording, the elapsed clock comes out of the menu and sits on the
   *  face — a running capture you cannot see is a capture you forget to stop */
  setRecording(on: boolean, seconds: number): void {
    this.recBtn.hidden = !on;
    this.recBtn.classList.toggle("recording", on);
    this.recBtn.textContent = on ? `stop ${seconds.toFixed(0)}s` : "stop";
    this.recItem.textContent = on ? "Stop recording" : "Record video";
  }

  /** grey each history button out when there is nothing that way */
  setHistory(undoDepth: number, redoDepth: number): void {
    this.undoBtn.disabled = undoDepth === 0;
    this.undoBtn.textContent = undoDepth > 0 ? `undo ${undoDepth}` : "undo";
    this.redoBtn.disabled = redoDepth === 0;
    this.redoBtn.textContent = redoDepth > 0 ? `redo ${redoDepth}` : "redo";
  }

  setPen(n: number): void {
    this.state.pen = Math.max(1, Math.min(48, n));
    this.penInput.value = String(this.state.pen);
    this.penOut.value = String(this.state.pen);
  }

  setPaused(p: boolean): void {
    this.state.paused = p;
    this.playBtn.textContent = p ? "play" : "pause";
  }

  setStats(fps: number, tickMs: number, dots: number, chunks: number): void {
    this.statFps.textContent = fps.toFixed(0);
    this.statTick.textContent = tickMs.toFixed(2);
    this.statDots.textContent = dots.toLocaleString();
    this.statChunks.textContent = String(chunks);
  }

  setPos(x: number, y: number): void {
    this.statPos.textContent = x >= 0 ? `${x},${y}` : "–";
  }

  /** zoom was invisible state: you could not tell 1× from 1.4× without a ruler */
  setZoom(z: number): void {
    this.statZoom.textContent = z >= 10 ? `${z.toFixed(0)}×` : `${z.toFixed(1)}×`;
  }

  /** Cell probe: the fields the engine has always computed but only ever showed
   *  as full-screen shaders — temperature, breathable air, overpressure, pH —
   *  read out for the cell under the pointer. Off-grid clears every channel. */
  setProbe(p: { x: number; y: number; id: number; temp: number; air: number; press: number } | null): void {
    if (!p) {
      this.statPos.textContent = "–";
      this.probeSw.hidden = true;
      this.probeName.textContent = "";
      this.probeTemp.textContent = "";
      this.probeAir.textContent = "";
      this.probePress.textContent = "";
      this.probePh.textContent = "";
      return;
    }
    this.statPos.textContent = `${p.x},${p.y}`;
    const el = ELEMENTS[p.id];
    if (p.id === E.EMPTY || !el) {
      this.probeSw.hidden = true;
      this.probeName.textContent = "empty";
      this.probeName.classList.add("void");
    } else {
      this.probeSw.hidden = false;
      this.probeSw.style.background = el.color;
      this.probeName.textContent = el.name;
      this.probeName.classList.remove("void");
    }
    this.probeTemp.textContent = `${Math.round(p.temp)}°`;
    this.probeTemp.classList.toggle("hot", p.temp >= 120);
    this.probeTemp.classList.toggle("cold", p.temp <= 0);
    // the field is breathable oxygen, and fire suffocates below a quarter of it
    this.probeAir.textContent = `O₂ ${(p.air * 100).toFixed(0)}%`;
    this.probeAir.classList.toggle("warn", p.air < 0.25);
    this.probePress.textContent = p.press < 0.05 ? "" : `press ${p.press.toFixed(1)}`;
    const ph = el ? PH[p.id] : 255;
    this.probePh.textContent = ph === 255 ? "" : `pH ${ph}`;
  }
}
