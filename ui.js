/* ==========================================================================
   UI CONTROLLER — routing, hub, chantier management, signalement capture
   ========================================================================== */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; };

// ------ STATE ------
const app = {
  currentPage: 'hub',
  chantierCourant: null,
  sessionActive: false,
  currentSignalementDraft: null,
  toastTimer: null,
  camStream: null,
  photoCat: ''
};

// ------ TOAST ------
function toast(msg, type = 'info', duration = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  requestAnimationFrame(() => {
    el.classList.add('visible');
  });
  if (app.toastTimer) clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => {
    el.classList.remove('visible');
  }, duration);
}

// ------ SHEET ------
function sheet(opts) {
  return new Promise(resolve => {
    const backdrop = $('sheet-backdrop');
    const s = $('sheet');
    $('sheet-title').textContent = opts.title || '';
    const bodyEl = $('sheet-body');
    if (opts.html) bodyEl.innerHTML = opts.html;
    else bodyEl.textContent = opts.body || '';
    const actionsEl = $('sheet-actions');
    actionsEl.innerHTML = '';
    (opts.actions || [{ label: 'OK', value: true, primary: true }]).forEach(a => {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.className = a.primary ? 'sheet-btn-primary' : a.danger ? 'sheet-btn-danger' : 'sheet-btn-cancel';
      b.onclick = () => {
        s.classList.remove('visible');
        backdrop.classList.remove('visible');
        setTimeout(() => resolve(a.value), 280);
      };
      actionsEl.appendChild(b);
    });
    backdrop.classList.add('visible');
    s.classList.add('visible');
    backdrop.onclick = () => {
      if (opts.dismissible !== false) {
        s.classList.remove('visible');
        backdrop.classList.remove('visible');
        setTimeout(() => resolve(null), 280);
      }
    };
  });
}

// ------ NAVIGATION ------
function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const el = $('page-' + page);
  if (el) el.classList.add('active');
  app.currentPage = page;

  // Update bottom nav
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const nav = $('nav-' + page);
  if (nav) nav.classList.add('active');

  // Show/hide navbar depending on page
  const navbar = $('navbar');
  if (page === 'hub' || page === 'journal' || page === 'archive' || page === 'menu') {
    navbar.style.display = 'grid';
  } else {
    navbar.style.display = 'none';
  }

  // Load page data
  if (page === 'hub') renderHub();
  if (page === 'journal') renderJournal();
  if (page === 'archive') renderArchive();
  if (page === 'menu') { updateMenuSessionInfo(); updateQuotaDisplay(); }
}
window.navigate = navigate;

// ------ HUB ------
async function renderHub() {
  const chantiers = await PKT_DB.getAll(PKT_DB.STORES.chantiers);
  chantiers.sort((a,b) => (b.updated||0) - (a.updated||0));
  const list = $('hub-chantier-list');
  if (!chantiers.length) {
    list.innerHTML = '<div class="empty-card">Aucun chantier enregistré. Commencez une marche libre ou créez un chantier.</div>';
    return;
  }
  list.innerHTML = chantiers.slice(0, 6).map(c => {
    const count = c.signalement_count || 0;
    const pkR = c.pk_start != null ? (c.pk_start/1000).toFixed(3) : '—';
    const pkF = c.pk_end != null ? (c.pk_end/1000).toFixed(3) : null;
    const rangeStr = pkF ? `PK ${pkR} → ${pkF}` : `PK ${pkR}`;
    return `
    <div class="chantier-card" onclick="openChantier('${c.id}')">
      <div class="chantier-dot"></div>
      <div class="chantier-body">
        <div class="chantier-name">${esc(c.name)}</div>
        <div class="chantier-meta">${rangeStr} · ${count} point${count>1?'s':''}</div>
      </div>
      <div class="chantier-chevron">›</div>
    </div>`;
  }).join('');
}

// ------ QUICK ACTIONS ------
window.startQuickWalk = async function() {
  await beginSession({ mode: 'libre' });
};

window.startWithPK = async function() {
  const html = `
    <div class="sheet-field-group">
      <label class="sheet-label">PK de départ (décimal)</label>
      <input id="sheet-pk-input" class="field" type="number" step="0.001" placeholder="ex : 42.350" inputmode="decimal" />
    </div>`;
  const result = await sheet({
    title: 'Démarrer avec PK',
    html,
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Démarrer', value: 'ok', primary: true }
    ]
  });
  if (result === 'ok') {
    const v = parseFloat($('sheet-pk-input')?.value);
    if (isNaN(v)) { toast('PK invalide', 'error'); return; }
    await beginSession({ mode: 'cumulatif', pkStart: v * 1000 });
  }
};

window.openChantier = async function(id) {
  const c = await PKT_DB.get(PKT_DB.STORES.chantiers, id);
  if (!c) return;
  app.chantierCourant = c;
  const html = `
    <div class="sheet-field-group">
      <label class="sheet-label">Chantier</label>
      <div style="font-size:16px;font-weight:500;margin-bottom:2px;">${esc(c.name)}</div>
      <div style="font-size:13px;color:var(--ink-2);">PK ${(c.pk_start/1000).toFixed(3)}${c.pk_end?' → '+(c.pk_end/1000).toFixed(3):''}</div>
    </div>
    <div class="sheet-field-group">
      <label class="sheet-label">Mode</label>
      <div style="font-size:13px;color:var(--ink-1);">Localisation précise par map-matching sur le tracé de référence.</div>
    </div>`;
  const result = await sheet({
    title: 'Reprendre le chantier',
    html,
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Démarrer', value: 'ok', primary: true }
    ]
  });
  if (result === 'ok') {
    await beginSession({
      mode: 'chantier',
      chantierId: c.id,
      refTrace: c.ref_trace,
      pkStart: c.pk_start,
      pkFin: c.pk_end
    });
  }
};

window.createChantier = async function() {
  const html = `
    <div class="sheet-field-group">
      <label class="sheet-label">Nom du chantier</label>
      <input id="sh-name" class="field" type="text" placeholder="ex : RER B — section Aulnay" />
    </div>
    <div class="sheet-field-group">
      <label class="sheet-label">Ligne</label>
      <input id="sh-line" class="field" type="text" placeholder="ex : 830000" />
    </div>
    <div class="sheet-field-group">
      <label class="sheet-label">PK de départ</label>
      <input id="sh-pks" class="field" type="number" step="0.001" inputmode="decimal" placeholder="42.000" />
    </div>
    <div class="sheet-field-group">
      <label class="sheet-label">PK de fin (optionnel)</label>
      <input id="sh-pkf" class="field" type="number" step="0.001" inputmode="decimal" placeholder="43.500" />
    </div>
    <div style="font-size:12px;color:var(--ink-2);line-height:1.55;">La première session enregistrera la trace de reconnaissance. Les sessions suivantes utiliseront cette trace pour un repérage précis.</div>`;
  const result = await sheet({
    title: 'Nouveau chantier',
    html,
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Créer et démarrer', value: 'ok', primary: true }
    ]
  });
  if (result !== 'ok') return;
  const name = $('sh-name').value.trim();
  const line = $('sh-line').value.trim();
  const pks = parseFloat($('sh-pks').value);
  const pkf = parseFloat($('sh-pkf').value);
  if (!name) { toast('Nom requis', 'error'); return; }
  if (isNaN(pks)) { toast('PK de départ requis', 'error'); return; }
  const chantier = {
    id: 'ch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name, line: line || null,
    pk_start: pks * 1000,
    pk_end: isNaN(pkf) ? null : pkf * 1000,
    ref_trace: null,
    signalement_count: 0,
    created: Date.now(),
    updated: Date.now()
  };
  await PKT_DB.put(PKT_DB.STORES.chantiers, chantier);
  // Begin reconnaissance session
  await beginSession({
    mode: 'cumulatif',
    chantierId: chantier.id,
    pkStart: chantier.pk_start,
    pkFin: chantier.pk_end,
    isReconnaissance: true
  });
};

