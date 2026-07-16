/* =========================================================================
 * KOWOO 인보이스 QR — 인보이스 파싱 (parse.js)
 * xlsx 워크북에서 (8) No. & Date of invoice 항목의 인보이스 번호/날짜 추출
 * 브라우저 + Node 양쪽에서 동작 (테스트 가능하도록 UMD 형태)
 * ========================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KWInvoiceParse = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  /* 엑셀 원본 서식(mmm"-"d"-"yyyy)과 동일하게: Jul-16-2026 */
  function fmtDate(d) {
    if (!(d instanceof Date) || isNaN(d)) return '';
    return MONTHS[d.getMonth()] + '-' + d.getDate() + '-' + d.getFullYear();
  }

  /* 엑셀 일련번호(1900 체계) → Date. SheetJS cellDates 미적용 대비 폴백 */
  function serialToDate(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 1 || n > 100000) return null;
    var ms = Math.round((n - 25569) * 86400 * 1000);   // 1899-12-30 기준
    var d = new Date(ms);
    return isNaN(d) ? null : new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /* 시트를 2차원 배열로 (SheetJS 필요) */
  function toGrid(XLSX, ws) {
    return XLSX.utils.sheet_to_json(ws, {
      header: 1, raw: true, blankrows: true, defval: null
    });
  }

  function asDate(v) {
    if (v instanceof Date && !isNaN(v)) return v;
    if (typeof v === 'number') return serialToDate(v);
    return null;
  }

  /* 인보이스 번호 형태: KW260716-RM 처럼 영문+숫자+하이픈 조합 */
  function looksLikeInvoiceNo(v) {
    if (typeof v !== 'string') return false;
    var s = v.trim();
    if (s.length < 4 || s.length > 40) return false;
    if (!/\d/.test(s)) return false;                 // 숫자 포함
    if (!/^[A-Za-z0-9][A-Za-z0-9\-\/_. ]*$/.test(s)) return false;
    if (/^\(\d+\)/.test(s)) return false;            // "(8) ..." 라벨 제외
    return true;
  }

  /* ---------------------------------------------------------------------
   * 추출: (8) No. & Date of invoice 라벨을 찾아 바로 아래 행에서
   *       인보이스 번호(문자열)와 날짜(Date)를 읽는다.
   *       실패 시 G4/J4 고정 위치 → 패턴 스캔 순으로 폴백.
   * ------------------------------------------------------------------- */
  function extract(XLSX, wb) {
    var result = { invoiceNo: '', date: null, dateText: '', sheet: '', source: '' };

    var sheetNames = wb.SheetNames.slice();
    // 'packing list' 우선
    sheetNames.sort(function (a, b) {
      var pa = norm(a).indexOf('packinglist') === 0 ? 0 : 1;
      var pb = norm(b).indexOf('packinglist') === 0 ? 0 : 1;
      return pa - pb;
    });

    for (var si = 0; si < sheetNames.length; si++) {
      var name = sheetNames[si];
      var grid = toGrid(XLSX, wb.Sheets[name]);
      if (!grid || !grid.length) continue;

      /* 1) 라벨 기반 탐색 */
      for (var r = 0; r < Math.min(grid.length, 40); r++) {
        var row = grid[r] || [];
        for (var c = 0; c < row.length; c++) {
          var n = norm(row[c]);
          if (n.indexOf('nodateofinvoice') === -1) continue;

          var below = grid[r + 1] || [];
          var inv = '', dt = null;
          for (var k = c; k < Math.min(below.length, c + 12); k++) {
            var v = below[k];
            if (!inv && looksLikeInvoiceNo(v)) inv = String(v).trim();
            if (!dt) { var d = asDate(v); if (d) dt = d; }
          }
          if (inv || dt) {
            result.invoiceNo = inv; result.date = dt;
            result.dateText = fmtDate(dt); result.sheet = name;
            result.source = '라벨 "(8) No. & Date of invoice" 기준';
            return result;
          }
        }
      }

      /* 2) 고정 위치 폴백: G4 / J4 */
      var ws = wb.Sheets[name];
      var g4 = ws['G4'], j4 = ws['J4'];
      if (g4 && looksLikeInvoiceNo(g4.v !== undefined ? String(g4.v) : '')) {
        result.invoiceNo = String(g4.v).trim();
        var d4 = j4 ? asDate(j4.v instanceof Date ? j4.v : (j4.t === 'd' ? j4.v : j4.v)) : null;
        result.date = d4; result.dateText = fmtDate(d4); result.sheet = name;
        result.source = '고정 위치 G4 / J4';
        return result;
      }
    }

    return result;
  }

  return {
    extract: extract,
    fmtDate: fmtDate,
    serialToDate: serialToDate,
    looksLikeInvoiceNo: looksLikeInvoiceNo
  };
}));
