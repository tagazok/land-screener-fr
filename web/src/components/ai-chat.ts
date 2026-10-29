import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Plan } from '../ai/plan';
import {
  DEFAULT_SETTINGS, assistant, loadSettings, nanoAvailability, saveSettings, type AiSettings, type NanoState,
} from '../ai/providers';

/** What the chat needs from the app: apply a plan, then describe the communes it now shows. */
export interface ChatHost {
  applyPlan(plan: Plan): { applied: string[]; dropped: string[] };
  facts(context: string): { count: number; text: string };
}

interface Msg {
  role: 'user' | 'assistant' | 'error';
  text: string;
  chips?: string[];
}

const EXAMPLES = [
  'Masque les communes avec plus de 3 risques',
  'Montre les communes où le prix des appartements a baissé en 3 ans',
  'Je veux vivre dans un village près d’une forêt, en colline, sans pollution ni inondation, avec une ville de 3 000 habitants à côté',
];

@customElement('ai-chat')
export class AiChat extends LitElement {
  @property({ attribute: false }) host!: ChatHost;
  @state() private open = false;
  @state() private settingsOpen = false;
  @state() private settings: AiSettings = loadSettings();
  @state() private nano: NanoState | null = null;
  @state() private busy = '';
  @state() private progress: number | null = null;
  @state() private msgs: Msg[] = [];
  @state() private draft = '';
  private abort?: AbortController;

  connectedCallback() {
    super.connectedCallback();
    nanoAvailability().then((s) => (this.nano = s));
  }

  private get ready(): boolean {
    if (this.settings.provider === 'bedrock') return !!this.settings.bedrockKey;
    return this.nano === 'available' || this.nano === 'downloadable' || this.nano === 'downloading';
  }

  private async send(text = this.draft.trim()) {
    if (!text || this.busy) return;
    this.draft = '';
    this.msgs = [...this.msgs, { role: 'user', text }];
    this.abort = new AbortController();
    const a = assistant(this.settings, (p) => (this.progress = p));
    const t0 = performance.now();
    try {
      this.busy = 'Je comprends la demande…';
      const before = this.history();
      const plan = await a.plan(before ? `Échange précédent :\n${before}\n\nNouvelle demande : ${text}` : text, this.abort.signal);
      const { applied, dropped } = this.host.applyPlan(plan);
      const chips = [...applied, ...dropped.map((d) => `ignoré : ${d}`)];
      if (plan.mode === 'answer') {
        this.busy = 'Je rédige la réponse…';
        const prev = this.history();
        const { count, text: facts } = this.host.facts(`${text} ${prev}`);
        const question = prev ? `Échange précédent :\n${prev}\n\nNouvelle question : ${text}` : text;
        const answer = count ? await a.answer(question, facts, this.abort.signal) : 'Aucune commune ne passe tous ces critères. Retirez un filtre (bouton × sur les étiquettes en haut) pour élargir la recherche.';
        this.msgs = [...this.msgs, { role: 'assistant', text: `${answer}\n\n${count} communes retenues.`, chips }];
      } else {
        this.msgs = [...this.msgs, { role: 'assistant', text: plan.summary || 'C’est fait.', chips }];
      }
      console.info(`[ai] ${this.settings.provider} ${(performance.now() - t0).toFixed(0)} ms`, plan);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.msgs = [...this.msgs, { role: 'error', text: (e as Error).message }];
    } finally {
      this.busy = '';
      this.progress = null;
    }
  }

  /** The previous question and answer, so a follow-up ("what is that risk?") keeps its context. */
  private history(): string {
    const done = this.msgs.slice(0, -1).filter((m) => m.role !== 'error');
    return done.slice(-2).map((m) => `${m.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${m.text}`).join('\n');
  }

  private saveSettings(e: Event) {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    this.settings = {
      provider: f.get('provider') === 'bedrock' ? 'bedrock' : 'nano',
      bedrockKey: String(f.get('key') ?? '').trim(),
      bedrockRegion: String(f.get('region') ?? '').trim() || DEFAULT_SETTINGS.bedrockRegion,
      bedrockModel: String(f.get('model') ?? '').trim() || DEFAULT_SETTINGS.bedrockModel,
    };
    saveSettings(this.settings);
    this.settingsOpen = false;
  }