// ------ TRACKING SESSION ------
async function beginSession(opts) {
  app.sessionActive = true;
  app.sessionOpts = opts;
  navigate('track');
  $('track-mode').textContent = opts.mode === 'chantier' ? 'CHANTIER' : opts.mode === 'cumulatif' ? 'PK CUMULATIF' : 'MARCHE LIBRE';
  $('btn-main').className = 'btn-main go';
  $('btn-main').innerHTML = iconPlay() + ' Démarrer le suivi';
  $('btn-main').onclick = () => tryStart(opts);
  $('mark-zone').classList.remove('visible');
  refreshTrackingUI(PKT_TRACKER.getSnapshot());
}

async function tryStart(opts) {
  await PKT_TRACKER.start(opts);
  $('btn-main').className = 'btn-main stop';
  $('btn-main').innerHTML = iconStop() + ' Arrêter';
  $('btn-main').onclick = stopSession;
  $('mark-zone').classList.add('visible');
}

async function stopSession() {
  PKT_TRACKER.stop();
  // If reconnaissance, offer to save trace as reference
  if (app.sessionOpts && app.sessionOpts.isReconnaissance && app.sessionOpts.chantierId) {
    const trace = PKT_TRACKER.getTrace();
    if (trace.length > 10) {
      // Build reference with PK interpolation
      const chantier = await PKT_DB.get(PKT_DB.STORES.chantiers, app.sessionOpts.chantierId);
      if (chantier) {
        const refTrace = buildRefTrace(trace, chantier.pk_start);
        chantier.ref_trace = refTrace;
        chantier.updated = Date.now();
        await PKT_DB.put(PKT_DB.STORES.chantiers, chantier);
        toast('Tracé de référence enregistré', 'success');
      }
    }
  }
  $('btn-main').className = 'btn-main go';
  $('btn-main').innerHTML = iconPlay() + ' Démarrer le suivi';
  $('btn-main').onclick = () => tryStart(app.sessionOpts);
  $('mark-zone').classList.remove('visible');
}

function buildRefTrace(trace, pkStart) {
  const out = [];
  let dist = 0;
  for (let i = 0; i < trace.length; i++) {
    const p = trace[i];
    if (i > 0) {
      dist += PKT_GEO.haversine(trace[i-1].lat, trace[i-1].lon, p.lat, p.lon);
    }
    out.push({ lat: p.lat, lon: p.lon, pk_m: pkStart + dist });
  }
  return out;
}

// ------ TRACKING UI ------
function refreshTrackingUI(s) {
  if (!s) s = PKT_TRACKER.getSnapshot();
  const pk = s.pk;
  const pkEl = $('pk-value');
  pkEl.innerHTML = `<span class="pk-km">${pk.sign}${pk.km}</span><span class="pk-plus">+</span><span class="pk-m">${pk.m}</span>`;
  pkEl.classList.toggle('low-trust', s.trust === 'stop');

  // Trust chip
  const chip = $('trust-chip');
  const trustText = {
    go: 'HAUTE CONFIANCE',
    slow: 'CONFIANCE MOYENNE',
    stop: 'À RECALIBRER'
  }[s.trust] || '';
  chip.className = 'trust-chip ' + s.trust;
  chip.innerHTML = '<span class="dot"></span>' + trustText;

  // Subtitle
  const subBits = [];
  if (app.sessionOpts?.isReconnaissance) subBits.push('Reconnaissance');
  else if (s.mode === 'chantier') subBits.push('Map-matching');
  else if (s.mode === 'cumulatif') subBits.push('PK cumulatif');
  else subBits.push('Marche libre');
  if (s.drift > 0 && s.mode !== 'chantier') subBits.push('±' + s.drift + ' m dérive');
  $('pk-sub').innerHTML = subBits.map((b,i) =>
    (i>0 ? '<span class="pk-sub-dot"></span>' : '') + esc(b)
  ).join('');

  // Telemetry
  const dist = s.dist;
  $('telem-dist').textContent = dist < 1000 ? Math.round(dist) + ' m' : (dist/1000).toFixed(2) + ' km';
  $('telem-speed').textContent = s.speed != null ? s.speed : '—';
  $('telem-steps').textContent = s.steps || 0;

  // Progress bar
  if (s.pkFin && app.sessionOpts) {
    const range = Math.abs(s.pkFin - (app.sessionOpts.pkStart || 0));
    if (range > 0) {
      const done = Math.abs(s.pkM - (app.sessionOpts.pkStart || 0));
      const pct = Math.min(100, (done / range) * 100);
      $('pk-bar-wrap').classList.add('visible');
      $('pk-bar-fill').style.width = pct.toFixed(0) + '%';
      $('pk-bar-pct').textContent = pct.toFixed(0) + '%';
    }
  } else {
    $('pk-bar-wrap').classList.remove('visible');
  }
}

// ------ TRACKER EVENTS ------
PKT_TRACKER.onUpdate(refreshTrackingUI);
PKT_TRACKER.onEvent(async (type, data) => {
  if (type === 'sens-detected') {
    const result = await sheet({
      title: 'Confirmer le sens de marche',
      body: `PK croissants vers le ${data.label} (${Math.round(data.bearing)}°). Correct ?`,
      actions: [
        { label: 'Inverser', value: 'no' },
        { label: 'Correct', value: 'yes', primary: true }
      ],
      dismissible: false
    });
    if (result === 'yes') PKT_TRACKER.lockSens(data.sens);
    else PKT_TRACKER.lockSens(-data.sens);
    toast('Sens verrouillé', 'success');
  }
  if (type === 'gps-degraded') {
    toast('GPS dégradé ±' + Math.round(data.acc) + ' m — confiance diminuée', 'warn');
  }
  if (type === 'gps-error') {
    toast('Erreur GPS : ' + data.message, 'error');
  }
  if (type === 'recalibrated') {
    toast('Recalibré : ' + data.from + ' → ' + data.to, 'success');
  }
});

// ------ QUICK MARK ACTIONS ------
window.quickMark = async function(note) {
  const s = PKT_TRACKER.getSnapshot();
  if (!s.active) { toast('Démarrez le suivi GPS', 'error'); return; }
  await createSignalement({ type: 'normal', note });
  toast(s.pk.full + ' · ' + note, 'success');
  vibrate([80]);
};

window.quickAlert = async function() {
  const s = PKT_TRACKER.getSnapshot();
  if (!s.active) { toast('Démarrez le suivi GPS', 'error'); return; }
  const note = $('note-input').value.trim() || 'Anomalie';
  await createSignalement({ type: 'alert', note });
  $('note-input').value = '';
  toast('⚠ Alerte au PK ' + s.pk.full, 'error');
  vibrate([140, 60, 140]);
};

