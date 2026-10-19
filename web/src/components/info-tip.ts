import { LitElement, css, html } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';

/**
 * A small "?" button that shows an explanation on hover, keyboard focus or tap.
 * The bubble is position: fixed so it is never clipped by scrolling containers
 * (the table, the side panel, the map overlay).
 */
@customElement('info-tip')
export class InfoTip extends LitElement {
  /** Explanation text. Blank lines separate paragraphs. */
  @property() text = '';
  /** What the tip is about, read by screen readers ("Rendement brut : aide"). */
  @property() label = '';
  @state() private open = false;
  @state() private tipStyle = '';
  @query('button') private btn!: HTMLButtonElement;

  static styles = css`
    :host { display: inline-block; vertical-align: middle; margin-left: 4px; line-height: 1; }
    button {
      width: 15px; height: 15px; padding: 0; border-radius: 50%;
      border: 0; background: var(--tip-btn, #e3e9e5); color: var(--tip-btn-fg, #4f5f57);
      font: 700 10px/15px system-ui, sans-serif; cursor: help; transition: background .15s, color .15s;
    }
    button:hover, button[aria-expanded='true'] { background: #1f7a4c; color: #fff; }
    button:focus-visible { outline: 2px solid #2a6f4f; outline-offset: 2px; }
    .tip {
      position: fixed; z-index: 1000; width: max-content; max-width: 320px; box-sizing: border-box;
      background: #15241d; color: #f2f6f3; padding: 10px 12px; border-radius: 10px;
      font: 400 12.5px/1.45 system-ui, sans-serif; text-align: left; text-transform: none;
      letter-spacing: normal; white-space: pre-line; box-shadow: 0 4px 14px rgba(0, 0, 0, .25);
      pointer-events: none;
    }
    .tip[hidden] { display: none; }
  `;

  render() {
    return html`
      <button type="button" aria-label=${`${this.label} : aide`} aria-describedby="tip" aria-expanded=${this.open ? 'true' : 'false'}
        @mouseenter=${this.show} @mouseleave=${this.hide} @focus=${this.show} @blur=${this.hide}
        @click=${this.onClick} @keydown=${(e: KeyboardEvent) => e.key === 'Escape' && this.hide()}>?</button>
      <div id="tip" role="tooltip" class="tip" style=${this.tipStyle} ?hidden=${!this.open}>${this.text}</div>`;
  }

  private onClick(e: Event) {
    // Touch screens have no hover: a tap opens the tip. Never let the tap
    // reach a parent (table row, sort button, checkbox label).
    e.stopPropagation();
    e.preventDefault();
    this.show();
  }

  private show = () => {
    const r = this.btn.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    // Open below the "?" unless that would run off the bottom of the window.
    const below = r.bottom + 220 < window.innerHeight;
    this.tipStyle = below
      ? `left:${left}px;top:${r.bottom + 6}px;max-width:${w}px`
      : `left:${left}px;bottom:${window.innerHeight - r.top + 6}px;max-width:${w}px`;
    this.open = true;
  };

  private hide = () => {
    this.open = false;
  };
}
