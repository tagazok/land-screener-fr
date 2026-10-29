import { LitElement, css, html, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import maplibregl, { type Map as MlMap } from 'maplibre-gl';
import mlcss from 'maplibre-gl/dist/maplibre-gl.css?inline';
import { Protocol } from 'pmtiles';
import type { Tier } from '../engine';

export const TIER_COLORS: Record<Tier | 'fail', string> = {
  A: '#1a9850',
  B: '#91cf60',
  C: '#d9ef8b',
  D: '#fee08b',
  E: '#fc8d59',
  fail: '#9e9e9e',
};

/** What to draw for one commune: its fill colour and whether it is emphasised. */
export interface Paint {
  color: string;
  strong: boolean;
  /** Outside the chosen départements: not drawn and not clickable. */
  hidden?: boolean;
}

export type Bounds = [[number, number], [number, number]];

const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
const FRANCE: Bounds = [[-4.9, 42.3], [8.3, 51.1]];
const SRC = 'communes';
const LAYER = 'communes'; // tippecanoe layer name

const WMTS = (layer: string, style: string, set: string) =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=${style}&FORMAT=image/png&TILEMATRIXSET=${set}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;

/** IGN Géoplateforme background layers (free, no key), drawn under the communes. */
export const OVERLAYS = {
  forest: {
    url: WMTS('IGNF_MASQUE-FORET.2021-2023', 'normal', 'PM_6_16'), minzoom: 6, maxzoom: 16, opacity: 0.85,
    attribution: '<a href="https://geoservices.ign.fr/" target="_blank">IGN</a> Masque forêt 2021–2023',
  },
  relief: {
    url: WMTS('ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW', 'estompage_grayscale', 'PM_0_15'), minzoom: 0, maxzoom: 15, opacity: 0.55,
    attribution: '<a href="https://geoservices.ign.fr/" target="_blank">IGN</a> Estompage',
  },
} as const;

// pmtiles:// URLs are read with HTTP range requests: only visible tiles are fetched.
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

@customElement('map-view')
export class MapView extends LitElement {
  static styles = [
    unsafeCSS(mlcss),
    css`
      :host { display: block; position: relative; }
      #map { position: absolute; inset: 0; }
      #map.dark .maplibregl-ctrl-attrib { background: rgba(22, 33, 28, .85); color: #9db0a6; }
      #map.dark .maplibregl-ctrl-attrib a { color: #c9d6cf; }
      #map.dark .maplibregl-ctrl-group { background: #16211c; box-shadow: 0 0 0 1px #25342d; }
      #map.dark .maplibregl-ctrl-group button + button { border-top-color: #25342d; }
      #map.dark .maplibregl-ctrl-group button span { filter: invert(1); }
    `,
  ];

  /** URL of the communes PMTiles file. */
  @property() tiles = '';
  @property({ attribute: false }) departements: GeoJSON.FeatureCollection | null = null;
  @property({ attribute: false }) paint: Map<string, Paint> = new Map();
  @property() selected: string | null = null;
  @property({ type: Boolean }) dark = false;
  /** When set, the map zooms to these bounds (e.g. the chosen département). */
  @property({ attribute: false }) zoomTo: Bounds | null = null;
  /** Optional background layers drawn under the communes. */
  @property({ attribute: false }) overlays: { forest: boolean; relief: boolean } = { forest: false, relief: false };

  private map?: MlMap;
  private styleReady = false;
  private hovered: string | null = null;
  private resizeObs?: ResizeObserver;
  private lastSelected: string | null = null;
  /** Feature states already sent, so a repaint only touches communes whose colour changed. */
  private sent = new Map<string, string>();

  render() {
    return html`<div id="map" class=${this.dark ? 'dark' : ''} role="region" aria-label="Carte des communes"></div>`;
  }

  firstUpdated() {
    const el = this.renderRoot.querySelector('#map') as HTMLElement;
    this.map = new maplibregl.Map({ container: el, style: this.dark ? STYLE_DARK : STYLE_LIGHT, bounds: this.zoomTo ?? FRANCE, fitBoundsOptions: { padding: 16 } });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    // Re-add our layers whenever the basemap style (light/dark) is (re)loaded.
    this.map.on('style.load', () => {
      this.styleReady = true;
      this.sent.clear();
      this.addData();
    });
    // The container can still be sizing itself on the first frame: fit again once the map is ready.
    this.map.once('load', () => this.map!.fitBounds(this.zoomTo ?? FRANCE, { padding: 16, animate: false }));
    this.map.on('mousemove', 'fill', (e) => {
      const f = e.features?.[0];
      const code = (f && !this.paint.get(f.properties?.code)?.hidden ? f.properties?.code : undefined) as string | undefined;
      if (code === this.hovered) return;
      this.setState(this.hovered, { hover: false });
      this.hovered = code ?? null;
      this.setState(code ?? null, { hover: true });
      this.map!.getCanvas().style.cursor = code ? 'pointer' : '';
    });
    this.map.on('mouseleave', 'fill', () => {
      this.setState(this.hovered, { hover: false });
      this.hovered = null;
      this.map!.getCanvas().style.cursor = '';
    });
    this.map.on('click', 'fill', (e) => {
      const code = e.features?.[0]?.properties?.code as string | undefined;
      if (code && !this.paint.get(code)?.hidden) this.dispatchEvent(new CustomEvent('select', { detail: code, bubbles: true, composed: true }));
    });
    this.resizeObs = new ResizeObserver(() => this.map?.resize());
    this.resizeObs.observe(el);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObs?.disconnect();
  }

  private setState(code: string | null, state: Record<string, unknown>) {
    if (code && this.map?.getSource(SRC)) this.map.setFeatureState({ source: SRC, sourceLayer: LAYER, id: code }, state);
  }

  private addData() {
    const m = this.map;
    if (!m || !this.styleReady || !this.tiles || m.getSource(SRC)) return;
    const abs = new URL(this.tiles, location.href).href;
    for (const [id, o] of Object.entries(OVERLAYS)) {
      m.addSource(id, { type: 'raster', tiles: [o.url], tileSize: 256, minzoom: o.minzoom, maxzoom: o.maxzoom, attribution: o.attribution });
      m.addLayer({ id, type: 'raster', source: id, layout: { visibility: 'none' }, paint: { 'raster-opacity': o.opacity } });
    }
    m.addSource(SRC, { type: 'vector', url: `pmtiles://${abs}`, promoteId: { [LAYER]: 'code' } });
    m.addLayer({
      id: 'fill', type: 'fill', source: SRC, 'source-layer': LAYER,
      paint: {
        'fill-color': ['coalesce', ['feature-state', 'color'], TIER_COLORS.fail],
        'fill-opacity': this.fillOpacity(),
      },
    });
    m.addLayer({
      id: 'line', type: 'line', source: SRC, 'source-layer': LAYER, minzoom: 7,
      paint: { 'line-color': this.dark ? '#0b1410' : '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.2, 11, 0.8],
        'line-opacity': ['case', ['boolean', ['feature-state', 'hidden'], false], 0, 0.7] },
    });
    if (this.departements) {
      m.addSource('dep', { type: 'geojson', data: this.departements });
      m.addLayer({
        id: 'dep-line', type: 'line', source: 'dep',
        paint: { 'line-color': this.dark ? '#c9d6cf' : '#2c3e36', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 10, 1.6], 'line-opacity': 0.55 },
      });
    }
    m.addLayer({
      id: 'highlight', type: 'line', source: SRC, 'source-layer': LAYER,
      paint: {
        'line-color': this.dark ? '#ffffff' : '#0d2a1d',
        'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3,
          ['boolean', ['feature-state', 'hover'], false], 1.5, 0],
      },
    });
    this.applyOverlays();
    this.repaint();
  }

  /** Lighter commune colours while a background layer is shown, so it stays readable. */
  private fillOpacity(): maplibregl.ExpressionSpecification {
    const on = this.overlays.forest || this.overlays.relief;
    return ['case', ['boolean', ['feature-state', 'hidden'], false], 0,
      ['boolean', ['feature-state', 'strong'], false], on ? 0.45 : 0.82, on ? 0.08 : 0.25];
  }

  private applyOverlays() {
    const m = this.map;
    if (!m || !m.getLayer('fill')) return;
    for (const id of Object.keys(OVERLAYS) as (keyof typeof OVERLAYS)[]) {
      m.setLayoutProperty(id, 'visibility', this.overlays[id] ? 'visible' : 'none');
    }
    m.setPaintProperty('fill', 'fill-opacity', this.fillOpacity());
  }

  private repaint() {
    const m = this.map;
    if (!m || !m.getSource(SRC)) return;
    for (const [code, p] of this.paint) {
      const key = `${p.color}${p.strong ? 1 : 0}${p.hidden ? 1 : 0}`;
      if (this.sent.get(code) === key) continue;
      this.sent.set(code, key);
      m.setFeatureState({ source: SRC, sourceLayer: LAYER, id: code }, { color: p.color, strong: p.strong, hidden: !!p.hidden });
    }
    if (this.lastSelected && this.lastSelected !== this.selected) this.setState(this.lastSelected, { selected: false });
    this.lastSelected = this.selected;
    if (this.selected) this.setState(this.selected, { selected: true });
  }

  flyTo(lon: number, lat: number) {
    this.map?.flyTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 10) });
  }

  updated(changed: Map<string, unknown>) {
    if (!this.map) return;
    if (changed.has('dark') && changed.get('dark') !== undefined) {
      this.styleReady = false;
      // diff:false forces a full reload so 'style.load' fires and re-adds the communes.
      this.map.setStyle(this.dark ? STYLE_DARK : STYLE_LIGHT, { diff: false });
      return;
    }
    if (changed.has('tiles') || changed.has('departements')) this.addData();
    if (changed.has('paint') || changed.has('selected')) this.repaint();
    if (changed.has('overlays')) this.applyOverlays();
    if (changed.has('zoomTo') && changed.get('zoomTo') !== undefined) {
      this.map.fitBounds(this.zoomTo ?? FRANCE, { padding: 20, duration: 600 });
    }
  }
}
