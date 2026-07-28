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
  function buildCsv() {
    var rows = [['인보이스','번호','상태','품목','수량','시각']];
    state.records.slice().reverse().forEach(function (r) {
      rows.push([state.invoice, r.no, r.bad ? '알수없음' : (r.dup ? '중복' : '정상'),
                 r.desc || '', r.qty || '', r.t]);
    });
    return '\ufeff' + rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
  }

  function deviceInfo() {
    var ua = navigator.userAgent || '';
    var isAndroid = /Android/i.test(ua);
    var isIOS = /iPhone|iPad|iPod/i.test(ua) ||
                (/Macintosh/.test(ua) && 'ontouchend' in document);   // iPadOS
    var isSamsung = /SamsungBrowser/i.test(ua);
    var isChrome = /Chrome/i.test(ua) && !/Edg|SamsungBrowser/i.test(ua);
    return { isAndroid: isAndroid, isIOS: isIOS, isSamsung: isSamsung,
             isChrome: isChrome, isMobile: isAndroid || isIOS };
  }

  function exportCsv() {
    if (!state.records.length) { toast('기록이 없습니다'); return; }
    var csv = buildCsv();
    var fname = 'scan-' + (state.invoice || 'log') + '.csv';
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });

    // 파일 저장 (다운로드)
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);

    showDownloadInfo(fname, blob);
  }

  /* ---- 저장 위치 안내 모달 ---- */
  function showDownloadInfo(fname, blob) {
    var dev = deviceInfo();
    $('#dlFname').textContent = fname;

    // 기기별 저장 경로 안내
    var pathHtml = '';
    if (dev.isAndroid) {
      pathHtml = '<span class="os">안드로이드</span>' +
        '<b>내장메모리 › Download</b> 폴더<br>' +
        '(내 파일 · 파일 관리자 앱에서 <b>다운로드</b> 폴더)';
    } else if (dev.isIOS) {
      pathHtml = '<span class="os">아이폰 · 아이패드</span>' +
        '<b>파일 앱 › 다운로드</b><br>' +
        '(Safari는 화면 위쪽 <b>↓ 다운로드 아이콘</b>을 눌러도 열립니다)';
    } else {
      pathHtml = '<span class="os">PC</span>' +
        '보통 <b>다운로드(Downloads)</b> 폴더에 저장됩니다.<br>' +
        '브라우저 다운로드 목록(Ctrl+J)에서 바로 열 수 있습니다.';
    }
    $('#dlPath').innerHTML = pathHtml;

    // 액션 버튼 구성
    var actions = $('#dlActions');
    actions.innerHTML = '';
    var extra = $('#dlExtra'); extra.innerHTML = '';
    var hint = $('#dlHint'); hint.textContent = '';

    // ① 공유 (폰에서 가장 편함: 카톡·메일·드라이브로 바로 전송/저장)
    var canShareFile = false;
    try {
      var testFile = new File([blob], fname, { type: 'text/csv' });
      canShareFile = !!(navigator.canShare && navigator.canShare({ files: [testFile] }));
    } catch (e) { canShareFile = false; }

    if (dev.isMobile && navigator.share) {
      var bShare = document.createElement('button');
      bShare.className = 'btn primary';
      bShare.innerHTML = '📤 공유 / 다른 앱으로 보내기';
      bShare.onclick = function () { shareCsv(fname); };
      actions.appendChild(bShare);
      extra.innerHTML = '<div style="font-size:12px;color:var(--muted);margin-top:2px">' +
        '공유를 누르면 <b>카카오톡·메일·드라이브</b> 등으로 바로 보내거나 원하는 폴더에 저장할 수 있습니다.</div>';
    }

    // ② 다운로드 목록/폴더 열기
    if (dev.isAndroid && dev.isChrome) {
      // 크롬 안드로이드: 다운로드 목록 페이지로 이동 가능
      var bDl = document.createElement('button');
      bDl.className = 'btn';
      bDl.textContent = '⬇ 브라우저 다운로드 목록 열기';
      bDl.onclick = function () {
        // 새 탭으로 크롬 다운로드 화면 시도
        var w = window.open('chrome://downloads', '_blank');
        if (!w) {
          hint.textContent = '주소창에 chrome://downloads 를 입력하면 다운로드 목록이 열립니다.';
        }
        closeDownloadInfoLater();
      };
      actions.appendChild(bDl);
      hint.textContent = '버튼이 막히면: 크롬 우측 상단 ⋮ 메뉴 → "다운로드"';
    } else if (dev.isAndroid) {
      hint.textContent = '파일 위치: 브라우저 메뉴 → 다운로드, 또는 "내 파일" 앱의 다운로드 폴더';
    } else if (dev.isIOS) {
      hint.innerHTML = 'Safari 화면 위쪽 <b>↓</b> 아이콘 → 파일을 탭하면 파일 앱에서 열립니다.';
    } else {
      var bJ = document.createElement('button');
      bJ.className = 'btn';
      bJ.textContent = '다운로드 목록 열기 (Ctrl+J)';
      bJ.onclick = function () { toast('키보드에서 Ctrl+J 를 누르세요'); };
      actions.appendChild(bJ);
    }

    // 닫기
    var bClose = document.createElement('button');
    bClose.className = 'btn ghost';
    bClose.textContent = '닫기';
    bClose.onclick = closeDownloadInfo;
    actions.appendChild(bClose);

    $('#dlOverlay').hidden = false;
  }

  function shareCsv(fname) {
    var csv = buildCsv();
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var file = null;
    try { file = new File([blob], fname, { type: 'text/csv' }); } catch (e) {}

    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: fname,
        text: (state.invoice || '') + ' 스캔 기록' })
        .then(function () { closeDownloadInfo(); })
        .catch(function () { /* 사용자가 취소 */ });
    } else if (navigator.share) {
      // 파일 공유 미지원 → 텍스트로라도 공유
      navigator.share({ title: fname, text: csv }).catch(function () {});
    } else {
      toast('이 브라우저는 공유를 지원하지 않습니다');
    }
  }

  function closeDownloadInfo() { $('#dlOverlay').hidden = true; }
  function closeDownloadInfoLater() { setTimeout(closeDownloadInfo, 400); }

  /* ---- 초기화 ---- */
  function bind() {
    $('#btnCam').onclick = function () { startCam(); };
    $('#btnCamStop').onclick = stopCam;
    $('#camSel').onchange = function (e) { stopCam(); startCam(e.target.value); };
    $('#btnExport').onclick = exportCsv;
    $('#dlOverlay').addEventListener('click', function (e) {
      if (e.target === $('#dlOverlay')) closeDownloadInfo();
    });
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
