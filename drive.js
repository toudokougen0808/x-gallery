// X Gallery（スマホ用・ホーム画面に置ける版）の、Google ドライブとのやりとり。
// 画面（index.html）から呼ぶ関数を、ブラウザから Drive API を直接呼んで行う（以前の Apps Script 版と同じ形の結果を返す）。
// できる操作は、見ることと、ジャンル間の移動（「ゴミ箱」フォルダへの移動を含む）だけ。
// ファイルを完全に消すこと、名前を変えること、画像を上書きすることはしない。
//
// ログインは Google の画面へ移って戻ってくる形（ポップアップを使わないので、ホーム画面から開いても動く）。
// 受け取る鍵（アクセストークン）は1時間で切れる。切れたら、もう一度 Google の画面を通って取り直す
// （一度許可していれば、Google の画面は一瞬で戻ってくる）。
(function () {
  var CFG = window.XG_CONFIG || {};
  var ROOT_NAME = 'Xのいろいろ保存';
  var TRASH_NAME = 'ゴミ箱';
  var MEDIA_RE = /\.(jpe?g|png|webp|gif|avif|bmp|mp4|webm|mov)$/i;
  var API = 'https://www.googleapis.com/drive/v3/';
  var UPLOAD = 'https://www.googleapis.com/upload/drive/v3/';
  var SCOPE = 'https://www.googleapis.com/auth/drive';
  var FOLDER = 'application/vnd.google-apps.folder';

  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) {} }
  function load(k, json) { try { var v = localStorage.getItem(k); return json ? JSON.parse(v || 'null') : v; } catch (e) { return null; } }

  // ---- ログイン ----
  var auth = load('xg-auth', true) || {};
  var XG = { leaving: false };

  // 戻り先は、いつも「…/」の形にする（「…/index.html」で開いても、Google に登録したアドレスと合うように）
  function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
  XG.login = function () {
    var st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    store('xg-auth-state', st);
    XG.leaving = true; // 「移動中に閉じますか」の確認を出さない
    var p = { client_id: CFG.clientId, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE, include_granted_scopes: 'true', state: st };
    var hint = load('xg-auth-hint');
    if (hint) p.login_hint = hint;
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(p).toString();
    return new Promise(function () {}); // ページを離れるので、ここから先は進まない
  };
  XG.logout = function () { auth = {}; store('xg-auth', null); store('xg-auth-hint', null); };

  // Google の画面から戻ってきたとき、アドレスの # の後ろに鍵が付いている
  function takeHash() {
    if (!location.hash || location.hash.length < 2) return null;
    var h = new URLSearchParams(location.hash.slice(1));
    if (!h.get('access_token') && !h.get('error')) return null;
    history.replaceState(null, '', location.pathname + location.search);
    var expected = load('xg-auth-state');
    store('xg-auth-state', null);
    if (h.get('error')) return h.get('error');
    if (!expected || h.get('state') !== expected) return 'state';
    auth = { token: h.get('access_token'), exp: Date.now() + (+h.get('expires_in') || 3600) * 1000 };
    store('xg-auth', auth);
    return 'ok';
  }

  // 起動時に呼ぶ。'ok'（使える）／'config'（設定が無い）／'login'（ログインが要る）／'error:理由' を返す。
  // 鍵の残りが 45 分を切っていたら、使っている途中で切れないよう、起動のときに取り直す
  XG.ready = function () {
    if (!CFG.clientId) return Promise.resolve('config');
    var got = takeHash();
    if (got && got !== 'ok') return Promise.resolve('error:' + got);
    var left = (auth.exp || 0) - Date.now();
    if (auth.token && left > 45 * 60 * 1000) return Promise.resolve('ok');
    if (auth.token && got === 'ok') return Promise.resolve('ok');
    // 前にログインしたことがあれば、そのまま取り直しに行く（一瞬で戻ってくる）。初めてなら、ボタンを押してもらう
    if (load('xg-auth-hint')) return XG.login();
    return Promise.resolve('login');
  };
  XG.tokenLeft = function () { return (auth.exp || 0) - Date.now(); };

  // Drive API を呼ぶ。鍵が切れていたら（401）、取り直しに行く。移動の順番待ちは端末に記録してあるので、戻ってから続きを行う
  function api(path, opt) {
    opt = opt || {};
    if (!auth.token || XG.tokenLeft() < 30 * 1000) return XG.login();
    var headers = Object.assign({ Authorization: 'Bearer ' + auth.token }, opt.headers || {});
    return fetch(path.indexOf('http') === 0 ? path : API + path, { method: opt.method || 'GET', headers: headers, body: opt.body }).then(function (r) {
      if (r.status === 401) { auth = {}; store('xg-auth', null); return XG.login(); }
      if (!r.ok && r.status !== 206) {
        return r.text().then(function (t) {
          var msg = t;
          try { var j = JSON.parse(t); msg = (j.error && j.error.message) || t; } catch (e) {}
          var err = new Error(msg || ('HTTP ' + r.status)); err.status = r.status; throw err;
        });
      }
      return opt.raw ? r : r.json();
    });
  }
  function qs(o) { return new URLSearchParams(o).toString(); }
  function q1(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }

  // 条件に合うファイルを全部取る（1回に 1000 件ずつ）
  function listAll(q, fields) {
    var out = [];
    var page = function (token) {
      var p = { q: q, fields: 'nextPageToken,files(' + fields + ')', pageSize: 1000, supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' };
      if (token) p.pageToken = token;
      return api('files?' + qs(p)).then(function (r) {
        out = out.concat(r.files || []);
        return r.nextPageToken ? page(r.nextPageToken) : out;
      });
    };
    return page(null);
  }

  // 同時にいくつかずつ進める（多すぎると Google に止められるので控えめに）
  function pool(list, n, fn) {
    var i = 0, res = new Array(list.length);
    var worker = function () {
      if (i >= list.length) return Promise.resolve();
      var k = i++;
      return Promise.resolve().then(function () { return fn(list[k], k); }).then(function (v) { res[k] = v; }, function (e) { res[k] = { error: e }; }).then(worker);
    };
    var ws = [];
    for (var w = 0; w < Math.min(n, list.length); w++) ws.push(worker());
    return Promise.all(ws).then(function () { return res; });
  }

  // ---- 「Xのいろいろ保存」と、その直下のフォルダ ----
  var rootP = null;
  function root() {
    if (rootP) return rootP;
    var saved = load('xg-root');
    var find = function () {
      return listAll('name = ' + q1(ROOT_NAME) + ' and mimeType = ' + q1(FOLDER) + ' and trashed = false', 'id,ownedByMe').then(function (fs) {
        if (!fs.length) throw new Error('フォルダ「' + ROOT_NAME + '」が見つかりません。このアカウントのドライブにあるか、共有されているか確かめてください。');
        fs.sort(function (a, b) { return (b.ownedByMe ? 1 : 0) - (a.ownedByMe ? 1 : 0); });
        store('xg-root', fs[0].id);
        return fs[0].id;
      });
    };
    rootP = (saved ? api('files/' + saved + '?' + qs({ fields: 'id,trashed', supportsAllDrives: 'true' })).then(function (f) { if (f.trashed) throw new Error('trashed'); return f.id; }).catch(function (e) { if (e && e.status === 401) throw e; return find(); }) : find());
    rootP.catch(function () { rootP = null; });
    return rootP;
  }

  // 直下のフォルダ（ジャンル・ゴミ箱・_web など）の { byId: {ID: 名前}, trash: ID, web: ID }。10分覚えておく
  var kidsMem = null;
  function kids(fresh) {
    if (!fresh && kidsMem && Date.now() - kidsMem.at < 10 * 60 * 1000) return Promise.resolve(kidsMem);
    return root().then(function (rid) {
      return listAll(q1(rid) + ' in parents and mimeType = ' + q1(FOLDER) + ' and trashed = false', 'id,name').then(function (fs) {
        var k = { at: Date.now(), root: rid, byId: {}, trash: null, web: null };
        fs.forEach(function (f) {
          if (f.name === '_web') k.web = f.id;
          if (f.name.charAt(0) === '_') return;
          k.byId[f.id] = f.name;
          if (f.name === TRASH_NAME) k.trash = f.id;
        });
        kidsMem = k;
        return k;
      });
    });
  }
  function checkGenre(folderId) {
    return kids(false).then(function (k) { return k.byId[folderId] ? k : kids(true); }).then(function (k) {
      if (!k.byId[folderId]) throw new Error('このフォルダは表示できません');
      return k;
    });
  }

  // _web の中のファイル { 名前: {id, size, modifiedTime} }。1分覚えておく
  var webMem = null;
  function webFiles(fresh) {
    if (!fresh && webMem && Date.now() - webMem.at < 60 * 1000) return Promise.resolve(webMem.files);
    return kids(false).then(function (k) {
      if (!k.web) return {};
      return listAll(q1(k.web) + ' in parents and trashed = false', 'id,name,size,modifiedTime').then(function (fs) {
        var m = {};
        fs.forEach(function (f) { m[f.name] = f; });
        webMem = { at: Date.now(), files: m };
        return m;
      });
    });
  }
  function readText(id, range) {
    var h = range ? { Range: 'bytes=' + range } : {};
    return api('files/' + id + '?alt=media&supportsAllDrives=true', { headers: h, raw: true }).then(function (r) { return r.arrayBuffer(); });
  }

  // ---- 端末の保存場所（IndexedDB） ----
  var dbP = null;
  function db() {
    if (!dbP) dbP = new Promise(function (res) {
      try {
        var r = indexedDB.open('xg-pwa', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
    return dbP;
  }
  function kvGet(k) {
    return db().then(function (d) {
      if (!d) return null;
      return new Promise(function (res) { try { var q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = function () { res(q.result || null); }; q.onerror = function () { res(null); }; } catch (e) { res(null); } });
    });
  }
  function kvPut(k, v) { return db().then(function (d) { if (!d) return; try { d.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch (e) {} }); }

  // ---- 本文などの情報（_web/meta.jsonl、数MB） ----
  // 一度取ったものを端末に取っておき、次からは増えた分（ファイルの後ろに足された行）だけを取る。
  // 途中が書き換わっていたとき（増えた分の手前の部分が、取っておいたものと合わないとき）は、全部を取り直す。
  var metaMem = null, metaP = null;
  var dec = new TextDecoder('utf-8');
  function parseMetas(text) {
    var m = {};
    text.split(/\r?\n/).forEach(function (line) {
      if (!line) return;
      try { var o = JSON.parse(line); if (o && o.k && o.m) m[o.k] = slim(o.m); } catch (e) {}
    });
    return m;
  }
  function slim(m) { return { name: m.name || null, text: m.text || '', thread: m.thread || null, created_at: m.created_at || null, source: m.source || null }; }
  function same(a, b) { if (!a || !b || a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  function loadMetas() {
    if (metaMem && Date.now() - metaMem.at < 3 * 60 * 1000) return Promise.resolve(metaMem.map);
    if (metaP) return metaP;
    metaP = Promise.all([webFiles(true), kvGet('meta')]).then(function (r) {
      var f = r[0]['meta.jsonl'], saved = r[1];
      if (!f) return {};
      var size = +f.size || 0;
      var full = function () {
        return readText(f.id).then(function (buf) {
          var bytes = new Uint8Array(buf), text = dec.decode(bytes);
          kvPut('meta', { id: f.id, size: bytes.length, tail: bytes.slice(Math.max(0, bytes.length - 64)), text: text });
          return text;
        });
      };
      var textP;
      if (!saved || saved.id !== f.id || size < saved.size) textP = full();
      else if (size === saved.size) textP = Promise.resolve(saved.text);
      else {
        // 足された分だけを取る。合わせ目の 64 バイトが、取っておいたものの最後と同じか確かめる
        var from = Math.max(0, saved.size - saved.tail.length);
        textP = readText(f.id, from + '-' + (size - 1)).then(function (buf) {
          var bytes = new Uint8Array(buf);
          if (!same(bytes.slice(0, saved.tail.length), saved.tail)) return full();
          var add = bytes.slice(saved.tail.length), text = saved.text + dec.decode(add);
          var tail = add.length >= 64 ? add.slice(add.length - 64) : (function () { var t = new Uint8Array(saved.tail.length + add.length); t.set(saved.tail); t.set(add, saved.tail.length); return t.slice(Math.max(0, t.length - 64)); })();
          kvPut('meta', { id: f.id, size: size, tail: tail, text: text });
          return text;
        }).catch(function () { return full(); });
      }
      return textP.then(function (text) {
        var map = parseMetas(text);
        metaMem = { at: Date.now(), map: map };
        return map;
      });
    }).then(function (m) { metaP = null; return m; }, function (e) {
      metaP = null;
      if (metaMem) return metaMem.map; // 取れなくても、前に取ったもので続ける
      return kvGet('meta').then(function (s) { if (s && s.text) return parseMetas(s.text); throw e; });
    });
    return metaP;
  }

  // ---- サムネイルの URL（ジャンルごとに 30 分覚えておく。時間がたつと使えなくなるため） ----
  var thumbsMem = {};
  function listGenre(folderId) {
    return listAll(q1(folderId) + ' in parents and trashed = false', 'id,name,thumbnailLink').then(function (fs) {
      var map = {};
      fs.forEach(function (f) { if (MEDIA_RE.test(f.name)) map[f.id] = f.thumbnailLink || ''; });
      thumbsMem[folderId] = { at: Date.now(), map: map };
      return fs;
    });
  }

  // ---- 画面から呼ぶ関数 ----

  // ジャンル（直下のフォルダ。_ で始まるものとゴミ箱は除く）の一覧
  // 並び順は PC のギャラリーと同じ（_web/settings.json の genreOrder。無いものは後ろに五十音順、「未分類」はその後ろ）
  XG.getGenres = function () {
    return Promise.all([kids(true), readJson('settings.json', {})]).then(function (r) {
      var k = r[0], order = Array.isArray(r[1].genreOrder) ? r[1].genreOrder : [];
      var out = [];
      Object.keys(k.byId).forEach(function (id) { if (id !== k.trash) out.push({ name: k.byId[id], id: id }); });
      var pos = function (g) { var i = order.indexOf(g.name); return i < 0 ? Infinity : i; };
      var rank = function (g) { return g.name === '未分類' ? 1 : 0; };
      out.sort(function (a, b) { return (pos(a) - pos(b)) || (rank(a) - rank(b)) || a.name.localeCompare(b.name, 'ja'); });
      if (k.trash) out.push({ name: TRASH_NAME, id: k.trash, trash: true });
      return out;
    });
  };
  function readJson(name, empty) {
    return webFiles(false).then(function (w) {
      if (!w[name]) return empty;
      return readText(w[name].id).then(function (buf) { return JSON.parse(dec.decode(buf)) || empty; });
    }).catch(function () { return empty; });
  }

  // ゴミ箱へ入れた日時 { ファイル名: ミリ秒 }（ゴミ箱のタブを、入れた順に並べるのに使う）
  XG.getTrashLog = function () {
    return webFiles(true).then(function () { return readJson('trash.json', { files: {} }); }).then(function (o) {
      var m = {};
      Object.keys(o.files || {}).forEach(function (n) { m[n] = Date.parse(o.files[n]) || 0; });
      return m;
    });
  };

  // ジャンル1つ分の中身。{ files: [[名前, ID], ...], metas: { キー: 情報 }, jsons: { 情報ファイル名: ID } }
  XG.getGenre = function (folderId) {
    return checkGenre(folderId).then(function () {
      return Promise.all([listGenre(folderId), loadMetas()]);
    }).then(function (r) {
      var listed = r[0], all = r[1];
      var files = [], jsons = {}, metas = {};
      listed.forEach(function (f) {
        if (MEDIA_RE.test(f.name)) files.push([f.name, f.id]);
        else if (/\.json$/i.test(f.name)) jsons[f.name] = f.id;
      });
      files.forEach(function (f) { var k = keyOf(f[0]); if (k && all[k]) metas[k] = all[k]; });
      return { files: files, metas: metas, jsons: jsons };
    });
  };
  function keyOf(name) {
    var m = name.match(/^(.+)_(\d{6,})_(\d+)\.[^.]+$/);
    if (!m) return null;
    return /^px-\d+$/.test(m[1]) ? 'px' + (m[2].replace(/^0+/, '') || '0') : m[2];
  }

  // 指定したファイルのサムネイルの URL（ids と同じ順。分からないものは空文字）
  XG.getThumbs = function (folderId, ids) {
    var mem = thumbsMem[folderId];
    var fresh = mem && Date.now() - mem.at < 30 * 60 * 1000 && ids.every(function (id) { return id in mem.map; });
    var p = fresh ? Promise.resolve() : checkGenre(folderId).then(function () { return listGenre(folderId); });
    return p.then(function () { var m = thumbsMem[folderId].map; return ids.map(function (id) { return m[id] || ''; }); });
  };

  // 作者の対応表（_web/authors.json）
  XG.getAuthors = function () {
    var empty = { pixiv: {}, links: [], unlinks: [] };
    return webFiles(false).then(function (w) {
      if (!w['authors.json']) return empty;
      return readText(w['authors.json'].id).then(function (buf) {
        var o = JSON.parse(dec.decode(buf));
        return { pixiv: o.pixiv || {}, links: o.links || [], unlinks: o.unlinks || [] };
      });
    }).catch(function () { return empty; });
  };

  // ファイルを別のジャンルへ移す。dest はジャンルのフォルダ ID か 'trash'（「ゴミ箱」フォルダへ）。
  // 直下のフォルダにあるファイルだけを、直下の別のフォルダへ移す。移動先に同じ名前があれば、上書きせずに飛ばす。
  // 戻り値: { moved: 移した数, skipped: [飛ばした名前], failed: [失敗の理由] }
  XG.moveItems = function (fileIds, dest) {
    var out = { moved: 0, skipped: [], failed: [] };
    if (!fileIds || !fileIds.length) return Promise.resolve(out);
    var k, destId;
    return kids(false).then(function (k0) {
      return dest !== 'trash' && !k0.byId[dest] ? kids(true) : k0;
    }).then(function (k1) {
      k = k1;
      if (dest === 'trash') {
        if (k.trash) return k.trash;
        return api('files?fields=id&supportsAllDrives=true', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: TRASH_NAME, mimeType: FOLDER, parents: [k.root] }) }).then(function (f) { k.trash = f.id; k.byId[f.id] = TRASH_NAME; return f.id; });
      }
      if (!k.byId[dest]) throw new Error('移動先のジャンルが見つかりません');
      return dest;
    }).then(function (id) {
      destId = id;
      // 移すファイルの名前と、いまあるフォルダを調べる
      return pool(fileIds, 6, function (fid) { return api('files/' + fid + '?' + qs({ fields: 'id,name,parents', supportsAllDrives: 'true' })); });
    }).then(function (got) {
      var entries = [];
      got.forEach(function (f, i) {
        if (!f || f.error) out.failed.push(fileIds[i] + '（' + (f && f.error && f.error.message || '見つかりません') + '）');
        else entries.push(f);
      });
      var isJson = function (f) { return /\.json$/i.test(f.name); };
      var baseOf = function (name) { return name.replace(/\.json$/i, '').replace(/_\d+\.[^.]+$/, ''); };
      var stuck = {}, trashed = [], restored = [], taken = {};
      var moveOne = function (f) {
        var src = (f.parents || []).filter(function (p) { return k.byId[p]; })[0];
        if (!src) { out.failed.push(f.name + '（ギャラリーの外にあるファイルは動かせません）'); return Promise.resolve(false); }
        if (src === destId) return Promise.resolve(true);
        // 移動先に同じ名前があるか（移すファイルの名前だけを調べる）
        var check = taken[f.name] ? Promise.resolve(true) : listAll('name = ' + q1(f.name) + ' and ' + q1(destId) + ' in parents and trashed = false', 'id').then(function (fs) { return fs.length > 0; });
        return check.then(function (isTaken) {
          if (isTaken) { out.skipped.push(f.name); return false; }
          taken[f.name] = true;
          return api('files/' + f.id + '?' + qs({ addParents: destId, removeParents: src, fields: 'id', supportsAllDrives: 'true' }), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function () {
            out.moved++;
            if (dest === 'trash' && !isJson(f)) trashed.push(f.name);
            if (src === k.trash && dest !== 'trash' && !isJson(f)) restored.push(f.name);
            return true;
          });
        }).catch(function (e) { out.failed.push(f.name + '（' + (e && e.message ? e.message : e) + '）'); return false; });
      };
      // 画像・動画を先に移し、移せなかったポストの情報ファイル（.json）は動かさない
      var media = entries.filter(function (f) { return !isJson(f); }), js = entries.filter(isJson);
      return pool(media, 4, function (f) { return moveOne(f).then(function (ok) { if (!ok) stuck[baseOf(f.name)] = true; }); })
        .then(function () { return pool(js.filter(function (f) { return !stuck[baseOf(f.name)]; }), 4, moveOne); })
        .then(function () { if (trashed.length || restored.length) return noteTrash(trashed, restored).catch(function () {}); })
        .then(function () { return out; });
    });
  };

  // ゴミ箱へ入れた日時を _web/trash.json に記録する（PC のギャラリーが、ゴミ箱をこの順に並べる）
  function noteTrash(names, removed) {
    return webFiles(true).then(function (w) {
      var f = w['trash.json'];
      var docP = f ? readText(f.id).then(function (buf) { var d = JSON.parse(dec.decode(buf)); if (!d.files) d.files = {}; return d; }).catch(function () { return { files: {} }; }) : Promise.resolve({ files: {} });
      return docP.then(function (doc) {
        var now = new Date().toISOString();
        names.forEach(function (n) { doc.files[n] = now; });
        (removed || []).forEach(function (n) { delete doc.files[n]; });
        var text = JSON.stringify(doc);
        if (f) return api(UPLOAD + 'files/' + f.id + '?uploadType=media&supportsAllDrives=true', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text });
        if (!kidsMem || !kidsMem.web) return;
        var meta = { name: 'trash.json', mimeType: 'application/json', parents: [kidsMem.web] };
        var form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
        form.append('file', new Blob([text], { type: 'application/json' }));
        return api(UPLOAD + 'files?uploadType=multipart&supportsAllDrives=true', { method: 'POST', body: form });
      });
    });
  }

  window.XG = XG;
})();