window.saveMark = async function() {
  const s = PKT_TRACKER.getSnapshot();
  if (!s.active) { toast('Démarrez le suivi GPS', 'error'); return; }
  const note = $('note-input').value.trim();
  await createSignalement({ type: 'normal', note });
  $('note-input').value = '';
  toast('PK ' + s.pk.full + ' enregistré', 'success');
  vibrate([80]);
};

window.recalibrate = async function() {
  const v = parseFloat($('recal-input').value);
  if (isNaN(v)) { toast('PK invalide', 'error'); return; }
  PKT_TRACKER.recalibrate(v);
  $('recal-input').value = '';
};

async function createSignalement(opts) {
  const s = PKT_TRACKER.getSnapshot();
  const id = 'sig_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = new Date();
  const payload = {
    id,
    chantier_id: app.sessionOpts?.chantierId || null,
    pk: s.pk.full,
    pk_m: Math.round(s.pkM),
    lat: s.lat ? +s.lat.toFixed(7) : null,
    lon: s.lon ? +s.lon.toFixed(7) : null,
    acc: s.acc ? Math.round(s.acc) : null,
    cap: s.heading != null ? Math.round(s.heading) : null,
    trust: s.trust,
    ts: now.toISOString(),
    ts_display: now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    date_display: now.toLocaleDateString('fr-FR'),
    type: opts.type,
    cat: opts.cat || '',
    note: opts.note || '',
    photo_id: opts.photo_id || null,
    statut: 'ouvert',
    hash: await sha256(id + '|' + Math.round(s.pkM) + '|' + (s.lat||'') + '|' + now.toISOString())
  };
  await PKT_DB.put(PKT_DB.STORES.signalements, payload);
  // Update chantier count
  if (payload.chantier_id) {
    const c = await PKT_DB.get(PKT_DB.STORES.chantiers, payload.chantier_id);
    if (c) { c.signalement_count = (c.signalement_count||0) + 1; c.updated = Date.now(); await PKT_DB.put(PKT_DB.STORES.chantiers, c); }
  }
  return payload;
}

async function sha256(msg) {
  try {
    const buf = new TextEncoder().encode(msg);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0,16);
  } catch { return ''; }
}

function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch {} }

// ------ JOURNAL ------
let journalFilter = 'all';
async function renderJournal() {
  const all = await PKT_DB.getAll(PKT_DB.STORES.signalements);
  all.sort((a,b) => (b.ts > a.ts ? 1 : -1));
  const list = all.filter(h =>
    journalFilter === 'all'
    || (journalFilter === 'photo' && h.photo_id)
    || (journalFilter === 'alert' && h.type === 'alert')
  );
  $('journal-count').textContent = list.length + ' pt' + (list.length>1?'s':'');
  const el = $('journal-list');
  if (!list.length) {
    el.innerHTML = '<div class="empty">Aucune entrée</div>';
    return;
  }
  // Render first
  el.innerHTML = list.map(h => `
    <div class="entry${h.type === 'alert' ? ' alert' : ''}">
      <div class="entry-hdr">
        <div>
          <div class="entry-pk">${esc(h.pk)}</div>
          <div class="entry-time">${esc(h.date_display)} · ${esc(h.ts_display)}${h.cat ? ' · ' + esc(h.cat) : ''}</div>
        </div>
        <div class="entry-right">
          <span class="badge ${h.type === 'alert' ? 'alert' : h.photo_id ? 'photo' : 'ok'}">${h.type === 'alert' ? 'Alerte' : h.photo_id ? 'Photo' : 'OK'}</span>
          <button class="del-btn" onclick="delSignalement('${h.id}')">×</button>
        </div>
      </div>
      ${h.photo_id ? `<div class="entry-photo-wrap" data-photo-id="${h.photo_id}"><div style="width:100%;height:140px;background:var(--bg-3);display:flex;align-items:center;justify-content:center;color:var(--ink-3);font-size:11px;">Chargement…</div></div>` : ''}
      <div class="entry-body">
        ${h.note ? '<div class="entry-note">'+esc(h.note)+'</div>' : ''}
        <div class="entry-coords">${h.lat ? h.lat+'°N  '+h.lon+'°E  ±'+h.acc+' m' : ''}${h.cap != null ? '  •  cap '+h.cap+'°' : ''}</div>
      </div>
    </div>
  `).join('');
  // Lazy-load photo thumbs
  document.querySelectorAll('.entry-photo-wrap[data-photo-id]').forEach(async (wrap) => {
    const pid = wrap.dataset.photoId;
    const data = await PKT_DB.get(PKT_DB.STORES.photos, pid);
    if (data) {
      wrap.innerHTML = `<img class="entry-photo" src="${data}" loading="lazy" alt="Photo" />`;
    }
  });
}
window.setFilter = function(f, el) {
  journalFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderJournal();
};
window.delSignalement = async function(id) {
  const ok = await sheet({
    title: 'Supprimer ce point ?',
    body: 'Cette action est irréversible.',
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Supprimer', value: 'yes', danger: true }
    ]
  });
  if (ok === 'yes') {
    await PKT_DB.del(PKT_DB.STORES.signalements, id);
    toast('Supprimé', 'success');
    renderJournal();
  }
};

// ------ PHOTO FLOW ------
let _currentPhotoDataUrl = null;

window.openPhoto = function() {
  const s = PKT_TRACKER.getSnapshot();
  if (!s.active) { toast('Démarrez le suivi GPS', 'error'); return; }
  navigate('photo');
  refreshPhotoDisplay();
};

window.closePhoto = function() {
  PKT_PHOTO.closeCamera();
  const v = $('cam-video');
  v.srcObject = null; v.style.display = 'none';
  $('cam-ph').style.display = 'block';
  $('btn-cam').style.display = 'flex';
  $('btn-shoot').style.display = 'none';
  $('preview-wrap').style.display = 'none';
  $('photo-note').value = '';
  _currentPhotoDataUrl = null;
  app.photoCat = '';
  document.querySelectorAll('#photo-cats .chip').forEach(c => c.classList.remove('selected'));
  navigate('track');
};

function refreshPhotoDisplay() {
  const s = PKT_TRACKER.getSnapshot();
  $('photo-pk').innerHTML = `<span>${s.pk.sign}${s.pk.km}</span><span class="pk-plus">+</span><span>${s.pk.m}</span>`;
  $('photo-pk-top').textContent = s.pk.full;
  $('photo-coords').textContent = s.lat ? s.lat.toFixed(6)+'°N  '+s.lon.toFixed(6)+'°E  · ±'+s.acc+' m' : '';
}

window.activateCam = async function() {
  const v = $('cam-video');
  const ok = await PKT_PHOTO.openCamera(v);
  if (!ok) { toast('Caméra non disponible', 'error'); return; }
  $('cam-ph').style.display = 'none';
  v.style.display = 'block';
  $('btn-cam').style.display = 'none';
  $('btn-shoot').style.display = 'flex';
  $('preview-wrap').style.display = 'none';
};

