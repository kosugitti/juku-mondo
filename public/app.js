// ============================================================
// 塾Q&A 本体
//   参加者は匿名ログイン(ブラウザごとのID)。幹事だけ Google ログイン
//   ルート: #/        ホーム(幹事はイベント作成と一覧)
//           #/e/<ID>  イベントの質問板
// ============================================================

// ---- Firebase SDK の読み込み ----
const V = "10.14.1";
const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
const {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInAnonymously,
  signInWithPopup, GoogleAuthProvider, signOut,
} = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
const {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, collection, addDoc,
  updateDoc, deleteDoc, onSnapshot, query, orderBy, serverTimestamp, arrayUnion, arrayRemove,
} = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);

// ---- 初期化(設定は Firebase Hosting が /__/firebase/init.json で配る) ----
const config = await (await fetch("/__/firebase/init.json")).json();
const app = initializeApp(config);
const auth = getAuth(app);
const db = getFirestore(app);
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
if (isLocal) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  window.__jukuqa = { auth, db }; // 模擬環境での動作確認用(本番では作られない)
}

// ---- 状態 ----
const state = {
  user: null,
  isOrganizer: false,
  unsubs: [],          // 画面を離れるときに外すリスナー
  event: null,         // 表示中のイベント
  eventId: null,
  posts: [],           // 表示中のイベントの投稿
  sort: load("sort", "new"),
  replyTo: null,       // 返信先の投稿
};
const $app = document.getElementById("app");
const $who = document.getElementById("who");

// ---- 小道具 ----
function load(key, dflt) {
  try { return localStorage.getItem("jukuqa." + key) ?? dflt; } catch { return dflt; }
}
function save(key, value) {
  try { localStorage.setItem("jukuqa." + key, value); } catch { /* 保存できなくても動く */ }
}
// DOM を組み立てる(文字列は textContent で入れるので HTML として解釈されない)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
function toast(msg) {
  const t = h("div", { class: "toast" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2500);
}
function fail(e) {
  console.error(e);
  toast(e?.code === "permission-denied" ? "権限がありません(締め切り後かもしれません)" : "エラー: " + (e?.message ?? e));
}
function fmtTime(ts, withDate = false) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : ts;
  const p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return withDate ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}` : hm;
}
function clearListeners() {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
}

// ---- 認証 ----
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    // 誰でもまず匿名で入る
    signInAnonymously(auth).catch(fail);
    return;
  }
  state.user = user;
  state.isOrganizer = await checkOrganizer(user);
  renderWho();
  route();
});

async function checkOrganizer(user) {
  if (user.isAnonymous) return false;
  try {
    const snap = await getDoc(doc(db, "config", "organizers"));
    return snap.exists() && (snap.data().emails ?? []).includes(user.email);
  } catch {
    return false; // 載っていなければルールで読めない
  }
}

async function organizerLogin() {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    if (e?.code !== "auth/popup-closed-by-user") fail(e);
  }
}

function renderWho() {
  $who.replaceChildren();
  if (!state.user || state.user.isAnonymous) return;
  $who.append(
    h("span", {}, state.user.email + (state.isOrganizer ? " (幹事)" : "")),
    h("button", { class: "link", onclick: () => signOut(auth) }, "ログアウト"),
  );
}

// ---- 画面の振り分け ----
window.addEventListener("hashchange", () => state.user && route());
function route() {
  clearListeners();
  state.replyTo = null;
  document.querySelector(".composer")?.remove();
  const m = location.hash.match(/^#\/e\/([A-Za-z0-9]+)$/);
  if (m) renderEvent(m[1]);
  else renderHome();
}

// ============================================================
// ホーム
// ============================================================
function renderHome() {
  document.title = "塾Q&A";
  $app.replaceChildren();

  if (!state.isOrganizer) {
    $app.append(
      h("div", { class: "card" },
        h("h1", {}, "塾Q&A"),
        h("p", {}, "幹事から配られたイベントのURLを開いてください。"),
        state.user.isAnonymous
          ? h("p", { class: "muted" }, "幹事の方はこちらから: ",
              h("button", { onclick: organizerLogin }, "幹事としてGoogleでログイン"))
          : h("p", { class: "muted" }, "このGoogleアカウントは幹事として登録されていません。"),
      ),
    );
    return;
  }

  // 幹事: イベントを作る
  const title = h("input", { placeholder: "例: 夏合宿 1日目", maxlength: 100 });
  const create = async () => {
    const t = title.value.trim();
    if (!t) return;
    try {
      const ref = await addDoc(collection(db, "events"), {
        title: t,
        createdBy: state.user.uid,
        createdByEmail: state.user.email,
        createdAt: serverTimestamp(),
        closed: false,
      });
      location.hash = `#/e/${ref.id}`;
    } catch (e) { fail(e); }
  };
  const list = h("div", {}, h("p", { class: "muted" }, "読み込み中…"));
  $app.append(
    h("div", { class: "card" },
      h("h2", {}, "新しいイベントを始める"),
      h("div", { class: "row" }, title, h("button", { class: "primary", onclick: create }, "作成")),
    ),
    h("h2", {}, "これまでのイベント"),
    list,
  );

  state.unsubs.push(onSnapshot(
    query(collection(db, "events"), orderBy("createdAt", "desc")),
    (snap) => {
      list.replaceChildren();
      if (snap.empty) list.append(h("p", { class: "muted" }, "まだありません。"));
      snap.forEach((d) => {
        const ev = d.data({ serverTimestamps: "estimate" });
        list.append(h("div", { class: "card row" },
          h("a", { href: `#/e/${d.id}` }, ev.title),
          ev.closed ? h("span", { class: "badge closed" }, "締め切り") : h("span", { class: "badge" }, "受付中"),
          h("span", { class: "muted" }, fmtTime(ev.createdAt, true) + " · " + ev.createdByEmail),
        ));
      });
    },
    fail,
  ));
}

