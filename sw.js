// X Gallery のサービスワーカー。2つのものを端末に取っておく。
// 1) ページそのもの（index.html など）: 取っておいたものをすぐ出し、裏で新しい版を取っておく（次に開いたときに新しくなる）
// 2) 画像（サムネイル）: ページは「t/ファイルID/大きさ?u=本当のURL」で頼む。ファイルID と大きさで覚えるので、
//    ドライブの URL が変わっても（時間がたつと変わる）、一度見た画像は通信せずに出せる。
var SHELL = 'xg-shell-v1';
var IMG = 'xg-img-v1';
var SHELL_FILES = ['./', 'index.html', 'drive.js', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
var MAX_IMG = 4000; // 取っておく画像の数の上限。超えたら古いものから捨てる

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(SHELL_FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== SHELL && k !== IMG; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return; // Google への通信はそのまま
  var scope = new URL(self.registration.scope);
  var rel = url.pathname.slice(scope.pathname.length);
  if (rel.indexOf('t/') === 0) { e.respondWith(image(url)); return; }
  e.respondWith(shell(e.request, url));
});

// ページの部品: 取っておいたものを先に返し、裏で取り直す（Google のログインから戻ったときの # 付きも同じ扱い）
function shell(req, url) {
  return caches.open(SHELL).then(function (c) {
    var key = url.pathname.endsWith('/') ? new Request(url.origin + url.pathname) : req;
    return c.match(key, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (r) { if (r.ok) c.put(key, r.clone()); return r; });
      if (hit) { net.catch(function () {}); return hit; }
      return net;
    });
  });
}

// 画像。ドライブの画像が「よそのページから読んでよい」と返す（CORS）なら、中身を確かめて覚える。
// 返さないときは、中身の見えない形（opaque）で覚える。失敗した画像が覚えられてしまったときは、
// ページが表示に失敗したことに気づいて、覚えたものを消して取り直す。
var corsOk = null, puts = 0;
function image(url) {
  var key = url.origin + url.pathname;
  var real = url.searchParams.get('u');
  return caches.open(IMG).then(function (c) {
    return c.match(key).then(function (hit) {
      if (hit) return hit;
      if (!real) return new Response('', { status: 404 });
      var keep = function (r) { c.put(key, r.clone()).then(trim).catch(function () {}); return r; };
      var opaque = function () { return fetch(real, { mode: 'no-cors', referrerPolicy: 'no-referrer', credentials: 'omit' }).then(keep); };
      if (corsOk === false) return opaque();
      return fetch(real, { mode: 'cors', referrerPolicy: 'no-referrer', credentials: 'omit' }).then(function (r) {
        corsOk = true;
        return r.ok ? keep(r) : r;
      }, function () { corsOk = false; return opaque(); });
    });
  });
}
function trim() {
  if (++puts % 50) return;
  caches.open(IMG).then(function (c) {
    return c.keys().then(function (keys) {
      if (keys.length <= MAX_IMG) return;
      return Promise.all(keys.slice(0, keys.length - MAX_IMG + 500).map(function (k) { return c.delete(k); }));
    });
  });
}
