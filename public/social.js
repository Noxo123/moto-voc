/* ═══════════════════════════════════════════
   MOTOVOC — social.js
   Extended social features: search, saved, profile
   ═══════════════════════════════════════════ */

(() => {
  const $ = s => document.querySelector(s);

  const api = async (p, o = {}) => {
    const t = localStorage.getItem('moto_token');
    const r = await fetch('/api' + p, {
      ...o,
      headers: {
        'Content-Type': 'application/json',
        ...(t ? { Authorization: 'Bearer ' + t } : {})
      }
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Error(d.error || 'Erreur');
    return d;
  };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])
  );

  /* ── Social Panel (fullscreen overlay) ── */
  function panel(title, body) {
    const d = document.createElement('div');
    d.className = 'modal';
    d.innerHTML = `
      <div class="modal-card social-panel">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
          <h2 style="margin:0">${title}</h2>
          <button class="action" data-x style="font-size:20px;padding:6px 10px">✕</button>
        </div>
        ${body}
      </div>`;
    document.body.append(d);
    d.querySelector('[data-x]').onclick = () => d.remove();
    d.addEventListener('click', e => { if (e.target === d) d.remove(); });
    return d;
  }

  /* ── Inject social toolbar into header ── */
  async function install() {
    if (!$('#app') || $('#app').classList.contains('hidden') || $('#socialTools')) return;
    const h = document.querySelector('.header-actions');
    if (!h) return;

    const t = document.createElement('div');
    t.id = 'socialTools';
    t.className = 'social-tools';
    t.innerHTML = `
      <button class="icon" id="socialSearch" title="Recherche">⌕</button>
      <button class="icon" id="socialSaved"  title="Enregistrés">🔖</button>
      <button class="icon" id="socialProfile" title="Mon profil">●</button>`;
    h.prepend(t);

    /* ─ Search ─ */
    $('#socialSearch').onclick = () => {
      const d = panel('Recherche globale', `
        <div style="position:relative;margin-bottom:14px">
          <input id="sq" placeholder="Recherche un rider, une publication…"
                 style="width:100%;background:var(--asphalt4);border:1px solid var(--border2);border-radius:99px;padding:12px 16px 12px 42px;color:var(--text);font-family:var(--font-body);font-size:14px;outline:none;transition:border-color .18s"
                 onfocus="this.style.borderColor='var(--ember)'" onblur="this.style.borderColor='var(--border2)'">
          <span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:18px">⌕</span>
        </div>
        <div id="sr" class="list" style="max-height:50vh;overflow-y:auto"></div>`);

      const i = d.querySelector('#sq');
      const res = d.querySelector('#sr');

      const run = async () => {
        const q = i.value.trim();
        if (!q) { res.innerHTML = ''; return; }
        res.innerHTML = '<div class="empty" style="padding:16px">Recherche…</div>';
        try {
          const x = await api('/search?q=' + encodeURIComponent(q));
          res.innerHTML = x.users.map(u => `
            <div class="person">
              <div class="avatar">${esc((u.display_name || '?')[0])}</div>
              <div>
                <b>${esc(u.display_name)}</b>
                <div class="muted">@${esc(u.username)}</div>
              </div>
              <button class="primary" data-f="${u.id}" style="flex:none;padding:9px 14px;font-size:13px">
                Suivre
              </button>
            </div>`).join('') || '<div class="empty" style="padding:20px">Aucun résultat pour « ' + esc(q) + ' »</div>';

          d.querySelectorAll('[data-f]').forEach(b => b.onclick = async () => {
            await api('/users/' + b.dataset.f + '/follow', { method: 'POST' });
            b.textContent = '✓ Suivi';
            b.style.background = 'var(--success)';
            b.disabled = true;
          });
        } catch { res.innerHTML = '<div class="empty" style="padding:20px">Erreur de recherche</div>'; }
      };

      i.oninput = () => { clearTimeout(i._t); i._t = setTimeout(run, 280); };
      setTimeout(() => i.focus(), 50);
    };

    /* ─ Saved posts ─ */
    $('#socialSaved').onclick = async () => {
      const d = panel('Publications enregistrées', '<div id="savedList" class="list" style="max-height:65vh;overflow-y:auto"><div class="empty" style="padding:20px">Chargement…</div></div>');
      try {
        const x = await api('/saved');
        const el = d.querySelector('#savedList');
        if (!el) return;
        el.innerHTML = x.posts.length
          ? x.posts.map(p => `
              <article class="card" style="margin-bottom:0">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
                  <div class="avatar" style="width:32px;height:32px;font-size:12px">${esc((p.display_name || '?')[0])}</div>
                  <b style="font-size:14px">${esc(p.display_name)}</b>
                </div>
                <div style="font-size:14px;color:var(--text);font-family:var(--font-body);line-height:1.6">${esc(p.content)}</div>
              </article>`).join('')
          : '<div class="empty" style="padding:40px">Aucune publication enregistrée 🔖<br><span style="font-size:12px;margin-top:6px;display:block">Enregistre des posts depuis ton fil</span></div>';
      } catch {
        const el = d.querySelector('#savedList');
        if (el) el.innerHTML = '<div class="empty" style="padding:20px">Impossible de charger</div>';
      }
    };

    /* ─ My profile ─ */
    $('#socialProfile').onclick = async () => {
      const d = panel('Mon profil', '<div id="profileContent" style="text-align:center;padding:8px 0"><div class="empty" style="padding:30px">Chargement…</div></div>');
      try {
        const m = (await api('/me')).user;
        const p = await api('/profile/' + encodeURIComponent(m.username));
        const el = d.querySelector('#profileContent');
        if (!el) return;
        el.innerHTML = `
          <div class="profile-social">
            <div class="avatar avatar-xl">${esc((p.user.display_name || '?')[0])}</div>
            <h2>${esc(p.user.display_name)}</h2>
            <div class="muted">@${esc(p.user.username)}</div>
            <p>${esc(p.user.bio || 'Aucune bio — parle-nous de ta passion moto 🏍')}</p>
            <div class="profile-stats">
              <b>${p.posts.length}<small>Publications</small></b>
              <b>${p.followers}<small>Abonnés</small></b>
              <b>${p.following}<small>Abonnements</small></b>
            </div>
          </div>
          ${p.posts.length ? `
            <div style="margin-top:20px;border-top:1px solid var(--border);padding-top:16px;text-align:left">
              <div style="font-family:var(--font-display);font-size:16px;letter-spacing:1px;color:var(--chrome-dim);margin-bottom:12px">
                DERNIÈRES PUBLICATIONS
              </div>
              <div class="list">
                ${p.posts.slice(0, 5).map(post => `
                  <div class="card" style="padding:14px">
                    <div style="font-size:14px;color:var(--text);font-family:var(--font-body);line-height:1.6">${esc(post.content)}</div>
                  </div>`).join('')}
              </div>
            </div>` : ''}`;
      } catch {
        const el = d.querySelector('#profileContent');
        if (el) el.innerHTML = '<div class="empty" style="padding:30px">Impossible de charger le profil</div>';
      }
    };
  }

  /* Poll until app is ready */
  document.addEventListener('DOMContentLoaded', () => {
    const check = setInterval(() => {
      if (!$('#app') || $('#app').classList.contains('hidden')) return;
      clearInterval(check);
      install();
    }, 300);
    // Also watch for auth transitions
    const observer = new MutationObserver(() => {
      if ($('#app') && !$('#app').classList.contains('hidden') && !$('#socialTools')) install();
    });
    const app = document.getElementById('app');
    if (app) observer.observe(app, { attributes: true, attributeFilter: ['class'] });
  });
})();