window.shoot = function() {
  const v = $('cam-video');
  const s = PKT_TRACKER.getSnapshot();
  const stampInfo = {
    pk: s.pk.full,
    chantier: app.sessionOpts?.chantierId ? (app.chantierCourant?.name || '') : '',
    lat: s.lat, lon: s.lon,
    ts: new Date()
  };
  const dataUrl = PKT_PHOTO.captureFromVideo(v, stampInfo, 0.82);
  if (!dataUrl) { toast('Erreur capture', 'error'); return; }
  PKT_PHOTO.closeCamera();
  v.srcObject = null; v.style.display = 'none';
  _currentPhotoDataUrl = dataUrl;
  $('preview-img').src = dataUrl;
  $('preview-wrap').style.display = 'block';
  $('btn-shoot').style.display = 'none';
  $('btn-cam').style.display = 'flex';
  $('btn-cam').innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l16 16M20 4L4 20"/></svg> Reprendre';
};

window.loadFromGallery = function(evt) {
  const f = evt.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const s = PKT_TRACKER.getSnapshot();
      const stampInfo = {
        pk: s.pk.full,
        chantier: app.chantierCourant?.name || '',
        lat: s.lat, lon: s.lon,
        ts: new Date()
      };
      const dataUrl = PKT_PHOTO.captureFromImage(img, stampInfo, 0.85);
      _currentPhotoDataUrl = dataUrl;
      $('preview-img').src = dataUrl;
      $('preview-wrap').style.display = 'block';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(f);
};

window.setPhotoCat = function(c, el) {
  app.photoCat = c;
  document.querySelectorAll('#photo-cats .chip').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
};

window.savePhotoNormal = async function() {
  if (!_currentPhotoDataUrl) { toast('Prenez une photo d\'abord', 'error'); return; }
  const photoId = await PKT_PHOTO.savePhoto(_currentPhotoDataUrl);
  const note = $('photo-note').value.trim() || app.photoCat;
  await createSignalement({ type: 'photo', note, cat: app.photoCat, photo_id: photoId });
  toast('Photo enregistrée au PK ' + PKT_TRACKER.getSnapshot().pk.full, 'success');
  vibrate([140]);
  closePhoto();
};

window.savePhotoAlert = async function() {
  if (!_currentPhotoDataUrl) { toast('Prenez une photo d\'abord', 'error'); return; }
  const photoId = await PKT_PHOTO.savePhoto(_currentPhotoDataUrl);
  const note = $('photo-note').value.trim() || 'ANOMALIE';
  await createSignalement({ type: 'alert', note, cat: app.photoCat, photo_id: photoId });
  toast('⚠ Alerte photo au PK ' + PKT_TRACKER.getSnapshot().pk.full, 'error');
  vibrate([160, 60, 160]);
  closePhoto();
};

// Update photo display when tracker updates while on photo page
PKT_TRACKER.onUpdate(() => {
  if (app.currentPage === 'photo') refreshPhotoDisplay();
  else refreshTrackingUI();
});

// ------ ARCHIVE ------
let _archiveItems = [];
async function renderArchive() {
  const chantiers = await PKT_DB.getAll(PKT_DB.STORES.chantiers);
  const sigs = await PKT_DB.getAll(PKT_DB.STORES.signalements);
  chantiers.sort((a,b) => (b.updated||0) - (a.updated||0));
  _archiveItems = [];
  chantiers.forEach(c => {
    const chSigs = sigs.filter(s => s.chantier_id === c.id);
    _archiveItems.push({ type: 'chantier', data: c, sigs: chSigs });
  });
  const orphans = sigs.filter(s => !s.chantier_id);
  if (orphans.length) {
    _archiveItems.push({ type: 'orphan', sigs: orphans });
  }
  $('archive-count').textContent = chantiers.length + ' chantier' + (chantiers.length>1?'s':'') + ' · ' + sigs.length + ' pt' + (sigs.length>1?'s':'');
  filterArchive('');
}

function filterArchive(query) {
  const el = $('archive-list');
  const q = (query || '').toLowerCase().trim();
  if (!_archiveItems.length) {
    el.innerHTML = '<div class="empty">Aucun chantier. Créez-en un depuis l\'accueil.</div>';
    return;
  }
  const cards = [];
  for (const item of _archiveItems) {
    if (item.type === 'chantier') {
      const c = item.data;
      const sigs = item.sigs;
      const matches = q
        ? (c.name.toLowerCase().includes(q) || sigs.some(s =>
            (s.pk||'').toLowerCase().includes(q) ||
            (s.note||'').toLowerCase().includes(q) ||
            (s.cat||'').toLowerCase().includes(q)))
        : true;
      if (!matches) continue;
      cards.push(`
        <div class="chantier-card" onclick="openChantierDetail('${c.id}')">
          <div class="chantier-dot" style="background:${c.ref_trace ? 'var(--signal-go)' : 'var(--signal-slow)'};"></div>
          <div class="chantier-body">
            <div class="chantier-name">${esc(c.name)}</div>
            <div class="chantier-meta">PK ${(c.pk_start/1000).toFixed(3)}${c.pk_end?' → '+(c.pk_end/1000).toFixed(3):''} · ${sigs.length} pt${sigs.length>1?'s':''} · ${c.ref_trace?'trace OK':'sans trace'}</div>
          </div>
          <div class="chantier-chevron">›</div>
        </div>
      `);
    } else if (item.type === 'orphan') {
      const matchOrphans = q ? item.sigs.filter(s =>
        (s.pk||'').toLowerCase().includes(q) ||
        (s.note||'').toLowerCase().includes(q) ||
        (s.cat||'').toLowerCase().includes(q)
      ) : item.sigs;
      if (matchOrphans.length) {
        cards.push(`
          <div class="chantier-card" onclick="navigate('journal')">
            <div class="chantier-dot" style="background:var(--ink-3);"></div>
            <div class="chantier-body">
              <div class="chantier-name">Hors chantier</div>
              <div class="chantier-meta">${matchOrphans.length} pt${matchOrphans.length>1?'s':''} · marches libres</div>
            </div>
            <div class="chantier-chevron">›</div>
          </div>
        `);
      }
    }
  }
  el.innerHTML = cards.length ? cards.join('') : '<div class="empty">Aucun résultat</div>';
}

window.searchArchive = function(v) { filterArchive(v); };

window.openChantierDetail = async function(id) {
  const c = await PKT_DB.get(PKT_DB.STORES.chantiers, id);
  if (!c) return;
  const sigs = (await PKT_DB.getAll(PKT_DB.STORES.signalements)).filter(s => s.chantier_id === id);
  const hasTrace = c.ref_trace && c.ref_trace.length > 0;
  const html = `
    <div class="sheet-field-group">
      <label class="sheet-label">Détails</label>
      <div style="font-size:14px;color:var(--ink-1);line-height:1.7;">
        <b style="color:var(--ink-0);">${esc(c.name)}</b><br>
        ${c.line ? 'Ligne ' + esc(c.line) + '<br>' : ''}
        PK ${(c.pk_start/1000).toFixed(3)}${c.pk_end?' → '+(c.pk_end/1000).toFixed(3):''}<br>
        ${sigs.length} signalement${sigs.length>1?'s':''}<br>
        ${hasTrace ? 'Tracé de référence : ' + c.ref_trace.length + ' points' : 'Pas encore de tracé de référence'}
      </div>
    </div>`;
  const result = await sheet({
    title: 'Chantier',
    html,
    actions: [
      { label: 'Supprimer', value: 'delete', danger: true },
      { label: 'Reprendre', value: 'open', primary: true }
    ]
  });
  if (result === 'open') {
    app.chantierCourant = c;
    if (hasTrace) {
      await beginSession({
        mode: 'chantier',
        chantierId: c.id,
        refTrace: c.ref_trace,
        pkStart: c.pk_start,
        pkFin: c.pk_end
      });
    } else {
      await beginSession({
        mode: 'cumulatif',
        chantierId: c.id,
        pkStart: c.pk_start,
        pkFin: c.pk_end,
        isReconnaissance: true
      });
    }
  } else if (result === 'delete') {
    const confirm = await sheet({
      title: 'Supprimer ' + c.name + ' ?',
      body: 'Le chantier et ses ' + sigs.length + ' signalement(s) seront effacés définitivement.',
      actions: [
        { label: 'Annuler', value: null },
        { label: 'Supprimer', value: 'yes', danger: true }
      ]
    });
    if (confirm === 'yes') {
      for (const s of sigs) {
        if (s.photo_id) await PKT_DB.del(PKT_DB.STORES.photos, s.photo_id);
        await PKT_DB.del(PKT_DB.STORES.signalements, s.id);
      }
      await PKT_DB.del(PKT_DB.STORES.chantiers, c.id);
      toast('Chantier supprimé', 'success');
      renderArchive();
    }
  }
};