// ============================================================
// イベントの質問板
// ============================================================
function renderEvent(eventId) {
  state.eventId = eventId;
  state.event = null;
  state.posts = [];
  $app.replaceChildren(h("p", { class: "muted" }, "読み込み中…"));

  const head = h("div");
  const modPanel = h("div");
  const toolbar = h("div", { class: "toolbar" });
  const postsBox = h("div");
  $app.replaceChildren(head, modPanel, toolbar, postsBox);

  const composer = buildComposer();
  document.body.append(composer.el);

  const isMod = () =>
    state.isOrganizer || (state.event && state.event.createdBy === state.user.uid);

  const redraw = () => {
    if (!state.event) return;
    renderHead(head);
    renderModPanel(modPanel, isMod());
    renderToolbar(toolbar, redraw, isMod());
    renderPosts(postsBox, isMod());
    composer.update();
  };

  // イベント本体
  state.unsubs.push(onSnapshot(doc(db, "events", eventId), (snap) => {
    if (!snap.exists()) {
      state.event = null;
      composer.el.remove();
      $app.replaceChildren(h("div", { class: "card" },
        h("p", {}, "イベントが見つかりません。削除されたか，URLが違います。"),
        h("a", { href: "#/" }, "ホームへ")));
      return;
    }
    state.event = snap.data({ serverTimestamps: "estimate" });
    document.title = state.event.title + " | 塾Q&A";
    redraw();
  }, fail));

  // 投稿(返信を含む)を時刻順に
  state.unsubs.push(onSnapshot(
    query(collection(db, "events", eventId, "posts"), orderBy("createdAt", "asc")),
    (snap) => {
      state.posts = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
      redraw();
    },
    fail,
  ));
}

function renderHead(el) {
  const ev = state.event;
  el.replaceChildren(
    h("div", { class: "row" },
      h("h1", {}, ev.title),
      ev.closed ? h("span", { class: "badge closed" }, "締め切りました(閲覧とCSV保存はできます)") : null),
  );
}

// ---- 司会の操作 ----
function renderModPanel(el, isMod) {
  el.replaceChildren();
  if (!isMod) return;
  const ev = state.event;
  const ref = doc(db, "events", state.eventId);
  const url = location.href;
  const qrBox = h("div");
  const showQR = () => {
    if (qrBox.firstChild) { qrBox.replaceChildren(); return; }
    const box = h("div", { id: "qr" });
    qrBox.append(box, h("p", { class: "muted", style: "text-align:center;overflow-wrap:anywhere" }, url));
    // eslint-disable-next-line no-undef
    new QRCode(box, { text: url, width: 240, height: 240, correctLevel: QRCode.CorrectLevel.M });
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); toast("URLをコピーしました"); } catch { toast(url); }
  };
  const toggleClose = () => updateDoc(ref, { closed: !ev.closed }).catch(fail);
  const remove = async () => {
    if (!confirm(`「${ev.title}」を投稿ごと削除します。参加者のCSV保存は済みましたか?`)) return;
    try {
      const snap = await getDocs(collection(db, "events", state.eventId, "posts"));
      const docs = snap.docs;
      for (let i = 0; i < docs.length; i += 20) {
        await Promise.all(docs.slice(i, i + 20).map((d) => deleteDoc(d.ref)));
      }
      await deleteDoc(ref);
      location.hash = "#/";
      toast("削除しました");
    } catch (e) { fail(e); }
  };
  el.append(h("div", { class: "card" },
    h("div", { class: "row" },
      h("strong", {}, "司会"),
      h("button", { onclick: copy }, "URLをコピー"),
      h("button", { onclick: showQR }, "QRコード"),
      h("button", { onclick: toggleClose }, ev.closed ? "受付を再開" : "受付を締め切る"),
      h("button", { class: "danger", onclick: remove }, "イベントを削除"),
    ),
    qrBox,
  ));
}