  private nanoText(): string {
    switch (this.nano) {
      case 'available': return 'Modèle Gemini Nano prêt, sur votre appareil.';
      case 'downloadable': return 'Gemini Nano sera téléchargé par Chrome à la première question (plusieurs Go, une seule fois).';
      case 'downloading': return 'Chrome télécharge Gemini Nano…';
      case 'unavailable': return 'Gemini Nano n’est pas disponible sur cet appareil (mémoire, espace disque ou langue).';
      case 'unsupported': return 'Ce navigateur n’a pas de modèle intégré : il faut Chrome sur ordinateur (version 148 ou plus). Vous pouvez utiliser une clé Amazon Bedrock dans les réglages.';
      default: return 'Vérification du modèle…';
    }
  }

  render() {
    if (!this.open) {
      return html`<button class="fab" @click=${() => (this.open = true)} aria-label="Ouvrir l’assistant">✦ Assistant</button>`;
    }
    const s = this.settings;
    return html`
      <section class="panel" role="dialog" aria-label="Assistant">
        <header>
          <b>✦ Assistant</b>
          <small>${s.provider === 'bedrock' ? `Bedrock · ${s.bedrockModel.replace(/^us\./, '')}` : 'Gemini Nano (local)'}</small>
          <span class="grow"></span>
          <button class="icon" title="Réglages" aria-label="Réglages de l’assistant" @click=${() => (this.settingsOpen = !this.settingsOpen)}>⚙</button>
          <button class="icon" title="Fermer" aria-label="Fermer l’assistant" @click=${() => (this.open = false)}>×</button>
        </header>
        ${this.settingsOpen ? this.renderSettings() : nothing}
        <div class="log" aria-live="polite">
          ${this.msgs.length ? nothing : html`
            <p class="muted">${s.provider === 'nano' ? this.nanoText() : 'Les questions sont envoyées à Amazon Bedrock avec votre clé.'}</p>
            <p class="muted">Décrivez ce que vous cherchez ou demandez un changement de la carte. Exemples :</p>
            ${EXAMPLES.map((e) => html`<button class="ex" @click=${() => this.send(e)} ?disabled=${!this.ready}>${e}</button>`)}`}
          ${this.msgs.map((m) => html`
            <div class="msg ${m.role}">
              <p>${m.text}</p>
              ${m.chips?.length ? html`<div class="chips">${m.chips.map((c) => html`<span>${c}</span>`)}</div>` : nothing}
            </div>`)}
          ${this.busy ? html`<div class="msg assistant busy"><span class="spinner"></span> ${this.busy}
            ${this.progress !== null && this.progress < 1 ? html` (téléchargement du modèle ${Math.round(this.progress * 100)} %)` : nothing}
            <button class="link" @click=${() => this.abort?.abort()}>Arrêter</button></div>` : nothing}
        </div>
        <form class="ask" @submit=${(e: Event) => { e.preventDefault(); this.send(); }}>
          <textarea rows="2" placeholder=${this.ready ? 'Votre demande…' : 'Assistant indisponible : voir les réglages ⚙'}
            .value=${this.draft} ?disabled=${!this.ready || !!this.busy}
            @input=${(e: Event) => (this.draft = (e.target as HTMLTextAreaElement).value)}
            @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } }}></textarea>
          <button class="send" type="submit" ?disabled=${!this.ready || !!this.busy || !this.draft.trim()}>Envoyer</button>
        </form>
      </section>`;
  }

  private renderSettings() {
    const s = this.settings;
    return html`
      <form class="settings" @submit=${(e: Event) => this.saveSettings(e)}>
        <fieldset>
          <legend>Modèle</legend>
          <label><input type="radio" name="provider" value="nano" ?checked=${s.provider === 'nano'}> Gemini Nano dans Chrome (local, gratuit, rien ne sort de l’ordinateur)</label>
          <label><input type="radio" name="provider" value="bedrock" ?checked=${s.provider === 'bedrock'}> Amazon Bedrock (votre clé, meilleur pour les demandes longues)</label>
        </fieldset>
        <label>Clé d’API Bedrock<input name="key" type="password" autocomplete="off" .value=${s.bedrockKey} placeholder="ABSK…"></label>
        <div class="row">
          <label>Région<input name="region" .value=${s.bedrockRegion}></label>
          <label>Modèle<input name="model" .value=${s.bedrockModel}></label>
        </div>
        <p class="muted small">La clé reste dans ce navigateur (stockage local), n’est jamais envoyée ailleurs qu’à Amazon Bedrock, et n’apparaît pas dans le lien de partage. Préférez une clé de courte durée, limitée à Bedrock.</p>
        <div class="row end">
          ${s.bedrockKey ? html`<button type="button" class="link" @click=${() => { this.settings = { ...s, bedrockKey: '', provider: 'nano' }; saveSettings(this.settings); }}>Effacer la clé</button>` : nothing}
          <button type="submit" class="send">Enregistrer</button>
        </div>
      </form>`;
  }