// ------ EXPORT ------
window.exportKMZ = async function() {
  const sigs = await PKT_DB.getAll(PKT_DB.STORES.signalements);
  if (!sigs.length) { toast('Aucune donnée à exporter', 'error'); return; }
  const chId = app.sessionOpts?.chantierId;
  const chantier = chId ? await PKT_DB.get(PKT_DB.STORES.chantiers, chId) : null;
  const targetSigs = chantier ? sigs.filter(s => s.chantier_id === chId) : sigs;
  const trace = PKT_TRACKER.getTrace();
  try {
    toast('Génération du KMZ…', 'info', 5000);
    const blob = await PKT_EXPORT.exportKMZ(chantier, targetSigs, trace);
    const fname = 'rapport_pk_' + new Date().toISOString().slice(0,10) + '.kmz';
    await PKT_EXPORT.downloadBlob(blob, fname);
    toast('KMZ téléchargé', 'success');
  } catch (e) {
    console.error(e);
    toast('Erreur export : ' + e.message, 'error');
  }
};

window.exportShare = async function() {
  const sigs = await PKT_DB.getAll(PKT_DB.STORES.signalements);
  if (!sigs.length) { toast('Aucune donnée à exporter', 'error'); return; }
  const chId = app.sessionOpts?.chantierId;
  const chantier = chId ? await PKT_DB.get(PKT_DB.STORES.chantiers, chId) : null;
  const targetSigs = chantier ? sigs.filter(s => s.chantier_id === chId) : sigs;
  const trace = PKT_TRACKER.getTrace();
  const data = PKT_EXPORT.buildShareJSON(chantier, targetSigs, trace);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const fname = 'partage_pk_' + new Date().toISOString().slice(0,10) + '.pkt';
  await PKT_EXPORT.downloadBlob(blob, fname);
  toast('Fichier de partage créé', 'success');
};

window.exportPDF = async function() {
  const sigs = await PKT_DB.getAll(PKT_DB.STORES.signalements);
  if (!sigs.length) { toast('Aucune donnée à exporter', 'error'); return; }
  const chId = app.sessionOpts?.chantierId;
  const chantier = chId ? await PKT_DB.get(PKT_DB.STORES.chantiers, chId) : null;
  const targetSigs = chantier ? sigs.filter(s => s.chantier_id === chId) : sigs;

  // Demander les infos agent avant génération
  const html = `
    <div class="sheet-field-group">
      <label class="sheet-label">Nom de l'agent</label>
      <input id="pdf-agent-name" class="field" type="text" placeholder="Prénom NOM" />
    </div>
    <div class="sheet-field-group">
      <label class="sheet-label">Fonction / Titre</label>
      <input id="pdf-agent-title" class="field" type="text" placeholder="ex : Responsable Études Travaux" />
    </div>
    <div class="sheet-field-group">
      <label class="sheet-label">Référence rapport (optionnel)</label>
      <input id="pdf-ref" class="field" type="text" placeholder="ex : RT-2026-042" />
    </div>`;

  const result = await sheet({
    title: 'Générer le rapport PDF',
    html,
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Générer', value: 'ok', primary: true }
    ]
  });
  if (result !== 'ok') return;

  const agentName  = $('pdf-agent-name')?.value.trim()  || '—';
  const agentTitle = $('pdf-agent-title')?.value.trim() || '—';
  const rapportRef = $('pdf-ref')?.value.trim()         || ('RT-' + new Date().toISOString().slice(0,10));

  await openPDFPreview(chantier, targetSigs, { agentName, agentTitle, rapportRef });
};

async function openPDFPreview(chantier, sigs, meta) {
  const photos = {};
  for (const s of sigs) {
    if (s.photo_id) photos[s.id] = await PKT_DB.get(PKT_DB.STORES.photos, s.photo_id);
  }
  const htmlContent = buildPDFHtml(chantier, sigs, photos, meta || {});
  const w = window.open('', '_blank');
  if (!w) { toast('Débloquez les popups pour imprimer', 'error'); return; }
  w.document.open();
  w.document.write(htmlContent);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 800);
}

