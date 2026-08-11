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
  onSave(): void;
  onLoad(): void;
  onExport(): void;
  onImport(): void;
  onCopyCode(): void;
  onPasteCode(): void;
  onCreateElement(spec: CustomSpec): void;
  onDemo(name: string): void;
  onUndo(): void;
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

export class Ui {
  state: UiState & { penMode: PenMode } = {
    toolL: E.POWDER, toolR: E.EMPTY, pen: 6, speed: 1, paused: false, penMode: "free",
  };

  private buttons = new Map<number, HTMLButtonElement>();
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
  private reagentCard!: HTMLElement;

  constructor(root: HTMLElement, private hooks: UiHooks) {
    root.innerHTML = `
      <header>
        <div class="wordmark">GRANULAB<small>granular matter laboratory</small></div>
        <div class="transport">
          <button id="play" class="primary" title="Space">pause</button>
          <button id="stepb" title="Enter">step</button>
          <select id="speed" title="Simulation speed">
            <option value="0.5">0.5×</option>
            <option value="1" selected>1×</option>
            <option value="2">2×</option>
            <option value="4">4×</option>
          </select>
          <select id="bg" title="Background render mode">
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
          <button id="undo" title="Undo the last edit (Ctrl+Z)" disabled>undo</button>
          <button id="clear">clear</button>
          <button id="fit" title="Reset view">fit</button>
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
          <select id="penmode" title="Pen mode">
            <option value="free" selected>pen: free</option>
            <option value="line">pen: line</option>
            <option value="rect">pen: rect</option>
          </select>
          <button id="save" title="Quick-save to this browser">save</button>
          <button id="load" title="Load the quick-save">load</button>
          <button id="export" title="Download scene as a .grn file">export</button>
          <button id="import" title="Open a .grn scene file">import</button>
          <button id="copycode" title="Copy the scene as a shareable code">code</button>
          <button id="pastecode" title="Paste a scene code">paste</button>
          <button id="gallery" title="Community scene gallery — upload and browse">gallery</button>
          <button id="nblog" title="Lab notebook — every reaction you've made happen">log</button>
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
      <aside id="rails"></aside>
      <dialog id="eldialog">
        <form method="dialog" id="elform">
          <h3>New element</h3>
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
      <dialog id="gallerydialog">
        <form method="dialog" id="galleryform">
          <h3>Scene gallery</h3>
          <div class="gal-upload">
            <input id="galname" name="gname" maxlength="40" placeholder="scene name" required>
            <input id="galauthor" name="gauthor" maxlength="24" placeholder="by (optional)">
            <button value="upload" class="primary">upload current scene</button>
          </div>
          <div class="gal-status" id="galstatus" aria-live="polite" hidden></div>
          <div id="gallist"><div class="gal-empty">loading…</div></div>
          <menu>
            <button value="close" formnovalidate>close</button>
          </menu>
        </form>
      </dialog>
      <main><canvas id="dish"></canvas><div id="reagent" aria-live="polite" hidden></div>
        <div id="notebook" hidden>
          <div class="nb-head"><span>LAB NOTEBOOK</span><button id="nbclose" title="Close">×</button></div>
          <div id="nbrows"><div class="nb-empty">No reactions witnessed yet — mix something.</div></div>
        </div>
      </main>
      <footer>
        <span>fps <b id="s-fps">–</b></span>
        <span>tick <b id="s-tick">–</b> ms</span>
        <span>dots <b id="s-dots">0</b></span>
        <span>chunks <b id="s-chunks">–</b></span>
        <span class="spacer"></span>
        <span id="s-pos">–</span>
        <span>wheel zoom · middle-drag pan · L/R click palette to bind</span>
      </footer>`;

    const addButton = (host: HTMLElement, id: number): void => {
      const el = ELEMENTS[id];
      const label = id === TOOL_PLAYER ? "Player" : id === TOOL_FIGHTER ? "Fighter" : id === E.EMPTY ? "Erase" : el.name;
      const sw = id === TOOL_PLAYER ? "#ffe94a" : id === TOOL_FIGHTER ? "#c05ac0" : id === E.EMPTY ? "transparent" : el.color;
      const btn = document.createElement("button");
      btn.className = "el";
      btn.innerHTML = `<span class="sw" style="background:${sw};${id === E.EMPTY ? "border:1px solid var(--hairline)" : ""}"></span>${label}`;
      btn.addEventListener("click", () => this.bind("L", id));
      btn.addEventListener("contextmenu", (e) => { e.preventDefault(); this.bind("R", id); });
      host.appendChild(btn);
      this.buttons.set(id, btn);
    };
    const aside = root.querySelector<HTMLElement>("#rails")!;
    const makeRail = (label: string): HTMLElement => {
      const lab = document.createElement("div");
      lab.className = "rail-label";
      lab.textContent = label;
      const pal = document.createElement("div");
      pal.className = "palette";
      aside.appendChild(lab);
      aside.appendChild(pal);
      return pal;
    };
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
        <select data-rw><option value="0">—</option>${targetOptions}</select>
        <select data-rs>${morphOptions}</select>
        <select data-ro>${morphOptions}</select>
        <input data-rp type="number" value="60" min="1" max="255">
        <button type="button" class="rxdel" title="remove row">×</button>`;
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
    root.querySelector("#save")!.addEventListener("click", () => hooks.onSave());
    root.querySelector("#load")!.addEventListener("click", () => hooks.onLoad());
    root.querySelector("#export")!.addEventListener("click", () => hooks.onExport());
    root.querySelector("#import")!.addEventListener("click", () => hooks.onImport());
    root.querySelector("#copycode")!.addEventListener("click", () => hooks.onCopyCode());
    root.querySelector("#pastecode")!.addEventListener("click", () => hooks.onPasteCode());
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
    // scene gallery: act on submit + e.submitter, never on dialog "close"
    // (embedded browsers can drop the close event entirely)
    this.galDialog = root.querySelector<HTMLDialogElement>("#gallerydialog")!;
    this.galList = root.querySelector<HTMLElement>("#gallist")!;
    this.galStatus = root.querySelector<HTMLElement>("#galstatus")!;
    this.galName = root.querySelector<HTMLInputElement>("#galname")!;
    this.galAuthor = root.querySelector<HTMLInputElement>("#galauthor")!;
    root.querySelector("#gallery")!.addEventListener("click", () => {
      this.galStatus.hidden = true;
      this.galList.replaceChildren(this.galNote("loading…"));
      this.galDialog.showModal();
      hooks.onGalleryOpen();
    });
    root.querySelector<HTMLFormElement>("#galleryform")!.addEventListener("submit", (e) => {
      if ((e.submitter as HTMLButtonElement | null)?.value !== "upload") return; // close button proceeds
      e.preventDefault(); // upload keeps the dialog open
      hooks.onGalleryUpload(this.galName.value.trim(), this.galAuthor.value.trim());
    });
    this.penInput.addEventListener("input", () => this.setPen(parseInt(this.penInput.value)));

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
    for (const [bid, btn] of this.buttons) {
      btn.classList.toggle("sel-l", bid === this.state.toolL);
      btn.classList.toggle("sel-r", bid === this.state.toolR);
    }
    if (side === "L") this.renderRecipes(id);
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
      if (s.thumb) shot.src = s.thumb;
      const name = document.createElement("span");
      name.className = "gal-name";
      name.textContent = s.name;
      name.title = s.name;
      const meta = document.createElement("span");
      meta.className = "gal-meta";
      const when = new Date(s.created).toISOString().slice(0, 10);
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
        del.addEventListener("click", () => this.hooks.onGalleryDelete(s.stamp));
        row.append(del);
      }
      return row;
    });
    this.galList.replaceChildren(...rows);
  }

  private undoBtn!: HTMLButtonElement;

  /** grey the undo button out when there is nothing to go back to */
  setUndoDepth(n: number): void {
    this.undoBtn.disabled = n === 0;
    this.undoBtn.textContent = n > 0 ? `undo ${n}` : "undo";
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
}