  static styles = css`
    :host { position: fixed; left: 18px; bottom: 18px; z-index: 55; font: inherit; color: var(--ink); }
    .fab { border: 0; border-radius: 999px; padding: 11px 18px; font: inherit; font-weight: 650; cursor: pointer;
      background: var(--brand); color: #fff; box-shadow: 0 6px 20px rgba(0,0,0,.22); }
    .panel { width: min(420px, calc(100vw - 36px)); height: min(620px, calc(100vh - 110px)); display: flex; flex-direction: column;
      background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 16px 48px rgba(0,0,0,.25); overflow: hidden; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    header small { color: var(--muted); font-size: 12px; }
    .grow { flex: 1; }
    .icon { border: 0; background: transparent; color: var(--muted); font-size: 18px; cursor: pointer; width: 30px; height: 30px; border-radius: 8px; }
    .icon:hover { background: var(--surface-2); color: var(--ink); }
    .log { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .muted { color: var(--muted); font-size: 13px; margin: 0; }
    .small { font-size: 12px; }
    .ex { text-align: left; border: 1px solid var(--line); background: var(--surface-2); color: var(--ink); border-radius: 10px; padding: 8px 10px; font: inherit; font-size: 13px; cursor: pointer; }
    .ex:disabled { opacity: .5; cursor: default; }
    .msg { border-radius: 12px; padding: 9px 11px; font-size: 13.5px; line-height: 1.5; max-width: 92%; }
    .msg p { margin: 0; white-space: pre-wrap; }
    .msg.user { align-self: flex-end; background: var(--brand); color: #fff; }
    .msg.assistant { align-self: flex-start; background: var(--surface-2); }
    .msg.error { align-self: flex-start; background: var(--bad-bg); color: var(--bad); }
    .msg.busy { display: flex; align-items: center; gap: 8px; color: var(--muted); flex-wrap: wrap; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
    .chips span { font-size: 11.5px; background: var(--brand-soft); color: var(--brand-2); border-radius: 999px; padding: 2px 8px; }
    .ask { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--line); }
    textarea { flex: 1; resize: none; font: inherit; font-size: 13.5px; border: 1px solid var(--input-line, var(--line)); border-radius: 10px; padding: 8px; background: var(--input-bg, var(--surface)); color: var(--ink); box-sizing: border-box; }
    .send { border: 0; border-radius: 10px; padding: 0 14px; font: inherit; font-weight: 650; background: var(--brand); color: #fff; cursor: pointer; min-height: 36px; }
    .send:disabled { opacity: .45; cursor: default; }
    .link { border: 0; background: transparent; color: var(--brand-2); font: inherit; font-size: 12.5px; cursor: pointer; text-decoration: underline; }
    .settings { padding: 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 9px; background: var(--surface-2); font-size: 13px; }
    fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 5px; }
    legend { font-weight: 650; margin-bottom: 4px; }
    .settings label { display: flex; flex-direction: column; gap: 3px; }
    .settings fieldset label { flex-direction: row; align-items: flex-start; gap: 6px; }
    .settings input:not([type=radio]) { font: inherit; padding: 6px 8px; border: 1px solid var(--input-line, var(--line)); border-radius: 8px; background: var(--input-bg, var(--surface)); color: var(--ink); width: 100%; box-sizing: border-box; }
    .row { display: flex; gap: 8px; } .row > * { flex: 1; } .row.end { justify-content: flex-end; align-items: center; } .row.end > * { flex: none; }
    .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--brand-2); animation: spin .9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;
}