// ---- 並べ替えと CSV ----
function renderToolbar(el, redraw, isMod) {
  const seg = h("div", { class: "seg" },
    ...[["new", "新しい順"], ["old", "古い順"], ["like", "いいね順"]].map(([k, label]) =>
      h("button", {
        class: state.sort === k ? "on" : "",
        onclick: () => { state.sort = k; save("sort", k); redraw(); },
      }, label)),
  );
  const nTop = state.posts.filter((p) => !p.parentId && (isMod || !p.hidden)).length;
  el.replaceChildren(
    seg,
    h("div", { class: "row" },
      h("span", { class: "muted" }, `質問 ${nTop} 件`),
      h("button", { onclick: () => downloadCSV(isMod) }, "CSVで保存")),
  );
}

// ---- 投稿一覧 ----
function renderPosts(el, isMod) {
  const posts = state.posts;
  const byId = new Map(posts.map((p) => [p.id, p]));
  const replies = new Map();
  const tops = [];
  for (const p of posts) {
    if (p.parentId) {
      if (!replies.has(p.parentId)) replies.set(p.parentId, []);
      replies.get(p.parentId).push(p);
    } else tops.push(p);
  }
  // 親が削除された返信も拾うため，親が無いものは仮の親を立てる
  for (const pid of replies.keys()) {
    if (!byId.has(pid)) tops.push({ id: pid, missing: true, createdAt: replies.get(pid)[0].createdAt, likedBy: [] });
  }

  const time = (p) => p.createdAt?.toMillis?.() ?? Date.now();
  const likes = (p) => p.likedBy?.length ?? 0;
  if (state.sort === "new") tops.sort((a, b) => time(b) - time(a));
  else if (state.sort === "old") tops.sort((a, b) => time(a) - time(b));
  else tops.sort((a, b) => likes(b) - likes(a) || time(b) - time(a));

  const items = [];
  for (const p of tops) {
    const kids = (replies.get(p.id) ?? []).filter((r) => isMod || !r.hidden);
    const hiddenTop = !p.missing && p.hidden && !isMod;
    if (hiddenTop && kids.length === 0) continue;
    items.push(h("div", { class: "post" + (p.hidden && isMod ? " hidden" : "") },
      p.missing ? h("div", { class: "placeholder" }, "削除された投稿")
        : hiddenTop ? h("div", { class: "placeholder" }, "司会により非表示")
          : postBody(p, isMod, p),
      kids.length ? h("div", { class: "replies" },
        kids.map((r) => h("div", { class: "post" + (r.hidden ? " hidden" : "") }, postBody(r, isMod, p)))) : null,
    ));
  }
  el.replaceChildren(...(items.length ? items
    : [h("p", { class: "muted" }, "まだ投稿はありません。下の欄から書き込めます。")]));
}