function buildPDFHtml(chantier, sigs, photos, meta) {
  const now        = new Date();
  const dateStr    = now.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const timeStr    = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const alerts     = sigs.filter(s => s.type === 'alert');
  const normaux    = sigs.filter(s => s.type !== 'alert');
  const phs        = sigs.filter(s => s.photo_id);
  const title      = chantier ? chantier.name : 'Rapport de tournée';
  const lineLabel  = chantier?.line ? 'Ligne ' + escPDF(chantier.line) : '';
  const pkStart    = chantier ? (chantier.pk_start/1000).toFixed(3) : '—';
  const pkEnd      = chantier?.pk_end ? (chantier.pk_end/1000).toFixed(3) : null;
  const pkRange    = pkEnd ? `PK ${pkStart} → ${pkEnd}` : `À partir de PK ${pkStart}`;
  const agentName  = escPDF(meta.agentName  || '—');
  const agentTitle = escPDF(meta.agentTitle || '—');
  const rapportRef = escPDF(meta.rapportRef || '—');

  // ---- EN-TÊTE NEUTRE (pas de logo RATP officiel sans accord comm) ----
  const logoRATP = `<div style="display:flex;flex-direction:column;justify-content:center;">
    <div style="font-size:13pt;font-weight:900;color:#D4021D;letter-spacing:0.05em;line-height:1;">INFRASTRUCTURE</div>
    <div style="font-size:13pt;font-weight:900;color:#D4021D;letter-spacing:0.05em;line-height:1;">FERROVIAIRE</div>
    <div style="font-size:8pt;color:#9CA3AF;margin-top:2px;letter-spacing:0.08em;">INSPECTION QUALITÉ VOIE</div>
  </div>`;

  // ---- LOGO PK TRACKER (SVG inline) ----
  const logoPKT = `<svg width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="52" height="52" rx="8" fill="#0A0E1A"/>
    <circle cx="26" cy="20" r="9" stroke="#10D981" stroke-width="2.5" fill="none"/>
    <circle cx="26" cy="20" r="3.5" fill="#10D981"/>
    <rect x="14" y="32" width="4" height="10" rx="1" fill="#1E2A3A"/>
    <rect x="20" y="32" width="4" height="10" rx="1" fill="#1E2A3A"/>
    <rect x="26" y="32" width="4" height="10" rx="1" fill="#1E2A3A"/>
    <rect x="32" y="32" width="4" height="10" rx="1" fill="#1E2A3A"/>
    <line x1="14" y1="32" x2="36" y2="32" stroke="#10D981" stroke-width="1.5"/>
    <line x1="14" y1="42" x2="36" y2="42" stroke="#10D981" stroke-width="1.5"/>
  </svg>`;

  // ---- TABLEAU RÉCAPITULATIF ANOMALIES ----
  const tableauAnomalies = alerts.length > 0 ? `
  <div class="section-block">
    <div class="section-header alert-header">
      <span class="section-icon">⚠</span>
      <span>Récapitulatif des anomalies — ${alerts.length} alerte${alerts.length > 1 ? 's' : ''}</span>
    </div>
    <table class="recap-table">
      <thead>
        <tr>
          <th>N°</th>
          <th>PK</th>
          <th>Heure</th>
          <th>Description</th>
          <th>Photo</th>
          <th>Précision GPS</th>
        </tr>
      </thead>
      <tbody>
        ${alerts.map((s, i) => `
        <tr class="alert-row">
          <td class="mono">A${String(i+1).padStart(2,'0')}</td>
          <td class="mono pk-cell">${escPDF(s.pk)}</td>
          <td class="mono">${escPDF(s.ts_display)}</td>
          <td>${escPDF(s.note || '—')}</td>
          <td class="center">${s.photo_id ? '✓' : '—'}</td>
          <td class="center">${s.acc != null ? '±'+s.acc+' m' : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : `
  <div class="section-block no-alert-box">
    <span class="no-alert-icon">✓</span>
    <span>Aucune anomalie détectée sur ce tronçon</span>
  </div>`;

  // ---- FICHES DÉTAILLÉES ----
  function buildFiche(s, i, prefix) {
    const photo   = photos[s.id];
    const isAlert = s.type === 'alert';
    const typeLabel = isAlert ? 'ALERTE' : s.photo_id ? 'PHOTO' : 'OBSERVATION';
    const typeClass = isAlert ? 'type-alert' : s.photo_id ? 'type-photo' : 'type-normal';
    return `
    <div class="fiche ${isAlert ? 'fiche-alert' : ''}">
      <div class="fiche-header">
        <div class="fiche-num">${prefix}${String(i+1).padStart(2,'0')}</div>
        <div class="fiche-pk-block">
          <div class="fiche-pk">PK ${escPDF(s.pk)}</div>
          <div class="fiche-date">${escPDF(s.date_display)} · ${escPDF(s.ts_display)}${s.cat ? ' · ' + escPDF(s.cat) : ''}</div>
        </div>
        <div class="fiche-type ${typeClass}">${typeLabel}</div>
      </div>

      ${s.note ? `<div class="fiche-note">${escPDF(s.note)}</div>` : ''}

      <div class="fiche-body">
        ${photo ? `<div class="fiche-photo-wrap"><img src="${photo}" class="fiche-photo" alt="Photo PK ${escPDF(s.pk)}" /></div>` : ''}
        <table class="fiche-table">
          <tr><td>Point kilométrique</td><td class="mono">${escPDF(s.pk)}</td></tr>
          <tr><td>Date / Heure</td><td class="mono">${escPDF(s.date_display)} — ${escPDF(s.ts_display)}</td></tr>
          ${s.lat ? `<tr><td>Coordonnées GPS</td><td class="mono">${s.lat.toFixed(6)}°N  ${s.lon.toFixed(6)}°E</td></tr>` : ''}
          <tr><td>Précision GPS</td><td class="mono">${s.acc != null ? '±'+s.acc+' m' : '—'}</td></tr>
          ${s.cap != null ? `<tr><td>Cap / Orientation</td><td class="mono">${s.cap}°</td></tr>` : ''}
          ${s.cat ? `<tr><td>Catégorie</td><td>${escPDF(s.cat)}</td></tr>` : ''}
          <tr><td>Statut</td><td><span class="statut-badge">${escPDF(s.statut || 'ouvert')}</span></td></tr>
          <tr><td>Empreinte SHA-256</td><td class="mono hash">${escPDF(s.hash || '—')}</td></tr>
        </table>
      </div>
    </div>`;
  }

  const fichesAlertes  = alerts.map((s, i) => buildFiche(s, i, 'A')).join('');
  const fichesNormaux  = normaux.map((s, i) => buildFiche(s, i, 'P')).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>${escPDF(title)} — Rapport PK Tracker</title>
<style>
  @page { size: A4; margin: 15mm 14mm 18mm 14mm; }
  @page :first { margin-top: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 10pt;
    color: #1a1f2e;
    line-height: 1.5;
    background: white;
  }

  .mono { font-family: "Courier New", Courier, monospace; font-size: 9pt; }
  .center { text-align: center; }

  /* ======= PAGE DE GARDE ======= */
  .cover-page {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    page-break-after: always;
    padding: 12mm 14mm;
  }

  .cover-logos {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 8mm;
    border-bottom: 3px solid #D4021D;
    margin-bottom: 12mm;
  }

  .cover-logos-left { display: flex; align-items: center; gap: 12px; }
  .cover-logo-label {
    font-size: 11pt;
    font-weight: 700;
    color: #1a1f2e;
    line-height: 1.2;
  }
  .cover-logo-sub { font-size: 8pt; color: #7C8599; font-weight: 400; }

  .cover-ref {
    font-size: 8pt;
    color: #7C8599;
    font-family: "Courier New", monospace;
    text-align: right;
  }

  .cover-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 10mm 0;
  }

  .cover-type {
    font-size: 9pt;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: #D4021D;
    margin-bottom: 6mm;
  }

  .cover-title {
    font-size: 26pt;
    font-weight: 700;
    color: #0A0E1A;
    line-height: 1.15;
    letter-spacing: -0.03em;
    margin-bottom: 4mm;
  }

  .cover-subtitle {
    font-size: 12pt;
    color: #4A5268;
    margin-bottom: 10mm;
  }

  .cover-meta-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4mm 8mm;
    background: #F8F9FB;
    border: 1px solid #E5E8EE;
    border-radius: 6px;
    padding: 6mm 8mm;
    margin-bottom: 8mm;
  }

  .cover-meta-item { display: flex; flex-direction: column; gap: 1mm; }
  .cover-meta-label {
    font-size: 7.5pt;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #9CA3AF;
  }
  .cover-meta-value { font-size: 10pt; color: #1a1f2e; font-weight: 500; }

  /* KPIs */
  .cover-kpis {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4mm;
    margin-bottom: 8mm;
  }
  .kpi-card {
    border: 1px solid #E5E8EE;
    border-radius: 6px;
    padding: 5mm 5mm 4mm;
    text-align: center;
  }
  .kpi-card.kpi-alert { border-color: #F5A524; background: #FFFBF2; }
  .kpi-num {
    font-size: 22pt;
    font-weight: 700;
    color: #0A0E1A;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .kpi-card.kpi-alert .kpi-num { color: #B36F00; }
  .kpi-lbl { font-size: 7.5pt; color: #9CA3AF; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 1.5mm; }

  /* SECTION SIGNATURE */
  .cover-signature {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6mm;
    border-top: 1px solid #E5E8EE;
    padding-top: 6mm;
    margin-top: auto;
  }
  .sig-block { }
  .sig-label { font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #9CA3AF; margin-bottom: 2mm; }
  .sig-name { font-size: 11pt; font-weight: 600; color: #1a1f2e; }
  .sig-title { font-size: 9pt; color: #4A5268; margin-bottom: 4mm; }
  .sig-line { border-bottom: 1px solid #1a1f2e; height: 8mm; margin-bottom: 1mm; }
  .sig-line-label { font-size: 7.5pt; color: #9CA3AF; }

  /* ======= CORPS DU RAPPORT ======= */
  .report-body { padding: 6mm 0; }

  .section-block {
    margin-bottom: 8mm;
    page-break-inside: avoid;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 9pt;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #4A5268;
    padding: 3mm 4mm;
    background: #F8F9FB;
    border-left: 3px solid #CBD5E1;
    margin-bottom: 3mm;
  }
  .section-header.alert-header { border-left-color: #F5A524; color: #92400E; background: #FFFBF2; }
  .section-icon { font-size: 11pt; }

  /* Tableau récap */
  .recap-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 9pt;
  }
  .recap-table th {
    background: #F1F5F9;
    padding: 2.5mm 3mm;
    text-align: left;
    font-size: 7.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #64748B;
    border-bottom: 1px solid #E2E8F0;
  }
  .recap-table td {
    padding: 2.5mm 3mm;
    border-bottom: 1px solid #F1F5F9;
    vertical-align: middle;
  }
  .alert-row { background: #FFFBF2; }
  .alert-row:hover { background: #FEF3C7; }
  .pk-cell { font-weight: 600; color: #D4021D; }

  .no-alert-box {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4mm 6mm;
    background: #F0FDF4;
    border: 1px solid #86EFAC;
    border-radius: 6px;
    color: #166534;
    font-weight: 500;
  }
  .no-alert-icon { font-size: 14pt; color: #16A34A; }

  /* Fiches */
  .fiche {
    border: 1px solid #E2E8F0;
    border-radius: 8px;
    margin-bottom: 6mm;
    overflow: hidden;
    page-break-inside: avoid;
  }
  .fiche-alert { border-color: #FCA5A5; }

  .fiche-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 3.5mm 5mm;
    background: #F8FAFC;
    border-bottom: 1px solid #E2E8F0;
  }
  .fiche-alert .fiche-header { background: #FFF7F7; border-bottom-color: #FCA5A5; }

  .fiche-num {
    font-family: "Courier New", monospace;
    font-size: 9pt;
    color: #94A3B8;
    min-width: 28px;
    font-weight: 700;
  }

  .fiche-pk-block { flex: 1; }
  .fiche-pk { font-family: "Courier New", monospace; font-size: 13pt; font-weight: 700; color: #0A0E1A; line-height: 1.1; }
  .fiche-alert .fiche-pk { color: #DC2626; }
  .fiche-date { font-size: 8pt; color: #94A3B8; margin-top: 0.5mm; }

  .fiche-type {
    font-size: 7.5pt;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 2px 7px;
    border-radius: 4px;
    text-transform: uppercase;
  }
  .type-alert  { background: #FEF2F2; color: #DC2626; border: 1px solid #FECACA; }
  .type-photo  { background: #EFF6FF; color: #1D4ED8; border: 1px solid #BFDBFE; }
  .type-normal { background: #F0FDF4; color: #166534; border: 1px solid #BBF7D0; }

  .fiche-note {
    padding: 3mm 5mm;
    font-size: 10pt;
    font-weight: 600;
    color: #1a1f2e;
    border-bottom: 1px solid #F1F5F9;
    background: white;
  }

  .fiche-body {
    display: flex;
    gap: 0;
  }

  .fiche-photo-wrap {
    flex: 0 0 55%;
    max-width: 55%;
    background: #F8FAFC;
    border-right: 1px solid #E2E8F0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 3mm;
  }
  .fiche-photo {
    max-width: 100%;
    max-height: 75mm;
    object-fit: contain;
    border-radius: 4px;
  }

  .fiche-table {
    flex: 1;
    border-collapse: collapse;
    font-size: 8.5pt;
    padding: 3mm;
    width: 100%;
    align-self: flex-start;
  }
  .fiche-body:not(:has(.fiche-photo-wrap)) .fiche-table {
    padding: 3mm 5mm;
  }
  .fiche-table td {
    padding: 2mm 3mm;
    vertical-align: top;
    border-bottom: 1px solid #F8FAFC;
  }
  .fiche-table tr:last-child td { border-bottom: none; }
  .fiche-table td:first-child { color: #94A3B8; font-size: 8pt; width: 42%; white-space: nowrap; }
  .fiche-table td:last-child { color: #1a1f2e; }

  .statut-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 7.5pt;
    font-weight: 700;
    text-transform: uppercase;
    background: #FEF2F2;
    color: #DC2626;
    border: 1px solid #FECACA;
  }

  .hash { font-size: 7pt; color: #94A3B8; letter-spacing: 0.03em; }

  /* Footer */
  .report-footer {
    position: fixed;
    bottom: 0;
    left: 14mm;
    right: 14mm;
    border-top: 1px solid #E2E8F0;
    padding-top: 2.5mm;
    padding-bottom: 3mm;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: white;
    font-size: 7.5pt;
    color: #94A3B8;
  }
  .footer-left { font-family: "Courier New", monospace; }
  .footer-center { color: #D4021D; font-weight: 600; }
  .footer-right { font-family: "Courier New", monospace; }

  /* Titres de section dans le corps */
  .body-section-title {
    font-size: 9pt;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #4A5268;
    margin: 8mm 0 4mm;
    padding-bottom: 2mm;
    border-bottom: 1.5px solid #E2E8F0;
    display: flex;
    align-items: center;
    gap: 6px;
    page-break-after: avoid;
  }
  .body-section-title.alert-title { color: #DC2626; border-bottom-color: #FCA5A5; }
  .body-section-count {
    background: #F1F5F9;
    color: #64748B;
    padding: 1px 6px;
    border-radius: 10px;
    font-size: 8pt;
  }
  .alert-title .body-section-count { background: #FEF2F2; color: #DC2626; }

  @media print {
    .cover-page { min-height: 100vh; }
  }
</style>
</head>
<body>

<!-- ========== PAGE DE GARDE ========== -->
<div class="cover-page">

  <div class="cover-logos">
    <div class="cover-logos-left">
      ${logoRATP}
      <div>
        <div class="cover-logo-label">RATP Group</div>
        <div class="cover-logo-sub">Infrastructure ferroviaire</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;">
      ${logoPKT}
      <div style="text-align:right;">
        <div class="cover-logo-label">PK Tracker Pro</div>
        <div class="cover-logo-sub">Rapport de tournée</div>
      </div>
    </div>
  </div>

  <div class="cover-main">
    <div class="cover-type">Rapport d'inspection · Voie ferrée</div>
    <div class="cover-title">${escPDF(title)}</div>
    <div class="cover-subtitle">${lineLabel ? lineLabel + ' · ' : ''}${pkRange}</div>

    <div class="cover-meta-grid">
      <div class="cover-meta-item">
        <div class="cover-meta-label">Date d'inspection</div>
        <div class="cover-meta-value">${dateStr}</div>
      </div>
      <div class="cover-meta-item">
        <div class="cover-meta-label">Heure de génération</div>
        <div class="cover-meta-value">${timeStr}</div>
      </div>
      <div class="cover-meta-item">
        <div class="cover-meta-label">Référence rapport</div>
        <div class="cover-meta-value mono">${rapportRef}</div>
      </div>
      <div class="cover-meta-item">
        <div class="cover-meta-label">Tronçon inspecté</div>
        <div class="cover-meta-value">${pkRange}</div>
      </div>
    </div>

    <div class="cover-kpis">
      <div class="kpi-card">
        <div class="kpi-num">${sigs.length}</div>
        <div class="kpi-lbl">Points relevés</div>
      </div>
      <div class="kpi-card ${alerts.length > 0 ? 'kpi-alert' : ''}">
        <div class="kpi-num">${alerts.length}</div>
        <div class="kpi-lbl">Anomalies</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-num">${phs.length}</div>
        <div class="kpi-lbl">Photos</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-num">${normaux.length}</div>
        <div class="kpi-lbl">Observations</div>
      </div>
    </div>

    <div class="cover-signature">
      <div class="sig-block">
        <div class="sig-label">Rédigé par</div>
        <div class="sig-name">${agentName}</div>
        <div class="sig-title">${agentTitle}</div>
        <div class="sig-line"></div>
        <div class="sig-line-label">Signature</div>
      </div>
      <div class="sig-block">
        <div class="sig-label">Validé par</div>
        <div class="sig-name">&nbsp;</div>
        <div class="sig-title">&nbsp;</div>
        <div class="sig-line"></div>
        <div class="sig-line-label">Signature</div>
      </div>
    </div>
  </div>

</div>

<!-- ========== CORPS DU RAPPORT ========== -->
<div class="report-body">

  <!-- Récapitulatif anomalies -->
  ${tableauAnomalies}

  <!-- Fiches anomalies -->
  ${alerts.length > 0 ? `
  <div class="body-section-title alert-title">
    ⚠ Fiches anomalies
    <span class="body-section-count">${alerts.length}</span>
  </div>
  ${fichesAlertes}` : ''}

  <!-- Fiches observations -->
  ${normaux.length > 0 ? `
  <div class="body-section-title">
    Observations
    <span class="body-section-count">${normaux.length}</span>
  </div>
  ${fichesNormaux}` : ''}

</div>

<!-- Footer fixe sur chaque page -->
<div class="report-footer">
  <div class="footer-left">${rapportRef} · ${escPDF(title)}</div>
  <div class="footer-center">RATP Group · PK Tracker Pro v7</div>
  <div class="footer-right">${dateStr} · ${timeStr}</div>
</div>

</body>
</html>`;
}

function escPDF(s) {
  if (s == null) return '';
  return String(s).replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' })[c]);
}

// ------ STRIDE CALIBRATION ------
window.openStrideCalib = async function() {
  const currentStride = PKT_TRACKER.getState().stride;
  const html = `
    <div class="sheet-field-group">
      <label class="sheet-label">Foulée actuelle</label>
      <div style="font-family:var(--ff-m);font-size:18px;color:var(--ink-0);">${currentStride.toFixed(2)} m</div>
    </div>
    <div style="font-size:13px;color:var(--ink-1);line-height:1.55;margin-bottom:14px;">
      Marchez une distance connue (idéalement 50 m mesurés au décamètre).<br>
      Saisissez ensuite la distance parcourue pour calibrer votre foulée.
    </div>
    <div class="sheet-field-group">
      <label class="sheet-label">Régler manuellement</label>
      <input id="stride-manual" class="field" type="number" step="0.01" min="0.3" max="1.5" placeholder="0.72" inputmode="decimal" value="${currentStride.toFixed(2)}" />
    </div>`;
  const result = await sheet({
    title: 'Calibration foulée',
    html,
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Enregistrer', value: 'save', primary: true }
    ]
  });
  if (result === 'save') {
    const v = parseFloat($('stride-manual').value);
    if (isNaN(v) || v < 0.3 || v > 1.5) { toast('Valeur invalide (0.3–1.5 m)', 'error'); return; }
    PKT_TRACKER.setStride(v);
    await PKT_DB.put(PKT_DB.STORES.meta, v, 'stride');
    $('stride-current').textContent = 'Actuelle : ' + v.toFixed(2) + ' m';
    toast('Foulée calibrée : ' + v.toFixed(2) + ' m', 'success');
  }
};

// ------ CLEAR EVERYTHING ------
window.clearEverything = async function() {
  const ok = await sheet({
    title: 'Tout effacer ?',
    body: 'Cette action supprime définitivement tous les chantiers, signalements et photos. Cette action ne peut pas être annulée.',
    actions: [
      { label: 'Annuler', value: null },
      { label: 'Tout effacer', value: 'yes', danger: true }
    ]
  });
  if (ok !== 'yes') return;
  await PKT_DB.clear(PKT_DB.STORES.chantiers);
  await PKT_DB.clear(PKT_DB.STORES.signalements);
  await PKT_DB.clear(PKT_DB.STORES.photos);
  await PKT_DB.clear(PKT_DB.STORES.traces);
  toast('Données effacées', 'success');
  navigate('hub');
};

// ------ QUOTA DISPLAY ------
async function updateQuotaDisplay() {
  const q = await PKT_DB.getQuota();
  const el = $('quota-info');
  if (el && q.total) {
    const usedMb = (q.used / 1024 / 1024).toFixed(1);
    const totalMb = (q.total / 1024 / 1024).toFixed(0);
    el.textContent = 'Stockage : ' + usedMb + ' / ' + totalMb + ' Mo';
  }
}

// ------ SESSION INFO IN MENU ------
async function updateMenuSessionInfo() {
  const s = PKT_TRACKER.getSnapshot();
  const el = $('menu-session-info');
  if (!el) return;
  if (!s.active) {
    el.innerHTML = '<div style="font-size:13px;color:var(--ink-2);">Aucune session active</div>';
  } else {
    const chantier = app.chantierCourant?.name || 'Marche libre';
    el.innerHTML = `
      <div style="font-size:14px;font-weight:500;margin-bottom:3px;">${esc(chantier)}</div>
      <div style="font-family:var(--ff-m);font-size:12px;color:var(--ink-2);">PK ${s.pk.full} · ${s.dist<1000 ? Math.round(s.dist)+' m' : (s.dist/1000).toFixed(2)+' km'} · ${s.steps||0} pas</div>`;
  }
}

// ------ ICONS ------
function iconPlay() {
  return '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/><circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/></svg>';
}
function iconStop() {
  return '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="2"/></svg>';
}

// ------ INIT ------
async function init() {
  await PKT_DB.requestPersistence();
  // Load saved stride
  try {
    const stride = await PKT_DB.get(PKT_DB.STORES.meta, 'stride');
    if (stride) PKT_TRACKER.setStride(stride);
  } catch {}
  // Register service worker
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch {}
  }
  // Step count updates
  PKT_MOTION.onStep(() => {
    if (app.currentPage === 'track') refreshTrackingUI();
  });
  PKT_MOTION.onHeading((h) => {
    const s = PKT_TRACKER.getState();
    if (s.lastPos) {
      s.lastHeading = PKT_GEO.magneticToTrueBearing(h, s.lastPos.lat, s.lastPos.lon);
    }
  });
  navigate('hub');
}

document.addEventListener('DOMContentLoaded', init);

})();
