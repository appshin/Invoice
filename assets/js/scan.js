/* =========================================================================
 * KOWOO 중복 스캔 검사 (scan.js)
 *  - 카메라(jsQR) + 현장 스캐너/붙여넣기 입력
 *  - 이미 스캔한 QR을 다시 읽으면 중복 알람 (색 + 글자 + 소리 + 진동)
 * ========================================================================= */
(function () {
  'use strict';

  var KEY = 'kw_scan_v1';
  var $ = function (s) { return document.querySelector(s); };

  var state = { invoice: '', total: 0, records: [] };   // records: {no, seq, desc, qty, t, dup}
  var stream = null, raf = null, lastText = '', lastAt = 0;

  /* ---- 저장 ---- */
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) { var p = JSON.parse(raw); if (p && Array.isArray(p.records)) state = p; }
    } catch (e) {}
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function toast(m) {
    var t = $('#toast'); t.textContent = m; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }
  function nowHM() {
    var d = new Date();
    return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)+':'+('0'+d.getSeconds()).slice(-2);
  }

  /* ---- 소리 (중복은 길고 거친 경고음) ---- */
  var actx = null;
  function beep(kind) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      var seq = kind === 'dup' ? [[220,.16],[0,.05],[220,.16],[0,.05],[220,.26]]
              : kind === 'bad' ? [[440,.18]]
              : [[880,.09],[1320,.11]];
      var t = actx.currentTime;
      seq.forEach(function (s) {
        if (s[0] > 0) {
          var o = actx.createOscillator(), g = actx.createGain();
          o.type = kind === 'dup' ? 'square' : 'sine';
          o.frequency.value = s[0];
          g.gain.setValueAtTime(kind === 'dup' ? .28 : .16, t);
          g.gain.exponentialRampToValueAtTime(.001, t + s[1]);
          o.connect(g); g.connect(actx.destination);
          o.start(t); o.stop(t + s[1]);
        }
        t += s[1];
      });
    } catch (e) {}
  }
  function buzz(kind) {
    try {
      if (navigator.vibrate) navigator.vibrate(kind === 'dup' ? [120,60,120,60,200] : 40);
    } catch (e) {}
  }

  /* ---- QR 내용 파싱 ----
   * INVOICE: KW260716-RM / DATE: ... / ITEM: ... / QTY: ... / NO: 03/20
   * 형식이 아니면 원문 자체를 키로 사용 (그래도 중복은 잡힘)
   */
  function parsePayload(text) {
    var o = { raw: text, invoice: '', date: '', item: '', qty: '', no: '', seq: 0, total: 0, known: false };
    String(text).split(/\r?\n/).forEach(function (line) {
      var m = /^\s*([A-Za-z ]+)\s*:\s*(.*)$/.exec(line);
      if (!m) return;
      var k = m[1].trim().toUpperCase(), v = m[2].trim();
      if (k === 'INVOICE') o.invoice = v;
      else if (k === 'DATE') o.date = v;
      else if (k === 'ITEM') o.item = v;
      else if (k === 'QTY') o.qty = v;
      else if (k === 'NO') o.no = v;
    });
    if (o.invoice && o.no) {
      o.known = true;
      var mm = /^(\d+)\s*\/\s*(\d+)$/.exec(o.no);
      if (mm) { o.seq = parseInt(mm[1], 10); o.total = parseInt(mm[2], 10); }
    }
    return o;
  }
  function keyOf(p) { return p.known ? (p.invoice + '|' + p.no) : ('RAW|' + p.raw); }

  /* ---- 상태 배너 ---- */
  function setStatus(stt, title, sub, no) {
    var el = $('#status');
    el.dataset.state = stt;
    $('#stIc').textContent = stt === 'ok' ? '✓' : stt === 'dup' ? '!' : stt === 'bad' ? '?' : '▦';
    $('#stT').textContent = title;
    $('#stS').textContent = sub || '';
    $('#stNo').textContent = no || '';
  }

  /* ---- 스캔 처리 (핵심) ----
   * source 'cam'  : 카메라는 같은 코드를 초당 수십 번 읽는다.
   *                 화면에 계속 보이는 동안은 한 번만 처리하고,
   *                 코드가 화면에서 사라졌다가 다시 오면 새 스캔으로 본다.
   * source 'manual': 스캐너 트리거/확인 버튼은 매번 사용자의 명시적 동작이므로 그대로 처리.
   */
  var CAM_COOLDOWN = 1200;

  function handle(text, source) {
    if (!text) return;
    if (source === 'cam') {
      var t = Date.now();
      if (text === lastText && t - lastAt < CAM_COOLDOWN) {
        lastAt = t;              // 계속 보이는 중 → 타이머만 갱신
        return;
      }
      lastText = text; lastAt = t;
    }
    process(text);
  }

  function process(text) {
    var p = parsePayload(text);

    if (!p.known) {
      setStatus('bad', '알 수 없는 코드', text.slice(0, 60), '');
      beep('bad'); buzz('bad');
      state.records.unshift({ no: '-', seq: 0, desc: text.slice(0, 40), qty: '', t: nowHM(), dup: false, bad: true });
      save(); renderLog(); return;
    }

    // 인보이스가 바뀌면 새 작업으로 전환
    if (state.invoice && state.invoice !== p.invoice) {
      if (!confirm('다른 인보이스 라벨입니다.\n\n현재: ' + state.invoice + '\n스캔: ' + p.invoice +
                   '\n\n새 인보이스로 기록을 초기화할까요?')) { return; }
      state = { invoice: p.invoice, total: p.total, records: [] };
    }
    if (!state.invoice) { state.invoice = p.invoice; state.total = p.total || 0; }
    if (p.total) state.total = p.total;

    // ★ 중복 판정
    var key = keyOf(p);
    var already = state.records.filter(function (r) { return !r.dup && !r.bad && r.key === key; })[0];

    if (already) {
      setStatus('dup', '중복 스캔!', p.item + ' · ' + p.qty + ' · 처음 스캔 ' + already.t, p.no);
      beep('dup'); buzz('dup');
      state.records.unshift({ key: key, no: p.no, seq: p.seq, desc: p.item, qty: p.qty,
                              t: nowHM(), dup: true });
      toast('이미 스캔한 라벨입니다 · ' + p.no);
    } else {
      setStatus('ok', '정상', p.item + ' · ' + p.qty, p.no);
      beep('ok'); buzz('ok');
      state.records.unshift({ key: key, no: p.no, seq: p.seq, desc: p.item, qty: p.qty,
                              t: nowHM(), dup: false });
    }
    save(); renderAll();
  }

  /* ---- 렌더 ---- */
  function uniqueDone() {
    return state.records.filter(function (r) { return !r.dup && !r.bad; });
  }
  function renderAll() { renderProgress(); renderLog(); }

  function renderProgress() {
    var done = uniqueDone();
    var total = state.total || 0;
    $('#invName').textContent = state.invoice || '—';
    $('#pDone').textContent = done.length;
    $('#pTotal').textContent = '/ ' + total;
    $('#pBar').style.width = total ? Math.min(100, done.length / total * 100) + '%' : '0%';

    var dups = state.records.filter(function (r) { return r.dup; }).length;
    var missing = [];
    if (total) {
      var got = {};
      done.forEach(function (r) { if (r.seq) got[r.seq] = 1; });
      for (var i = 1; i <= total; i++) if (!got[i]) missing.push(i);
    }
    var sub = [];
    if (total) sub.push(missing.length ? '남은 라벨 ' + missing.length + '개' : '전부 스캔 완료');
    if (dups) sub.push('중복 ' + dups + '회');
    $('#pSub').textContent = sub.length ? sub.join(' · ') : '아직 스캔한 라벨이 없습니다';

    // 번호 칩
    var chips = $('#chips'); chips.innerHTML = '';
    if (total) {
      var dupSeq = {};
      state.records.forEach(function (r) { if (r.dup && r.seq) dupSeq[r.seq] = 1; });
      var gotSeq = {};
      done.forEach(function (r) { if (r.seq) gotSeq[r.seq] = 1; });
      for (var n = 1; n <= total; n++) {
        var cls = dupSeq[n] ? 'chip dup' : (gotSeq[n] ? 'chip done' : 'chip');
        var c = document.createElement('span');
        c.className = cls; c.textContent = ('0' + n).slice(-2);
        chips.appendChild(c);
      }
    }
  }

  function renderLog() {
    var box = $('#log');
    if (!state.records.length) { box.innerHTML = '<div class="log-empty">기록이 없습니다</div>'; return; }
    box.innerHTML = '';
    state.records.slice(0, 100).forEach(function (r) {
      var cls = r.bad ? 'bad' : (r.dup ? 'dup' : 'ok');
      var tag = r.bad ? '알수없음' : (r.dup ? '중복' : '정상');
      var d = document.createElement('div');
      d.className = 'log-item ' + cls;
      d.innerHTML = '<span class="lno">' + esc(r.no) + '</span>' +
        '<span class="tag">' + tag + '</span>' +
        '<span class="ldesc">' + esc(r.desc || '') + (r.qty ? ' · ' + esc(r.qty) : '') + '</span>' +
        '<span class="ltime">' + esc(r.t) + '</span>';
      box.appendChild(d);
    });
  }

  /* ---- 카메라 ---- */
  var canvas = document.createElement('canvas'), cctx = canvas.getContext('2d', { willReadFrequently: true });

  function tick() {
    var v = $('#video');
    if (v.readyState === v.HAVE_ENOUGH_DATA) {
      var w = v.videoWidth, h = v.videoHeight;
      if (w && h) {
        var s = Math.min(w, h);                        // 중앙 정사각 영역만 검사 → 빠르고 정확
        canvas.width = canvas.height = Math.min(s, 640);
        cctx.drawImage(v, (w - s) / 2, (h - s) / 2, s, s, 0, 0, canvas.width, canvas.height);
        var img = cctx.getImageData(0, 0, canvas.width, canvas.height);
        var res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (res && res.data) handle(res.data, 'cam');
      }
    }
    raf = requestAnimationFrame(tick);
  }

  function startCam(deviceId) {
    var c = { video: deviceId ? { deviceId: { exact: deviceId } }
                              : { facingMode: { ideal: 'environment' } }, audio: false };
    navigator.mediaDevices.getUserMedia(c).then(function (s) {
      stream = s;
      var v = $('#video'); v.srcObject = s; v.play();
      $('#camOff').hidden = true; $('#reticle').hidden = false;
      $('#camBar').hidden = false;
      listCams();
      cancelAnimationFrame(raf); tick();
    }).catch(function (e) {
      var msg = e && e.name === 'NotAllowedError'
        ? '카메라 사용이 거부되었습니다. 브라우저 주소창의 카메라 아이콘에서 허용해 주세요.'
        : (location.protocol !== 'https:' && location.hostname !== 'localhost')
          ? '카메라는 https 주소에서만 됩니다. GitHub Pages 주소로 접속해 주세요.'
          : '카메라를 열 수 없습니다. 아래 스캐너/직접 입력을 사용해 주세요.';
      $('#camHint').textContent = msg;
      toast('카메라를 열 수 없습니다');
    });
  }
  function stopCam() {
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    $('#camOff').hidden = false; $('#reticle').hidden = true; $('#camBar').hidden = true;
  }
  function listCams() {
    if (!navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (ds) {
      var cams = ds.filter(function (d) { return d.kind === 'videoinput'; });
      var sel = $('#camSel'); sel.innerHTML = '';
      cams.forEach(function (c, i) {
        var o = document.createElement('option');
        o.value = c.deviceId; o.textContent = c.label || ('카메라 ' + (i + 1));
        sel.appendChild(o);
      });
      var cur = stream && stream.getVideoTracks()[0];
      if (cur && cur.getSettings && cur.getSettings().deviceId) sel.value = cur.getSettings().deviceId;
    });
  }

  /* ---- 현장 스캐너(키보드 입력) / 붙여넣기 ---- */
  function bindWedge() {
    var ta = $('#wedge'), timer = null;
    // 스캐너는 여러 줄을 순식간에 입력 → 잠시 멈추면 한 건으로 처리
    ta.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var v = ta.value.trim();
        if (v.length > 8) { handle(v, 'manual'); ta.value = ''; }
      }, 350);
    });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault(); clearTimeout(timer);
        var v = ta.value.trim(); if (v) { handle(v, 'manual'); ta.value = ''; }
      }
    });
    $('#btnWedge').onclick = function () {
      clearTimeout(timer);
      var v = ta.value.trim(); if (v) { handle(v, 'manual'); ta.value = ''; }
      else toast('내용을 붙여넣어 주세요');
    };
  }

  /* ---- CSV ---- */
  function exportCsv() {
    if (!state.records.length) { toast('기록이 없습니다'); return; }
    var rows = [['인보이스','번호','상태','품목','수량','시각']];
    state.records.slice().reverse().forEach(function (r) {
      rows.push([state.invoice, r.no, r.bad ? '알수없음' : (r.dup ? '중복' : '정상'),
                 r.desc || '', r.qty || '', r.t]);
    });
    var csv = '\ufeff' + rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'scan-' + (state.invoice || 'log') + '.csv';
    a.click(); URL.revokeObjectURL(a.href);
  }

  /* ---- 초기화 ---- */
  function bind() {
    $('#btnCam').onclick = function () { startCam(); };
    $('#btnCamStop').onclick = stopCam;
    $('#camSel').onchange = function (e) { stopCam(); startCam(e.target.value); };
    $('#btnExport').onclick = exportCsv;
    $('#btnReset').onclick = function () {
      if (!state.records.length) { toast('기록이 없습니다'); return; }
      if (!confirm('스캔 기록을 모두 지울까요?\n(' + state.invoice + ' · ' +
                   uniqueDone().length + '장 스캔됨)')) return;
      state = { invoice: '', total: 0, records: [] };
      save(); renderAll(); setStatus('idle', '스캔 대기 중', 'QR 코드를 스캔하세요', '');
      toast('기록을 지웠습니다');
    };
    bindWedge();
    window.addEventListener('beforeunload', function () { if (stream) stopCam(); });
  }

  function init() {
    load(); bind(); renderAll();
    setStatus('idle', '스캔 대기 중', 'QR 코드를 스캔하세요', '');
    if (state.invoice) toast(state.invoice + ' · ' + uniqueDone().length + '장 스캔 기록을 불러왔습니다');
  }
  document.addEventListener('DOMContentLoaded', init);
})();
