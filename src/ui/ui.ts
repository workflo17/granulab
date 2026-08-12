// Toolbar, palette, wells, status readout. The UI's accent is the held element's
// color (--accent-l / --accent-r) — the chassis stays neutral, substances carry chroma.

import {
  E, B, ELEMENTS, REACT, REACT_COUNT, REACT_NAME, REACT_DT, PH, CONDUCTS,
  N_IDS, HOT_AT, HOT_TO, COLD_AT, COLD_TO, IGNITES_AT, FLAMMABLE, EXPLODE_R,
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
  onCreateElement(spec: CustomSpec): void;
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

/** dates in the viewer's own locale and timezone — toISOString dated an
 *  11pm save as tomorrow */
const shortDate = (t: number): string =>
  new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(new Date(t));

export class Ui {
  state: UiState & { penMode: PenMode; penShape: PenShape } = {
    toolL: E.POWDER, toolR: E.EMPTY, pen: 6, speed: 1, paused: false,
    penMode: "free", penShape: "round",
  };

  /** one id can have two buttons: its home rail and the RECENT rail */
  private buttons = new Map<number, HTMLButtonElement[]>();
  private rails: { label: HTMLElement; host: HTMLElement }[] = [];
  private recentHost!: HTMLElement;
  private recent: number[] = JSON.parse(localStorage.getItem("granulab-recent") ?? "[]");
  private filterInput!: HTMLInputElement;
  private filterCount!: HTMLElement;
  private noMatch!: HTMLElement;
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
        <div class="transport">
          <div class="grp" role="group" aria-label="Run">
            <button id="play" class="primary" title="Play or pause (Space)">pause</button>
            <button id="stepb" title="Advance one frame (Enter)">step</button>
            <select id="speed" title="Simulation speed" aria-label="Simulation speed">
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
        <p id="norail" hidden>Nothing matches. Clear the filter with Esc.</p>
      </aside>
      <dialog id="eldialog" aria-labelledby="eltitle">
        <form method="dialog" id="elform">
          <h2 id="eltitle">New element</h2>
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
            <button value="ok" class="primary">create</button>
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
                <div><dt><kbd>/</kbd></dt><dd>filter the elements</dd></div>
                <div><dt><kbd>?</kbd></dt><dd>this panel</dd></div>
              </dl>
              <h3>Mouse</h3>
              <dl>
                <div><dt>left</dt><dd>paint the left-hand element</dd></div>
                <div><dt>right</dt><dd>paint the right-hand one</dd></div>
                <div><dt>middle drag</dt><dd>pan the view</dd></div>
                <div><dt>wheel</dt><dd>zoom</dd></div>
              </dl>
            </section>
          </div>
          <p class="dlg-note">In the palette, click an element to hold it on the left button and
            right-click to hold it on the right. Fans, cannons and lasers aim along the direction you
            drag while painting them.</p>
          <menu><button value="close" class="primary">close</button></menu>
        </form>
      </dialog>
      <main><canvas id="dish" tabindex="-1" aria-label="Simulation grid — paint with the left and right mouse buttons"></canvas>
        <!-- not a live region: it rewrites every reaction row each time you pick
             an element, and reading thirty rows aloud per click helps nobody -->
        <div id="reagent" aria-live="off" hidden></div>
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
        <div id="notebook" hidden>
          <div class="nb-head"><span>LAB NOTEBOOK</span><button id="nbclose" title="Close the notebook" aria-label="Close the notebook">×</button></div>
          <div id="nbrows"><div class="nb-empty">No reactions witnessed yet — mix something.</div></div>
        </div>
      </main>
      <footer>
        <span>fps <b id="s-fps">–</b></span>
        <span>tick <b id="s-tick">–</b> ms</span>
        <span>dots <b id="s-dots">0</b></span>
        <span>chunks <b id="s-chunks">–</b></span>
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
      const label = id === TOOL_PLAYER ? "Player" : id === TOOL_FIGHTER ? "Fighter" : id === E.EMPTY ? "Erase" : el.name;
      const sw = id === TOOL_PLAYER ? "#ffe94a" : id === TOOL_FIGHTER ? "#c05ac0" : id === E.EMPTY ? "transparent" : el.color;
      const btn = document.createElement("button");
      btn.className = "el";
      btn.innerHTML = `<span class="sw" style="background:${sw};${id === E.EMPTY ? "border:1px solid var(--hairline)" : ""}"></span>${label}`;
      btn.title = `${label} — click to hold on the left button, right-click for the right`;
      btn.setAttribute("aria-label", label);
      btn.dataset.name = label.toLowerCase();
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
    newBtn.addEventListener("click", () => {
      rxRows.replaceChildren();
      addRxRow();
      dialog.showModal();
    });
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
      hooks.onCreateElement({
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
      hooks.onDemo((e.target as HTMLSelectElement).value);
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
    this.filterInput.addEventListener("input", () => this.applyFilter());
    this.filterInput.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (this.filterInput.value === "") this.filterInput.blur();
      else { this.filterInput.value = ""; this.applyFilter(); }
    });

    this.renderRecent();
    this.bind("L", E.POWDER);
    this.bind("R", E.EMPTY);
  }

  bind(side: "L" | "R", id: number): void {
    if (side === "L") this.state.toolL = id;
    else this.state.toolR = id;
    const name = id === TOOL_PLAYER ? "Player" : id === TOOL_FIGHTER ? "Fighter" : id === E.EMPTY ? "Erase" : ELEMENTS[id].name;
    const color = id === TOOL_PLAYER ? "#ffe94a" : id === TOOL_FIGHTER ? "#c05ac0" : id === E.EMPTY ? "#3a4049" : ELEMENTS[id].color;
    if (side === "L") {
      this.wellL.textContent = name;
      document.documentElement.style.setProperty("--accent-l", color);
    } else {
      this.wellR.textContent = name;
      document.documentElement.style.setProperty("--accent-r", color);
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
  }

  /** name/group filter over the whole palette; empty rails fold away */
  private applyFilter(): void {
    const q = (this.filterInput?.value ?? "").trim().toLowerCase();
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
        const hit = q === "" ? true : !isNew && (railHit || name.includes(q));
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
    if (rows.length === 0) { card.hidden = true; return; }
    card.innerHTML = `<div class="rhead">${sw(id)}${ELEMENTS[id].name}</div>` + rows.join("");
    card.hidden = false;
  }

  /** add a palette button for a freshly registered custom element */
  addElementButton(id: number): void {
    this.addButtonFn(this.customHost, id);
    this.customHost.appendChild(this.newElBtn); // keep "+ New…" last
    this.applyFilter();
  }

  /** Lab Notebook: diffs the REACT_COUNT table on the stats cadence; new
   *  pairs become entries (flashing if never seen in this browser before) */
  private nbPrev = new Uint32Array(N_IDS * N_IDS);
  private nbRows = new Map<number, { row: HTMLElement; count: HTMLElement; rate: HTMLElement; last: number }>();
  private nbSeen = new Set<string>(JSON.parse(localStorage.getItem("granulab-seen-rx") ?? "[]"));
  private notebook!: HTMLElement;
  private nbRowsHost!: HTMLElement;
  private nbBtn!: HTMLButtonElement;
  private nbFresh = 0;

  refreshNotebook(dtMs: number): void {
    for (let k = 0; k < REACT_COUNT.length; k++) {
      const c = REACT_COUNT[k];
      if (c === 0) continue;
      const prev = this.nbPrev[k];
      if (c === prev && this.nbRows.has(k)) continue;
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
        };
        this.nbRows.set(k, entry);
        if (this.notebook.hidden) {
          this.nbFresh++;
          this.nbBtn.classList.add("attn");
          this.nbBtn.textContent = `log ${this.nbFresh}`;
        }
      }
      entry.count.textContent = c.toLocaleString();
      const perSec = ((c - entry.last) / dtMs) * 1000;
      entry.last = c;
      entry.rate.textContent = perSec > 0.5 ? `${perSec.toFixed(0)}/s` : "";
    }
  }

  // ---- scene gallery -----------------------------------------------------
  private galDialog!: HTMLDialogElement;
  private galList!: HTMLElement;
  private galStatus!: HTMLElement;
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
  setGalleryScenes(scenes: GalleryScene[] | null): void {
    if (scenes === null) {
      this.galList.replaceChildren(this.galNote("gallery unreachable — try again later"));
      return;
    }
    if (scenes.length === 0) {
      this.galList.replaceChildren(this.galNote("no scenes yet — upload the first one"));
      return;
    }
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