// 1件分の中身。root は返信先にする一番上の投稿
function postBody(p, isMod, root) {
  const me = state.user.uid;
  const closed = state.event.closed;
  const liked = (p.likedBy ?? []).includes(me);
  const ref = doc(db, "events", state.eventId, "posts", p.id);
  const toggleLike = () =>
    updateDoc(ref, { likedBy: liked ? arrayRemove(me) : arrayUnion(me) }).catch(fail);
  const reply = () => {
    state.replyTo = { id: root.id, name: p.name || "匿名", text: p.text };
    document.dispatchEvent(new Event("jukuqa:reply"));
  };
  const del = () => {
    if (confirm("この投稿を削除しますか?")) deleteDoc(ref).catch(fail);
  };
  const toggleHide = () => updateDoc(ref, { hidden: !p.hidden }).catch(fail);

  return [
    h("div", { class: "meta" },
      h("span", { class: "name" }, p.name || "匿名"),
      h("span", {}, fmtTime(p.createdAt)),
      p.uid === me ? h("span", {}, "(自分)") : null,
      p.hidden ? h("span", {}, "非表示中") : null),
    h("div", { class: "text" }, p.text),
    h("div", { class: "actions" },
      h("button", { class: "link like" + (liked ? " on" : ""), onclick: toggleLike, disabled: closed },
        (liked ? "♥ " : "♡ ") + (p.likedBy?.length ?? 0)),
      closed ? null : h("button", { class: "link", onclick: reply }, "返信"),
      p.uid === me ? h("button", { class: "link", onclick: del }, "削除") : null,
      isMod ? h("button", { class: "link", onclick: toggleHide }, p.hidden ? "再表示" : "非表示") : null),
  ];
}

// ---- 画面下の投稿欄 ----
function buildComposer() {
  const name = h("input", { class: "name-input", placeholder: "表示名(空欄なら匿名)", maxlength: 40, value: load("name", "") });
  name.addEventListener("change", () => save("name", name.value.trim()));
  const text = h("textarea", { placeholder: "質問やコメントを書く", maxlength: 2000, rows: 2 });
  const replying = h("div");
  const send = h("button", { class: "primary" }, "投稿");
  const closedNote = h("p", { class: "muted", style: "margin:0" }, "受付は締め切られました。");
  const form = h("div", { class: "composer-inner" }, replying, text, h("div", { class: "row" }, name, send,
    h("span", { class: "muted", style: "font-size:12px" }, "⌘/Ctrl+Enter で送信")));
  const el = h("div", { class: "composer" }, form);

  const showReply = () => {
    replying.replaceChildren();
    if (!state.replyTo) return;
    replying.append(h("div", { class: "replying" },
      h("span", {}, `返信先: ${state.replyTo.name}「${state.replyTo.text}」`),
      h("button", { class: "link", onclick: () => { state.replyTo = null; showReply(); } }, "取消")));
  };
  document.addEventListener("jukuqa:reply", () => { showReply(); text.focus(); });

  const submit = async () => {
    const t = text.value.trim();
    if (!t || send.disabled) return;
    send.disabled = true;
    try {
      await addDoc(collection(db, "events", state.eventId, "posts"), {
        text: t,
        name: name.value.trim().slice(0, 40),
        uid: state.user.uid,
        createdAt: serverTimestamp(),
        parentId: state.replyTo?.id ?? null,
        hidden: false,
        likedBy: [],
      });
      save("name", name.value.trim());
      text.value = "";
      state.replyTo = null;
      showReply();
    } catch (e) { fail(e); } finally { send.disabled = false; }
  };
  send.addEventListener("click", submit);
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  });

  return {
    el,
    update() {
      // 締め切りの状態が変わったときだけ差し替える(入力中のフォーカスを奪わない)
      const want = state.event?.closed ? closedNote : form;
      if (el.firstChild !== want) el.replaceChildren(want);
    },
  };
}

// ---- CSV 保存(Excel で化けないよう BOM 付き UTF-8) ----
function downloadCSV(isMod) {
  const posts = state.posts.filter((p) => isMod || !p.hidden);
  // 質問→その返信 の順に並べる
  const tops = posts.filter((p) => !p.parentId);
  const ordered = [];
  const used = new Set();
  for (const t of tops) {
    ordered.push(t); used.add(t.id);
    for (const r of posts.filter((p) => p.parentId === t.id)) { ordered.push(r); used.add(r.id); }
  }
  for (const p of posts) if (!used.has(p.id)) ordered.push(p); // 親が消えた返信

  const header = ["投稿ID", "親ID", "投稿時刻", "表示名", "本文", "いいね数"];
  if (isMod) header.push("非表示");
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [header.map(esc).join(",")];
  for (const p of ordered) {
    const row = [p.id, p.parentId ?? "", fmtTime(p.createdAt, true), p.name || "匿名", p.text, p.likedBy?.length ?? 0];
    if (isMod) row.push(p.hidden ? "1" : "0");
    lines.push(row.map(esc).join(","));
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const fname = `${state.event.title.replace(/[\\/:*?"<>|\s]+/g, "_")}_${ymd}.csv`;
  const a = h("a", { href: URL.createObjectURL(blob), download: fname });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
