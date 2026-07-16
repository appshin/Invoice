/* =========================================================================
 * KOWOO 인보이스 QR 라벨 발행 (app.js)
 * ========================================================================= */
(function () {
  'use strict';

  var P = window.KWInvoiceParse;
  var $ = function (s) { return document.querySelector(s); };

  var st = { invoiceNo: '', dateText: '', fileName: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function toast(m) {
    var t = $('#toast'); t.textContent = m; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

  /* ---- QR 페이로드: 라벨마다 일련번호가 달라 내용이 절대 겹치지 않음 ---- */
  function payload(seq, total) {
    var w = String(total).length < 2 ? 2 : String(total).length;
    return ['KWINV', st.invoiceNo || '-', st.dateText || '-',
            pad(seq, w) + '/' + pad(total, w)].join('|');
  }

  function qrSvg(text) {
    try {
      var qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
    } catch (e) {
      return '<div style="width:60px;height:60px;border:1px dashed #999"></div>';
    }
  }

  /* ---- 입력값 읽기 ---- */
  function cfg() {
    var total = clampInt($('#f_total').value, 1, 999, 1);
    var from  = clampInt($('#f_from').value, 1, 999, 1);
    var count = clampInt($('#f_count').value, 1, 999, 1);
    return {
      total: total, from: from, count: count,
      cols: parseInt($('#f_cols').value, 10) || 1,
      showText: $('#f_showText').checked
    };
  }
  function clampInt(v, lo, hi, dflt) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  /* ---- 라벨 HTML : 왼쪽 QR + 오른쪽 인보이스번호/날짜(육안 식별용) ---- */
  function labelHtml(seq, c) {
    var text = payload(seq, c.total);
    var w = String(c.total).length < 2 ? 2 : String(c.total).length;
    return '<div class="label">' +
      '<div class="qr">' + qrSvg(text) + '</div>' +
      '<div class="fields">' +
        '<div class="f">' +
          '<div class="k">INVOICE NO.</div>' +
          '<div class="v">' + esc(st.invoiceNo || '—') + '</div>' +
        '</div>' +
        '<div class="f">' +
          '<div class="k">DATE</div>' +
          '<div class="v">' + esc(st.dateText || '—') + '</div>' +
        '</div>' +
        (c.showText ? '<div class="txt">' + esc(text) + '</div>' : '') +
      '</div>' +
      '<div class="stamp">' +
        '<div class="cap">NO.</div>' +
        '<div class="num">' + pad(seq, w) +
          '<span class="of">/ ' + pad(c.total, w) + '</span></div>' +
      '</div>' +
    '</div>';
  }

  /* ---- 미리보기 렌더 ---- */
  function render() {
    var c = cfg();
    var root = $('#previewRoot');
    var ready = !!(st.invoiceNo && st.dateText);

    // QR 내용 미리보기 (3번 라벨 기준, 없으면 시작번호)
    var sample = Math.min(Math.max(3, c.from), c.from + c.count - 1);
    $('#payloadPreview').innerHTML = ready
      ? esc(payload(sample, c.total)).replace(
          /(\d+\/\d+)$/, '<b>$1</b>')
      : '파일을 올리거나 정보를 입력하세요';

    $('#btnPrint').disabled = !ready;
    $('#btnPrint2').disabled = !ready;

    if (!ready) {
      root.innerHTML = '<div class="empty"><div class="big">▦</div>' +
        '<h3>인보이스 정보가 필요합니다</h3>' +
        '<div>엑셀 파일을 올리면 인보이스 번호와 날짜를 자동으로 읽어<br>' +
        'QR 라벨을 만들어 드립니다.</div></div>';
      $('#cnt').textContent = '—';
      return;
    }

    var last = c.from + c.count - 1;
    var over = last > c.total;
    $('#cnt').innerHTML = '<b>' + c.count + '</b>장 인쇄 · ' +
      '번호 <b>' + c.from + '</b> ~ <b>' + last + '</b> / 총 <b>' + c.total + '</b>장' +
      (over ? ' <span style="color:var(--red)">· 총 매수를 넘습니다</span>' : '');

    var html = '';
    for (var i = 0; i < c.count; i++) html += labelHtml(c.from + i, c);
    root.innerHTML = '<div class="sheet"><div class="labels c' + c.cols + '">' + html + '</div></div>';
  }

  /* ---- 엑셀 읽기 ---- */
  function readFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var wb = XLSX.read(new Uint8Array(reader.result), { type: 'array', cellDates: true });
        var r = P.extract(XLSX, wb);
        st.fileName = file.name;
        $('#fileName').textContent = file.name;
        $('#fileRow').hidden = false;
        $('#drop').classList.add('loaded');
        $('#dropT1').textContent = '읽기 완료';
        $('#dropT2').textContent = r.sheet ? '시트: ' + r.sheet : '';

        if (r.invoiceNo || r.dateText) {
          st.invoiceNo = r.invoiceNo; st.dateText = r.dateText;
          $('#f_inv').value = r.invoiceNo;
          $('#f_date').value = r.dateText;
          $('#srcNote').className = 'note';
          $('#srcNote').innerHTML = '자동으로 읽었습니다 · <b>' + esc(r.source) + '</b>' +
            (r.invoiceNo && !r.dateText ? '<br>날짜를 찾지 못했습니다. 직접 입력해 주세요.' : '');
          toast('인보이스 ' + (r.invoiceNo || '') + ' 를 읽었습니다');
        } else {
          $('#srcNote').className = 'warn';
          $('#srcNote').innerHTML = '이 파일에서 인보이스 번호를 찾지 못했습니다. ' +
            '아래 두 칸에 직접 입력하시면 그대로 라벨이 만들어집니다.';
          toast('자동 인식 실패 · 직접 입력해 주세요');
        }
        render();
      } catch (e) {
        $('#srcNote').className = 'warn';
        $('#srcNote').textContent = '엑셀 파일을 여는 중 문제가 생겼습니다. 파일이 손상되지 않았는지 확인하거나, 정보를 직접 입력해 주세요.';
        toast('파일을 읽지 못했습니다');
      }
    };
    reader.onerror = function () { toast('파일을 읽지 못했습니다'); };
    reader.readAsArrayBuffer(file);
  }

  function clearFile() {
    st.fileName = '';
    $('#fileRow').hidden = true;
    $('#drop').classList.remove('loaded');
    $('#dropT1').textContent = '엑셀 파일을 올려놓으세요';
    $('#dropT2').textContent = '클릭해서 선택 · .xlsx / .xlsm';
    $('#fileInput').value = '';
  }

  /* ---- 이벤트 ---- */
  function bind() {
    var drop = $('#drop'), input = $('#fileInput');
    drop.onclick = function () { input.click(); };
    input.onchange = function (e) { if (e.target.files[0]) readFile(e.target.files[0]); };
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files[0]; if (f) readFile(f);
    });
    $('#btnClear').onclick = function (e) { e.stopPropagation(); clearFile(); };

    // 정보 직접 수정
    $('#f_inv').oninput = function (e) { st.invoiceNo = e.target.value.trim(); render(); };
    $('#f_date').oninput = function (e) { st.dateText = e.target.value.trim(); render(); };

    // 수량/배치
    ['#f_total', '#f_from', '#f_count', '#f_cols', '#f_showText'].forEach(function (sel) {
      $(sel).addEventListener('input', render);
      $(sel).addEventListener('change', render);
    });
    // 총 매수 바꾸면 인쇄 매수도 따라가도록 (시작이 1일 때만)
    $('#f_total').addEventListener('change', function () {
      if (clampInt($('#f_from').value, 1, 999, 1) === 1) {
        $('#f_count').value = clampInt($('#f_total').value, 1, 999, 1);
        render();
      }
    });

    $('#btnPrint').onclick = function () { window.print(); };
    $('#btnPrint2').onclick = function () { window.print(); };

    $('#btnSample').onclick = function () {
      st.invoiceNo = 'KW260716-RM'; st.dateText = 'Jul-16-2026';
      $('#f_inv').value = st.invoiceNo; $('#f_date').value = st.dateText;
      $('#srcNote').className = 'note';
      $('#srcNote').innerHTML = '샘플 값입니다. 실제 파일을 올리면 자동으로 바뀝니다.';
      render();
    };
  }

  function init() { bind(); render(); }
  document.addEventListener('DOMContentLoaded', init);
})();
